/**
 * Workflow engine core (obj 900638, card B2 of docs/design/WORKFLOWS.md §4).
 *
 * A small durable interpreter for validated `okflow/1` definitions, persisted in
 * the existing SQLite DB (tables in db/schema/flow.ts). Card B2 added the
 * `trigger`, `tool`, `branch`, `check` and `end` node kinds; card B3 (obj 900639)
 * adds `llm` (services/flow-llm.ts: llm-gateway backend, `output_schema`,
 * `max_iterations`), `mcp` (services/flow-mcp.ts: connector credentials of the
 * run's workspace only) and run budgets (services/flow-budget.ts: `budget.run_usd`
 * + job-accounting ceilings, checked before every spending node).
 * Card B5 (obj 900641) adds the run MODES of §5.2 (`dry`, `test`: see
 * FLOW_RUN_MODES in db/schema/flow.ts — a step that must not call out writes a
 * `simulated` row instead: its `mock`, a schema stub, or "would send …"), the
 * engine-side evaluation of `goal.end_condition` (asserts + optional judge) on
 * every run that reaches its end, and a SEQUENTIAL `loop` (one body iteration
 * at a time; step rows carry the iteration index).
 * Card B8 (obj 900644) adds run mode `replay` for the auto-debug watcher
 * (services/flow-repair.ts): `startRun({mode: 'replay', parentRunId})` copies the
 * failed run's succeeded rows up to the first failed / changed node (seedReplay),
 * then the run behaves like `test`. A process error's `code` / exit code is kept
 * on the step error so 127 / ENOENT reads as definition rot.
 * Card B9 (obj 900645) adds the PARKING nodes and loop concurrency:
 *  - `agent` files a child card (services/flow-agent.ts, origin `workflow`) and
 *    parks the run on a `flow_wait_tokens` row (reason `agent`); the card
 *    reaching its disposition resumes the run with the card's result.
 *  - `wait` parks the run on a token: `for` / `until` (resolved by the tick once
 *    due), `event` (deliverEvent) or `approval` (resolveApproval — the caller
 *    checks it is a cookie owner/admin). A parked run holds NO lease and no
 *    promise: it is a `waiting` row, so it survives any number of restarts.
 *  - `loop.concurrency` (≤ 4) runs up to N iterations at once. A slot is held by
 *    an iteration until it COMPLETES — an iteration parked on an agent card or an
 *    approval keeps its slot — so at most N body steps are ever in flight.
 * A nested loop still fails the run with `unsupported_node_kind`; it never
 * silently skips.
 *
 * Durability model (borrowed from Inngest `step.run` / Temporal; no code copied):
 *
 *  - MEMOISED STEPS. Every node execution writes a `flow_step_runs` row. Executing
 *    a run always re-walks the definition from the trigger. A node whose latest
 *    row is `succeeded` is NOT executed again: its stored output is replayed into
 *    scope. A branch's chosen block is memoised the same way, so a replay is
 *    deterministic. Resuming after a crash therefore "starts at the first node
 *    without a succeeded row" with no separate cursor to drift.
 *
 *  - LEASE, NOT LOCK. A run is claimed with a conditional UPDATE on
 *    `flow_runs.lease_owner / lease_expires_at` (the same compare-and-set pattern
 *    as the `obj:<id>` identity lease in session-lease.ts, so it holds across
 *    processes). The holder heartbeats it. EVERY write made while executing is
 *    FENCED on still holding the lease: a stale executor that wakes up after
 *    another engine took over writes nothing.
 *
 *  - RESUME ON BOOT. A restart drops the old process and its heartbeat. Once the
 *    lease expires, the next tick re-claims the `running` run and re-walks it.
 *
 *  - IN-FLIGHT AT CRASH. A step row still `running` when its run is re-claimed was
 *    in flight when the old engine died. A `read`/`write` step is marked
 *    `interrupted` and run again. A `send`/`spend` step is run again ONLY if its
 *    Tool declares idempotency support (and the node did not opt out with
 *    `idempotency: none`); otherwise the row becomes `unknown`, an
 *    "unknown outcome, confirm" approval token is written and the run goes to
 *    `waiting`. That rule is what stops a restart from double-sending (§4.3.2).
 *
 *  - IDEMPOTENCY KEYS. A side-effecting step gets
 *    `sha256(run_id:node_id:iteration)` — stable across attempts and restarts — in
 *    its tool context, so an idempotent Tool can dedupe a retried call.
 *
 *  - RETRIES + TIMEOUTS per node (`retry: {max, backoff, delay_ms}`, `timeout_ms`),
 *    default 3 attempts, exponential from 2 s, 60 s timeout. `retry.max` is the
 *    TOTAL attempt count (the §6.2 viewer renders `max: 3` as "3 attempts max").
 *    Backoff is durable: a failed attempt sets `flow_runs.next_attempt_at`, the
 *    lease is released and a later tick picks the run up again, so a backoff
 *    survives a restart and never pins the event loop.
 *
 *  - DAEMON DISCIPLINE. `startFlowEngine()` arms the tick only on the real host:
 *    never under `CC_SCRATCH_SERVER=1` / any scratch verdict
 *    (services/scratch-instance.ts). Each tick writes a heartbeat and does nothing
 *    else while `settings.flows_enabled != '1'` (default '0' until card B4).
 *
 * The engine core is DB-injected and has no import of db/index.ts, the WebSocket
 * server or the secrets registry, so it is unit-testable on an in-memory DB; the
 * host wiring (getDb, redaction, activity_log) is attached in startFlowEngine().
 */
import crypto from 'crypto'
import os from 'os'
import type Database from 'better-sqlite3'
import { validateFlow } from '../../../shared/flow/validate.js'
import type {
  FlowApprovals, FlowDefinition, FlowEffect, FlowNode, ToolNode, BranchNode, CheckNode, EndNode, FlowRegistry, LlmNode,
  LoopNode, McpNode, AgentNode, WaitNode,
} from '../../../shared/flow/types.js'
import { LOOP_MAX_CONCURRENCY } from '../../../shared/flow/types.js'
import type { FlowGoalResult, FlowJudgeResult, FlowWaitSummary } from '../../../shared/flow/api.js'
import type { ServerMessage } from '@operationkit/shared'
import { hasMock, stubFromSchema } from '../../../shared/flow/self-test.js'
import { diffFlowNodes } from '../../../shared/flow/diff.js'
import { isProvenReadStep } from '../../../shared/flow/repair.js'
import {
  initFlowSchema, type FlowRunMode, type FlowRunStatus, type FlowStepSimulation, type FlowStepStatus,
} from '../db/schema/flow.js'
import { initJobAccountingSchema } from '../db/schema/job-accounting.js'
import type { LlmBackend } from './llm-gateway/claude-cli-backend.js'
import { LLM_DEFAULTS, runLlmAttempt } from './flow-llm.js'
import { createWorkspaceMcpResolver, mcpResultToOutput, McpToolCallError, type FlowMcpResolver } from './flow-mcp.js'
import { addRunSpend, checkFlowBudget, isSpendingNode } from './flow-budget.js'
import {
  evaluateCondition, evaluateExpressionField, resolveTemplates, FlowExprError, type FlowEvalScope,
} from '../lib/flow-eval.js'
import { finalizeSelfTest } from './flow-self-test.js'
import { agentCardOutcome, hostFlowAgentHost, type FlowAgentHost } from './flow-agent.js'
import { detectScratchInstance, type ScratchVerdict } from './scratch-instance.js'

// ── Public types ────────────────────────────────────────────────────────────

/** Problem-Details-shaped step/run error (§4.3 `error_json`). */
export interface FlowProblem {
  type: string
  title: string
  detail?: string
  node_id?: string
  retryable?: boolean
  /** HTTP-equivalent status, e.g. 403 for a connector outside the run's workspace. */
  status?: number
  /** Problem-Details extension members (e.g. a budget stop's `limit`, `cap_usd`, `spent_usd`). */
  [ext: string]: unknown
}

/** Thrown by a Tool to control retry behaviour. Any other throw is retryable. */
export class FlowStepError extends Error {
  constructor(readonly type: string, message: string, readonly retryable = true) {
    super(message)
  }
}

export interface FlowToolContext {
  runId: number
  nodeId: string
  workspace: string
  attempt: number
  /** Stable across attempts and restarts; null for read-only steps or `idempotency: none`. */
  idempotencyKey: string | null
  /** Aborted when the step times out or the engine is killed. */
  signal: AbortSignal
}

export interface FlowTool {
  /** Effect class from Tool metadata; a node's own `effect` wins. Unknown ⇒ `send`. */
  effect?: FlowEffect
  /** The Tool dedupes calls by `ctx.idempotencyKey`, so re-running an in-flight call is safe. */
  idempotent?: boolean
  run(input: unknown, ctx: FlowToolContext): Promise<unknown>
}

/** Resolves a `tool` node's registry slug to something the engine can execute. */
export interface FlowToolRegistry {
  get(slug: string): FlowTool | null
}

export type FlowEngineEvent =
  | { type: 'run_started'; runId: number; flowId: number; workspace: string }
  | { type: 'run_finished'; runId: number; flowId: number; workspace: string; status: FlowRunStatus; error?: FlowProblem }
  | {
      type: 'step'; runId: number; flowId: number; workspace: string; nodeId: string
      /** Loop iteration the row is keyed by (0 outside a loop). */
      iteration: number; attempt: number; status: FlowStepStatus
    }
  /** A run parked on / was released from a wait token (B9). */
  | { type: 'wait'; runId: number; flowId: number; workspace: string; nodeId: string; reason: string; resolution?: string; by?: string }
  /** A spending node ran with no finite budget because policy `observe` allowed it (flow-budget.ts). */
  | { type: 'budget_observed'; runId: number; flowId: number; workspace: string; nodeId: string; detail: string }

export interface FlowEngineOptions {
  db: Database.Database
  tools: FlowToolRegistry
  /** Model backend for `llm` nodes (the llm-gateway contract). Absent ⇒ llm nodes fail `llm_unavailable`. */
  llm?: LlmBackend
  /** Connector resolver for `mcp` nodes. Absent ⇒ mcp nodes fail `mcp_unavailable`. */
  mcp?: FlowMcpResolver
  /** Files + starts an `agent` node's child card (B9). Absent ⇒ agent nodes fail `agent_unavailable`. */
  agents?: FlowAgentHost
  /** Epoch-ms clock. Injected so leases, backoff and `now()` are testable. */
  clock?: () => number
  /** Lease owner id; defaults to host:pid:random (unique per engine instance). */
  owner?: string
  leaseTtlMs?: number
  heartbeatMs?: number
  /** Redacts serialised step I/O before it is stored. Host wiring passes redactForStorage. */
  redact?: (text: string) => string
  onEvent?: (event: FlowEngineEvent) => void
}

export const FLOW_DEFAULTS = {
  attempts: 3,
  backoff: 'exponential' as const,
  delayMs: 2000,
  maxBackoffMs: 3_600_000,
  timeoutMs: 60_000,
  leaseTtlMs: 30_000,
  heartbeatMs: 10_000,
  maxConcurrentRuns: 4,
  perFlowConcurrentRuns: 1,
  /** A memoised output must replay faithfully, so an oversized one fails the step rather than being truncated. */
  maxStepJsonBytes: 1_000_000,
  /** An agent node's child card still in `queue` with no session this long after its last start attempt is started again (B9). */
  strandedAgentKickMs: 10 * 60_000,
  strandedAgentMaxKicks: 3,
}

const DURATION_UNIT_MS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }

/** `30s`, `15m`, `2h`, `1d`, `500ms` or ISO-8601 `P1DT2H`, `PT15M` → ms; null if unparseable. */
export function parseFlowDurationMs(raw: string): number | null {
  const s = raw.trim()
  const simple = /^(\d+)\s*(ms|s|m|h|d)$/.exec(s)
  if (simple) return Number(simple[1]) * DURATION_UNIT_MS[simple[2]]
  const iso = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(s)
  if (!iso || s === 'P' || s.endsWith('T')) return null
  const [, d, h, m, sec] = iso
  return (Number(d ?? 0) * 86_400 + Number(h ?? 0) * 3600 + Number(m ?? 0) * 60 + Number(sec ?? 0)) * 1000
}

export const FLOW_HEARTBEAT_KEY = 'flow_engine_last_tick_at'

// ── Definition storage helpers (B4 adds the REST surface on top) ────────────

function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`).join(',')}}`
  }
  return JSON.stringify(v ?? null)
}

export type SaveFlowVersionResult =
  | { ok: true; flowId: number; version: number; created: boolean }
  | { ok: false; reason: string; errors?: unknown[] }

/**
 * Store a validated definition as an immutable version. Creates the
 * `flow_definitions` row (workspace NOT NULL) on first save. Re-saving the same
 * version with identical content is a no-op; different content is refused.
 */
export function saveFlowVersion(
  db: Database.Database,
  args: { workspace: string; definition: FlowDefinition; author: string; registry?: FlowRegistry },
): SaveFlowVersionResult {
  initFlowSchema(db)
  const { workspace, definition, author } = args
  if (!workspace) return { ok: false, reason: 'workspace_required' }
  if (definition.workspace && definition.workspace !== workspace) return { ok: false, reason: 'workspace_mismatch' }
  // A stored version is a DRAFT until the owner publishes it (B5): an unapproved
  // send/spend node is a warning here, and the publish gate decides.
  const validation = validateFlow(definition, { requireApprovals: false, ...(args.registry ? { registry: args.registry } : {}) })
  if (!validation.ok) return { ok: false, reason: 'invalid_definition', errors: validation.errors }
  const json = canonicalJson(definition)
  const sha = crypto.createHash('sha256').update(json).digest('hex')
  return db.transaction((): SaveFlowVersionResult => {
    let flow = db.prepare('SELECT id FROM flow_definitions WHERE workspace = ? AND slug = ?').get(workspace, definition.id) as { id: number } | undefined
    if (!flow) {
      const r = db.prepare('INSERT INTO flow_definitions (slug, workspace, name, created_by) VALUES (?, ?, ?, ?)')
        .run(definition.id, workspace, definition.name, author)
      flow = { id: Number(r.lastInsertRowid) }
    }
    const existing = db.prepare('SELECT sha256 FROM flow_versions WHERE flow_id = ? AND version = ?').get(flow.id, definition.version) as { sha256: string } | undefined
    if (existing) {
      return existing.sha256 === sha
        ? { ok: true, flowId: flow.id, version: definition.version, created: false }
        : { ok: false, reason: 'version_immutable' }
    }
    const parent = db.prepare('SELECT MAX(version) v FROM flow_versions WHERE flow_id = ? AND version < ?').get(flow.id, definition.version) as { v: number | null }
    db.prepare(
      `INSERT INTO flow_versions (flow_id, version, definition_json, sha256, author, parent_version, validation_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(flow.id, definition.version, JSON.stringify(definition), sha, author, parent.v, JSON.stringify(validation))
    // approvals_json is NOT copied from `definition.approvals`: anyone who can draft
    // could type that block. Only the publish gate (cookie owner) writes it (B5).
    return { ok: true, flowId: flow.id, version: definition.version, created: true }
  })()
}

export function flowDefinitionSha256(definition: FlowDefinition): string {
  return crypto.createHash('sha256').update(canonicalJson(definition)).digest('hex')
}

/**
 * The owner's recorded approval of one version (flow_versions.approvals_json),
 * or null. It counts only when it names THIS version and carries THIS version's
 * SHA-256 — so a row B4 copied from definition text (no sha) is not authority.
 */
export function recordedFlowApprovals(db: Database.Database, flowId: number, version: number): FlowApprovals | null {
  const row = db.prepare('SELECT approvals_json, sha256 FROM flow_versions WHERE flow_id = ? AND version = ?').get(flowId, version) as
    | { approvals_json: string | null; sha256: string }
    | undefined
  if (!row?.approvals_json) return null
  let ap: FlowApprovals
  try { ap = JSON.parse(row.approvals_json) as FlowApprovals } catch { return null }
  if (!ap || ap.version !== version || ap.sha256 !== row.sha256 || !Array.isArray(ap.nodes)) return null
  return ap
}

/**
 * The definition the engine and the publish gate validate: the stored document
 * with its embedded `approvals` block REPLACED by the recorded owner approval
 * (or removed when there is none).
 */
export function withRecordedApprovals(def: FlowDefinition, approvals: FlowApprovals | null): FlowDefinition {
  const out: FlowDefinition = { ...def }
  delete out.approvals
  if (approvals) out.approvals = { version: approvals.version, nodes: approvals.nodes, by: approvals.by, at: approvals.at }
  return out
}

export function flowsEnabled(db: Database.Database): boolean {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'flows_enabled'").get() as { value: string } | undefined
    return row?.value === '1'
  } catch {
    return false // no settings table ⇒ off (fail closed)
  }
}

function intSetting(db: Database.Database, key: string, fallback: number): number {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
    const n = row ? Number(row.value) : NaN
    return Number.isInteger(n) && n > 0 ? n : fallback
  } catch {
    return fallback
  }
}

// ── Internal row shapes ─────────────────────────────────────────────────────

interface RunRow {
  id: number
  flow_id: number
  version: number
  workspace: string
  mode: string
  trigger_json: string | null
  status: FlowRunStatus
  lease_owner: string | null
  lease_expires_at: string | null
  next_attempt_at: string | null
  objective_id: number | null
  self_test_id: number | null
  wakes: number
  /** The failed run a replay re-runs (B8); null otherwise. */
  parent_run_id?: number | null
}

interface StepRow {
  id: number
  node_id: string
  iteration: number
  attempt: number
  status: FlowStepStatus
  effect: string | null
  input_json: string | null
  output_json: string | null
  error_json: string | null
  idempotency_key: string | null
  ended_at: string | null
  simulated: string | null
}

type Outcome =
  | { kind: 'continue' }
  | { kind: 'end'; output: unknown }
  | { kind: 'suspend'; until: string }
  | { kind: 'wait'; reason: string }
  | { kind: 'fail'; error: FlowProblem }

type StepResult = { kind: 'ok'; output: unknown } | Exclude<Outcome, { kind: 'continue' } | { kind: 'end' }>

class LeaseLostError extends Error {}

const parseJson = (s: string | null): unknown => {
  if (s === null) return null
  try { return JSON.parse(s) } catch { return null }
}

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex')

export function flowIdempotencyKey(runId: number, nodeId: string, iteration = 0): string {
  return sha256(`${runId}:${nodeId}:${iteration}`)
}

/** Delay before attempt `failures + 1`, where `failures` ≥ 1 failed attempts already happened. */
export function backoffDelayMs(node: Pick<FlowNode, 'retry'>, failures: number): number {
  const backoff = node.retry?.backoff ?? FLOW_DEFAULTS.backoff
  const base = node.retry?.delay_ms ?? FLOW_DEFAULTS.delayMs
  const d = backoff === 'fixed' ? base : base * 2 ** Math.max(0, failures - 1)
  return Math.min(d, FLOW_DEFAULTS.maxBackoffMs)
}

const DETERMINISTIC_KINDS = new Set(['trigger', 'branch', 'check', 'end'])
/** Synthetic node id the goal judge's spend is checked under (never a real node: ids cannot start with `$`). */
export const GOAL_JUDGE_NODE_ID = '$goal_judge'
const JUDGE_OUTPUT_SCHEMA = {
  type: 'object',
  properties: { pass: { type: 'boolean' }, reason: { type: 'string' } },
  required: ['pass', 'reason'],
}
/** Kinds that call out (and get retries, timeouts, crash recovery). */
const EFFECTFUL_KINDS = new Set(['tool', 'mcp', 'llm'])
type EffectfulNode = ToolNode | McpNode | LlmNode

// ── Engine ──────────────────────────────────────────────────────────────────

export class FlowEngine {
  readonly db: Database.Database
  readonly owner: string
  private readonly tools: FlowToolRegistry
  /** @internal */ readonly llm: LlmBackend | null
  /** @internal */ readonly mcp: FlowMcpResolver | null
  /** @internal */ readonly agents: FlowAgentHost | null
  private readonly clock: () => number
  private readonly leaseTtlMs: number
  private readonly heartbeatMs: number
  private readonly redact: (text: string) => string
  private readonly onEvent?: (event: FlowEngineEvent) => void
  private readonly inFlight = new Map<number, Promise<void>>()
  private readonly controllers = new Set<AbortController>()
  private readonly heartbeats = new Set<ReturnType<typeof setInterval>>()
  private killed = false

  constructor(opts: FlowEngineOptions) {
    this.db = opts.db
    this.tools = opts.tools
    this.llm = opts.llm ?? null
    this.mcp = opts.mcp ?? null
    this.agents = opts.agents ?? null
    this.clock = opts.clock ?? Date.now
    this.owner = opts.owner ?? `${os.hostname()}:${process.pid}:${crypto.randomBytes(4).toString('hex')}`
    this.leaseTtlMs = opts.leaseTtlMs ?? FLOW_DEFAULTS.leaseTtlMs
    this.heartbeatMs = opts.heartbeatMs ?? FLOW_DEFAULTS.heartbeatMs
    this.redact = opts.redact ?? ((t) => t)
    this.onEvent = opts.onEvent
    initFlowSchema(this.db)
    // Run spend is checked against (and added to) the job-accounting ledger.
    initJobAccountingSchema(this.db)
  }

  private iso(offsetMs = 0): string {
    return new Date(this.clock() + offsetMs).toISOString()
  }

  private emit(e: FlowEngineEvent): void {
    try { this.onEvent?.(e) } catch { /* observers never break a run */ }
  }

  // ── Starting runs ─────────────────────────────────────────────────────────

  /** Queue a run pinned to one version (default: the published one). Refused while flows_enabled is off. */
  startRun(args: {
    flowId: number
    version?: number
    trigger?: { source?: string; payload?: unknown }
    mode?: FlowRunMode
    objectiveId?: number | null
    parentRunId?: number | null
    /** The self-test this run belongs to (B5). */
    selfTestId?: number | null
  }): { ok: true; runId: number; seeded?: number } | { ok: false; reason: string } {
    if (!flowsEnabled(this.db)) return { ok: false, reason: 'flows_disabled' }
    const flow = this.db.prepare('SELECT id, workspace, status, published_version FROM flow_definitions WHERE id = ?').get(args.flowId) as
      { id: number; workspace: string; status: string; published_version: number | null } | undefined
    if (!flow) return { ok: false, reason: 'flow_not_found' }
    if (flow.status === 'archived') return { ok: false, reason: 'flow_archived' }
    const version = args.version ?? flow.published_version
    if (version === null || version === undefined) return { ok: false, reason: 'no_published_version' }
    const def = this.loadDefinition(flow.id, version)
    if (!def) return { ok: false, reason: 'version_not_found' }
    const mode: FlowRunMode = args.mode ?? 'live'
    // dry/test/replay runs never perform a write/send/spend (they are simulated), so
    // a draft may be tested before the owner approves it. A live run needs the
    // RECORDED owner approval of its send/spend nodes (the embedded block is ignored).
    const simulatedMode = mode === 'dry' || mode === 'test' || mode === 'replay'
    // B8: a replay re-runs one FAILED run (same flow) against this version.
    let parent: { id: number; version: number; trigger_json: string | null; error_json: string | null } | undefined
    if (mode === 'replay') {
      if (args.parentRunId == null) return { ok: false, reason: 'replay_parent_required' }
      parent = this.db.prepare('SELECT id, version, trigger_json, error_json FROM flow_runs WHERE id = ? AND flow_id = ?').get(args.parentRunId, flow.id) as
        typeof parent
      if (!parent) return { ok: false, reason: 'replay_parent_not_found' }
    }
    const effective = simulatedMode ? def : withRecordedApprovals(def, recordedFlowApprovals(this.db, flow.id, version))
    const v = validateFlow(effective, { requireApprovals: !simulatedMode })
    if (!v.ok) return { ok: false, reason: v.errors.every((e) => e.code === 'UNAPPROVED_EFFECT') ? 'unapproved_effect' : 'invalid_definition' }
    const now = this.iso()
    const triggerJson = args.trigger ? JSON.stringify(args.trigger)
      : parent?.trigger_json ?? JSON.stringify({ source: 'manual', payload: {} })
    return this.db.transaction(() => {
      const r = this.db.prepare(
        `INSERT INTO flow_runs (flow_id, version, workspace, mode, trigger_json, status, objective_id, parent_run_id, self_test_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)`,
      ).run(flow.id, version, flow.workspace, mode, triggerJson,
        args.objectiveId ?? null, args.parentRunId ?? null, args.selfTestId ?? null, now, now)
      const runId = Number(r.lastInsertRowid)
      if (!parent) return { ok: true as const, runId }
      const parentDef = this.loadDefinition(flow.id, parent.version)
      const seeded = parentDef ? this.seedReplay(runId, parent, parentDef, def, now) : 0
      return { ok: true as const, runId, seeded }
    })()
  }

  /**
   * B8 replay (§5.2 / §5.3): "recorded outputs from a previous run, up to a chosen
   * node". The chosen node is the FIRST row the failed run wrote for any node
   * that failed, was changed or removed by the patch. Every `succeeded` row the
   * failed run wrote BEFORE that row — and whose node is unchanged in the patched
   * version — is copied in as a memoised step (`simulated = 'replay'`, one row
   * per node and iteration), so the walk replays it without calling out. From
   * that node on the replay runs like `test`: read live, write/send/spend stubbed.
   * Rows are ordered by id, which is walk order, so a row before the cutoff can
   * never depend on a node the patch changed (that node would have its own,
   * earlier row and move the cutoff). Returns the number of rows copied.
   */
  private seedReplay(
    runId: number,
    parent: { id: number; error_json: string | null },
    parentDef: FlowDefinition,
    def: FlowDefinition,
    now: string,
  ): number {
    const diff = diffFlowNodes(parentDef, def)
    const stop = new Set([...diff.changed, ...diff.removed])
    const failedNode = (parseJson(parent.error_json) as { node_id?: unknown } | null)?.node_id
    if (typeof failedNode === 'string') stop.add(failedNode)
    const present = new Set(def.nodes.map((n) => n.id))
    const rows = this.db.prepare('SELECT * FROM flow_step_runs WHERE run_id = ? ORDER BY id').all(parent.id) as StepRow[]
    const cutoff = rows.find((r) => stop.has(r.node_id))?.id ?? Number.POSITIVE_INFINITY
    const latest = new Map<string, StepRow>()
    for (const r of rows) {
      if (r.id >= cutoff) break
      if (r.status !== 'succeeded' || !present.has(r.node_id) || stop.has(r.node_id)) continue
      latest.set(`${r.node_id}\u0000${r.iteration}`, r)
    }
    const ins = this.db.prepare(
      `INSERT INTO flow_step_runs (run_id, node_id, iteration, attempt, status, effect, input_json, output_json, error_json, simulated, started_at, ended_at)
       VALUES (?, ?, ?, 1, 'succeeded', ?, ?, ?, NULL, 'replay', ?, ?)`,
    )
    for (const r of latest.values()) ins.run(runId, r.node_id, r.iteration, r.effect, r.input_json, r.output_json, now, now)
    return latest.size
  }

  private loadDefinition(flowId: number, version: number): FlowDefinition | null {
    const row = this.db.prepare('SELECT definition_json FROM flow_versions WHERE flow_id = ? AND version = ?').get(flowId, version) as { definition_json: string } | undefined
    return row ? (parseJson(row.definition_json) as FlowDefinition) : null
  }

  // ── Tick / claim ──────────────────────────────────────────────────────────

  /**
   * One scheduler pass: heartbeat, then (only if flows_enabled) claim every
   * runnable run up to the global and per-flow caps and execute it. Resolves
   * when the runs claimed in THIS pass stop executing (finished, suspended for
   * backoff, waiting, or lease lost). The interval in startFlowEngine() does not
   * await it; a run already executing here is skipped by later ticks.
   */
  async tick(): Promise<{ claimed: number[] }> {
    if (this.killed) return { claimed: [] }
    this.recordHeartbeat()
    if (!flowsEnabled(this.db)) return { claimed: [] }
    // B9: settle due timed waits and finished agent cards first, so a run they
    // release is claimable in this same pass.
    try { this.resolveWaits() } catch (err) { console.warn('[flows] wait resolution failed:', err instanceof Error ? err.message : err) }
    const now = this.iso()
    const globalCap = intSetting(this.db, 'flow_max_concurrent_runs', FLOW_DEFAULTS.maxConcurrentRuns)
    const perFlowCap = intSetting(this.db, 'flow_per_flow_concurrent_runs', FLOW_DEFAULTS.perFlowConcurrentRuns)
    const candidates = this.db.prepare(
      `SELECT id, flow_id FROM flow_runs
        WHERE status IN ('queued', 'running')
          AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
          AND (lease_owner IS NULL OR lease_expires_at <= ?)
        ORDER BY id`,
    ).all(now, now) as { id: number; flow_id: number }[]
    const claimed: number[] = []
    for (const c of candidates) {
      if (this.inFlight.has(c.id)) continue
      const live = this.db.prepare(
        "SELECT flow_id FROM flow_runs WHERE status = 'running' AND lease_owner IS NOT NULL AND lease_expires_at > ?",
      ).all(now) as { flow_id: number }[]
      if (live.length >= globalCap) break
      if (live.filter((l) => l.flow_id === c.flow_id).length >= perFlowCap) continue
      if (this.claim(c.id)) claimed.push(c.id)
    }
    const runs = claimed.map((id) => {
      const p = this.executeClaimed(id).finally(() => this.inFlight.delete(id))
      this.inFlight.set(id, p)
      return p
    })
    await Promise.all(runs)
    return { claimed }
  }

  /** Boot-time pass: re-claims every run whose lease expired (i.e. the previous process died). */
  resumeOnBoot(): Promise<{ claimed: number[] }> {
    return this.tick()
  }

  /**
   * Execute one queued run NOW instead of waiting for the next tick (a self-test
   * answers synchronously). Same claim/lease as tick(), so it never races the
   * host tick: if the run is already executing here this awaits it, if another
   * engine holds the lease it returns without touching it. A run that suspends
   * for a retry backoff stays queued for the tick. Refused while flows_enabled is off.
   */
  async runNow(runId: number): Promise<void> {
    if (this.killed || !flowsEnabled(this.db)) return
    const existing = this.inFlight.get(runId)
    if (existing) return existing
    if (!this.claim(runId)) return
    const p = this.executeClaimed(runId).finally(() => this.inFlight.delete(runId))
    this.inFlight.set(runId, p)
    return p
  }

  private claim(runId: number): boolean {
    const now = this.iso()
    const r = this.db.prepare(
      `UPDATE flow_runs
          SET lease_owner = ?, lease_expires_at = ?, status = 'running', next_attempt_at = NULL,
              started_at = COALESCE(started_at, ?), updated_at = ?
        WHERE id = ? AND status IN ('queued', 'running')
          AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
          AND (lease_owner IS NULL OR lease_expires_at <= ?)`,
    ).run(this.owner, this.iso(this.leaseTtlMs), now, now, runId, now, now)
    return r.changes === 1
  }

  private recordHeartbeat(): void {
    try {
      this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .run(FLOW_HEARTBEAT_KEY, this.iso())
    } catch { /* bare test DB without settings */ }
  }

  /** Run `fn` in a transaction only while this engine still holds the run's lease; extends the lease. */
  private fenced<T>(runId: number, fn: () => T): T {
    if (this.killed) throw new LeaseLostError()
    return this.db.transaction(() => {
      const r = this.db.prepare(
        'UPDATE flow_runs SET lease_expires_at = ?, updated_at = ? WHERE id = ? AND lease_owner = ?',
      ).run(this.iso(this.leaseTtlMs), this.iso(), runId, this.owner)
      if (r.changes !== 1) throw new LeaseLostError()
      return fn()
    })()
  }

  /** Simulates (and is used on) process death in tests: stop heartbeats, abort steps, fence every later write. */
  kill(): void {
    this.killed = true
    for (const h of this.heartbeats) clearInterval(h)
    this.heartbeats.clear()
    for (const c of this.controllers) c.abort()
    this.controllers.clear()
  }

  // ── Executing one claimed run ─────────────────────────────────────────────

  private async executeClaimed(runId: number): Promise<void> {
    const run = this.db.prepare('SELECT * FROM flow_runs WHERE id = ?').get(runId) as RunRow
    const wakesAtStart = Number(run.wakes ?? 0)
    const hb = setInterval(() => {
      try { this.fenced(runId, () => undefined) } catch { clearInterval(hb) }
    }, this.heartbeatMs)
    hb.unref?.()
    this.heartbeats.add(hb)
    try {
      const def = this.loadDefinition(run.flow_id, run.version)
      if (!def) {
        this.finish(run, 'failed', null, { type: 'definition_missing', title: `flow ${run.flow_id} v${run.version} not found` })
        return
      }
      const stepsBefore = this.db.prepare('SELECT COUNT(*) n FROM flow_step_runs WHERE run_id = ?').get(runId) as { n: number }
      if (stepsBefore.n === 0) this.emit({ type: 'run_started', runId, flowId: run.flow_id, workspace: run.workspace })

      const trig = parseJson(run.trigger_json) as { payload?: unknown } | null
      const exec = new RunExecution(this, run, def, trig?.payload ?? {})
      const outcome = await exec.walk()
      switch (outcome.kind) {
        case 'end':
        case 'continue': { // 'continue' = chain ran out without an `end` (validator normally prevents this)
          // §3.3: the end condition is evaluated by the ENGINE, never by the agent
          // that built or repaired the flow. Run status and goal_met are separate.
          const goal = await exec.evaluateGoal()
          this.finish(run, 'succeeded', outcome.kind === 'end' ? outcome.output ?? null : null, null, goal)
          break
        }
        case 'fail':
          this.finish(run, 'failed', null, outcome.error)
          break
        case 'wait':
          this.fenced(runId, () => {
            // A token settled WHILE this pass walked (an approval click, a card going
            // done) bumped `wakes`; parking would strand that result, so requeue instead.
            const cur = this.db.prepare('SELECT wakes FROM flow_runs WHERE id = ?').get(runId) as { wakes: number }
            const next = Number(cur.wakes) !== wakesAtStart ? 'queued' : 'waiting'
            this.db.prepare(
              'UPDATE flow_runs SET status = ?, lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?',
            ).run(next, this.iso(), runId)
          })
          break
        case 'suspend':
          this.fenced(runId, () => {
            this.db.prepare(
              'UPDATE flow_runs SET next_attempt_at = ?, lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?',
            ).run(outcome.until, this.iso(), runId)
          })
          break
      }
    } catch (err) {
      if (err instanceof LeaseLostError) return // another engine owns this run now; write nothing
      try {
        this.finish(run, 'failed', null, { type: 'engine_error', title: 'engine error', detail: err instanceof Error ? err.message : String(err) })
      } catch { /* lease lost while failing */ }
    } finally {
      clearInterval(hb)
      this.heartbeats.delete(hb)
    }
  }

  private finish(run: RunRow, status: 'succeeded' | 'failed', output: unknown, error: FlowProblem | null, goal: FlowGoalResult | null = null): void {
    this.fenced(run.id, () => {
      const now = this.iso()
      this.db.prepare(
        `UPDATE flow_runs SET status = ?, output_json = ?, error_json = ?, goal_met = ?, goal_json = ?, lease_owner = NULL,
                lease_expires_at = NULL, next_attempt_at = NULL, ended_at = ?, updated_at = ? WHERE id = ?`,
      ).run(status, output === null ? null : this.serialise(output).text, error ? JSON.stringify(error) : null,
        goal ? (goal.met ? 1 : 0) : null, goal ? this.serialise(goal).text : null, now, now, run.id)
      // A self-test is judged once its last fixture run is terminal (flow-self-test.ts).
      if (run.self_test_id != null) {
        try { finalizeSelfTest(this.db, run.self_test_id, now) } catch (err) {
          console.warn(`[flows] self-test ${run.self_test_id} could not be finalized:`, err instanceof Error ? err.message : err)
        }
      }
    })
    this.emit({ type: 'run_finished', runId: run.id, flowId: run.flow_id, workspace: run.workspace, status, ...(error ? { error } : {}) })
  }

  // ── Helpers used by RunExecution ──────────────────────────────────────────

  /** @internal */ serialise(v: unknown): { text: string; tooLarge: boolean } {
    const raw = JSON.stringify(v ?? null) ?? 'null'
    if (Buffer.byteLength(raw) > FLOW_DEFAULTS.maxStepJsonBytes) return { text: raw, tooLarge: true }
    return { text: this.redact(raw), tooLarge: false }
  }
  /** @internal */ now(): number { return this.clock() }
  /** @internal */ isoAt(offsetMs = 0): string { return this.iso(offsetMs) }
  /** @internal */ tool(slug: string): FlowTool | null { return this.tools.get(slug) }
  /** Registry effect class of a Tool slug (B8: the repair classifier checks an added node's declared effect). */
  toolEffect(slug: string): FlowEffect | undefined {
    const t = this.tools.get(slug)
    return t ? t.effect ?? 'send' : undefined // registered with no metadata ⇒ unknown ⇒ send (§3.2)
  }
  /** @internal */ definitionOf(flowId: number, version: number): FlowDefinition | null { return this.loadDefinition(flowId, version) }
  /** @internal */ fence<T>(runId: number, fn: () => T): T { return this.fenced(runId, fn) }
  /** @internal */ event(e: FlowEngineEvent): void { this.emit(e) }
  /** @internal */ track(c: AbortController): () => void {
    if (this.killed) c.abort()
    this.controllers.add(c)
    return () => this.controllers.delete(c)
  }

  // ── Resolving an unknown-outcome wait ─────────────────────────────────────

  /**
   * Owner answer to "unknown outcome, confirm" (§5.4). `sent` = the side effect
   * happened: the step is recorded as succeeded (with `output` if known) and the
   * run continues after it. `not_sent` = it did not: the step runs again. Either
   * way the run goes back to `running` and the next tick picks it up. The caller
   * (card UI, B9) is responsible for checking the resolver is a verified owner.
   */
  resolveUnknownOutcome(args: { runId: number; nodeId: string; outcome: 'sent' | 'not_sent'; by: string; output?: unknown }): { ok: boolean; reason?: string } {
    return this.db.transaction(() => {
      const run = this.db.prepare('SELECT status FROM flow_runs WHERE id = ?').get(args.runId) as { status: string } | undefined
      if (!run) return { ok: false, reason: 'run_not_found' }
      if (run.status !== 'waiting') return { ok: false, reason: 'run_not_waiting' }
      const step = this.db.prepare(
        "SELECT id FROM flow_step_runs WHERE run_id = ? AND node_id = ? AND status = 'unknown' ORDER BY attempt DESC LIMIT 1",
      ).get(args.runId, args.nodeId) as { id: number } | undefined
      if (!step) return { ok: false, reason: 'no_unknown_step' }
      const now = this.iso()
      if (args.outcome === 'sent') {
        this.db.prepare("UPDATE flow_step_runs SET status = 'succeeded', output_json = ?, ended_at = COALESCE(ended_at, ?) WHERE id = ?")
          .run(this.serialise(args.output ?? null).text, now, step.id)
      } else {
        this.db.prepare("UPDATE flow_step_runs SET status = 'interrupted' WHERE id = ?").run(step.id)
      }
      this.db.prepare(
        `UPDATE flow_wait_tokens SET resolved_by = ?, resolved_at = ?, resolution = ?
          WHERE run_id = ? AND node_id = ? AND reason = 'unknown_outcome' AND resolved_at IS NULL`,
      ).run(args.by, now, args.outcome, args.runId, args.nodeId)
      this.db.prepare("UPDATE flow_runs SET status = 'running', next_attempt_at = NULL, wakes = wakes + 1, updated_at = ? WHERE id = ?").run(now, args.runId)
      return { ok: true }
    })()
  }

  // ── B9: settling wait tokens ──────────────────────────────────────────────

  /**
   * Settle one open token and its parked step row in ONE transaction, then
   * release the run (`waiting` → `queued`) for the next tick. Idempotent: a
   * token that is already resolved changes nothing and returns false. No lease is
   * needed — a parked run has none; an executor that is mid-walk sees `wakes`
   * move and requeues instead of parking (executeClaimed).
   */
  private settle(token: WaitTokenRow, r: {
    status: 'succeeded' | 'failed'; output?: unknown; error?: FlowProblem; resolution: string; by: string; costUsd?: number
  }): boolean {
    const done = this.db.transaction(() => {
      const now = this.iso()
      const t = this.db.prepare(
        'UPDATE flow_wait_tokens SET resolved_by = ?, resolved_at = ?, resolution = ? WHERE token_hash = ? AND resolved_at IS NULL',
      ).run(r.by, now, r.resolution, token.token_hash)
      if (t.changes !== 1) return false
      const cost = r.costUsd && Number.isFinite(r.costUsd) && r.costUsd > 0 ? r.costUsd : 0
      if (token.step_id != null) {
        this.db.prepare(
          `UPDATE flow_step_runs SET status = ?, output_json = ?, error_json = ?, cost_usd = cost_usd + ?, ended_at = ?
            WHERE id = ? AND status = 'running'`,
        ).run(r.status, r.status === 'succeeded' ? this.serialise(r.output ?? null).text : null,
          r.error ? JSON.stringify(r.error) : null, cost, now, token.step_id)
      }
      // A child card accounts its own spend on its own ledger; the run total adds it
      // so budget.run_usd sees it (§7.3) — the home card's ledger is NOT charged twice.
      if (cost) this.db.prepare('UPDATE flow_runs SET spent_usd = spent_usd + ? WHERE id = ?').run(cost, token.run_id)
      this.db.prepare(
        "UPDATE flow_runs SET wakes = wakes + 1, updated_at = ?, status = CASE WHEN status = 'waiting' THEN 'queued' ELSE status END, next_attempt_at = CASE WHEN status = 'waiting' THEN NULL ELSE next_attempt_at END WHERE id = ?",
      ).run(now, token.run_id)
      return true
    })()
    if (done) {
      const run = this.db.prepare('SELECT flow_id, workspace FROM flow_runs WHERE id = ?').get(token.run_id) as { flow_id: number; workspace: string } | undefined
      if (run) this.emit({ type: 'step', runId: token.run_id, flowId: run.flow_id, workspace: run.workspace, nodeId: token.node_id, iteration: token.iteration ?? 0, attempt: 0, status: r.status })
      if (run) this.emit({ type: 'wait', runId: token.run_id, flowId: run.flow_id, workspace: run.workspace, nodeId: token.node_id, reason: token.reason ?? '', resolution: r.resolution, by: r.by })
    }
    return done
  }

  /**
   * The tick's wait pass: release timed waits that are due, settle agent nodes
   * whose child card reached its disposition (and re-start a stranded one), and
   * expire event / approval / agent waits past their `timeout_ms`. Finally,
   * requeue any `waiting` run that has no open token left (self-healing).
   */
  resolveWaits(): { settled: number } {
    const now = this.iso()
    const open = this.db.prepare(
      `SELECT t.* FROM flow_wait_tokens t JOIN flow_runs r ON r.id = t.run_id
        WHERE t.resolved_at IS NULL AND t.reason IN ('agent', 'duration', 'until', 'event', 'approval')
          AND r.status IN ('queued', 'running', 'waiting')`,
    ).all() as WaitTokenRow[]
    let settled = 0
    for (const t of open) {
      const expired = t.expires_at !== null && t.expires_at <= now
      if (t.reason === 'duration' || t.reason === 'until') {
        if (expired) settled += Number(this.settle(t, { status: 'succeeded', output: { waited_until: t.expires_at, resumed_at: now }, resolution: 'elapsed', by: 'engine' }))
        continue
      }
      if (t.reason === 'agent' && t.objective_id != null) {
        const o = agentCardOutcome(this.db, t.objective_id)
        if (o.state === 'done') {
          settled += Number(this.settle(t, { status: 'succeeded', output: o.output, resolution: o.output.disposition, by: `objective:${t.objective_id}`, costUsd: o.costUsd }))
          continue
        }
        if (o.state === 'failed') {
          settled += Number(this.settle(t, { status: 'failed', error: { type: o.type, title: o.title, node_id: t.node_id, retryable: false }, resolution: o.type, by: `objective:${t.objective_id}` }))
          continue
        }
        if (o.stranded && !expired) this.kickStrandedAgent(t)
      }
      if (expired) {
        const type = t.reason === 'approval' ? 'approval_timeout' : t.reason === 'agent' ? 'agent_timeout' : 'wait_timeout'
        const what = t.reason === 'approval' ? 'no approval' : t.reason === 'agent' ? `child card #${t.objective_id} not done` : `event "${t.event_name}" not received`
        settled += Number(this.settle(t, {
          status: 'failed', error: { type, title: `"${t.node_id}" timed out: ${what} by ${t.expires_at}`, node_id: t.node_id, retryable: false },
          resolution: 'timeout', by: 'engine',
        }))
      }
    }
    this.db.prepare(
      `UPDATE flow_runs SET status = 'queued', updated_at = ?
        WHERE status = 'waiting' AND NOT EXISTS (SELECT 1 FROM flow_wait_tokens w WHERE w.run_id = flow_runs.id AND w.resolved_at IS NULL)`,
    ).run(now)
    return { settled }
  }

  /** Re-start an agent node's child card that never got a session (spawn refused at the cap, a restart …). */
  private kickStrandedAgent(t: WaitTokenRow): void {
    if (!this.agents?.startCard || t.objective_id == null) return
    const detail = (parseJson(t.detail_json) as { kicks?: number; last_kick_at?: string } | null) ?? {}
    const kicks = Number(detail.kicks ?? 0)
    if (kicks >= FLOW_DEFAULTS.strandedAgentMaxKicks) return
    const last = detail.last_kick_at ? Date.parse(detail.last_kick_at) : Date.parse(t.created_at)
    if (this.clock() - last < FLOW_DEFAULTS.strandedAgentKickMs) return
    const next = { ...detail, kicks: kicks + 1, last_kick_at: this.iso() }
    this.db.prepare('UPDATE flow_wait_tokens SET detail_json = ? WHERE token_hash = ?').run(JSON.stringify(next), t.token_hash)
    try { void Promise.resolve(this.agents.startCard(t.objective_id)).catch(() => undefined) } catch { /* never throws by contract */ }
  }

  private openTokens(runId: number, reasons: string[], nodeId?: string, iteration?: number): WaitTokenRow[] {
    const rows = this.db.prepare(
      `SELECT * FROM flow_wait_tokens WHERE run_id = ? AND resolved_at IS NULL AND reason IN (${reasons.map(() => '?').join(', ')}) ORDER BY created_at, iteration`,
    ).all(runId, ...reasons) as WaitTokenRow[]
    return rows.filter((r) => (nodeId === undefined || r.node_id === nodeId) && (iteration === undefined || r.iteration === iteration))
  }

  /**
   * An owner's Approve / Reject on an approval `wait` (§5.4 per-run approval).
   * Approve: the wait succeeds with `{ approved: true, by, at, note }` and the run
   * continues. Reject: the wait fails `approval_rejected` and so does the run.
   * The CALLER must have checked the resolver is a cookie owner/admin; `by`
   * is recorded on the token. `nodeId` / `iteration` pick one of several open
   * approvals (a parallel loop); with exactly one open, they may be omitted.
   */
  resolveApproval(args: { runId: number; nodeId?: string; iteration?: number; decision: 'approve' | 'reject'; by: string; note?: string }):
    { ok: true } | { ok: false; reason: 'run_not_found' | 'no_open_approval' | 'ambiguous_approval' } {
    const run = this.db.prepare('SELECT id FROM flow_runs WHERE id = ?').get(args.runId)
    if (!run) return { ok: false, reason: 'run_not_found' }
    const open = this.openTokens(args.runId, ['approval'], args.nodeId, args.iteration)
    if (open.length === 0) return { ok: false, reason: 'no_open_approval' }
    if (open.length > 1) return { ok: false, reason: 'ambiguous_approval' }
    const t = open[0]
    const note = typeof args.note === 'string' && args.note.trim() ? args.note.trim().slice(0, 1000) : null
    const at = this.iso()
    const ok = args.decision === 'approve'
      ? this.settle(t, { status: 'succeeded', output: { approved: true, by: args.by, at, note }, resolution: 'approved', by: args.by })
      : this.settle(t, {
        status: 'failed',
        error: { type: 'approval_rejected', title: `"${t.node_id}" was rejected by ${args.by}`, ...(note ? { detail: note } : {}), node_id: t.node_id, retryable: false },
        resolution: 'rejected', by: args.by,
      })
    return ok ? { ok: true } : { ok: false, reason: 'no_open_approval' }
  }

  /**
   * Deliver a named event to every open `wait.event` token of the flow's runs
   * (optionally one run). Each wait succeeds with `{ event, payload, received_at }`.
   * Workspace isolation is the caller's job (the route loads the flow first).
   */
  deliverEvent(args: { flowId: number; event: string; payload?: unknown; runId?: number; by: string }): { delivered: number; run_ids: number[] } {
    const rows = this.db.prepare(
      `SELECT t.* FROM flow_wait_tokens t JOIN flow_runs r ON r.id = t.run_id
        WHERE t.resolved_at IS NULL AND t.reason = 'event' AND t.event_name = ? AND r.flow_id = ?
          AND r.status IN ('queued', 'running', 'waiting') ${args.runId !== undefined ? 'AND r.id = ?' : ''}
        ORDER BY t.run_id, t.iteration`,
    ).all(args.event, args.flowId, ...(args.runId !== undefined ? [args.runId] : [])) as WaitTokenRow[]
    const runIds = new Set<number>()
    let delivered = 0
    for (const t of rows) {
      if (this.settle(t, { status: 'succeeded', output: { event: args.event, payload: args.payload ?? null, received_at: this.iso() }, resolution: 'event', by: args.by })) {
        delivered++
        runIds.add(t.run_id)
      }
    }
    return { delivered, run_ids: [...runIds] }
  }
}

// ── Wait tokens (B9) ────────────────────────────────────────────────────────

interface WaitTokenRow {
  token_hash: string
  run_id: number
  node_id: string
  kind: string
  reason: string | null
  detail_json: string | null
  expires_at: string | null
  created_at: string
  resolved_by: string | null
  resolved_at: string | null
  resolution: string | null
  step_id: number | null
  iteration: number
  objective_id: number | null
  event_name: string | null
}

/** What a run is parked on (the run detail's "waiting for" panel). */
export function listOpenWaits(db: Database.Database, runId: number): FlowWaitSummary[] {
  const hasObjectives = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'objectives'").get()
  const rows = db.prepare(
    hasObjectives
      ? `SELECT t.*, o.status AS objective_status FROM flow_wait_tokens t LEFT JOIN objectives o ON o.id = t.objective_id
          WHERE t.run_id = ? AND t.resolved_at IS NULL ORDER BY t.created_at, t.iteration`
      : 'SELECT t.*, NULL AS objective_status FROM flow_wait_tokens t WHERE t.run_id = ? AND t.resolved_at IS NULL ORDER BY t.created_at, t.iteration',
  ).all(runId) as (WaitTokenRow & { objective_status: string | null })[]
  return rows.map((t) => {
    const d = (parseJson(t.detail_json) as Record<string, unknown> | null) ?? {}
    const approval = d.approval && typeof d.approval === 'object' ? d.approval as { from: string; prompt: string } : null
    const next = d.next && typeof d.next === 'object' ? d.next as FlowWaitSummary['next'] : null
    return {
      node_id: t.node_id,
      iteration: t.iteration ?? 0,
      reason: t.reason ?? t.kind,
      kind: t.kind,
      created_at: t.created_at,
      expires_at: t.expires_at,
      objective_id: t.objective_id ?? null,
      objective_status: t.objective_status ?? null,
      event_name: t.event_name ?? null,
      approval,
      next,
    }
  })
}

// ── One execution pass over one run ─────────────────────────────────────────

/** What a dry/test step does instead of calling out. */
interface Simulation {
  label: FlowStepSimulation
  output?: unknown
  error?: FlowProblem
}

class RunExecution {
  private readonly byId: Map<string, FlowNode>
  private readonly scope: FlowEvalScope
  /** Loop iteration the walk is in (0 outside a loop); every step row is keyed by it. */
  private iter = 0
  private inLoop = false
  /** B8 replay: added/changed tool/mcp steps that are NOT proven read-only — stubbed, never run live. */
  private readonly replayUntrusted: Set<string>

  constructor(
    private readonly engine: FlowEngine,
    private readonly run: RunRow,
    private readonly def: FlowDefinition,
    triggerPayload: unknown,
    /** B9: one loop iteration runs in its own child execution (own scope + iteration key), so N can run at once. */
    iteration?: { index: number; scope: FlowEvalScope },
  ) {
    this.byId = new Map(def.nodes.map((n) => [n.id, n]))
    this.replayUntrusted = run.mode === 'replay' ? this.untrustedReplaySteps() : new Set()
    if (iteration) {
      this.scope = iteration.scope
      this.iter = iteration.index
      this.inLoop = true
    } else {
      this.scope = { trigger: { payload: triggerPayload }, steps: {}, now: () => new Date(engine.now()) }
    }
  }

  /**
   * B8: in a replay, a tool/mcp step the patch ADDED or CHANGED runs live only when
   * it is provably read-only (isProvenReadStep against the failed run's version).
   * A declared `effect: "read"` alone is text the repair agent typed.
   */
  private untrustedReplaySteps(): Set<string> {
    const out = new Set<string>()
    const parent = this.run.parent_run_id != null
      ? this.engine.db.prepare('SELECT version FROM flow_runs WHERE id = ?').get(this.run.parent_run_id) as { version: number } | undefined
      : undefined
    const before = parent ? this.engine.definitionOf(this.run.flow_id, parent.version) : null
    const d = before ? diffFlowNodes(before, this.def) : null
    for (const n of this.def.nodes) {
      if (n.kind !== 'tool' && n.kind !== 'mcp') continue
      const touched = !d || d.added.includes(n.id) || d.changed.includes(n.id)
      if (touched && !(before && isProvenReadStep(n, before, (s) => this.engine.toolEffect(s)))) out.add(n.id)
    }
    return out
  }

  /** The effect a simulated step is RECORDED and stubbed as (an untrusted replay step is treated as send). */
  private simEffect(node: FlowNode): FlowEffect {
    const e = this.effectOf(node)
    return e === 'read' && this.replayUntrusted.has(node.id) ? 'send' : e
  }

  /** Run context every `step` event carries (the live viewer routes on it, card B7). */
  private where(): { flowId: number; workspace: string; iteration: number } {
    return { flowId: this.run.flow_id, workspace: this.run.workspace, iteration: this.iter }
  }

  async walk(): Promise<Outcome> {
    const trigger = this.def.nodes.find((n) => n.kind === 'trigger')
    if (!trigger) return { kind: 'fail', error: { type: 'invalid_definition', title: 'no trigger node' } }
    return this.chain(trigger.id)
  }

  private async chain(startId: string): Promise<Outcome> {
    let id: string | undefined = startId
    while (id !== undefined) {
      const node = this.byId.get(id)
      if (!node) return { kind: 'fail', error: { type: 'invalid_definition', title: `dangling node "${id}"` } }
      const o = await this.node(node)
      if (o.kind !== 'continue') return o
      id = node.next
    }
    return { kind: 'continue' }
  }

  private async block(ids: string[]): Promise<Outcome> {
    for (const id of ids) {
      const node = this.byId.get(id)
      if (!node) return { kind: 'fail', error: { type: 'invalid_definition', title: `dangling node "${id}"` } }
      const o = await this.node(node)
      if (o.kind !== 'continue') return o
    }
    return { kind: 'continue' }
  }

  private async node(node: FlowNode): Promise<Outcome> {
    const r = await this.step(node)
    if (r.kind !== 'ok') return r
    if (node.kind === 'branch') {
      const chosen = (r.output as { block?: string[] } | null)?.block ?? []
      if (chosen.length) return this.block(chosen)
    }
    if (node.kind === 'end') return { kind: 'end', output: r.output }
    return { kind: 'continue' }
  }

  // ── Step memoisation, crash recovery, retries ─────────────────────────────

  private rows(nodeId: string): StepRow[] {
    return this.engine.db.prepare(
      'SELECT * FROM flow_step_runs WHERE run_id = ? AND node_id = ? AND iteration = ? ORDER BY attempt',
    ).all(this.run.id, nodeId, this.iter) as StepRow[]
  }

  private effectOf(node: FlowNode, row?: StepRow): FlowEffect {
    if (row?.effect) return row.effect as FlowEffect
    if (node.effect) return node.effect
    if (node.kind === 'tool') return this.engine.tool(node.tool)?.effect ?? 'send'
    if (node.kind === 'mcp') return 'send'
    return 'read'
  }

  /** Re-running an in-flight send/spend is safe only when the Tool dedupes by idempotency key. */
  private retrySafe(node: FlowNode): boolean {
    if (node.kind !== 'tool' || node.idempotency === 'none') return false
    return this.engine.tool(node.tool)?.idempotent === true
  }

  private async step(node: FlowNode): Promise<StepResult> {
    const runId = this.run.id
    for (;;) {
      const rows = this.rows(node.id)
      const last = rows[rows.length - 1]

      if (last?.status === 'succeeded') {
        const output = parseJson(last.output_json)
        this.scope.steps[node.id] = { output, input: parseJson(last.input_json) }
        return { kind: 'ok', output }
      }
      if (last?.status === 'unknown') return { kind: 'wait', reason: 'unknown_outcome' }

      // B9: agent / wait PARK on a wait token. Their `running` row is not a call in
      // flight — the token is still open (the resolver settles row + token together).
      if (node.kind === 'agent' || node.kind === 'wait') {
        if (last?.status === 'failed') return { kind: 'fail', error: { ...(parseJson(last.error_json) as FlowProblem), node_id: node.id } }
        if (last?.status === 'running') return { kind: 'wait', reason: node.kind }
        return this.park(node, rows.length + 1)
      }

      if (last?.status === 'running') {
        // We hold the lease, so nobody else is executing this: it was in flight when
        // the previous engine died.
        const effect = this.effectOf(node, last)
        if ((effect === 'send' || effect === 'spend') && !this.retrySafe(node)) {
          this.markUnknown(node, last, effect)
          return { kind: 'wait', reason: 'unknown_outcome' }
        }
        this.engine.fence(runId, () => {
          this.engine.db.prepare("UPDATE flow_step_runs SET status = 'interrupted', error_json = ?, ended_at = ? WHERE id = ?")
            .run(JSON.stringify({ type: 'interrupted', title: 'engine stopped while this step was in flight; re-running', node_id: node.id }), this.engine.isoAt(), last.id)
        })
        this.engine.event({ type: 'step', ...this.where(), runId, nodeId: node.id, attempt: last.attempt, status: 'interrupted' })
        continue
      }

      if (DETERMINISTIC_KINDS.has(node.kind)) {
        if (last?.status === 'failed') return { kind: 'fail', error: (parseJson(last.error_json) as FlowProblem) }
        return this.runDeterministic(node, rows.length + 1)
      }
      if (node.kind === 'loop' && !this.inLoop) {
        if (last?.status === 'failed') return { kind: 'fail', error: (parseJson(last.error_json) as FlowProblem) }
        return this.runLoop(node as LoopNode, rows.length + 1)
      }
      if (!EFFECTFUL_KINDS.has(node.kind)) {
        const error: FlowProblem = {
          type: 'unsupported_node_kind',
          title: node.kind === 'loop' ? `nested loop "${node.id}" is not executable` : `"${node.kind}" nodes are not executable`,
          detail: node.kind === 'loop'
            ? 'The engine runs one level of loop (sequential or bounded-parallel); a loop inside a loop body is refused.'
            : `The engine has no executor for "${node.kind}".`,
          node_id: node.id,
          retryable: false,
        }
        this.writeTerminalRow(node, rows.length + 1, 'failed', null, null, error)
        return { kind: 'fail', error }
      }

      // dry / test mode: a step that must not call out is simulated (§5.2) — no
      // retries, no budget (nothing is spent), no registry lookup, one terminal row.
      if (last?.status === 'failed' && last.simulated) return { kind: 'fail', error: { ...(parseJson(last.error_json) as FlowProblem), node_id: node.id } }
      const sim = this.simulation(node as EffectfulNode)
      if (sim) {
        this.writeSimulatedRow(node as EffectfulNode, rows.length + 1, sim)
        continue // the next pass reads the row just written (succeeded → ok, failed → fail)
      }

      // tool / mcp / llm: retry accounting
      const failures = rows.filter((r) => r.status === 'failed' || r.status === 'interrupted')
      const maxAttempts = Math.max(1, node.retry?.max ?? FLOW_DEFAULTS.attempts)
      if (last?.status === 'failed') {
        const err = parseJson(last.error_json) as FlowProblem | null
        if (err?.retryable === false || failures.length >= maxAttempts) {
          return { kind: 'fail', error: { ...(err ?? { type: 'step_failed', title: 'step failed' }), node_id: node.id } }
        }
        const realFailures = failures.filter((r) => r.status === 'failed').length
        const due = new Date(new Date(last.ended_at ?? this.engine.isoAt()).getTime() + backoffDelayMs(node, realFailures)).toISOString()
        if (due > this.engine.isoAt()) return { kind: 'suspend', until: due }
      } else if (failures.length >= maxAttempts) {
        return { kind: 'fail', error: { type: 'interrupted', title: `step interrupted ${failures.length} time(s); attempts exhausted`, node_id: node.id } }
      }
      // Budget gate (flow-budget.ts): checked before EVERY attempt of a spending node,
      // so a run that is already over budget stops here and the node never runs.
      if (isSpendingNode(node, this.effectOf(node))) {
        const b = checkFlowBudget(this.engine.db, { run: this.run, budget: this.def.budget, node })
        if (!b.ok) {
          this.writeTerminalRow(node, rows.length + 1, 'failed', null, null, b.problem)
          return { kind: 'fail', error: b.problem }
        }
        if (b.observed) this.engine.event({ type: 'budget_observed', runId, flowId: this.run.flow_id, workspace: this.run.workspace, nodeId: node.id, detail: b.observed })
      }
      await this.runEffectful(node as EffectfulNode, rows.length + 1)
      // loop: the next iteration reads the row just written (succeeded → ok, failed → retry/backoff/fail)
    }
  }

  private markUnknown(node: FlowNode, row: StepRow, effect: FlowEffect): void {
    const runId = this.run.id
    const token = crypto.randomBytes(24).toString('base64url')
    this.engine.fence(runId, () => {
      const now = this.engine.isoAt()
      this.engine.db.prepare("UPDATE flow_step_runs SET status = 'unknown', error_json = ?, ended_at = ? WHERE id = ?").run(
        JSON.stringify({
          type: 'unknown_outcome',
          title: `"${node.id}" (${effect}) was in flight when the engine stopped; it may or may not have happened`,
          detail: 'Not re-run automatically: its Tool does not declare idempotency support. Confirm whether it happened to continue.',
          node_id: node.id,
          retryable: false,
        }),
        now, row.id,
      )
      this.engine.db.prepare(
        `INSERT INTO flow_wait_tokens (token_hash, run_id, node_id, kind, reason, detail_json, created_at)
         VALUES (?, ?, ?, 'approval', 'unknown_outcome', ?, ?)`,
      ).run(sha256(token), runId, node.id, JSON.stringify({ effect, attempt: row.attempt, idempotency_key: row.idempotency_key }), now)
    })
    this.engine.event({ type: 'step', ...this.where(), runId, nodeId: node.id, attempt: row.attempt, status: 'unknown' })
  }

  private writeTerminalRow(node: FlowNode, attempt: number, status: 'succeeded' | 'failed', input: unknown, output: unknown, error: FlowProblem | null): void {
    const runId = this.run.id
    this.engine.fence(runId, () => {
      const now = this.engine.isoAt()
      this.engine.db.prepare(
        `INSERT INTO flow_step_runs (run_id, node_id, iteration, attempt, status, effect, input_json, output_json, error_json, started_at, ended_at)
         VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
      ).run(runId, node.id, this.iter, attempt, status,
        input === null ? null : this.engine.serialise(input).text,
        status === 'succeeded' ? this.engine.serialise(output).text : null,
        error ? JSON.stringify(error) : null, now, now)
    })
    this.engine.event({ type: 'step', ...this.where(), runId, nodeId: node.id, attempt, status })
  }

  /** trigger / branch / check / end: pure, synchronous, one row, never retried. */
  private runDeterministic(node: FlowNode, attempt: number): StepResult {
    let output: unknown
    try {
      switch (node.kind) {
        case 'trigger':
          output = this.scope.trigger.payload
          break
        case 'branch':
          output = this.chooseBranch(node as BranchNode)
          break
        case 'check': {
          const c = node as CheckNode
          const failed = c.assert.filter((a) => !evaluateCondition(a.expr, this.scope)).map((a) => ({ expr: a.expr, why: a.why }))
          output = { passed: failed.length === 0, failed }
          if (failed.length && (c.on_fail ?? 'fail') !== 'continue') {
            // `repair`: the run fails here and the auto-debug watcher (services/flow-repair.ts,
            // card B8) opens a repair for it. `fail` fails without a repair.
            const error: FlowProblem = {
              type: 'check_failed',
              title: `check "${c.id}" failed: ${failed.map((f) => f.why ?? f.expr).join('; ')}`,
              detail: JSON.stringify(failed),
              node_id: c.id,
              retryable: false,
            }
            this.writeTerminalRow(node, attempt, 'failed', null, null, error)
            return { kind: 'fail', error }
          }
          break
        }
        case 'end': {
          const e = node as EndNode
          output = e.output === undefined ? null : resolveTemplates(e.output, this.scope)
          break
        }
      }
    } catch (err) {
      const error: FlowProblem = {
        type: err instanceof FlowExprError ? 'expression_error' : 'step_failed',
        title: `"${node.id}" could not be evaluated`,
        detail: err instanceof Error ? err.message : String(err),
        node_id: node.id,
        retryable: false,
      }
      this.writeTerminalRow(node, attempt, 'failed', null, null, error)
      return { kind: 'fail', error }
    }
    this.writeTerminalRow(node, attempt, 'succeeded', null, output, null)
    this.scope.steps[node.id] = { output }
    return { kind: 'ok', output }
  }

  private chooseBranch(node: BranchNode): { case: number | 'default' | null; block: string[] } {
    for (let i = 0; i < node.cases.length; i++) {
      if (evaluateCondition(node.cases[i].when, this.scope)) return { case: i, block: node.cases[i].then }
    }
    if (node.default !== undefined) {
      return { case: 'default', block: typeof node.default === 'string' ? [node.default] : node.default }
    }
    return { case: null, block: [] }
  }

  /**
   * Execute one attempt of a tool / mcp / llm node and record its row. Never
   * throws except LeaseLostError.
   */
  private async runEffectful(node: EffectfulNode, attempt: number): Promise<void> {
    const runId = this.run.id
    const effect = this.effectOf(node)
    const key = effect !== 'read' && node.idempotency !== 'none' ? flowIdempotencyKey(runId, node.id, this.iter) : null

    const resolved = this.resolveInput(node)
    const input = resolved.input
    let preError: FlowProblem | null = resolved.error
    if (!preError) preError = this.unavailable(node)
    const inputText = this.engine.serialise(input ?? null).text

    // Record "in flight" BEFORE calling out — this row is what crash recovery reads.
    const rowId = this.engine.fence(runId, () => Number(this.engine.db.prepare(
      `INSERT INTO flow_step_runs (run_id, node_id, iteration, attempt, status, effect, input_json, idempotency_key, started_at)
       VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?)`,
    ).run(runId, node.id, this.iter, attempt, effect, inputText, key, this.engine.isoAt()).lastInsertRowid))
    this.engine.event({ type: 'step', ...this.where(), runId, nodeId: node.id, attempt, status: 'running' })

    let output: unknown = null
    let error: FlowProblem | null = preError
    if (!error) {
      const controller = new AbortController()
      const untrack = this.engine.track(controller)
      const timeoutMs = node.timeout_ms ?? (node.kind === 'llm' ? LLM_DEFAULTS.timeoutMs : FLOW_DEFAULTS.timeoutMs)
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        output = await Promise.race([
          this.callOut(node, input, { runId, nodeId: node.id, workspace: this.run.workspace, attempt, idempotencyKey: key, signal: controller.signal }, rowId),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              reject(new FlowStepError('timeout', `"${node.id}" timed out after ${timeoutMs} ms`, true))
              controller.abort()
            }, timeoutMs)
            // Engine killed: settle now instead of waiting for a call that ignores the signal.
            controller.signal.addEventListener('abort', () => reject(new FlowStepError('aborted', `"${node.id}" aborted`, true)), { once: true })
          }),
        ])
        if (output === undefined) output = null
      } catch (err) {
        if (err instanceof LeaseLostError) throw err
        const fp = (err as { flowProblem?: FlowProblem } | null)?.flowProblem
        error = fp ? { ...fp, node_id: node.id }
          : err instanceof FlowStepError
            ? { type: err.type, title: err.message, node_id: node.id, retryable: err.retryable }
            : err instanceof McpToolCallError
              ? { type: 'mcp_tool_error', title: `MCP tool "${(node as McpNode).tool}" reported an error`, detail: err.message, node_id: node.id, retryable: true }
              : { type: node.kind === 'tool' ? 'tool_error' : `${node.kind}_error`, title: err instanceof Error ? err.message : String(err), node_id: node.id, retryable: true }
        // B8: keep a process error's `code` (ENOENT) / exit code (127) — that is how
        // definition rot is told apart from a transient failure (shared/flow/repair.ts).
        const e = err as { code?: unknown; exitCode?: unknown; exit_code?: unknown } | null
        if (error && typeof e?.code === 'string') error.code = e.code
        const exit = e?.exit_code ?? e?.exitCode
        if (error && typeof exit === 'number') error.exit_code = exit
      } finally {
        if (timer) clearTimeout(timer)
        untrack()
      }
    }
    let outText: string | null = null
    if (!error) {
      const s = this.engine.serialise(output)
      if (s.tooLarge) {
        error = { type: 'output_too_large', title: `output of "${node.id}" exceeds ${FLOW_DEFAULTS.maxStepJsonBytes} bytes`, node_id: node.id, retryable: false }
      } else outText = s.text
    }

    const status: FlowStepStatus = error ? 'failed' : 'succeeded'
    // Fenced: if this engine was killed or lost the lease while awaiting, nothing is written.
    this.engine.fence(runId, () => {
      this.engine.db.prepare('UPDATE flow_step_runs SET status = ?, output_json = ?, error_json = ?, ended_at = ? WHERE id = ?')
        .run(status, outText, error ? JSON.stringify(error) : null, this.engine.isoAt(), rowId)
    })
    this.engine.event({ type: 'step', ...this.where(), runId, nodeId: node.id, attempt, status })
  }

  /** The resolved `input` / `arguments` / prompt of a tool / mcp / llm node. */
  private resolveInput(node: EffectfulNode): { input: unknown; error: FlowProblem | null } {
    try {
      const input = node.kind === 'tool' ? resolveTemplates(node.input ?? {}, this.scope)
        : node.kind === 'mcp' ? resolveTemplates(node.arguments ?? {}, this.scope)
          : { model: node.model ?? 'default', max_iterations: node.max_iterations ?? LLM_DEFAULTS.maxIterations, prompt: resolveTemplates(node.prompt, this.scope) }
      return { input, error: null }
    } catch (err) {
      return { input: null, error: { type: 'expression_error', title: `input of "${node.id}" could not be resolved`, detail: (err as Error).message, node_id: node.id, retryable: false } }
    }
  }

  /**
   * §5.2 run modes. Returns null when the step should really run, else what to
   * record instead:
   *
   *   mode   read             write / send / spend      llm (effect read)
   *   dry    mock             mock, "would …"           mock, else a schema stub
   *   test   LIVE             mock, "would …"           LIVE
   *
   * A write/send/spend node is ALWAYS labelled `would_<effect>` (its resolved
   * input is on the row), with or without a mock; without one its output is
   * null. A `read` tool/mcp node in a dry run with no mock fails `mock_missing`.
   * A `mock.error` makes the step fail (non-retryable) with that error.
   */
  private simulation(node: EffectfulNode): Simulation | null {
    const mode = this.run.mode
    if (mode !== 'dry' && mode !== 'test' && mode !== 'replay') return null
    const effect = this.simEffect(node)
    // B8: a replay runs exactly like `test` after its copied rows (read live, the rest stubbed).
    if ((mode === 'test' || mode === 'replay') && effect === 'read') return null
    const label: FlowStepSimulation = effect === 'read' ? (hasMock(node) || node.kind !== 'llm' ? 'mock' : 'stub') : `would_${effect}`
    const mock = node.mock
    if (mock && typeof mock === 'object' && 'error' in mock && mock.error !== undefined) {
      const e = mock.error as { type?: unknown; title?: unknown; detail?: unknown } | string
      const obj = typeof e === 'object' && e !== null ? e : null
      return {
        label,
        error: {
          type: typeof obj?.type === 'string' ? obj.type : 'mock_error',
          title: typeof obj?.title === 'string' ? obj.title : typeof e === 'string' ? e : `mock error of "${node.id}"`,
          ...(typeof obj?.detail === 'string' ? { detail: obj.detail } : {}),
          node_id: node.id,
          retryable: false,
        },
      }
    }
    if (mock && typeof mock === 'object' && 'output' in mock) return { label, output: mock.output ?? null }
    if (node.kind === 'llm' && effect === 'read') return { label: 'stub', output: stubFromSchema(node.output_schema) }
    if (effect === 'read') {
      return {
        label,
        error: {
          type: 'mock_missing',
          title: `"${node.id}" has no mock, and a dry run never calls out`,
          detail: 'Add mock.output (or mock.error) to this node, or self-test in mode "test" to read live.',
          node_id: node.id,
          retryable: false,
        },
      }
    }
    return { label, output: null }
  }

  private writeSimulatedRow(node: EffectfulNode, attempt: number, sim: Simulation): void {
    const runId = this.run.id
    const effect = this.simEffect(node)
    const resolved = this.resolveInput(node)
    let err: FlowProblem | null = resolved.error ?? sim.error ?? null
    let outText: string | null = null
    if (!err) {
      const out = this.engine.serialise(sim.output ?? null)
      if (out.tooLarge) err = { type: 'output_too_large', title: `mock output of "${node.id}" exceeds ${FLOW_DEFAULTS.maxStepJsonBytes} bytes`, node_id: node.id, retryable: false }
      else outText = out.text
    }
    const status: FlowStepStatus = err ? 'failed' : 'succeeded'
    this.engine.fence(runId, () => {
      const now = this.engine.isoAt()
      this.engine.db.prepare(
        `INSERT INTO flow_step_runs (run_id, node_id, iteration, attempt, status, effect, input_json, output_json, error_json, simulated, started_at, ended_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(runId, node.id, this.iter, attempt, status, effect, this.engine.serialise(resolved.input ?? null).text, outText,
        err ? JSON.stringify(err) : null, sim.label, now, now)
    })
    this.engine.event({ type: 'step', ...this.where(), runId, nodeId: node.id, attempt, status })
  }

  /** Node ids owned by a block, including the members of nested branch blocks. */
  private blockClosure(ids: string[], out = new Set<string>()): Set<string> {
    for (const id of ids) {
      if (out.has(id)) continue
      out.add(id)
      const n = this.byId.get(id)
      if (n?.kind === 'branch') {
        for (const c of n.cases) this.blockClosure(c.then, out)
        if (n.default !== undefined) this.blockClosure(typeof n.default === 'string' ? [n.default] : n.default, out)
      }
    }
    return out
  }

  /**
   * A loop (B5 sequential, B9 bounded-parallel). Each item runs the body block
   * in its own child execution — its own scope (`item.<as>` bound, body outputs
   * private to the item) and its own iteration key on every step row — so a
   * re-walk after a crash, a backoff or a wait replays finished iterations from
   * their memoised rows.
   *
   * `concurrency` (1..4, default 1) is a pool of SLOTS. A slot is freed only when
   * its iteration COMPLETES; an iteration that parks (agent card, approval, timed
   * wait) or suspends for a retry backoff keeps its slot for the rest of the pass.
   * Each iteration runs its body sequentially, so at most `concurrency` body
   * steps are ever in flight — including child agent cards. With concurrency 1
   * this is exactly the B5 sequential loop.
   *
   * After the in-flight iterations settle, the loop's outcome is the most severe
   * one: fail (first by index) > suspend (earliest) > wait. A failure stops new
   * iterations from starting. The loop's own row (iteration 0) holds its output:
   * one `{ <body node id>: output }` object per item, in item order.
   */
  private async runLoop(node: LoopNode, attempt: number): Promise<StepResult> {
    const fail = (error: FlowProblem): StepResult => {
      this.writeTerminalRow(node, attempt, 'failed', null, null, error)
      return { kind: 'fail', error }
    }
    let list: unknown
    try {
      list = evaluateExpressionField(node.over, this.scope)
    } catch (err) {
      return fail({ type: 'expression_error', title: `"${node.id}".over could not be evaluated`, detail: err instanceof Error ? err.message : String(err), node_id: node.id, retryable: false })
    }
    if (!Array.isArray(list)) {
      return fail({ type: 'loop_over_not_list', title: `"${node.id}".over is not a list`, detail: `got ${list === null ? 'null' : typeof list}`, node_id: node.id, retryable: false })
    }
    if (list.length > node.max_items) {
      return fail({ type: 'loop_max_items_exceeded', title: `"${node.id}" has ${list.length} items, max_items is ${node.max_items}`, node_id: node.id, retryable: false })
    }
    const items = list
    const concurrency = Math.max(1, Math.min(Number.isInteger(node.concurrency) ? node.concurrency! : 1, LOOP_MAX_CONCURRENCY))
    const outputs: Record<string, unknown>[] = new Array(items.length)
    const stopped: { index: number; outcome: Exclude<Outcome, { kind: 'continue' } | { kind: 'end' }> }[] = []
    let nextIndex = 0
    let halt = false

    const runItem = async (i: number): Promise<Outcome> => {
      const scope: FlowEvalScope = { ...this.scope, steps: { ...this.scope.steps }, item: { [node.as]: items[i] } }
      const child = new RunExecution(this.engine, this.run, this.def, null, { index: i, scope })
      const o = await child.block(node.body)
      if (o.kind === 'continue') {
        const per: Record<string, unknown> = {}
        for (const id of node.body) per[id] = scope.steps[id]?.output ?? null
        outputs[i] = per
      }
      return o
    }
    const slot = async (): Promise<void> => {
      while (!halt && nextIndex < items.length) {
        const i = nextIndex++
        let o = await runItem(i)
        if (o.kind === 'continue') continue // completed: the slot takes the next item
        if (o.kind === 'end') o = { kind: 'fail', error: { type: 'invalid_definition', title: `an end node inside loop "${node.id}"`, node_id: node.id, retryable: false } }
        stopped.push({ index: i, outcome: o })
        if (o.kind === 'fail') halt = true
        return // parked / suspended / failed: this slot stays occupied for the rest of the pass
      }
    }
    const settled = await Promise.allSettled(Array.from({ length: Math.min(concurrency, items.length) }, slot))
    const thrown = settled.find((r): r is PromiseRejectedResult => r.status === 'rejected')
    if (thrown) throw thrown.reason // LeaseLostError (or an engine bug) — never swallowed

    if (stopped.length) {
      stopped.sort((a, b) => a.index - b.index)
      const failed = stopped.find((x) => x.outcome.kind === 'fail')
      if (failed) return failed.outcome
      const suspends = stopped.flatMap((x) => (x.outcome.kind === 'suspend' ? [x.outcome.until] : []))
      if (suspends.length) return { kind: 'suspend', until: suspends.sort()[0] }
      return stopped[0].outcome
    }
    this.writeTerminalRow(node, attempt, 'succeeded', null, outputs, null)
    this.scope.steps[node.id] = { output: outputs }
    return { kind: 'ok', output: outputs }
  }

  // ── Parking nodes: agent + wait (B9) ──────────────────────────────────────

  /**
   * First visit of an `agent` / `wait` node. In a dry/test run nothing parks:
   * the step is simulated (its `mock`, else a stub; an approval counts as given)
   * so a self-test stays synchronous and never files a card. Live, the step row
   * (`running`), the wait token and — for an agent — the child card are written
   * in ONE fenced transaction, then the run parks.
   */
  private async park(node: AgentNode | WaitNode, attempt: number): Promise<StepResult> {
    const runId = this.run.id
    if (this.run.mode === 'dry' || this.run.mode === 'test' || this.run.mode === 'replay') return this.simulatePark(node, attempt)

    const bad = (type: string, title: string, detail?: string): StepResult => {
      const error: FlowProblem = { type, title, ...(detail ? { detail } : {}), node_id: node.id, retryable: false }
      this.writeTerminalRow(node, attempt, 'failed', null, null, error)
      return { kind: 'fail', error }
    }
    const resolveStr = (v: string, field: string): { ok: true; value: unknown } | { ok: false; result: StepResult } => {
      try { return { ok: true, value: resolveTemplates(v, this.scope) } } catch (err) {
        return { ok: false, result: bad('expression_error', `"${node.id}".${field} could not be resolved`, err instanceof Error ? err.message : String(err)) }
      }
    }
    const nowMs = this.engine.now()
    const deadline = typeof node.timeout_ms === 'number' && node.timeout_ms > 0 ? this.engine.isoAt(node.timeout_ms) : null

    let reason: 'agent' | 'duration' | 'until' | 'event' | 'approval'
    let kind: 'approval' | 'event' | 'until'
    let expiresAt: string | null = deadline
    let input: Record<string, unknown>
    let eventName: string | null = null
    let detail: Record<string, unknown> = {}
    let agentReq: Parameters<FlowAgentHost['createCard']>[1] | null = null

    if (node.kind === 'agent') {
      if (!this.engine.agents) return bad('agent_unavailable', 'no agent host is configured for this engine (child cards cannot be filed)')
      const b = checkFlowBudget(this.engine.db, { run: this.run, budget: this.def.budget, node })
      if (!b.ok) {
        this.writeTerminalRow(node, attempt, 'failed', null, null, b.problem)
        return { kind: 'fail', error: b.problem }
      }
      if (b.observed) this.engine.event({ type: 'budget_observed', runId, flowId: this.run.flow_id, workspace: this.run.workspace, nodeId: node.id, detail: b.observed })
      const brief = resolveStr(node.brief, 'brief')
      if (!brief.ok) return brief.result
      // The card's ceiling: the node's budget_usd, never more than the run has left.
      const spent = (this.engine.db.prepare('SELECT spent_usd FROM flow_runs WHERE id = ?').get(runId) as { spent_usd: number }).spent_usd
      const caps = [node.budget_usd, typeof this.def.budget?.run_usd === 'number' ? this.def.budget.run_usd - spent : undefined]
        .filter((c): c is number => typeof c === 'number' && Number.isFinite(c))
      const budgetUsd = caps.length ? Math.max(0, Math.min(...caps)) : null
      const home = this.run.objective_id
      agentReq = {
        runId, flowId: this.run.flow_id, flowName: this.def.name, nodeId: node.id, nodeLabel: node.label ?? null,
        iteration: this.inLoop ? this.iter : null, workspace: this.run.workspace, brief: String(brief.value ?? ''),
        agent: node.agent ?? null, budgetUsd, homeObjectiveId: home,
      }
      reason = 'agent'
      kind = 'event'
      input = { brief: agentReq.brief, agent: agentReq.agent, budget_usd: budgetUsd }
    } else if (node.for !== undefined) {
      const r = resolveStr(node.for, 'for')
      if (!r.ok) return r.result
      const ms = parseFlowDurationMs(String(r.value ?? ''))
      if (ms === null) return bad('invalid_duration', `"${node.id}".for is not a duration: "${String(r.value)}"`)
      reason = 'duration'
      kind = 'until'
      expiresAt = this.engine.isoAt(ms)
      input = { for: String(r.value), until: expiresAt }
    } else if (node.until !== undefined) {
      const r = resolveStr(node.until, 'until')
      if (!r.ok) return r.result
      const at = typeof r.value === 'number' ? r.value : Date.parse(String(r.value ?? ''))
      if (!Number.isFinite(at)) return bad('invalid_timestamp', `"${node.id}".until is not a timestamp: "${String(r.value)}"`)
      const iso = new Date(at).toISOString()
      if (at <= nowMs) {
        // Already past: nothing to wait for.
        this.writeTerminalRow(node, attempt, 'succeeded', { until: iso }, { waited_until: iso, resumed_at: this.engine.isoAt() }, null)
        const output = { waited_until: iso, resumed_at: this.engine.isoAt() }
        this.scope.steps[node.id] = { output }
        return { kind: 'ok', output }
      }
      reason = 'until'
      kind = 'until'
      expiresAt = iso
      input = { until: iso }
    } else if (node.event !== undefined) {
      const r = resolveStr(node.event, 'event')
      if (!r.ok) return r.result
      eventName = String(r.value ?? '').trim()
      if (!eventName) return bad('invalid_event', `"${node.id}".event resolved to an empty name`)
      reason = 'event'
      kind = 'event'
      input = { event: eventName }
    } else if (node.approval) {
      const r = resolveStr(node.approval.prompt, 'approval.prompt')
      if (!r.ok) return r.result
      const approval = { from: node.approval.from, prompt: String(r.value ?? '') }
      detail = { approval, next: this.previewNext(node) }
      reason = 'approval'
      kind = 'approval'
      input = { approval }
    } else {
      return bad('invalid_definition', `wait "${node.id}" has none of for / until / event / approval`)
    }

    const token = crypto.randomBytes(24).toString('base64url')
    let objectiveId: number | null = null
    this.engine.fence(runId, () => {
      const now = this.engine.isoAt()
      if (agentReq) {
        objectiveId = this.engine.agents!.createCard(this.engine.db, agentReq)
        input.objective_id = objectiveId
      }
      const stepId = Number(this.engine.db.prepare(
        `INSERT INTO flow_step_runs (run_id, node_id, iteration, attempt, status, effect, input_json, idempotency_key, started_at)
         VALUES (?, ?, ?, ?, 'running', NULL, ?, ?, ?)`,
      ).run(runId, node.id, this.iter, attempt, this.engine.serialise(input).text, flowIdempotencyKey(runId, node.id, this.iter), now).lastInsertRowid)
      this.engine.db.prepare(
        `INSERT INTO flow_wait_tokens (token_hash, run_id, node_id, kind, reason, detail_json, expires_at, created_at, step_id, iteration, objective_id, event_name)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(sha256(token), runId, node.id, kind, reason, this.engine.serialise(detail).text, expiresAt, now, stepId, this.iter, objectiveId, eventName)
    })
    this.engine.event({ type: 'step', runId, flowId: this.run.flow_id, workspace: this.run.workspace, nodeId: node.id, iteration: this.iter, attempt, status: 'running' })
    this.engine.event({ type: 'wait', runId, flowId: this.run.flow_id, workspace: this.run.workspace, nodeId: node.id, reason })
    if (objectiveId !== null && this.engine.agents?.startCard) {
      const id: number = objectiveId
      try { void Promise.resolve(this.engine.agents.startCard(id)).catch(() => undefined) } catch { /* never throws by contract */ }
    }
    return { kind: 'wait', reason }
  }

  /** The node an approval guards and its resolved input: the exact payload the owner is approving. */
  private previewNext(node: WaitNode): { node_id: string; kind: string; effect: string | null; input: unknown } | null {
    const next = node.next ? this.byId.get(node.next) : undefined
    if (!next) return null
    let input: unknown = null
    if (next.kind === 'tool' || next.kind === 'mcp' || next.kind === 'llm') {
      const r = this.resolveInput(next as EffectfulNode)
      input = r.error ? { error: r.error.detail ?? r.error.title } : r.input
    } else if (next.kind === 'agent') {
      try { input = { brief: resolveTemplates(next.brief, this.scope) } } catch { input = null }
    }
    const effect = next.kind === 'tool' || next.kind === 'mcp' || next.kind === 'llm' || next.kind === 'agent' ? this.effectOf(next) : null
    return { node_id: next.id, kind: next.kind, effect, input }
  }

  /** dry / test: an agent or wait step never parks. Its mock (or a stub) is recorded as a simulated row. */
  private simulatePark(node: AgentNode | WaitNode, attempt: number): StepResult {
    const runId = this.run.id
    const mock = node.mock
    let output: unknown = null
    let error: FlowProblem | null = null
    let label: FlowStepSimulation = 'stub'
    if (mock && typeof mock === 'object' && 'error' in mock && mock.error !== undefined) {
      label = 'mock'
      const e = mock.error as { type?: unknown; title?: unknown } | string
      const obj = typeof e === 'object' && e !== null ? e : null
      error = {
        type: typeof obj?.type === 'string' ? obj.type : 'mock_error',
        title: typeof obj?.title === 'string' ? obj.title : typeof e === 'string' ? e : `mock error of "${node.id}"`,
        node_id: node.id, retryable: false,
      }
    } else if (mock && typeof mock === 'object' && 'output' in mock) {
      label = 'mock'
      output = mock.output ?? null
    } else if (node.kind === 'agent') {
      output = { objective_id: null, status: 'done', disposition: 'complete', note: null, summary: null, pr_url: null, cost_usd: 0 }
    } else if (node.approval) {
      output = { approved: true, by: `simulated:${this.run.mode}`, at: this.engine.isoAt(), note: null }
    } else if (node.event !== undefined) {
      output = { event: node.event, payload: null, received_at: this.engine.isoAt() }
    } else {
      output = { waited_until: this.engine.isoAt(), resumed_at: this.engine.isoAt() }
    }
    const status: FlowStepStatus = error ? 'failed' : 'succeeded'
    this.engine.fence(runId, () => {
      const now = this.engine.isoAt()
      this.engine.db.prepare(
        `INSERT INTO flow_step_runs (run_id, node_id, iteration, attempt, status, effect, input_json, output_json, error_json, simulated, started_at, ended_at)
         VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?)`,
      ).run(runId, node.id, this.iter, attempt, status, error ? null : this.engine.serialise(output).text, error ? JSON.stringify(error) : null, label, now, now)
    })
    this.engine.event({ type: 'step', runId, flowId: this.run.flow_id, workspace: this.run.workspace, nodeId: node.id, iteration: this.iter, attempt, status })
    if (error) return { kind: 'fail', error }
    this.scope.steps[node.id] = { output }
    return { kind: 'ok', output }
  }

  // ── Goal / end condition (§3.3) ───────────────────────────────────────────

  /**
   * Evaluate `goal.end_condition` against the finished run: every deterministic
   * assert, then (only when they all pass, and never in a dry run) the optional
   * judge. An assert that cannot be evaluated counts as failed, with the reason.
   */
  async evaluateGoal(): Promise<FlowGoalResult> {
    const ec = this.def.goal?.end_condition
    const asserts = (ec?.assert ?? []).map((a) => {
      const base = { expr: a.expr, ...(a.why ? { why: a.why } : {}) }
      try {
        return { ...base, passed: evaluateCondition(a.expr, this.scope) }
      } catch (err) {
        return { ...base, passed: false, error: err instanceof Error ? err.message : String(err) }
      }
    })
    const assertsOk = asserts.length > 0 && asserts.every((a) => a.passed)
    let judge: FlowJudgeResult | null = null
    if (ec?.judge) {
      if (!assertsOk) judge = { status: 'skipped', reason: 'a deterministic assert failed; the judge was not asked' }
      else if (this.run.mode === 'dry') judge = { status: 'skipped', reason: 'dry run: no model calls (self-test in mode "test" to run the judge)' }
      else if (!this.engine.llm) judge = { status: 'skipped', reason: 'no model backend is configured for this engine' }
      else judge = await this.runJudge(ec.judge)
    }
    const met = assertsOk && (judge === null || judge.status === 'passed' || judge.status === 'skipped')
    return { met, asserts, judge, evaluated_at: this.engine.isoAt() }
  }

  /** The judge: one small model call that sees ONLY the rubric and the named value. */
  private async runJudge(j: { rubric: string; on: string; budget_usd?: number }): Promise<FlowJudgeResult> {
    let value: unknown
    try {
      value = evaluateExpressionField(j.on, this.scope)
    } catch (err) {
      return { status: 'error', reason: `judge.on could not be evaluated: ${err instanceof Error ? err.message : String(err)}` }
    }
    const prompt = [
      'You are the end-condition judge of an automated workflow. Decide whether the value below satisfies the rubric.',
      'Reply {"pass": true|false, "reason": "<one sentence>"}.',
      '', `Rubric: ${j.rubric}`, '', 'Value (JSON):', (JSON.stringify(value ?? null) ?? 'null').slice(0, 8_000),
    ].join('\n')
    const node: LlmNode = {
      id: GOAL_JUDGE_NODE_ID, kind: 'llm', model: 'default', max_iterations: 2, output_schema: JUDGE_OUTPUT_SCHEMA, prompt,
      ...(j.budget_usd !== undefined ? { budget_usd: j.budget_usd } : {}),
    }
    // The judge has no step row, so its own budget_usd is checked against what it
    // spent in this call; run_usd / job ceilings see the run total (written per turn).
    let spent = 0
    const budget = (): FlowProblem | null => {
      const b = checkFlowBudget(this.engine.db, { run: this.run, budget: this.def.budget, node })
      if (!b.ok) return b.problem
      if (typeof j.budget_usd === 'number' && spent >= j.budget_usd) {
        return { type: 'budget', title: `judge budget exhausted: $${spent.toFixed(4)} spent of judge.budget_usd $${j.budget_usd.toFixed(4)}`, node_id: GOAL_JUDGE_NODE_ID, retryable: false }
      }
      return null
    }
    const pre = budget()
    if (pre) return { status: 'error', reason: pre.title }
    const controller = new AbortController()
    const untrack = this.engine.track(controller)
    const timer = setTimeout(() => controller.abort(), LLM_DEFAULTS.timeoutMs)
    try {
      const r = await runLlmAttempt({
        node, prompt, backend: this.engine.llm!, signal: controller.signal,
        onCost: (usd) => {
          spent += usd
          this.engine.fence(this.run.id, () => addRunSpend(this.engine.db, this.run, usd))
        },
        beforeTurn: budget,
      })
      if (!r.ok) return { status: 'error', reason: `${r.error.type}: ${r.error.title}`, cost_usd: r.costUsd }
      const out = r.output as { pass?: unknown; reason?: unknown }
      return { status: out.pass === true ? 'passed' : 'failed', reason: typeof out.reason === 'string' ? out.reason.slice(0, 500) : '', cost_usd: r.costUsd }
    } catch (err) {
      if (err instanceof LeaseLostError) throw err
      return { status: 'error', reason: controller.signal.aborted ? 'judge aborted or timed out' : err instanceof Error ? err.message : String(err) }
    } finally {
      clearTimeout(timer)
      untrack()
    }
  }

  /** Why this node cannot run at all on this engine, or null. */
  private unavailable(node: EffectfulNode): FlowProblem | null {
    if (node.kind === 'tool' && !this.engine.tool(node.tool)) {
      return { type: 'unknown_tool', title: `Tool "${node.tool}" is not registered with the flow engine`, node_id: node.id, retryable: false }
    }
    if (node.kind === 'mcp' && !this.engine.mcp) {
      return { type: 'mcp_unavailable', title: 'no MCP connector resolver is configured for this engine', node_id: node.id, retryable: false }
    }
    if (node.kind === 'llm' && !this.engine.llm) {
      return { type: 'llm_unavailable', title: 'no model backend is configured for this engine', node_id: node.id, retryable: false }
    }
    return null
  }

  /** The actual outbound call for one attempt. Throws to fail the attempt. */
  private async callOut(node: EffectfulNode, input: unknown, ctx: FlowToolContext, rowId: number): Promise<unknown> {
    if (node.kind === 'tool') return this.engine.tool(node.tool)!.run(input, ctx)

    if (node.kind === 'mcp') {
      const res = await this.engine.mcp!.resolve({ workspace: this.run.workspace, connector: node.connector, tool: node.tool })
      if (!res.ok) throw Object.assign(new Error(res.problem.title), { flowProblem: res.problem })
      return mcpResultToOutput(await res.connection.call(node.tool, (input ?? {}) as Record<string, unknown>, ctx.signal))
    }

    // llm
    const r = await runLlmAttempt({
      node,
      prompt: String((input as { prompt: unknown }).prompt ?? ''),
      backend: this.engine.llm!,
      signal: ctx.signal,
      runTool: (slug, toolInput) => {
        const t = this.engine.tool(slug)
        if (!t) return Promise.reject(new Error(`Tool "${slug}" is not registered with the flow engine`))
        if ((t.effect ?? 'send') !== 'read') return Promise.reject(new Error(`Tool "${slug}" is not read-only`))
        return t.run(toolInput, { ...ctx, idempotencyKey: null })
      },
      // Each turn's cost is written as soon as it is known (fenced), so a crash or
      // timeout mid-loop still leaves the spend on the run and the card ledger.
      onCost: (usd) => this.engine.fence(this.run.id, () => {
        this.engine.db.prepare('UPDATE flow_step_runs SET cost_usd = cost_usd + ? WHERE id = ?').run(usd, rowId)
        addRunSpend(this.engine.db, this.run, usd)
      }),
      beforeTurn: () => {
        const b = checkFlowBudget(this.engine.db, { run: this.run, budget: this.def.budget, node })
        return b.ok ? null : b.problem
      },
    })
    if (!r.ok) throw Object.assign(new Error(r.error.title), { flowProblem: r.error as FlowProblem })
    return r.output
  }
}

// ── Host wiring ─────────────────────────────────────────────────────────────

/** Tools registered in-process. The okit-registry-backed runner (HTTP / script Tools) plugs in here. */
const registeredTools = new Map<string, FlowTool>()
export function registerFlowTool(slug: string, tool: FlowTool): void { registeredTools.set(slug, tool) }
export const defaultFlowToolRegistry: FlowToolRegistry = { get: (slug) => registeredTools.get(slug) ?? null }
/** Slugs + effect classes of the in-process Tools (the builder brief lists them, card B6). */
export function listRegisteredFlowTools(): { slug: string; effect: FlowEffect | undefined }[] {
  return [...registeredTools.entries()].map(([slug, t]) => ({ slug, effect: t.effect })).sort((a, b) => a.slug.localeCompare(b.slug))
}

export const FLOW_TICK_MS = 2000

let tickTimer: ReturnType<typeof setInterval> | null = null
let hostEngine: FlowEngine | null = null

export interface StartFlowEngineOptions {
  /** Defaults to detectScratchInstance(). Injected by tests. */
  scratch?: ScratchVerdict
  /** Defaults to an engine on getDb() with redaction and activity_log wiring. */
  engine?: FlowEngine
  /** B8: defaults to a FlowRepairWatcher on the engine with the host card wiring. */
  repairWatcher?: import('./flow-repair.js').FlowRepairWatcher
  tickMs?: number
}

/**
 * Arm the engine tick on the real host. Returns false (and arms nothing) on a
 * scratch instance. While `flows_enabled != '1'` every tick only writes the
 * heartbeat. The first tick after boot is the resume-on-boot pass.
 */
export async function startFlowEngine(opts: StartFlowEngineOptions = {}): Promise<boolean> {
  const verdict = opts.scratch ?? detectScratchInstance()
  if (verdict.scratch) {
    console.log(`[flows] engine NOT started — scratch instance (${verdict.reason})`)
    return false
  }
  if (tickTimer) return true
  const engine = opts.engine ?? (await defaultHostEngine())
  hostEngine = engine
  // B8: the auto-debug watcher rides the same tick (triage failed runs, supervise repairs).
  const { FlowRepairWatcher, hostFlowRepairHost, setHostRepairWatcher } = await import('./flow-repair.js')
  // An injected engine (tests) gets a watcher with the plain DB card host: no host wiring is imported.
  const watcher = opts.repairWatcher
    ?? new FlowRepairWatcher({ engine, ...(opts.engine ? {} : { host: await hostFlowRepairHost() }) })
  setHostRepairWatcher(watcher)
  const run = () => {
    engine.tick().catch((err) => console.error('[flows] tick failed:', err))
    watcher.tick().catch((err) => console.error('[flows] repair watcher tick failed:', err))
  }
  tickTimer = setInterval(run, opts.tickMs ?? FLOW_TICK_MS)
  tickTimer.unref?.()
  run() // resume-on-boot
  console.log(`[flows] engine started — ${(opts.tickMs ?? FLOW_TICK_MS) / 1000}s tick, owner ${engine.owner}, flows_enabled=${flowsEnabled(engine.db) ? '1' : '0'}`)
  return true
}

export function stopFlowEngine(): void {
  if (tickTimer) clearInterval(tickTimer)
  tickTimer = null
  hostEngine = null
  void import('./flow-repair.js').then((m) => m.setHostRepairWatcher(null)).catch(() => undefined)
}

export function flowEngineRunning(): boolean { return tickTimer !== null }
export function getHostFlowEngine(): FlowEngine | null { return hostEngine }

/**
 * The llm-gateway model path for `llm` nodes: the same Claude CLI backend as
 * routes/llm-gateway.ts (pool seats, reserve seats excluded), with the install's
 * single server token (SESSION_JAIL_CLAUDE_OAUTH_TOKEN) as the last resort.
 * Built lazily on the first llm call so importing the engine stays light.
 */
function hostLlmBackend(): LlmBackend {
  let backend: LlmBackend | null = null
  return async (req) => {
    if (!backend) {
      const { createClaudeCliBackend } = await import('./llm-gateway/claude-cli-backend.js')
      const token = (process.env.SESSION_JAIL_CLAUDE_OAUTH_TOKEN ?? '').trim()
      backend = createClaudeCliBackend({ fallbackTokens: token ? [{ id: 'server-token', token }] : [] })
    }
    return backend(req)
  }
}

/**
 * Engine event → WebSocket `flow_step` message for the live viewer overlay
 * (card B7, docs/design/WORKFLOWS.md §6.2 "Run overlay"). Carries ids and a
 * status only — never step input/output — and is delivered by ws/index.ts to
 * sockets whose user belongs to `workspace`. The client refetches the run (a
 * workspace-checked, redacted REST read) on receipt.
 */
export function flowEventToLiveMessage(e: FlowEngineEvent, at: string = new Date().toISOString()): ServerMessage | null {
  switch (e.type) {
    case 'step':
      return {
        type: 'flow_step',
        payload: {
          workspace: e.workspace, flow_id: e.flowId, run_id: e.runId, event: 'step',
          node_id: e.nodeId, iteration: e.iteration, attempt: e.attempt, status: e.status, at,
        },
      }
    case 'wait':
      // B9: a run parked on (or was released from) a wait token. The overlay refetches;
      // `status` says which way it went. Ids + reason only — never the wait's detail.
      return {
        type: 'flow_step',
        payload: {
          workspace: e.workspace, flow_id: e.flowId, run_id: e.runId, event: 'wait',
          node_id: e.nodeId, status: e.resolution ?? 'waiting', at,
        },
      }
    case 'run_started':
      return { type: 'flow_step', payload: { workspace: e.workspace, flow_id: e.flowId, run_id: e.runId, event: 'run_started', at } }
    case 'run_finished':
      return {
        type: 'flow_step',
        payload: { workspace: e.workspace, flow_id: e.flowId, run_id: e.runId, event: 'run_finished', status: e.status, at },
      }
    default:
      return null
  }
}

async function defaultHostEngine(): Promise<FlowEngine> {
  const [{ getDb }, { redactForStorage }, { logActivity }, { broadcast }] = await Promise.all([
    import('../db/index.js'),
    import('./secret-redaction.js'),
    import('../routes/feed.js'),
    import('../ws/index.js'),
  ])
  return new FlowEngine({
    db: getDb(),
    tools: defaultFlowToolRegistry,
    llm: hostLlmBackend(),
    mcp: createWorkspaceMcpResolver(),
    agents: hostFlowAgentHost,
    redact: (t) => redactForStorage(t).text,
    onEvent: (e) => {
      // Live viewer overlay (card B7): push ids + status, synchronously with the row write.
      const live = flowEventToLiveMessage(e)
      if (live) {
        try { broadcast(live) } catch { /* observers never break a run */ }
      }
      if (e.type === 'step') return
      if (e.type === 'wait') {
        // Parking is routine; a RELEASE by a person (approval, reject, outcome) is a decision worth a line.
        if (!e.resolution || !e.by || e.by === 'engine' || e.by.startsWith('objective:')) return
        try {
          logActivity({
            project: 'flows', workspace: e.workspace, event_type: 'decision',
            title: `Flow run ${e.runId}: "${e.nodeId}" ${e.resolution} by ${e.by}`, detail: null,
            metadata: { kind: `flow_wait_${e.resolution}`, run_id: e.runId, flow_id: e.flowId, node_id: e.nodeId, reason: e.reason, actor: e.by },
          })
        } catch { /* observers never break a run */ }
        return
      }
      if (e.type === 'budget_observed') {
        console.warn(`[flows] run ${e.runId} node ${e.nodeId}: ${e.detail}`)
        try {
          logActivity({
            project: 'flows', workspace: e.workspace, event_type: 'decision',
            title: `Flow run ${e.runId}: unbudgeted spend allowed (observe)`, detail: e.detail,
            metadata: { kind: 'flow_budget_observed', run_id: e.runId, flow_id: e.flowId, node_id: e.nodeId },
          })
        } catch { /* observers never break a run */ }
        return
      }
      // activity_log.event_type is CHECK-constrained: new kinds go in metadata.kind.
      try {
        logActivity({
          project: 'flows',
          workspace: e.workspace,
          event_type: e.type === 'run_finished' && e.status === 'failed' ? 'error' : 'milestone',
          title: e.type === 'run_started' ? `Flow run ${e.runId} started` : `Flow run ${e.runId} ${e.status}`,
          detail: e.type === 'run_finished' && e.error ? `${e.error.type}: ${e.error.title}` : null,
          metadata: { kind: e.type === 'run_started' ? 'flow_run_started' : `flow_run_${e.status}`, run_id: e.runId, flow_id: e.flowId },
        })
      } catch (err) {
        console.warn('[flows] activity log write failed:', err instanceof Error ? err.message : err)
      }
    },
  })
}
