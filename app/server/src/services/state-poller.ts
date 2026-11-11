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
import { hasArenaCohort } from './arena-lifecycle.js'
import { broadcast } from '../ws/index.js'
import { mustRouteToHumanReview } from '../lib/human-tracked.js'
import { runMachineStatusUpdate } from '../lib/status-lock.js'
import type {
  Objective,
  ObjectiveStatus,
} from '@operationkit/shared'
import { MAX_CONCURRENT_SESSIONS } from '@operationkit/shared'
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

// Re-export moved functions so existing consumers don't break
export {
  type NoOpDecision,
  type DeadReparkAction,
  type DelegatorBackstopAction,
  type WatchdogReason,
  decideDeadSessionRepark,
  classifyNoOpSpawn,
  resolveWorkerEndStatus,
  delegatorBackstopDecision,
  extractFeatureBriefTag,
  extractScreenshotsTag,
  extractJsonArrayTag,
  parseCriteriaResults,
  extractScreenshotPaths,
  parseAcceptanceCriteria,
  AI_REVIEW_ITERATION_CAP,
  AI_REVIEW_BUDGET_CEILING_USD,
  budgetCeilingForEffort,
  decideRespawnAction,
  classifyFailType,
  type FailType,
  failingCriterionIds,
  watchdogDecision,
} from './poller-decisions.js'
export {
  escalateCapOut,
  forceRouteStuckWorker,
  ghExecEnv,
  withRetry,
} from './poller-ai-review.js'
export { delegatorParentOf, continueDelegationOnCommit } from './poller-delegator.js'
export {
  type HygieneDigest,
  selectOrphanedQueueChildren,
  selectAutoAcceptCandidates,
  selectTopLevelQueueStarterCandidates,
  buildHygieneDigest,
} from './poller-hygiene.js'
import {
  pollActiveSessions,
  parkDelegatorIfWaiting,
  handleDeadSessionOutcome,
} from './poller-loop.js'

// Poll cadence. Overridable via CC_POLL_INTERVAL_MS so ops can relieve
// event-loop pressure without a code change (2026-08-17 incident: each tick does
// synchronous per-objective sqlite + spawnSync + transcript work, so on a busy
// board a 3s cadence can starve HTTP accept). Floored at 1s to prevent a typo
// from hot-looping the poller.
const POLL_INTERVAL_MS = Math.max(1000, Number(process.env.CC_POLL_INTERVAL_MS) || 3000)
// Absolute ceiling on AI-review iterations per objective (objective 360). The
// per-iteration `ITERATION_CAP=3` only bounds worker↔reviewer *fail* bounces; it
// does NOT stop an already-passed objective from being re-reviewed every time it
// is resurrected to `working` (via chat/upload/reopen). A `pass` is terminal and
// an objective can never accumulate more than this many review iterations.
let pollTimer: ReturnType<typeof setInterval> | null = null
let pollInFlight = false

export function startPoller(): void {
  if (pollTimer) return

  // Startup sweep: any objectives stuck in 'working' with no active process are stale
  // (e.g., from a container restart that killed all sessions). Async (obj 900510 —
  // the sweep now reads the dead session's transcript before re-parking it), so this
  // fires in the background rather than blocking server boot on a slow sweep.
  void sweepStaleWorkingSessions()

  pollTimer = setInterval(() => {
    // A tick that overruns the cadence used to stack overlapping polls, each
    // doing sync sqlite + tmux execSync, which starved HTTP accept (creates
    // sitting on Saving… for tens of seconds). Skip if the previous tick is
    // still running.
    if (pollInFlight) return
    pollInFlight = true
    void pollActiveSessions().finally(() => { pollInFlight = false })
  }, POLL_INTERVAL_MS)

  console.log(`State poller started (every ${POLL_INTERVAL_MS}ms)`)
}

/**
 * On startup, move any 'working' objectives with dead sessions to 'review'.
 *
 * obj 900510: this used to be a bare `UPDATE ... SET status = 'review'` with NO
 * call to `handleSessionDeath` (which releases the account slot, extracts the
 * real token/cost usage, and queues the LLM session-summary extraction) and no
 * call to the no-op/startup-failure classifier the LIVE poll loop
 * (`pollActiveSessions` → `handleDeadSessionOutcome`) already uses for the exact
 * same "session died while nobody was watching" case.
 *
 * A session that finishes (or is killed) during the few seconds a backend
 * restart pauses the poller (self-deploy — `POST /api/internal/deploy
 * {"mode":"both"}` — is this project's own normal workflow, so a
 * `create_pr: true` card on THIS project routinely triggers one) is caught by
 * THIS sweep on the next boot, not by the live loop. Skipping the real
 * accounting here meant such a card landed in `review` with total_tokens=0,
 * cost=$0, no last_session_summary and no PR — forever, since once the row is
 * no longer 'working' nothing ever re-extracts it. Reusing the same
 * `handleSessionDeath` + `handleDeadSessionOutcome` pipeline the live loop uses
 * fixes both: real usage is recorded when the session actually did work, and a
 * session that produced nothing gets a visible `blocked` verdict + reason
 * instead of a silent, unexplained `review`.
 */
async function sweepStaleWorkingSessions(): Promise<void> {
  const db = getDb()
  const stale = db
    .prepare("SELECT * FROM objectives WHERE status = 'working' AND session_id IS NOT NULL")
    .all() as Objective[]

  let swept = 0
  for (const obj of stale) {
    const state = getSessionState(obj.session_id!)
    if (state !== 'dead') continue
    if (parkDelegatorIfWaiting(obj)) continue

    // Release the account slot and record whatever real usage the dead session
    // actually produced (tokens, cost, intel extraction, session summary) BEFORE
    // any status mutation — exactly what the live poll loop does on every other
    // dead-session path. Without this call the session's true usage is lost the
    // instant its row leaves 'working'.
    try { handleSessionDeath(obj.session_id!) } catch (err) {
      console.error(`[state-poller] Startup sweep: handleSessionDeath failed for obj ${obj.id} (${obj.session_id}):`, err)
    }

    // Give the same truthful-outcome classifier the live loop uses a chance to
    // recognise a no-output / startup-failure death and park it with a visible
    // blocked verdict + reason, instead of a bare, unexplained 'review'. Returns
    // true (and has already updated the row + broadcast) when it did so.
    let handled = false
    try {
      handled = await handleDeadSessionOutcome(obj)
    } catch (err) {
      console.error(`[state-poller] Startup sweep: handleDeadSessionOutcome failed for obj ${obj.id} (${obj.session_id}):`, err)
    }
    if (handled) {
      swept++
      continue
    }

    // Genuine deliverable (or an unparseable transcript — fail open rather than
    // invent a block): fall back to the original plain re-park, now carrying the
    // usage just recorded above instead of none at all.
    console.log(`[state-poller] Startup sweep: objective ${obj.id} ("${obj.title}") was stuck in 'working' — moving to 'review'`)
    runMachineStatusUpdate(
      db,
      "UPDATE objectives SET status = 'review', updated_at = datetime('now') WHERE id = ?",
      obj.id,
    )
    const updated = db.prepare('SELECT * FROM objectives WHERE id = ?').get(obj.id) as Objective
    broadcast({ type: 'objective_updated', payload: updated })
    swept++
  }

  if (swept > 0) console.log(`[state-poller] Startup sweep: moved ${swept} stale objectives to review`)
}

export function stopPoller(): void {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
    console.log('State poller stopped')
  }
}
