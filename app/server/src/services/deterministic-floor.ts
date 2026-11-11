/**
 * Deterministic floor (ST1 / roadmap P1+P2) — poller-run CI under the LLM reviewer.
 *
 * Split: runner/config in deterministic-floor-run.ts, floor gate/persistence in
 * deterministic-floor-gate.ts, outcome + oracle gates in
 * deterministic-floor-outcome.ts. This file is the re-export facade.
 */

export {
  DEFAULT_TIMEOUT_MS,
  execRunner,
  getFloorConfig,
  hasProjectFloorOptIn,
  isFloorActiveForProject,
  isFloorEnabled,
  isFloorKilled,
  resolveFloorCwd,
  runFloor,
  buildFloorFailFollowUp,
  type CommandRunner,
  type FloorCommandResult,
  type FloorConfig,
  type FloorOutcome,
  type FloorRunResult,
} from './deterministic-floor-run.js'

export {
  evaluateFloorGate,
  logFloorMilestoneRow,
  recordFloorRunRow,
  type FloorGateDecision,
  type FloorGateDeps,
  type FloorObjectiveRef,
} from './deterministic-floor-gate.js'

export {
  COMMAND_CENTER_PROJECT,
  ORACLE_COMMAND,
  buildOracleFailFollowUp,
  buildOutcomeFailFollowUp,
  evaluateOracleGate,
  evaluateOutcomeGate,
  getOutcomeAssertion,
  hasOutcomeOptIn,
  isCommandCenterTarget,
  isOracleGateActiveForObjective,
  isOracleGateEnabled,
  isOutcomeVerificationActiveForObjective,
  isOutcomeVerificationEnabled,
  isOutcomeVerificationKilled,
  recordOutcomeRunRow,
  type OracleGateDecision,
  type OracleGateDeps,
  type OracleObjectiveRef,
  type OutcomeAssertionConfig,
  type OutcomeGateDecision,
  type OutcomeGateDeps,
  type OutcomeObjectiveRef,
} from './deterministic-floor-outcome.js'
