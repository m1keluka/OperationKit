/**
 * Sibling read edge + message relationship check (obj 707038, P1-3).
 *
 * Two halves of one idea: the board is a DAG, so "who may read whom, and what
 * they may read" should be expressible as data about that DAG rather than as
 * prose in a prompt.
 *
 *   P1.1 — an objective carries an explicit query of what it needs from the board.
 *          `GET /objectives/:id/siblings` IS that query, made supported.
 *   P2.3 — siblings read each other's FINAL deliverable, never intermediate
 *          scratch. Enforced here by a column ALLOWLIST (`SIBLING_FIELDS`), not
 *          by a denylist: a prose column added to `objectives` later is withheld
 *          by default rather than leaking on its next migration.
 *
 * Before this existed there was no supported sibling primitive at all, while
 * `POST /objectives/:id/message` (localhost-only, unauthed) would deliver a
 * message from ANY session to ANY objective with no relationship check —
 * the worst of both: no sanctioned read edge, and no isolation on the write one.
 */

interface DbLike {
  prepare(sql: string): { all(...params: unknown[]): unknown[]; get(...params: unknown[]): unknown }
}

/**
 * The ONLY columns a sibling may see of a sibling — final-value fields.
 *
 * `last_session_summary` is the deliverable-shaped column: it is what a worker
 * concluded, already reviewed. `ai_review_verdict` is the independent judgement
 * on it. `updated_at` stands in for a completion timestamp (the table has no
 * `completed_at`; for a terminal row `updated_at` IS when it settled) and costs
 * nothing since the row is already loaded.
 *
 * Deliberately EXCLUDED, and this is the point of the endpoint: `description`
 * (the brief, not the outcome), `approved_plan`, `acceptance_criteria`,
 * `ai_review_findings`, `completion_goal`, `job_review_note`, `session_id` /
 * any handle that would let a caller pull `/output` (the raw session log), and
 * anything pointing at the peer's NOTES.md. Those are scratch — mid-flight
 * reasoning a sibling reading them would couple itself to.
 */
export const SIBLING_FIELDS = [
  'id',
  'title',
  'status',
  'ai_review_verdict',
  'last_session_summary',
  'updated_at',
] as const

/** Query params `GET /objectives/:id/siblings` understands. */
export const SUPPORTED_SIBLINGS_PARAMS = ['include_terminal'] as const

/** Param names the caller passed that the siblings endpoint does not implement. */
export function unknownSiblingParams(query: Record<string, unknown>): string[] {
  const supported = new Set<string>(SUPPORTED_SIBLINGS_PARAMS)
  return Object.keys(query).filter(k => !supported.has(k))
}

export interface SiblingRow {
  id: number
  title: string
  status: string
  ai_review_verdict: string | null
  last_session_summary: string | null
  updated_at: string
}

/**
 * Direct siblings of `id`: same `parent_id`, self excluded.
 *
 * Index path (obj 707003's `idx_objectives_parent`): one point lookup for the
 * node's own `parent_id`, then a `parent_id = ?` seek. No full-board scan, ever
 * — which matters because the naive version of this query ("everything, then
 * filter in JS") is exactly the 8k-row read P0-2 removed.
 *
 * An ORPHAN (`parent_id IS NULL`) gets an EMPTY list, not the top tier. Sharing
 * "no parent" is not a relationship; treating it as one would make every
 * unparented card a sibling of every other and hand back most of the board.
 */
export function listSiblings(db: DbLike, id: number, includeTerminal = true): SiblingRow[] {
  const self = db.prepare('SELECT parent_id FROM objectives WHERE id = ?').get(id) as
    | { parent_id: number | null }
    | undefined
  if (!self) return []
  if (self.parent_id == null) return []

  const cols = SIBLING_FIELDS.join(', ')
  const terminalClause = includeTerminal ? '' : " AND status NOT IN ('done', 'cancelled')"
  return db
    .prepare(
      `SELECT ${cols} FROM objectives WHERE parent_id = ? AND id != ?${terminalClause} ORDER BY id ASC`,
    )
    .all(self.parent_id, id) as SiblingRow[]
}

/** True when the row exists. Distinguishes 404 from "orphan, no siblings". */
export function objectiveExists(db: DbLike, id: number): boolean {
  return db.prepare('SELECT 1 FROM objectives WHERE id = ?').get(id) !== undefined
}

export type Relation = 'self' | 'parent' | 'child' | 'sibling'

/**
 * How `fromId` relates to `toId`, or `null` when they are unrelated.
 *
 * Only the ONE-HOP relations count. A grandparent is not a parent: the graph
 * edge is what authorizes the message, and transitive reach would make a
 * top-level Strategy a legitimate sender to every card beneath it, which is the
 * unbounded edge this check exists to remove. `self` is allowed so an objective
 * can re-enter its own session (the daemon/self-nudge path).
 */
export function relationBetween(db: DbLike, fromId: number, toId: number): Relation | null {
  if (fromId === toId) return 'self'
  const from = db.prepare('SELECT id, parent_id FROM objectives WHERE id = ?').get(fromId) as
    | { id: number; parent_id: number | null }
    | undefined
  const to = db.prepare('SELECT id, parent_id FROM objectives WHERE id = ?').get(toId) as
    | { id: number; parent_id: number | null }
    | undefined
  if (!from || !to) return null

  if (to.parent_id === from.id) return 'parent' // from IS the parent of to
  if (from.parent_id === to.id) return 'child' // from IS a child of to
  // Orphans are not siblings of each other — same rule as listSiblings().
  if (from.parent_id != null && from.parent_id === to.parent_id) return 'sibling'
  return null
}
