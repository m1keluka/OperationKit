/**
 * Delegator park/wake helpers — extracted from state-poller.ts (behavior frozen).
 * Parent lookup, strategy continuation, reconcile, orphan/wedged sweeps.
 * parkDelegatorIfWaiting stays in the facade (shares stuckAlerted/watchdogRouted).
 */
import type { Objective, ObjectiveStatus } from '@command-center/shared'
import { getDb } from '../db/index.js'
import { getSessionState } from './session-manager.js'
import { wakeDelegator, nudgeDelegator, recentlyNudged, reconcileDecision, appendChildResult } from './delegation.js'
import { isStrategyTierEnabled } from './strategy-governance.js'
import { broadcast } from '../ws/index.js'
import { runMachineStatusUpdate } from '../lib/status-lock.js'
import { delegatorBackstopDecision } from './poller-decisions.js'
import { DELEGATOR_BACKSTOP_MS } from '../config.js'
import { insertAlert } from './notifier.js'
import {
  classifyBackstopProgress,
  computeProgressSig,
  readBackstopState,
  persistBackstopState,
  clearBackstopState,
} from '../lib/backstop-progress.js'

// Don't re-nudge a delegator from the reconcile pass more than once per this
// window — gives a revived delegator time to act before the safety net fires again.
const RECONCILE_THROTTLE_MS = 2 * 60 * 1000

/**
 * If `objective` is a worker of a delegator (its parent runs in delegate_mode),
 * returns the parent's id; otherwise null. Used to route every delegator worker
 * through the independent adversarial reviewer before the delegator accepts it.
 */
export function delegatorParentOf(objective: Objective): number | null {
  if (objective.parent_id == null) return null
  const parent = getDb()
    .prepare('SELECT delegate_mode FROM objectives WHERE id = ?')
    .get(objective.parent_id) as { delegate_mode: number } | undefined
  return parent && parent.delegate_mode ? objective.parent_id : null
}

// Strategy Layer dark-launch flag — the ONE shared helper (isStrategyTierEnabled,
// env CC_STRATEGY_TIER OR settings.strategy_tier_enabled). Read at the POINT OF USE
// — never cached — so a test (or an operator flip) takes effect without a restart.
// When off, the P3 continuation wake below never fires.

/**
 * P3 continuation engine (Strategy Layer) — flag-gated.
 *
 * When a delegate_mode child commits to `review`/`done` at the worker-end commit
 * seam (the non-`ai_review` branch), propagate completion UP the tree by waking
 * its delegator parent. Because `delegatorParentOf` is already depth-agnostic,
 * this is depth-aware by construction: a finishing PROJECT (depth 1) wakes its
 * STRATEGY parent (depth 0), re-invoking the persistent strategy node after each
 * project completes. Recursion is emergent — each tier wakes only its immediate
 * delegator parent through the same fabric.
 *
 * Returns the parent id woken, or null if no wake fired. Invariants:
 *  - FLAG OFF (CC_STRATEGY_TIER unset): always returns null → behavior at this
 *    seam is byte-identical to pre-P3 (zero extra wakes).
 *  - NO DOUBLE WAKE: fires only for resolvedStatus 'review' | 'done'. The
 *    pre-existing ai_review single-hop wake (the ai_review polling loop) owns the
 *    resolvedStatus === 'ai_review' transitions, which return null here. The two
 *    paths are mutually exclusive by resolvedStatus, so a single finishing child
 *    yields EXACTLY ONE parent wake.
 */
export function continueDelegationOnCommit(
  objective: Objective,
  updated: Objective,
  resolvedStatus: ObjectiveStatus,
): number | null {
  if (resolvedStatus !== 'review' && resolvedStatus !== 'done') return null
  const dp = delegatorParentOf(objective)
  if (dp == null) return null

  // Flag ON (full Strategy autonomy): re-wake the strategy parent so it runs its
  // decision loop after the child finishes. wakeDelegator both appends the child
  // summary to the strategy's NOTES.md AND fires the (costly) resume nudge.
  if (isStrategyTierEnabled()) {
    wakeDelegator(dp, updated)
    return dp
  }

  // obj 2384 — Strategy-OWNED recurring Jobs feed back into their strategy's
  // rolling context EVEN WITH THE AUTONOMY FLAG OFF. The strategy_objective_id
  // link IS the opt-in, so a finished routine run whose owning routine points at
  // this delegator parent appends its summary to the strategy's NOTES.md — the
  // same durable channel wakeDelegator uses — WITHOUT the autonomy resume nudge
  // (which stays gated behind CC_STRATEGY_TIER). For any non-strategy-owned child
  // this is a no-op, preserving pre-P3 / pre-2384 flag-off equivalence.
  if (isStrategyOwnedRoutineRun(objective, dp)) {
    appendChildResult(dp, updated)
    return dp
  }
  return null
}

/**
 * obj 2384 — true when `objective` is a run spawned by a routine that is OWNED by
 * the delegator `dp` (routines.strategy_objective_id === dp). Such runs feed their
 * summary back to the owning strategy independent of the autonomy flag.
 */
function isStrategyOwnedRoutineRun(objective: Objective, dp: number): boolean {
  if (objective.routine_id == null) return false
  const row = getDb()
    .prepare('SELECT strategy_objective_id FROM routines WHERE id = ?')
    .get(objective.routine_id) as { strategy_objective_id: number | null } | undefined
  return !!row && row.strategy_objective_id === dp
}

/**
 * Reconcile safety net. The event-driven wake (wakeDelegator) only fires from the
 * session-intel extraction pipeline; any other path to `review` — a worker spawned
 * via the wrong mechanism, swept to review on restart, or a dropped extraction —
 * leaves the delegator blind. This pass revives a dormant delegator (no live
 * session) that has workers awaiting acceptance OR is all-done but not yet closed.
 *
 * It nudges only when the child-status signature has CHANGED since the last nudge
 * (see reconcileDecision) — a settled state (all-done-but-parked, or a worker the
 * delegator keeps declining) is recorded once and then left alone. A genuinely new
 * completion changes the signature and still wakes the delegator.
 *
 * The last-nudged signature is persisted in `objectives.reconcile_sig` (the DURABLE
 * source of truth), NOT an in-memory map. This is deliberate: an all-done delegator
 * parked in `review` (awaiting Mike's accept) has a STABLE signature that never
 * changes, so once recorded it must stay recorded ACROSS server restarts. An
 * in-memory map was wiped on every restart, making `lastSig` undefined and `changed`
 * spuriously true on the first post-restart pass — re-nudging every settled
 * delegator and spawning a useless ~$7 [child-complete] session each time (the
 * recurring budget leak on obj-955/obj-878). With durable storage the invariant
 * "the reconcile net fires AT MOST ONCE per distinct actionable signature" holds
 * across restarts, while a genuinely new completion (signature differs from the
 * persisted value — including a change that landed during the restart window) still
 * produces exactly one nudge.
 */
export function reconcileDelegators(): void {
  const db = getDb()
  const delegators = db.prepare(
    "SELECT id, session_id, reconcile_sig FROM objectives WHERE delegate_mode = 1 AND status != 'done'"
  ).all() as { id: number; session_id: string | null; reconcile_sig: string | null }[]
  for (const d of delegators) {
    const kids = db.prepare(
      "SELECT id, status FROM objectives WHERE parent_id = ? ORDER BY id"
    ).all(d.id) as { id: number; status: string }[]
    if (kids.length === 0) continue

    const lastSig = d.reconcile_sig ?? undefined
    const { actionable, changed, sig, why } = reconcileDecision(kids, lastSig)
    if (!actionable) continue
    // Persist the observed actionable signature durably up front, so a completion
    // already handled by the event path (or the delegator's own live session) is
    // not re-nudged by this safety net on a later tick OR after a restart. Only
    // write when it actually changed, to avoid a redundant UPDATE every poll.
    if (changed) db.prepare("UPDATE objectives SET reconcile_sig = ? WHERE id = ?").run(sig, d.id)
    if (!changed) continue // settled state we've already acted on → no wake storm

    // A genuinely new actionable state. Defer to an active or freshly-nudged
    // session; otherwise wake the dormant delegator once.
    if (d.session_id && getSessionState(d.session_id) === 'working') continue
    if (recentlyNudged(d.id, RECONCILE_THROTTLE_MS)) continue

    console.log(`[state-poller] Reconcile: delegator #${d.id} — ${why} — nudging (sig ${sig})`)
    nudgeDelegator(d.id)
  }
  // Clear the persisted signature for any delegator that has reached `done` so a
  // stale sig isn't retained (the durable equivalent of the old in-memory pruning).
  // Idempotent and cheap — the WHERE clause matches only rows that still hold one.
  db.prepare("UPDATE objectives SET reconcile_sig = NULL WHERE status = 'done' AND reconcile_sig IS NOT NULL").run()
}

// Runtime safety net for objectives orphaned in 'working' with NO session_id.
// The main poll query requires session_id IS NOT NULL, so a 'working' objective
// whose session_id is NULL is invisible to the poller and never advances. This
// happens when a resume PATCH fails AFTER the objective was already dequeued from
// the account-router (working→working is an invalid transition, so the drain
// drops it without re-queuing — see index.ts), or any other path that leaves
// working+NULL. Such objectives sat stuck for hours. Delegators are LEGITIMATELY
// working+NULL while parked waiting on workers (handled by reconcileDelegators),
// so they're excluded. The age guard avoids racing a just-spawned objective whose
// session_id write hasn't landed yet. Moving to 'review' makes it visible and
// resumable, and wakes a delegator parent via reconcileDelegators.
let lastOrphanSweep = 0
const ORPHAN_SWEEP_INTERVAL_MS = 60 * 1000

export function sweepOrphanedWorkingSessions(): void {
  const now = Date.now()
  if (now - lastOrphanSweep < ORPHAN_SWEEP_INTERVAL_MS) return
  lastOrphanSweep = now

  const db = getDb()
  const orphans = db
    .prepare(
      "SELECT * FROM objectives WHERE status = 'working' AND session_id IS NULL AND delegate_mode = 0 AND updated_at < datetime('now', '-5 minutes')"
    )
    .all() as Objective[]

  for (const obj of orphans) {
    runMachineStatusUpdate(
      db,
      "UPDATE objectives SET status = 'review', updated_at = datetime('now') WHERE id = ?",
      obj.id,
    )
    const updated = db.prepare('SELECT * FROM objectives WHERE id = ?').get(obj.id) as Objective
    broadcast({ type: 'objective_updated', payload: updated })
    console.warn(
      `[state-poller] Orphan recovery: objective ${obj.id} ("${obj.title}") was stuck in 'working' with no session (invisible to poller) — moved to 'review'`
    )
  }
}

// ── Delegator liveness backstop (time-based, NOT signature-gated) ──
// The watchdog (`watchdogDecision`, guarded by `&& !objective.delegate_mode`)
// and the orphan sweep (`sweepOrphanedWorkingSessions`, WHERE `delegate_mode = 0`)
// both EXEMPT delegators. Delegator recovery otherwise relies entirely on event
// wakes + `reconcileDelegators`, which is SIGNATURE-gated via the durable
// `reconcile_sig`: it fires AT MOST ONCE per distinct child-status signature and
// skips `kids.length === 0`. So a delegator wedged in `working` with no live
// session whose recovery signal never lands — a coalesced/missed wake, a nudge
// whose spawned session crashed, session_id nulled by the failed-resume drop
// (working→working is invalid, so the drain drops it un-requeued), or 0 children
// — has NO absolute time-based backstop. This helper is that backstop.
//
// It deliberately does NOT read the signature: the whole point is to recover a
// delegator whose signature is already 'spent'. Pure (no DB, no timers) so it is
// unit-tested; the TIME throttling that prevents a wake storm lives in the caller
// (`sweepWedgedDelegators`), mirroring how `watchdogDecision` is pure and the
// force-route side-effects live in `forceRouteStuckWorker`.

// Runtime backstop for delegators wedged in `working`. Sibling of
// `sweepOrphanedWorkingSessions`, but for `delegate_mode = 1` (which that sweep
// and the watchdog both exclude). Time-throttled TWO ways so a healthy delegator
// legitimately parked waiting on long-running workers is never spammed:
//  1. a global interval (this sweep runs at most every 60s), and
//  2. a per-delegator throttle (`lastBackstopAt`) so an individual delegator is
//     touched at most once per DELEGATOR_BACKSTOP_MS.
// Crucially this is TIME-throttled, NOT signature-gated — a wedged delegator whose
// reconcile signature is already 'spent' is still eventually recovered. Additive:
// it does not touch the watchdog, orphan sweep, reconcile, or dead-session nets.
let lastWedgedDelegatorSweep = 0
const WEDGED_DELEGATOR_SWEEP_INTERVAL_MS = 60 * 1000
const lastBackstopAt = new Map<number, number>()

export function sweepWedgedDelegators(): void {
  const now = Date.now()
  if (now - lastWedgedDelegatorSweep < WEDGED_DELEGATOR_SWEEP_INTERVAL_MS) return
  lastWedgedDelegatorSweep = now

  const db = getDb()
  // Compute wedge age in the query (SQLite stores updated_at as UTC text) to
  // avoid JS timezone-parsing pitfalls.
  const delegators = db
    .prepare(
      `SELECT *, (strftime('%s','now') - strftime('%s', updated_at)) * 1000 AS wedge_age_ms
         FROM objectives
        WHERE delegate_mode = 1 AND status = 'working'`
    )
    .all() as (Objective & { wedge_age_ms: number })[]

  for (const d of delegators) {
    // Per-delegator time throttle: don't re-backstop the same delegator within
    // one window (preserves the anti-wake-storm invariant reconcile protects).
    const last = lastBackstopAt.get(d.id)
    if (last != null && now - last < DELEGATOR_BACKSTOP_MS) continue

    const hasLiveSession = !!d.session_id && getSessionState(d.session_id) === 'working'
    const kids = db
      .prepare("SELECT id, status FROM objectives WHERE parent_id = ? ORDER BY id")
      .all(d.id) as { id: number; status: string }[]

    const decision = delegatorBackstopDecision({
      hasLiveSession,
      ageMs: d.wedge_age_ms,
      kids,
      thresholdMs: DELEGATOR_BACKSTOP_MS,
    })
    if (!decision.recover) continue

    // Record the backstop attempt up front so the per-delegator throttle holds
    // even if the recovery action itself takes a moment (or fails).
    lastBackstopAt.set(d.id, now)

    if (decision.action === 'nudge') {
      // Durable no-progress circuit breaker (obj 707460). The nudge branch is
      // the ONLY one that loops: `route-review` terminates by leaving `working`,
      // but a nudge puts the delegator right back into the exact state this
      // sweep selects for. Time throttle alone has no convergence condition.
      const progressSig = computeProgressSig(d.id, kids)
      const progress = classifyBackstopProgress(progressSig, readBackstopState(d.id))
      persistBackstopState(d.id, progressSig, progress.noProgress)

      if (progress.action === 'park') {
        const reason =
          `Delegator backstop parked this objective after ${progress.noProgress} consecutive ` +
          `wake(s) that produced no progress (unchanged child states and zero durable file ` +
          `writes) at a ${Math.round(DELEGATOR_BACKSTOP_MS / 60000)}-minute cadence. Each wake ` +
          `re-ran the same work and changed nothing, so re-waking cannot help — this needs a ` +
          `human to unblock the underlying dependency. Progress signature: ${progressSig}`
        runMachineStatusUpdate(
          db,
          "UPDATE objectives SET status = 'review', ai_review_verdict = 'blocked', ai_review_findings = ?, has_blockers = 1, updated_at = datetime('now') WHERE id = ?",
          reason,
          d.id,
        )
        console.warn(
          `[state-poller] Delegator backstop: delegator #${d.id} ("${d.title}") — ${progress.why} — PARKED to review/blocked instead of nudging.`
        )
        try {
          db.prepare(
            "INSERT INTO activity_log (project, workspace, objective_id, session_id, event_type, title, detail) VALUES (?, ?, ?, ?, 'milestone', 'backstop_noprogress_parked', ?)"
          ).run(d.project || 'unknown', d.workspace, d.id, d.session_id, reason)
        } catch (err) {
          console.error(`[state-poller] Failed to log backstop-park for obj ${d.id}:`, err)
        }
        try {
          insertAlert({
            severity: 'high',
            source: 'state-poller',
            title: `Objective #${d.id} parked: ${progress.noProgress} no-progress backstop wakes`,
            message: reason,
            dedup_key: `backstop-noprogress-${d.id}`,
            url: `/objectives/${d.id}`,
          })
        } catch (err) {
          console.error(`[state-poller] Failed to alert backstop-park for obj ${d.id}:`, err)
        }
        clearBackstopState(d.id)
        const parked = db.prepare('SELECT * FROM objectives WHERE id = ?').get(d.id) as Objective
        if (parked) broadcast({ type: 'objective_updated', payload: parked })
        continue
      }

      console.warn(
        `[state-poller] Delegator backstop: delegator #${d.id} ("${d.title}") wedged in 'working' with no live session — ${decision.why} — ${progress.why} — nudging`
      )
      nudgeDelegator(d.id)
    } else if (decision.action === 'route-review') {
      runMachineStatusUpdate(
        db,
        "UPDATE objectives SET status = 'review', updated_at = datetime('now') WHERE id = ?",
        d.id,
      )
      clearBackstopState(d.id)
      const updated = db.prepare('SELECT * FROM objectives WHERE id = ?').get(d.id) as Objective
      broadcast({ type: 'objective_updated', payload: updated })
      console.warn(
        `[state-poller] Delegator backstop: delegator #${d.id} ("${d.title}") wedged in 'working' — ${decision.why} — moved to 'review'`
      )
    }
  }
}

