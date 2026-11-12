// okflow/1 — workflow definition types (docs/design/WORKFLOWS.md §3).
//
// The code namespace is `flow` (not `workflow`): `app/shared/workflow.ts` is the
// objective status-transition engine. A definition is plain JSON; these types
// describe a document that has PASSED `validateFlow()`. Anything read from disk,
// the API or a model must go through the validator first.

export const OKFLOW_API_VERSION = 'okflow/1' as const
/** Every apiVersion the validator accepts (a future okflow/2 adds a migration). */
export const SUPPORTED_API_VERSIONS: readonly string[] = [OKFLOW_API_VERSION]

export const FLOW_NODE_KINDS = [
  'trigger', 'tool', 'mcp', 'llm', 'agent', 'branch', 'loop', 'wait', 'check', 'end',
] as const
export type FlowNodeKind = (typeof FLOW_NODE_KINDS)[number]

/** Side-effect class. `send`/`spend` nodes need an owner approval (§5.4). */
export const FLOW_EFFECTS = ['read', 'write', 'send', 'spend'] as const
export type FlowEffect = (typeof FLOW_EFFECTS)[number]

export const TRIGGER_SOURCES = ['schedule', 'webhook', 'manual', 'board', 'event'] as const
export type TriggerSource = (typeof TRIGGER_SOURCES)[number]

/** Pure functions allowed inside `{{ }}` / assert expressions, with their arity. */
export const FLOW_FUNCTIONS: Readonly<Record<string, { min: number; max: number }>> = {
  len: { min: 1, max: 1 },
  now: { min: 0, max: 0 },
  date_add: { min: 3, max: 3 },
  lower: { min: 1, max: 1 },
  join: { min: 1, max: 2 },
  default: { min: 2, max: 2 },
}

export const NODE_ID_RE = /^[a-z][a-z0-9_]{0,40}$/
export const FLOW_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/
export const LLM_MAX_ITERATIONS_CAP = 8
export const LOOP_MAX_CONCURRENCY = 4
/** Most self-test fixtures one definition (or one test request) may carry. */
export const MAX_FLOW_FIXTURES = 10

export interface FlowRetry {
  max: number
  backoff: 'fixed' | 'exponential'
  delay_ms: number
}

/** Fields every node may carry (§3.2). */
export interface FlowNodeBase {
  id: string
  kind: FlowNodeKind
  label?: string
  /** Next node in the same sequence. Not allowed on a node listed in a block (`then` / `body` / `default`). */
  next?: string
  retry?: FlowRetry
  timeout_ms?: number
  idempotency?: 'auto' | 'none'
  effect?: FlowEffect
  /** Fixture used by dry-run (B5). Never scanned for references. */
  mock?: { output?: unknown; error?: unknown }
}

export interface TriggerNode extends FlowNodeBase {
  kind: 'trigger'
  on: TriggerSource
  schedule?: { cron: string; timezone?: string }
  /** Event name, for `on: event`. */
  event?: string
}

export interface ToolNode extends FlowNodeBase {
  kind: 'tool'
  /** OperationKit Tool registry slug. */
  tool: string
  input?: Record<string, unknown>
}

export interface McpNode extends FlowNodeBase {
  kind: 'mcp'
  connector: string
  tool: string
  arguments?: Record<string, unknown>
}

export interface LlmNode extends FlowNodeBase {
  kind: 'llm'
  prompt: string
  output_schema: Record<string, unknown>
  model?: string
  /** Default 1, cap 8. */
  max_iterations?: number
  /** Read-only Tool slugs the model may call in its short tool loop. */
  tools?: string[]
  budget_usd?: number
}

export interface AgentNode extends FlowNodeBase {
  kind: 'agent'
  brief: string
  agent?: string
  budget_usd?: number
}

/**
 * Blocks (`then`, `default`, `body`) are ORDERED lists of node ids run in
 * sequence. Their members carry no `next`; when a block finishes, control
 * rejoins at the owner's continuation (its `next`, or the next member of the
 * block that contains the owner).
 */
export interface BranchCase {
  /** Expression, bare (`a == 1`) or wrapped (`{{ a == 1 }}`). */
  when: string
  then: string[]
}

export interface BranchNode extends FlowNodeBase {
  kind: 'branch'
  cases: BranchCase[]
  /** A single id is shorthand for a one-member block. */
  default?: string | string[]
}

export interface LoopNode extends FlowNodeBase {
  kind: 'loop'
  /** Expression yielding a list. */
  over: string
  /** Loop variable; the body reads `{{ item.<as>.field }}`. */
  as: string
  body: string[]
  max_items: number
  /** 1..4, default 1 (sequential). */
  concurrency?: number
}

export interface WaitNode extends FlowNodeBase {
  kind: 'wait'
  /** Exactly one of for / until / event / approval. `for` is a duration: `30s`, `15m`, `2h`, `1d` or ISO-8601 `PT15M`. */
  for?: string
  until?: string
  event?: string
  approval?: { from: string; prompt: string }
}

export interface FlowAssert {
  expr: string
  why?: string
}

export interface CheckNode extends FlowNodeBase {
  kind: 'check'
  assert: FlowAssert[]
  on_fail?: 'fail' | 'repair' | 'continue'
}

export interface EndNode extends FlowNodeBase {
  kind: 'end'
  output?: unknown
}

export type FlowNode =
  | TriggerNode | ToolNode | McpNode | LlmNode | AgentNode
  | BranchNode | LoopNode | WaitNode | CheckNode | EndNode

export interface FlowGoal {
  statement: string
  end_condition: {
    /** At least one deterministic assert is required; a judge alone fails validation. */
    assert: FlowAssert[]
    judge?: { rubric: string; on: string; budget_usd?: number }
  }
}

export interface FlowBudget {
  run_usd?: number
  repair_usd?: number
  repairs_per_day?: number
}

/**
 * Owner's per-version approval of send/spend nodes (§5.4).
 *
 * Card B5: the AUTHORITATIVE record is `flow_versions.approvals_json`, written
 * only by the publish gate for a cookie-authenticated owner/admin. An `approvals`
 * block inside a submitted definition is just text anyone (an agent, a builder)
 * could have typed, so the engine and the publish gate never count it.
 */
export interface FlowApprovals {
  version: number
  nodes: string[]
  /** `user:<id>` only — agents and repair runs can never approve. */
  by: string
  at: string
  /** SHA-256 of the canonical definition the owner approved (B5). */
  sha256?: string
  /** The green self-test the publish was gated on (B5). */
  self_test_id?: number
}

/** One self-test trigger payload (§5.2): an empty list, a normal day, a 200-item day… */
export interface FlowFixture {
  name: string
  payload?: Record<string, unknown>
}

export interface FlowDefinition {
  apiVersion: typeof OKFLOW_API_VERSION
  id: string
  name: string
  description?: string
  workspace?: string
  version: number
  goal: FlowGoal
  budget?: FlowBudget
  approvals?: FlowApprovals
  /** Self-test trigger payloads (B5). Absent ⇒ one fixture with an empty payload. */
  fixtures?: FlowFixture[]
  nodes: FlowNode[]
}

// ── Validation result ──────────────────────────────────────────────────────

export const FLOW_ERROR_CODES = [
  // document shape
  'INVALID_DOCUMENT', 'UNSUPPORTED_API_VERSION', 'MISSING_FIELD', 'INVALID_FIELD', 'UNKNOWN_FIELD',
  // nodes
  'INVALID_NODE_ID', 'UNKNOWN_NODE_KIND', 'DUPLICATE_NODE_ID',
  'LOOP_MAX_ITEMS_MISSING', 'LOOP_CONCURRENCY_EXCEEDED', 'LLM_MAX_ITERATIONS_EXCEEDED',
  'WAIT_MODE_INVALID', 'EFFECT_NOT_APPLICABLE',
  // graph
  'NO_TRIGGER', 'MULTIPLE_TRIGGERS', 'TRIGGER_NOT_FIRST', 'TRIGGER_HAS_INCOMING',
  'DANGLING_EDGE', 'CYCLE', 'UNREACHABLE_NODE', 'MULTIPLE_INCOMING',
  'BLOCK_NODE_HAS_NEXT', 'END_HAS_NEXT', 'NO_END_NODE',
  // expressions / references
  'EXPR_SYNTAX', 'EXPR_UNKNOWN_FUNCTION', 'EXPR_ARITY', 'SECRET_REFERENCE',
  'DANGLING_REFERENCE', 'REFERENCE_NOT_UPSTREAM', 'REFERENCE_INVALID_PATH', 'UNKNOWN_REFERENCE_ROOT',
  'ITEM_OUTSIDE_LOOP', 'UNKNOWN_LOOP_VARIABLE',
  // goal
  'GOAL_MISSING', 'GOAL_NO_DETERMINISTIC_ASSERT',
  // approvals
  'UNAPPROVED_EFFECT', 'APPROVAL_VERSION_MISMATCH', 'APPROVAL_UNKNOWN_NODE', 'APPROVAL_INVALID_APPROVER',
  // registry (only with an injected resolver)
  'UNKNOWN_TOOL', 'UNKNOWN_CONNECTOR', 'CONNECTOR_DISABLED', 'UNKNOWN_CONNECTOR_TOOL',
  'EFFECT_UNDERSTATED', 'LLM_TOOL_NOT_READ_ONLY',
] as const
export type FlowErrorCode = (typeof FLOW_ERROR_CODES)[number]

export interface FlowIssue {
  code: FlowErrorCode
  severity: 'error' | 'warning'
  message: string
  /** JSON-ish path into the document, e.g. `nodes[3].max_items` or `goal.end_condition.assert`. */
  path: string
  node_id?: string
}

export interface FlowValidationResult {
  ok: boolean
  errors: FlowIssue[]
  warnings: FlowIssue[]
}

/**
 * Registry lookups are injected so the validator stays pure and dependency-free.
 * The server passes a resolver backed by the okit Tools registry and the
 * workspace's connectors; without one, registry checks are skipped and a node
 * with no declared `effect` is treated as `send` (§3.2: unknown ⇒ send).
 */
export interface FlowRegistry {
  /** `null` = no such Tool. `effect` = from Tool metadata. */
  getTool(slug: string): { effect?: FlowEffect } | null
  /** `null` = no such connector in this workspace. */
  getConnector(id: string): {
    enabled: boolean
    /** `null` = the connector does not expose this tool; `undefined` = unknown (skip). */
    getTool?(name: string): { effect?: FlowEffect; readOnlyHint?: boolean } | null
  } | null
}

export interface ValidateFlowOptions {
  registry?: FlowRegistry
  /**
   * Default true (publish semantics). `false` downgrades UNAPPROVED_EFFECT to a
   * warning so a builder can validate a draft before the owner approves it.
   */
  requireApprovals?: boolean
}

export type FlowNodeRunStatus = 'succeeded' | 'failed' | 'running' | 'waiting' | 'skipped' | 'mocked'
