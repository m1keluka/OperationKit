/**
 * Workflow self-test + publish gate (obj 900641, card B5 of docs/design/WORKFLOWS.md
 * §5.2 and §5.4).
 *
 * A SELF-TEST runs one version once per fixture (trigger payload) in mode `dry`
 * (nothing calls out: mocks, schema stubs, "would send …") or `test` (read tools,
 * read mcp calls and llm nodes run live; write/send/spend stay stubbed). The
 * ENGINE — never the agent that wrote the flow — then decides whether it passed:
 *
 *   - every fixture run SUCCEEDED;
 *   - every deterministic `goal.end_condition.assert` is true on every fixture run;
 *   - in a `test` self-test, a declared `judge` PASSED (a dry run never asks it);
 *   - every node completed on at least one fixture (branch / loop coverage);
 *   - each run stayed under `budget.run_usd`.
 *
 * The verdict is stored on `flow_self_tests` and, when green, a run of it is
 * linked as `flow_versions.self_test_run_id`. "No green self-test, no publish."
 *
 * PUBLISH GATE (checkPublishGate): who may call it is the route's job (a cookie
 * owner/admin only). This gate adds: a valid definition, mocks on every
 * write/send/spend node, the LATEST self-test of this exact version green, and
 * the owner's explicit approval of EXACTLY the send/spend node set (the nodes no
 * approval `wait` guards). The approval is recorded in
 * `flow_versions.approvals_json` with the version, the node set, the approver,
 * the time, the definition SHA-256 and the self-test id. That record — never an
 * `approvals` block typed into the definition — is what the engine honours.
 *
 * DB-injected; imports only TYPES from flow-engine (the engine imports
 * finalizeSelfTest from here, so a runtime import back would be a cycle).
 */
import type Database from 'better-sqlite3'
import type { FlowApprovals, FlowDefinition, FlowFixture } from '../../../shared/flow/types.js'
import { MAX_FLOW_FIXTURES } from '../../../shared/flow/types.js'
import type {
  FlowFailingAssert, FlowGoalResult, FlowSelfTest, FlowSelfTestFailure, FlowSelfTestFixtureResult, FlowSelfTestResult,
  FlowSimulatedStep,
} from '../../../shared/flow/api.js'
import { validateFlow } from '../../../shared/flow/validate.js'
import {
  effectiveFixtures, nodesMissingMocks, nodesRequiringApproval, type FlowSelfTestMode,
} from '../../../shared/flow/self-test.js'
import { initFlowSchema } from '../db/schema/flow.js'
import type { FlowEngine } from './flow-engine.js'

/** Self-test modes a publish accepts. See the PR notes: §5.2 names `test`; `dry` is accepted too until the okit Tool runner lands. */
export const PUBLISH_SELF_TEST_MODES: readonly FlowSelfTestMode[] = ['dry', 'test']
export const MAX_FIXTURE_PAYLOAD_BYTES = 64 * 1024
const PREVIEW_CHARS = 2000

interface SelfTestRow {
  id: number
  flow_id: number
  version: number
  mode: 'dry' | 'test'
  status: 'running' | 'passed' | 'failed'
  fixtures_json: string
  result_json: string | null
  requested_by: string
  created_at: string
  ended_at: string | null
}

interface RunRow {
  id: number
  status: string
  goal_met: number | null
  goal_json: string | null
  error_json: string | null
  trigger_json: string | null
  spent_usd: number
}

const parse = <T>(s: string | null | undefined): T | null => {
  if (!s) return null
  try { return JSON.parse(s) as T } catch { return null }
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

function loadVersion(db: Database.Database, flowId: number, version: number): FlowDefinition | null {
  const row = db.prepare('SELECT definition_json FROM flow_versions WHERE flow_id = ? AND version = ?').get(flowId, version) as
    | { definition_json: string }
    | undefined
  return row ? parse<FlowDefinition>(row.definition_json) : null
}

function toSelfTest(db: Database.Database, row: SelfTestRow): FlowSelfTest {
  const runIds = (db.prepare('SELECT id FROM flow_runs WHERE self_test_id = ? ORDER BY id').all(row.id) as { id: number }[]).map((r) => r.id)
  return {
    id: row.id,
    flow_id: row.flow_id,
    version: row.version,
    mode: row.mode,
    status: row.status,
    requested_by: row.requested_by,
    created_at: row.created_at,
    ended_at: row.ended_at,
    run_ids: runIds,
    result: parse<FlowSelfTestResult>(row.result_json),
  }
}

export function getSelfTest(db: Database.Database, id: number): FlowSelfTest | null {
  initFlowSchema(db)
  const row = db.prepare('SELECT * FROM flow_self_tests WHERE id = ?').get(id) as SelfTestRow | undefined
  return row ? toSelfTest(db, row) : null
}

/** The latest self-test of one version — the one the publish gate reads. */
export function latestSelfTest(db: Database.Database, flowId: number, version: number): FlowSelfTest | null {
  initFlowSchema(db)
  const row = db.prepare('SELECT * FROM flow_self_tests WHERE flow_id = ? AND version = ? ORDER BY id DESC LIMIT 1').get(flowId, version) as
    | SelfTestRow
    | undefined
  return row ? toSelfTest(db, row) : null
}

export function listSelfTests(db: Database.Database, flowId: number, version?: number, limit = 20): FlowSelfTest[] {
  initFlowSchema(db)
  const rows = (version === undefined
    ? db.prepare('SELECT * FROM flow_self_tests WHERE flow_id = ? ORDER BY id DESC LIMIT ?').all(flowId, limit)
    : db.prepare('SELECT * FROM flow_self_tests WHERE flow_id = ? AND version = ? ORDER BY id DESC LIMIT ?').all(flowId, version, limit)) as SelfTestRow[]
  return rows.map((r) => toSelfTest(db, r))
}

/** Validate request-supplied fixtures: [{ name, payload }], ≤ MAX_FLOW_FIXTURES, unique names, object payloads. */
export function parseFixtures(raw: unknown): { ok: true; fixtures: FlowFixture[] | null } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, fixtures: null }
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_FLOW_FIXTURES) {
    return { ok: false, error: `fixtures must be a list of 1..${MAX_FLOW_FIXTURES} { name, payload } objects` }
  }
  const names = new Set<string>()
  const out: FlowFixture[] = []
  for (const [i, f] of raw.entries()) {
    if (!isObj(f) || typeof f.name !== 'string' || !f.name.trim()) return { ok: false, error: `fixtures[${i}].name must be a non-empty string` }
    if (names.has(f.name)) return { ok: false, error: `fixture name "${f.name}" is used twice` }
    names.add(f.name)
    if (f.payload !== undefined && !isObj(f.payload)) return { ok: false, error: `fixtures[${i}].payload must be a JSON object` }
    if (JSON.stringify(f.payload ?? {}).length > MAX_FIXTURE_PAYLOAD_BYTES) return { ok: false, error: `fixtures[${i}].payload is larger than ${MAX_FIXTURE_PAYLOAD_BYTES} bytes` }
    out.push({ name: f.name, payload: (f.payload as Record<string, unknown> | undefined) ?? {} })
  }
  return { ok: true, fixtures: out }
}

export type RunSelfTestResult =
  | { ok: true; selfTest: FlowSelfTest }
  | { ok: false; status: number; reason: string; detail?: unknown }

/**
 * Start a self-test of one version and execute its fixture runs now, one after
 * another (the per-flow concurrency cap stays meaningful). Returns the stored
 * self-test: terminal in the normal case, `running` when a run is waiting out a
 * retry backoff — the engine tick finishes it and finalizes the verdict.
 */
export async function runSelfTest(
  engine: FlowEngine,
  args: { flowId: number; version: number; mode: FlowSelfTestMode; fixtures?: FlowFixture[] | null; requestedBy: string; objectiveId?: number | null },
): Promise<RunSelfTestResult> {
  const db = engine.db
  initFlowSchema(db)
  const def = loadVersion(db, args.flowId, args.version)
  if (!def) return { ok: false, status: 404, reason: 'version_not_found' }
  const v = validateFlow(def, { requireApprovals: false })
  if (!v.ok) return { ok: false, status: 409, reason: 'invalid_definition', detail: v.errors }
  const fixtures = effectiveFixtures(def, args.fixtures)
  // startRun refuses while the kill switch is off; check first so no orphan self-test row is left.
  const probe = db.prepare("SELECT value FROM settings WHERE key = 'flows_enabled'").get() as { value: string } | undefined
  if (probe?.value !== '1') return { ok: false, status: 409, reason: 'flows_disabled' }

  const st = Number(db.prepare(
    'INSERT INTO flow_self_tests (flow_id, version, mode, fixtures_json, requested_by) VALUES (?, ?, ?, ?, ?)',
  ).run(args.flowId, args.version, args.mode, JSON.stringify(fixtures), args.requestedBy).lastInsertRowid)

  const runIds: number[] = []
  for (const fx of fixtures) {
    const r = engine.startRun({
      flowId: args.flowId,
      version: args.version,
      mode: args.mode,
      trigger: { source: 'self_test', payload: fx.payload ?? {}, fixture: fx.name } as { source: string; payload: unknown },
      objectiveId: args.objectiveId ?? null,
      selfTestId: st,
    })
    if (!r.ok) {
      const failure: FlowSelfTestFailure = { code: 'start_failed', message: `fixture "${fx.name}" could not start: ${r.reason}`, fixture: fx.name }
      const result: FlowSelfTestResult = { passed: false, fixtures: [], uncovered_nodes: [], failing_asserts: [], failures: [failure] }
      db.prepare("UPDATE flow_self_tests SET status = 'failed', result_json = ?, ended_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?")
        .run(JSON.stringify(result), st)
      // Runs already queued for earlier fixtures are cancelled so they never execute.
      if (runIds.length) {
        db.prepare(`UPDATE flow_runs SET status = 'cancelled', ended_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id IN (${runIds.map(() => '?').join(',')}) AND status = 'queued'`)
          .run(...runIds)
      }
      return r.reason === 'flows_disabled'
        ? { ok: false, status: 409, reason: 'flows_disabled' }
        : { ok: true, selfTest: getSelfTest(db, st)! }
    }
    runIds.push(r.runId)
  }
  for (const id of runIds) await engine.runNow(id)
  finalizeSelfTest(db, st)
  return { ok: true, selfTest: getSelfTest(db, st)! }
}

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled'])

/**
 * Judge a self-test once every fixture run is terminal. Idempotent: a terminal
 * self-test is never re-judged. Called by the engine as each run finishes and
 * by runSelfTest at the end.
 */
export function finalizeSelfTest(db: Database.Database, selfTestId: number, nowIso?: string): void {
  const st = db.prepare('SELECT * FROM flow_self_tests WHERE id = ?').get(selfTestId) as SelfTestRow | undefined
  if (!st || st.status !== 'running') return
  const runs = db.prepare(
    'SELECT id, status, goal_met, goal_json, error_json, trigger_json, spent_usd FROM flow_runs WHERE self_test_id = ? ORDER BY id',
  ).all(selfTestId) as RunRow[]
  const expected = (parse<FlowFixture[]>(st.fixtures_json) ?? []).length
  if (runs.length < expected || runs.some((r) => !TERMINAL.has(r.status))) return

  const def = loadVersion(db, st.flow_id, st.version)
  const result = judgeSelfTest(db, st.mode, def, runs)
  const now = nowIso ?? new Date().toISOString()
  db.prepare("UPDATE flow_self_tests SET status = ?, result_json = ?, ended_at = ? WHERE id = ? AND status = 'running'")
    .run(result.passed ? 'passed' : 'failed', JSON.stringify(result), now, selfTestId)
  // self_test_run_id always points at a run of the version's CURRENT green self-test (or nothing).
  db.prepare('UPDATE flow_versions SET self_test_run_id = ? WHERE flow_id = ? AND version = ?')
    .run(result.passed && runs.length ? runs[0].id : null, st.flow_id, st.version)
}

function judgeSelfTest(db: Database.Database, mode: 'dry' | 'test', def: FlowDefinition | null, runs: RunRow[]): FlowSelfTestResult {
  const failures: FlowSelfTestFailure[] = []
  const failingAsserts: FlowFailingAssert[] = []
  const covered = new Set<string>()
  const fixtures: FlowSelfTestFixtureResult[] = []
  const runUsd = def?.budget?.run_usd

  for (const run of runs) {
    const trig = parse<{ fixture?: unknown }>(run.trigger_json)
    const name = typeof trig?.fixture === 'string' ? trig.fixture : `run ${run.id}`
    const goal = parse<FlowGoalResult>(run.goal_json)
    const err = parse<{ type?: unknown; title?: unknown; node_id?: unknown }>(run.error_json)
    const steps = db.prepare(
      'SELECT node_id, iteration, status, effect, simulated, input_json FROM flow_step_runs WHERE run_id = ? ORDER BY id',
    ).all(run.id) as { node_id: string; iteration: number; status: string; effect: string | null; simulated: string | null; input_json: string | null }[]
    const simulated: FlowSimulatedStep[] = []
    for (const s of steps) {
      if (s.status === 'succeeded') covered.add(s.node_id)
      if (s.simulated && s.simulated.startsWith('would_')) {
        simulated.push({
          node_id: s.node_id, iteration: s.iteration, effect: s.effect, simulated: s.simulated,
          input_preview: s.input_json ? s.input_json.slice(0, PREVIEW_CHARS) : null,
        })
      }
    }
    fixtures.push({
      name,
      run_id: run.id,
      status: run.status,
      goal_met: run.goal_met,
      goal,
      error: err ? {
        type: typeof err.type === 'string' ? err.type : 'error',
        title: typeof err.title === 'string' ? err.title : '',
        ...(typeof err.node_id === 'string' ? { node_id: err.node_id } : {}),
      } : null,
      spent_usd: Number(run.spent_usd) || 0,
      simulated,
    })

    if (run.status !== 'succeeded') {
      const where = err && typeof err.node_id === 'string' ? ` at "${err.node_id}"` : ''
      failures.push({ code: 'run_failed', fixture: name, message: `fixture "${name}" run ${run.status}${where}: ${typeof err?.title === 'string' ? err.title : 'no detail'}` })
      continue
    }
    for (const a of goal?.asserts ?? []) {
      if (a.passed) continue
      failingAsserts.push({ fixture: name, run_id: run.id, expr: a.expr, ...(a.why ? { why: a.why } : {}), ...(a.error ? { error: a.error } : {}) })
    }
    if (!goal || goal.asserts.some((a) => !a.passed)) {
      failures.push({ code: 'goal_not_met', fixture: name, message: `fixture "${name}": end condition not met` })
    }
    if (goal?.judge) {
      if (goal.judge.status === 'failed' || goal.judge.status === 'error') {
        failures.push({ code: 'judge_failed', fixture: name, message: `fixture "${name}": judge ${goal.judge.status} — ${goal.judge.reason}` })
      } else if (mode === 'test' && goal.judge.status === 'skipped' && goal.asserts.every((a) => a.passed)) {
        failures.push({ code: 'judge_not_evaluated', fixture: name, message: `fixture "${name}": the judge was not evaluated (${goal.judge.reason})` })
      }
    }
    if (typeof runUsd === 'number' && Number(run.spent_usd) > runUsd) {
      failures.push({ code: 'over_budget', fixture: name, message: `fixture "${name}" spent $${Number(run.spent_usd).toFixed(4)} over budget.run_usd $${runUsd.toFixed(4)}` })
    }
  }

  const uncovered = (def?.nodes ?? []).map((n) => n.id).filter((id) => !covered.has(id))
  // Coverage only means something when every fixture ran to the end.
  if (uncovered.length && runs.every((r) => r.status === 'succeeded')) {
    failures.push({
      code: 'uncovered_nodes',
      node_ids: uncovered,
      message: `no fixture completed ${uncovered.map((u) => `"${u}"`).join(', ')} — add a fixture that reaches ${uncovered.length === 1 ? 'it' : 'them'}`,
    })
  }
  return { passed: failures.length === 0, fixtures, uncovered_nodes: uncovered, failing_asserts: failingAsserts, failures }
}

// ── Publish gate (§5.4) ─────────────────────────────────────────────────────

export type PublishGateResult =
  | { ok: true; approvals: FlowApprovals; definition: FlowDefinition }
  | { ok: false; status: number; reason: string; [detail: string]: unknown }

/**
 * Everything a publish needs besides WHO is asking (the route enforces a cookie
 * owner/admin). `approve` is the owner's list of approved send/spend node ids
 * and must equal the set that needs approval — exactly, no more and no less.
 */
export function checkPublishGate(
  db: Database.Database,
  args: { flowId: number; version: number; approve: unknown; approverUserId: number; sha256: (d: FlowDefinition) => string; now?: string },
): PublishGateResult {
  initFlowSchema(db)
  const def = loadVersion(db, args.flowId, args.version)
  if (!def) return { ok: false, status: 404, reason: 'version_not_found' }
  const v = validateFlow(def, { requireApprovals: false })
  if (!v.ok) return { ok: false, status: 409, reason: 'invalid_definition', errors: v.errors }

  const missingMocks = nodesMissingMocks(def)
  if (missingMocks.length) {
    return {
      ok: false, status: 409, reason: 'mocks_missing', nodes: missingMocks,
      error: `every write/send/spend node needs a mock before publish: ${missingMocks.join(', ')}`,
    }
  }

  const st = latestSelfTest(db, args.flowId, args.version)
  if (!st) return { ok: false, status: 409, reason: 'self_test_required', error: `version ${args.version} has no self-test; POST /api/flows/${args.flowId}/test first` }
  if (st.status === 'running') return { ok: false, status: 409, reason: 'self_test_running', self_test_id: st.id }
  if (st.status !== 'passed' || !st.result?.passed) {
    const fa = st.result?.failing_asserts ?? []
    return {
      ok: false, status: 409, reason: 'self_test_failed', self_test_id: st.id,
      error: fa.length
        ? `the end condition failed: ${fa.map((a) => `${a.expr}${a.why ? ` (${a.why})` : ''} on fixture "${a.fixture}"`).join('; ')}`
        : `the latest self-test of version ${args.version} failed: ${(st.result?.failures ?? []).map((f) => f.message).join('; ')}`,
      failing_asserts: fa,
      failures: st.result?.failures ?? [],
    }
  }
  if (!PUBLISH_SELF_TEST_MODES.includes(st.mode)) return { ok: false, status: 409, reason: 'self_test_mode_not_accepted', self_test_id: st.id }

  const need = nodesRequiringApproval(def)
  let approved: string[] = []
  if (need.length) {
    if (args.approve === undefined || args.approve === null) {
      return {
        ok: false, status: 409, reason: 'approval_required', nodes_requiring_approval: need,
        error: `version ${args.version} sends or spends through ${need.join(', ')}; the owner must approve exactly these nodes`,
      }
    }
    if (!Array.isArray(args.approve) || !args.approve.every((x) => typeof x === 'string')) {
      return { ok: false, status: 400, reason: 'invalid_approve', error: 'approve must be a list of node ids' }
    }
    approved = [...new Set(args.approve as string[])].sort()
    const exact = approved.length === need.length && approved.every((id, i) => id === need[i])
    if (!exact) {
      return {
        ok: false, status: 409, reason: 'approval_mismatch', nodes_requiring_approval: need, approved,
        error: `approve must name exactly the send/spend nodes of version ${args.version}: ${need.join(', ')}`,
      }
    }
  }
  const approvals: FlowApprovals = {
    version: args.version,
    nodes: need,
    by: `user:${args.approverUserId}`,
    at: args.now ?? new Date().toISOString(),
    sha256: args.sha256(def),
    self_test_id: st.id,
  }
  // The recorded approval must make the definition valid with approvals REQUIRED.
  const withApproval: FlowDefinition = { ...def, approvals: { version: approvals.version, nodes: approvals.nodes, by: approvals.by, at: approvals.at } }
  const strict = validateFlow(withApproval)
  if (!strict.ok) return { ok: false, status: 409, reason: 'invalid_definition', errors: strict.errors }
  return { ok: true, approvals, definition: def }
}

/**
 * Write the owner's approval record for one version (the publish route, in its
 * transaction). The record is bound to the stored version's SHA-256; a caller
 * that passes none gets the stored one (engine tests stand in for the owner).
 */
export function recordFlowApprovals(db: Database.Database, flowId: number, approvals: FlowApprovals): void {
  const row = db.prepare('SELECT sha256 FROM flow_versions WHERE flow_id = ? AND version = ?').get(flowId, approvals.version) as
    | { sha256: string }
    | undefined
  if (!row) throw new Error(`flow ${flowId} has no version ${approvals.version}`)
  if (approvals.sha256 && approvals.sha256 !== row.sha256) throw new Error('approval sha256 does not match the stored version')
  db.prepare('UPDATE flow_versions SET approvals_json = ? WHERE flow_id = ? AND version = ?')
    .run(JSON.stringify({ ...approvals, sha256: row.sha256 }), flowId, approvals.version)
}
