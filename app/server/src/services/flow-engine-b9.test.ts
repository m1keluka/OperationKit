// Flow engine card B9 (obj 900645, docs/design/WORKFLOWS.md §8): `agent` node,
// `wait` / approval node, `loop` concurrency. Engine-level tests on a bare DB;
// the HTTP side (approval click, child card on the board) is routes/flows-b9.test.ts.
//
// Card acceptance covered here:
//   - loop with `concurrency: 4` never exceeds 4 in-flight steps
//   - a flow waits across an engine restart and resumes on approval
// plus: timed waits, events, timeouts, rejection, the slot rule (a parked
// iteration keeps its slot), the wake race, and dry runs never parking.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import type { FlowDefinition, FlowNode } from '../../../shared/flow/types.js'
import {
  FlowEngine, saveFlowVersion, listOpenWaits, parseFlowDurationMs, type FlowTool, type FlowToolContext,
} from './flow-engine.js'
import { initFlowSchema } from '../db/schema/flow.js'
import type { FlowAgentHost } from './flow-agent.js'

const T0 = Date.parse('2026-11-12T00:00:00.000Z')

let db: Database.Database
let now: number
const clock = () => now

function freshDb(): Database.Database {
  const d = new Database(':memory:')
  d.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  initFlowSchema(d)
  d.prepare("UPDATE settings SET value = '1' WHERE key = 'flows_enabled'").run()
  return d
}

function flow(nodes: FlowNode[], extra: Partial<FlowDefinition> = {}): FlowDefinition {
  return {
    apiVersion: 'okflow/1',
    id: 'b9-flow',
    name: 'B9 flow',
    version: 1,
    goal: { statement: 'test', end_condition: { assert: [{ expr: 'true' }] } },
    nodes,
    ...extra,
  }
}

function spyTool(impl: (n: number, input: unknown, ctx: FlowToolContext) => unknown | Promise<unknown>, meta: Partial<FlowTool> = {}) {
  const calls: { n: number; input: unknown; ctx: FlowToolContext }[] = []
  const tool: FlowTool = {
    effect: 'read',
    ...meta,
    async run(input, ctx) {
      const n = calls.length + 1
      calls.push({ n, input, ctx })
      return impl(n, input, ctx)
    },
  }
  return { tool, calls }
}

function engine(tools: Record<string, FlowTool>, owner: string, agents?: FlowAgentHost) {
  return new FlowEngine({
    db, tools: { get: (slug) => tools[slug] ?? null }, clock, owner, leaseTtlMs: 30_000, heartbeatMs: 60_000,
    ...(agents ? { agents } : {}),
  })
}

function save(def: FlowDefinition): number {
  const r = saveFlowVersion(db, { workspace: 'acme', definition: def, author: 'user:1' })
  if (!r.ok) throw new Error(`save failed: ${r.reason} ${JSON.stringify(r.errors)}`)
  return r.flowId
}

function start(e: FlowEngine, flowId: number, payload: unknown = {}, mode: 'live' | 'dry' | 'test' = 'live'): number {
  const r = e.startRun({ flowId, version: 1, trigger: { source: 'manual', payload }, mode })
  if (!r.ok) throw new Error(`start failed: ${r.reason}`)
  return r.runId
}

const runRow = (id: number) => db.prepare('SELECT * FROM flow_runs WHERE id = ?').get(id) as Record<string, any>
const step = (id: number, node: string, iteration = 0) =>
  db.prepare('SELECT * FROM flow_step_runs WHERE run_id = ? AND node_id = ? AND iteration = ? ORDER BY attempt DESC LIMIT 1').get(id, node, iteration) as Record<string, any> | undefined
const openTokens = (id: number) =>
  db.prepare('SELECT * FROM flow_wait_tokens WHERE run_id = ? AND resolved_at IS NULL ORDER BY iteration').all(id) as Record<string, any>[]
const realSleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

beforeEach(() => {
  now = T0
  db = freshDb()
})
afterEach(() => {
  db.close()
})

// ── loop concurrency ────────────────────────────────────────────────────────

describe('acceptance: loop with concurrency 4 never exceeds 4 in-flight steps', () => {
  function loopFlow(concurrency?: number) {
    return flow([
      { id: 'start', kind: 'trigger', on: 'manual', next: 'each' },
      {
        id: 'each', kind: 'loop', over: '{{ trigger.payload.items }}', as: 'it', max_items: 50, body: ['work', 'mark'],
        ...(concurrency !== undefined ? { concurrency } : {}), next: 'done',
      },
      { id: 'work', kind: 'tool', tool: 'slow', effect: 'read', input: { n: '{{ item.it }}' }, retry: { max: 1, backoff: 'fixed', delay_ms: 1 } },
      { id: 'mark', kind: 'check', assert: [{ expr: 'steps.work.output.n == item.it' }] },
      { id: 'done', kind: 'end', output: '{{ steps.each.output }}' },
    ])
  }

  /** A slow read Tool that measures concurrency two ways: its own counter, and `running` step rows in the DB. */
  function concurrencyProbe() {
    let inFlight = 0
    const seen = { tool: 0, dbRunning: 0 }
    const probe = spyTool(async (_n, input) => {
      inFlight++
      seen.tool = Math.max(seen.tool, inFlight)
      const running = (db.prepare("SELECT COUNT(*) n FROM flow_step_runs WHERE status = 'running'").get() as { n: number }).n
      seen.dbRunning = Math.max(seen.dbRunning, running)
      await realSleep(5 + Math.floor(Math.random() * 10))
      inFlight--
      return { n: (input as { n: number }).n }
    })
    return { ...probe, seen }
  }

  it('12 items at concurrency 4: peak in-flight is exactly 4 (tool counter AND running step rows), outputs in item order', async () => {
    const flowId = save(loopFlow(4))
    const p = concurrencyProbe()
    const e = engine({ slow: p.tool }, 'host')
    const items = Array.from({ length: 12 }, (_, i) => i + 1)
    const runId = start(e, flowId, { items })
    await e.tick()
    expect(runRow(runId).status).toBe('succeeded')
    expect(p.calls).toHaveLength(12)
    expect(p.seen.tool).toBe(4)
    expect(p.seen.dbRunning).toBeLessThanOrEqual(4)
    expect(p.seen.dbRunning).toBeGreaterThan(1)
    const out = JSON.parse(runRow(runId).output_json) as { work: { n: number } }[]
    expect(out.map((o) => o.work.n)).toEqual(items)
    // one body row per item, keyed by item index
    const iters = db.prepare("SELECT iteration FROM flow_step_runs WHERE run_id = ? AND node_id = 'work' ORDER BY iteration").all(runId) as { iteration: number }[]
    expect(iters.map((r) => r.iteration)).toEqual(items.map((_, i) => i))
  })

  it('without concurrency the loop stays sequential (peak 1) — the B5 behaviour', async () => {
    const flowId = save(loopFlow())
    const p = concurrencyProbe()
    const e = engine({ slow: p.tool }, 'host')
    const runId = start(e, flowId, { items: [1, 2, 3, 4, 5] })
    await e.tick()
    expect(runRow(runId).status).toBe('succeeded')
    expect(p.seen.tool).toBe(1)
  })

  it('concurrency larger than the list runs every item at once and no more', async () => {
    const flowId = save(loopFlow(4))
    const p = concurrencyProbe()
    const e = engine({ slow: p.tool }, 'host')
    const runId = start(e, flowId, { items: [1, 2] })
    await e.tick()
    expect(runRow(runId).status).toBe('succeeded')
    expect(p.seen.tool).toBe(2)
  })

  it('a failing item stops new items from starting and fails the run; finished items stay memoised', async () => {
    const flowId = save(loopFlow(2))
    const started: number[] = []
    const t = spyTool(async (_n, input) => {
      const n = (input as { n: number }).n
      started.push(n)
      await realSleep(n === 2 ? 1 : 15)
      if (n === 2) throw Object.assign(new Error('boom'), {})
      return { n }
    })
    const e = engine({ slow: t.tool }, 'host')
    const runId = start(e, flowId, { items: [1, 2, 3, 4, 5, 6] })
    await e.tick()
    expect(runRow(runId).status).toBe('failed')
    expect(JSON.parse(runRow(runId).error_json)).toMatchObject({ node_id: 'work' })
    // item 1 (in flight when 2 failed) completed; nothing after the failure was started
    expect(step(runId, 'work', 0)?.status).toBe('succeeded')
    expect(started.length).toBeLessThanOrEqual(3)
  })

  it('a parked iteration KEEPS its slot: concurrency 2 over 5 approval-gated items never has more than 2 open approvals', async () => {
    const flowId = save(flow([
      { id: 'start', kind: 'trigger', on: 'manual', next: 'each' },
      { id: 'each', kind: 'loop', over: '{{ trigger.payload.items }}', as: 'it', max_items: 10, concurrency: 2, body: ['ask', 'act'], next: 'done' },
      { id: 'ask', kind: 'wait', approval: { from: 'owner', prompt: 'Send #{{ item.it }}?' } },
      { id: 'act', kind: 'tool', tool: 'sender', effect: 'send', input: { n: '{{ item.it }}' } },
      { id: 'done', kind: 'end' },
    ]))
    const sender = spyTool((_n, input) => ({ sent: (input as { n: number }).n }), { effect: 'send' })
    const e = engine({ sender: sender.tool }, 'host')
    const runId = start(e, flowId, { items: [10, 20, 30, 40, 50] })

    await e.tick()
    expect(runRow(runId).status).toBe('waiting')
    expect(openTokens(runId).map((t) => t.iteration)).toEqual([0, 1])

    // approve item 0 → it completes, its slot takes item 2 (item 1 still parked)
    expect(e.resolveApproval({ runId, nodeId: 'ask', iteration: 0, decision: 'approve', by: 'user:1' })).toEqual({ ok: true })
    expect(runRow(runId).status).toBe('queued')
    await e.tick()
    expect(runRow(runId).status).toBe('waiting')
    expect(openTokens(runId).map((t) => t.iteration)).toEqual([1, 2])
    expect(sender.calls.map((c) => c.input)).toEqual([{ n: 10 }])

    // with two open, the caller must say which
    expect(e.resolveApproval({ runId, decision: 'approve', by: 'user:1' })).toEqual({ ok: false, reason: 'ambiguous_approval' })
    for (let round = 0; round < 10 && runRow(runId).status !== 'succeeded'; round++) {
      for (const t of openTokens(runId)) e.resolveApproval({ runId, nodeId: 'ask', iteration: t.iteration, decision: 'approve', by: 'user:1' })
      expect(openTokens(runId).length).toBeLessThanOrEqual(2)
      await e.tick()
      expect(openTokens(runId).length).toBeLessThanOrEqual(2)
    }
    expect(runRow(runId).status).toBe('succeeded')
    expect(sender.calls.map((c) => (c.input as { n: number }).n).sort((a, b) => a - b)).toEqual([10, 20, 30, 40, 50])
  })
})

// ── wait: approval ──────────────────────────────────────────────────────────

describe('acceptance: a flow waits across a restart and resumes on approval', () => {
  function approvalFlow() {
    return flow([
      { id: 'start', kind: 'trigger', on: 'manual', next: 'gate' },
      { id: 'gate', kind: 'wait', approval: { from: 'owner', prompt: 'Email {{ trigger.payload.to }}?' }, next: 'send' },
      { id: 'send', kind: 'tool', tool: 'mailer', effect: 'send', input: { to: '{{ trigger.payload.to }}', body: 'hi' }, next: 'done' },
      { id: 'done', kind: 'end', output: '{{ steps.gate.output }}' },
    ], { goal: { statement: 'approved then sent', end_condition: { assert: [{ expr: 'steps.gate.output.approved == true' }, { expr: 'steps.send.output.ok == true' }] } } })
  }

  it('engine A parks the run and dies; engine B (after restart) resumes it on approve, sending exactly once', async () => {
    const flowId = save(approvalFlow())
    const mailer = spyTool(() => ({ ok: true }), { effect: 'send' })
    const a = engine({ mailer: mailer.tool }, 'engine-A')
    const runId = start(a, flowId, { to: 'pat@example.com' })
    await a.tick()

    expect(runRow(runId)).toMatchObject({ status: 'waiting', lease_owner: null })
    expect(step(runId, 'gate')?.status).toBe('running')
    expect(mailer.calls).toHaveLength(0)
    const [w] = listOpenWaits(db, runId)
    expect(w).toMatchObject({
      node_id: 'gate', reason: 'approval', kind: 'approval',
      approval: { from: 'owner', prompt: 'Email pat@example.com?' },
      // the exact payload that will go out if approved
      next: { node_id: 'send', kind: 'tool', effect: 'send', input: { to: 'pat@example.com', body: 'hi' } },
    })

    // "backend restart": A is gone. Hours pass; ticks of a NEW engine do nothing while it waits.
    a.kill()
    now += 6 * 3_600_000
    const b = engine({ mailer: mailer.tool }, 'engine-B')
    await b.tick()
    expect(runRow(runId).status).toBe('waiting')
    expect(mailer.calls).toHaveLength(0)

    // the owner clicks Approve (the route checks cookie owner/admin; here we call the engine)
    expect(b.resolveApproval({ runId, decision: 'approve', by: 'user:1', note: 'go' })).toEqual({ ok: true })
    const tok = db.prepare("SELECT * FROM flow_wait_tokens WHERE run_id = ? AND reason = 'approval'").get(runId) as Record<string, any>
    expect(tok).toMatchObject({ resolved_by: 'user:1', resolution: 'approved' })
    await b.tick()

    const run = runRow(runId)
    expect(run.status).toBe('succeeded')
    expect(run.goal_met).toBe(1)
    expect(JSON.parse(run.output_json)).toMatchObject({ approved: true, by: 'user:1', note: 'go' })
    expect(mailer.calls).toHaveLength(1)
    expect(mailer.calls[0].input).toEqual({ to: 'pat@example.com', body: 'hi' })
    // a second click is refused, never re-sends
    expect(b.resolveApproval({ runId, decision: 'approve', by: 'user:1' })).toEqual({ ok: false, reason: 'no_open_approval' })
  })

  it('reject fails the run with approval_rejected and the guarded send never runs', async () => {
    const flowId = save(approvalFlow())
    const mailer = spyTool(() => ({ ok: true }), { effect: 'send' })
    const e = engine({ mailer: mailer.tool }, 'host')
    const runId = start(e, flowId, { to: 'x@example.com' })
    await e.tick()
    expect(e.resolveApproval({ runId, decision: 'reject', by: 'user:1', note: 'wrong list' })).toEqual({ ok: true })
    await e.tick()
    expect(runRow(runId).status).toBe('failed')
    expect(JSON.parse(runRow(runId).error_json)).toMatchObject({ type: 'approval_rejected', node_id: 'gate', detail: 'wrong list' })
    expect(mailer.calls).toHaveLength(0)
  })

  it('an approval with timeout_ms expires: the run fails approval_timeout', async () => {
    const def = approvalFlow()
    ;(def.nodes[1] as { timeout_ms?: number }).timeout_ms = 60_000
    const flowId = save(def)
    const e = engine({ mailer: spyTool(() => ({ ok: true }), { effect: 'send' }).tool }, 'host')
    const runId = start(e, flowId, { to: 'x@example.com' })
    await e.tick()
    now += 59_000
    await e.tick()
    expect(runRow(runId).status).toBe('waiting')
    now += 2_000
    await e.tick()
    expect(runRow(runId).status).toBe('failed')
    expect(JSON.parse(runRow(runId).error_json)).toMatchObject({ type: 'approval_timeout', node_id: 'gate' })
  })

  it('a token settled WHILE the run walks requeues it instead of stranding it as waiting (wake race)', async () => {
    // item 0 parks on an approval; item 1's tool is held open. The approval for
    // item 0 lands while item 1 is still in flight, i.e. after the walk passed item 0.
    const flowId = save(flow([
      { id: 'start', kind: 'trigger', on: 'manual', next: 'each' },
      { id: 'each', kind: 'loop', over: '{{ trigger.payload.items }}', as: 'it', max_items: 5, concurrency: 2, body: ['pick'], next: 'done' },
      { id: 'pick', kind: 'branch', cases: [{ when: 'item.it == 1', then: ['ask'] }], default: ['slow'] },
      { id: 'ask', kind: 'wait', approval: { from: 'owner', prompt: 'ok?' } },
      { id: 'slow', kind: 'tool', tool: 'slow', effect: 'read' },
      { id: 'done', kind: 'end' },
    ]))
    let release!: () => void
    const held = new Promise<void>((r) => { release = r })
    let entered!: () => void
    const inSlow = new Promise<void>((r) => { entered = r })
    const slow = spyTool(async () => { entered(); await held; return { ok: 1 } })
    const e = engine({ slow: slow.tool }, 'host')
    const runId = start(e, flowId, { items: [1, 2] })
    const pass = e.tick()
    await inSlow
    expect(e.resolveApproval({ runId, nodeId: 'ask', decision: 'approve', by: 'user:1' })).toEqual({ ok: true })
    release()
    await pass
    expect(runRow(runId).status).toBe('queued') // NOT 'waiting' with nothing left to wait for
    await e.tick()
    expect(runRow(runId).status).toBe('succeeded')
  })
})

// ── wait: duration / until / event ──────────────────────────────────────────

describe('wait for / until / event', () => {
  it('wait.for parks the run on a durable timer and resumes once due', async () => {
    const flowId = save(flow([
      { id: 'start', kind: 'trigger', on: 'manual', next: 'pause' },
      { id: 'pause', kind: 'wait', for: '15m', next: 'done' },
      { id: 'done', kind: 'end', output: '{{ steps.pause.output.waited_until }}' },
    ]))
    const e = engine({}, 'host')
    const runId = start(e, flowId)
    await e.tick()
    expect(runRow(runId).status).toBe('waiting')
    const [t] = openTokens(runId)
    expect(t).toMatchObject({ kind: 'until', reason: 'duration', expires_at: new Date(T0 + 15 * 60_000).toISOString() })

    // restart in the middle of the wait: a brand-new engine picks it up when due
    e.kill()
    const e2 = engine({}, 'host-2')
    now += 14 * 60_000
    await e2.tick()
    expect(runRow(runId).status).toBe('waiting')
    now += 60_000
    await e2.tick()
    expect(runRow(runId).status).toBe('succeeded')
    expect(JSON.parse(runRow(runId).output_json)).toBe(new Date(T0 + 15 * 60_000).toISOString())
  })

  it('wait.until in the past passes straight through; in the future it parks until then', async () => {
    const flowId = save(flow([
      { id: 'start', kind: 'trigger', on: 'manual', next: 'pause' },
      { id: 'pause', kind: 'wait', until: '{{ trigger.payload.at }}', next: 'done' },
      { id: 'done', kind: 'end' },
    ]))
    const e = engine({}, 'host')
    const past = start(e, flowId, { at: '2026-01-01T00:00:00Z' })
    const future = start(e, flowId, { at: '2026-11-12T03:00:00Z' })
    await e.tick()
    await e.tick()
    expect(runRow(past).status).toBe('succeeded')
    expect(runRow(future).status).toBe('waiting')
    now = Date.parse('2026-11-12T03:00:00Z')
    await e.tick()
    expect(runRow(future).status).toBe('succeeded')
  })

  it('wait.event resumes on the named event and hands its payload to the next node; other events do not', async () => {
    const flowId = save(flow([
      { id: 'start', kind: 'trigger', on: 'manual', next: 'paid' },
      { id: 'paid', kind: 'wait', event: 'invoice.paid', next: 'done' },
      { id: 'done', kind: 'end', output: '{{ steps.paid.output.payload.amount }}' },
    ]))
    const e = engine({}, 'host')
    const runId = start(e, flowId)
    await e.tick()
    expect(listOpenWaits(db, runId)[0]).toMatchObject({ reason: 'event', event_name: 'invoice.paid' })
    expect(e.deliverEvent({ flowId, event: 'invoice.void', by: 'user:1' }).delivered).toBe(0)
    expect(e.deliverEvent({ flowId, event: 'invoice.paid', payload: { amount: 42 }, by: 'user:1' })).toEqual({ delivered: 1, run_ids: [runId] })
    await e.tick()
    expect(runRow(runId).status).toBe('succeeded')
    expect(JSON.parse(runRow(runId).output_json)).toBe(42)
  })

  it('an event wait with timeout_ms fails wait_timeout when nothing arrives', async () => {
    const flowId = save(flow([
      { id: 'start', kind: 'trigger', on: 'manual', next: 'paid' },
      { id: 'paid', kind: 'wait', event: 'invoice.paid', timeout_ms: 1_000, next: 'done' },
      { id: 'done', kind: 'end' },
    ]))
    const e = engine({}, 'host')
    const runId = start(e, flowId)
    await e.tick()
    now += 1_000
    await e.tick()
    expect(runRow(runId).status).toBe('failed')
    expect(JSON.parse(runRow(runId).error_json)).toMatchObject({ type: 'wait_timeout', node_id: 'paid' })
  })

  it('parses the documented duration forms', () => {
    expect(parseFlowDurationMs('30s')).toBe(30_000)
    expect(parseFlowDurationMs('15m')).toBe(900_000)
    expect(parseFlowDurationMs('2h')).toBe(7_200_000)
    expect(parseFlowDurationMs('1d')).toBe(86_400_000)
    expect(parseFlowDurationMs('PT15M')).toBe(900_000)
    expect(parseFlowDurationMs('P1DT2H')).toBe(93_600_000)
    expect(parseFlowDurationMs('soon')).toBeNull()
    expect(parseFlowDurationMs('PT')).toBeNull()
  })
})

// ── agent (engine side; the board side is in routes/flows-b9.test.ts) ───────

describe('agent node (engine side)', () => {
  function agentFlow() {
    return flow([
      { id: 'start', kind: 'trigger', on: 'manual', next: 'research' },
      { id: 'research', kind: 'agent', brief: 'Research {{ trigger.payload.topic }}', budget_usd: 2, next: 'done' },
      { id: 'done', kind: 'end', output: '{{ steps.research.output.summary }}' },
    ], { budget: { run_usd: 5 } })
  }

  it('without an agent host the node fails agent_unavailable (never skipped)', async () => {
    const flowId = save(agentFlow())
    const e = engine({}, 'host')
    const runId = start(e, flowId, { topic: 'x' })
    await e.tick()
    expect(runRow(runId).status).toBe('failed')
    expect(JSON.parse(runRow(runId).error_json)).toMatchObject({ type: 'agent_unavailable', node_id: 'research' })
  })

  it('a card-creation failure rolls back the step row and the token with it (one transaction)', async () => {
    const flowId = save(agentFlow())
    const host: FlowAgentHost = { createCard: () => { throw new Error('insert failed') } }
    const e = engine({}, 'host', host)
    const runId = start(e, flowId, { topic: 'x' })
    await e.tick()
    expect(runRow(runId).status).toBe('failed')
    expect(openTokens(runId)).toHaveLength(0)
    expect(db.prepare("SELECT COUNT(*) n FROM flow_step_runs WHERE run_id = ? AND node_id = 'research' AND status = 'running'").get(runId)).toEqual({ n: 0 })
  })

  it('a dry run never files a card and never parks (agent, approval and timers are simulated)', async () => {
    const flowId = save(flow([
      { id: 'start', kind: 'trigger', on: 'manual', next: 'research' },
      { id: 'research', kind: 'agent', brief: 'x', budget_usd: 1, mock: { output: { summary: 'mocked', disposition: 'complete' } }, next: 'gate' },
      { id: 'gate', kind: 'wait', approval: { from: 'owner', prompt: 'ok?' }, next: 'pause' },
      { id: 'pause', kind: 'wait', for: '1d', next: 'done' },
      { id: 'done', kind: 'end', output: '{{ steps.research.output.summary }}' },
    ], { budget: { run_usd: 5 } }))
    const createCard = vi.fn(() => 1)
    const e = engine({}, 'host', { createCard })
    const runId = start(e, flowId, {}, 'dry')
    await e.runNow(runId)
    expect(runRow(runId).status).toBe('succeeded')
    expect(JSON.parse(runRow(runId).output_json)).toBe('mocked')
    expect(createCard).not.toHaveBeenCalled()
    expect(openTokens(runId)).toHaveLength(0)
    expect(step(runId, 'gate')).toMatchObject({ status: 'succeeded', simulated: 'stub' })
  })
})
