// Card B5 (obj 900641, docs/design/WORKFLOWS.md §5.2 / §5.4 / §8) — engine level.
//
//   A1  a `dry` run of the §3.5 example makes ZERO external calls (Tool, MCP,
//       model, fetch, http/https, child processes — all spied) and records
//       "would send" for `notify`
//   +   `test` mode: read Tools / mcp reads / llm run live, write/send stay stubbed
//   +   goal.end_condition is evaluated by the ENGINE (asserts + optional judge)
//   +   the self-test verdict: run failures, failing asserts, judge, branch
//       coverage over fixtures, budget
//   +   a sequential loop (needed by §3.5): per-item rows, max_items, memoised replay
//   +   only a RECORDED owner approval lets a live run send — not one typed into
//       the definition
//   +   the flow_runs.mode CHECK migration keeps old rows and never cascades
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import http from 'http'
import https from 'https'
import net from 'net'
import childProcess from 'child_process'
import Database from 'better-sqlite3'
import type { FlowDefinition, FlowNode } from '../../../shared/flow/types.js'
import { DAILY_BOOKING_TRIAGE } from '../../../shared/flow/__tests__/example.js'
import { stubFromSchema, nodesRequiringApproval, nodesMissingMocks } from '../../../shared/flow/self-test.js'
import { FlowEngine, saveFlowVersion, type FlowTool } from './flow-engine.js'
import { initFlowSchema } from '../db/schema/flow.js'
import { initJobAccountingSchema } from '../db/schema/job-accounting.js'
import { checkPublishGate, recordFlowApprovals, runSelfTest, getSelfTest } from './flow-self-test.js'
import { flowDefinitionSha256 } from './flow-engine.js'
import type { BackendRequest, LlmBackend } from './llm-gateway/claude-cli-backend.js'
import type { FlowMcpResolver } from './flow-mcp.js'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any

const T0 = Date.parse('2026-11-12T08:00:00.000Z')
let db: Database.Database
let now: number
const clock = () => now

function freshDb(): Database.Database {
  const d = new Database(':memory:')
  d.pragma('foreign_keys = ON')
  d.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  initFlowSchema(d)
  initJobAccountingSchema(d)
  d.prepare("UPDATE settings SET value = '1' WHERE key = 'flows_enabled'").run()
  return d
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T

/** Every way the engine could reach outside the process, counted. */
function spyEverything() {
  const toolCalls: { slug: string; input: unknown }[] = []
  const mcpResolves: unknown[] = []
  const mcpCalls: unknown[] = []
  const llmCalls: BackendRequest[] = []
  const tool = (slug: string, out: unknown, meta: Partial<FlowTool> = {}): FlowTool => ({
    ...meta,
    async run(input) { toolCalls.push({ slug, input }); return out },
  })
  const tools: Record<string, FlowTool> = {
    'calendar-bookings-list': tool('calendar-bookings-list', { bookings: [{ id: 'live-1', notes: 'live note' }] }, { effect: 'read' }),
  }
  const mcp: FlowMcpResolver = {
    async resolve(args) {
      mcpResolves.push(args)
      return { ok: true, connection: { async call(t, a) { mcpCalls.push({ t, a }); return { structuredContent: { ok: true, count: 1 } } } } }
    },
  }
  const llm: LlmBackend = async (req) => {
    llmCalls.push(req)
    const text = req.systemPrompt.includes('end-condition judge') || req.prompt.includes('end-condition judge')
      ? '{"pass": true, "reason": "states the count only"}'
      : '{"category": "support"}'
    return { text, usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }, stopReason: 'end_turn', slot: 'stub', costUsd: 0.001, ttftMs: 1, attempts: 1 }
  }
  const net_ = {
    fetch: vi.spyOn(globalThis, 'fetch'),
    http: vi.spyOn(http, 'request'),
    httpGet: vi.spyOn(http, 'get'),
    https: vi.spyOn(https, 'request'),
    httpsGet: vi.spyOn(https, 'get'),
    connect: vi.spyOn(net, 'connect'),
    spawn: vi.spyOn(childProcess, 'spawn'),
    execFile: vi.spyOn(childProcess, 'execFile'),
  }
  const engine = new FlowEngine({ db, tools: { get: (s) => tools[s] ?? null }, llm, mcp, clock, owner: 'b5', heartbeatMs: 60_000 })
  const externalCalls = () =>
    toolCalls.length + mcpResolves.length + mcpCalls.length + llmCalls.length +
    Object.values(net_).reduce((n, s) => n + s.mock.calls.length, 0)
  return { engine, tools, toolCalls, mcpResolves, mcpCalls, llmCalls, net: net_, externalCalls }
}

function save(def: FlowDefinition, workspace = 'acme'): number {
  const r = saveFlowVersion(db, { workspace, definition: def, author: 'agent:42' })
  if (!r.ok) throw new Error(`save failed: ${r.reason} ${JSON.stringify(r.errors)}`)
  return r.flowId
}

async function runOnce(e: FlowEngine, flowId: number, mode: 'dry' | 'test' | 'live', payload: unknown = {}, version = 3): Promise<number> {
  const r = e.startRun({ flowId, version, mode, trigger: { source: 'manual', payload } })
  if (!r.ok) throw new Error(`start failed: ${r.reason}`)
  await e.runNow(r.runId)
  return r.runId
}

const runRow = (id: number) => db.prepare('SELECT * FROM flow_runs WHERE id = ?').get(id) as Loose
const stepRows = (id: number) => db.prepare('SELECT * FROM flow_step_runs WHERE run_id = ? ORDER BY id').all(id) as Loose[]

/** §3.5 with the mocks a builder must write and a goal that the check node's output can satisfy. */
function greenTriage(): FlowDefinition {
  const d = clone(DAILY_BOOKING_TRIAGE) as Loose
  d.goal.end_condition.assert[0] = { expr: 'len(steps.each.output) == len(steps.fetch.output.bookings)', why: 'nothing dropped' }
  for (const n of d.nodes) {
    if (n.id === 'upsert_one') n.mock = { output: { id: 'c1' } }
    if (n.id === 'notify') n.mock = { output: { ok: true } }
  }
  return d
}

beforeEach(() => {
  db = freshDb()
  now = T0
})

afterEach(() => {
  vi.restoreAllMocks()
  db.close()
})

describe('acceptance: a dry run of the §3.5 example makes zero external calls and records "would send" for notify', () => {
  it('every node is simulated; tool/mcp/model/network/child-process spies all stay at zero', async () => {
    const s = spyEverything()
    const flowId = save(clone(DAILY_BOOKING_TRIAGE))
    const runId = await runOnce(s.engine, flowId, 'dry')

    expect(s.externalCalls()).toBe(0)
    expect(s.toolCalls).toEqual([])
    expect(s.mcpResolves).toEqual([])
    expect(s.llmCalls).toEqual([])
    for (const [name, spy] of Object.entries(s.net)) expect(spy.mock.calls.length, name).toBe(0)

    const run = runRow(runId)
    expect(run).toMatchObject({ status: 'succeeded', mode: 'dry' })
    const steps = stepRows(runId)
    const by = (id: string, iteration = 0) => steps.find((r) => r.node_id === id && r.iteration === iteration)
    expect(by('fetch')).toMatchObject({ status: 'succeeded', simulated: 'mock', effect: 'read' })
    expect(JSON.parse(by('fetch').output_json)).toEqual({ bookings: [{ id: 'b1', notes: 'pricing question' }] })
    // classify has no mock: a stub from its output_schema, never a model call
    expect(by('classify')).toMatchObject({ status: 'succeeded', simulated: 'stub' })
    expect(JSON.parse(by('classify').output_json)).toEqual({ category: 'sales' })
    expect(by('upsert_one')).toMatchObject({ status: 'succeeded', simulated: 'would_write', effect: 'write' })
    expect(JSON.parse(by('upsert_one').input_json)).toEqual({ external_id: 'b1', tag: 'sales' })

    // "would send" for notify, with exactly what would have gone out
    const notify = by('notify')
    expect(notify).toMatchObject({ status: 'succeeded', simulated: 'would_send', effect: 'send', idempotency_key: null })
    expect(JSON.parse(notify.input_json)).toEqual({ channel: '#bookings', text: 'Triaged 1 bookings.' })

    // the loop ran its body once per item, rows keyed by the item index
    expect(by('each')).toMatchObject({ status: 'succeeded', iteration: 0 })
    expect(JSON.parse(by('each').output_json)).toEqual([{ classify: { category: 'sales' }, upsert_one: null }])
  })

  it('the engine evaluates the §3.5 end condition: both asserts fail on the dry run (no mocks for upsert/notify), judge skipped', async () => {
    const s = spyEverything()
    const flowId = save(clone(DAILY_BOOKING_TRIAGE))
    const run = runRow(await runOnce(s.engine, flowId, 'dry'))
    expect(run.status).toBe('succeeded') // run status and goal are separate (§4.3)
    expect(run.goal_met).toBe(0)
    const goal = JSON.parse(run.goal_json)
    expect(goal.asserts).toEqual([
      { expr: 'len(steps.fetch.output.bookings) == steps.upsert.output.count', why: 'nothing dropped', passed: false },
      { expr: 'steps.notify.output.ok == true', why: 'summary posted', passed: false },
    ])
    expect(goal.judge).toMatchObject({ status: 'skipped' })
    expect(s.externalCalls()).toBe(0)
  })

  it('a dry self-test of the §3.5 example is red, names the failing asserts, and lists the would-send step', async () => {
    const s = spyEverything()
    const flowId = save(clone(DAILY_BOOKING_TRIAGE))
    const r = await runSelfTest(s.engine, { flowId, version: 3, mode: 'dry', requestedBy: 'agent:42' })
    if (!r.ok) throw new Error(r.reason)
    expect(r.selfTest.status).toBe('failed')
    expect(r.selfTest.result!.failing_asserts.map((a) => a.expr)).toEqual([
      'len(steps.fetch.output.bookings) == steps.upsert.output.count',
      'steps.notify.output.ok == true',
    ])
    expect(r.selfTest.result!.fixtures[0].simulated.find((x) => x.node_id === 'notify')).toMatchObject({ simulated: 'would_send', effect: 'send' })
    expect(s.externalCalls()).toBe(0)
  })
})

describe('test mode (§5.2): reads and llm live, write/send stubbed', () => {
  it('runs the read Tool and the model for real, never the CRM write or the Slack send; judge runs and passes', async () => {
    const s = spyEverything()
    const flowId = save(greenTriage())
    const r = await runSelfTest(s.engine, { flowId, version: 3, mode: 'test', requestedBy: 'user:1' })
    if (!r.ok) throw new Error(r.reason)
    expect(s.toolCalls.map((c) => c.slug)).toEqual(['calendar-bookings-list'])
    expect(s.mcpResolves).toEqual([]) // both mcp nodes are write/send
    expect(s.llmCalls.length).toBe(2) // classify + the judge
    expect(r.selfTest.status).toBe('passed')
    const fx = r.selfTest.result!.fixtures[0]
    expect(fx.goal?.judge).toMatchObject({ status: 'passed' })
    expect(fx.spent_usd).toBeCloseTo(0.002)
    expect(fx.simulated.map((x) => `${x.node_id}:${x.simulated}`)).toEqual(['upsert_one:would_write', 'notify:would_send'])
    const notify = stepRows(fx.run_id).find((x) => x.node_id === 'notify')
    expect(JSON.parse(notify.input_json).text).toBe('Triaged 1 bookings.') // the LIVE read's single booking
    // the judge saw only the rubric and the named output
    const judgeReq = s.llmCalls[1]
    expect(judgeReq.prompt).toContain('The message states how many bookings were triaged')
    expect(judgeReq.prompt).toContain('"Triaged 1 bookings."')
    expect(judgeReq.prompt).not.toContain('live note')
    // green ⇒ a run of it is linked on the version
    const v = db.prepare('SELECT self_test_run_id FROM flow_versions WHERE flow_id = ? AND version = 3').get(flowId) as Loose
    expect(v.self_test_run_id).toBe(fx.run_id)
  })

  it('a judge that fails makes goal_met 0 and the self-test red', async () => {
    const s = spyEverything()
    const flowId = save(greenTriage())
    const judgeNo: LlmBackend = async (req) => ({
      text: req.prompt.includes('end-condition judge') ? '{"pass": false, "reason": "it says more than the count"}' : '{"category": "other"}',
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }, stopReason: 'end_turn', slot: 'stub', costUsd: 0.001, ttftMs: 1, attempts: 1,
    })
    const e = new FlowEngine({ db, tools: { get: (x) => s.tools[x] ?? null }, llm: judgeNo, clock, owner: 'b5j', heartbeatMs: 60_000 })
    const r = await runSelfTest(e, { flowId, version: 3, mode: 'test', requestedBy: 'user:1' })
    if (!r.ok) throw new Error(r.reason)
    expect(r.selfTest.status).toBe('failed')
    expect(r.selfTest.result!.failures.map((f) => f.code)).toEqual(['judge_failed'])
    expect(runRow(r.selfTest.run_ids[0]).goal_met).toBe(0)
  })

  it('a test self-test with a judge but no model backend is not green (judge_not_evaluated)', async () => {
    const s = spyEverything()
    const flowId = save(greenTriage())
    const e = new FlowEngine({ db, tools: { get: (x) => s.tools[x] ?? null }, clock, owner: 'b5n', heartbeatMs: 60_000 })
    const def = greenTriage() as Loose
    def.version = 4
    def.nodes.find((n: Loose) => n.id === 'classify').mock = { output: { category: 'sales' } }
    def.nodes.find((n: Loose) => n.id === 'classify').effect = 'write' // stubbed in test mode, so no backend is needed for it
    const f2 = save(def)
    expect(f2).toBe(flowId)
    const r = await runSelfTest(e, { flowId, version: 4, mode: 'test', requestedBy: 'user:1' })
    if (!r.ok) throw new Error(r.reason)
    expect(r.selfTest.result!.failures.map((f) => f.code)).toEqual(['judge_not_evaluated'])
  })
})

describe('the self-test verdict (engine-judged)', () => {
  const branchy = (): FlowDefinition => ({
    apiVersion: 'okflow/1', id: 'branchy', name: 'Branchy', version: 1,
    goal: { statement: 'routed', end_condition: { assert: [{ expr: 'steps.fetch.output.n >= 0' }] } },
    fixtures: [{ name: 'some', payload: { n: 3 } }],
    nodes: [
      { id: 'start', kind: 'trigger', on: 'manual', next: 'fetch' },
      { id: 'fetch', kind: 'tool', tool: 'count', effect: 'read', input: { n: '{{ trigger.payload.n }}' }, mock: { output: { n: 3 } }, next: 'route' },
      { id: 'route', kind: 'branch', cases: [{ when: 'trigger.payload.n > 0', then: ['tell'] }], default: ['noop'], next: 'done' },
      { id: 'tell', kind: 'tool', tool: 'post', effect: 'send', input: { text: 'n={{ trigger.payload.n }}' }, mock: { output: { ok: true } } },
      { id: 'noop', kind: 'check', assert: [{ expr: 'true' }] },
      { id: 'done', kind: 'end' },
    ] as FlowNode[],
  })

  it('a branch arm no fixture reaches is uncovered → red; adding a fixture that reaches it → green', async () => {
    const s = spyEverything()
    const flowId = save(branchy())
    const red = await runSelfTest(s.engine, { flowId, version: 1, mode: 'dry', requestedBy: 'user:1' })
    if (!red.ok) throw new Error(red.reason)
    expect(red.selfTest.status).toBe('failed')
    expect(red.selfTest.result!.uncovered_nodes).toEqual(['noop'])
    expect(red.selfTest.result!.failures.map((f) => f.code)).toEqual(['uncovered_nodes'])

    const green = await runSelfTest(s.engine, {
      flowId, version: 1, mode: 'dry', requestedBy: 'user:1',
      fixtures: [{ name: 'some', payload: { n: 3 } }, { name: 'none', payload: { n: 0 } }],
    })
    if (!green.ok) throw new Error(green.reason)
    expect(green.selfTest.status).toBe('passed')
    expect(green.selfTest.result!.fixtures.map((f) => f.name)).toEqual(['some', 'none'])
    expect(green.selfTest.result!.fixtures[0].simulated).toEqual([
      expect.objectContaining({ node_id: 'tell', simulated: 'would_send', input_preview: '{"text":"n=3"}' }),
    ])
    expect(s.externalCalls()).toBe(0)
  })

  it('a mock.error fails its step (no retry) and the self-test reports run_failed', async () => {
    const s = spyEverything()
    const def = branchy() as Loose
    def.nodes[1].mock = { error: { type: 'http_500', title: 'calendar API is down' } }
    const flowId = save(def)
    const r = await runSelfTest(s.engine, { flowId, version: 1, mode: 'dry', requestedBy: 'user:1' })
    if (!r.ok) throw new Error(r.reason)
    expect(r.selfTest.status).toBe('failed')
    expect(r.selfTest.result!.failures[0]).toMatchObject({ code: 'run_failed', fixture: 'some' })
    expect(r.selfTest.result!.failures[0].message).toContain('calendar API is down')
    expect(stepRows(r.selfTest.run_ids[0]).filter((x) => x.node_id === 'fetch')).toHaveLength(1)
  })

  it('a dry run of a read node with no mock fails mock_missing instead of calling out', async () => {
    const s = spyEverything()
    const def = branchy() as Loose
    delete def.nodes[1].mock
    const flowId = save(def)
    const runId = await runOnce(s.engine, flowId, 'dry', { n: 1 }, 1)
    expect(JSON.parse(runRow(runId).error_json)).toMatchObject({ type: 'mock_missing', node_id: 'fetch' })
    expect(s.externalCalls()).toBe(0)
  })

  it('refuses while the kill switch is off, without leaving a self-test row', async () => {
    const s = spyEverything()
    const flowId = save(branchy())
    db.prepare("UPDATE settings SET value = '0' WHERE key = 'flows_enabled'").run()
    const r = await runSelfTest(s.engine, { flowId, version: 1, mode: 'dry', requestedBy: 'user:1' })
    expect(r).toEqual({ ok: false, status: 409, reason: 'flows_disabled' })
    expect((db.prepare('SELECT COUNT(*) n FROM flow_self_tests').get() as Loose).n).toBe(0)
  })
})

describe('sequential loop', () => {
  const loopFlow = (maxItems = 5): FlowDefinition => ({
    apiVersion: 'okflow/1', id: 'loopy', name: 'Loopy', version: 1,
    goal: { statement: 'each item handled', end_condition: { assert: [{ expr: 'len(steps.each.output) == len(trigger.payload.items)' }] } },
    nodes: [
      { id: 'start', kind: 'trigger', on: 'manual', next: 'each' },
      { id: 'each', kind: 'loop', over: '{{ trigger.payload.items }}', as: 'it', max_items: maxItems, body: ['look'], next: 'done' },
      { id: 'look', kind: 'tool', tool: 'echo', effect: 'read', input: { v: '{{ item.it.v }}' } },
      { id: 'done', kind: 'end', output: '{{ steps.each.output }}' },
    ] as FlowNode[],
  })

  it('live: one body row per item (iteration = index), output is one object per item, goal met', async () => {
    const calls: unknown[] = []
    const echo: FlowTool = { effect: 'read', async run(input) { calls.push(input); return input } }
    const e = new FlowEngine({ db, tools: { get: () => echo }, clock, owner: 'loop', heartbeatMs: 60_000 })
    const flowId = save(loopFlow())
    const r = e.startRun({ flowId, version: 1, trigger: { payload: { items: [{ v: 'a' }, { v: 'b' }, { v: 'c' }] } } })
    if (!r.ok) throw new Error(r.reason)
    await e.runNow(r.runId)
    expect(calls).toEqual([{ v: 'a' }, { v: 'b' }, { v: 'c' }])
    expect(stepRows(r.runId).filter((x) => x.node_id === 'look').map((x) => x.iteration)).toEqual([0, 1, 2])
    const run = runRow(r.runId)
    expect(run).toMatchObject({ status: 'succeeded', goal_met: 1 })
    expect(JSON.parse(run.output_json)).toEqual([{ look: { v: 'a' } }, { look: { v: 'b' } }, { look: { v: 'c' } }])
  })

  it('a re-walk after a retry backoff replays finished iterations instead of calling them again', async () => {
    const calls: unknown[] = []
    let failB = true
    const echo: FlowTool = {
      effect: 'read',
      async run(input) {
        calls.push(input)
        if ((input as Loose).v === 'b' && failB) { failB = false; throw new Error('flaky') }
        return input
      },
    }
    const def = loopFlow() as Loose
    def.nodes[2].retry = { max: 3, backoff: 'fixed', delay_ms: 1000 }
    const e = new FlowEngine({ db, tools: { get: () => echo }, clock, owner: 'loop2', heartbeatMs: 60_000 })
    const flowId = save(def)
    const r = e.startRun({ flowId, version: 1, trigger: { payload: { items: [{ v: 'a' }, { v: 'b' }] } } })
    if (!r.ok) throw new Error(r.reason)
    await e.runNow(r.runId)
    expect(runRow(r.runId).status).toBe('running') // suspended for backoff
    now += 1500
    await e.tick()
    expect(runRow(r.runId).status).toBe('succeeded')
    expect(calls).toEqual([{ v: 'a' }, { v: 'b' }, { v: 'b' }]) // 'a' was never re-run
  })

  it('more items than max_items fails the run before any body step', async () => {
    const echo: FlowTool = { effect: 'read', async run(i) { return i } }
    const e = new FlowEngine({ db, tools: { get: () => echo }, clock, owner: 'loop3', heartbeatMs: 60_000 })
    const flowId = save(loopFlow(2))
    const r = e.startRun({ flowId, version: 1, trigger: { payload: { items: [{ v: 1 }, { v: 2 }, { v: 3 }] } } })
    if (!r.ok) throw new Error(r.reason)
    await e.runNow(r.runId)
    expect(JSON.parse(runRow(r.runId).error_json)).toMatchObject({ type: 'loop_max_items_exceeded', node_id: 'each' })
    expect(stepRows(r.runId).filter((x) => x.node_id === 'look')).toEqual([])
  })
})

describe('approvals: only the RECORDED owner approval counts', () => {
  it('a live run of a send node is refused even when the definition carries a typed-in approvals block', async () => {
    const s = spyEverything()
    const forged = greenTriage() // embeds approvals { nodes: [notify], by: user:1 }
    const flowId = save(forged)
    expect(db.prepare('SELECT approvals_json FROM flow_versions WHERE flow_id = ?').get(flowId)).toEqual({ approvals_json: null })
    expect(s.engine.startRun({ flowId, version: 3, mode: 'live' })).toEqual({ ok: false, reason: 'unapproved_effect' })
    // a dry/test self-test of the same draft is fine — it sends nothing
    expect(s.engine.startRun({ flowId, version: 3, mode: 'dry' }).ok).toBe(true)
    recordFlowApprovals(db, flowId, { version: 3, nodes: ['notify'], by: 'user:1', at: new Date(T0).toISOString() })
    expect(s.engine.startRun({ flowId, version: 3, mode: 'live' }).ok).toBe(true)
  })

  it('checkPublishGate records the exact node set + version, the approver, the sha and the self-test', async () => {
    const s = spyEverything()
    const def = greenTriage()
    const flowId = save(def)
    const st = await runSelfTest(s.engine, { flowId, version: 3, mode: 'dry', requestedBy: 'user:1' })
    if (!st.ok) throw new Error(st.reason)
    expect(st.selfTest.status).toBe('passed')
    const base = { flowId, version: 3, approverUserId: 7, sha256: flowDefinitionSha256, now: '2026-11-12T09:00:00.000Z' }
    expect(checkPublishGate(db, { ...base, approve: undefined })).toMatchObject({ ok: false, status: 409, reason: 'approval_required', nodes_requiring_approval: ['notify'] })
    expect(checkPublishGate(db, { ...base, approve: ['notify', 'upsert_one'] })).toMatchObject({ ok: false, reason: 'approval_mismatch' })
    expect(checkPublishGate(db, { ...base, approve: [] })).toMatchObject({ ok: false, reason: 'approval_mismatch' })
    const ok = checkPublishGate(db, { ...base, approve: ['notify'] })
    expect(ok).toMatchObject({
      ok: true,
      approvals: { version: 3, nodes: ['notify'], by: 'user:7', at: '2026-11-12T09:00:00.000Z', sha256: flowDefinitionSha256(def), self_test_id: st.selfTest.id },
    })
  })
})

describe('pure helpers', () => {
  it('nodesRequiringApproval ignores an embedded approvals block; nodesMissingMocks lists write/send/spend without mocks', () => {
    expect(nodesRequiringApproval(DAILY_BOOKING_TRIAGE)).toEqual(['notify'])
    expect(nodesMissingMocks(DAILY_BOOKING_TRIAGE)).toEqual(['upsert_one', 'notify'])
    expect(nodesMissingMocks(greenTriage())).toEqual([])
  })

  it('stubFromSchema builds a minimal valid value', () => {
    expect(stubFromSchema({ type: 'object', properties: { category: { enum: ['sales', 'x'] }, n: { type: 'integer', minimum: 2 }, tags: { type: 'array', items: { type: 'string' }, minItems: 1 } }, required: ['category', 'n', 'tags'] }))
      .toEqual({ category: 'sales', n: 2, tags: [''] })
    expect(stubFromSchema({ type: 'boolean' })).toBe(false)
    expect(stubFromSchema({ const: 'fixed' })).toBe('fixed')
  })
})

describe('migration: flow_runs.mode gains "test" on a DB created before B5', () => {
  it('rebuilds the table once, keeps every run and step row (no FK cascade), and accepts mode "test"', () => {
    const d = new Database(':memory:')
    d.pragma('foreign_keys = ON')
    d.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    d.exec(`CREATE TABLE flow_definitions (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL, workspace TEXT NOT NULL, name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft', published_version INTEGER, objective_id INTEGER, created_by TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT 'x', updated_at TEXT NOT NULL DEFAULT 'x', UNIQUE(workspace, slug))`)
    // the B2 shape, verbatim CHECK
    d.exec(`CREATE TABLE IF NOT EXISTS flow_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, flow_id INTEGER NOT NULL REFERENCES flow_definitions(id) ON DELETE CASCADE,
      version INTEGER NOT NULL, workspace TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'live' CHECK(mode IN ('live', 'dry', 'replay')),
      trigger_json TEXT, status TEXT NOT NULL DEFAULT 'queued', goal_met INTEGER CHECK(goal_met IN (0, 1)),
      spent_usd REAL NOT NULL DEFAULT 0, output_json TEXT, error_json TEXT, lease_owner TEXT, lease_expires_at TEXT,
      next_attempt_at TEXT, parent_run_id INTEGER, objective_id INTEGER, created_at TEXT NOT NULL, started_at TEXT,
      updated_at TEXT NOT NULL, ended_at TEXT)`)
    d.exec(`CREATE TABLE flow_step_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER NOT NULL REFERENCES flow_runs(id) ON DELETE CASCADE,
      node_id TEXT NOT NULL, iteration INTEGER NOT NULL DEFAULT 0, attempt INTEGER NOT NULL, status TEXT NOT NULL, effect TEXT,
      input_json TEXT, output_json TEXT, error_json TEXT, idempotency_key TEXT, cost_usd REAL NOT NULL DEFAULT 0,
      started_at TEXT NOT NULL, ended_at TEXT, UNIQUE(run_id, node_id, iteration, attempt))`)
    d.prepare("INSERT INTO flow_definitions (slug, workspace, name, created_by) VALUES ('old', 'acme', 'Old', 'user:1')").run()
    d.prepare("INSERT INTO flow_runs (flow_id, version, workspace, mode, status, created_at, updated_at) VALUES (1, 1, 'acme', 'live', 'succeeded', 't', 't')").run()
    d.prepare("INSERT INTO flow_step_runs (run_id, node_id, attempt, status, started_at) VALUES (1, 'start', 1, 'succeeded', 't')").run()
    expect(() => d.prepare("INSERT INTO flow_runs (flow_id, version, workspace, mode, created_at, updated_at) VALUES (1, 1, 'acme', 'test', 't', 't')").run()).toThrow(/CHECK/)

    initFlowSchema(d)
    initFlowSchema(d) // idempotent
    expect((d.prepare('SELECT COUNT(*) n FROM flow_runs').get() as Loose).n).toBe(1)
    expect((d.prepare('SELECT COUNT(*) n FROM flow_step_runs').get() as Loose).n).toBe(1)
    d.prepare("INSERT INTO flow_runs (flow_id, version, workspace, mode, created_at, updated_at) VALUES (1, 1, 'acme', 'test', 't', 't')").run()
    expect(() => d.prepare("INSERT INTO flow_runs (flow_id, version, workspace, mode, created_at, updated_at) VALUES (1, 1, 'acme', 'bogus', 't', 't')").run()).toThrow(/CHECK/)
    const cols = (d.prepare('PRAGMA table_info(flow_runs)').all() as { name: string }[]).map((c) => c.name)
    expect(cols).toEqual(expect.arrayContaining(['goal_json', 'self_test_id']))
    expect(d.pragma('foreign_keys', { simple: true })).toBe(1)
    expect(d.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    // FK from flow_step_runs still points at the (new) flow_runs and still cascades
    d.prepare('DELETE FROM flow_runs WHERE id = 1').run()
    expect((d.prepare('SELECT COUNT(*) n FROM flow_step_runs').get() as Loose).n).toBe(0)
    d.close()
  })

  it('getSelfTest returns null for an unknown id', () => {
    expect(getSelfTest(db, 999)).toBeNull()
  })
})

describe('recorded approvals are bound to the version content', () => {
  it('an approvals_json without the version sha (as B4 copied from definition text) is not authority', () => {
    const s = spyEverything()
    const flowId = save(greenTriage())
    db.prepare('UPDATE flow_versions SET approvals_json = ? WHERE flow_id = ? AND version = 3')
      .run(JSON.stringify({ version: 3, nodes: ['notify'], by: 'user:1', at: 'x' }), flowId)
    expect(s.engine.startRun({ flowId, version: 3, mode: 'live' })).toEqual({ ok: false, reason: 'unapproved_effect' })
    expect(() => recordFlowApprovals(db, flowId, { version: 3, nodes: ['notify'], by: 'user:1', at: 'x', sha256: 'f'.repeat(64) })).toThrow(/sha256/)
  })

  it('a later red self-test clears self_test_run_id', async () => {
    const s = spyEverything()
    const flowId = save(greenTriage())
    const green = await runSelfTest(s.engine, { flowId, version: 3, mode: 'dry', requestedBy: 'user:1' })
    if (!green.ok) throw new Error(green.reason)
    const linked = () => (db.prepare('SELECT self_test_run_id FROM flow_versions WHERE flow_id = ? AND version = 3').get(flowId) as Loose).self_test_run_id
    expect(linked()).toBe(green.selfTest.run_ids[0])
    // a second self-test whose fixture run ends failed (forced, then re-judged)
    const red = await runSelfTest(s.engine, { flowId, version: 3, mode: 'test', requestedBy: 'user:1' })
    if (!red.ok) throw new Error(red.reason)
    db.prepare("UPDATE flow_self_tests SET status = 'running' WHERE id = ?").run(red.selfTest.id)
    db.prepare("UPDATE flow_runs SET status = 'failed', error_json = ? WHERE id = ?").run(JSON.stringify({ type: 'x', title: 'forced' }), red.selfTest.run_ids[0])
    const { finalizeSelfTest } = await import('./flow-self-test.js')
    finalizeSelfTest(db, red.selfTest.id)
    expect(getSelfTest(db, red.selfTest.id)!.status).toBe('failed')
    expect(linked()).toBeNull()
  })
})
