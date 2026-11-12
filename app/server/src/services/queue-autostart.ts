/**
 * Queue auto-start (obj 900625) — queued task/bug cards start on their own when a
 * session slot and a seat are free, in the workspaces an admin switched it on for.
 *
 * Why a new sweep and not a wider `sweepTopLevelQueueStarter`: that starter is
 * hard-filtered to bulk-route provenance (`origin IN ('job_reply','strategy')`) and
 * `category = 'platform'`. Widening its allowlist would launch every old strategy /
 * job_reply card in EVERY workspace (client workspaces included). This sweep is the
 * opposite shape: origin-agnostic, but scoped to an explicit workspace list and to
 * cards that entered the queue AFTER the workspace was switched on — so turning it
 * on never floods a backlog.
 *
 * What it starts (all must hold — see {@link selectQueueAutostartCandidates}):
 *  - status `queue`, top-level (`parent_id IS NULL`), type `task` or `bug`, not a
 *    Strategy, not a `[Review]` companion, not soft-deleted
 *  - in a workspace listed in `settings.queue_autostart_workspaces` or
 *    `CC_QUEUE_AUTOSTART_WORKSPACES`
 *  - no `queue_hold`, and no `blocked_by` card that is not `done` yet
 *  - EITHER explicitly start-requested (`auto_start_requested_at`, set when a start
 *    hit the session cap) OR a never-run card that entered queue after the
 *    workspace's `enabled_at` and has sat there for the grace window
 *
 * When (all must hold, per card, oldest first — see {@link runQueueAutostartTick}):
 *  - running sessions < MAX_CONCURRENT_SESSIONS (same count as PATCH → working)
 *  - running auto-started cards < `queue_autostart_max_concurrent` (default 4)
 *  - a seat of the card's engine (or an allowed failover engine) can take work now;
 *    when every seat is cooling the card is SKIPPED, not failed, and stays queued
 *  - no same-title twin is already running (the duplicate guard PATCH applies)
 *  - `guardAutoStartCeiling(path 'queue_autostart')` allows it — default ENFORCE:
 *    an unbudgeted card is not started (reason stamped on the card)
 *
 * Every start is audited in `objective_audit` (pathway `queue-autostart`) and
 * attributed as start reason `queue_autostart` (session_starts + last_start_reason).
 */
import type { Database } from 'better-sqlite3'
import type { Objective } from '@operationkit/shared'
import { MAX_CONCURRENT_SESSIONS } from '@operationkit/shared'
import { getDb } from '../db/index.js'
import { startSession } from './session-manager.js'
import { logObjectiveAudit } from './objective-audit.js'
import { noteStartReason } from './session-start-reasons.js'
import { guardAutoStartCeiling, type AutoStartGuardVerdict } from './job-accounting.js'
import { findRunningTwinForStart } from '../lib/objective-dedupe.js'
import { hasAvailableSeat } from './account-router.js'
import { effectiveFailover, parseCardFailover, resolveEngineFailover, type FailoverPolicy, type SeatKind } from './seat-pool.js'
import { getModelEngine } from './model-registry.js'
import { broadcast } from '../ws/index.js'
import {
  AUDIT_PATHWAY,
  START_REASON,
  countAutostartedInFlight,
  queueAutostartGraceMinutes,
  queueAutostartMaxConcurrent,
  resolveEnabledWorkspaces,
  selectQueueAutostartCandidates,
} from '../lib/queue-autostart.js'

// Config, selection, the request flag and the hold fields live in the pure lib.
export * from '../lib/queue-autostart.js'

function runningSessions(db: Database): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM objectives WHERE status IN ('working', 'ai_review')").get() as { n: number }).n
}

// ── Seat gate ────────────────────────────────────────────────────────────────

export interface SeatCheck {
  ok: boolean
  engine: SeatKind
  reason?: string
}

/**
 * Can a seat take this card NOW? Same decision startSession makes (card engine,
 * then the workspace/card failover policy), but asked up-front so a card whose
 * seats are all cooling is skipped and stays queued — instead of startSession
 * throwing and parking it in the account-router retry queue.
 *
 * `failoverOf` is seat-assign's getWorkspaceFailover, passed in (the tick
 * imports seat-assign lazily: loading it statically would pull seat-credentials'
 * load-time side effects into every module that imports the state poller).
 */
export function defaultSeatCheck(
  obj: Objective,
  has: (kind: SeatKind) => boolean,
  failoverOf: (workspace: string | null | undefined) => FailoverPolicy,
): SeatCheck {
  const engine = getModelEngine(obj.model) as SeatKind
  const policy = effectiveFailover(
    failoverOf(obj.workspace),
    parseCardFailover((obj as { engine_failover?: string | null }).engine_failover ?? null),
  )
  const decision = resolveEngineFailover(engine, policy, has)
  if (decision.queued) {
    return { ok: false, engine, reason: `no ${engine} seat can take work now (every seat is cooling down, parked or busy)` }
  }
  return { ok: true, engine: decision.engine }
}

// ── Per-card bookkeeping ─────────────────────────────────────────────────────

/** Stamp the auto-starter's latest decision on a queued card. Returns true when it changed. */
function setNote(db: Database, id: number, note: string | null): boolean {
  const info = db
    .prepare("UPDATE objectives SET auto_start_note = ? WHERE id = ? AND status = 'queue' AND auto_start_note IS NOT ?")
    .run(note, id, note)
  return info.changes > 0
}

function logActivity(db: Database, obj: Objective, title: string, detail: string | null, meta: Record<string, unknown>): void {
  try {
    db.prepare(
      `INSERT INTO activity_log (project, workspace, objective_id, event_type, title, detail, metadata)
       VALUES (?, ?, ?, 'progress', ?, ?, ?)`,
    ).run(obj.project || 'unknown', obj.workspace, obj.id, title, detail, JSON.stringify({ kind: title, ...meta }))
  } catch { /* diagnostics never block the sweep */ }
}

function ceilingMeta(g: AutoStartGuardVerdict): Record<string, unknown> {
  return { path: 'queue_autostart', policy: g.policy, policy_source: g.policySource, ceiling_source: g.ceiling.source, code: g.code }
}

// ── The tick ─────────────────────────────────────────────────────────────────

export interface QueueAutostartDeps {
  db: Database
  env?: NodeJS.ProcessEnv
  /** Spawns the session; returns its id. Defaults to session-manager's startSession. */
  start?: (obj: Objective) => Promise<string>
  /** Seat availability for the card. Defaults to {@link defaultSeatCheck}. */
  seatCheck?: (obj: Objective) => SeatCheck
}

export interface QueueAutostartTickResult {
  workspaces: string[]
  candidates: number
  started: number[]
  skipped: Array<{ id: number; reason: string }>
  /** Why the tick stopped before the end of the candidate list, if it did. */
  stoppedBy: 'session_cap' | 'autostart_cap' | null
}

export async function runQueueAutostartTick(deps: QueueAutostartDeps): Promise<QueueAutostartTickResult> {
  const { db } = deps
  const env = deps.env ?? process.env
  const start = deps.start ?? startSession
  const result: QueueAutostartTickResult = { workspaces: [], candidates: 0, started: [], skipped: [], stoppedBy: null }

  const enabled = resolveEnabledWorkspaces(db, env)
  result.workspaces = enabled.map(w => w.workspace)
  if (enabled.length === 0) return result

  const candidates = selectQueueAutostartCandidates(db, enabled, { graceMinutes: queueAutostartGraceMinutes(env) })
  result.candidates = candidates.length
  if (candidates.length === 0) return result

  const cap = queueAutostartMaxConcurrent(db, env).value
  // One seat lookup per engine per tick — the answer does not change mid-tick
  // except by our own starts, which the next tick sees.
  const seatMemo = new Map<SeatKind, boolean>()
  const memoHas = (kind: SeatKind) => {
    if (!seatMemo.has(kind)) seatMemo.set(kind, hasAvailableSeat(kind))
    return seatMemo.get(kind)!
  }
  let seatCheck = deps.seatCheck
  if (!seatCheck) {
    const { getWorkspaceFailover } = await import('./seat-assign.js')
    seatCheck = (o: Objective) => defaultSeatCheck(o, memoHas, getWorkspaceFailover)
  }

  const skip = (obj: Objective, reason: string) => {
    result.skipped.push({ id: obj.id, reason })
    setNote(db, obj.id, reason)
  }

  for (const obj of candidates) {
    if (runningSessions(db) >= MAX_CONCURRENT_SESSIONS) {
      result.stoppedBy = 'session_cap'
      break
    }
    if (countAutostartedInFlight(db) >= cap) {
      result.stoppedBy = 'autostart_cap'
      break
    }
    // Re-read: a human may have started, held or cancelled it since selection.
    const fresh = db.prepare('SELECT * FROM objectives WHERE id = ?').get(obj.id) as Objective | undefined
    if (!fresh || fresh.status !== 'queue') continue
    const freshRaw = fresh as unknown as { queue_hold?: string | null; blocked_by?: number | null }
    if (freshRaw.queue_hold && freshRaw.queue_hold.trim() !== '') continue
    if (freshRaw.blocked_by != null) {
      const dep = db.prepare('SELECT status FROM objectives WHERE id = ?').get(freshRaw.blocked_by) as { status: string } | undefined
      if (dep?.status !== 'done') continue
    }

    const seat = seatCheck(fresh)
    if (!seat.ok) {
      skip(fresh, `waiting: ${seat.reason ?? 'no seat can take work now'}`)
      continue
    }

    const twin = findRunningTwinForStart(db, fresh as Parameters<typeof findRunningTwinForStart>[1])
    if (twin) {
      skip(fresh, `waiting: a card with the same title (#${twin.id}) is already running`)
      continue
    }

    const guard = guardAutoStartCeiling(db, fresh, { path: 'queue_autostart' })
    if (!guard.allowed) {
      const note = `refused: ${guard.reason ?? 'job ceiling guard refused the start'}`.slice(0, 1000)
      result.skipped.push({ id: fresh.id, reason: note })
      // Record the decision once per change, not once per tick.
      if (setNote(db, fresh.id, note)) {
        logActivity(db, fresh, 'queue_autostart_refused', guard.diagnostic, ceilingMeta(guard))
        console.warn(`[queue-autostart] #${fresh.id} not started — ${guard.diagnostic}`)
      }
      continue
    }

    try {
      noteStartReason(fresh.id, START_REASON, AUDIT_PATHWAY, `workspace ${fresh.workspace}`)
      const sessionId = await start(fresh)
      db.prepare(
        `UPDATE objectives SET
           status = 'working',
           session_id = ?,
           terminal_by_human = 0,
           autostarted_at = datetime('now'),
           auto_start_requested_at = NULL,
           auto_start_note = NULL,
           last_start_reason = ?,
           last_start_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
           updated_at = datetime('now')
         WHERE id = ?`,
      ).run(sessionId, START_REASON, fresh.id)
      logObjectiveAudit(db, {
        objectiveId: fresh.id,
        eventType: 'status_change',
        fromStatus: 'queue',
        toStatus: 'working',
        actor: 'state-poller',
        pathway: AUDIT_PATHWAY,
        sessionId,
        titleSnapshot: fresh.title ?? null,
        workspace: fresh.workspace ?? null,
      })
      // "Observe" must never mean "silent": an unbudgeted start is recorded.
      if (guard.diagnostic) logActivity(db, fresh, 'queue_autostart_unbudgeted_start', guard.diagnostic, ceilingMeta(guard))
      const requested = (fresh as unknown as { auto_start_requested_at?: string | null }).auto_start_requested_at
      console.warn(
        `[queue-autostart] started #${fresh.id} ("${fresh.title}") in ${fresh.workspace} on ${seat.engine}` +
          (requested ? ' (start was requested while the session cap was full)' : ''),
      )
      result.started.push(fresh.id)
      seatMemo.clear()
      try {
        const updated = db.prepare('SELECT * FROM objectives WHERE id = ?').get(fresh.id) as Objective
        broadcast({ type: 'objective_updated', payload: updated })
      } catch { /* no ws server in tests */ }
    } catch (err) {
      // startSession can still refuse (lease conflict, seat lost between check and
      // spawn). Leave the card queued; the next tick retries.
      skip(fresh, `start failed, will retry: ${(err as Error).message}`.slice(0, 1000))
    }
  }
  return result
}

// ── Poller entry point ───────────────────────────────────────────────────────

let lastSweep = 0
const SWEEP_INTERVAL_MS = 30 * 1000

/** State-poller hook. Throttled to every 30s; a no-op when no workspace has it on. */
export async function sweepQueueAutostart(): Promise<void> {
  const now = Date.now()
  if (now - lastSweep < SWEEP_INTERVAL_MS) return
  lastSweep = now
  try {
    await runQueueAutostartTick({ db: getDb() })
  } catch (err) {
    console.error('[queue-autostart] tick failed:', (err as Error).message)
  }
}

export function __resetQueueAutostartThrottle(): void {
  lastSweep = 0
}
