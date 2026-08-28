/**
 * Field projection + bounded paging for the objectives LIST endpoints (obj 705914).
 *
 * Why this exists: `GET /api/internal/objectives` used to `SELECT *` over the
 * whole table with no bound. At 7.5k rows that is a ~44 MB JSON body taking
 * ~10.6s to serialize+transfer, which intermittently blew the daily verify
 * sweep's 30s fetch cap and false-reported the API as DOWN.
 *
 * The payload is dominated by a handful of free-text columns, not by row count:
 *
 *   description 19.0 MB | ai_review_findings 5.8 MB | acceptance_criteria 5.4 MB
 *   last_session_summary 2.5 MB | completion_goal 1.4 MB | everything else < 2 MB
 *
 * So the fix is a COLUMN projection, not a row cut: the default response now
 * omits those heavy columns (`fields=summary` — measured 43.1 MB → 8.7 MB over
 * the real 7,491-row board) while still returning EVERY row, so no caller
 * silently loses a card. Two further modes bracket it:
 *
 *   fields=minimal — the identity/lifecycle columns only (2.6 MB whole board; 65 KB with include_terminal=0).
 *                    What a health probe or an active.md render actually reads.
 *   fields=full    — the prose too, but bounded to ONE page, so the 44 MB body
 *                    is no longer reachable by accident.
 *
 * Row semantics are deliberately unchanged by default: an external consumer
 * (second-brain's render-active-md) lists objectives that *just went done* in
 * its last-hour section, so silently dropping terminal rows would regress it.
 * Callers that don't want the tail opt out with `include_terminal=0`.
 */

/**
 * Columns withheld from the default (`summary`) projection. Every one is
 * unbounded agent-written prose; together they are ~97% of the payload bytes.
 * Fetch them per-objective via `GET /api/internal/objectives/:id`, or ask for
 * `?fields=full` on a bounded page.
 */
export const HEAVY_COLUMNS = [
  'description',
  'last_session_summary',
  'completion_goal',
  'approved_plan',
  'ai_review_findings',
  'acceptance_criteria',
  'job_review_note',
] as const

/**
 * `fields=minimal` — identity + lifecycle only. At ~7.5k rows the JSON *keys*
 * dominate a wide projection, so trimming to what probes actually read is worth
 * another ~3× over `summary` (8.7 MB → 2.6 MB). Callers: the daily verify sweep's api-up/board-sane
 * probes, cc-oracle's shape check, second-brain's active.md render.
 */
export const MINIMAL_COLUMNS = [
  'id', 'title', 'status', 'agent_context', 'workspace', 'project', 'project_id', 'type',
  'parent_id', 'depth', 'is_strategy', 'session_id', 'has_blockers',
  'pr_url', 'created_at', 'updated_at',
] as const

/** Max rows a single `fields=full` page may return. */
export const FULL_PAGE_MAX = 200
/** Page size applied to `fields=full` when the caller passes no explicit limit. */
export const FULL_PAGE_DEFAULT = 200

export type FieldsMode = 'minimal' | 'summary' | 'full'

interface DbLike {
  prepare(sql: string): { all(...params: unknown[]): unknown[]; get(...params: unknown[]): unknown }
}

/** `summary` (the back-compatible default) unless `minimal`/`full` is asked for. */
export function parseFieldsMode(raw: unknown): FieldsMode {
  const v = String(raw ?? '').toLowerCase()
  return v === 'full' || v === 'minimal' ? v : 'summary'
}

/**
 * SELECT list for a projection mode. `full` is `*`; `minimal` is the fixed
 * MINIMAL_COLUMNS allowlist; `summary` is every real column minus
 * HEAVY_COLUMNS, resolved from the live table so a column added later is
 * included automatically (add it to HEAVY_COLUMNS if it is prose).
 */
export function selectListFor(db: DbLike, mode: FieldsMode): string {
  if (mode === 'full') return '*'
  if (mode === 'minimal') {
    // Intersect with the live table so a column dropped by a migration can't
    // turn every list request into a SQL error.
    const live = new Set((db.prepare('PRAGMA table_info(objectives)').all() as { name: string }[]).map(c => c.name))
    const kept = MINIMAL_COLUMNS.filter(c => live.has(c))
    return kept.length > 0 ? kept.join(', ') : 'id, title, status'
  }
  const cols = (db.prepare('PRAGMA table_info(objectives)').all() as { name: string }[]).map(c => c.name)
  const heavy = new Set<string>(HEAVY_COLUMNS)
  const kept = cols.filter(c => !heavy.has(c))
  // Defensive: an unexpected empty PRAGMA must not produce `SELECT  FROM`.
  return kept.length > 0 ? kept.join(', ') : '*'
}

export interface PageBounds {
  limit: number | null
  offset: number
}

/**
 * Resolve LIMIT/OFFSET. `summary` stays unbounded when no limit is given (that
 * is the cheap full-board read the health check and active.md refresh want);
 * `full` is always bounded so the 44 MB response cannot be re-created.
 */
export function resolvePageBounds(rawLimit: unknown, rawOffset: unknown, mode: FieldsMode): PageBounds {
  const parsedLimit = parseInt(String(rawLimit ?? ''), 10)
  const parsedOffset = parseInt(String(rawOffset ?? ''), 10)
  const offset = !isNaN(parsedOffset) && parsedOffset > 0 ? parsedOffset : 0

  if (!isNaN(parsedLimit) && parsedLimit > 0) {
    return { limit: Math.min(parsedLimit, mode === 'full' ? FULL_PAGE_MAX : parsedLimit), offset }
  }
  return { limit: mode === 'full' ? FULL_PAGE_DEFAULT : null, offset }
}

export interface ListFilters {
  workspace?: string
  status?: string
  since?: string
  /** `?parent_id=<id>` — DIRECT children only. `?parent_id=null` — top-level rows. */
  parentId?: number | 'null'
  /** `?ancestor_id=<id>` — the whole subtree BELOW that node (strict descendants). */
  ancestorId?: number
  includeTerminal: boolean
}

/** Terminal statuses — the 7.3k-row tail that accumulates forever. */
export const TERMINAL_STATUSES = ['done', 'cancelled'] as const

/**
 * Every query param `GET /api/internal/objectives` understands (obj 707003).
 *
 * This list is the contract, and it is ENFORCED: a param outside it is a 400,
 * not a silent no-op. That inversion is the actual point of the change. Before
 * it, `?parent_id=706936` — an unsupported param — returned all 8,362 rows with
 * HTTP 200, so a caller filtering the DAG got a full-board false positive that
 * looked exactly like a correct answer. A silently-ignored filter on a list
 * endpoint is worse than a missing one, because the caller cannot tell.
 *
 * Adding a param means adding it here as well as to the parser below; the route
 * test asserts the two agree.
 */
export const SUPPORTED_LIST_PARAMS = [
  'fields',
  'workspace',
  'status',
  'since',
  'parent_id',
  'ancestor_id',
  'include_terminal',
  'limit',
  'offset',
] as const

/** Param names the caller passed that this endpoint does not implement. */
export function unknownListParams(query: Record<string, unknown>): string[] {
  const supported = new Set<string>(SUPPORTED_LIST_PARAMS)
  return Object.keys(query).filter(k => !supported.has(k))
}

/** `?parent_id=` / `?ancestor_id=` — a positive integer id, or nothing. */
function parseId(raw: unknown): number | undefined {
  const n = parseInt(String(raw ?? ''), 10)
  return !isNaN(n) && n > 0 ? n : undefined
}

export function parseListFilters(query: Record<string, unknown>): ListFilters {
  const raw = String(query.include_terminal ?? '').toLowerCase()
  // `?parent_id=null` (also `none`/`root`) asks for the TOP tier — the rows with
  // no parent at all. Spelled explicitly because an omitted param means "don't
  // filter", and those two must not collapse into each other.
  const parentRaw = String(query.parent_id ?? '').toLowerCase()
  const parentIsNull = parentRaw === 'null' || parentRaw === 'none' || parentRaw === 'root'
  return {
    workspace: typeof query.workspace === 'string' && query.workspace ? query.workspace : undefined,
    status: typeof query.status === 'string' && query.status ? query.status : undefined,
    since: typeof query.since === 'string' && query.since ? query.since : undefined,
    parentId: parentIsNull ? 'null' : parseId(query.parent_id),
    ancestorId: parseId(query.ancestor_id),
    // Row set is unchanged by default (back-compat); callers opt OUT of the tail.
    includeTerminal: !(raw === '0' || raw === 'false' || raw === 'no'),
  }
}

export interface BuiltQuery {
  where: string
  params: unknown[]
}

export function buildWhere(filters: ListFilters): BuiltQuery {
  const conditions: string[] = []
  const params: unknown[] = []
  if (filters.workspace) {
    conditions.push('workspace = ?')
    params.push(filters.workspace)
  }
  if (filters.status) {
    conditions.push('status = ?')
    params.push(filters.status)
  } else if (!filters.includeTerminal) {
    conditions.push(`status NOT IN (${TERMINAL_STATUSES.map(() => '?').join(', ')})`)
    params.push(...TERMINAL_STATUSES)
  }
  if (filters.since) {
    conditions.push('updated_at >= ?')
    params.push(filters.since)
  }
  // DIRECT children. Backed by idx_objectives_parent, so this is an index seek
  // rather than the 8,362-row scan the caller used to get back in full.
  if (filters.parentId === 'null') {
    conditions.push('parent_id IS NULL')
  } else if (filters.parentId !== undefined) {
    conditions.push('parent_id = ?')
    params.push(filters.parentId)
  }
  // Whole subtree BELOW the node (strict descendants — the node itself is not a
  // descendant of itself, matching parent_id's "children only" semantics; ask
  // for the root separately if you want it). `UNION` (not `UNION ALL`) makes the
  // walk terminate on a parent cycle: a row already in the set is not re-added.
  if (filters.ancestorId !== undefined) {
    conditions.push(`id IN (
      WITH RECURSIVE sub(id) AS (
        SELECT id FROM objectives WHERE parent_id = ?
        UNION
        SELECT o.id FROM objectives o JOIN sub ON o.parent_id = sub.id
      ) SELECT id FROM sub
    )`)
    params.push(filters.ancestorId)
  }
  return { where: conditions.length > 0 ? ' WHERE ' + conditions.join(' AND ') : '', params }
}
