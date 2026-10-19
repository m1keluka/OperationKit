/**
 * Shared TypeScript contracts for Command Center.
 *
 * Split: core (objective/status/agent) in types-core.ts, platform surfaces in
 * types-surfaces.ts, runtime (WS/session/assistant) in types-runtime.ts.
 * Type-aware workflow helpers stay in workflow.ts. This file is the package
 * entry (`@operationkit/shared`) and re-exports everything.
 */

export * from './types-core.js'
export * from './types-surfaces.js'
export * from './types-runtime.js'

// Type-aware transitions live in `./workflow.ts` to keep this file focused on
// the data shape. Re-exported here so `@operationkit/shared` callers can get
// them without a subpath import.
export {
  isTransitionAllowed,
  allowedTransitions,
  getInitialStatus,
  DEFAULT_EFFORT_BY_TYPE,
  TYPE_LABELS,
  STRATEGY_BADGE,
  ORIGIN_BADGES,
  IN_FLIGHT_STATUSES,
  isInFlightStatus,
} from './workflow.js'
