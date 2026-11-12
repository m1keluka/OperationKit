/**
 * Workflows REST surface (obj 900640, card B4 of docs/design/WORKFLOWS.md §7.6).
 *
 *   GET  /api/flows?workspace=<slug>          list workflows (+ routine, last run)
 *   GET  /api/flows/runs?workspace=&limit=    recent runs across workflows (Jobs lanes)
 *   GET  /api/flows/:id?version=N             definition + versions + Mermaid with last-run status
 *   POST /api/flows                           create a workflow / a new draft version from okflow/1 JSON,
 *                                             OR "New workflow" from a goal: {workspace, goal, name?,
 *                                             end_condition?, builder?: {max_iterations}} → a builder card (B6)
 *   POST /api/flows/validate {definition}     validate okflow/1 JSON without saving it (B6)
 *   POST /api/flows/:id/versions {definition} draft a new version of an existing workflow (B6); every
 *                                             validation error at once; agent drafts count against
 *                                             builder.max_iterations
 *   POST /api/flows/:id/test {version?, mode?, fixtures?}  self-test a version: dry | test (B5, §5.2)
 *   GET  /api/flows/:id/tests?version=N       self-tests of a workflow (latest first)
 *   GET  /api/flows/:id/tests/:testId         one self-test + the engine's verdict
 *   POST /api/flows/:id/publish {version, approve?}  publish a version (cookie owner/admin only, §5.4):
 *                                             needs a green self-test and, for send/spend
 *                                             nodes, the owner's approval of exactly that set (B5)
 *   POST /api/flows/:id/runs                  run now (queues a live run of the published version)
 *   GET  /api/flows/:id/runs                  runs of one workflow
 *   GET  /api/flows/:id/runs/:runId           one run + its step rows + Mermaid overlay + open waits (B9)
 *   POST /api/flows/:id/runs/:runId/approval {decision: approve|reject, node_id?, iteration?, note?}
 *                                             answer an approval `wait` (cookie owner/admin only, §5.4) (B9)
 *   POST /api/flows/:id/runs/:runId/outcome {node_id, outcome: sent|not_sent}
 *                                             answer "unknown outcome, confirm" after a crash (cookie owner/admin only) (B9)
 *   POST /api/flows/:id/events {event, payload?, run_id?}  release `wait.event` nodes of this flow's runs (B9)
 *   GET  /api/flows/:id/runs/:runId/nodes/:nodeId  click-to-inspect (B7): node config, its attempts in
 *                                             this run, and its last good run — all redacted at READ time
 *   GET  /api/flows/:id/nodes/:nodeId?version=N  the same panel with no run selected (config + last good run)
 *   GET  /api/flows/:id/repairs               auto-debug incidents of a workflow (B8, §5.3), latest first
 *   GET  /api/flows/:id/repairs/:repairId     one incident: patch, diff, safe-class verdict, replay evidence
 *   POST /api/flows/:id/repairs/:repairId/draft {patch, explanation}
 *                                             the repair card's answer (ITS OWN card session only): JSON Patch →
 *                                             validate → replay → auto-apply (safe class) or Needs Review (B8)
 *   POST /api/flows/:id/repairs/:repairId/approve {approve?: [node ids]}
 *   POST /api/flows/:id/repairs/:repairId/reject {note?}
 *                                             the owner's decision on a Needs Review repair (cookie owner/admin only, §5.4)
 *
 * WORKSPACE ISOLATION (§7.5) is a hard filter on every route. A card session
 * (`X-CC-Session-Token`) is confined to its card's ONE workspace; a member to the
 * workspaces they belong to; an admin with a cookie sees all (the Jobs page is the
 * admin, cross-workspace surface). A cross-workspace request is a loud 403 — never
 * a silently narrowed 200.
 *
 * Agent API keys (card B6) reach every route here except publish, under the
 * scopes in agent-key-guard.ts (read = board:read; create/draft/validate =
 * board:write; test/run = board:start). A key sees the workspaces its owner
 * belongs to (all, for an admin's key), narrowed to the key's own allowlist.
 * The MCP tools in agent-mcp.ts are thin loopback adapters over these routes.
 *
 * The kill switch `settings.flows_enabled` (default '0') does not hide reads or
 * definitions, but nothing runs while it is off: run-now answers 409
 * `flows_disabled` and the scheduler refuses the routine's fires.
 */
import { Router } from 'express'
import type { Response } from 'express'
import type Database from 'better-sqlite3'
import type { Objective } from '@operationkit/shared'
import { getDb } from '../db/index.js'
import type { AuthRequest } from '../middleware/auth.js'
import { getUserWorkspaces, userHasWorkspace } from '../middleware/workspace.js'
import { sessionOrRequireAuth } from '../middleware/session-file-access.js'
import { broadcast } from '../ws/index.js'
import { logActivity } from './feed.js'
import {
  saveFlowVersion, flowsEnabled, flowDefinitionSha256, recordedFlowApprovals, withRecordedApprovals, listOpenWaits,
} from '../services/flow-engine.js'
import {
  checkPublishGate, getSelfTest, latestSelfTest, listSelfTests, parseFixtures, recordFlowApprovals, runSelfTest,
} from '../services/flow-self-test.js'
import { FLOW_SELF_TEST_MODES, nodesMissingMocks, nodesRequiringApproval, type FlowSelfTestMode } from '../../../shared/flow/self-test.js'
import {
  ensureFlowHomeCard, flowEngineFor, getFlowRow, latestFlowVersion, loadFlowVersion, publishFlowVersion, triggerOf,
  type FlowRow,
} from '../services/flow-routines.js'
import { describeCron, nextRunAt, type RoutineRow } from '../services/routine-scheduler.js'
import {
  BUILDER_MAX_ITERATIONS_CAP, FLOW_GOAL_MAX_CHARS, FLOW_NAME_MAX_CHARS, builderIterationState, createWorkflowFromGoal,
  isAgentAuthor, recordBuilderAttempt,
} from '../services/flow-builder.js'
import { validateFlow } from '../../../shared/flow/validate.js'
import { autoPauseThreshold } from '../services/routine-auto-pause.js'
import { definitionToMermaid } from '../../../shared/flow/mermaid.js'
import { nodeStatusFromSteps } from '../../../shared/flow/run-status.js'
import { diffFlowNodes } from '../../../shared/flow/diff.js'
import { redactLive } from '../services/live-redaction.js'
import type { FlowDefinition } from '../../../shared/flow/types.js'
import {
  FlowRepairWatcher, getHostRepairWatcher, REPAIR_DEFAULTS, type FlowRepairRow, type RepairReplaySummary,
} from '../services/flow-repair.js'
import type { RepairClassification } from '../../../shared/flow/repair.js'
import type {
  FlowBuilderState, FlowDetailResponse, FlowGoalResult, FlowListResponse, FlowNodeAttempt, FlowNodeInspectResponse,
  FlowPublishState, FlowRoutineInfo, FlowRunDetailResponse, FlowRunSummary, FlowRunsResponse, FlowStepSummary,
  FlowSummary, FlowVersionChanges, FlowVersionSummary,
} from '../../../shared/flow/api.js'

const router = Router()
router.use(sessionOrRequireAuth)

const WS_SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/i
const ID = /^\d+$/
const MAX_PAYLOAD_BYTES = 64 * 1024
const OUTPUT_PREVIEW_CHARS = 2000
/** Side-panel cap per field (B7). Applied AFTER redaction so a cut can never expose a token's prefix. */
const INSPECT_FIELD_CHARS = 8000
const INSPECT_MAX_ATTEMPTS = 20
const NODE_ID = /^[a-z][a-z0-9_]{0,40}$/

/**
 * Step I/O is redacted at WRITE time (redactForStorage), but a secret that was
 * added to the store after the row was written — or a value a rule did not
 * know then — would still be in the row. Everything the viewer shows from a
 * step row therefore goes through live-redaction at READ time too, and only
 * then is truncated: truncating first could cut a token below the length its
 * pattern needs and show its prefix.
 */
function redactThenCap(text: string | null, cap: number): { text: string | null; truncated: boolean } {
  if (text == null) return { text: null, truncated: false }
  const red = redactLive(text).text
  return red.length > cap ? { text: red.slice(0, cap), truncated: true } : { text: red, truncated: false }
}

// ── Principal → workspaces ──────────────────────────────────────────────────

/** 'all' for a cookie/JWT admin; otherwise the explicit list this caller may touch. */
function allowedWorkspaces(req: AuthRequest): 'all' | string[] {
  if (req.sessionFile) return [req.sessionFile.workspace]
  if (!req.user) return []
  const own: 'all' | string[] = req.user.role === 'admin' ? 'all' : getUserWorkspaces(req.user.id).map((w) => w.workspace)
  // An agent key (B6) acts as its owner, narrowed to the key's workspace allowlist.
  const keyWs = req.agentKey ? req.agentKey.workspaces : null
  if (!keyWs) return own
  return own === 'all' ? [...keyWs] : keyWs.filter((w) => own.includes(w))
}

function canAccessWorkspace(req: AuthRequest, workspace: string): boolean {
  if (req.sessionFile) return req.sessionFile.workspace === workspace
  if (!req.user) return false
  if (req.agentKey) {
    const allowed = allowedWorkspaces(req)
    return allowed === 'all' || allowed.includes(workspace)
  }
  if (req.user.role === 'admin') return true
  return userHasWorkspace(req.user.id, workspace)
}

/** Who did it, for flow_versions.author / self-test requested_by / activity. */
function actorOf(req: AuthRequest): string {
  if (req.sessionFile) return `agent:${req.sessionFile.objectiveId}`
  if (req.agentKey) return `agent_key:${req.agentKey.id}`
  return `user:${req.user!.id}`
}

function forbidden(res: Response, workspace: string): void {
  res.status(403).json({ error: `No access to workspace '${workspace}'`, code: 'workspace_forbidden' })
}

/** Publish is a human act: a cookie-authenticated admin, never a key or a card session (§5.4). */
function isCookieAdmin(req: AuthRequest): boolean {
  return !!req.user && req.user.role === 'admin' && req.authVia === 'session'
    && !req.agentKey && !req.sessionFile && typeof req.cookies?.token === 'string' && req.cookies.token.length > 0
}

/** Load the flow named by :id and enforce the workspace filter. Responds and returns null on failure. */
function loadFlowFor(req: AuthRequest, res: Response): FlowRow | null {
  const raw = String(req.params.id ?? '')
  if (!ID.test(raw)) {
    res.status(400).json({ error: 'flow id must be an integer' })
    return null
  }
  const flow = getFlowRow(getDb(), Number(raw))
  if (!flow) {
    res.status(404).json({ error: 'Workflow not found' })
    return null
  }
  if (!canAccessWorkspace(req, flow.workspace)) {
    forbidden(res, flow.workspace)
    return null
  }
  return flow
}

/** `?workspace=` handling for list routes: undefined = every allowed workspace. */
function listScope(req: AuthRequest, res: Response): { ok: true; workspaces: 'all' | string[] } | { ok: false } {
  const q = req.query.workspace
  if (q !== undefined && (typeof q !== 'string' || (q !== 'all' && !WS_SLUG.test(q)))) {
    res.status(400).json({ error: 'workspace must be a workspace slug' })
    return { ok: false }
  }
  const allowed = allowedWorkspaces(req)
  if (typeof q === 'string' && q !== 'all') {
    if (!canAccessWorkspace(req, q)) {
      forbidden(res, q)
      return { ok: false }
    }
    return { ok: true, workspaces: [q] }
  }
  return { ok: true, workspaces: allowed }
}

function wsClause(workspaces: 'all' | string[], column: string): { sql: string; params: string[] } {
  if (workspaces === 'all') return { sql: '1 = 1', params: [] }
  if (workspaces.length === 0) return { sql: '0 = 1', params: [] }
  return { sql: `${column} IN (${workspaces.map(() => '?').join(', ')})`, params: workspaces }
}

// ── Row → response shapes ───────────────────────────────────────────────────

interface RunRow {
  id: number
  flow_id: number
  version: number
  workspace: string
  mode: string
  trigger_json: string | null
  status: string
  goal_met: number | null
  spent_usd: number
  error_json: string | null
  goal_json?: string | null
  self_test_id?: number | null
  objective_id: number | null
  created_at: string
  started_at: string | null
  ended_at: string | null
  flow_slug?: string
  flow_name?: string
}

const parse = <T>(s: string | null): T | null => {
  if (!s) return null
  try { return JSON.parse(s) as T } catch { return null }
}

function runSummary(r: RunRow, flow?: Pick<FlowRow, 'slug' | 'name'>): FlowRunSummary {
  const trig = parse<{ source?: unknown }>(r.trigger_json)
  const err = parse<{ type?: unknown; title?: unknown; node_id?: unknown }>(r.error_json)
  return {
    id: r.id,
    flow_id: r.flow_id,
    flow_slug: flow?.slug ?? r.flow_slug ?? '',
    flow_name: flow?.name ?? r.flow_name ?? '',
    workspace: r.workspace,
    version: r.version,
    mode: r.mode,
    status: r.status,
    goal_met: r.goal_met,
    spent_usd: Number(r.spent_usd) || 0,
    trigger_source: typeof trig?.source === 'string' ? trig.source : null,
    objective_id: r.objective_id,
    created_at: r.created_at,
    started_at: r.started_at,
    ended_at: r.ended_at,
    error: err
      ? {
          type: typeof err.type === 'string' ? err.type : 'error',
          title: typeof err.title === 'string' ? err.title : '',
          ...(typeof err.node_id === 'string' ? { node_id: err.node_id } : {}),
        }
      : null,
    goal: parse<FlowGoalResult>(r.goal_json ?? null),
    self_test_id: r.self_test_id ?? null,
  }
}

function publishState(db: Database.Database, flowId: number, version: number, def: FlowDefinition): FlowPublishState {
  return {
    version,
    nodes_requiring_approval: nodesRequiringApproval(def),
    nodes_missing_mocks: nodesMissingMocks(def),
    self_test: latestSelfTest(db, flowId, version),
    approvals: recordedFlowApprovals(db, flowId, version),
  }
}

/** B6: goal + builder budget, for a workflow that has a goal (made with New workflow). */
function builderState(db: Database.Database, flow: FlowRow): FlowBuilderState | null {
  const row = db.prepare('SELECT goal_statement FROM flow_definitions WHERE id = ?').get(flow.id) as { goal_statement: string | null } | undefined
  if (!row?.goal_statement) return null
  return { goal: row.goal_statement, objective_id: flow.objective_id, ...builderIterationState(db, flow.id) }
}

function routineInfo(db: Database.Database, flowId: number): FlowRoutineInfo | null {
  const r = db.prepare("SELECT * FROM routines WHERE kind = 'flow' AND flow_id = ? ORDER BY id LIMIT 1").get(flowId) as
    | RoutineRow
    | undefined
  if (!r) return null
  const next = r.enabled ? nextRunAt(r.cron_expr) : null
  return {
    id: r.id,
    cron_expr: r.cron_expr,
    cadence: describeCron(r.cron_expr),
    enabled: r.enabled === 1,
    next_run_at: next ? next.toISOString() : null,
    last_run_at: r.last_run_at,
    consecutive_failures: r.consecutive_failures ?? 0,
    auto_pause_threshold: autoPauseThreshold(r),
    auto_paused_at: r.auto_paused_at ?? null,
    auto_pause_reason: r.auto_pause_reason ?? null,
  }
}

function summarize(db: Database.Database, flow: FlowRow): FlowSummary {
  const latest = latestFlowVersion(db, flow.id)
  const shownVersion = flow.published_version ?? latest
  const def = shownVersion != null ? loadFlowVersion(db, flow.id, shownVersion) : null
  const trig = triggerOf(def)
  const kinds: Record<string, number> = {}
  for (const n of def?.nodes ?? []) if (n && typeof n.kind === 'string') kinds[n.kind] = (kinds[n.kind] ?? 0) + 1
  const last = db.prepare("SELECT * FROM flow_runs WHERE flow_id = ? AND mode = 'live' ORDER BY id DESC LIMIT 1").get(flow.id) as
    | RunRow
    | undefined
  return {
    id: flow.id,
    slug: flow.slug,
    name: flow.name,
    workspace: flow.workspace,
    status: flow.status,
    published_version: flow.published_version,
    latest_version: latest,
    objective_id: flow.objective_id,
    created_by: flow.created_by,
    created_at: flow.created_at,
    updated_at: flow.updated_at,
    trigger: trig ? { on: trig.on, cron: trig.schedule?.cron ?? null } : null,
    node_count: def?.nodes?.length ?? 0,
    kinds,
    routine: routineInfo(db, flow.id),
    last_run: last ? runSummary(last, flow) : null,
  }
}

/**
 * Diagram + per-node overlay. A send/spend node is labelled "owner-approved"
 * only from the RECORDED approval of that version (`flow_versions.approvals_json`,
 * sha-bound). An `approvals` block typed into the definition is not authority
 * (B5), so the diagram must not show it as approved either.
 */
function overlayFor(db: Database.Database, flowId: number, version: number, stored: FlowDefinition, run: RunRow | undefined) {
  const def = withRecordedApprovals(stored, recordedFlowApprovals(db, flowId, version))
  if (!run) return { node_status: {}, mermaid: definitionToMermaid(def) }
  const steps = db.prepare('SELECT node_id, iteration, attempt, status FROM flow_step_runs WHERE run_id = ?').all(run.id) as
    { node_id: string; iteration: number; attempt: number; status: string }[]
  const nodeIds = (def.nodes ?? []).map((n) => n.id)
  const node_status = nodeStatusFromSteps(steps, run.status, nodeIds)
  return { node_status, mermaid: definitionToMermaid(def, { status: node_status }) }
}

/**
 * Changed-node tags for the version picker (B7). The base is the version this
 * one was drafted from (`parent_version`), else the next lower stored version.
 */
function versionChanges(db: Database.Database, flowId: number, version: number, def: FlowDefinition): FlowVersionChanges | null {
  const row = db.prepare('SELECT author, parent_version FROM flow_versions WHERE flow_id = ? AND version = ?').get(flowId, version) as
    | { author: string; parent_version: number | null }
    | undefined
  if (!row) return null
  let base = row.parent_version
  if (base == null || base === version) {
    const lower = db.prepare('SELECT MAX(version) v FROM flow_versions WHERE flow_id = ? AND version < ?').get(flowId, version) as
      { v: number | null }
    base = lower.v
  }
  if (base == null) return null
  const prev = loadFlowVersion(db, flowId, base)
  if (!prev) return null
  const d = diffFlowNodes(prev, def)
  return { base_version: base, author: row.author, added: d.added, changed: d.changed, removed: d.removed }
}

// ── Routes ──────────────────────────────────────────────────────────────────

router.get('/', (req: AuthRequest, res) => {
  const scope = listScope(req, res)
  if (!scope.ok) return
  const db = getDb()
  const w = wsClause(scope.workspaces, 'workspace')
  const rows = db.prepare(`SELECT * FROM flow_definitions WHERE ${w.sql} AND status != 'archived' ORDER BY workspace, name`).all(...w.params) as FlowRow[]
  const body: FlowListResponse = { flows_enabled: flowsEnabled(db), flows: rows.map((f) => summarize(db, f)) }
  res.json(body)
})

router.get('/runs', (req: AuthRequest, res) => {
  const scope = listScope(req, res)
  if (!scope.ok) return
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100))
  const db = getDb()
  const w = wsClause(scope.workspaces, 'r.workspace')
  const rows = db.prepare(
    `SELECT r.*, f.slug AS flow_slug, f.name AS flow_name
       FROM flow_runs r JOIN flow_definitions f ON f.id = r.flow_id
      WHERE ${w.sql} AND r.mode = 'live'
      ORDER BY r.id DESC LIMIT ?`,
  ).all(...w.params, limit) as RunRow[]
  const body: FlowRunsResponse = { flows_enabled: flowsEnabled(db), runs: rows.map((r) => runSummary(r)) }
  res.json(body)
})

router.get('/:id', (req: AuthRequest, res) => {
  const flow = loadFlowFor(req, res)
  if (!flow) return
  const db = getDb()
  const requested = req.query.version
  let version: number | null
  if (requested !== undefined) {
    if (typeof requested !== 'string' || !ID.test(requested)) {
      res.status(400).json({ error: 'version must be an integer' })
      return
    }
    version = Number(requested)
  } else {
    version = flow.published_version ?? latestFlowVersion(db, flow.id)
  }
  // B6: a workflow made from a goal has no version until its builder drafts one.
  // That is a normal state (the builder card is working on it), not a 404.
  if (version == null) {
    const empty: FlowDetailResponse = {
      flows_enabled: flowsEnabled(db), flow: summarize(db, flow), version: null, definition: null, versions: [],
      mermaid: '', node_status: {}, status_run_id: null, runs: [], publish: null, builder: builderState(db, flow), changes: null,
    }
    res.json(empty)
    return
  }
  const def = loadFlowVersion(db, flow.id, version)
  if (!def) {
    res.status(404).json({ error: 'Version not found' })
    return
  }
  const versions = (db.prepare(
    'SELECT version, author, sha256, parent_version, created_at FROM flow_versions WHERE flow_id = ? ORDER BY version DESC',
  ).all(flow.id) as Omit<FlowVersionSummary, 'published'>[]).map((v) => ({ ...v, published: v.version === flow.published_version }))
  const latestRun = db.prepare("SELECT * FROM flow_runs WHERE flow_id = ? AND version = ? AND mode = 'live' ORDER BY id DESC LIMIT 1")
    .get(flow.id, version) as RunRow | undefined
  const runs = db.prepare("SELECT * FROM flow_runs WHERE flow_id = ? AND mode = 'live' ORDER BY id DESC LIMIT 20").all(flow.id) as RunRow[]
  const overlay = overlayFor(db, flow.id, version, def, latestRun)
  const body: FlowDetailResponse = {
    flows_enabled: flowsEnabled(db),
    flow: summarize(db, flow),
    version,
    definition: def,
    versions,
    mermaid: overlay.mermaid,
    node_status: overlay.node_status,
    status_run_id: latestRun?.id ?? null,
    runs: runs.map((r) => runSummary(r, flow)),
    publish: publishState(db, flow.id, version, def),
    changes: versionChanges(db, flow.id, version, def),
    builder: builderState(db, flow),
  }
  res.json(body)
})

router.post('/', async (req: AuthRequest, res) => {
  const body = (req.body ?? {}) as { workspace?: unknown; definition?: unknown; goal?: unknown }
  const def = body.definition
  if (def === undefined && body.goal !== undefined) {
    await createFromGoal(req, res)
    return
  }
  if (!def || typeof def !== 'object' || Array.isArray(def)) {
    res.status(400).json({ error: 'definition (an okflow/1 JSON object) or goal (New workflow) is required' })
    return
  }
  const d = def as FlowDefinition
  const workspace =
    (typeof body.workspace === 'string' && body.workspace) ||
    (typeof d.workspace === 'string' && d.workspace) ||
    req.sessionFile?.workspace ||
    ''
  if (!workspace || !WS_SLUG.test(workspace)) {
    res.status(400).json({ error: 'workspace is required (body.workspace or definition.workspace)' })
    return
  }
  if (!canAccessWorkspace(req, workspace)) {
    forbidden(res, workspace)
    return
  }
  const db = getDb()
  const author = actorOf(req)
  const saved = saveFlowVersion(db, { workspace, definition: d, author })
  if (!saved.ok) {
    const status = saved.reason === 'version_immutable' ? 409 : 400
    res.status(status).json({ error: saved.reason, reason: saved.reason, errors: saved.errors ?? [] })
    return
  }
  const before = getFlowRow(db, saved.flowId)?.objective_id ?? null
  const actingUser = req.user && req.user.id > 0 ? req.user.id : null
  const objectiveId = ensureFlowHomeCard(db, saved.flowId, actingUser)
  if (objectiveId != null && objectiveId !== before) {
    const obj = db.prepare('SELECT * FROM objectives WHERE id = ?').get(objectiveId) as Objective | undefined
    if (obj) broadcast({ type: 'objective_updated', payload: obj })
  }
  const flow = getFlowRow(db, saved.flowId)!
  res.status(saved.created ? 201 : 200).json({
    ok: true,
    flow_id: saved.flowId,
    version: saved.version,
    created: saved.created,
    objective_id: objectiveId,
    flow: summarize(db, flow),
  })
})

// ── New workflow from a goal + drafting (B6, §5.1 / §7.6) ───────────────────

type EndCondition = { assert: { expr: string; why?: string }[]; judge?: unknown }

function parseEndCondition(raw: unknown): { ok: true; value: EndCondition | null } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, value: null }
  const ec = raw as { assert?: unknown }
  if (typeof raw !== 'object' || Array.isArray(raw) || !Array.isArray(ec.assert) || ec.assert.length === 0) {
    return { ok: false, error: 'end_condition must be {assert: [{expr, why?}, …], judge?} with at least one deterministic assert' }
  }
  for (const a of ec.assert) {
    if (!a || typeof a !== 'object' || typeof (a as { expr?: unknown }).expr !== 'string' || !(a as { expr: string }).expr.trim()) {
      return { ok: false, error: 'every end_condition.assert entry needs a non-empty expr string' }
    }
  }
  if (JSON.stringify(raw).length > 8000) return { ok: false, error: 'end_condition is too large' }
  return { ok: true, value: raw as EndCondition }
}

/**
 * "New workflow": a goal, not a definition. Creates the flow (no version yet) and
 * its builder card — the brief carries the goal, the end condition (or a request
 * to propose one), the Tool registry and the workspace's enabled connectors.
 */
async function createFromGoal(req: AuthRequest, res: Response): Promise<void> {
  const body = (req.body ?? {}) as {
    workspace?: unknown; goal?: unknown; name?: unknown; end_condition?: unknown; builder?: unknown; max_iterations?: unknown
  }
  const g = body.goal as { statement?: unknown; end_condition?: unknown } | string
  const statement = typeof g === 'string' ? g : g && typeof g === 'object' && !Array.isArray(g) && typeof g.statement === 'string' ? g.statement : ''
  if (!statement.trim()) {
    res.status(400).json({ error: 'goal must be a non-empty string (or {statement, end_condition?})' })
    return
  }
  if (statement.length > FLOW_GOAL_MAX_CHARS) {
    res.status(400).json({ error: `goal is longer than ${FLOW_GOAL_MAX_CHARS} characters` })
    return
  }
  const ec = parseEndCondition(body.end_condition ?? (typeof g === 'object' ? g?.end_condition : undefined))
  if (!ec.ok) {
    res.status(400).json({ error: ec.error })
    return
  }
  if (body.name !== undefined && (typeof body.name !== 'string' || body.name.length > FLOW_NAME_MAX_CHARS)) {
    res.status(400).json({ error: `name must be a string of at most ${FLOW_NAME_MAX_CHARS} characters` })
    return
  }
  const rawMax = (body.builder as { max_iterations?: unknown } | undefined)?.max_iterations ?? body.max_iterations
  let maxIterations: number | undefined
  if (rawMax !== undefined) {
    const n = Number(rawMax)
    if (!Number.isInteger(n) || n < 1 || n > BUILDER_MAX_ITERATIONS_CAP) {
      res.status(400).json({ error: `builder.max_iterations must be an integer from 1 to ${BUILDER_MAX_ITERATIONS_CAP}` })
      return
    }
    maxIterations = n
  }
  const allowed = allowedWorkspaces(req)
  const workspace =
    (typeof body.workspace === 'string' && body.workspace) ||
    req.sessionFile?.workspace ||
    (allowed !== 'all' && allowed.length === 1 ? allowed[0] : '')
  if (!workspace || !WS_SLUG.test(workspace)) {
    res.status(400).json({ error: 'workspace is required' })
    return
  }
  if (!canAccessWorkspace(req, workspace)) {
    forbidden(res, workspace)
    return
  }
  const db = getDb()
  const actor = actorOf(req)
  const actingUser = req.user && req.user.id > 0 ? req.user.id : null
  const made = await createWorkflowFromGoal(db, {
    workspace, goal: statement.trim(), ...(typeof body.name === 'string' && body.name.trim() ? { name: body.name } : {}),
    endCondition: ec.value, ...(maxIterations ? { maxIterations } : {}), createdBy: actor, createdByUserId: actingUser,
  })
  const obj = db.prepare('SELECT * FROM objectives WHERE id = ?').get(made.objectiveId) as Objective | undefined
  if (obj) broadcast({ type: 'objective_updated', payload: obj })
  try {
    logActivity({
      project: 'flows', workspace, event_type: 'decision',
      title: `New workflow '${made.name}': builder card #${made.objectiveId}`,
      detail: statement.slice(0, 1000),
      metadata: { kind: 'flow_builder_created', flow_id: made.flowId, objective_id: made.objectiveId, actor, max_iterations: made.maxIterations },
    })
  } catch { /* activity is best-effort */ }
  res.status(201).json({
    ok: true,
    flow_id: made.flowId,
    slug: made.slug,
    workspace,
    objective_id: made.objectiveId,
    builder: {
      objective_id: made.objectiveId,
      status: obj?.status ?? 'queue',
      max_iterations: made.maxIterations,
      queue_hold: made.queueHold,
    },
    flow: summarize(db, getFlowRow(db, made.flowId)!),
  })
}

/** Validate okflow/1 JSON without saving it. Free: never counts as a builder iteration. */
router.post('/validate', (req: AuthRequest, res) => {
  const body = (req.body ?? {}) as { definition?: unknown; workspace?: unknown }
  const def = body.definition
  if (!def || typeof def !== 'object' || Array.isArray(def)) {
    res.status(400).json({ error: 'definition (an okflow/1 JSON object) is required' })
    return
  }
  // Pure, but a workspace the caller names must still be one it may touch.
  for (const ws of [body.workspace, (def as { workspace?: unknown }).workspace]) {
    if (typeof ws === 'string' && ws && WS_SLUG.test(ws) && !canAccessWorkspace(req, ws)) {
      forbidden(res, ws)
      return
    }
  }
  // A draft fills a missing version with the next number, so a pre-draft check
  // must not fail on it: validate as version 1 and say so.
  const d = { ...(def as Record<string, unknown>) }
  const defaults_applied: string[] = []
  if (d.version === undefined) {
    d.version = 1
    defaults_applied.push('version')
  }
  // Same options as a stored draft: an unapproved send/spend node is a warning
  // (the publish gate decides), everything else is an error.
  const v = validateFlow(d, { requireApprovals: false })
  res.json({ ok: v.ok, errors: v.errors, warnings: v.warnings, defaults_applied })
})

/**
 * Draft a new version of an existing workflow. `id` and `workspace` default to
 * the flow's own (and must match it when given); `version` defaults to the next
 * number. A refused draft answers 400 with EVERY validation error. An agent's
 * draft (card session or agent key) counts against builder.max_iterations.
 */
router.post('/:id/versions', (req: AuthRequest, res) => {
  const flow = loadFlowFor(req, res)
  if (!flow) return
  if (flow.status === 'archived') {
    res.status(409).json({ error: 'flow_archived', reason: 'flow_archived' })
    return
  }
  const raw = (req.body ?? {}).definition
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    res.status(400).json({ error: 'definition (an okflow/1 JSON object) is required' })
    return
  }
  const db = getDb()
  const d = { ...(raw as FlowDefinition) }
  if (d.id === undefined) d.id = flow.slug
  if (d.workspace === undefined) d.workspace = flow.workspace
  if (d.version === undefined) d.version = (latestFlowVersion(db, flow.id) ?? 0) + 1
  const author = actorOf(req)
  const agent = isAgentAuthor(author)
  if (agent) {
    const st = builderIterationState(db, flow.id)
    if (st.exhausted) {
      res.status(409).json({
        error: `builder_iterations_exhausted: ${st.used} draft(s) since the last green self-test; the limit is ${st.max}. Hand the card to the owner.`,
        reason: 'builder_iterations_exhausted',
        builder: st,
      })
      return
    }
  }
  let saved: ReturnType<typeof saveFlowVersion>
  if (d.id !== flow.slug) saved = { ok: false, reason: 'flow_id_mismatch' }
  else if (d.workspace !== flow.workspace) saved = { ok: false, reason: 'workspace_mismatch' }
  else saved = saveFlowVersion(db, { workspace: flow.workspace, definition: d, author })
  // An identical resubmission of a stored version changes nothing and costs nothing.
  if (agent && !(saved.ok && !saved.created)) {
    recordBuilderAttempt(db, {
      flowId: flow.id, author, ok: saved.ok, version: saved.ok ? saved.version : null,
      errors: saved.ok ? undefined : (saved.errors ?? [{ code: saved.reason }]),
    })
  }
  const builder = agent ? builderIterationState(db, flow.id) : null
  if (!saved.ok) {
    const status = saved.reason === 'version_immutable' ? 409 : 400
    const hint = saved.reason === 'flow_id_mismatch'
      ? `definition.id must be '${flow.slug}'`
      : saved.reason === 'workspace_mismatch' ? `definition.workspace must be '${flow.workspace}'` : undefined
    res.status(status).json({ error: hint ?? saved.reason, reason: saved.reason, errors: saved.errors ?? [], builder })
    return
  }
  const vrow = db.prepare('SELECT validation_json FROM flow_versions WHERE flow_id = ? AND version = ?').get(flow.id, saved.version) as
    | { validation_json: string | null }
    | undefined
  const validation = parse<{ warnings?: unknown[] }>(vrow?.validation_json ?? null)
  try {
    logActivity({
      project: 'flows', workspace: flow.workspace, event_type: 'progress',
      title: `Workflow '${flow.name}' draft v${saved.version}`,
      detail: null,
      metadata: { kind: 'flow_version_drafted', flow_id: flow.id, version: saved.version, actor: author, builder },
    })
  } catch { /* activity is best-effort */ }
  res.status(saved.created ? 201 : 200).json({
    ok: true,
    flow_id: flow.id,
    version: saved.version,
    created: saved.created,
    warnings: validation?.warnings ?? [],
    builder,
    flow: summarize(db, getFlowRow(db, flow.id)!),
  })
})

router.post('/:id/publish', (req: AuthRequest, res) => {
  const flow = loadFlowFor(req, res)
  if (!flow) return
  if (!isCookieAdmin(req)) {
    res.status(403).json({ error: 'Publishing a workflow needs an owner/admin signed in to the web app', code: 'publish_requires_owner' })
    return
  }
  const db = getDb()
  const raw = (req.body ?? {}).version
  const version = raw === undefined ? latestFlowVersion(db, flow.id) : Number(raw)
  if (version == null || !Number.isInteger(version) || version < 1) {
    res.status(400).json({ error: 'version must be a positive integer' })
    return
  }
  // B5 gate: green self-test of THIS version + the owner's approval of exactly
  // its send/spend nodes. The approval is recorded and the version published in
  // one transaction, so a refused publish leaves no approval behind.
  const gate = checkPublishGate(db, {
    flowId: flow.id, version, approve: (req.body ?? {}).approve, approverUserId: req.user!.id, sha256: flowDefinitionSha256,
  })
  if (!gate.ok) {
    const { ok: _ok, status, reason, ...detail } = gate
    res.status(status).json({ error: typeof detail.error === 'string' ? detail.error : reason, ...detail, reason })
    return
  }
  let r: ReturnType<typeof publishFlowVersion>
  try {
    r = db.transaction(() => {
      recordFlowApprovals(db, flow.id, gate.approvals)
      const out = publishFlowVersion(db, { flowId: flow.id, version })
      if (!out.ok) throw Object.assign(new Error(out.reason), { publishResult: out })
      return out
    })()
  } catch (err) {
    const pr = (err as { publishResult?: ReturnType<typeof publishFlowVersion> }).publishResult
    if (!pr || pr.ok) throw err
    res.status(pr.status).json({ error: pr.reason, reason: pr.reason, detail: pr.detail ?? null })
    return
  }
  if (!r.ok) return
  try {
    logActivity({
      project: 'flows', workspace: flow.workspace, event_type: 'decision',
      title: `Workflow '${flow.name}' v${version} published`,
      detail: [
        r.routineId != null ? `schedule routine #${r.routineId}` : 'no schedule trigger',
        gate.approvals.nodes.length ? `owner approved send/spend nodes: ${gate.approvals.nodes.join(', ')}` : 'no send/spend nodes',
        `self-test #${gate.approvals.self_test_id}`,
      ].join('; '),
      metadata: {
        kind: 'flow_published', flow_id: flow.id, version, routine_id: r.routineId, actor: `user:${req.user!.id}`,
        approved_nodes: gate.approvals.nodes, self_test_id: gate.approvals.self_test_id, sha256: gate.approvals.sha256,
      },
    })
  } catch { /* activity is best-effort */ }
  res.json({
    ok: true, flow_id: flow.id, version, routine_id: r.routineId, approvals: gate.approvals,
    flow: summarize(db, getFlowRow(db, flow.id)!),
  })
})

// ── Self-test (B5, §5.2) ────────────────────────────────────────────────────

/**
 * Run a self-test of one version (default: the latest) and answer with the
 * engine's verdict. Any caller who may run the flow may test it — a member, a
 * card session (the builder agent), an admin. `dry` never calls out; `test`
 * reads live and calls the model, so it spends (budget.run_usd still applies).
 * 200 when the verdict is in, 202 while a fixture run waits out a retry backoff
 * (poll GET /:id/tests/:testId). 409 `flows_disabled` while the kill switch is off.
 */
router.post('/:id/test', async (req: AuthRequest, res) => {
  const flow = loadFlowFor(req, res)
  if (!flow) return
  const body = (req.body ?? {}) as { version?: unknown; mode?: unknown; fixtures?: unknown }
  const mode = body.mode === undefined ? 'dry' : body.mode
  if (typeof mode !== 'string' || !(FLOW_SELF_TEST_MODES as readonly string[]).includes(mode)) {
    res.status(400).json({ error: `mode must be one of ${FLOW_SELF_TEST_MODES.join(', ')}` })
    return
  }
  const db = getDb()
  const version = body.version === undefined ? latestFlowVersion(db, flow.id) : Number(body.version)
  if (version == null || !Number.isInteger(version) || version < 1) {
    res.status(400).json({ error: 'version must be a positive integer' })
    return
  }
  const fx = parseFixtures(body.fixtures)
  if (!fx.ok) {
    res.status(400).json({ error: fx.error })
    return
  }
  const requestedBy = actorOf(req)
  let r: Awaited<ReturnType<typeof runSelfTest>>
  try {
    r = await runSelfTest(flowEngineFor(db), {
      flowId: flow.id, version, mode: mode as FlowSelfTestMode, fixtures: fx.fixtures, requestedBy, objectiveId: flow.objective_id,
    })
  } catch (err) {
    console.error('[flows] self-test failed to run:', err)
    res.status(500).json({ error: 'self-test failed to run', detail: err instanceof Error ? err.message : String(err) })
    return
  }
  if (!r.ok) {
    res.status(r.status).json({ error: r.reason, reason: r.reason, detail: r.detail ?? null })
    return
  }
  try {
    logActivity({
      project: 'flows', workspace: flow.workspace, event_type: 'progress',
      title: `Workflow '${flow.name}' v${version} self-test (${mode}): ${r.selfTest.status}`,
      detail: (r.selfTest.result?.failures ?? []).map((f) => f.message).join('; ').slice(0, 1000) || null,
      metadata: { kind: 'flow_self_test', flow_id: flow.id, version, self_test_id: r.selfTest.id, mode, status: r.selfTest.status, actor: requestedBy },
    })
  } catch { /* activity is best-effort */ }
  res.status(r.selfTest.status === 'running' ? 202 : 200).json({ ok: true, self_test: r.selfTest })
})

router.get('/:id/tests', (req: AuthRequest, res) => {
  const flow = loadFlowFor(req, res)
  if (!flow) return
  const raw = req.query.version
  if (raw !== undefined && (typeof raw !== 'string' || !ID.test(raw))) {
    res.status(400).json({ error: 'version must be an integer' })
    return
  }
  res.json({ self_tests: listSelfTests(getDb(), flow.id, raw === undefined ? undefined : Number(raw)) })
})

router.get('/:id/tests/:testId', (req: AuthRequest, res) => {
  const flow = loadFlowFor(req, res)
  if (!flow) return
  const raw = String(req.params.testId ?? '')
  if (!ID.test(raw)) {
    res.status(400).json({ error: 'self-test id must be an integer' })
    return
  }
  const st = getSelfTest(getDb(), Number(raw))
  if (!st || st.flow_id !== flow.id) {
    res.status(404).json({ error: 'Self-test not found' })
    return
  }
  res.json({ self_test: st })
})

router.post('/:id/runs', (req: AuthRequest, res) => {
  const flow = loadFlowFor(req, res)
  if (!flow) return
  const payload = (req.body ?? {}).payload ?? {}
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    res.status(400).json({ error: 'payload must be a JSON object' })
    return
  }
  if (JSON.stringify(payload).length > MAX_PAYLOAD_BYTES) {
    res.status(413).json({ error: `payload larger than ${MAX_PAYLOAD_BYTES} bytes` })
    return
  }
  const db = getDb()
  const r = flowEngineFor(db).startRun({
    flowId: flow.id,
    trigger: { source: 'manual', payload },
    objectiveId: flow.objective_id,
  })
  if (!r.ok) {
    res.status(r.reason === 'flow_not_found' ? 404 : 409).json({ ok: false, reason: r.reason })
    return
  }
  const run = db.prepare('SELECT * FROM flow_runs WHERE id = ?').get(r.runId) as RunRow
  res.status(201).json({ ok: true, run_id: r.runId, run: runSummary(run, flow) })
})

router.get('/:id/runs', (req: AuthRequest, res) => {
  const flow = loadFlowFor(req, res)
  if (!flow) return
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50))
  const rows = getDb().prepare('SELECT * FROM flow_runs WHERE flow_id = ? ORDER BY id DESC LIMIT ?').all(flow.id, limit) as RunRow[]
  res.json({ runs: rows.map((r) => runSummary(r, flow)) })
})

router.get('/:id/runs/:runId', (req: AuthRequest, res) => {
  const flow = loadFlowFor(req, res)
  if (!flow) return
  const rawRun = String(req.params.runId ?? '')
  if (!ID.test(rawRun)) {
    res.status(400).json({ error: 'run id must be an integer' })
    return
  }
  const db = getDb()
  const run = db.prepare('SELECT * FROM flow_runs WHERE id = ? AND flow_id = ?').get(Number(rawRun), flow.id) as RunRow | undefined
  if (!run) {
    res.status(404).json({ error: 'Run not found' })
    return
  }
  const def = loadFlowVersion(db, flow.id, run.version)
  const stepRows = db.prepare(
    `SELECT node_id, iteration, attempt, status, effect, error_json, output_json, input_json, simulated, cost_usd, started_at, ended_at
       FROM flow_step_runs WHERE run_id = ? ORDER BY id`,
  ).all(run.id) as (Omit<FlowStepSummary, 'error' | 'output_preview' | 'input_preview'> & {
    error_json: string | null; output_json: string | null; input_json: string | null
  })[]
  const steps: FlowStepSummary[] = stepRows.map(({ error_json, output_json, input_json, ...s }) => ({
    ...s,
    cost_usd: Number(s.cost_usd) || 0,
    error: parse(redactThenCap(error_json, Number.MAX_SAFE_INTEGER).text),
    output_preview: redactThenCap(output_json, OUTPUT_PREVIEW_CHARS).text,
    simulated: s.simulated ?? null,
    input_preview: redactThenCap(input_json, OUTPUT_PREVIEW_CHARS).text,
  }))
  const overlay = def ? overlayFor(db, flow.id, run.version, def, run) : { node_status: {}, mermaid: '' }
  const body: FlowRunDetailResponse = {
    run: runSummary(run, flow), steps, node_status: overlay.node_status, mermaid: overlay.mermaid, waits: listOpenWaits(db, run.id),
  }
  res.json(body)
})

interface InspectStepRow {
  iteration: number
  attempt: number
  status: string
  effect: string | null
  simulated: string | null
  cost_usd: number
  started_at: string
  ended_at: string | null
  input_json: string | null
  output_json: string | null
  error_json: string | null
}

function pretty(json: string | null): string | null {
  if (json == null) return null
  try { return JSON.stringify(JSON.parse(json), null, 2) } catch { return json }
}

function inspectAttempt(r: InspectStepRow): FlowNodeAttempt {
  const input = redactThenCap(pretty(r.input_json), INSPECT_FIELD_CHARS)
  const output = redactThenCap(pretty(r.output_json), INSPECT_FIELD_CHARS)
  const error = redactThenCap(pretty(r.error_json), INSPECT_FIELD_CHARS)
  return {
    iteration: r.iteration,
    attempt: r.attempt,
    status: r.status,
    effect: r.effect,
    simulated: r.simulated ?? null,
    cost_usd: Number(r.cost_usd) || 0,
    started_at: r.started_at,
    ended_at: r.ended_at,
    input: input.text,
    output: output.text,
    error: error.text,
    truncated: input.truncated || output.truncated || error.truncated,
  }
}

const INSPECT_COLUMNS = 'iteration, attempt, status, effect, simulated, cost_usd, started_at, ended_at, input_json, output_json, error_json'

function inspectNode(
  db: Database.Database,
  flow: FlowRow,
  version: number,
  run: RunRow | null,
  nodeId: string,
): FlowNodeInspectResponse | null {
  const def = loadFlowVersion(db, flow.id, version)
  const node = def?.nodes?.find((n) => n && n.id === nodeId) ?? null
  const attempt_count = run
    ? (db.prepare('SELECT COUNT(*) n FROM flow_step_runs WHERE run_id = ? AND node_id = ?').get(run.id, nodeId) as { n: number }).n
    : 0
  if (!node && attempt_count === 0) return null
  const rows = run
    ? (db.prepare(
        `SELECT ${INSPECT_COLUMNS} FROM flow_step_runs WHERE run_id = ? AND node_id = ? ORDER BY id DESC LIMIT ?`,
      ).all(run.id, nodeId, INSPECT_MAX_ATTEMPTS) as InspectStepRow[]).reverse()
    : []
  let status: FlowNodeInspectResponse['status'] = null
  if (run) {
    const all = db.prepare('SELECT node_id, iteration, attempt, status FROM flow_step_runs WHERE run_id = ?').all(run.id) as
      { node_id: string; iteration: number; attempt: number; status: string }[]
    status = nodeStatusFromSteps(all, run.status, (def?.nodes ?? []).map((n) => n.id))[nodeId] ?? null
  }
  const good = db.prepare(
    `SELECT s.run_id, r.version, ${INSPECT_COLUMNS.split(', ').map((c) => `s.${c}`).join(', ')}
       FROM flow_step_runs s JOIN flow_runs r ON r.id = s.run_id
      WHERE r.flow_id = ? AND r.mode = 'live' AND s.run_id != ? AND s.node_id = ? AND s.status = 'succeeded'
      ORDER BY s.run_id DESC, s.id DESC LIMIT 1`,
  ).get(flow.id, run?.id ?? -1, nodeId) as (InspectStepRow & { run_id: number; version: number }) | undefined
  return {
    run_id: run?.id ?? null,
    version,
    node_id: nodeId,
    kind: node ? node.kind : null,
    config: node ? redactThenCap(JSON.stringify(node, null, 2), INSPECT_FIELD_CHARS).text : null,
    status,
    attempts: rows.map(inspectAttempt),
    attempt_count,
    last_good: good ? { run_id: good.run_id, version: good.version, attempt: inspectAttempt(good) } : null,
  }
}

/**
 * Click-to-inspect (B7, §6.2): one node of one run — its config, its attempts
 * and the same node in the last good run. Same workspace filter as every other
 * flow route; every text field is redacted at READ time before it is capped.
 */
router.get('/:id/runs/:runId/nodes/:nodeId', (req: AuthRequest, res) => {
  const flow = loadFlowFor(req, res)
  if (!flow) return
  const rawRun = String(req.params.runId ?? '')
  const nodeId = String(req.params.nodeId ?? '')
  if (!ID.test(rawRun)) {
    res.status(400).json({ error: 'run id must be an integer' })
    return
  }
  if (!NODE_ID.test(nodeId)) {
    res.status(400).json({ error: 'node id is not a valid okflow node id' })
    return
  }
  const db = getDb()
  const run = db.prepare('SELECT * FROM flow_runs WHERE id = ? AND flow_id = ?').get(Number(rawRun), flow.id) as RunRow | undefined
  if (!run) {
    res.status(404).json({ error: 'Run not found' })
    return
  }
  const body = inspectNode(db, flow, run.version, run, nodeId)
  if (!body) {
    res.status(404).json({ error: 'Node not found in this run' })
    return
  }
  res.json(body)
})

/** The same panel for a version with no run selected: config + last good run only. */
router.get('/:id/nodes/:nodeId', (req: AuthRequest, res) => {
  const flow = loadFlowFor(req, res)
  if (!flow) return
  const nodeId = String(req.params.nodeId ?? '')
  if (!NODE_ID.test(nodeId)) {
    res.status(400).json({ error: 'node id is not a valid okflow node id' })
    return
  }
  const db = getDb()
  const requested = req.query.version
  if (requested !== undefined && (typeof requested !== 'string' || !ID.test(requested))) {
    res.status(400).json({ error: 'version must be an integer' })
    return
  }
  const version = requested !== undefined ? Number(requested) : flow.published_version ?? latestFlowVersion(db, flow.id)
  const body = version != null ? inspectNode(db, flow, version, null, nodeId) : null
  if (!body) {
    res.status(404).json({ error: 'Node not found in this version' })
    return
  }
  res.json(body)
})

// ── Waits (B9): approval clicks, unknown-outcome confirms, events ───────────

/** Load :runId of the flow already loaded by loadFlowFor. Responds and returns null on failure. */
function loadRunFor(req: AuthRequest, res: Response, flow: FlowRow): RunRow | null {
  const raw = String(req.params.runId ?? '')
  if (!ID.test(raw)) {
    res.status(400).json({ error: 'run id must be an integer' })
    return null
  }
  const run = getDb().prepare('SELECT * FROM flow_runs WHERE id = ? AND flow_id = ?').get(Number(raw), flow.id) as RunRow | undefined
  if (!run) {
    res.status(404).json({ error: 'Run not found' })
    return null
  }
  return run
}

const OWNER_ONLY = 'Approving a workflow step needs an owner/admin signed in to the web app'

/**
 * The per-run approval of §5.4: the same principal as publish — a cookie owner/admin,
 * never an agent key, a card session or a bearer token. Approve continues the run;
 * reject fails it with `approval_rejected`. The engine tick picks the run up.
 */
router.post('/:id/runs/:runId/approval', (req: AuthRequest, res) => {
  const flow = loadFlowFor(req, res)
  if (!flow) return
  if (!isCookieAdmin(req)) {
    res.status(403).json({ error: OWNER_ONLY, code: 'approval_requires_owner' })
    return
  }
  const run = loadRunFor(req, res, flow)
  if (!run) return
  const b = (req.body ?? {}) as { decision?: unknown; node_id?: unknown; iteration?: unknown; note?: unknown }
  if (b.decision !== 'approve' && b.decision !== 'reject') {
    res.status(400).json({ error: "decision must be 'approve' or 'reject'" })
    return
  }
  if (b.node_id !== undefined && typeof b.node_id !== 'string') {
    res.status(400).json({ error: 'node_id must be a string' })
    return
  }
  if (b.iteration !== undefined && (!Number.isInteger(b.iteration) || (b.iteration as number) < 0)) {
    res.status(400).json({ error: 'iteration must be a non-negative integer' })
    return
  }
  const db = getDb()
  const by = `user:${req.user!.id}`
  const r = flowEngineFor(db).resolveApproval({
    runId: run.id, decision: b.decision, by,
    ...(typeof b.node_id === 'string' ? { nodeId: b.node_id } : {}),
    ...(typeof b.iteration === 'number' ? { iteration: b.iteration } : {}),
    ...(typeof b.note === 'string' ? { note: b.note } : {}),
  })
  if (!r.ok) {
    res.status(r.reason === 'ambiguous_approval' ? 400 : 409).json({ error: r.reason, reason: r.reason, waits: listOpenWaits(db, run.id) })
    return
  }
  try {
    logActivity({
      project: 'flows', workspace: flow.workspace, event_type: 'decision',
      title: `Workflow '${flow.name}' run #${run.id}: ${b.decision === 'approve' ? 'approved' : 'rejected'}${typeof b.node_id === 'string' ? ` "${b.node_id}"` : ''}`,
      detail: typeof b.note === 'string' && b.note.trim() ? b.note.trim().slice(0, 1000) : null,
      metadata: { kind: `flow_run_${b.decision === 'approve' ? 'approved' : 'rejected'}`, flow_id: flow.id, run_id: run.id, node_id: b.node_id ?? null, actor: by },
    })
  } catch { /* activity is best-effort */ }
  const fresh = db.prepare('SELECT * FROM flow_runs WHERE id = ?').get(run.id) as RunRow
  res.json({ ok: true, run: runSummary(fresh, flow), waits: listOpenWaits(db, run.id) })
})

/** "Unknown outcome, confirm" (B2 §4.3.2): the owner says whether the in-flight send/spend happened. */
router.post('/:id/runs/:runId/outcome', (req: AuthRequest, res) => {
  const flow = loadFlowFor(req, res)
  if (!flow) return
  if (!isCookieAdmin(req)) {
    res.status(403).json({ error: OWNER_ONLY, code: 'approval_requires_owner' })
    return
  }
  const run = loadRunFor(req, res, flow)
  if (!run) return
  const b = (req.body ?? {}) as { node_id?: unknown; outcome?: unknown }
  if (typeof b.node_id !== 'string' || !b.node_id) {
    res.status(400).json({ error: 'node_id is required' })
    return
  }
  if (b.outcome !== 'sent' && b.outcome !== 'not_sent') {
    res.status(400).json({ error: "outcome must be 'sent' or 'not_sent'" })
    return
  }
  const db = getDb()
  const by = `user:${req.user!.id}`
  const r = flowEngineFor(db).resolveUnknownOutcome({ runId: run.id, nodeId: b.node_id, outcome: b.outcome, by })
  if (!r.ok) {
    res.status(409).json({ error: r.reason, reason: r.reason })
    return
  }
  try {
    logActivity({
      project: 'flows', workspace: flow.workspace, event_type: 'decision',
      title: `Workflow '${flow.name}' run #${run.id}: "${b.node_id}" confirmed ${b.outcome === 'sent' ? 'sent' : 'not sent'}`,
      detail: null,
      metadata: { kind: 'flow_unknown_outcome_resolved', flow_id: flow.id, run_id: run.id, node_id: b.node_id, outcome: b.outcome, actor: by },
    })
  } catch { /* activity is best-effort */ }
  const fresh = db.prepare('SELECT * FROM flow_runs WHERE id = ?').get(run.id) as RunRow
  res.json({ ok: true, run: runSummary(fresh, flow) })
})

const EVENT_NAME = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/

/**
 * Release `wait.event` nodes listening for `event` in this flow's runs (or one
 * run). Anyone who may run the flow may send it an event — a member, a card
 * session, an admin; the workspace filter is loadFlowFor's. Not an approval: a
 * send/spend node still needs an approval wait or the owner's publish approval.
 */
router.post('/:id/events', (req: AuthRequest, res) => {
  const flow = loadFlowFor(req, res)
  if (!flow) return
  const b = (req.body ?? {}) as { event?: unknown; payload?: unknown; run_id?: unknown }
  if (typeof b.event !== 'string' || !EVENT_NAME.test(b.event)) {
    res.status(400).json({ error: 'event must be a name like order.paid (letters, digits, _ . : -)' })
    return
  }
  if (b.run_id !== undefined && (!Number.isInteger(b.run_id) || (b.run_id as number) < 1)) {
    res.status(400).json({ error: 'run_id must be a positive integer' })
    return
  }
  if (b.payload !== undefined && JSON.stringify(b.payload).length > MAX_PAYLOAD_BYTES) {
    res.status(413).json({ error: `payload larger than ${MAX_PAYLOAD_BYTES} bytes` })
    return
  }
  const by = req.sessionFile ? `agent:${req.sessionFile.objectiveId}` : `user:${req.user!.id}`
  const r = flowEngineFor(getDb()).deliverEvent({
    flowId: flow.id, event: b.event, payload: b.payload ?? null, by,
    ...(typeof b.run_id === 'number' ? { runId: b.run_id } : {}),
  })
  res.json({ ok: true, ...r })
})

// ── Auto-debug repairs (card B8, §5.3) ────────────────────────────────────────

/** The watcher the engine tick drives; a write-capable one on this DB when the host engine is not armed. */
function repairWatcher(db: Database.Database): FlowRepairWatcher {
  const host = getHostRepairWatcher()
  if (host && host.db === db) return host
  return new FlowRepairWatcher({ engine: flowEngineFor(db) })
}

function repairView(db: Database.Database, r: FlowRepairRow) {
  const base = loadFlowVersion(db, r.flow_id, r.base_version)
  const draft = r.draft_version != null ? loadFlowVersion(db, r.flow_id, r.draft_version) : null
  const err = parse<{ type?: unknown; title?: unknown; node_id?: unknown }>(r.error_json)
  return {
    id: r.id,
    flow_id: r.flow_id,
    workspace: r.workspace,
    run_id: r.run_id,
    base_version: r.base_version,
    status: r.status,
    reason: r.reason,
    detail: r.detail ? redactLive(r.detail).text : null,
    signature: r.signature,
    failed_node_id: r.failed_node_id,
    definition_rot: !!r.definition_rot,
    error: err ? { type: String(err.type ?? 'error'), title: redactLive(String(err.title ?? '')).text, node_id: typeof err.node_id === 'string' ? err.node_id : null } : null,
    objective_id: r.objective_id,
    review_objective_id: r.review_objective_id,
    repair_usd: r.repair_usd,
    drafts: r.drafts,
    drafts_max: REPAIR_DEFAULTS.maxDrafts,
    draft_version: r.draft_version,
    patch: parse<unknown[]>(r.patch_json),
    explanation: r.explanation ? redactLive(r.explanation).text : null,
    diff: base && draft ? diffFlowNodes(base, draft) : null,
    classification: parse<RepairClassification>(r.classification_json),
    replay: parse<RepairReplaySummary>(r.replay_json),
    nodes_requiring_approval: draft ? nodesRequiringApproval(draft) : [],
    applied_version: r.applied_version,
    rerun_run_id: r.rerun_run_id,
    rerun_note: r.rerun_note,
    resolved_by: r.resolved_by,
    created_at: r.created_at,
    updated_at: r.updated_at,
    resolved_at: r.resolved_at,
  }
}

function loadRepairFor(req: AuthRequest, res: Response, flow: FlowRow): FlowRepairRow | null {
  const raw = String(req.params.repairId ?? '')
  if (!ID.test(raw)) {
    res.status(400).json({ error: 'repair id must be an integer' })
    return null
  }
  const r = getDb().prepare('SELECT * FROM flow_repairs WHERE id = ? AND flow_id = ?').get(Number(raw), flow.id) as FlowRepairRow | undefined
  if (!r) {
    res.status(404).json({ error: 'Repair not found' })
    return null
  }
  return r
}

router.get('/:id/repairs', (req: AuthRequest, res) => {
  const flow = loadFlowFor(req, res)
  if (!flow) return
  const db = getDb()
  const rows = db.prepare('SELECT * FROM flow_repairs WHERE flow_id = ? ORDER BY id DESC LIMIT 50').all(flow.id) as FlowRepairRow[]
  res.json({ repairs: rows.map((r) => repairView(db, r)) })
})

router.get('/:id/repairs/:repairId', (req: AuthRequest, res) => {
  const flow = loadFlowFor(req, res)
  if (!flow) return
  const r = loadRepairFor(req, res, flow)
  if (!r) return
  res.json({ repair: repairView(getDb(), r) })
})

router.post('/:id/repairs/:repairId/draft', async (req: AuthRequest, res) => {
  const flow = loadFlowFor(req, res)
  if (!flow) return
  const r = loadRepairFor(req, res, flow)
  if (!r) return
  // Only the repair card's own session drafts a repair. A person edits the workflow
  // through the normal versions/publish path; an agent key never reaches this route.
  if (!req.sessionFile || r.objective_id == null || req.sessionFile.objectiveId !== r.objective_id) {
    res.status(403).json({ error: 'only the repair card\'s own session may draft this repair', code: 'not_repair_card' })
    return
  }
  const db = getDb()
  const out = await repairWatcher(db).submitDraft(r.id, { patch: (req.body ?? {}).patch, explanation: (req.body ?? {}).explanation })
  if (!out.ok) {
    res.status(out.status).json({ error: out.error, reason: out.reason, errors: out.errors ?? [], ...(out.result ? { result: out.result } : {}) })
    return
  }
  res.status(200).json({ ok: true, result: out.result, repair: repairView(db, repairWatcher(db).getRepair(r.id)!) })
})

router.post('/:id/repairs/:repairId/approve', (req: AuthRequest, res) => {
  const flow = loadFlowFor(req, res)
  if (!flow) return
  if (!isCookieAdmin(req)) {
    res.status(403).json({ error: 'Only the signed-in owner/admin can approve a repair', code: 'owner_cookie_required' })
    return
  }
  const r = loadRepairFor(req, res, flow)
  if (!r) return
  const db = getDb()
  const out = repairWatcher(db).approve(r.id, { userId: req.user!.id, approve: (req.body ?? {}).approve })
  if (!out.ok) {
    const { status, ...body } = out
    res.status(status).json(body)
    return
  }
  try {
    logActivity({
      project: 'flows', workspace: flow.workspace, event_type: 'decision',
      title: `Workflow '${flow.name}': repair #${r.id} approved as v${out.repair.applied_version}`, detail: null,
      metadata: { kind: 'flow_repair_approved', flow_id: flow.id, repair_id: r.id, actor: `user:${req.user!.id}` },
    })
  } catch { /* activity is best-effort */ }
  res.json({ ok: true, repair: repairView(db, out.repair) })
})

router.post('/:id/repairs/:repairId/reject', (req: AuthRequest, res) => {
  const flow = loadFlowFor(req, res)
  if (!flow) return
  if (!isCookieAdmin(req)) {
    res.status(403).json({ error: 'Only the signed-in owner/admin can reject a repair', code: 'owner_cookie_required' })
    return
  }
  const r = loadRepairFor(req, res, flow)
  if (!r) return
  const db = getDb()
  const out = repairWatcher(db).reject(r.id, { userId: req.user!.id, note: (req.body ?? {}).note })
  if (!out.ok) {
    res.status(out.status).json({ error: out.error, reason: out.reason })
    return
  }
  res.json({ ok: true, repair: repairView(db, out.repair) })
})

export default router
