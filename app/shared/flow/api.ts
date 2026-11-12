// REST shapes for /api/flows* (card B4, docs/design/WORKFLOWS.md §7.6).
// Response contracts shared by the server routes and the Jobs → Workflows UI.

import type { FlowApprovals, FlowDefinition, FlowNodeRunStatus } from './types.js'

/** The `kind='flow'` routine row that carries a published flow's cron (§7.1). */
export interface FlowRoutineInfo {
  id: number
  cron_expr: string
  cadence: string
  enabled: boolean
  next_run_at: string | null
  last_run_at: string | null
  consecutive_failures: number
  /** Effective K (per-routine override → env → settings → 5). 0 = never. */
  auto_pause_threshold: number
  auto_paused_at: string | null
  auto_pause_reason: string | null
}

export interface FlowRunSummary {
  id: number
  flow_id: number
  flow_slug: string
  flow_name: string
  workspace: string
  version: number
  mode: string
  status: string
  goal_met: number | null
  spent_usd: number
  /** `schedule` (routine cron), `manual` (run-now), … */
  trigger_source: string | null
  objective_id: number | null
  created_at: string
  started_at: string | null
  ended_at: string | null
  error: { type: string; title: string; node_id?: string } | null
  /** Engine-evaluated `goal.end_condition` (B5); null until the run succeeded. */
  goal: FlowGoalResult | null
  /** Set on a run that belongs to a self-test (B5). */
  self_test_id: number | null
}

/** One deterministic `goal.end_condition.assert`, as the ENGINE evaluated it (B5). */
export interface FlowAssertResult {
  expr: string
  why?: string
  passed: boolean
  /** The expression could not be evaluated (e.g. it names a node that never ran). */
  error?: string
}

/**
 * The optional judge (§3.3): a separate, small model call that sees only the
 * rubric and the named output. `skipped` = not evaluated (dry run, asserts
 * already failed, no model backend). `error` = it could not give a verdict.
 */
export interface FlowJudgeResult {
  status: 'passed' | 'failed' | 'skipped' | 'error'
  reason: string
  cost_usd?: number
}

export interface FlowGoalResult {
  /** All asserts passed and the judge (if it ran) did not fail. */
  met: boolean
  asserts: FlowAssertResult[]
  judge: FlowJudgeResult | null
  evaluated_at: string
}

export interface FlowSummary {
  id: number
  slug: string
  name: string
  workspace: string
  status: 'draft' | 'active' | 'paused' | 'archived'
  published_version: number | null
  latest_version: number | null
  /** The flow's home card (§7.2). */
  objective_id: number | null
  created_by: string
  created_at: string
  updated_at: string
  /** Trigger of the published version (else the latest). */
  trigger: { on: string; cron: string | null } | null
  node_count: number
  /** Node count per kind, e.g. `{ tool: 2, llm: 1 }`. */
  kinds: Record<string, number>
  routine: FlowRoutineInfo | null
  last_run: FlowRunSummary | null
}

export interface FlowVersionSummary {
  version: number
  author: string
  sha256: string
  parent_version: number | null
  created_at: string
  published: boolean
}

export interface FlowStepSummary {
  node_id: string
  iteration: number
  attempt: number
  status: string
  effect: string | null
  error: { type?: string; title?: string; detail?: string } | null
  cost_usd: number
  started_at: string
  ended_at: string | null
  /** Redacted at write time, truncated here. */
  output_preview: string | null
  /** B5: how a step that did NOT call out was produced (`mock`, `stub`, `would_send` …); null = real. */
  simulated: string | null
  /** B5: the resolved input (what a `would_send` step would have sent), redacted and truncated. */
  input_preview: string | null
}

export interface FlowListResponse {
  flows_enabled: boolean
  flows: FlowSummary[]
}

export interface FlowRunsResponse {
  flows_enabled: boolean
  runs: FlowRunSummary[]
}

export interface FlowDetailResponse {
  flows_enabled: boolean
  flow: FlowSummary
  /**
   * The version shown (`?version=`, else published, else latest). Null only for a
   * workflow created from a goal (B6) whose builder has not drafted a version yet.
   */
  version: number | null
  definition: FlowDefinition | null
  versions: FlowVersionSummary[]
  /** `definitionToMermaid(definition, { status: node_status })`. */
  mermaid: string
  /** Per-node status from the latest run of the shown version. */
  node_status: Record<string, FlowNodeRunStatus>
  status_run_id: number | null
  runs: FlowRunSummary[]
  /** B5: self-test + approval state of the shown version (null when there is no version yet). */
  publish: FlowPublishState | null
  /** B6: the goal "New workflow" was created from, and the builder's iteration budget. */
  builder?: FlowBuilderState | null
  /**
   * B7: what changed in the shown version vs the version it was drafted from
   * (`parent_version`, else the next lower version). Null for a first version,
   * and absent/null for a workflow with no version yet (B6).
   */
  changes: FlowVersionChanges | null
}

/** Card B6: a workflow built from a goal by its builder card. */
export interface FlowBuilderState {
  goal: string | null
  objective_id: number | null
  /** Agent draft submissions since the last green self-test. */
  used: number
  max: number
  remaining: number
  exhausted: boolean
}

/** Changed-node tags for the version picker (B7, §6.2 "Versions"). */
export interface FlowVersionChanges {
  /** The version compared against. */
  base_version: number
  /** Author of the shown version: `user:<id>`, `agent:<objective id>`, `repair:<run id>`. */
  author: string
  added: string[]
  changed: string[]
  removed: string[]
}

export interface FlowRunDetailResponse {
  run: FlowRunSummary
  steps: FlowStepSummary[]
  node_status: Record<string, FlowNodeRunStatus>
  mermaid: string
  /** B9: what the run is parked on right now (unresolved wait tokens). Empty unless `waiting`. */
  waits: FlowWaitSummary[]
}

// ── Waits (card B9, §4.3 rule 4 + §5.4) ─────────────────────────────────────

/**
 * One unresolved `flow_wait_tokens` row. `reason`:
 *  - `approval`         an approval `wait` node: Approve / Reject (cookie owner/admin)
 *  - `unknown_outcome`  a send/spend step was in flight at a crash: "it was sent" / "it was not sent"
 *  - `agent`            an `agent` node waiting on its child card (`objective_id`)
 *  - `event`            a `wait.event` node waiting for `event_name`
 *  - `duration`/`until` a timed wait; resumes on its own at `expires_at`
 */
export interface FlowWaitSummary {
  node_id: string
  iteration: number
  reason: string
  kind: string
  created_at: string
  /** Resume time of a timed wait; deadline of an event / approval / agent wait with `timeout_ms`. */
  expires_at: string | null
  /** Child card of an `agent` node. */
  objective_id: number | null
  objective_status?: string | null
  event_name: string | null
  /** approval: who may approve (`from`) and the resolved prompt. */
  approval?: { from: string; prompt: string } | null
  /** approval: the step right after the wait and its resolved input — the exact payload that will go out. */
  next?: { node_id: string; kind: string; effect: string | null; input: unknown } | null
}

export type FlowApprovalDecision = 'approve' | 'reject'
export type FlowUnknownOutcomeDecision = 'sent' | 'not_sent'

// ── Self-test + publish gate (card B5, §5.2 / §5.4) ─────────────────────────

/** A step a self-test did not perform: "would send …" etc. */
export interface FlowSimulatedStep {
  node_id: string
  iteration: number
  effect: string | null
  simulated: string
  /** Redacted, truncated resolved input — what would have gone out. */
  input_preview: string | null
}

export interface FlowSelfTestFixtureResult {
  name: string
  run_id: number
  status: string
  goal_met: number | null
  goal: FlowGoalResult | null
  error: { type: string; title: string; node_id?: string } | null
  spent_usd: number
  simulated: FlowSimulatedStep[]
}

export interface FlowSelfTestFailure {
  /** run_failed | goal_not_met | judge_failed | judge_not_evaluated | uncovered_nodes | over_budget | start_failed */
  code: string
  message: string
  fixture?: string
  node_ids?: string[]
}

export interface FlowFailingAssert {
  fixture: string
  run_id: number
  expr: string
  why?: string
  error?: string
}

export interface FlowSelfTestResult {
  passed: boolean
  fixtures: FlowSelfTestFixtureResult[]
  /** Nodes no fixture run completed (§5.2: every reachable node must complete on at least one fixture). */
  uncovered_nodes: string[]
  failing_asserts: FlowFailingAssert[]
  failures: FlowSelfTestFailure[]
}

export interface FlowSelfTest {
  id: number
  flow_id: number
  version: number
  mode: 'dry' | 'test'
  status: 'running' | 'passed' | 'failed'
  requested_by: string
  created_at: string
  ended_at: string | null
  run_ids: number[]
  /** Null while running. */
  result: FlowSelfTestResult | null
}

/** What the owner is asked to approve before publishing a version (GET /api/flows/:id). */
export interface FlowPublishState {
  version: number
  /** send/spend nodes not behind an approval wait — the exact set the owner approves. */
  nodes_requiring_approval: string[]
  /** write/send/spend nodes without a `mock` (publish refuses them). */
  nodes_missing_mocks: string[]
  /** Latest self-test of this version (the publish gate reads exactly this one). */
  self_test: FlowSelfTest | null
  /** The recorded owner approval of this version, if it was published. */
  approvals: FlowApprovals | null
}

// ── Click-to-inspect side panel (card B7, §6.2 "Click a node") ──────────────

/** One attempt of one node, as the side panel shows it. Every text field is redacted at READ time. */
export interface FlowNodeAttempt {
  iteration: number
  attempt: number
  status: string
  effect: string | null
  simulated: string | null
  cost_usd: number
  started_at: string
  ended_at: string | null
  /** Redacted (live-redaction) THEN capped; null = nothing stored. */
  input: string | null
  output: string | null
  error: string | null
  /** True when input/output/error was cut at the cap. */
  truncated: boolean
}

/** GET /api/flows/:id/runs/:runId/nodes/:nodeId and GET /api/flows/:id/nodes/:nodeId?version=N */
export interface FlowNodeInspectResponse {
  /** Null when inspected per version with no run selected (`GET /api/flows/:id/nodes/:nodeId`). */
  run_id: number | null
  version: number
  node_id: string
  kind: string | null
  /** The node's definition (pretty JSON), redacted. Null if the node is not in this run's version. */
  config: string | null
  /** Overlay status of this node in this run. */
  status: FlowNodeRunStatus | null
  /** Attempts in this run, oldest first; at most the last 20 rows. */
  attempts: FlowNodeAttempt[]
  /** Total step rows of this node in this run (a loop body can have hundreds). */
  attempt_count: number
  /** The same node's latest succeeded attempt in the most recent OTHER live run where it succeeded. */
  last_good: { run_id: number; version: number; attempt: FlowNodeAttempt } | null
}

/**
 * WebSocket `flow_step` payload (B7): a step row or the run status changed. The
 * viewer refetches the run on receipt, so the payload carries ids, never step I/O.
 */
export interface FlowLiveEvent {
  workspace: string
  flow_id: number
  run_id: number
  /** `step` (a step row was written), `run_started`, `run_finished`, or `wait` (B9: parked on / released from a wait). */
  event: 'step' | 'run_started' | 'run_finished' | 'wait'
  node_id?: string
  iteration?: number
  attempt?: number
  /** Step status for `step`; run status for `run_finished`; `waiting` or the resolution for `wait`. */
  status?: string
  at: string
}
