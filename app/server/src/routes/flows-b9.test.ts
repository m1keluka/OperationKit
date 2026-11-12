// Workflows card B9 (obj 900645, docs/design/WORKFLOWS.md §8) — HTTP + board side:
//   1. an `agent` node's child card appears on the board with origin = workflow
//      and its result flows into the next node
//   2. a flow waits across a backend restart and resumes on the owner's approval CLICK
//      (POST /api/flows/:id/runs/:runId/approval — cookie owner/admin only)
// plus: the run detail lists open waits with the exact payload awaiting approval,
// event delivery is workspace-scoped, cancel/disposition handling for agent cards,
// and the unknown-outcome confirm route.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'
import cookieParser from 'cookie-parser'
import jwt from 'jsonwebtoken'
import type { FlowDefinition, FlowNode } from '../../../shared/flow/types.js'

vi.mock('node-pty', () => ({ spawn: () => { throw new Error('node-pty is not available in flows tests') } }))

const TMP_DB = path.join(os.tmpdir(), `cc-flows-b9-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB
process.env.JWT_SECRET = 'test-secret-flows-b9'
process.env.PORT = '59953'
process.env.ALERTS_ENABLED = 'false'
process.env.CC_SESSION_KB_ACCESS = '1'

const { initDb, getDb } = await import('../db/index.js')
const { default: flowsRouter } = await import('./flows.js')
const { default: objectivesRouter } = await import('./objectives.js')
const { registerInternalHermesRoutes } = await import('./internal-hermes.js')
const { agentKeyGuard } = await import('../middleware/agent-key-guard.js')
const { mintSessionToken } = await import('../lib/session-trust.js')
const { FlowEngine } = await import('../services/flow-engine.js')
const { createFlowAgentCard } = await import('../services/flow-agent.js')
const { recordSpend } = await import('../services/job-accounting.js')

const ADMIN = { id: 601, username: 'owner', role: 'admin' as const }
const MEMBER_A = { id: 602, username: 'member-a', role: 'member' as const }
const MEMBER_B = { id: 603, username: 'member-b', role: 'member' as const }
type Who = typeof ADMIN | typeof MEMBER_A | typeof MEMBER_B
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any

let server: http.Server
let baseUrl = ''
const cookieFor = (u: Who) => `token=${jwt.sign(u, process.env.JWT_SECRET as string, { expiresIn: '1h' })}`
const bearerFor = (u: Who) => jwt.sign(u, process.env.JWT_SECRET as string, { expiresIn: '1h' })

async function call(method: string, p: string, opts: { as?: Who; bearer?: string; session?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (opts.session) headers['X-CC-Session-Token'] = opts.session
  else if (opts.bearer) headers.Authorization = `Bearer ${opts.bearer}`
  else if (opts.as) headers.Cookie = cookieFor(opts.as)
  const res = await fetch(`${baseUrl}${p}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) })
  const text = await res.text()
  let json: Loose = text
  try { json = JSON.parse(text) } catch { /* text */ }
  return { status: res.status, json }
}

function def(ws: string, slug: string, nodes: FlowNode[], extra: Partial<FlowDefinition> = {}): FlowDefinition {
  return {
    apiVersion: 'okflow/1', id: slug, name: `Flow ${slug}`, workspace: ws, version: 1,
    goal: { statement: 'b9', end_condition: { assert: [{ expr: 'true' }] } },
    nodes,
    ...extra,
  }
}

const started: number[] = []
const mailerCalls: unknown[] = []
/** A fresh engine instance = a fresh server process after a restart (new lease owner, no in-memory state). */
const engine = (owner: string) => new FlowEngine({
  db: getDb(),
  owner,
  tools: { get: (slug) => (slug === 'mailer' ? { effect: 'send', run: async (input) => { mailerCalls.push(input); return { ok: true } } } : null) },
  agents: { createCard: createFlowAgentCard, startCard: (id) => { started.push(id) } },
})

async function create(ws: string, d: FlowDefinition): Promise<{ flowId: number; home: number }> {
  const c = await call('POST', '/api/flows', { as: ADMIN, body: { definition: d } })
  expect(c.status, JSON.stringify(c.json)).toBe(201)
  return { flowId: c.json.flow_id, home: c.json.objective_id }
}

function startRun(e: InstanceType<typeof FlowEngine>, flowId: number, home: number, payload: unknown = {}): number {
  const r = e.startRun({ flowId, version: 1, trigger: { source: 'manual', payload }, objectiveId: home })
  if (!r.ok) throw new Error(`start failed: ${r.reason}`)
  return r.runId
}

const runRow = (id: number) => getDb().prepare('SELECT * FROM flow_runs WHERE id = ?').get(id) as Loose

beforeAll(async () => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
  const db = getDb()
  for (const u of [ADMIN, MEMBER_A, MEMBER_B]) {
    db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, 'x', ?)").run(u.id, u.username, u.role)
  }
  db.prepare("INSERT OR IGNORE INTO user_workspaces (user_id, workspace) VALUES (?, 'ws-a')").run(MEMBER_A.id)
  db.prepare("INSERT OR IGNORE INTO user_workspaces (user_id, workspace) VALUES (?, 'ws-b')").run(MEMBER_B.id)
  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  app.use(agentKeyGuard)
  app.use('/api/flows', flowsRouter)
  app.use('/api/objectives', objectivesRouter)
  const internal = express.Router()
  registerInternalHermesRoutes(internal)
  app.use('/api/internal', internal)
  server = http.createServer(app)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()))
  try { fs.unlinkSync(TMP_DB) } catch { /* gone */ }
})

beforeEach(() => {
  getDb().prepare("INSERT INTO settings (key, value) VALUES ('flows_enabled', '1') ON CONFLICT(key) DO UPDATE SET value = '1'").run()
  started.length = 0
  mailerCalls.length = 0
})

// ── 1. agent node → child card on the board → result into the next node ─────

describe('acceptance: an agent node files a child card (origin workflow) and its result flows into the next node', () => {
  const agentFlow = (slug: string) => def('ws-a', slug, [
    { id: 'start', kind: 'trigger', on: 'manual', next: 'research' },
    { id: 'research', kind: 'agent', label: 'Vendor research', brief: 'List three vendors for {{ trigger.payload.topic }}.', budget_usd: 2, next: 'verify' },
    { id: 'verify', kind: 'check', assert: [{ expr: "steps.research.output.disposition == 'complete'", why: 'agent finished' }], next: 'done' },
    { id: 'done', kind: 'end', output: { summary: '{{ steps.research.output.summary }}', card: '{{ steps.research.output.objective_id }}' } },
  ], {
    budget: { run_usd: 5 },
    goal: { statement: 'vendor list', end_condition: { assert: [{ expr: 'len(steps.research.output.summary) > 0' }] } },
  })

  it('files the card, parks the run, and resumes with the card summary when the card is done', async () => {
    const { flowId, home } = await create('ws-a', agentFlow('agent-ok'))
    const e = engine('host-1')
    const runId = startRun(e, flowId, home, { topic: 'payroll' })
    await e.tick()
    expect(runRow(runId).status).toBe('waiting')

    // the child card exists, as a normal board card
    const child = getDb().prepare("SELECT * FROM objectives WHERE origin = 'workflow' AND parent_id = ?").get(home) as Loose
    expect(child).toMatchObject({ workspace: 'ws-a', origin: 'workflow', status: 'queue', type: 'task', parent_id: home })
    expect(child.title).toBe(`Flow agent-ok · Vendor research (run #${runId})`)
    expect(child.description).toContain('List three vendors for payroll.')
    expect(child.description).toContain('steps.research.output.summary')
    expect(started).toEqual([child.id]) // the host was asked to start its session
    const ceiling = getDb().prepare('SELECT cost_ceiling_usd FROM objective_job_accounting WHERE objective_id = ?').get(child.id) as Loose
    expect(ceiling.cost_ceiling_usd).toBe(2)

    // … and it is on the board (GET /api/objectives, the board's list route)
    const board = await call('GET', '/api/objectives', { as: ADMIN })
    expect(board.status).toBe(200)
    const listed = (Array.isArray(board.json) ? board.json : board.json.objectives ?? []).find((o: Loose) => o.id === child.id)
    expect(listed).toMatchObject({ origin: 'workflow', status: 'queue', workspace: 'ws-a' })

    // the run detail says what it is waiting on
    const detail = await call('GET', `/api/flows/${flowId}/runs/${runId}`, { as: MEMBER_A })
    expect(detail.status).toBe(200)
    expect(detail.json.waits).toEqual([expect.objectContaining({ node_id: 'research', reason: 'agent', objective_id: child.id, objective_status: 'queue' })])

    // ticks while the card works change nothing
    getDb().prepare("UPDATE objectives SET status = 'working', session_id = 'cc-x' WHERE id = ?").run(child.id)
    await e.tick()
    expect(runRow(runId).status).toBe('waiting')

    // the card finishes: its summary is the deliverable, its spend is on its own ledger
    recordSpend(getDb(), child.id, { usd: 0.4 })
    getDb().prepare("UPDATE objectives SET status = 'done', last_session_summary = 'Gusto, Rippling, Deel.' WHERE id = ?").run(child.id)
    await e.tick()

    const run = runRow(runId)
    expect(run.status).toBe('succeeded')
    expect(run.goal_met).toBe(1)
    expect(JSON.parse(run.output_json)).toEqual({ summary: 'Gusto, Rippling, Deel.', card: child.id })
    expect(run.spent_usd).toBeCloseTo(0.4)
    const st = getDb().prepare("SELECT * FROM flow_step_runs WHERE run_id = ? AND node_id = 'research'").get(runId) as Loose
    expect(st.status).toBe('succeeded')
    expect(st.cost_usd).toBeCloseTo(0.4)
    expect(JSON.parse(st.output_json)).toMatchObject({ objective_id: child.id, status: 'done', disposition: 'complete', summary: 'Gusto, Rippling, Deel.' })
    // exactly one card for this node, ever
    expect(getDb().prepare("SELECT COUNT(*) n FROM objectives WHERE origin = 'workflow' AND parent_id = ?").get(home)).toEqual({ n: 1 })
  })

  it('a worker-declared disposition (POST …/job-disposition, now allowed on workflow cards) resolves a card parked in review', async () => {
    const { flowId, home } = await create('ws-a', agentFlow('agent-review'))
    const e = engine('host-1')
    const runId = startRun(e, flowId, home, { topic: 'crm' })
    await e.tick()
    const child = getDb().prepare("SELECT id FROM objectives WHERE origin = 'workflow' AND parent_id = ?").get(home) as { id: number }
    const disp = await call('POST', `/api/internal/objectives/${child.id}/job-disposition`, { body: { disposition: 'needs_review', note: 'two vendors lack SOC2' } })
    expect(disp.status, JSON.stringify(disp.json)).toBe(200)
    await e.tick()
    expect(runRow(runId).status).toBe('waiting') // still working: a disposition alone is not the end

    getDb().prepare("UPDATE objectives SET status = 'review', last_session_summary = 'Partial list.' WHERE id = ?").run(child.id)
    await e.tick()
    // `verify` asserts disposition == complete, so the flow sees needs_review and fails its check
    expect(runRow(runId).status).toBe('failed')
    expect(JSON.parse(runRow(runId).error_json)).toMatchObject({ type: 'check_failed', node_id: 'verify' })
    const out = JSON.parse((getDb().prepare("SELECT output_json FROM flow_step_runs WHERE run_id = ? AND node_id = 'research'").get(runId) as Loose).output_json)
    expect(out).toMatchObject({ disposition: 'needs_review', note: 'two vendors lack SOC2', summary: 'Partial list.' })
  })

  it('a cancelled child card fails the node (agent_cancelled) instead of hanging forever', async () => {
    const { flowId, home } = await create('ws-a', agentFlow('agent-cancel'))
    const e = engine('host-1')
    const runId = startRun(e, flowId, home, { topic: 'x' })
    await e.tick()
    const child = getDb().prepare("SELECT id FROM objectives WHERE origin = 'workflow' AND parent_id = ?").get(home) as { id: number }
    getDb().prepare("UPDATE objectives SET status = 'cancelled' WHERE id = ?").run(child.id)
    await e.tick()
    expect(runRow(runId).status).toBe('failed')
    expect(JSON.parse(runRow(runId).error_json)).toMatchObject({ type: 'agent_cancelled', node_id: 'research' })
  })

  it('a run restarted while its agent card works does not file a second card', async () => {
    const { flowId, home } = await create('ws-a', agentFlow('agent-restart'))
    const a = engine('host-A')
    const runId = startRun(a, flowId, home, { topic: 'x' })
    await a.tick()
    a.kill()
    const b = engine('host-B')
    for (let i = 0; i < 3; i++) await b.tick()
    expect(getDb().prepare("SELECT COUNT(*) n FROM objectives WHERE origin = 'workflow' AND parent_id = ?").get(home)).toEqual({ n: 1 })
    expect(runRow(runId).status).toBe('waiting')
  })
})

// ── 2. approval click across a restart ──────────────────────────────────────

describe('acceptance: a flow waits across a backend restart and resumes on the approval click', () => {
  const approvalFlow = (ws: string, slug: string) => def(ws, slug, [
    { id: 'start', kind: 'trigger', on: 'manual', next: 'confirm' },
    { id: 'confirm', kind: 'wait', approval: { from: 'owner', prompt: 'Send the renewal notice to {{ trigger.payload.to }}?' }, next: 'notify' },
    { id: 'notify', kind: 'tool', tool: 'mailer', effect: 'send', input: { to: '{{ trigger.payload.to }}', template: 'renewal' }, next: 'done' },
    { id: 'done', kind: 'end', output: '{{ steps.notify.output }}' },
  ])

  it('park → restart → only a cookie owner can click → the new process resumes and sends once', async () => {
    const { flowId, home } = await create('ws-a', approvalFlow('ws-a', 'approve-click'))
    const before = engine('process-1')
    const runId = startRun(before, flowId, home, { to: 'cfo@example.com' })
    await before.tick()
    expect(runRow(runId).status).toBe('waiting')
    before.kill() // the backend restarts

    // the card UI shows the pending approval with the exact payload that will go out
    const detail = await call('GET', `/api/flows/${flowId}/runs/${runId}`, { as: ADMIN })
    expect(detail.json.waits).toEqual([expect.objectContaining({
      node_id: 'confirm', reason: 'approval',
      approval: { from: 'owner', prompt: 'Send the renewal notice to cfo@example.com?' },
      next: { node_id: 'notify', kind: 'tool', effect: 'send', input: { to: 'cfo@example.com', template: 'renewal' } },
    })])

    // not an approval: a workspace member, a card session, a bearer-token admin
    const session = mintSessionToken({ objectiveId: home, workspace: 'ws-a', actingUserId: ADMIN.id })
    for (const opts of [{ as: MEMBER_A }, { session }, { bearer: bearerFor(ADMIN) }]) {
      const r = await call('POST', `/api/flows/${flowId}/runs/${runId}/approval`, { ...opts, body: { decision: 'approve' } })
      expect(r.status, JSON.stringify(opts)).toBe(403)
    }
    // cross-workspace member does not even learn the run exists
    expect((await call('POST', `/api/flows/${flowId}/runs/${runId}/approval`, { as: MEMBER_B, body: { decision: 'approve' } })).status).toBe(403)
    expect(runRow(runId).status).toBe('waiting')
    expect(mailerCalls).toHaveLength(0)

    const click = await call('POST', `/api/flows/${flowId}/runs/${runId}/approval`, { as: ADMIN, body: { decision: 'approve', node_id: 'confirm', note: 'checked' } })
    expect(click.status, JSON.stringify(click.json)).toBe(200)
    expect(click.json.run.status).toBe('queued')
    expect(click.json.waits).toEqual([])

    const after = engine('process-2') // the new server process's engine
    await after.tick()
    const run = runRow(runId)
    expect(run.status).toBe('succeeded')
    expect(mailerCalls).toEqual([{ to: 'cfo@example.com', template: 'renewal' }])
    const tok = getDb().prepare("SELECT resolved_by, resolution FROM flow_wait_tokens WHERE run_id = ? AND reason = 'approval'").get(runId)
    expect(tok).toEqual({ resolved_by: `user:${ADMIN.id}`, resolution: 'approved' })

    // a second click has nothing to answer
    const again = await call('POST', `/api/flows/${flowId}/runs/${runId}/approval`, { as: ADMIN, body: { decision: 'approve' } })
    expect(again.status).toBe(409)
    expect(mailerCalls).toHaveLength(1)
  })

  it('Reject fails the run with approval_rejected; nothing is sent', async () => {
    const { flowId, home } = await create('ws-a', approvalFlow('ws-a', 'reject-click'))
    const e = engine('p1')
    const runId = startRun(e, flowId, home, { to: 'x@example.com' })
    await e.tick()
    const r = await call('POST', `/api/flows/${flowId}/runs/${runId}/approval`, { as: ADMIN, body: { decision: 'reject', note: 'not this quarter' } })
    expect(r.status).toBe(200)
    await e.tick()
    expect(runRow(runId).status).toBe('failed')
    expect(JSON.parse(runRow(runId).error_json)).toMatchObject({ type: 'approval_rejected', node_id: 'confirm' })
    expect(mailerCalls).toHaveLength(0)
  })

  it('validates the body', async () => {
    const { flowId, home } = await create('ws-a', approvalFlow('ws-a', 'approve-bad-body'))
    const e = engine('p1')
    const runId = startRun(e, flowId, home, { to: 'x@example.com' })
    await e.tick()
    expect((await call('POST', `/api/flows/${flowId}/runs/${runId}/approval`, { as: ADMIN, body: { decision: 'yes' } })).status).toBe(400)
    expect((await call('POST', `/api/flows/${flowId}/runs/999999/approval`, { as: ADMIN, body: { decision: 'approve' } })).status).toBe(404)
  })
})

// ── events + unknown-outcome confirm ────────────────────────────────────────

describe('POST /api/flows/:id/events and /runs/:runId/outcome', () => {
  it('a workspace member (or the card session) may deliver an event; another workspace may not', async () => {
    const { flowId, home } = await create('ws-a', def('ws-a', 'event-flow', [
      { id: 'start', kind: 'trigger', on: 'manual', next: 'paid' },
      { id: 'paid', kind: 'wait', event: 'invoice.paid', next: 'done' },
      { id: 'done', kind: 'end', output: '{{ steps.paid.output.payload.amount }}' },
    ]))
    const e = engine('p1')
    const runId = startRun(e, flowId, home)
    await e.tick()
    expect((await call('POST', `/api/flows/${flowId}/events`, { as: MEMBER_B, body: { event: 'invoice.paid' } })).status).toBe(403)
    expect((await call('POST', `/api/flows/${flowId}/events`, { as: MEMBER_A, body: { event: 'bad name!' } })).status).toBe(400)
    const r = await call('POST', `/api/flows/${flowId}/events`, { as: MEMBER_A, body: { event: 'invoice.paid', payload: { amount: 120 } } })
    expect(r.status).toBe(200)
    expect(r.json).toMatchObject({ ok: true, delivered: 1, run_ids: [runId] })
    await e.tick()
    expect(runRow(runId).status).toBe('succeeded')
    expect(JSON.parse(runRow(runId).output_json)).toBe(120)
  })

  it('unknown-outcome confirm is cookie-owner only and resumes the run', async () => {
    const { flowId, home } = await create('ws-a', def('ws-a', 'outcome-flow', [
      { id: 'start', kind: 'trigger', on: 'manual', next: 'notify' },
      { id: 'notify', kind: 'tool', tool: 'mailer', effect: 'send', input: { to: 'a@example.com' }, mock: { output: { ok: true } }, next: 'done' },
      { id: 'done', kind: 'end' },
    ]))
    // B5: a live run of a send node needs the owner's recorded publish approval.
    const t = await call('POST', `/api/flows/${flowId}/test`, { as: ADMIN, body: { version: 1, mode: 'dry' } })
    expect(t.json.self_test?.status, JSON.stringify(t.json)).toBe('passed')
    expect((await call('POST', `/api/flows/${flowId}/publish`, { as: ADMIN, body: { version: 1, approve: ['notify'] } })).status).toBe(200)
    const e = engine('p1')
    const runId = startRun(e, flowId, home)
    // simulate a crash mid-send: the step row is `running` and the lease has expired
    const db = getDb()
    db.prepare("UPDATE flow_runs SET status = 'running', lease_owner = 'dead', lease_expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(runId)
    db.prepare("INSERT INTO flow_step_runs (run_id, node_id, iteration, attempt, status, effect, started_at) VALUES (?, 'start', 0, 1, 'succeeded', NULL, '2000-01-01T00:00:00.000Z')").run(runId)
    db.prepare("INSERT INTO flow_step_runs (run_id, node_id, iteration, attempt, status, effect, started_at) VALUES (?, 'notify', 0, 1, 'running', 'send', '2000-01-01T00:00:00.000Z')").run(runId)
    await e.tick()
    expect(runRow(runId).status).toBe('waiting')
    expect((await call('GET', `/api/flows/${flowId}/runs/${runId}`, { as: ADMIN })).json.waits[0]).toMatchObject({ reason: 'unknown_outcome', node_id: 'notify' })
    expect((await call('POST', `/api/flows/${flowId}/runs/${runId}/outcome`, { as: MEMBER_A, body: { node_id: 'notify', outcome: 'sent' } })).status).toBe(403)
    const r = await call('POST', `/api/flows/${flowId}/runs/${runId}/outcome`, { as: ADMIN, body: { node_id: 'notify', outcome: 'sent' } })
    expect(r.status, JSON.stringify(r.json)).toBe(200)
    await e.tick()
    expect(runRow(runId).status).toBe('succeeded')
    expect(mailerCalls).toHaveLength(0) // "sent" means it already happened: never re-sent
  })
})
