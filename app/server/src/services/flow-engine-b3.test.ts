// Flow engine, card B3 (obj 900639, docs/design/WORKFLOWS.md §8): llm + mcp nodes, budgets.
//
// Card acceptance (stub backends — no model, no network):
//   1. schema-invalid LLM output retries, then fails with a typed error
//   2. a run exceeding budget.run_usd stops before the next spending node with
//      status=failed, error.type=budget
//   3. an mcp node gets a 403-equivalent error for a connector it cannot resolve
//      in its own workspace (the REAL workspace resolver is exercised against a
//      real DB + stub MCP server in flow-mcp-workspace.test.ts)
// plus max_iterations (self-correction + the read-only tool loop), job-accounting
// ceilings (workspace, home card, policy), and the spend ledger.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import type { FlowDefinition, FlowNode } from '../../../shared/flow/types.js'
import { FlowEngine, saveFlowVersion, type FlowEngineEvent, type FlowTool } from './flow-engine.js'
import { initFlowSchema } from '../db/schema/flow.js'
import { recordFlowApprovals } from './flow-self-test.js'
import { initJobAccountingSchema } from '../db/schema/job-accounting.js'
import { getSpend, recordSpend, setObjectiveCeiling } from './job-accounting.js'
import type { BackendRequest, LlmBackend } from './llm-gateway/claude-cli-backend.js'
import { connectorForbidden, type FlowMcpResolver } from './flow-mcp.js'
import { DEFAULT_MODEL } from './llm-gateway/translate.js'

const T0 = Date.parse('2026-11-12T00:00:00.000Z')
let db: Database.Database
let now: number
const clock = () => now

const CATEGORY_SCHEMA = {
  type: 'object',
  properties: { category: { enum: ['sales', 'support', 'other'] } },
  required: ['category'],
  additionalProperties: false,
}
const FAST_RETRY = { max: 3, backoff: 'fixed' as const, delay_ms: 1000 }

function freshDb(): Database.Database {
  const d = new Database(':memory:')
  d.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  initFlowSchema(d)
  initJobAccountingSchema(d)
  d.prepare("UPDATE settings SET value = '1' WHERE key = 'flows_enabled'").run()
  return d
}

const setSetting = (k: string, v: string) =>
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, v)

function flow(nodes: FlowNode[], extra: Partial<FlowDefinition> = {}): FlowDefinition {
  return {
    apiVersion: 'okflow/1',
    id: 'b3-flow',
    name: 'B3 flow',
    version: 1,
    goal: { statement: 'test', end_condition: { assert: [{ expr: `steps.${nodes[1].id}.output != null` }] } },
    budget: { run_usd: 1 },
    nodes,
    ...extra,
  }
}

/** Stub llm-gateway backend: `reply(n, req)` decides the n-th call's text and cost. */
function stubLlm(reply: (n: number, req: BackendRequest) => string | { text: string; cost: number }) {
  const calls: BackendRequest[] = []
  const backend: LlmBackend = async (req) => {
    calls.push(req)
    const r = reply(calls.length, req)
    const { text, cost } = typeof r === 'string' ? { text: r, cost: 0.01 } : r
    return { text, usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }, stopReason: 'end_turn', slot: 'stub', costUsd: cost, ttftMs: 1, attempts: 1 }
  }
  return { backend, calls }
}

function spyTool(impl: (input: unknown) => unknown, meta: Partial<FlowTool> = {}) {
  const calls: unknown[] = []
  const tool: FlowTool = { ...meta, async run(input) { calls.push(input); return impl(input) } }
  return { tool, calls }
}

function engine(opts: { tools?: Record<string, FlowTool>; llm?: LlmBackend; mcp?: FlowMcpResolver; events?: FlowEngineEvent[] } = {}) {
  return new FlowEngine({
    db,
    tools: { get: (s) => opts.tools?.[s] ?? null },
    llm: opts.llm,
    mcp: opts.mcp,
    clock,
    owner: 'b3',
    leaseTtlMs: 30_000,
    heartbeatMs: 60_000,
    onEvent: (e) => opts.events?.push(e),
  })
}

function startFlow(e: FlowEngine, def: FlowDefinition, opts: { workspace?: string; objectiveId?: number; payload?: unknown } = {}): number {
  const saved = saveFlowVersion(db, { workspace: opts.workspace ?? 'acme', definition: def, author: 'user:1' })
  if (!saved.ok) throw new Error(`save failed: ${saved.reason} ${JSON.stringify(saved.errors)}`)
  // B5: only a RECORDED owner approval counts (the publish gate writes it); stand in for it here.
  if (def.approvals) recordFlowApprovals(db, saved.flowId, def.approvals)
  const r = e.startRun({ flowId: saved.flowId, version: 1, trigger: { source: 'manual', payload: opts.payload ?? { note: 'what does the pro plan cost?' } }, objectiveId: opts.objectiveId ?? null })
  if (!r.ok) throw new Error(`start failed: ${r.reason}`)
  return r.runId
}

/** Tick until the run settles, jumping the clock over each durable backoff. */
async function runToEnd(e: FlowEngine, runId: number): Promise<Record<string, any>> {
  for (let i = 0; i < 30; i++) {
    await e.tick()
    const row = runRow(runId)
    if (['succeeded', 'failed', 'waiting', 'cancelled'].includes(row.status)) return row
    if (row.next_attempt_at) now = Math.max(now, Date.parse(row.next_attempt_at))
  }
  throw new Error('run did not settle')
}

const runRow = (id: number) => db.prepare('SELECT * FROM flow_runs WHERE id = ?').get(id) as Record<string, any>
const steps = (id: number) =>
  db.prepare('SELECT node_id, attempt, status, cost_usd, output_json, error_json FROM flow_step_runs WHERE run_id = ? ORDER BY id').all(id) as Record<string, any>[]
const err = (row: Record<string, any>) => JSON.parse(row.error_json ?? 'null')

beforeEach(() => {
  now = T0
  db = freshDb()
})
afterEach(() => db.close())

const classify = (extra: Partial<FlowNode> = {}): FlowNode => ({
  id: 'classify', kind: 'llm', prompt: 'Classify this note: {{ trigger.payload.note }}',
  output_schema: CATEGORY_SCHEMA, retry: FAST_RETRY, next: 'done', ...extra,
} as FlowNode)
const end: FlowNode = { id: 'done', kind: 'end', output: '{{ steps.classify.output }}' }
const start = (next = 'classify'): FlowNode => ({ id: 'start', kind: 'trigger', on: 'manual', next })

// ── 1. schema-invalid output retries, then fails with a typed error ─────────

describe('acceptance 1: schema-invalid LLM output retries then fails with a typed error', () => {
  it('every attempt invalid → 3 attempts (durable backoff) → run failed, error.type = llm_output_invalid', async () => {
    const llm = stubLlm(() => '{"category": "weather"}')
    const e = engine({ llm: llm.backend })
    const runId = startFlow(e, flow([start(), classify(), end]))

    // First tick: attempt 1 fails and the run is parked for the backoff, not failed.
    await e.tick()
    expect(runRow(runId).status).toBe('running')
    expect(runRow(runId).next_attempt_at).toBe(new Date(T0 + 1000).toISOString())

    const run = await runToEnd(e, runId)
    expect(run.status).toBe('failed')
    expect(llm.calls).toHaveLength(3)
    const error = err(run)
    expect(error).toMatchObject({ type: 'llm_output_invalid', node_id: 'classify', retryable: true })
    expect(error.detail).toMatch(/\$\.category: must be one of \["sales","support","other"\]/)
    expect(error.issues[0]).toMatchObject({ path: '$.category' })

    const rows = steps(runId).filter((s) => s.node_id === 'classify')
    expect(rows.map((r) => [r.attempt, r.status, err(r).type])).toEqual([
      [1, 'failed', 'llm_output_invalid'], [2, 'failed', 'llm_output_invalid'], [3, 'failed', 'llm_output_invalid'],
    ])
    expect(steps(runId).some((s) => s.node_id === 'done')).toBe(false)
    // Each attempt's spend is on its own row and on the run.
    expect(rows.map((r) => r.cost_usd)).toEqual([0.01, 0.01, 0.01])
    expect(run.spent_usd).toBeCloseTo(0.03, 10)
  })

  it('a non-JSON reply is schema-invalid too (typed, not a crash)', async () => {
    const llm = stubLlm(() => 'Sure! I think this is about sales.')
    const e = engine({ llm: llm.backend })
    const run = await runToEnd(e, startFlow(e, flow([start(), classify({ retry: { max: 2, backoff: 'fixed', delay_ms: 10 } }), end])))
    expect(run.status).toBe('failed')
    expect(llm.calls).toHaveLength(2)
    expect(err(run)).toMatchObject({ type: 'llm_output_invalid', detail: '$: reply is not JSON' })
  })

  it('invalid on attempt 1, valid on attempt 2 → succeeded; the output is the parsed JSON and feeds the next node', async () => {
    const llm = stubLlm((n) => (n === 1 ? '{"category": 7}' : '```json\n{"category": "sales"}\n```'))
    const e = engine({ llm: llm.backend })
    const runId = startFlow(e, flow([start(), classify(), end]))
    const run = await runToEnd(e, runId)
    expect(run.status).toBe('succeeded')
    expect(JSON.parse(run.output_json)).toEqual({ category: 'sales' })
    expect(steps(runId).filter((s) => s.node_id === 'classify').map((s) => s.status)).toEqual(['failed', 'succeeded'])
    // The model saw the resolved prompt, the schema in the system prompt and the default model.
    expect(llm.calls[0].prompt).toContain('Classify this note: what does the pro plan cost?')
    expect(llm.calls[0].systemPrompt).toContain(JSON.stringify(CATEGORY_SCHEMA))
    expect(llm.calls[0].model).toBe(DEFAULT_MODEL)
  })

  it('a succeeded llm step is memoised: a re-walk replays its output and never calls the model again', async () => {
    const llm = stubLlm(() => '{"category": "support"}')
    const e = engine({ llm: llm.backend })
    const runId = startFlow(e, flow([start(), classify(), end]))
    await runToEnd(e, runId)
    // Force a second walk of the finished run (as a resume would).
    db.prepare("UPDATE flow_runs SET status = 'running' WHERE id = ?").run(runId)
    await e.tick()
    expect(llm.calls).toHaveLength(1)
    expect(runRow(runId).status).toBe('succeeded')
  })

  it('an unsupported model fails at once, non-retryable, without calling the backend', async () => {
    const llm = stubLlm(() => '{"category": "sales"}')
    const e = engine({ llm: llm.backend })
    const run = await runToEnd(e, startFlow(e, flow([start(), classify({ model: 'gpt-4o' } as Partial<FlowNode>), end])))
    expect(run.status).toBe('failed')
    expect(err(run)).toMatchObject({ type: 'llm_model_unsupported', retryable: false })
    expect(llm.calls).toHaveLength(0)
  })

  it('no backend configured → llm_unavailable (never a silent skip)', async () => {
    const e = engine()
    const run = await runToEnd(e, startFlow(e, flow([start(), classify(), end])))
    expect(err(run)).toMatchObject({ type: 'llm_unavailable', node_id: 'classify' })
  })
})

// ── max_iterations: self-correction and the read-only tool loop ─────────────

describe('llm max_iterations', () => {
  it('max_iterations 2: an invalid first turn is corrected inside ONE attempt (one step row, two model turns)', async () => {
    const llm = stubLlm((n) => (n === 1 ? '{"category": "billing"}' : '{"category": "sales"}'))
    const e = engine({ llm: llm.backend })
    const runId = startFlow(e, flow([start(), classify({ max_iterations: 2 } as Partial<FlowNode>), end]))
    const run = await runToEnd(e, runId)
    expect(run.status).toBe('succeeded')
    expect(llm.calls).toHaveLength(2)
    expect(llm.calls[1].prompt).toContain('did not match the schema: $.category: must be one of')
    const rows = steps(runId).filter((s) => s.node_id === 'classify')
    expect(rows).toHaveLength(1)
    expect(rows[0].cost_usd).toBeCloseTo(0.02, 10)
  })

  it('tool loop: the model calls a read-only Tool, gets its result, then answers', async () => {
    const lookup = spyTool((input) => ({ plan: (input as { q: string }).q, tier: 'enterprise' }), { effect: 'read' })
    const llm = stubLlm((n) => (n === 1
      ? '{"tool_call": {"tool": "crm-lookup", "input": {"q": "pro"}}}'
      : '{"output": {"category": "sales"}}'))
    const e = engine({ llm: llm.backend, tools: { 'crm-lookup': lookup.tool } })
    const runId = startFlow(e, flow([start(), classify({ max_iterations: 3, tools: ['crm-lookup'] } as Partial<FlowNode>), end]))
    const run = await runToEnd(e, runId)
    expect(run.status).toBe('succeeded')
    expect(JSON.parse(run.output_json)).toEqual({ category: 'sales' })
    expect(lookup.calls).toEqual([{ q: 'pro' }])
    expect(llm.calls[1].prompt).toContain('Tool "crm-lookup" returned: {"plan":"pro","tier":"enterprise"}')
    expect(llm.calls[0].systemPrompt).toContain('"tool_call"')
  })

  it('tool loop refuses a Tool that is not read-only, and a tool call on the last turn ends the attempt (llm_max_iterations)', async () => {
    const send = spyTool(() => ({ ok: true }), { effect: 'send' })
    const llm = stubLlm(() => '{"tool_call": {"tool": "crm-write", "input": {}}}')
    const e = engine({ llm: llm.backend, tools: { 'crm-write': send.tool } })
    const runId = startFlow(e, flow([start(), classify({ max_iterations: 2, tools: ['crm-write'], retry: { max: 1, backoff: 'fixed', delay_ms: 10 } } as Partial<FlowNode>), end]))
    const run = await runToEnd(e, runId)
    expect(send.calls).toHaveLength(0)
    expect(llm.calls[1].prompt).toContain('Tool "crm-write" failed: Tool "crm-write" is not read-only')
    expect(run.status).toBe('failed')
    expect(err(run)).toMatchObject({ type: 'llm_max_iterations', node_id: 'classify' })
  })
})

// ── 2. budgets ──────────────────────────────────────────────────────────────

describe('acceptance 2: a run exceeding run_usd stops before the next spending node (status=failed, error.type=budget)', () => {
  const second: FlowNode = {
    id: 'summarise', kind: 'llm', prompt: 'Summarise {{ steps.classify.output.category }}',
    output_schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }, next: 'done',
  }

  it('llm #1 overshoots run_usd → llm #2 never runs; the run fails with error.type=budget', async () => {
    const llm2 = stubLlm((n) => ({ text: n === 1 ? '{"category": "sales"}' : '{"text": "never"}', cost: 0.06 }))
    const e = engine({ llm: llm2.backend })
    const runId = startFlow(e, flow([start(), classify({ next: 'summarise' }), second, end], { budget: { run_usd: 0.05 } }))
    const run = await runToEnd(e, runId)

    expect(run.status).toBe('failed')
    expect(llm2.calls).toHaveLength(1) // only classify ran
    const error = err(run)
    expect(error).toMatchObject({ type: 'budget', node_id: 'summarise', limit: 'run_usd', cap_usd: 0.05, retryable: false })
    expect(error.spent_usd).toBeCloseTo(0.06, 10)
    expect(run.spent_usd).toBeCloseTo(0.06, 10)
    expect(steps(runId).map((s) => [s.node_id, s.status])).toEqual([
      ['start', 'succeeded'], ['classify', 'succeeded'], ['summarise', 'failed'],
    ])
    expect(err(steps(runId)[2]).type).toBe('budget')
  })

  it('a `spend`-effect tool is a spending node too: it is never called once the run is over budget', async () => {
    const charge = spyTool(() => ({ charged: true }), { effect: 'spend' })
    const llm = stubLlm(() => ({ text: '{"category": "sales"}', cost: 0.06 }))
    const e = engine({ llm: llm.backend, tools: { 'card-charge': charge.tool } })
    const def = flow([
      start(),
      classify({ next: 'charge' }),
      { id: 'charge', kind: 'tool', tool: 'card-charge', effect: 'spend', input: {}, next: 'done' },
      end,
    ], { budget: { run_usd: 0.05 }, approvals: { version: 1, nodes: ['charge'], by: 'user:1', at: '2026-11-12T00:00:00Z' } })
    const run = await runToEnd(e, startFlow(e, def))
    expect(run.status).toBe('failed')
    expect(err(run)).toMatchObject({ type: 'budget', node_id: 'charge' })
    expect(charge.calls).toHaveLength(0)
  })

  it('read-only nodes still run after the overshoot; the stop is AT the next spending node', async () => {
    const read = spyTool(() => ({ rows: 1 }), { effect: 'read' })
    const llm = stubLlm((n) => ({ text: n === 1 ? '{"category": "sales"}' : '{"text": "never"}', cost: 0.06 }))
    const e = engine({ llm: llm.backend, tools: { 'rows-list': read.tool } })
    const runId = startFlow(e, flow([
      start(),
      classify({ next: 'fetch' }),
      { id: 'fetch', kind: 'tool', tool: 'rows-list', effect: 'read', input: {}, next: 'summarise' },
      second,
      end,
    ], { budget: { run_usd: 0.05 } }))
    const run = await runToEnd(e, runId)
    expect(read.calls).toHaveLength(1)
    expect(err(run)).toMatchObject({ type: 'budget', node_id: 'summarise' })
  })

  it('under budget: both llm nodes run and the spend adds up on the run', async () => {
    const llm = stubLlm((n) => ({ text: n === 1 ? '{"category": "sales"}' : '{"text": "ok"}', cost: 0.06 }))
    const e = engine({ llm: llm.backend })
    const run = await runToEnd(e, startFlow(e, flow([start(), classify({ next: 'summarise' }), second, end], { budget: { run_usd: 0.5 } })))
    expect(run.status).toBe('succeeded')
    expect(run.spent_usd).toBeCloseTo(0.12, 10)
  })

  it('budget is re-checked between turns of one llm node: no correction turn once over run_usd, and no retry', async () => {
    const llm = stubLlm(() => ({ text: '{"category": "nope"}', cost: 0.06 }))
    const e = engine({ llm: llm.backend })
    const run = await runToEnd(e, startFlow(e, flow([start(), classify({ max_iterations: 3 } as Partial<FlowNode>), end], { budget: { run_usd: 0.05 } })))
    expect(llm.calls).toHaveLength(1)
    expect(run.status).toBe('failed')
    expect(err(run)).toMatchObject({ type: 'budget', limit: 'run_usd', node_id: 'classify' })
  })

  it("the node's own budget_usd caps it across attempts", async () => {
    const llm = stubLlm(() => ({ text: '{"category": "nope"}', cost: 0.01 }))
    const e = engine({ llm: llm.backend })
    const run = await runToEnd(e, startFlow(e, flow([start(), classify({ budget_usd: 0.015, retry: { max: 5, backoff: 'fixed', delay_ms: 10 } } as Partial<FlowNode>), end])))
    expect(llm.calls).toHaveLength(2) // 0.01 < 0.015 → attempt 2; 0.02 ≥ 0.015 → stop
    expect(err(run)).toMatchObject({ type: 'budget', limit: 'node_budget_usd', node_id: 'classify' })
  })
})

describe('budgets: job-accounting ceilings (same ledger, stricter wins)', () => {
  const twoLlm = (budget?: FlowDefinition['budget']) => flow([
    start(),
    classify({ next: 'again' }),
    { id: 'again', kind: 'llm', prompt: 'again', output_schema: { type: 'object' }, next: 'done' },
    end,
  ], { budget })

  it('settings.job_cost_ceiling_usd:<workspace> is a per-run ceiling and stops the next spending node', async () => {
    setSetting('job_cost_ceiling_usd:acme', '0.05')
    const llm = stubLlm((n) => ({ text: n === 1 ? '{"category": "sales"}' : '{}', cost: 0.06 }))
    const e = engine({ llm: llm.backend })
    const run = await runToEnd(e, startFlow(e, twoLlm(undefined)))
    expect(llm.calls).toHaveLength(1)
    expect(err(run)).toMatchObject({ type: 'budget', limit: 'job_ceiling', cap_usd: 0.05, node_id: 'again' })
    expect(err(run).title).toContain('source: workspace:acme')
  })

  it('stricter wins: a workspace ceiling below run_usd stops the run even though run_usd has room', async () => {
    setSetting('job_cost_ceiling_usd:acme', '0.05')
    const llm = stubLlm((n) => ({ text: n === 1 ? '{"category": "sales"}' : '{}', cost: 0.06 }))
    const e = engine({ llm: llm.backend })
    const run = await runToEnd(e, startFlow(e, twoLlm({ run_usd: 10 })))
    expect(err(run)).toMatchObject({ type: 'budget', limit: 'job_ceiling' })
  })

  it("the home card's ledger: run spend is added to objective_job_accounting and its own ceiling is cumulative", async () => {
    setObjectiveCeiling(db, 42, { costUsd: 0.1 })
    recordSpend(db, 42, { usd: 0.08 }) // earlier runs of this flow
    const llm = stubLlm((n) => ({ text: n === 1 ? '{"category": "sales"}' : '{}', cost: 0.03 }))
    const e = engine({ llm: llm.backend })
    const run = await runToEnd(e, startFlow(e, twoLlm({ run_usd: 10 }), { objectiveId: 42 }))
    expect(llm.calls).toHaveLength(1) // 0.08 < 0.10 → classify runs; 0.11 ≥ 0.10 → `again` stops
    expect(getSpend(db, 42).spentUsd).toBeCloseTo(0.11, 10)
    expect(err(run)).toMatchObject({ type: 'budget', limit: 'job_ceiling', node_id: 'again' })
    expect(err(run).detail).toContain('home card #42')
  })

  it('no finite budget anywhere → refused under the default enforce policy (no guessed default)', async () => {
    const llm = stubLlm(() => '{"category": "sales"}')
    const e = engine({ llm: llm.backend })
    const run = await runToEnd(e, startFlow(e, twoLlm(undefined)))
    expect(llm.calls).toHaveLength(0)
    expect(err(run)).toMatchObject({ type: 'budget', limit: 'no_budget', node_id: 'classify' })
  })

  it("policy observe lets an unbudgeted run spend and reports it; policy off never disables the flow's own run_usd", async () => {
    setSetting('job_ceiling_policy:flow_run:acme', 'observe')
    const events: FlowEngineEvent[] = []
    const llm = stubLlm((n) => (n === 1 ? '{"category": "sales"}' : '{}'))
    const e = engine({ llm: llm.backend, events })
    const ok = await runToEnd(e, startFlow(e, twoLlm(undefined)))
    expect(ok.status).toBe('succeeded')
    expect(events.filter((x) => x.type === 'budget_observed').map((x) => (x as { nodeId: string }).nodeId)).toEqual(['classify', 'again'])

    setSetting('job_ceiling_policy:flow_run:acme', 'off')
    const llm2 = stubLlm((n) => ({ text: n === 1 ? '{"category": "sales"}' : '{}', cost: 0.06 }))
    const e2 = engine({ llm: llm2.backend })
    const def = { ...twoLlm({ run_usd: 0.05 }), id: 'b3-flow-2' }
    const stopped = await runToEnd(e2, startFlow(e2, def))
    expect(err(stopped)).toMatchObject({ type: 'budget', limit: 'run_usd' })
  })
})

// ── 3. mcp nodes (stub resolver; the real workspace resolver is in flow-mcp-workspace.test.ts) ──

describe('mcp nodes', () => {
  const mcpNode = (extra: Partial<FlowNode> = {}): FlowNode => ({
    id: 'lookup', kind: 'mcp', connector: 'crm', tool: 'find_contact', effect: 'read',
    arguments: { email: '{{ trigger.payload.email }}' }, next: 'done', ...extra,
  } as FlowNode)
  const done: FlowNode = { id: 'done', kind: 'end', output: '{{ steps.lookup.output }}' }

  /** Connectors enabled per workspace; a call records (workspace, tool, args). */
  function stubResolver(enabled: Record<string, string[]>, result: unknown = { content: [{ type: 'text', text: '{"id": 7}' }] }) {
    const calls: { workspace: string; tool: string; args: unknown }[] = []
    const resolves: string[] = []
    const resolver: FlowMcpResolver = {
      async resolve({ workspace, connector }) {
        resolves.push(`${workspace}:${connector}`)
        if (!(enabled[workspace] ?? []).includes(connector)) return { ok: false, problem: connectorForbidden(workspace, connector) }
        return { ok: true, connection: { async call(tool, args) { calls.push({ workspace, tool, args }); return result } } }
      },
    }
    return { resolver, calls, resolves }
  }

  it("resolves the connector in the RUN's workspace and parses the tool's JSON text content", async () => {
    const s = stubResolver({ acme: ['crm'] })
    const e = engine({ mcp: s.resolver })
    const run = await runToEnd(e, startFlow(e, flow([start('lookup'), mcpNode(), done]), { payload: { email: 'a@b.co' } }))
    expect(run.status).toBe('succeeded')
    expect(JSON.parse(run.output_json)).toEqual({ id: 7 })
    expect(s.calls).toEqual([{ workspace: 'acme', tool: 'find_contact', args: { email: 'a@b.co' } }])
  })

  it('a connector enabled only in another workspace → 403-equivalent `forbidden`, not retried, nothing called', async () => {
    const s = stubResolver({ beta: ['crm'] })
    const e = engine({ mcp: s.resolver })
    const run = await runToEnd(e, startFlow(e, flow([start('lookup'), mcpNode(), done]), { workspace: 'acme' }))
    expect(run.status).toBe('failed')
    expect(err(run)).toMatchObject({ type: 'forbidden', status: 403, node_id: 'lookup', retryable: false })
    expect(err(run).title).toBe('connector "crm" is not enabled for workspace "acme"')
    expect(s.resolves).toEqual(['acme:crm'])
    expect(s.calls).toHaveLength(0)
  })

  it('an MCP tool result with isError → mcp_tool_error (retryable, so the node retry applies)', async () => {
    const s = stubResolver({ acme: ['crm'] }, { isError: true, content: [{ type: 'text', text: 'rate limited' }] })
    const e = engine({ mcp: s.resolver })
    const run = await runToEnd(e, startFlow(e, flow([start('lookup'), mcpNode({ retry: { max: 2, backoff: 'fixed', delay_ms: 10 } } as Partial<FlowNode>), done])))
    expect(s.calls).toHaveLength(2)
    expect(err(run)).toMatchObject({ type: 'mcp_tool_error', detail: 'rate limited' })
  })

  it('an mcp node defaults to effect `send` (needs approval to publish) and gets an idempotency key', async () => {
    const s = stubResolver({ acme: ['crm'] }, { structuredContent: { ok: true } })
    const e = engine({ mcp: s.resolver })
    const def = flow([start('lookup'), mcpNode({ effect: undefined } as Partial<FlowNode>), done], {
      approvals: { version: 1, nodes: ['lookup'], by: 'user:1', at: '2026-11-12T00:00:00Z' },
    })
    const runId = startFlow(e, def)
    const run = await runToEnd(e, runId)
    expect(JSON.parse(run.output_json)).toEqual({ ok: true })
    const row = db.prepare("SELECT effect, idempotency_key FROM flow_step_runs WHERE run_id = ? AND node_id = 'lookup'").get(runId) as Record<string, any>
    expect(row.effect).toBe('send')
    expect(row.idempotency_key).toMatch(/^[0-9a-f]{64}$/)
  })
})
