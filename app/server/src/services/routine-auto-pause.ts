/**
 * Routine auto-pause (obj 64, Part B).
 *
 * Two hourly routines failed ~164/165 runs for a week and nobody noticed. Any
 * routine (ai or script) is now auto-paused (enabled=0) after K CONSECUTIVE
 * failed runs, with an activity-log row + a high alert, and a one-click resume.
 *
 * K resolution (first match wins):
 *   1. routines.max_consecutive_failures (per routine, integer >= 0)
 *   2. env CC_ROUTINE_AUTO_PAUSE_FAILURES
 *   3. settings.routine_auto_pause_failures
 *   4. DEFAULT_AUTO_PAUSE_FAILURES (5)
 * K = 0 disables auto-pause for that scope.
 *
 * What a "failed run" is:
 *  - script routine: non-zero exit, timeout, or spawn error. An alert-marker
 *    escalation with exit 0 is NOT a failure (the script worked; it reported).
 *  - ai routine, at fire time: fireRoutine came back with a real error —
 *    template not valid JSON / missing title, "created but spawn failed", or a
 *    stranded card that still will not spawn. Benign guard skips (over-fire,
 *    queue-depth, concurrency, duplicate-title, script-already-running) are neither failure nor
 *    success: they leave the streak untouched.
 *  - ai routine, after the run: the spawned objective reached a terminal state
 *    that is a failure — status 'cancelled' (killed / retired by hygiene) or an
 *    ai_review_verdict of 'fail'. Status 'done' (or parked 'review' without a
 *    fail verdict) is a success and resets the streak. These outcomes are read
 *    lazily by `reconcileAiRunOutcomes` (each scheduler tick), walking the
 *    routine's objectives past a watermark (`last_accounted_objective_id`) in id
 *    order and stopping at the first still-in-flight run — so no session/poller
 *    code had to change, and each run is counted exactly once.
 *  - a fire-time AI success is NEUTRAL (the real outcome is not known yet);
 *    only the run's terminal outcome resets the streak. Otherwise fire-ok /
 *    run-cancelled would alternate reset/+1 forever and never pause.
 */
import { getDb } from '../db/index.js'
import { logActivity } from '../routes/feed.js'
import { notify } from './notifier.js'

export const DEFAULT_AUTO_PAUSE_FAILURES = 5
export const AUTO_PAUSE_SETTING_KEY = 'routine_auto_pause_failures'
export const AUTO_PAUSE_ENV_KEY = 'CC_ROUTINE_AUTO_PAUSE_FAILURES'

export interface AutoPauseRoutineFields {
  id: number
  name: string
  objective_template?: string
  max_consecutive_failures?: number | null
  consecutive_failures?: number | null
}

function parseK(v: unknown): number | null {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isInteger(n) && n >= 0 ? n : null
}

/** Global K: env override → settings key → default. */
export function globalAutoPauseThreshold(): number {
  const env = parseK(process.env[AUTO_PAUSE_ENV_KEY])
  if (env != null) return env
  try {
    const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(AUTO_PAUSE_SETTING_KEY) as
      | { value: string }
      | undefined
    const s = parseK(row?.value)
    if (s != null) return s
  } catch {
    /* settings unreadable → default */
  }
  return DEFAULT_AUTO_PAUSE_FAILURES
}

/** Effective K for a routine (per-routine override wins). 0 ⇒ never auto-pause. */
export function autoPauseThreshold(routine: Pick<AutoPauseRoutineFields, 'max_consecutive_failures'>): number {
  return parseK(routine.max_consecutive_failures) ?? globalAutoPauseThreshold()
}

/** Benign guard skips — a fire that was refused, not a run that failed. */
const BENIGN_SKIP_PREFIXES = [
  'over-fire guard',
  'queue depth guard',
  'concurrency guard',
  'duplicate guard',
  'script already running',
]

export type FireClassification = 'failure' | 'neutral'

/** Classify an AI-routine FireResult for the streak (see module doc). */
export function classifyAiFireResult(res: { ok: boolean; reason?: string }): FireClassification {
  const reason = res.reason ?? ''
  if (!res.ok) {
    return BENIGN_SKIP_PREFIXES.some(p => reason.startsWith(p)) ? 'neutral' : 'failure'
  }
  return reason.startsWith('created but spawn failed') ? 'failure' : 'neutral'
}

function workspaceOf(routine: AutoPauseRoutineFields): string {
  try {
    const tpl = JSON.parse(routine.objective_template || '{}') as { workspace?: unknown }
    if (typeof tpl.workspace === 'string' && tpl.workspace) return tpl.workspace
  } catch {
    /* fall through */
  }
  return 'example'
}

/** Auto-pause reason string shown on the Jobs board. */
export function autoPauseReason(k: number, lastError: string | null): string {
  const err = (lastError || 'unknown').replace(/\s+/g, ' ').trim().slice(0, 300)
  return `auto-paused: ${k} failures, last error ${err}`
}

export interface FailureRecordResult {
  consecutive_failures: number
  threshold: number
  paused: boolean
}

/**
 * Count one failed run. Persists last_error, bumps consecutive_failures and —
 * when the streak reaches K (> 0) on a still-enabled routine — pauses it,
 * writes an activity row and raises a deduped high alert.
 */
export async function recordRoutineFailure(routineId: number, error: string): Promise<FailureRecordResult | null> {
  const db = getDb()
  db.prepare(
    'UPDATE routines SET consecutive_failures = COALESCE(consecutive_failures, 0) + 1, last_error = ? WHERE id = ?',
  ).run(error.slice(0, 2000), routineId)
  const r = db.prepare('SELECT * FROM routines WHERE id = ?').get(routineId) as
    | (AutoPauseRoutineFields & { enabled: number; consecutive_failures: number })
    | undefined
  if (!r) return null
  const k = autoPauseThreshold(r)
  const count = r.consecutive_failures ?? 0
  if (k <= 0 || count < k || !r.enabled) return { consecutive_failures: count, threshold: k, paused: false }

  const now = new Date().toISOString()
  const reason = autoPauseReason(count, error)
  db.prepare('UPDATE routines SET enabled = 0, auto_paused_at = ?, auto_pause_reason = ? WHERE id = ?').run(
    now,
    reason,
    routineId,
  )
  console.warn(`[routines] '${r.name}' (#${r.id}) ${reason}`)
  try {
    logActivity({
      project: 'operationkit',
      workspace: workspaceOf(r),
      event_type: 'blocker',
      title: `Routine '${r.name}' auto-paused after ${count} consecutive failures`,
      detail: reason,
      metadata: { kind: 'routine_auto_paused', routine_id: r.id, consecutive_failures: count, threshold: k },
    })
  } catch (err) {
    console.warn('[routines] auto-pause activity log failed:', err instanceof Error ? err.message : err)
  }
  await notify({
    severity: 'high',
    source: 'routines',
    title: `Routine '${r.name}' auto-paused`,
    message:
      `Routine '${r.name}' (#${r.id}) failed ${count} runs in a row and was disabled. ${reason}. ` +
      `Fix the cause, then press Resume on the Jobs board.`,
    dedup_key: `routine-auto-paused-${r.id}`,
    url: '/jobs',
  })
  return { consecutive_failures: count, threshold: k, paused: true }
}

/** A successful run resets the streak. */
export function recordRoutineSuccess(routineId: number): void {
  getDb().prepare('UPDATE routines SET consecutive_failures = 0 WHERE id = ?').run(routineId)
}

/**
 * One-click resume: re-enable, clear the streak + auto-pause fields, log it.
 * Returns false when the routine does not exist.
 */
export function resumeRoutine(routineId: number, actor = 'operator'): boolean {
  const db = getDb()
  const r = db.prepare('SELECT * FROM routines WHERE id = ?').get(routineId) as
    | (AutoPauseRoutineFields & { auto_pause_reason: string | null })
    | undefined
  if (!r) return false
  db.prepare(
    'UPDATE routines SET enabled = 1, consecutive_failures = 0, auto_paused_at = NULL, auto_pause_reason = NULL WHERE id = ?',
  ).run(routineId)
  try {
    logActivity({
      project: 'operationkit',
      workspace: workspaceOf(r),
      event_type: 'decision',
      title: `Routine '${r.name}' resumed`,
      detail: r.auto_pause_reason ? `was ${r.auto_pause_reason}` : null,
      metadata: { kind: 'routine_resumed', routine_id: r.id, actor },
    })
  } catch (err) {
    console.warn('[routines] resume activity log failed:', err instanceof Error ? err.message : err)
  }
  console.log(`[routines] '${r.name}' (#${r.id}) resumed by ${actor}`)
  return true
}

type RunOutcome = 'success' | 'failure' | 'pending'

/** Terminal outcome of one routine-spawned objective (see module doc). */
export function classifyRunObjective(o: { status: string; ai_review_verdict?: string | null }): RunOutcome {
  if (o.ai_review_verdict === 'fail' && (o.status === 'review' || o.status === 'done' || o.status === 'cancelled')) {
    return 'failure'
  }
  if (o.status === 'cancelled') return 'failure'
  if (o.status === 'done' || o.status === 'review') return 'success'
  return 'pending'
}

/**
 * Count the terminal outcomes of an AI routine's spawned objectives that have
 * not been counted yet. Walks past `last_accounted_objective_id` in id order and
 * stops at the first run still in flight. Script routines are skipped (their
 * escalation cards are not "runs"; the exit code is).
 */
export async function reconcileAiRunOutcomes(routineId: number): Promise<void> {
  const db = getDb()
  const r = db.prepare('SELECT id, kind, last_accounted_objective_id FROM routines WHERE id = ?').get(routineId) as
    | { id: number; kind: string | null; last_accounted_objective_id: number | null }
    | undefined
  if (!r || (r.kind ?? 'ai') !== 'ai') return
  const rows = db
    .prepare(
      `SELECT id, status, ai_review_verdict, title FROM objectives
        WHERE routine_id = ? AND id > ? ORDER BY id LIMIT 50`,
    )
    .all(r.id, r.last_accounted_objective_id ?? 0) as {
    id: number
    status: string
    ai_review_verdict: string | null
    title: string
  }[]
  for (const o of rows) {
    const outcome = classifyRunObjective(o)
    if (outcome === 'pending') break
    db.prepare('UPDATE routines SET last_accounted_objective_id = ? WHERE id = ?').run(o.id, r.id)
    if (outcome === 'success') recordRoutineSuccess(r.id)
    else {
      const why = o.ai_review_verdict === 'fail' ? 'AI review verdict fail' : `status ${o.status}`
      await recordRoutineFailure(r.id, `run objective #${o.id} ended failed (${why})`)
    }
  }
}
