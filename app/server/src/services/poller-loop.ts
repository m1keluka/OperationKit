/**
 * Worker poll loop — extracted from state-poller.ts (behavior frozen).
 * startPoller/stopPoller stay on the facade and call pollActiveSessions.
 */
import fs from 'fs'
import path from 'path'
import { getDb } from '../db/index.js'
import {
  getSessionState,
  readJsonlTail,
  getSessionStartedAt,
  handleSessionDeath,
  isOverloadRetryPending,
  spawnReviewerSession,
  sendFollowUp,
  resolveWorkdir,
  startSession,
  sweepOrphanWorkerTmux,
} from './session-manager.js'
import {
  isFloorActiveForProject,
  getFloorConfig,
  runFloor,
  resolveFloorCwd,
  buildFloorFailFollowUp,
  isOutcomeVerificationActiveForObjective,
  getOutcomeAssertion,
  evaluateOutcomeGate,
  recordOutcomeRunRow,
  isOracleGateActiveForObjective,
  evaluateOracleGate,
  type FloorRunResult,
} from './deterministic-floor.js'
import { heartbeatBranchLease, releaseBranchLease } from './branch-lease.js'
import { heartbeatSessionLeasesForObjective, releaseSessionLeasesForObjective } from './session-lease.js'
import { logObjectiveAudit } from './objective-audit.js'
import { deriveBranchName } from './branch-scope.js'
import {
  isGateRejectionMemoryEnabled,
  isGateRejectionMemoryKilled,
  gateRejectionDecision,
} from './governance.js'
import {
  discoverAndBackfillPR,
  isPrAutolinkKilled,
} from './pr-linkage.js'
import { insertAlert } from './notifier.js'
import { runCompletionGate, applyGateHandback } from './ci-green-gate.js'
import { extractDeterministic } from './session-intel-parse.js'
import { queueExtraction } from './session-intel-pipeline.js'
import { hasArenaCohort } from './arena-lifecycle.js'
import { broadcast } from '../ws/index.js'
import { mustRouteToHumanReview } from '../lib/human-tracked.js'
import { classifyMergeLane, isRedLaneText, GREEN_LANE_FINDINGS, type MergeLane } from './merge-lane.js'
import { isBackendOnlyChange } from './design-context.js'
import { resolveFilesTouched } from './files-touched.js'
import { skipMachineStatusWrite, runMachineStatusUpdate } from '../lib/status-lock.js'
import type {
  Objective,
  ObjectiveStatus,
} from '@command-center/shared'
import { MAX_CONCURRENT_SESSIONS } from '@command-center/shared'
import { TRANSCRIPT_DIR, WATCHDOG_IDLE_FORCE_MS, WATCHDOG_WALLCLOCK_MS } from '../config.js'
import {
  MAX_NOOP_RESPAWNS,
  type NoOpDecision,
  decideDeadSessionRepark,
  classifyNoOpSpawn,
  resolveWorkerEndStatus,
  watchdogDecision,
} from './poller-decisions.js'
import {
  forceRouteStuckWorker,
  pollAIReviewSessions,
  sweepPRLinkageAndHarness,
  currentTreeShaForObjective,
  realGhExec,
  postHarnessStatus,
} from './poller-ai-review.js'
import {
  delegatorParentOf,
  continueDelegationOnCommit,
  reconcileDelegators,
  sweepOrphanedWorkingSessions,
  sweepWedgedDelegators,
} from './poller-delegator.js'
import {
  sweepTopLevelQueueStarter,
  sweepOrphanedQueueChildren,
  sweepAutoAcceptOnPass,
  writeHygieneDigest,
} from './poller-hygiene.js'
import {
  knowledgeScanOffsets,
  scopeScanOffsets,
  scanForKnowledgeWrites,
  scanForScopeBleed,
  handleLimitDeath,
  handleOverloadDeath,
  handleTurnsDeath,
  recordFloorRun,
  logFloorMilestone,
  promoteArenaCohortIfReady,
} from './poller-worker.js'

const MAX_AI_REVIEW_ITERATIONS = 5
// No-op-spawn guard (objective 840). A worker `claude` process can exit near-
// instantly (started_at == ended_at) producing ZERO tool calls and ZERO file
// changes — a process-level startup/auth/rate-limit exit before any model turn,
// NOT a finished deliverable. The pre-fix poller routed such an empty tree to a
// reviewer, which FAILed the nonexistent work and bounced it back, burning a
// review cycle and landing the objective in a false FAIL. We instead re-spawn the
// worker a bounded number of times; on exhaustion the objective is marked blocked
// (verdict='blocked') with a clear reason — never silently reviewed/failed.
// In-memory per-objective re-spawn budget (cleared on restart, à la autoResumeCounts).
// Keyed by objective id; reset to 0 once the objective produces a non-empty session.
export const noopRespawnCounts = new Map<number, number>()

// 30 min: Fable 5 at high effort can think for many minutes inside one turn
// with no JSONL writes — 10 min produced false stuck alerts on the best sessions.
const IDLE_THRESHOLD_MS = 30 * 60 * 1000
export const stuckAlerted = new Set<string>() // Avoid re-alerting same session
export const watchdogRouted = new Set<string>() // Avoid re-routing a session the watchdog already force-routed

/**
 * Delegator dormancy. A delegate_mode objective whose --print session has ended
 * is NOT awaiting a human — it ended a turn and is waiting to be woken when a
 * worker finishes (see wakeDelegator). While it still has in-flight workers
 * (planning/queue/working/ai_review) it must NOT enter the ai_review/review
 * lifecycle or trigger stuck alerts. Park it as a dormant 'working' orchestrator
 * with session_id cleared (so the poller's session-bound queries skip it);
 * wakeDelegator revives it via a fresh follow-up that resumes from NOTES.md.
 *
 * Children already at the human gate (`review`) or retired (`cancelled`) do NOT
 * count as in-flight. Counting them as pending parked parent 704132 in Working
 * forever while W11 sat in failed-review — fireWake will not auto-wake a
 * review parent, so the human gate is the correct place. Once no worker is
 * in-flight this returns false, so normal routing sends the delegator to
 * `review`. Returns true if it parked the objective (caller should skip routing).
 */
export function parkDelegatorIfWaiting(objective: Objective): boolean {
  if (!objective.delegate_mode || !objective.session_id) return false
  const db = getDb()
  if (skipMachineStatusWrite(db, objective.id)) return true
  const pending = (db.prepare(
    "SELECT COUNT(*) AS n FROM objectives WHERE parent_id = ? AND status IN ('planning','queue','working','ai_review')"
  ).get(objective.id) as { n: number }).n
  if (pending === 0) return false // no in-flight workers — let routing reach `review`
  handleSessionDeath(objective.session_id)
  stuckAlerted.delete(objective.session_id)
  watchdogRouted.delete(objective.session_id)
  runMachineStatusUpdate(
    db,
    "UPDATE objectives SET status = 'working', session_id = NULL, updated_at = datetime('now') WHERE id = ?",
    objective.id,
  )
  const updated = db.prepare('SELECT * FROM objectives WHERE id = ?').get(objective.id) as Objective
  if (updated) broadcast({ type: 'objective_updated', payload: updated })
  console.log(`[state-poller] Delegator #${objective.id} parked (orchestrating, ${pending} worker(s) pending) — no review/ai_review`)
  return true
}

export async function pollActiveSessions(): Promise<void> {
  // Drain the AI-review queue first so that a worker→review→worker bounce
  // happens in the same tick when possible.
  try {
    await pollAIReviewSessions()
  } catch (err) {
    console.error('[state-poller] pollAIReviewSessions failed:', err)
  }

  // Safety net: revive dormant delegators with workers awaiting processing.
  try {
    reconcileDelegators()
  } catch (err) {
    console.error('[state-poller] reconcileDelegators failed:', err)
  }

  // Safety net: recover objectives orphaned in 'working' with no session
  // (invisible to the poll query below, which requires session_id IS NOT NULL).
  try {
    sweepOrphanedWorkingSessions()
  } catch (err) {
    console.error('[state-poller] sweepOrphanedWorkingSessions failed:', err)
  }

  // Safety net: recover DELEGATORS wedged in 'working' with no live session.
  // Delegators are exempt from the watchdog and the orphan sweep, and reconcile
  // is signature-gated; this time-throttled backstop is the ONLY net that
  // recovers a delegator whose recovery signal never lands (spent signature).
  try {
    sweepWedgedDelegators()
  } catch (err) {
    console.error('[state-poller] sweepWedgedDelegators failed:', err)
  }

  try {
    sweepOrphanWorkerTmux()
  } catch (err) {
    console.error('[state-poller] sweepOrphanWorkerTmux failed:', err)
  }

  // Safety net (obj 2352): auto-link worker PRs that never self-reported and
  // re-post the harness/test-agent status for any pass-verdict PR that lacks it,
  // so a PR can never strand behind the required gate. Idempotent + killable.
  try {
    await sweepPRLinkageAndHarness()
  } catch (err) {
    console.error('[state-poller] sweepPRLinkageAndHarness failed:', err)
  }

  // Board-hygiene sweeps (obj 700595). All three are internally throttled + flag-
  // gated (queue-drainer / auto-accept DEFAULT OFF); the digest is always written
  // but is read-only unless the hard-expiry flag is armed. Each is wrapped so one
  // failure never breaks the poll loop.
  try {
    await sweepOrphanedQueueChildren()
  } catch (err) {
    console.error('[state-poller] sweepOrphanedQueueChildren failed:', err)
  }
  // obj 701663 — autonomous starter for TOP-LEVEL bulk-route queue cards (the
  // missing scheduler that stranded the distill backlog). DEFAULT ON, tightly
  // allowlisted, cap-respecting; wrapped so one failure never breaks the loop.
  try {
    await sweepTopLevelQueueStarter()
  } catch (err) {
    console.error('[state-poller] sweepTopLevelQueueStarter failed:', err)
  }
  try {
    await sweepAutoAcceptOnPass()
  } catch (err) {
    console.error('[state-poller] sweepAutoAcceptOnPass failed:', err)
  }
  try {
    writeHygieneDigest()
  } catch (err) {
    console.error('[state-poller] writeHygieneDigest failed:', err)
  }

  const db = getDb()
  const actives = db
    .prepare("SELECT * FROM objectives WHERE status IN ('working', 'review') AND session_id IS NOT NULL")
    .all() as Objective[]

  for (const objective of actives) {
    if (!objective.session_id) continue
    // Human already clicked Done/Cancelled this tick (or earlier). Do not
    // route a dying tmux session back to Needs You / Working over that.
    if (skipMachineStatusWrite(db, objective.id)) continue

    // A 529 overload retry is scheduled for this session — its tmux process is
    // dead while we wait out the backoff, so skip it this tick. Handling it here
    // would route the (transiently) dead session into review and double-spawn.
    if (isOverloadRetryPending(objective.session_id)) continue

    // Design Arena (obj 594) — DORMANT unless a cohort was registered (only happens
    // when shouldRunArena was true at spawn). When all variant sessions finish, this
    // renders+ranks+promotes the winner by repointing session_id at the winning
    // variant; the very next tick then routes that winner into ai_review via the
    // UNCHANGED transition below. While the cohort is still building, skip this tick.
    if (hasArenaCohort(objective.id)) {
      try {
        await promoteArenaCohortIfReady(objective)
      } catch (err) {
        console.error(`[state-poller] arena cohort eval failed for #${objective.id}:`, err)
      }
      continue
    }

    // Real-time knowledge capture — scan for vault writes mid-session
    if (objective.status === 'working') {
      try {
        scanForKnowledgeWrites(objective.session_id, objective.id)
      } catch (err) {
        // Non-fatal — don't break polling if knowledge scan fails
      }

      // obj 994 — keep this objective's branch lease alive while it works, and
      // scan for scope-bleed (foreign branch ops / cross-project edits).
      try {
        const ownedBranch = deriveBranchName(objective)
        if (ownedBranch) {
          heartbeatBranchLease(getDb(), ownedBranch, objective.id)
        } else {
          // obj 1075 — non-PR objective: keep its identity lease(s) alive while it
          // works, so a duplicate wake reattaches/refuses instead of double-spawning.
          heartbeatSessionLeasesForObjective(getDb(), objective.id)
        }
        scanForScopeBleed(objective)
      } catch (err) {
        // Non-fatal — guardrail telemetry must never break the poll loop.
      }
    }

    const detectedState = getSessionState(objective.session_id)

    // Stuck session detection
    if (detectedState === 'working' && !stuckAlerted.has(objective.session_id!)) {
      const jsonlPath = path.join(TRANSCRIPT_DIR, `${objective.session_id}.jsonl`)
      try {
        const stat = fs.statSync(jsonlPath)
        const idleMs = Date.now() - stat.mtimeMs
        if (idleMs > IDLE_THRESHOLD_MS) {
          stuckAlerted.add(objective.session_id!)
          broadcast({
            type: 'session_stuck',
            payload: {
              objective_id: objective.id,
              session_id: objective.session_id!,
              reason: `No output for ${Math.round(idleMs / 60000)} minutes`,
            },
          })
        }
      } catch {}

      // Check for repeated errors in recent output. Only the last 20 lines
      // matter, so read the transcript tail instead of the whole file — this
      // check runs for every working session on every 3s poll tick.
      try {
        const content = readJsonlTail(jsonlPath)
        const lines = content.trim().split('\n').slice(-20)
        let errorCount = 0
        for (const line of lines) {
          try {
            const event = JSON.parse(line)
            if (event.type === 'error') errorCount++
          } catch {}
        }
        if (errorCount >= 3 && !stuckAlerted.has(objective.session_id!)) {
          stuckAlerted.add(objective.session_id!)
          broadcast({
            type: 'session_stuck',
            payload: {
              objective_id: objective.id,
              session_id: objective.session_id!,
              reason: `${errorCount} errors in recent output`,
            },
          })
        }
      } catch {}
    }

    // ── Watchdog force-route (ST3) ──────────────────────────────────────────
    // Runs independently of the soft `stuckAlerted` gate above (which fires at
    // 30 min and then suppresses itself) so a session that already alerted is
    // still force-routed once it crosses the larger idle/wall-clock thresholds.
    // Delegators parked as dormant orchestrators are exempt — their "idleness"
    // is by design while they wait on workers.
    if (detectedState === 'working' && !watchdogRouted.has(objective.session_id!) && !objective.delegate_mode) {
      try {
        const jsonlPath = path.join(TRANSCRIPT_DIR, `${objective.session_id}.jsonl`)
        const stat = fs.statSync(jsonlPath)
        const now = Date.now()
        const idleMs = now - stat.mtimeMs
        // Wall-clock must measure the CURRENT spawn, not the objective's whole
        // life. The transcript file is appended across every resume, so its
        // birthtime is the first-ever start — using it force-routed a just-resumed
        // follow-up straight to review on any objective older than the budget
        // (obj 1234 sent a follow-up and was killed 1s later). `getSessionStartedAt`
        // is restart-durable (obj 705463): it prefers the in-memory spawn start and
        // rehydrates from the persisted `session_spawns` row when the map was wiped
        // by a server restart. The birthtime fallback below therefore only applies
        // to a session this server has genuinely never spawned — before the durable
        // clock, a post-restart resume measured from the first-ever spawn and force-
        // routed instantly with a fake runtime (702774: 30348 min vs 0.6 min of work).
        const spawnStartMs = getSessionStartedAt(objective.session_id!)
        const startMs = spawnStartMs ?? (stat.birthtimeMs || stat.ctimeMs)
        const wallClockMs = now - startMs
        const decision = watchdogDecision({
          idleMs,
          wallClockMs,
          idleForceMs: WATCHDOG_IDLE_FORCE_MS,
          wallClockLimitMs: WATCHDOG_WALLCLOCK_MS,
        })
        if (decision.forceRoute && decision.reason) {
          watchdogRouted.add(objective.session_id!)
          const detail = decision.reason === 'idle'
            ? `idle ${Math.round(idleMs / 60000)} min (threshold ${Math.round(WATCHDOG_IDLE_FORCE_MS / 60000)} min)`
            : `running ${Math.round(wallClockMs / 60000)} min (budget ${Math.round(WATCHDOG_WALLCLOCK_MS / 60000)} min)`
          forceRouteStuckWorker(objective, decision.reason, detail)
          continue  // routed off `working`; skip the normal transition handling this tick
        }
      } catch (err) {
        // Fail-safe: a stat/route error must never wedge the poller.
        console.error(`[state-poller] watchdog check failed for obj ${objective.id}:`, err)
      }
    }

    if (detectedState === 'dead') {
      // Delegator waiting on workers → park as dormant orchestrator, skip review.
      if (parkDelegatorIfWaiting(objective)) continue
      stuckAlerted.delete(objective.session_id!)
      watchdogRouted.delete(objective.session_id!)
      knowledgeScanOffsets.delete(objective.session_id!)
      scopeScanOffsets.delete(objective.session_id!)
      const death = handleSessionDeath(objective.session_id!)

      // Account hit a usage/spend limit → auto-rotate to a fresh account and
      // resume uninterrupted (or queue for auto-resume when all are limited),
      // instead of dumping to a manual-resume review. (objective 337)
      // NOTE: the branch lease is intentionally NOT released here — the same
      // objective resumes under the same session id, so it keeps ownership.
      if (death.limitHit && handleLimitDeath(objective, death.spendCapHit)) continue

      // Anthropic 529 (Overloaded) → retry the SAME session after a backoff
      // instead of parking (rotation is futile; it hits every account). The
      // backoff respawn is scheduled inside autoResumeOnOverload; the pending
      // guard at the top of the loop keeps us from re-handling it meanwhile.
      if (death.overloaded && handleOverloadDeath(objective)) continue

      // Per-spawn turn cap (--max-turns) fired on a still-productive session →
      // auto-continue the SAME session (bounded) instead of stranding it for a
      // manual Resume. Wired BEFORE the route-to-review fallthrough; when the
      // continue budget is exhausted/disabled it returns false and we fall
      // through to review, so a genuine runaway is still stopped. (obj 1487)
      if (death.turnsExhausted && handleTurnsDeath(objective)) continue

      // Session died unexpectedly -- mark as review so user can investigate.
      // Release the branch lease (obj 994) so a re-open does a fresh acquire+spawn
      // rather than reattaching to the now-dead session.
      const deadBranch = deriveBranchName(objective)
      if (deadBranch) {
        try { releaseBranchLease(getDb(), deadBranch) } catch { /* non-fatal */ }
      } else {
        // obj 1075 — non-PR objective died: release its identity lease(s) so a
        // legit reopen does a fresh acquire+spawn rather than reattaching to the
        // corpse. (Not reached on limitHit — handleLimitDeath continued above and
        // keeps the lease, since auto-resume stays under the same session id.)
        try { releaseSessionLeasesForObjective(getDb(), objective.id) } catch { /* non-fatal */ }
      }
      // ── FIX A (obj 700415) — kill the MODE-1 dead-session re-park churn ────
      // A `review` objective whose session died with a resultless transcript is
      // re-selected by the poll query every tick (it requires session_id IS NOT
      // NULL) and re-written status='review'+updated_at here, WITHOUT ever
      // clearing session_id — so it can never leave the select set → infinite
      // re-park churn + an objective_updated broadcast every tick (deliverable A
      // §3, live on #2/#3). When re-parking an ALREADY-`review` dead session in
      // place, clear session_id so the row drops out of the select set after one
      // pass; and skip the write entirely when nothing would change (no
      // updated_at bump, no broadcast). Human reopen mints a fresh session_id
      // regardless, so it is unaffected. Working→review transitions keep the
      // current behavior (session_id retained for inspection of the just-died
      // working spawn). Gated by CC_POLL_CLEAR_DEAD_SESSION (default ON).
      if (skipMachineStatusWrite(db, objective.id)) continue
      const reparkAction = decideDeadSessionRepark(objective)
      if (reparkAction === 'skip-noop') {
        // Nothing would change — emit nothing (no updated_at bump / broadcast).
        continue
      }
      if (reparkAction === 'clear-session') {
        logObjectiveAudit(db, {
          objectiveId: objective.id,
          eventType: 'status_change',
          fromStatus: objective.status,
          toStatus: 'review',
          actor: 'state-poller',
          pathway: 'dead-session-repark-clear',
          sessionId: objective.session_id,
          titleSnapshot: objective.title,
          workspace: objective.workspace,
        })
        runMachineStatusUpdate(
          db,
          "UPDATE objectives SET status = 'review', session_id = NULL, updated_at = datetime('now') WHERE id = ?",
          objective.id,
        )
        const cleared = db
          .prepare('SELECT * FROM objectives WHERE id = ?')
          .get(objective.id) as Objective
        broadcast({ type: 'objective_updated', payload: cleared })
        continue
      }

      // route-to-review: working→review (session died) — unchanged behavior. Audit the transition.
      if (objective.status !== 'review') {
        logObjectiveAudit(db, {
          objectiveId: objective.id,
          eventType: 'status_change',
          fromStatus: objective.status,
          toStatus: 'review',
          actor: 'state-poller',
          pathway: 'dead-session-route-to-review',
          sessionId: objective.session_id,
          titleSnapshot: objective.title,
          workspace: objective.workspace,
        })
      }
      runMachineStatusUpdate(
        db,
        "UPDATE objectives SET status = 'review', updated_at = datetime('now') WHERE id = ?",
        objective.id,
      )

      const updated = db
        .prepare('SELECT * FROM objectives WHERE id = ?')
        .get(objective.id) as Objective

      broadcast({ type: 'objective_updated', payload: updated })
      continue
    }

    const newStatus: ObjectiveStatus = detectedState
    if (newStatus !== objective.status) {
      // Delegator finished a turn but still has pending workers → park as a
      // dormant orchestrator instead of routing to ai_review/review.
      if (parkDelegatorIfWaiting(objective)) continue
      // Session finished (or hit rate limit) — clean up account slot + detect rate limits
      if (newStatus === 'review' && objective.status === 'working') {
        const death = handleSessionDeath(objective.session_id!)
        // Account hit a usage/spend limit → auto-rotate to a fresh account and
        // resume uninterrupted (or queue for auto-resume when all are limited),
        // instead of routing to review/ai_review for a manual resume. (objective 337)
        if (death.limitHit && handleLimitDeath(objective, death.spendCapHit)) continue
        // Anthropic 529 (Overloaded) → retry the same session after a backoff.
        if (death.overloaded && handleOverloadDeath(objective)) continue
        // Per-spawn turn cap (--max-turns) on a productive session → auto-continue
        // the SAME session (bounded), before the route-to-review fallthrough. (obj 1487)
        if (death.turnsExhausted && handleTurnsDeath(objective)) continue
      }

      // ── PR auto-linkage at session-end (obj 2352) ─────────────────────────
      // A worker just ended (working→review). Before it flows into the reviewer
      // (or Green-lane harness post), try to link the PR from the server-derived
      // branch — so linkage never depends on the worker having called /pr-created.
      // Idempotent (no-ops once pr_number is set), best-effort (never throws),
      // bounded by the gh timeout. Copy the linked PR onto the in-memory row so
      // the same tick can classify files, run the CI-green gate, and post harness.
      if (
        newStatus === 'review' &&
        objective.status === 'working' &&
        objective.create_pr &&
        objective.pr_number == null &&
        !isPrAutolinkKilled(db)
      ) {
        try {
          const linked = await discoverAndBackfillPR(db, objective, realGhExec)
          if (linked.linked) {
            if (linked.pr_number != null) objective.pr_number = linked.pr_number
            if (linked.pr_url) objective.pr_url = linked.pr_url
            if (linked.branch) objective.branch_name = linked.branch
          }
        } catch (err) {
          console.warn(`[state-poller] session-end PR discovery failed for obj ${objective.id}:`, (err as Error).message)
        }
      }

      // ── No-op-spawn guard (objective 840) ─────────────────────────────────
      // Before routing a just-ended worker into the review lifecycle, check the
      // synchronous deterministic intel: a session with 0 tool calls AND 0 file
      // changes never actually executed (the claude process exited before any
      // model turn). Reviewing it manufactures a false FAIL on an empty tree;
      // re-spawn it (bounded) instead. Delegators are excluded — their
      // "deliverable" is orchestration and they have a separate parked lifecycle
      // (parkDelegatorIfWaiting / wakeDelegator).
      let skipAiReviewForShortSession = false
      if (
        newStatus === 'review' &&
        objective.status === 'working' &&
        !objective.delegate_mode &&
        objective.session_id
      ) {
        let decision: NoOpDecision = { isNoOp: false, action: 'none' }
        try {
          const intel = await extractDeterministic(
            path.join(TRANSCRIPT_DIR, `${objective.session_id}.jsonl`)
          )
          decision = classifyNoOpSpawn(
            {
              toolCalls: intel.toolCalls,
              filesCreated: intel.filesCreated.length,
              filesModified: intel.filesModified.length,
              durationMs: intel.durationMs,
            },
            noopRespawnCounts.get(objective.id) || 0
          )
        } catch (err) {
          // Can't parse the transcript → don't risk a false positive; fall
          // through to normal routing (the genuine-empty-deliverable path).
          console.warn(
            `[state-poller] no-op check: failed to parse intel for objective ${objective.id} (${objective.session_id}):`,
            err
          )
        }

        if (decision.action === 'respawn') {
          // No-op spawn re-queued — NOT a deliverable, do NOT spawn a reviewer.
          noopRespawnCounts.set(objective.id, decision.attempt!)
          console.warn(
            `[state-poller] No-op spawn detected for objective ${objective.id} (0 tool calls / 0 file changes, attempt ${decision.attempt}/${MAX_NOOP_RESPAWNS}) — re-spawning worker, no reviewer.`
          )
          try {
            db.prepare(
              "INSERT INTO activity_log (project, workspace, objective_id, session_id, event_type, title, detail) VALUES (?, ?, ?, ?, 'milestone', 'noop_spawn_requeued', ?)"
            ).run(
              objective.project || 'unknown',
              objective.workspace,
              objective.id,
              objective.session_id,
              `Worker session produced 0 tool calls / 0 file changes (no-op spawn). Re-spawning worker, attempt ${decision.attempt}/${MAX_NOOP_RESPAWNS}; no reviewer spawned.`
            )
          } catch (err) {
            console.error(`[state-poller] Failed to log noop-requeue for obj ${objective.id}:`, err)
          }
          try {
            const newSessionId = await startSession(objective)
            runMachineStatusUpdate(
              db,
              "UPDATE objectives SET status = 'working', session_id = ?, ai_review_verdict = NULL, ai_review_findings = NULL, updated_at = datetime('now') WHERE id = ?",
              newSessionId,
              objective.id,
            )
          } catch (err) {
            // All accounts exhausted → startSession already enqueued the
            // objective with the account-router; park it in `queue` so the
            // queue-drain (queue→working PATCH) re-spawns it when a slot frees.
            console.warn(
              `[state-poller] No-op respawn for objective ${objective.id} deferred (accounts busy) — parked in queue: ${err}`
            )
            runMachineStatusUpdate(
              db,
              "UPDATE objectives SET status = 'queue', session_id = NULL, updated_at = datetime('now') WHERE id = ?",
              objective.id,
            )
          }
          const updated = db.prepare('SELECT * FROM objectives WHERE id = ?').get(objective.id) as Objective
          if (updated) broadcast({ type: 'objective_updated', payload: updated })
          continue
        } else if (decision.action === 'block') {
          // Bounded re-spawns exhausted → block (never a false-FAIL review,
          // never silently done). Mirrors the reviewer-no-verdict blocked path.
          noopRespawnCounts.delete(objective.id)
          const reason = `Worker spawn produced 0 tool calls / 0 file changes across ${MAX_NOOP_RESPAWNS} re-spawn attempts — the claude process exited before executing any work (no-op spawn). Not a deliverable; never reviewed. Needs manual investigation (process-level startup/auth/rate-limit exit).`
          console.warn(
            `[state-poller] No-op spawn for objective ${objective.id} exhausted ${MAX_NOOP_RESPAWNS} re-spawns — marking blocked.`
          )
          runMachineStatusUpdate(
            db,
            "UPDATE objectives SET status = 'review', ai_review_verdict = 'blocked', ai_review_findings = ?, updated_at = datetime('now') WHERE id = ?",
            reason,
            objective.id,
          )
          try {
            db.prepare(
              "INSERT INTO activity_log (project, workspace, objective_id, session_id, event_type, title, detail) VALUES (?, ?, ?, ?, 'milestone', 'noop_spawn_blocked', ?)"
            ).run(
              objective.project || 'unknown',
              objective.workspace,
              objective.id,
              objective.session_id,
              reason
            )
          } catch (err) {
            console.error(`[state-poller] Failed to log noop-blocked for obj ${objective.id}:`, err)
          }
          const updated = db.prepare('SELECT * FROM objectives WHERE id = ?').get(objective.id) as Objective
          if (updated) broadcast({ type: 'objective_updated', payload: updated })
          continue
        } else if (decision.action === 'skip-reviewer') {
          skipAiReviewForShortSession = true
          noopRespawnCounts.delete(objective.id)
          console.warn(
            `[state-poller] Short empty-tree session for objective ${objective.id} — skipping AI reviewer (human review only).`,
          )
        } else {
          // Genuine non-empty session (or unparseable) — reset the re-spawn
          // budget so a future unrelated run starts fresh, then route normally.
          noopRespawnCounts.delete(objective.id)
        }
      }

      // Type-aware auto-advance when a worker session ends successfully.
      // Green lane skips the tmux reviewer (CI is the gate). Yellow/Red keep
      // the existing table in resolveWorkerEndStatus.
      let resolvedStatus: ObjectiveStatus = newStatus
      let mergeLane: MergeLane | undefined
      if (newStatus === 'review' && objective.status === 'working') {
        const skipAi = !!(objective as Objective & { skip_ai_review?: boolean | number }).skip_ai_review
        let filesKnown = false
        let uiTouched = false
        if (objective.create_pr) {
          try {
            const { files } = await resolveFilesTouched(db, objective, { ghExec: realGhExec })
            filesKnown = files.length > 0
            uiTouched = filesKnown && !isBackendOnlyChange(files)
          } catch (err) {
            console.warn(`[state-poller] merge-lane file list failed for obj ${objective.id}:`, (err as Error).message)
          }
        }
        mergeLane = classifyMergeLane({
          type: objective.type,
          createPr: !!objective.create_pr,
          delegateMode: !!objective.delegate_mode,
          redPath: isRedLaneText(objective),
          filesKnown,
          uiTouched,
        })
        resolvedStatus = resolveWorkerEndStatus({
          type: objective.type,
          delegateMode: !!objective.delegate_mode,
          createPr: !!objective.create_pr,
          skipAi,
          hasDelegatorParent: delegatorParentOf(objective) != null,
          isRoutine: objective.routine_id != null,
          lane: mergeLane,
        })
        if (mergeLane === 'green') {
          console.log(`[state-poller] Green lane obj ${objective.id} (${objective.type}) — skip LLM reviewer → ${resolvedStatus}`)
        }
        if (skipAiReviewForShortSession && resolvedStatus === 'ai_review') {
          resolvedStatus = 'review'
          console.warn(
            `[state-poller] Objective ${objective.id} produced no files in under 35s — routing to human review instead of ai_review.`,
          )
        }
      }

      // ── Re-review churn guard (objective 360) ──────────────────────────────
      // A PASS is terminal: never re-queue an already-passed deliverable for
      // another review, and never let consecutive reviews accumulate unbounded
      // iterations. This was the single largest source of wasted sessions —
      // obj-238 ran 17 review iterations (iter 1 already passed), obj-191 ran 16,
      // each burning a full reviewer session on the same unchanged deliverable
      // every time the worker was resurrected to `working`. A `fail` verdict is
      // NOT terminal here (fix-then-re-review still works); only `pass` and the
      // absolute cap short-circuit. A deliberate re-review remains available via
      // the manual `ai_review` override route, which sets status directly.
      if (resolvedStatus === 'ai_review') {
        const alreadyPassed = objective.ai_review_verdict === 'pass'
        const atAbsoluteCap = (objective.ai_review_iteration || 0) >= MAX_AI_REVIEW_ITERATIONS
        if (alreadyPassed || atAbsoluteCap) {
          // Forward status mirrors the reviewer PASS branch: project → human
          // review gate, everything else → done.
          const forwardStatus: ObjectiveStatus = objective.type === 'project' ? 'review' : 'done'
          const why = alreadyPassed
            ? `already passed AI review (verdict=pass, iteration ${objective.ai_review_iteration})`
            : `hit absolute AI-review cap (${MAX_AI_REVIEW_ITERATIONS} iterations)`
          resolvedStatus = forwardStatus
          console.log(`[state-poller] Skipping re-review for objective ${objective.id} — ${why} → ${forwardStatus}`)
          try {
            db.prepare(
              `INSERT INTO activity_log (project, workspace, objective_id, session_id, event_type, title, detail)
               VALUES (?, ?, ?, ?, 'milestone', 'ai_review_rereview_skipped', ?)`
            ).run(
              objective.project || 'unknown',
              objective.workspace,
              objective.id,
              objective.session_id,
              `${why}; advanced to ${forwardStatus} instead of spawning another reviewer.`
            )
          } catch (err) {
            console.error(`[state-poller] Failed to log rereview-skip for obj ${objective.id}:`, err)
          }
        }
      }

      // ── KL-21 gate-rejection memory (obj-2509) ─────────────────────────────
      // If the objective was already REJECTED (verdict=fail) and its head tree is
      // byte-identical to the tree it was rejected on, re-grading it burns a full
      // auditor session on an unchanged deliverable (one of this objective's two
      // named active blockers: token waste re-grading unchanged trees). Mark it
      // NOT_MERGEABLE and route to the human gate WITHOUT spawning the reviewer.
      // Flag-gated (default OFF) + kill switch; the outer guard also avoids the git
      // tree-SHA call entirely while the flag is off. Fails OPEN: any null SHA or a
      // changed tree falls through and the auditor runs exactly as today.
      if (
        resolvedStatus === 'ai_review' &&
        isGateRejectionMemoryEnabled(db) &&
        !isGateRejectionMemoryKilled(db)
      ) {
        const currentTreeSha = currentTreeShaForObjective(objective)
        const decision = gateRejectionDecision({
          enabled: true,
          killed: false,
          priorVerdict: objective.ai_review_verdict,
          rejectedTreeSha: (objective as Objective & { rejected_tree_sha?: string | null }).rejected_tree_sha,
          currentTreeSha,
        })
        if (decision.skipAuditor) {
          const forwardStatus: ObjectiveStatus = objective.type === 'project' ? 'review' : 'done'
          resolvedStatus = mustRouteToHumanReview(objective) && forwardStatus === 'done' ? 'review' : forwardStatus
          db.prepare(
            "UPDATE objectives SET not_mergeable = 1, updated_at = datetime('now') WHERE id = ?"
          ).run(objective.id)
          console.log(`[state-poller] KL-21 gate-rejection memory: skipping auditor for obj ${objective.id} — ${decision.reason} → ${resolvedStatus}`)
          try {
            db.prepare(
              `INSERT INTO activity_log (project, workspace, objective_id, session_id, event_type, title, detail)
               VALUES (?, ?, ?, ?, 'milestone', 'gate_rejection_memory_skip', ?)`
            ).run(
              objective.project || 'unknown',
              objective.workspace,
              objective.id,
              objective.session_id,
              `${decision.reason}; advanced to ${resolvedStatus} without spawning a reviewer.`,
            )
          } catch (err) {
            console.error(`[state-poller] Failed to log gate-rejection skip for obj ${objective.id}:`, err)
          }
        }
      }

      // ── ST1: deterministic floor (P1+P2) ──────────────────────────────────
      // A worker just finished (working→review). Before trusting its process-exit
      // and advancing to the LLM reviewer / review / done, run the linked
      // project's deterministic checks. The floor sits UNDER the LLM review: a red
      // floor short-circuits the transition entirely (the reviewer never spawns),
      // so the LLM verdict cannot override it. fail-safe-OPEN so a floor bug can
      // never wedge the board.
      //
      // Activation is per-project (obj 2335): the floor runs when the project is
      // active via isFloorActiveForProject — i.e. the GLOBAL flag is on OR this
      // project has its own `floor_config:<project>` opt-in row. That lets one
      // pilot arm the floor while `deterministic_floor_enabled` stays 0 in code.
      // NOTE: getSessionState only yields working|review|dead, so a worker's
      // session-end is always newStatus==='review' here — resolvedStatus may still
      // be `done` (task/bug), so this entry already covers the working→done
      // session-end path. The OTHER working→done path — a self-claimed PATCH
      // straight to `done` — is gated symmetrically in routes/objectives.ts.
      if (objective.status === 'working' && newStatus === 'review' && isFloorActiveForProject(db, objective.project)) {
        let floorCfg: ReturnType<typeof getFloorConfig> = null
        let cfgError = false
        try {
          floorCfg = getFloorConfig(db, objective.project)
        } catch (err) {
          // Malformed config row = INFRA failure → fail-safe-OPEN (log + skip).
          cfgError = true
          console.error(`[state-poller][floor] config parse error for obj ${objective.id} (${objective.project}) — FAILING OPEN:`, err)
          logFloorMilestone(db, objective, 'floor_open', `config parse error; gate skipped (fail-open): ${String(err)}`)
        }

        // resolveWorkdir fails closed for an unresolvable project-linked objective
        // (obj 1451). The floor is an advisory gate on an already-running session,
        // so a throw here must NOT crash the poll loop — resolve the cwd defensively
        // and, on failure, treat it as a fail-safe-OPEN (skip the gate, advance as
        // today) exactly like a config parse error.
        let floorCwd: string | null = null
        if (!cfgError && floorCfg) {
          try {
            floorCwd = resolveFloorCwd(objective, () => resolveWorkdir(objective))
          } catch (err) {
            console.warn(`[state-poller][floor] resolveWorkdir failed for obj ${objective.id} — skipping floor (fail-open): ${err instanceof Error ? err.message : err}`)
            logFloorMilestone(db, objective, 'floor_open', `resolveWorkdir threw; gate skipped (fail-open): ${String(err)}`)
          }
        }
        if (!cfgError && floorCfg && floorCwd !== null) {
          const cwd = floorCwd
          let run: FloorRunResult
          try {
            run = runFloor(floorCfg, cwd)
          } catch (err) {
            // Any unexpected throw from the run path itself → fail-safe-OPEN.
            run = { outcome: 'open', commands: [], openReason: `runFloor threw: ${String(err)}` }
          }
          recordFloorRun(db, objective, resolvedStatus, cwd, run)

          if (run.outcome === 'fail') {
            // ── RED FLOOR → automatic fail, routed back to the worker. ──
            // The LLM reviewer is NOT spawned, so its verdict cannot override.
            const llmWouldHaveRun = resolvedStatus === 'ai_review'
            logFloorMilestone(
              db,
              objective,
              'floor_caught_failure',
              `Deterministic floor FAILED on \`${run.failedCommand}\` — objective auto-failed. ` +
                `Without the floor this would have ${llmWouldHaveRun ? 'reached the LLM reviewer (whose pass could not override the red floor)' : `advanced straight to ${resolvedStatus} UNREVIEWED`}. ` +
                `This is the verifier signal: the floor caught a failure the LLM verdict would have passed.`,
            )
            console.log(`[state-poller][floor] RED floor on obj ${objective.id} (${run.failedCommand}) — auto-fail, LLM review bypassed.`)
            const followUp = buildFloorFailFollowUp(run)
            db.prepare(
              "UPDATE objectives SET ai_review_verdict = 'fail', ai_review_findings = ?, updated_at = datetime('now') WHERE id = ?",
            ).run(followUp, objective.id)
            if (objective.session_id) {
              try {
                const newSessionId = sendFollowUp(objective.session_id, followUp, objective)
                runMachineStatusUpdate(
                  db,
                  "UPDATE objectives SET status = 'working', session_id = ?, updated_at = datetime('now') WHERE id = ?",
                  newSessionId,
                  objective.id,
                )
                console.log(`[state-poller][floor] obj ${objective.id} bounced to worker session ${newSessionId} with floor findings`)
              } catch (err) {
                console.error(`[state-poller][floor] failed to send floor-fail follow-up for obj ${objective.id}:`, err)
                runMachineStatusUpdate(
                  db,
                  "UPDATE objectives SET status = 'review', updated_at = datetime('now') WHERE id = ?",
                  objective.id,
                )
              }
            } else {
              runMachineStatusUpdate(
                db,
                "UPDATE objectives SET status = 'review', updated_at = datetime('now') WHERE id = ?",
                objective.id,
              )
            }
            const updated = db.prepare('SELECT * FROM objectives WHERE id = ?').get(objective.id) as Objective
            broadcast({ type: 'objective_updated', payload: updated })
            continue // gate applied — never reach the reviewer/advance path
          } else if (run.outcome === 'open') {
            // ── FAIL-SAFE-OPEN: infra error/timeout → log loudly, skip the gate. ──
            console.error(`[state-poller][floor] FAIL-OPEN on obj ${objective.id}: ${run.openReason} — proceeding as today.`)
            logFloorMilestone(db, objective, 'floor_open', `gate skipped (fail-open): ${run.openReason}`)
            // fall through to the normal advance path
          } else {
            // ── GREEN FLOOR → proceed; the floor verified the build. ──
            logFloorMilestone(db, objective, 'floor_pass', `all ${floorCfg.commands.length} check(s) green; advancing to ${resolvedStatus}`)
            console.log(`[state-poller][floor] GREEN floor on obj ${objective.id} → ${resolvedStatus}`)
          }
        }

        // P2 instrumentation: every working→done-ish transition records whether
        // it was floor-gated. Bypasses (project not opted-in, untestable noop)
        // are logged with the completion_goal as the admin-reviewable justification.
        const wasGated = !cfgError && !!floorCfg && floorCwd !== null
        logFloorMilestone(
          db,
          objective,
          'floor_transition',
          `working→${resolvedStatus} floor-gated=${wasGated}` +
            (wasGated
              ? ''
              : ` (noop/bypass — ${objective.completion_goal ? 'completion_goal attached as justification' : 'NO completion_goal justification'})`),
        )
      }

      // ── Oracle hard merge gate (obj 700316, Stage-C enforcement) ───────────
      // When `kitchen_loop_oracle_gate` is ON, run the command-center-infra
      // regression oracle (spec/cc-oracle.mjs, QUICK) as a HARD gate under the LLM
      // reviewer: a non-GREEN verdict BLOCKS the transition and bounces the worker,
      // exactly like a red floor. SCOPE GUARD: isOracleGateActiveForObjective is
      // true ONLY when the flag is on AND project === 'command-center-infra', so no
      // other workspace can ever be gated — even with the flag on. Flag OFF ⇒ this
      // block is never entered ⇒ behaviour byte-for-byte identical to today.
      // fail-safe-OPEN: any infra failure running the oracle proceeds as today.
      if (
        objective.status === 'working' &&
        newStatus === 'review' &&
        isOracleGateActiveForObjective(db, objective)
      ) {
        const oracleDecision = evaluateOracleGate({
          resolveCwd: () => resolveFloorCwd(objective, () => resolveWorkdir(objective)),
          run: (cfg, cwd) => runFloor(cfg, cwd),
          logMilestone: (title, detail) => logFloorMilestone(db, objective, title, detail),
        })
        if (oracleDecision.action === 'block') {
          logFloorMilestone(
            db,
            objective,
            'oracle_caught_regression',
            `Regression oracle returned non-GREEN — objective auto-failed (working→${resolvedStatus} blocked). ` +
              `The oracle sits under the AI review; a non-GREEN verdict cannot be overridden.`,
          )
          console.log(`[state-poller][oracle] RED oracle on obj ${objective.id} — auto-fail, advance bypassed.`)
          const followUp = oracleDecision.followUp
          db.prepare(
            "UPDATE objectives SET ai_review_verdict = 'fail', ai_review_findings = ?, updated_at = datetime('now') WHERE id = ?",
          ).run(followUp, objective.id)
          if (objective.session_id) {
            try {
              const newSessionId = sendFollowUp(objective.session_id, followUp, objective)
              runMachineStatusUpdate(
                db,
                "UPDATE objectives SET status = 'working', session_id = ?, updated_at = datetime('now') WHERE id = ?",
                newSessionId,
                objective.id,
              )
              console.log(`[state-poller][oracle] obj ${objective.id} bounced to worker session ${newSessionId} with oracle findings`)
            } catch (err) {
              console.error(`[state-poller][oracle] failed to send oracle-fail follow-up for obj ${objective.id}:`, err)
              runMachineStatusUpdate(
                db,
                "UPDATE objectives SET status = 'review', updated_at = datetime('now') WHERE id = ?",
                objective.id,
              )
            }
          } else {
            runMachineStatusUpdate(
              db,
              "UPDATE objectives SET status = 'review', updated_at = datetime('now') WHERE id = ?",
              objective.id,
            )
          }
          const updated = db.prepare('SELECT * FROM objectives WHERE id = ?').get(objective.id) as Objective
          broadcast({ type: 'objective_updated', payload: updated })
          continue // oracle gate applied — never reach the reviewer/advance path
        }
      }

      // ── Outcome verification (obj 700028): generalized state-delta floor for ──
      // NON-CODE objectives. Independent of the code floor above: it arms via a
      // per-objective/type `outcome_assertion:*` row (NOT a project's tsc/build/test
      // config), so research/content/data/ops objectives — which the code floor
      // never covers — get a hard, mechanical outcome check at the working→done
      // gate. Flag-guarded (CC_OUTCOME_VERIFICATION_ENABLED / settings), GLOBAL
      // DEFAULT OFF, fail-safe-OPEN, kill-switchable. A clean non-zero exit BLOCKS
      // and bounces the worker exactly like a red code floor.
      if (objective.status === 'working' && isOutcomeVerificationActiveForObjective(db, objective)) {
        const outcomeDecision = evaluateOutcomeGate({
          getConfig: () => getOutcomeAssertion(db, objective),
          resolveFallbackCwd: () => resolveFloorCwd(objective, () => resolveWorkdir(objective)),
          run: (cfg, cwd) => runFloor(cfg, cwd),
          record: (cwd, run) => recordOutcomeRunRow(db, objective, resolvedStatus, cwd, run),
          logMilestone: (title, detail) => logFloorMilestone(db, objective, title, detail),
        })
        if (outcomeDecision.action === 'block') {
          logFloorMilestone(
            db,
            objective,
            'outcome_caught_failure',
            `Outcome verification FAILED on \`${outcomeDecision.run.failedCommand}\` — objective auto-failed (working→${resolvedStatus} blocked).`,
          )
          console.log(`[state-poller][outcome] RED outcome on obj ${objective.id} (${outcomeDecision.run.failedCommand}) — auto-fail, advance bypassed.`)
          const followUp = outcomeDecision.followUp
          db.prepare(
            "UPDATE objectives SET ai_review_verdict = 'fail', ai_review_findings = ?, updated_at = datetime('now') WHERE id = ?",
          ).run(followUp, objective.id)
          if (objective.session_id) {
            try {
              const newSessionId = sendFollowUp(objective.session_id, followUp, objective)
              runMachineStatusUpdate(
                db,
                "UPDATE objectives SET status = 'working', session_id = ?, updated_at = datetime('now') WHERE id = ?",
                newSessionId,
                objective.id,
              )
              console.log(`[state-poller][outcome] obj ${objective.id} bounced to worker session ${newSessionId} with outcome findings`)
            } catch (err) {
              console.error(`[state-poller][outcome] failed to send outcome-fail follow-up for obj ${objective.id}:`, err)
              runMachineStatusUpdate(
                db,
                "UPDATE objectives SET status = 'review', updated_at = datetime('now') WHERE id = ?",
                objective.id,
              )
            }
          } else {
            runMachineStatusUpdate(
              db,
              "UPDATE objectives SET status = 'review', updated_at = datetime('now') WHERE id = ?",
              objective.id,
            )
          }
          const updated = db.prepare('SELECT * FROM objectives WHERE id = ?').get(objective.id) as Objective
          broadcast({ type: 'objective_updated', payload: updated })
          continue // outcome gate applied — never reach the reviewer/advance path
        }
      }

      // Single chokepoint for the worker auto-advance path: a human-tracked
      // objective (top-level, non-routine) must not auto-complete — redirect
      // any resolved `done` to `review` for admin sign-off. Carve-outs:
      // green-lane (CI is the gate), passing AI review on a non-project,
      // delegator children, and routine-spawned jobs.
      if (mustRouteToHumanReview(objective, { lane: mergeLane }) && resolvedStatus === 'done') {
        resolvedStatus = 'review'
      }

      // Human may have clicked Done during floor/oracle/outcome awaits.
      if (skipMachineStatusWrite(db, objective.id)) continue

      let ciGateBlocked = false
      if (resolvedStatus === 'ai_review') {
        try {
          // Increment the iteration counter BEFORE spawning so the reviewer
          // prompt sees the correct iteration number. The objective passed to
          // spawnReviewerSession must reflect the new iteration value too.
          const nextIteration = (objective.ai_review_iteration || 0) + 1
          ;(objective as Objective & { ai_review_iteration: number }).ai_review_iteration = nextIteration
          const reviewerSessionId = await spawnReviewerSession(objective)
          runMachineStatusUpdate(
            db,
            `UPDATE objectives SET
               status = 'ai_review',
               ai_review_session_id = ?,
               ai_review_verdict = NULL,
               ai_review_findings = NULL,
               ai_review_iteration = ?,
               updated_at = datetime('now')
             WHERE id = ?`,
            reviewerSessionId,
            nextIteration,
            objective.id,
          )
          console.log(`[state-poller] Spawned reviewer ${reviewerSessionId} for objective ${objective.id} (${objective.type}) iteration ${nextIteration}`)
        } catch (err) {
          // If reviewer can't spawn (account exhausted etc.), leave in review for human triage.
          console.error(`[state-poller] Failed to spawn reviewer for objective ${objective.id}:`, err)
          runMachineStatusUpdate(
            db,
            "UPDATE objectives SET status = 'review', updated_at = datetime('now') WHERE id = ?",
            objective.id,
          )
        }
      } else {
        // ── CI-green gate on the WORKER-SESSION-END apply path (obj 704785) ────
        // This write takes a VARIABLE status, so it does not grep as a `'done'`
        // literal — which is exactly how it was missed on the first pass of this
        // objective. It reaches `done` three ways, all of which can carry a PR:
        //   1. resolveWorkerEndStatus() returning 'done' directly,
        //   2. the ALWAYS-ON re-review churn guard (:3067) forwarding an
        //      already-passed / iteration-capped objective straight to done,
        //   3. the KL-21 gate-rejection-memory skip (:3117) doing the same.
        // (2) is the dangerous one: an objective that already passed review (so it
        // has a PR) and is later resurrected to `working` would forward to `done`
        // with nothing looking at its checks. Gating the reviewer-verdict path but
        // not this one leaves the gate LOOKING closed while a live path walks past
        // it. On a block we rewrite `resolvedStatus` to where the handback actually
        // landed the objective, so continueDelegationOnCommit below does not tell a
        // delegator parent that a child finished when it did not.
        if (resolvedStatus === 'done') {
          const gate = await runCompletionGate(db, objective, { pathway: 'worker-end-apply', alert: insertAlert })
          if (gate.blocked) {
            const landed = applyGateHandback(db, objective, gate, { sendFollowUp, broadcast })
            console.warn(
              `[state-poller] CI-green gate ${gate.decision.action.toUpperCase()} on worker-end apply for ` +
              `objective ${objective.id} (${gate.repo}#${gate.prNumber}) → ${landed}: ${gate.decision.reason}`,
            )
            resolvedStatus = landed
            ciGateBlocked = true
          }
        }
        if (!ciGateBlocked) {
          runMachineStatusUpdate(
            db,
            "UPDATE objectives SET status = ?, updated_at = datetime('now') WHERE id = ?",
            resolvedStatus,
            objective.id,
          )
        }
      }

      const updated = db
        .prepare('SELECT * FROM objectives WHERE id = ?')
        .get(objective.id) as Objective

      // Green lane skipped the tmux reviewer. If this card opened a PR, post
      // harness/test-agent so branch protection is not starved. Never auto-merge
      // and never auto-done — a human or the Agent API closes the card.
      if (!ciGateBlocked && mergeLane === 'green') {
        if (updated.create_pr || updated.pr_number) {
          postHarnessStatus(updated, 'success', GREEN_LANE_FINDINGS)
        }
        try {
          db.prepare(
            `INSERT INTO activity_log (project, workspace, objective_id, session_id, event_type, title, detail)
             VALUES (?, ?, ?, ?, 'milestone', 'merge_lane_green', ?)`,
          ).run(
            objective.project || 'unknown',
            objective.workspace,
            objective.id,
            objective.session_id,
            GREEN_LANE_FINDINGS,
          )
        } catch (err) {
          console.warn(`[state-poller] Failed to log green-lane skip for obj ${objective.id}:`, (err as Error).message)
        }
      }

      broadcast({ type: 'objective_updated', payload: updated })

      // P3 continuation engine (Strategy Layer, flag-gated). Propagate this
      // worker-end commit UP to a delegator parent so a persistent strategy node
      // is re-invoked after each project finishes. No-op unless CC_STRATEGY_TIER
      // is set; mutually exclusive with the ai_review wake (:1420) because
      // resolvedStatus is never 'ai_review' on a review/done commit → exactly one
      // parent wake per finishing child. See continueDelegationOnCommit.
      continueDelegationOnCommit(objective, updated, resolvedStatus)
    }
  }
}
