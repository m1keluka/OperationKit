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

export function startPoller(): void {
  if (pollTimer) return

  // Startup sweep: any objectives stuck in 'working' with no active process are stale
  // (e.g., from a container restart that killed all sessions)
  sweepStaleWorkingSessions()

  pollTimer = setInterval(() => {
    void pollActiveSessions()
  }, POLL_INTERVAL_MS)

  console.log(`State poller started (every ${POLL_INTERVAL_MS}ms)`)
}

/** On startup, move any 'working' objectives with dead sessions to 'review' */
function sweepStaleWorkingSessions(): void {
  const db = getDb()
  const stale = db
    .prepare("SELECT * FROM objectives WHERE status = 'working' AND session_id IS NOT NULL")
    .all() as Objective[]

  for (const obj of stale) {
    const state = getSessionState(obj.session_id!)
    if (state === 'dead') {
      if (parkDelegatorIfWaiting(obj)) continue
      console.log(`[state-poller] Startup sweep: objective ${obj.id} ("${obj.title}") was stuck in 'working' — moving to 'review'`)
      runMachineStatusUpdate(
        db,
        "UPDATE objectives SET status = 'review', updated_at = datetime('now') WHERE id = ?",
        obj.id,
      )
      const updated = db.prepare('SELECT * FROM objectives WHERE id = ?').get(obj.id) as Objective
      broadcast({ type: 'objective_updated', payload: updated })
    }
  }

  if (stale.length > 0) {
    const swept = stale.filter(o => getSessionState(o.session_id!) === 'dead').length
    if (swept > 0) console.log(`[state-poller] Startup sweep: moved ${swept} stale objectives to review`)
  }
}

export function stopPoller(): void {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
    console.log('State poller stopped')
  }
}
