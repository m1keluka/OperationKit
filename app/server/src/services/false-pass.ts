/**
 * Gate false-pass instrumentation (ROADMAP ST2, 2026-06-17).
 *
 * The AI-review gate emits a `pass` verdict to let an objective into `done`.
 * If that objective is later REOPENED (done → working), the prior `pass` was a
 * FALSE PASS: the gate approved work that wasn't actually complete. This module
 * records each such event (linking the reopen back to its passing review) and
 * computes a rolling false-pass RATE per workspace — the baseline metric that
 * makes the gate measurable.
 *
 * See db/index.ts `gate_false_pass` and
 * ~/second-brain/.../decisions for the design rationale.
 */
import { getDb } from '../db/index.js'

/** Minimal shape needed to attribute a reopen. The PATCH routes pass the full
 *  Objective row; only these fields are read. */
export interface ReopenedObjective {
  id: number
  workspace: string
  agent_context?: string | null
}

/**
 * Called when an objective transitions done → working (a reopen). If the
 * objective's most-recent AI review verdict was `pass`, insert one
 * `gate_false_pass` row linking the reopen to that passing review and return
 * its id. Returns null when the objective was not pass-gated (no reviews, or the
 * latest verdict was fail/blocked) or when this exact reopen was already
 * recorded (idempotent guard against a re-reopen of the same passing review).
 *
 * Safe to call unconditionally inside the done → working branch: it self-filters
 * to genuine pass-gated reopens and never throws into the request path on a
 * benign miss.
 */
export function recordReopenFalsePass(obj: ReopenedObjective): number | null {
  const db = getDb()

  // Most-recent review for this objective. iteration is monotonic and uniquely
  // indexed per objective, so DESC gives the latest gate verdict.
  const review = db
    .prepare(
      'SELECT id, verdict, created_at FROM objective_reviews WHERE objective_id = ? ORDER BY iteration DESC LIMIT 1'
    )
    .get(obj.id) as { id: number; verdict: string; created_at: string } | undefined

  // Only a most-recent `pass` is a false pass when reopened.
  if (!review || review.verdict !== 'pass') return null

  // Idempotency: never double-count the same passing review. A new false-pass
  // row is only warranted when a NEW passing review was issued since the last
  // recorded one for this objective.
  const already = db
    .prepare('SELECT 1 FROM gate_false_pass WHERE objective_id = ? AND review_id = ? LIMIT 1')
    .get(obj.id, review.id)
  if (already) return null

  const result = db
    .prepare(
      `INSERT INTO gate_false_pass
         (objective_id, review_id, workspace, agent_context, source, prior_verdict_at)
       VALUES (?, ?, ?, ?, 'reopen', ?)`
    )
    .run(obj.id, review.id, obj.workspace, obj.agent_context ?? null, review.created_at)

  return Number(result.lastInsertRowid)
}

/** A canary escape: a known-bad Tier-1 fixture the gate FAILED to reject. */
export interface CanaryFalsePass {
  /** The fixture id (namespaces the row; no real objective exists). */
  canary_id: string
  /** Bookkeeping workspace; canary escapes are platform-level, default 'operator'. */
  workspace: string
  /** The tier of the escaped canary (Tier-1 = a critical alarm). */
  tier?: number
}

/**
 * Record a CANARY false pass: the anti-signal canary harness fed a known-bad
 * fixture through the REAL gate and the gate did NOT reject it. Writes a
 * `gate_false_pass` row carrying `source='canary'` + the `canary_id`, with NULL
 * objective_id/review_id (no real objective backs a canary). The `source`
 * discriminator keeps this row OUT of the human-reopen false-pass rate
 * (getFalsePassRate filters to source='reopen'). Returns the new row id.
 *
 * This is the proactive analogue of recordReopenFalsePass: an escape here is a
 * gate defect we caught BEFORE a human had to reopen a bad merge.
 */
export function recordCanaryFalsePass(canary: CanaryFalsePass): number {
  const db = getDb()
  const result = db
    .prepare(
      `INSERT INTO gate_false_pass
         (objective_id, review_id, workspace, agent_context, source, canary_id, prior_verdict_at)
       VALUES (NULL, NULL, ?, ?, 'canary', ?, datetime('now'))`
    )
    .run(canary.workspace, `canary:tier${canary.tier ?? 1}`, canary.canary_id)
  return Number(result.lastInsertRowid)
}

export interface WorkspaceFalsePassRate {
  workspace: string
  /** gate_false_pass rows in the window. */
  false_passes: number
  /** objective_reviews rows with verdict='pass' in the window (the gated set). */
  pass_gated_reviews: number
  /** false_passes / pass_gated_reviews, 0 when no pass-gated reviews. */
  rate: number
}

/**
 * Rolling per-workspace false-pass rate over the trailing `windowDays`.
 * rate = (gate_false_pass rows in window) / (pass-gated reviews in window).
 *
 * Numerator is keyed on `gate_false_pass.workspace`; denominator joins
 * objective_reviews → objectives for the workspace. Window bounds are evaluated
 * in SQL via datetime('now', '-N days') to match the stored datetime() format.
 */
export function getFalsePassRate(windowDays = 30): WorkspaceFalsePassRate[] {
  const db = getDb()
  const offset = `-${Math.max(1, Math.floor(windowDays))} days`

  // NOTE: scoped to source='reopen' (obj-2376). The numerator is the HUMAN-reopen
  // false-pass rate; canary-harness escape rows (source='canary') are a separate,
  // proactive signal and must NEVER inflate this reactive metric.
  const falsePassRows = db
    .prepare(
      `SELECT workspace, COUNT(*) AS n
         FROM gate_false_pass
        WHERE reopened_at >= datetime('now', ?)
          AND source = 'reopen'
        GROUP BY workspace`
    )
    .all(offset) as Array<{ workspace: string; n: number }>

  const passReviewRows = db
    .prepare(
      `SELECT o.workspace AS workspace, COUNT(*) AS n
         FROM objective_reviews r
         JOIN objectives o ON o.id = r.objective_id
        WHERE r.verdict = 'pass' AND r.created_at >= datetime('now', ?)
        GROUP BY o.workspace`
    )
    .all(offset) as Array<{ workspace: string; n: number }>

  const falseByWs = new Map(falsePassRows.map(r => [r.workspace, r.n]))
  const gatedByWs = new Map(passReviewRows.map(r => [r.workspace, r.n]))

  // Union of workspaces seen on either side so a workspace with false passes but
  // no in-window pass reviews (or vice versa) still surfaces.
  const workspaces = new Set<string>([...falseByWs.keys(), ...gatedByWs.keys()])

  return [...workspaces]
    .map(workspace => {
      const false_passes = falseByWs.get(workspace) ?? 0
      const pass_gated_reviews = gatedByWs.get(workspace) ?? 0
      const rate = pass_gated_reviews > 0 ? false_passes / pass_gated_reviews : 0
      return { workspace, false_passes, pass_gated_reviews, rate }
    })
    .sort((a, b) => b.rate - a.rate || a.workspace.localeCompare(b.workspace))
}
