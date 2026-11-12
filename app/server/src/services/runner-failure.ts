/**
 * Runner failure — a card that went to `working` but never got a worker (obj 900652).
 *
 * Signature: `status='working'`, NO `session_id`, and nothing ever ran — 0 tokens,
 * $0, `session_count = 0`, no `last_session_summary`. A genuine session burns tokens
 * on its system prompt alone, so this is never "the worker finished with nothing to
 * say"; it is the RUNNER failing to launch one. Concrete cause on 2026-11-12: a
 * `type=project` card started from `planning` hit a status route that flipped it to
 * `working` without calling `startSession` (#900639 / #900640 — fixed in
 * lib/working-start.ts). Any other path that leaves `working` + no session lands here.
 *
 * Before: `sweepOrphanedWorkingSessions` (5 min) parked such a card in plain
 * `review`, and the zero-token sweep then stamped it `blocked` — a human had to
 * notice a card that never ran and press Start again. The stall watchdog would have
 * restarted it (`never_spawned`), but at 10 min it always lost the race to the
 * 5-min orphan sweep.
 *
 * Now the orphan sweep hands this signature here instead:
 *   1. FIRST failure → one automatic retry: a fresh `startSession`, card stays
 *      `working`, attributed `session_starts.reason = 'runner_failure_retry'`.
 *   2. NEXT failure (or the retry itself throws) → FLAGGED as a runner failure:
 *      `stalled_at` + `stall_reason` (needs_agent wake), a high-severity alert, an
 *      activity_log row, then parked in `review` with a `blocked` verdict whose
 *      findings say "Runner failure" — never a silent pending-human-review card.
 *
 * The once-only budget IS the stall watchdog's (`objectives.stall_restarts`, same
 * compare-and-set via `restartStalled`, same `stall_watchdog_enabled` /
 * `stall_watchdog_max_restarts` settings). A stall restart, an abnormal-end retry
 * and a runner-failure retry therefore share ONE automatic restart per episode, and
 * `runner_failure_retry` does not re-arm it (session-start-reasons.ts).
 */
import type Database from 'better-sqlite3'
import type { Objective } from '@operationkit/shared'
import {
  resolveStallConfig,
  restartStalled,
  flagStalled,
  parseDbTime,
  type StallCardRow,
  type StallConfig,
  type StallDecision,
  type StallDeps,
} from './stall-watchdog.js'
import { runMachineStatusUpdate } from '../lib/status-lock.js'

export const RUNNER_FAILURE_START_REASON = 'runner_failure_retry'

type RunnerRow = StallCardRow & {
  total_tokens: number | null
  total_cost_usd: number | null
  session_count: number | null
  last_session_summary: string | null
}

/** Pure: does this row carry the "runner never launched a worker" signature? */
export function isRunnerFailure(row: {
  status: string
  session_id: string | null
  delegate_mode: number | null
  total_tokens: number | null
  total_cost_usd: number | null
  session_count: number | null
  last_session_summary: string | null
}): boolean {
  return (
    row.status === 'working' &&
    !row.session_id &&
    !(Number(row.delegate_mode) > 0) &&
    !(Number(row.total_tokens) > 0) &&
    !(Number(row.total_cost_usd) > 0) &&
    !(Number(row.session_count) > 0) &&
    (row.last_session_summary == null || String(row.last_session_summary).trim() === '')
  )
}

export function describeRunnerFailure(row: Pick<RunnerRow, 'id'>, idleMs: number): string {
  const mins = Math.round(idleMs / 60_000)
  return (
    `runner failure: card #${row.id} was moved to working but no worker session was ever launched ` +
    `(no session id, 0 sessions, 0 tokens, $0, no output) — idle ${mins} min`
  )
}

export interface RunnerFailureDeps {
  db: Database.Database
  now: () => number
  config?: StallConfig
  /** Spawn a fresh worker; returns the new session id. Throws on failure. */
  start: (objective: Objective) => Promise<string>
  /** Attribute the retry's session start (session-start-reasons). */
  noteStartReason: (objectiveId: number, detail: string) => void
  notify: (row: StallCardRow, reason: string) => void
  broadcast: (objectiveId: number) => void
  log?: (msg: string) => void
}

export type RunnerFailureOutcome = 'not_runner_failure' | 'retried' | 'flagged'

function logActivity(db: Database.Database, row: RunnerRow, eventType: 'milestone' | 'error', title: string, detail: string): void {
  try {
    db.prepare(
      'INSERT INTO activity_log (project, workspace, objective_id, session_id, event_type, title, detail, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(row.project || 'unknown', row.workspace, row.id, row.session_id, eventType, title, detail, JSON.stringify({ kind: title }))
  } catch { /* telemetry never blocks */ }
}

/**
 * Handle one `working` + no-session card from the orphan sweep. Returns
 * `not_runner_failure` for anything that ever ran (the caller keeps its old
 * park-in-review behavior for those), `retried` when a fresh worker was launched,
 * `flagged` when the card was parked `review` + `blocked` as a runner failure.
 */
export async function handleRunnerFailure(objectiveId: number, deps: RunnerFailureDeps): Promise<RunnerFailureOutcome> {
  const db = deps.db
  const row = db.prepare(
    `SELECT id, title, status, workspace, project, session_id, delegate_mode, last_activity_at, last_start_at,
            updated_at, stalled_at, stall_restarts, total_tokens, total_cost_usd, session_count, last_session_summary
       FROM objectives WHERE id = ?`,
  ).get(objectiveId) as RunnerRow | undefined
  if (!row || !isRunnerFailure(row)) return 'not_runner_failure'

  const cfg = deps.config ?? resolveStallConfig(db)
  const nowMs = deps.now()
  const origin = parseDbTime(row.last_start_at) ?? parseDbTime(row.updated_at) ?? nowMs
  const idleMs = Math.max(0, nowMs - origin)
  const reason = describeRunnerFailure(row, idleMs)
  const autoRestarts = Number(row.stall_restarts) || 0
  const canRetry = cfg.enabled && autoRestarts < cfg.maxAutoRestarts
  const decision: StallDecision = {
    stalled: true,
    class: 'never_spawned',
    idleMs,
    thresholdMs: cfg.thresholdMs,
    action: canRetry ? 'restart' : 'flag',
  }
  // restartStalled / flagStalled need the watchdog's dep shape; the probe-side
  // fields are unused on these two paths (there is no session to probe or stop).
  const stallDeps: StallDeps = {
    db,
    now: deps.now,
    config: cfg,
    transcriptPath: () => null,
    probe: () => ({ exists: false, lastWriteMs: null, cliEventsSinceSpawn: 0, phase: 'no_cli_output', toolInFlight: false }),
    isAlive: () => false,
    spawnStartMs: () => null,
    isExempt: () => false,
    stop: async () => {},
    start: deps.start,
    noteStartReason: deps.noteStartReason,
    notify: deps.notify,
    broadcast: deps.broadcast,
    log: deps.log,
  }

  if (canRetry) {
    logActivity(db, row, 'milestone', 'runner_failure_auto_retry', `Auto-retrying once: ${reason}`)
    if (await restartStalled(stallDeps, row, decision, reason)) {
      deps.log?.(`[runner-failure] #${row.id} never got a worker — auto-retried once (fresh start)`)
      return 'retried'
    }
    // Retry claim lost, or the spawn threw (restartStalled has then already
    // flagged it; flagStalled is idempotent per episode, so this is a no-op).
    flagStalled(stallDeps, row, `${reason}; the automatic retry did not launch a worker`, decision)
  } else {
    flagStalled(stallDeps, row, `${reason}; the one automatic retry is already spent`, decision)
  }

  // Park it — visibly. A `blocked` verdict keeps the zero-token review sweep off it
  // (it only stamps `ai_review_verdict IS NULL` rows) and shows the cause on the card.
  const findings =
    `Runner failure — not a deliverable and not ready for human review. ${reason}. ` +
    (canRetry
      ? 'The one automatic retry did not launch a worker either.'
      : 'This is the second launch failure in a row; the one automatic retry is already spent.') +
    ' Check the server log for the start path that set this card to working, then start it again.'
  runMachineStatusUpdate(
    db,
    "UPDATE objectives SET status = 'review', ai_review_verdict = 'blocked', ai_review_findings = ?, updated_at = datetime('now') WHERE id = ? AND status = 'working' AND session_id IS NULL",
    findings.slice(0, 2000),
    row.id,
  )
  logActivity(db, row, 'error', 'runner_failure_flagged', findings)
  deps.broadcast(row.id)
  deps.log?.(`[runner-failure] #${row.id} never got a worker — flagged runner failure, parked review/blocked`)
  return 'flagged'
}
