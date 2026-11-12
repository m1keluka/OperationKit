// okflow/1 — workflow definitions (docs/design/WORKFLOWS.md §3, §6.1).
// Pure, dependency-free; shared by server (API/MCP/engine) and client (viewer).
export * from './types.js'
export { validateFlow } from './validate.js'
export { definitionToMermaid, mermaidNodeId, type MermaidOptions } from './mermaid.js'
export { parseExpression, parseExpressionField, parseTemplate, type ExprRef, type ParsedExpr } from './expr.js'
export { analyzeFlow, type FlowAnalysis, type FlowEdge } from './analyze.js'
export {
  nodeStatusFromSteps, flowRunLane, isActiveFlowRun, ACTIVE_FLOW_RUN_STATUSES,
  type FlowRunLane, type FlowRunStatusName, type FlowStepStatusName, type StepStatusRow,
} from './run-status.js'
export {
  FLOW_SELF_TEST_MODES, nodesRequiringApproval, nodesMissingMocks, hasMock, effectiveFixtures, stubFromSchema,
  type FlowSelfTestMode,
} from './self-test.js'
export { diffFlowNodes, type FlowNodeChange, type FlowNodeDiff } from './diff.js'
export type * from './api.js'
export { applyJsonPatch, isJsonPatch, parseJsonPointer, JSON_PATCH_MAX_OPS, type JsonPatchOp, type JsonPatchResult } from './json-patch.js'
export {
  classifyRepairPatch, flowFailureSignature, isDefinitionRot, REPAIR_BLOCKER_CODES,
  type RepairBlocker, type RepairBlockerCode, type RepairClassification, type RepairSafeChange, type ClassifyRepairOptions,
  type FlowFailureLike,
} from './repair.js'
