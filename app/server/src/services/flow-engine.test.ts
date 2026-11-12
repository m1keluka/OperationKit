// Flow engine core (obj 900638, card B2 of docs/design/WORKFLOWS.md §8).
//
// Card acceptance, one describe each:
//   1. a 4-node flow runs to `succeeded` and writes one flow_step_runs row per node
//   2. killing the engine mid-run and restarting resumes without re-executing
//      completed nodes (asserted by call counter)
//   3. a `send`-class step in flight at crash goes to `waiting` (unknown outcome), not re-run
//   4. retries honour backoff
//   5. a scratch instance does not tick
// plus the kill switch, lease fencing, timeouts, branch memoisation and the
// idempotency key.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import type { FlowDefinition, FlowNode } from '../../../shared/flow/types.js'
import {
  FlowEngine, FlowStepError, saveFlowVersion, startFlowEngine, stopFlowEngine, flowEngineRunning,
  flowIdempotencyKey, backoffDelayMs, FLOW_HEARTBEAT_KEY, type FlowTool, type FlowToolContext,
} from './flow-engine.js'
import { initFlowSchema } from '../db/schema/flow.js'
import { recordFlowApprovals } from './flow-self-test.js'

// The initDb wiring test imports db/index.ts, whose import graph reaches node-pty.
// Nothing here opens a terminal; stub it so the suite does not need the native build.
vi.mock('node-pty', () => ({ spawn: () => { throw new Error('node-pty is not available in flow-engine tests') } }))

const T0 = Date.parse('2026-11-12T00:00:00.000Z')
const LEASE_TTL = 30_000

let db: Database.Database
let now: number
const clock = () => now

function freshDb(enabled = true): Database.Database {
  const d = new Database(':memory:')
  d.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  initFlowSchema(d)
  if (enabled) d.prepare("UPDATE settings SET value = '1' WHERE key = 'flows_enabled'").run()
  return d
}

function setEnabled(on: boolean) {
  db.prepare("UPDATE settings SET value = ? WHERE key = 'flows_enabled'").run(on ? '1' : '0')
}

function flow(nodes: FlowNode[], extra: Partial<FlowDefinition> = {}): FlowDefinition {
  return {
    apiVersion: 'okflow/1',
    id: 'test-flow',
    name: 'Test flow',
    version: 1,
    goal: { statement: 'test', end_condition: { assert: [{ expr: `steps.${nodes[1].id}.output != null` }] } },
    nodes,
    ...extra,
  }
}

/** A tool spy: records every call; `impl` decides the result per call number (1-based). */
function spyTool(impl: (n: number, input: unknown, ctx: FlowToolContext) => unknown | Promise<unknown>, meta: Partial<FlowTool> = {}) {
  const calls: { n: number; at: number; input: unknown; ctx: FlowToolContext }[] = []
  const tool: FlowTool = {
    ...meta,
    async run(input, ctx) {
      const n = calls.length + 1
      calls.push({ n, at: now, input, ctx })
      return impl(n, input, ctx)
    },
  }
  return { tool, calls }
}

function registry(map: Record<string, FlowTool>) {
  return { get: (slug: string) => map[slug] ?? null }
}

function engine(tools: Record<string, FlowTool>, owner: string) {
  return new FlowEngine({ db, tools: registry(tools), clock, owner, leaseTtlMs: LEASE_TTL, heartbeatMs: 60_000 })
}

function save(def: FlowDefinition): number {
  const r = saveFlowVersion(db, { workspace: 'acme', definition: def, author: 'user:1' })
  if (!r.ok) throw new Error(`save failed: ${r.reason} ${JSON.stringify(r.errors)}`)
  // B5: an `approvals` block typed into a definition is not authority; the
  // publish gate records the owner's approval. These engine tests stand in for it.
  if (def.approvals) recordFlowApprovals(db, r.flowId, def.approvals)
  return r.flowId
}

function start(e: FlowEngine, flowId: number, payload: unknown = {}): number {
  const r = e.startRun({ flowId, version: 1, trigger: { source: 'manual', payload } })
  if (!r.ok) throw new Error(`start failed: ${r.reason}`)
  return r.runId
}

const runRow = (id: number) => db.prepare('SELECT * FROM flow_runs WHERE id = ?').get(id) as Record<string, any>
const stepRows = (id: number) =>
  db.prepare('SELECT node_id, attempt, status, idempotency_key, output_json, error_json FROM flow_step_runs WHERE run_id = ? ORDER BY id').all(id) as Record<string, any>[]

/** A promise that never settles until `release()` — a Tool call "in flight". */
function gate<T = unknown>() {
  let release!: (v: T) => void
  let entered!: () => void
  const enteredP = new Promise<void>((r) => { entered = r })
  const p = new Promise<T>((r) => { release = r })
  return { p, release, entered, enteredP }
}

beforeEach(() => {
  now = T0
  db = freshDb()
})
afterEach(() => {
  stopFlowEngine()
  vi.useRealTimers()
  db.close()
})

// ── 1. four nodes → succeeded, one row per node ─────────────────────────────

describe('acceptance 1: a 4-node flow runs to succeeded with one flow_step_runs row per node', () => {
  it('trigger → tool → check → end', async () => {
    const fetch = spyTool((_n, input) => ({ rows: [{ id: 'a' }, { id: 'b' }], since: (input as any).since }))
    const flowId = save(flow([
      { id: 'start', kind: 'trigger', on: 'manual', next: 'fetch' },
      { id: 'fetch', kind: 'tool', tool: 'rows-list', effect: 'read', input: { since: '{{ trigger.payload.since }}' }, next: 'verify' },
      { id: 'verify', kind: 'check', assert: [{ expr: 'len(steps.fetch.output.rows) == 2', why: 'two rows' }], next: 'done' },
      { id: 'done', kind: 'end', output: '{{ steps.fetch.output.rows }}' },
    ]))
    const e = engine({ 'rows-list': fetch.tool }, 'host-a')
    const runId = start(e, flowId, { since: '2026-11-11' })
    expect(runRow(runId).status).toBe('queued')

    const { claimed } = await e.tick()
    expect(claimed).toEqual([runId])

    const run = runRow(runId)
    expect(run.status).toBe('succeeded')
    expect(JSON.parse(run.output_json)).toEqual([{ id: 'a' }, { id: 'b' }])
    expect(run.lease_owner).toBeNull()
    expect(run.ended_at).toBe(new Date(T0).toISOString())

    const steps = stepRows(runId)
    expect(steps.map((s) => s.node_id)).toEqual(['start', 'fetch', 'verify', 'done'])
    expect(steps.every((s) => s.status === 'succeeded' && s.attempt === 1)).toBe(true)
    expect(JSON.parse(steps[2].output_json)).toEqual({ passed: true, failed: [] })

    // input templating, and a read step carries no idempotency key
    expect(fetch.calls).toHaveLength(1)
    expect(fetch.calls[0].input).toEqual({ since: '2026-11-11' })
    expect(fetch.calls[0].ctx.idempotencyKey).toBeNull()
    expect(steps[1].idempotency_key).toBeNull()

    // a finished run is never picked up again
    await e.tick()
    expect(fetch.calls).toHaveLength(1)
    expect(stepRows(runId)).toHaveLength(4)
  })

  it('a failing check fails the run with check_failed and is not retried', async () => {
    const fetch = spyTool(() => ({ rows: [] }))
    const flowId = save(flow([
      { id: 'start', kind: 'trigger', on: 'manual', next: 'fetch' },
      { id: 'fetch', kind: 'tool', tool: 'rows-list', effect: 'read', next: 'verify' },
      { id: 'verify', kind: 'check', assert: [{ expr: 'len(steps.fetch.output.rows) > 0', why: 'nothing fetched' }], next: 'done' },
      { id: 'done', kind: 'end' },
    ]))
    const e = engine({ 'rows-list': fetch.tool }, 'host-a')
    const runId = start(e, flowId)
    await e.tick()
    const run = runRow(runId)
    expect(run.status).toBe('failed')
    expect(JSON.parse(run.error_json)).toMatchObject({ type: 'check_failed', node_id: 'verify' })
    expect(stepRows(runId).map((s) => `${s.node_id}:${s.status}`)).toEqual(['start:succeeded', 'fetch:succeeded', 'verify:failed'])
  })
})

// ── 2. crash + restart resumes without re-executing completed nodes ─────────

const TWO_WRITES: FlowNode[] = [
  { id: 'start', kind: 'trigger', on: 'manual', next: 'first' },
  { id: 'first', kind: 'tool', tool: 'step-one', effect: 'write', next: 'second' },
  { id: 'second', kind: 'tool', tool: 'step-two', effect: 'write', input: { from: '{{ steps.first.output.value }}' }, next: 'done' },
  { id: 'done', kind: 'end', output: '{{ steps.second.output }}' },
]

describe('acceptance 2: kill mid-run + restart resumes without re-executing completed nodes', () => {
  it('replays memoised steps and re-runs only the step that was in flight', async () => {
    const inFlight = gate()
    const first = spyTool(() => ({ value: 41 }))
    const second = spyTool(async (n, input) => {
      if (n === 1) { inFlight.entered(); return inFlight.p } // engine A dies while this is in flight
      return { got: (input as any).from, n }
    })
    const tools = { 'step-one': first.tool, 'step-two': second.tool }
    const flowId = save(flow(TWO_WRITES))

    const a = engine(tools, 'host-a')
    const runId = start(a, flowId)
    const aTick = a.tick()
    await inFlight.enteredP
    a.kill() // process death: no more heartbeats, every later write by A is fenced off
    await aTick

    expect(runRow(runId)).toMatchObject({ status: 'running', lease_owner: 'host-a' })
    expect(stepRows(runId).map((s) => `${s.node_id}:${s.status}`)).toEqual(['start:succeeded', 'first:succeeded', 'second:running'])

    // A fresh process boots. The dead owner's lease is still live → nothing to claim yet.
    const b = engine(tools, 'host-b')
    expect((await b.resumeOnBoot()).claimed).toEqual([])

    now += LEASE_TTL + 1 // the lease expires
    expect((await b.resumeOnBoot()).claimed).toEqual([runId])

    const run = runRow(runId)
    expect(run.status).toBe('succeeded')
    expect(JSON.parse(run.output_json)).toEqual({ got: 41, n: 2 }) // memoised `first` output fed `second`
    expect(first.calls).toHaveLength(1) // completed node NOT re-executed
    expect(second.calls).toHaveLength(2) // the in-flight one ran again

    const steps = stepRows(runId)
    expect(steps.map((s) => `${s.node_id}:${s.attempt}:${s.status}`)).toEqual([
      'start:1:succeeded', 'first:1:succeeded', 'second:1:interrupted', 'second:2:succeeded', 'done:1:succeeded',
    ])
    // idempotency key is stable across the attempt that crashed and the retry
    const key = flowIdempotencyKey(runId, 'second')
    expect(second.calls.map((c) => c.ctx.idempotencyKey)).toEqual([key, key])
    expect(steps.filter((s) => s.node_id === 'second').map((s) => s.idempotency_key)).toEqual([key, key])
  })

  it('fences a stale engine: once another engine took the lease, the old one writes nothing', async () => {
    const inFlight = gate<{ late: true }>()
    const first = spyTool(() => ({ value: 1 }))
    const second = spyTool(async (n) => {
      if (n === 1) { inFlight.entered(); return inFlight.p }
      return { fresh: true }
    })
    const tools = { 'step-one': first.tool, 'step-two': second.tool }
    const flowId = save(flow(TWO_WRITES))

    const a = engine(tools, 'host-a')
    const runId = start(a, flowId)
    const aTick = a.tick()
    await inFlight.enteredP
    // A is NOT killed — it is just stuck past its lease (e.g. a starved event loop).
    now += LEASE_TTL + 1
    const b = engine(tools, 'host-b')
    await b.tick()
    expect(runRow(runId).status).toBe('succeeded')
    const before = stepRows(runId)

    inFlight.release({ late: true }) // A's call finally returns
    await aTick
    expect(stepRows(runId)).toEqual(before) // A's late result was not recorded
    expect(runRow(runId)).toMatchObject({ status: 'succeeded', output_json: JSON.stringify({ fresh: true }) })
  })
})

// ── 3. send-class step in flight at crash → waiting, not re-run ─────────────

const SEND_FLOW = (idempotency?: 'none'): FlowDefinition => flow([
  { id: 'start', kind: 'trigger', on: 'manual', next: 'fetch' },
  { id: 'fetch', kind: 'tool', tool: 'rows-list', effect: 'read', next: 'notify' },
  { id: 'notify', kind: 'tool', tool: 'post-message', effect: 'send', input: { text: 'hi' }, ...(idempotency ? { idempotency } : {}), next: 'done' },
  { id: 'done', kind: 'end', output: '{{ steps.notify.output }}' },
], { approvals: { version: 1, nodes: ['notify'], by: 'user:1', at: '2026-11-12T00:00:00Z' } })

async function crashDuringNotify(notifyMeta: Partial<FlowTool> = {}, idempotency?: 'none') {
  const inFlight = gate()
  const fetch = spyTool(() => ({ rows: [1] }))
  const notify = spyTool(async (n) => {
    if (n === 1) { inFlight.entered(); return inFlight.p }
    return { ok: true, n }
  }, notifyMeta)
  const tools = { 'rows-list': fetch.tool, 'post-message': notify.tool }
  const flowId = save(SEND_FLOW(idempotency))
  const a = engine(tools, 'host-a')
  const runId = start(a, flowId)
  const aTick = a.tick()
  await inFlight.enteredP
  a.kill()
  await aTick
  now += LEASE_TTL + 1
  const b = engine(tools, 'host-b')
  await b.resumeOnBoot()
  return { runId, b, fetch, notify }
}

describe('acceptance 3: a send-class step in flight at crash goes to waiting (unknown outcome), not re-run', () => {
  it('parks the run on an unknown-outcome approval and never calls the send Tool again', async () => {
    const { runId, b, fetch, notify } = await crashDuringNotify()

    expect(notify.calls).toHaveLength(1) // NOT re-run
    expect(fetch.calls).toHaveLength(1)
    const run = runRow(runId)
    expect(run.status).toBe('waiting')
    expect(run.lease_owner).toBeNull()

    const notifyRows = stepRows(runId).filter((s) => s.node_id === 'notify')
    expect(notifyRows).toHaveLength(1)
    expect(notifyRows[0].status).toBe('unknown')
    expect(JSON.parse(notifyRows[0].error_json)).toMatchObject({ type: 'unknown_outcome', node_id: 'notify' })

    const tokens = db.prepare('SELECT * FROM flow_wait_tokens WHERE run_id = ?').all(runId) as Record<string, any>[]
    expect(tokens).toHaveLength(1)
    expect(tokens[0]).toMatchObject({ node_id: 'notify', kind: 'approval', reason: 'unknown_outcome', resolved_at: null })
    expect(tokens[0].token_hash).toMatch(/^[0-9a-f]{64}$/) // stored hashed

    // more ticks, even much later, leave a waiting run alone
    now += 3_600_000
    expect((await b.tick()).claimed).toEqual([])
    expect(notify.calls).toHaveLength(1)
  })

  it('owner confirms it was sent → the run continues after the step without re-sending', async () => {
    const { runId, b, notify } = await crashDuringNotify()
    expect(b.resolveUnknownOutcome({ runId, nodeId: 'notify', outcome: 'sent', by: 'user:1', output: { ok: true, confirmed: true } })).toEqual({ ok: true })
    await b.tick()
    expect(runRow(runId).status).toBe('succeeded')
    expect(JSON.parse(runRow(runId).output_json)).toEqual({ ok: true, confirmed: true })
    expect(notify.calls).toHaveLength(1)
    const tok = db.prepare('SELECT resolved_by, resolution FROM flow_wait_tokens WHERE run_id = ?').get(runId)
    expect(tok).toEqual({ resolved_by: 'user:1', resolution: 'sent' })
  })

  it('owner says it was not sent → the step runs again', async () => {
    const { runId, b, notify } = await crashDuringNotify()
    b.resolveUnknownOutcome({ runId, nodeId: 'notify', outcome: 'not_sent', by: 'user:1' })
    await b.tick()
    expect(runRow(runId).status).toBe('succeeded')
    expect(notify.calls).toHaveLength(2)
  })

  it('a send Tool that declares idempotency support IS re-run, with the same idempotency key', async () => {
    const { runId, notify } = await crashDuringNotify({ idempotent: true })
    expect(runRow(runId).status).toBe('succeeded')
    expect(notify.calls).toHaveLength(2)
    const key = flowIdempotencyKey(runId, 'notify')
    expect(notify.calls.map((c) => c.ctx.idempotencyKey)).toEqual([key, key])
  })

  it('…unless the node opted out with idempotency: none', async () => {
    const { runId, notify } = await crashDuringNotify({ idempotent: true }, 'none')
    expect(runRow(runId).status).toBe('waiting')
    expect(notify.calls).toHaveLength(1)
    expect(notify.calls[0].ctx.idempotencyKey).toBeNull()
  })
})

// ── 4. retries honour backoff ───────────────────────────────────────────────

describe('acceptance 4: retries honour backoff', () => {
  const RETRY_FLOW = (retry: FlowNode['retry'], timeout_ms?: number): FlowDefinition => flow([
    { id: 'start', kind: 'trigger', on: 'manual', next: 'fetch' },
    { id: 'fetch', kind: 'tool', tool: 'flaky', effect: 'read', retry, ...(timeout_ms ? { timeout_ms } : {}), next: 'done' },
    { id: 'done', kind: 'end', output: '{{ steps.fetch.output }}' },
  ])

  it('exponential: waits delay_ms, then 2×delay_ms, and never calls early', async () => {
    const flaky = spyTool((n) => {
      if (n < 3) throw new Error(`boom ${n}`)
      return { ok: true }
    })
    const flowId = save(RETRY_FLOW({ max: 3, backoff: 'exponential', delay_ms: 1000 }))
    const e = engine({ flaky: flaky.tool }, 'host-a')
    const runId = start(e, flowId)

    await e.tick() // attempt 1 fails at T0
    expect(flaky.calls).toHaveLength(1)
    expect(runRow(runId)).toMatchObject({ status: 'running', lease_owner: null, next_attempt_at: new Date(T0 + 1000).toISOString() })

    now = T0 + 999
    expect((await e.tick()).claimed).toEqual([])
    expect(flaky.calls).toHaveLength(1)

    now = T0 + 1000
    await e.tick() // attempt 2 fails
    expect(flaky.calls).toHaveLength(2)
    expect(runRow(runId).next_attempt_at).toBe(new Date(T0 + 1000 + 2000).toISOString())

    now = T0 + 2999
    await e.tick()
    expect(flaky.calls).toHaveLength(2)

    now = T0 + 3000
    await e.tick() // attempt 3 succeeds
    expect(flaky.calls.map((c) => c.at - T0)).toEqual([0, 1000, 3000])
    expect(runRow(runId).status).toBe('succeeded')
    expect(stepRows(runId).filter((s) => s.node_id === 'fetch').map((s) => `${s.attempt}:${s.status}`)).toEqual(['1:failed', '2:failed', '3:succeeded'])
  })

  it('fixed backoff, attempts exhausted → run failed with the last error', async () => {
    const flaky = spyTool(() => { throw new FlowStepError('upstream_503', 'service unavailable') })
    const flowId = save(RETRY_FLOW({ max: 3, backoff: 'fixed', delay_ms: 500 }))
    const e = engine({ flaky: flaky.tool }, 'host-a')
    const runId = start(e, flowId)
    for (const t of [0, 250, 500, 750, 1000, 5000]) {
      now = T0 + t
      await e.tick()
    }
    expect(flaky.calls.map((c) => c.at - T0)).toEqual([0, 500, 1000])
    expect(runRow(runId).status).toBe('failed')
    expect(JSON.parse(runRow(runId).error_json)).toMatchObject({ type: 'upstream_503', node_id: 'fetch' })
  })

  it('backoff survives a restart (it lives in flow_runs.next_attempt_at, not a timer)', async () => {
    const flaky = spyTool((n) => { if (n === 1) throw new Error('first'); return { ok: 1 } })
    const flowId = save(RETRY_FLOW({ max: 2, backoff: 'fixed', delay_ms: 10_000 }))
    const a = engine({ flaky: flaky.tool }, 'host-a')
    const runId = start(a, flowId)
    await a.tick()
    a.kill()
    const b = engine({ flaky: flaky.tool }, 'host-b')
    now = T0 + 9_999
    await b.resumeOnBoot()
    expect(flaky.calls).toHaveLength(1)
    now = T0 + 10_000
    await b.tick()
    expect(flaky.calls).toHaveLength(2)
    expect(runRow(runId).status).toBe('succeeded')
  })

  it('a non-retryable FlowStepError fails immediately', async () => {
    const flaky = spyTool(() => { throw new FlowStepError('bad_request', 'invalid input', false) })
    const flowId = save(RETRY_FLOW({ max: 5, backoff: 'fixed', delay_ms: 1 }))
    const e = engine({ flaky: flaky.tool }, 'host-a')
    const runId = start(e, flowId)
    now = T0; await e.tick()
    now = T0 + 10; await e.tick()
    expect(flaky.calls).toHaveLength(1)
    expect(runRow(runId).status).toBe('failed')
  })

  it('a step that exceeds timeout_ms fails with type timeout and its signal is aborted', async () => {
    let aborted = false
    const slow = spyTool((_n, _i, ctx) => new Promise(() => { ctx.signal.addEventListener('abort', () => { aborted = true }) }))
    const flowId = save(RETRY_FLOW({ max: 1, backoff: 'fixed', delay_ms: 1 }, 20))
    const e = engine({ flaky: slow.tool }, 'host-a')
    const runId = start(e, flowId)
    await e.tick()
    expect(aborted).toBe(true)
    expect(runRow(runId).status).toBe('failed')
    expect(JSON.parse(runRow(runId).error_json)).toMatchObject({ type: 'timeout', node_id: 'fetch' })
  })

  it('defaults: 3 attempts, exponential from 2 s', () => {
    expect([1, 2, 3].map((f) => backoffDelayMs({}, f))).toEqual([2000, 4000, 8000])
    expect(backoffDelayMs({ retry: { max: 3, backoff: 'fixed', delay_ms: 700 } }, 3)).toBe(700)
  })
})

// ── 5. scratch instance does not tick ───────────────────────────────────────

describe('acceptance 5: a scratch instance does not tick', () => {
  it('CC_SCRATCH_SERVER verdict → no timer armed, queued run never executes', async () => {
    vi.useFakeTimers()
    const tool = spyTool(() => ({ rows: [] }))
    const flowId = save(flow([
      { id: 'start', kind: 'trigger', on: 'manual', next: 'fetch' },
      { id: 'fetch', kind: 'tool', tool: 't', effect: 'read', next: 'done' },
      { id: 'done', kind: 'end' },
    ]))
    const e = engine({ t: tool.tool }, 'scratch')
    const runId = start(e, flowId)
    const started = await startFlowEngine({ scratch: { scratch: true, reason: 'CC_SCRATCH_SERVER/OK_SCRATCH set' }, engine: e, tickMs: 50 })
    expect(started).toBe(false)
    expect(flowEngineRunning()).toBe(false)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(tool.calls).toHaveLength(0)
    expect(runRow(runId).status).toBe('queued')
    expect(db.prepare('SELECT value FROM settings WHERE key = ?').get(FLOW_HEARTBEAT_KEY)).toBeUndefined()
  })

  it('with no injected verdict it detects the scratch/test process itself and does not start', async () => {
    const e = engine({}, 'auto')
    expect(await startFlowEngine({ engine: e })).toBe(false) // NODE_ENV=test / VITEST ⇒ scratch
    expect(flowEngineRunning()).toBe(false)
  })

  it('control: the real host DOES tick and resumes queued runs on boot', async () => {
    const tool = spyTool(() => ({ rows: [] }))
    const flowId = save(flow([
      { id: 'start', kind: 'trigger', on: 'manual', next: 'fetch' },
      { id: 'fetch', kind: 'tool', tool: 't', effect: 'read', next: 'done' },
      { id: 'done', kind: 'end' },
    ]))
    const e = engine({ t: tool.tool }, 'host')
    const runId = start(e, flowId)
    expect(await startFlowEngine({ scratch: { scratch: false, reason: null }, engine: e, tickMs: 50 })).toBe(true)
    expect(flowEngineRunning()).toBe(true)
    await vi.waitFor(() => expect(runRow(runId).status).toBe('succeeded'))
    expect(tool.calls).toHaveLength(1)
    stopFlowEngine()
    expect(flowEngineRunning()).toBe(false)
  })
})

// ── kill switch ─────────────────────────────────────────────────────────────

describe('settings.flows_enabled kill switch', () => {
  it('defaults OFF on a fresh schema', () => {
    const d = freshDb(false)
    expect(d.prepare("SELECT value FROM settings WHERE key = 'flows_enabled'").get()).toEqual({ value: '0' })
    initFlowSchema(d) // idempotent, and never flips an operator's choice
    expect(d.prepare("SELECT value FROM settings WHERE key = 'flows_enabled'").get()).toEqual({ value: '0' })
    d.close()
  })

  it('off: startRun is refused and a tick only writes the heartbeat', async () => {
    const tool = spyTool(() => ({}))
    const flowId = save(flow([
      { id: 'start', kind: 'trigger', on: 'manual', next: 'fetch' },
      { id: 'fetch', kind: 'tool', tool: 't', effect: 'read', next: 'done' },
      { id: 'done', kind: 'end' },
    ]))
    const e = engine({ t: tool.tool }, 'host')
    const runId = start(e, flowId) // queued while on
    setEnabled(false)
    expect(e.startRun({ flowId, version: 1 })).toEqual({ ok: false, reason: 'flows_disabled' })
    expect((await e.tick()).claimed).toEqual([])
    expect(tool.calls).toHaveLength(0)
    expect(runRow(runId).status).toBe('queued')
    expect(db.prepare('SELECT value FROM settings WHERE key = ?').get(FLOW_HEARTBEAT_KEY)).toEqual({ value: new Date(T0).toISOString() })
    setEnabled(true)
    await e.tick()
    expect(runRow(runId).status).toBe('succeeded')
  })
})

// ── branch memoisation, concurrency, unsupported kinds ──────────────────────

describe('branch / concurrency / scope edges', () => {
  const BRANCH_FLOW = flow([
    { id: 'start', kind: 'trigger', on: 'manual', next: 'route' },
    {
      id: 'route', kind: 'branch',
      cases: [{ when: 'trigger.payload.kind == "big"', then: ['big_one', 'big_two'] }],
      default: 'small', next: 'done',
    },
    { id: 'big_one', kind: 'tool', tool: 'big', effect: 'read' },
    { id: 'big_two', kind: 'tool', tool: 'big', effect: 'read' },
    { id: 'small', kind: 'tool', tool: 'small', effect: 'read' },
    { id: 'done', kind: 'end', output: '{{ steps.route.output.case }}' },
  ], { goal: { statement: 'x', end_condition: { assert: [{ expr: 'steps.route.output != null' }] } } })

  it('runs only the chosen block and memoises the decision', async () => {
    const big = spyTool(() => ({ ok: 1 }))
    const small = spyTool(() => ({ ok: 2 }))
    const flowId = save(BRANCH_FLOW)
    const e = engine({ big: big.tool, small: small.tool }, 'host')
    const r1 = start(e, flowId, { kind: 'big' })
    const r2 = start(e, flowId, { kind: 'tiny' })
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('flow_per_flow_concurrent_runs', '1')").run()
    await e.tick() // per-flow cap 1: only r1
    expect(runRow(r1).status).toBe('succeeded')
    expect(runRow(r2).status).toBe('queued')
    await e.tick()
    expect(runRow(r2).status).toBe('succeeded')

    expect(stepRows(r1).map((s) => s.node_id)).toEqual(['start', 'route', 'big_one', 'big_two', 'done'])
    expect(JSON.parse(stepRows(r1)[1].output_json)).toEqual({ case: 0, block: ['big_one', 'big_two'] })
    expect(JSON.parse(runRow(r1).output_json)).toBe(0)
    expect(stepRows(r2).map((s) => s.node_id)).toEqual(['start', 'route', 'small', 'done'])
    expect(JSON.parse(runRow(r2).output_json)).toBe('default')
    expect(big.calls).toHaveLength(2)
    expect(small.calls).toHaveLength(1)
  })

  // B9 made agent/wait executable; a loop nested in a loop body is the one shape
  // the engine still refuses — loudly, never skipped.
  it('a nested loop fails loudly with unsupported_node_kind (never skipped)', async () => {
    const flowId = save(flow([
      { id: 'start', kind: 'trigger', on: 'manual', next: 'outer' },
      { id: 'outer', kind: 'loop', over: '{{ trigger.payload.rows }}', as: 'r', max_items: 5, body: ['inner'], next: 'done' },
      { id: 'inner', kind: 'loop', over: '{{ item.r.cells }}', as: 'c', max_items: 5, body: ['noop'] },
      { id: 'noop', kind: 'check', assert: [{ expr: 'true' }] },
      { id: 'done', kind: 'end' },
    ], { goal: { statement: 'x', end_condition: { assert: [{ expr: 'steps.outer.output != null' }] } } }))
    const e = engine({}, 'host')
    const runId = start(e, flowId, { rows: [{ cells: [1] }] })
    await e.tick()
    expect(runRow(runId).status).toBe('failed')
    expect(JSON.parse(runRow(runId).error_json)).toMatchObject({ type: 'unsupported_node_kind', node_id: 'inner' })
  })

  it('an unregistered Tool fails the run without retries', async () => {
    const flowId = save(flow([
      { id: 'start', kind: 'trigger', on: 'manual', next: 'fetch' },
      { id: 'fetch', kind: 'tool', tool: 'nope', effect: 'read', next: 'done' },
      { id: 'done', kind: 'end' },
    ]))
    const e = engine({}, 'host')
    const runId = start(e, flowId)
    await e.tick()
    expect(JSON.parse(runRow(runId).error_json)).toMatchObject({ type: 'unknown_tool' })
    expect(stepRows(runId).filter((s) => s.node_id === 'fetch')).toHaveLength(1)
  })

  it('redacts serialised step I/O through the injected redactor', async () => {
    // Low-entropy marker, not a real-shaped credential: the OSS publish gate runs gitleaks over tests too.
    const leaky = spyTool(() => ({ echoed: 'xx-redact-me-xx' }))
    const flowId = save(flow([
      { id: 'start', kind: 'trigger', on: 'manual', next: 'fetch' },
      { id: 'fetch', kind: 'tool', tool: 'leaky', effect: 'read', next: 'done' },
      { id: 'done', kind: 'end' },
    ]))
    const e = new FlowEngine({ db, tools: registry({ leaky: leaky.tool }), clock, owner: 'h', redact: (t) => t.replace(/xx-redact-me-xx/g, '[REDACTED:K]') })
    const runId = start(e, flowId)
    await e.tick()
    expect(stepRows(runId)[1].output_json).toBe('{"echoed":"[REDACTED:K]"}')
  })
})

describe('saveFlowVersion', () => {
  const DEF = flow([
    { id: 'start', kind: 'trigger', on: 'manual', next: 'fetch' },
    { id: 'fetch', kind: 'tool', tool: 't', effect: 'read', next: 'done' },
    { id: 'done', kind: 'end' },
  ])

  it('versions are immutable; identical re-save is a no-op', () => {
    const a = saveFlowVersion(db, { workspace: 'acme', definition: DEF, author: 'user:1' })
    expect(a).toMatchObject({ ok: true, created: true, version: 1 })
    expect(saveFlowVersion(db, { workspace: 'acme', definition: DEF, author: 'user:1' })).toMatchObject({ ok: true, created: false })
    expect(saveFlowVersion(db, { workspace: 'acme', definition: { ...DEF, name: 'changed' }, author: 'user:1' }))
      .toEqual({ ok: false, reason: 'version_immutable' })
    const row = db.prepare('SELECT workspace, slug FROM flow_definitions').get()
    expect(row).toEqual({ workspace: 'acme', slug: 'test-flow' })
  })

  it('refuses an invalid definition and a workspace mismatch', () => {
    const bad = saveFlowVersion(db, { workspace: 'acme', definition: { ...DEF, nodes: DEF.nodes.slice(1) }, author: 'user:1' })
    expect(bad).toMatchObject({ ok: false, reason: 'invalid_definition' })
    expect(saveFlowVersion(db, { workspace: 'acme', definition: { ...DEF, workspace: 'other' }, author: 'user:1' }))
      .toEqual({ ok: false, reason: 'workspace_mismatch' })
    expect(saveFlowVersion(db, { workspace: '', definition: DEF, author: 'user:1' })).toEqual({ ok: false, reason: 'workspace_required' })
  })
})

describe('initDb wiring', () => {
  it('the real initDb creates the flow_* tables and switches flows_enabled on once (obj 900675)', async () => {
    const { initDb } = await import('../db/index.js')
    const real = initDb()
    const tables = (real.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'flow_%' ORDER BY name").all() as { name: string }[]).map((t) => t.name)
    expect(tables).toEqual(['flow_builder_attempts', 'flow_definitions', 'flow_repairs', 'flow_runs', 'flow_self_tests', 'flow_step_runs', 'flow_versions', 'flow_wait_tokens'])
    expect(real.prepare("SELECT value FROM settings WHERE key = 'flows_enabled'").get()).toEqual({ value: '1' })
    expect(real.prepare("SELECT value FROM settings WHERE key = 'flows_enabled_default_on_applied'").get()).toEqual({ value: '1' })
  })
})
