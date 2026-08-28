/**
 * Persistent no-progress circuit breaker for the delegator liveness backstop
 * (obj 707460).
 *
 * WHY THIS EXISTS. `sweepWedgedDelegators` (poller-delegator.ts) revives a delegator
 * wedged in `working` with no live session. It is deliberately TIME-throttled and
 * NOT signature-gated — that was the whole point of the backstop, because the
 * signature-gated `reconcileDelegators` net goes inert once a signature is
 * "spent" and could not recover a wedge. But time-throttling alone gives the
 * sweep **no convergence condition at all**: it re-nudges every
 * `DELEGATOR_BACKSTOP_MS` forever, whether or not the nudge accomplishes
 * anything.
 *
 * Measured consequence (obj 706967, "Missing MLS events"): a top-level delegator
 * blocked on a hard external dependency the agent cannot resolve — it cannot read
 * a human-attached screenshot — accrued **82 sessions, 61 of them <=35s no-ops**,
 * locked to a ~31-minute metronome for 33+ hours and still going. Each wake
 * re-ran the same dead-end investigation, changed nothing, and exited. Cost:
 * ~$53 of model spend to reach the same dead end 61 times. obj 707308 showed the
 * identical cadence over 24 sessions.
 *
 * The pre-existing no-op guard (`MAX_NOOP_RESPAWNS` / `noopRespawnCounts` in
 * poller-loop.ts) does NOT cover this, for two independent reasons:
 *   1. It is explicitly gated on `!objective.delegate_mode` — the victims are
 *      delegators, so their no-op sessions are never even counted.
 *   2. It lives on the session-END `working→review` transition inside
 *      `pollActiveSessions`, and its counter is an in-memory `Map` documented as
 *      "cleared on restart". The backstop sweep never reads it.
 *
 * So the breaker here is a SEPARATE, DURABLE counter that lives on the objectives
 * row (`backstop_sig` + `backstop_noprogress`), mirroring the `reconcile_sig`
 * precedent. A restart cannot reset it — which matters, because a 33-hour wake
 * loop comfortably outlives any single server process.
 *
 * WHAT COUNTS AS PROGRESS. A signature of the delegator's observable state.
 * The choices here are load-bearing:
 *   - Child status multiset: IN. A child advancing queue→review is real progress
 *     and must reset the counter.
 *   - Durable file writes across the objective's sessions: IN. This is the
 *     "did anything actually change" signal.
 *   - `session_count`: OUT. It increments on every wake including a no-op, so
 *     using it would make the signature change every single time and the breaker
 *     could never trip.
 *   - `tool_calls`: OUT. A dead-end read-only investigation burns tool calls
 *     while changing nothing — that is exactly 706967's shape (10-35s, reads,
 *     zero writes). Counting tool calls would also never trip.
 *   - Writes under the objective-memory scratch directory: OUT (see
 *     {@link isScratchPath}). A worker is *instructed* to update its own
 *     NOTES.md/ARTIFACT.md on every wake, so scratch churn is guaranteed on a
 *     no-op wake. Counting it as progress would reset the counter forever and
 *     make the breaker inert — the exact failure mode this module exists to fix.
 */

import { getDb } from '../db/index.js'

/**
 * Consecutive no-progress backstop wakes tolerated before the objective is
 * parked instead of re-nudged. 3 (~90 min at the default 30-min cadence) leaves
 * room for a genuinely slow-but-live delegator while bounding a dead loop to
 * hours instead of days.
 */
export const BACKSTOP_MAX_NOPROGRESS = Math.max(
  1,
  parseInt(process.env.BACKSTOP_MAX_NOPROGRESS || '3', 10) || 3,
)

/** Persisted breaker state for one objective. Read straight off the row. */
export interface BackstopProgressState {
  /** Signature recorded at the previous backstop wake; null = never woken. */
  sig: string | null
  /** Consecutive wakes observed with an unchanged signature. */
  noProgress: number
}

export type BackstopProgressAction = 'proceed' | 'park'

export interface BackstopProgressDecision {
  /** 'proceed' = nudge as before; 'park' = stop the loop and escalate. */
  action: BackstopProgressAction
  /** The counter value to persist for this wake. */
  noProgress: number
  /** True when this wake's signature matched the previous one. */
  stalled: boolean
  why: string
}

/**
 * The pure branch. Given this wake's progress signature and the state persisted
 * at the previous wake, decide whether to nudge again or park.
 *
 * First wake (`prev.sig == null`) always proceeds: we have no baseline to
 * compare against, so we cannot yet know whether the objective is stuck.
 */
export function classifyBackstopProgress(
  currentSig: string,
  prev: BackstopProgressState,
  max: number = BACKSTOP_MAX_NOPROGRESS,
): BackstopProgressDecision {
  if (prev.sig == null) {
    return {
      action: 'proceed',
      noProgress: 0,
      stalled: false,
      why: 'first backstop wake — no baseline signature to compare',
    }
  }
  if (prev.sig !== currentSig) {
    return {
      action: 'proceed',
      noProgress: 0,
      stalled: false,
      why: 'progress since last backstop wake (signature changed) — counter reset',
    }
  }
  const n = prev.noProgress + 1
  if (n >= max) {
    return {
      action: 'park',
      noProgress: n,
      stalled: true,
      why: `${n} consecutive backstop wakes with zero progress (cap ${max}) — parking instead of re-nudging`,
    }
  }
  return {
    action: 'proceed',
    noProgress: n,
    stalled: true,
    why: `no progress since last backstop wake (${n}/${max})`,
  }
}

/**
 * True for a path that a worker is *instructed* to rewrite on every wake, so its
 * modification carries no information about progress. Kept deliberately narrow:
 * only the per-objective memory directory (NOTES.md / ARTIFACT.md and anything
 * else under it).
 */
export function isScratchPath(p: string): boolean {
  return p.includes('/ai-workspace/objective-memory/')
}

/** Parse a `session_intel` JSON array column without trusting its contents. */
function parsePathList(raw: unknown): string[] {
  if (typeof raw !== 'string' || raw.length === 0) return []
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

/**
 * Count durable (non-scratch) file writes recorded across every session of this
 * objective. Computed in JS rather than SQL on purpose: the columns are TEXT JSON
 * that must be filtered per-path, and a malformed row must degrade to 0 rather
 * than throw inside the poller's sweep.
 */
export function countDurableWrites(objectiveId: number): number {
  const rows = getDb()
    .prepare('SELECT files_created, files_modified FROM session_intel WHERE objective_id = ?')
    .all(objectiveId) as { files_created: unknown; files_modified: unknown }[]
  let n = 0
  for (const r of rows) {
    for (const p of parsePathList(r.files_created)) if (!isScratchPath(p)) n++
    for (const p of parsePathList(r.files_modified)) if (!isScratchPath(p)) n++
  }
  return n
}

/**
 * Build this wake's progress signature: the child-status multiset ONLY.
 *
 * Durable writes used to be in this string. That reset the breaker on every
 * no-op wake that touched any non-scratch file (or whose intel row listed one),
 * which is how obj 707614 ran 78 sessions / 29 identical "6 workers in
 * queue/review" nudges without ever parking. Child status changing (queue →
 * review → done) is the only progress a delegator wake can actually show.
 */
export function computeProgressSig(
  _objectiveId: number,
  kids: { id: number; status: string }[],
): string {
  const kidSig = kids
    .map(k => `${k.id}:${k.status}`)
    .sort()
    .join(',')
  return `kids=[${kidSig}]`
}

/** Read the durable breaker state off the objectives row. */
export function readBackstopState(objectiveId: number): BackstopProgressState {
  const row = getDb()
    .prepare('SELECT backstop_sig, backstop_noprogress FROM objectives WHERE id = ?')
    .get(objectiveId) as { backstop_sig: string | null; backstop_noprogress: number | null } | undefined
  return {
    sig: row?.backstop_sig ?? null,
    noProgress: Number(row?.backstop_noprogress ?? 0) || 0,
  }
}

/**
 * Persist the breaker state. Written BEFORE the nudge fires so a crash mid-nudge
 * cannot lose the increment (the failure mode that would let the loop run
 * forever again).
 */
export function persistBackstopState(objectiveId: number, sig: string, noProgress: number): void {
  getDb()
    .prepare('UPDATE objectives SET backstop_sig = ?, backstop_noprogress = ? WHERE id = ?')
    .run(sig, noProgress, objectiveId)
}

/**
 * Clear the breaker so a resurrected objective starts fresh. Called when the
 * objective leaves `working` through any path.
 */
export function clearBackstopState(objectiveId: number): void {
  getDb()
    .prepare('UPDATE objectives SET backstop_sig = NULL, backstop_noprogress = 0 WHERE id = ?')
    .run(objectiveId)
}
