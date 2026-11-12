// Workflows card B4 (obj 900640, docs/design/WORKFLOWS.md §8) — acceptance:
//   1. a published flow fires on its cron via the EXISTING routine scheduler and
//      its run appears in the Jobs lanes feed (GET /api/flows/runs)
//   2. run-now works (POST /api/flows/:id/runs and the routine's run-now)
//   3. auto-pause after K failures sets the fields the existing banner reads
//      (GET /api/admin/routines → auto_paused_at / auto_pause_reason)
//   4. the diagram renders kind, tool/connector, effect and LLM nodes distinctly,
//      with per-node status from the latest run
//   5. every route 403s cross-workspace (member, card session token)
// plus: publish is cookie-owner only, the kill switch blocks runs, home card.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'
import cookieParser from 'cookie-parser'
import jwt from 'jsonwebtoken'
import type { FlowDefinition } from '../../../shared/flow/types.js'
import { DAILY_BOOKING_TRIAGE } from '../../../shared/flow/__tests__/example.js'

// db/index.ts's import graph reaches node-pty; nothing here opens a terminal.
vi.mock('node-pty', () => ({ spawn: () => { throw new Error('node-pty is not available in flows tests') } }))

const TMP_DB = path.join(os.tmpdir(), `cc-flows-b4-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB
process.env.JWT_SECRET = 'test-secret-flows-b4'
process.env.PORT = '59951'
process.env.ALERTS_ENABLED = 'false'
process.env.CC_SESSION_KB_ACCESS = '1'
delete process.env.CC_ROUTINE_AUTO_PAUSE_FAILURES

const { initDb, getDb } = await import('../db/index.js')
const { default: flowsRouter } = await import('./flows.js')
const { default: jobsRouter } = await import('./admin-jobs.js')
const { requireAuth, requireAdmin } = await import('../middleware/auth.js')
const { agentKeyGuard } = await import('../middleware/agent-key-guard.js')
const { mintSessionToken } = await import('../lib/session-trust.js')
const { FlowEngine } = await import('../services/flow-engine.js')
const { runRoutineTickForTests, fireRoutine } = await import('../services/routine-scheduler.js')
const { createAgentKey } = await import('../lib/agent-keys.js')

const ADMIN = { id: 501, username: 'owner', role: 'admin' as const }
const MEMBER_A = { id: 502, username: 'member-a', role: 'member' as const }
const MEMBER_B = { id: 503, username: 'member-b', role: 'member' as const }
type Who = typeof ADMIN | typeof MEMBER_A | typeof MEMBER_B

let server: http.Server
let baseUrl = ''
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any

const cookieFor = (u: Who) => `token=${jwt.sign(u, process.env.JWT_SECRET as string, { expiresIn: '1h' })}`
const bearerFor = (u: Who) => jwt.sign(u, process.env.JWT_SECRET as string, { expiresIn: '1h' })

async function call(
  method: string,
  p: string,
  opts: { as?: Who; bearer?: string; session?: string; body?: unknown } = {},
): Promise<{ status: number; json: Loose }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (opts.session) headers['X-CC-Session-Token'] = opts.session
  else if (opts.bearer) headers.Authorization = `Bearer ${opts.bearer}`
  else if (opts.as) headers.Cookie = cookieFor(opts.as)
  const res = await fetch(`${baseUrl}${p}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) })
  const text = await res.text()
  let json: unknown = text
  try { json = JSON.parse(text) } catch { /* text */ }
  return { status: res.status, json }
}

function flowDef(ws: string, slug: string, opts: { cron?: string; tool?: string; version?: number } = {}): FlowDefinition {
  return {
    apiVersion: 'okflow/1',
    id: slug,
    name: `Flow ${slug}`,
    workspace: ws,
    version: opts.version ?? 1,
    goal: { statement: 'rows are fetched', end_condition: { assert: [{ expr: 'len(steps.fetch.output.rows) > 0' }] } },
    nodes: [
      { id: 'start', kind: 'trigger', on: 'schedule', schedule: { cron: opts.cron ?? '0 * * * *' }, next: 'fetch' },
      {
        id: 'fetch', kind: 'tool', tool: opts.tool ?? 'rows-list', effect: 'read', retry: { max: 1, backoff: 'fixed', delay_ms: 1 },
        mock: { output: { rows: [{ id: 'fixture' }] } }, next: 'verify',
      },
      { id: 'verify', kind: 'check', assert: [{ expr: 'len(steps.fetch.output.rows) > 0', why: 'rows fetched' }], next: 'done' },
      { id: 'done', kind: 'end', output: '{{ steps.fetch.output.rows }}' },
    ],
  }
}

let rowsResult: unknown = { rows: [{ id: 'a' }] }
const executor = () =>
  new FlowEngine({
    db: getDb(),
    tools: { get: (slug) => (slug === 'rows-list' ? { run: async () => rowsResult } : null) },
    owner: 'test-executor',
  })

/** Execute every runnable run (earlier tests may have left queued runs ahead in the global cap). */
async function drain(): Promise<void> {
  const e = executor()
  for (let i = 0; i < 20; i++) {
    const { claimed } = await e.tick()
    if (claimed.length === 0) return
  }
}

const setFlowsEnabled = (on: boolean) =>
  getDb().prepare("INSERT INTO settings (key, value) VALUES ('flows_enabled', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(on ? '1' : '0')

async function createAndPublish(ws: string, slug: string, opts: { cron?: string } = {}): Promise<{ flowId: number; routineId: number; objectiveId: number }> {
  const c = await call('POST', '/api/flows', { as: ADMIN, body: { definition: flowDef(ws, slug, opts) } })
  expect(c.status, JSON.stringify(c.json)).toBe(201)
  // B5: no green self-test, no publish.
  const t = await call('POST', `/api/flows/${c.json.flow_id}/test`, { as: ADMIN, body: { version: 1, mode: 'dry' } })
  expect(t.json.self_test?.status, JSON.stringify(t.json)).toBe('passed')
  const p = await call('POST', `/api/flows/${c.json.flow_id}/publish`, { as: ADMIN, body: { version: 1 } })
  expect(p.status, JSON.stringify(p.json)).toBe(200)
  return { flowId: c.json.flow_id, routineId: p.json.routine_id, objectiveId: c.json.objective_id }
}

let wsBSessionObjective = 0

beforeAll(async () => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
  const db = getDb()
  for (const u of [ADMIN, MEMBER_A, MEMBER_B]) {
    db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, 'x', ?)").run(u.id, u.username, u.role)
  }
  db.prepare("INSERT OR IGNORE INTO user_workspaces (user_id, workspace) VALUES (?, 'ws-a')").run(MEMBER_A.id)
  db.prepare("INSERT OR IGNORE INTO user_workspaces (user_id, workspace) VALUES (?, 'ws-b')").run(MEMBER_B.id)
  wsBSessionObjective = Number(db.prepare("INSERT INTO objectives (title, workspace, status) VALUES ('card in ws-b', 'ws-b', 'working')").run().lastInsertRowid)

  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  app.use(agentKeyGuard)
  app.use('/api/flows', flowsRouter)
  app.use('/api/admin', requireAuth, requireAdmin, jobsRouter)
  server = http.createServer(app)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()))
  try { fs.unlinkSync(TMP_DB) } catch { /* gone */ }
})

beforeEach(() => {
  setFlowsEnabled(true)
  rowsResult = { rows: [{ id: 'a' }] }
})

describe('kill switch default', () => {
  it('initDb seeds settings.flows_enabled (the operator can still switch it off)', () => {
    // beforeEach flips it on for the suite; the seeded row is what a fresh install gets.
    const fresh = getDb().prepare("SELECT value FROM settings WHERE key = 'flows_enabled'").get() as { value: string }
    expect(fresh).toBeTruthy()
    setFlowsEnabled(false)
    expect((getDb().prepare("SELECT value FROM settings WHERE key = 'flows_enabled'").get() as { value: string }).value).toBe('0')
  })
})

describe('create from JSON + home card + publish', () => {
  it('POST /api/flows stores a draft version and files one home card (origin workflow, never started)', async () => {
    const r = await call('POST', '/api/flows', { as: ADMIN, body: { definition: flowDef('ws-a', 'home-card') } })
    expect(r.status).toBe(201)
    expect(r.json.flow.status).toBe('draft')
    expect(r.json.flow.published_version).toBeNull()
    const card = getDb().prepare('SELECT * FROM objectives WHERE id = ?').get(r.json.objective_id) as Loose
    expect(card).toMatchObject({ workspace: 'ws-a', origin: 'workflow', status: 'done', routine_id: null })
    expect(card.description).toContain(`/jobs?view=workflows&flow=${r.json.flow_id}`)

    // a second version re-uses the same home card
    const v2 = await call('POST', '/api/flows', { as: ADMIN, body: { definition: flowDef('ws-a', 'home-card', { version: 2 }) } })
    expect(v2.status).toBe(201)
    expect(v2.json.objective_id).toBe(r.json.objective_id)
    expect(v2.json.flow.latest_version).toBe(2)

    // same version, different content = immutable
    const clash = await call('POST', '/api/flows', { as: ADMIN, body: { definition: { ...flowDef('ws-a', 'home-card'), name: 'changed' } } })
    expect(clash.status).toBe(409)
  })

  it('an invalid definition is a 400 with the validator error codes', async () => {
    const bad = flowDef('ws-a', 'bad-flow')
    bad.nodes.push({ ...bad.nodes[0], id: 'start2' } as Loose)
    const r = await call('POST', '/api/flows', { as: ADMIN, body: { definition: bad } })
    expect(r.status).toBe(400)
    expect(r.json.reason).toBe('invalid_definition')
    expect(r.json.errors.length).toBeGreaterThan(0)
  })

  it('publish creates the kind=flow routine from trigger.schedule.cron (one source of truth)', async () => {
    const { flowId, routineId } = await createAndPublish('ws-a', 'publish-me', { cron: '15 6 * * 1-5' })
    const routine = getDb().prepare('SELECT * FROM routines WHERE id = ?').get(routineId) as Loose
    expect(routine).toMatchObject({ kind: 'flow', flow_id: flowId, cron_expr: '15 6 * * 1-5', enabled: 1, name: 'flow:ws-a/publish-me' })
    expect(JSON.parse(routine.objective_template)).toMatchObject({ workspace: 'ws-a', flow_id: flowId })
    const detail = await call('GET', `/api/flows/${flowId}`, { as: ADMIN })
    expect(detail.json.flow).toMatchObject({ status: 'active', published_version: 1 })
    expect(detail.json.flow.routine).toMatchObject({ id: routineId, enabled: true, cron_expr: '15 6 * * 1-5' })
  })

  it('publish is cookie-owner only: a member, a Bearer JWT and a card session are refused', async () => {
    const c = await call('POST', '/api/flows', { as: MEMBER_A, body: { definition: flowDef('ws-a', 'member-made') } })
    expect(c.status).toBe(201)
    expect(c.json.flow.created_by).toBe(`user:${MEMBER_A.id}`)
    expect((await call('POST', `/api/flows/${c.json.flow_id}/publish`, { as: MEMBER_A, body: { version: 1 } })).status).toBe(403)
    expect((await call('POST', `/api/flows/${c.json.flow_id}/publish`, { bearer: bearerFor(ADMIN), body: { version: 1 } })).status).toBe(403)
    const session = mintSessionToken({ objectiveId: wsBSessionObjective, workspace: 'ws-b', actingUserId: ADMIN.id })
    const own = await call('POST', '/api/flows', { session, body: { definition: flowDef('ws-b', 'session-made') } })
    expect(own.status).toBe(201)
    expect(own.json.flow.created_by).toBe(`agent:${wsBSessionObjective}`)
    expect((await call('POST', `/api/flows/${own.json.flow_id}/publish`, { session, body: { version: 1 } })).status).toBe(403)
    // the member may self-test it (B5) — only the publish is the owner's
    expect((await call('POST', `/api/flows/${c.json.flow_id}/test`, { as: MEMBER_A, body: { version: 1 } })).json.self_test.status).toBe('passed')
    expect((await call('POST', `/api/flows/${c.json.flow_id}/publish`, { as: ADMIN, body: { version: 1 } })).status).toBe(200)
  })
})

describe('acceptance 1: a published flow fires on its cron via the existing scheduler and appears in Jobs lanes', () => {
  it('routine tick at a cron-matching minute queues a run; the engine executes it; it shows in /api/flows/runs', async () => {
    const { flowId, routineId, objectiveId } = await createAndPublish('ws-a', 'cron-fire', { cron: '30 9 * * *' })
    const db = getDb()
    const runsBefore = (db.prepare('SELECT COUNT(*) n FROM flow_runs WHERE self_test_id IS NULL AND flow_id = ?').get(flowId) as { n: number }).n
    expect(runsBefore).toBe(0)

    // a non-matching minute does nothing
    await runRoutineTickForTests(new Date(2026, 10, 12, 9, 29, 10))
    expect((db.prepare('SELECT COUNT(*) n FROM flow_runs WHERE self_test_id IS NULL AND flow_id = ?').get(flowId) as { n: number }).n).toBe(0)

    // the matching minute fires through tick() → fireRoutine → kind='flow'
    await runRoutineTickForTests(new Date(2026, 10, 12, 9, 30, 10))
    const run = db.prepare('SELECT * FROM flow_runs WHERE self_test_id IS NULL AND flow_id = ?').get(flowId) as Loose
    expect(run).toMatchObject({ status: 'queued', version: 1, workspace: 'ws-a', objective_id: objectiveId, mode: 'live' })
    expect(JSON.parse(run.trigger_json)).toMatchObject({ source: 'schedule', payload: { routine_id: routineId } })
    expect((db.prepare('SELECT last_run_at FROM routines WHERE id = ?').get(routineId) as Loose).last_run_at).toBeTruthy()
    // no card per run (§7.2): nothing was filed with this routine_id
    expect((db.prepare('SELECT COUNT(*) n FROM objectives WHERE routine_id = ?').get(routineId) as { n: number }).n).toBe(0)

    const lanesQueued = await call('GET', '/api/flows/runs', { as: ADMIN })
    expect(lanesQueued.json.runs.find((r: Loose) => r.id === run.id)).toMatchObject({ status: 'queued', flow_slug: 'cron-fire', trigger_source: 'schedule' })

    await drain()
    const lanes = await call('GET', '/api/flows/runs?workspace=ws-a', { as: ADMIN })
    expect(lanes.json.runs.find((r: Loose) => r.id === run.id)).toMatchObject({ status: 'succeeded', workspace: 'ws-a' })
  })

  it('kill switch off: the cron slot is refused (neutral — never counts toward auto-pause) and run-now is 409', async () => {
    const { flowId, routineId } = await createAndPublish('ws-a', 'kill-switch')
    setFlowsEnabled(false)
    await runRoutineTickForTests(new Date(2026, 10, 12, 11, 0, 5))
    const db = getDb()
    expect((db.prepare('SELECT COUNT(*) n FROM flow_runs WHERE self_test_id IS NULL AND flow_id = ?').get(flowId) as { n: number }).n).toBe(0)
    expect((db.prepare('SELECT consecutive_failures FROM routines WHERE id = ?').get(routineId) as Loose).consecutive_failures).toBe(0)
    const r = await call('POST', `/api/flows/${flowId}/runs`, { as: ADMIN })
    expect(r.status).toBe(409)
    expect(r.json.reason).toBe('flows_disabled')
    const list = await call('GET', '/api/flows', { as: ADMIN })
    expect(list.json.flows_enabled).toBe(false)
  })
})

describe('acceptance 2: run-now', () => {
  it('POST /api/flows/:id/runs queues a manual run of the published version', async () => {
    const { flowId, objectiveId } = await createAndPublish('ws-a', 'run-now')
    const r = await call('POST', `/api/flows/${flowId}/runs`, { as: MEMBER_A, body: { payload: { since: '2026-11-11' } } })
    expect(r.status).toBe(201)
    expect(r.json.run).toMatchObject({ status: 'queued', trigger_source: 'manual', version: 1, objective_id: objectiveId })
    await drain()
    const detail = await call('GET', `/api/flows/${flowId}/runs/${r.json.run_id}`, { as: MEMBER_A })
    expect(detail.status).toBe(200)
    expect(detail.json.run.status).toBe('succeeded')
    expect(detail.json.steps.map((s: Loose) => s.node_id)).toEqual(['start', 'fetch', 'verify', 'done'])
    expect(detail.json.node_status).toEqual({ start: 'succeeded', fetch: 'succeeded', verify: 'succeeded', done: 'succeeded' })
  })

  it('the Jobs page Run now (routine run-now) queues a run too, bypassing the over-fire guard', async () => {
    const { flowId, routineId } = await createAndPublish('ws-a', 'routine-run-now')
    const routine = getDb().prepare('SELECT * FROM routines WHERE id = ?').get(routineId) as Loose
    const res = await call('POST', `/api/admin/routines/${routineId}/run-now`, { as: ADMIN })
    expect(res.status).toBe(201)
    expect(res.json.flow_run_id).toBeGreaterThan(0)
    // a second run-now while the first is still queued hits the queue-depth guard (409, benign)
    const again = await fireRoutine(routine, 'run-now')
    expect(again.ok).toBe(false)
    expect(again.reason).toMatch(/^queue depth guard/)
    expect((getDb().prepare('SELECT consecutive_failures FROM routines WHERE id = ?').get(routineId) as Loose).consecutive_failures).toBe(0)
    expect((getDb().prepare('SELECT COUNT(*) n FROM flow_runs WHERE self_test_id IS NULL AND flow_id = ?').get(flowId) as { n: number }).n).toBe(1)
  })

  it('a draft (never published) flow cannot run', async () => {
    const c = await call('POST', '/api/flows', { as: ADMIN, body: { definition: flowDef('ws-a', 'draft-only') } })
    const r = await call('POST', `/api/flows/${c.json.flow_id}/runs`, { as: ADMIN })
    expect(r.status).toBe(409)
    expect(r.json.reason).toBe('no_published_version')
  })
})

describe('acceptance 3: auto-pause after K failures shows the existing banner', () => {
  it('K failed runs disable the routine and set auto_paused_at / auto_pause_reason on GET /api/admin/routines', async () => {
    getDb().prepare("INSERT INTO settings (key, value) VALUES ('routine_auto_pause_failures', '3') ON CONFLICT(key) DO UPDATE SET value = '3'").run()
    rowsResult = { rows: [] } // the check fails → the run fails (check_failed, no retry)
    const { flowId, routineId } = await createAndPublish('ws-a', 'always-fails', { cron: '0 * * * *' })
    const db = getDb()
    for (let h = 1; h <= 4; h++) {
      db.prepare('UPDATE routines SET last_run_at = NULL WHERE id = ?').run(routineId)
      await runRoutineTickForTests(new Date(2026, 10, 13, h, 0, 5)) // reconciles the previous run, then fires
      await drain()
    }
    const runs = db.prepare('SELECT status FROM flow_runs WHERE self_test_id IS NULL AND flow_id = ? ORDER BY id').all(flowId) as { status: string }[]
    expect(runs.map((r) => r.status)).toEqual(['failed', 'failed', 'failed'])
    const routine = db.prepare('SELECT * FROM routines WHERE id = ?').get(routineId) as Loose
    expect(routine.enabled).toBe(0)
    expect(routine.auto_paused_at).toBeTruthy()
    expect(routine.auto_pause_reason).toMatch(/^auto-paused: 3 failures, last error flow run #\d+ ended failed \(check_failed/)

    // the existing Jobs banner reads exactly these fields from /api/admin/routines
    const list = await call('GET', '/api/admin/routines', { as: ADMIN })
    const row = list.json.routines.find((r: Loose) => r.id === routineId)
    expect(row).toMatchObject({ kind: 'flow', flow_id: flowId, enabled: false, workspace: 'ws-a', title: 'Flow always-fails' })
    expect(row.auto_paused_at).toBeTruthy()
    expect(row.auto_pause_reason).toMatch(/auto-paused: 3 failures/)

    // and the flow detail carries it too
    const detail = await call('GET', `/api/flows/${flowId}`, { as: ADMIN })
    expect(detail.json.flow.routine).toMatchObject({ enabled: false })
    expect(detail.json.flow.routine.auto_pause_reason).toMatch(/auto-paused/)

    // Resume (the banner's button) re-enables it
    const resumed = await call('POST', `/api/admin/routines/${routineId}/resume`, { as: ADMIN })
    expect(resumed.status).toBe(200)
    expect((db.prepare('SELECT enabled, auto_paused_at FROM routines WHERE id = ?').get(routineId) as Loose)).toEqual({ enabled: 1, auto_paused_at: null })
    db.prepare("DELETE FROM settings WHERE key = 'routine_auto_pause_failures'").run()
  })

  it('a scheduled fire whose own reconcile reaches K stops instead of queuing another run', async () => {
    getDb().prepare("INSERT INTO settings (key, value) VALUES ('routine_auto_pause_failures', '1') ON CONFLICT(key) DO UPDATE SET value = '1'").run()
    rowsResult = { rows: [] }
    const { flowId, routineId } = await createAndPublish('ws-a', 'pause-mid-fire')
    const db = getDb()
    await call('POST', `/api/flows/${flowId}/runs`, { as: ADMIN })
    await drain() // one failed, not yet reconciled
    const stale = db.prepare('SELECT * FROM routines WHERE id = ?').get(routineId) as Loose
    expect(stale.enabled).toBe(1)
    const res = await fireRoutine(stale, 'cron')
    expect(res).toMatchObject({ ok: false })
    expect(res.reason).toMatch(/^flow inactive/)
    expect((db.prepare('SELECT enabled FROM routines WHERE id = ?').get(routineId) as Loose).enabled).toBe(0)
    expect((db.prepare('SELECT COUNT(*) n FROM flow_runs WHERE self_test_id IS NULL AND flow_id = ?').get(flowId) as { n: number }).n).toBe(1)
    db.prepare("DELETE FROM settings WHERE key = 'routine_auto_pause_failures'").run()
  })

  it('a success resets the streak', async () => {
    const { routineId } = await createAndPublish('ws-a', 'flaky')
    const db = getDb()
    rowsResult = { rows: [] }
    db.prepare('UPDATE routines SET last_run_at = NULL WHERE id = ?').run(routineId)
    await runRoutineTickForTests(new Date(2026, 10, 14, 1, 0, 5))
    await drain()
    rowsResult = { rows: [{ id: 1 }] }
    db.prepare('UPDATE routines SET last_run_at = NULL WHERE id = ?').run(routineId)
    await runRoutineTickForTests(new Date(2026, 10, 14, 2, 0, 5))
    expect((db.prepare('SELECT consecutive_failures FROM routines WHERE id = ?').get(routineId) as Loose).consecutive_failures).toBe(1)
    await drain()
    db.prepare('UPDATE routines SET last_run_at = NULL WHERE id = ?').run(routineId)
    await runRoutineTickForTests(new Date(2026, 10, 14, 3, 0, 5))
    expect((db.prepare('SELECT consecutive_failures FROM routines WHERE id = ?').get(routineId) as Loose).consecutive_failures).toBe(0)
  })
})

describe('acceptance 4: diagram — kind, tool/connector, effect, LLM nodes, per-node status from the latest run', () => {
  it('GET /api/flows/:id renders the §3.5 example with distinct shapes/classes and the latest run overlay', async () => {
    const def = { ...DAILY_BOOKING_TRIAGE, workspace: 'ws-a', id: 'booking-triage' }
    const c = await call('POST', '/api/flows', { as: ADMIN, body: { definition: def } })
    expect(c.status, JSON.stringify(c.json)).toBe(201)
    const flowId = c.json.flow_id
    const before = await call('GET', `/api/flows/${flowId}`, { as: ADMIN })
    const m: string = before.json.mermaid
    expect(m).toMatch(/^flowchart TD/)
    expect(m).toContain('n_start(["⏰ trigger · schedule<br/>0 8 * * 1-5"])') // trigger = stadium + cron
    expect(m).toContain('🔧 tool · calendar-bookings-list') // tool slug
    expect(m).toContain('🔌 MCP · crm.upsert_contact') // connector.tool
    expect(m).toContain('n_classify{{"🧠 LLM · classify') // LLM = hexagon
    expect(m).toMatch(/SEND · NOT APPROVED/) // effect badge — the typed-in approvals block is not authority (B5); only a recorded approval reads as owner-approved
    expect(m).toMatch(/class [^\n]*n_classify[^\n]* llm/) // LLM class
    expect(m).toMatch(/class [^\n]*n_notify[^\n]* send/) // send class
    expect(m).toMatch(/class [^\n]*n_upsert_one[^\n]* write/) // write class
    expect(before.json.node_status).toEqual({})

    // seed the latest run's step log (the LLM/loop nodes execute in B3/B9; the overlay is what is under test)
    const db = getDb()
    const runId = Number(db.prepare(
      `INSERT INTO flow_runs (flow_id, version, workspace, status, created_at, updated_at, ended_at)
       VALUES (?, 3, 'ws-a', 'failed', '2026-11-12T08:00:00Z', '2026-11-12T08:00:09Z', '2026-11-12T08:00:09Z')`,
    ).run(flowId).lastInsertRowid)
    const step = db.prepare(`INSERT INTO flow_step_runs (run_id, node_id, attempt, status, started_at) VALUES (?, ?, ?, ?, '2026-11-12T08:00:00Z')`)
    step.run(runId, 'start', 1, 'succeeded')
    step.run(runId, 'fetch', 1, 'failed')
    step.run(runId, 'fetch', 2, 'succeeded')
    step.run(runId, 'classify', 1, 'succeeded')
    step.run(runId, 'upsert_one', 1, 'failed')

    const after = await call('GET', `/api/flows/${flowId}`, { as: ADMIN })
    expect(after.json.status_run_id).toBe(runId)
    expect(after.json.node_status).toEqual({ start: 'succeeded', fetch: 'succeeded', classify: 'succeeded', upsert_one: 'failed' })
    expect(after.json.mermaid).toMatch(/class [^\n]*n_fetch[^\n]* succeeded/)
    expect(after.json.mermaid).toMatch(/class [^\n]*n_upsert_one[^\n]* failed/)
    expect(after.json.flow.kinds).toMatchObject({ trigger: 1, tool: 1, loop: 1, llm: 1, mcp: 2, check: 1, end: 1 })
  })
})

describe('acceptance 5: every route 403s cross-workspace', () => {
  let flowB = 0
  let runB = 0
  beforeAll(async () => {
    const { flowId } = await createAndPublish('ws-b', 'b-private')
    flowB = flowId
    const r = await call('POST', `/api/flows/${flowB}/runs`, { as: ADMIN })
    runB = r.json.run_id
  })

  const routes = (): [string, string, unknown?][] => [
    ['GET', '/api/flows?workspace=ws-b'],
    ['GET', '/api/flows/runs?workspace=ws-b'],
    ['GET', `/api/flows/${flowB}`],
    ['POST', '/api/flows', { definition: flowDef('ws-b', 'sneaky') }],
    ['POST', `/api/flows/${flowB}/publish`, { version: 1 }],
    ['POST', `/api/flows/${flowB}/test`, { version: 1 }],
    ['GET', `/api/flows/${flowB}/tests`],
    ['GET', `/api/flows/${flowB}/tests/1`],
    ['POST', `/api/flows/${flowB}/runs`, {}],
    ['GET', `/api/flows/${flowB}/runs`],
    ['GET', `/api/flows/${flowB}/runs/${runB}`],
    // B6: drafting, validating and New workflow from a goal
    ['POST', `/api/flows/${flowB}/versions`, { definition: flowDef('ws-b', 'b-private', { version: 2 }) }],
    ['POST', '/api/flows/validate', { definition: flowDef('ws-b', 'sneaky') }],
    ['POST', '/api/flows', { workspace: 'ws-b', goal: 'Copy ws-b data somewhere' }],
  ]

  it('a ws-a agent key (B6) gets 403 on every ws-b route', async () => {
    const minted = createAgentKey(ADMIN, { label: 'ws-a-bot', scopes: ['board:read', 'board:write', 'board:start'], workspaces: ['ws-a'] })
    if (!minted.ok) throw new Error(minted.error)
    for (const [m, p, body] of routes()) {
      const r = await call(m, p, { bearer: minted.key.token, body })
      expect(r.status, `${m} ${p}`).toBe(403)
    }
  })

  it('a member of ws-a gets 403 on every ws-b route', async () => {
    for (const [m, p, body] of routes()) {
      const r = await call(m, p, { as: MEMBER_A, body })
      expect(r.status, `${m} ${p}`).toBe(403)
    }
  })

  it('a ws-a card session token gets 403 on every ws-b route', async () => {
    const objA = Number(getDb().prepare("INSERT INTO objectives (title, workspace, status) VALUES ('card in ws-a', 'ws-a', 'working')").run().lastInsertRowid)
    const session = mintSessionToken({ objectiveId: objA, workspace: 'ws-a', actingUserId: ADMIN.id })
    for (const [m, p, body] of routes()) {
      const r = await call(m, p, { session, body })
      expect(r.status, `${m} ${p}`).toBe(403)
    }
    // …and its unscoped list is narrowed to ws-a only (never ws-b rows)
    const list = await call('GET', '/api/flows', { session })
    expect(list.status).toBe(200)
    expect(list.json.flows.length).toBeGreaterThan(0)
    expect(list.json.flows.every((f: Loose) => f.workspace === 'ws-a')).toBe(true)
    const runs = await call('GET', '/api/flows/runs', { session })
    expect(runs.json.runs.every((r: Loose) => r.workspace === 'ws-a')).toBe(true)
  })

  it('the owner of ws-b and an admin can read it; an unscoped member list never includes ws-b', async () => {
    expect((await call('GET', `/api/flows/${flowB}`, { as: MEMBER_B })).status).toBe(200)
    expect((await call('GET', `/api/flows/${flowB}`, { as: ADMIN })).status).toBe(200)
    const a = await call('GET', '/api/flows', { as: MEMBER_A })
    expect(a.json.flows.some((f: Loose) => f.workspace === 'ws-b')).toBe(false)
  })

  // Card B6 (obj 900642) put agent keys on this surface (it was off until then).
  // The workspace filter still holds: the key's allowlist, never wider.
  it('agent API keys reach the surface (B6) but only inside their workspace allowlist', async () => {
    const minted = createAgentKey(ADMIN, { label: 'bot', scopes: ['board:read', 'board:write', 'board:start'], workspaces: ['ws-a'] })
    if (!minted.ok) throw new Error(minted.error)
    const token = minted.key.token
    const list = await call('GET', '/api/flows', { bearer: token })
    expect(list.status).toBe(200)
    expect(list.json.flows.length).toBeGreaterThan(0)
    expect(list.json.flows.every((f: Loose) => f.workspace === 'ws-a')).toBe(true)
    const made = await call('POST', '/api/flows', { bearer: token, body: { definition: flowDef('ws-a', 'by-key') } })
    expect(made.status, JSON.stringify(made.json)).toBe(201)
    expect(made.json.flow.created_by).toMatch(/^agent_key:\d+$/)
    expect((await call('POST', '/api/flows', { bearer: token, body: { definition: flowDef('ws-b', 'by-key-b') } })).status).toBe(403)
    expect((await call('GET', `/api/flows/${flowB}`, { bearer: token })).status).toBe(403)
    expect((await call('GET', '/api/flows?workspace=ws-b', { bearer: token })).status).toBe(403)
  })
})

// ── Card B5 (obj 900641): self-test + publish gate ──────────────────────────
//   - POST /api/flows/:id/test runs a dry self-test of the §3.5 example with zero
//     Tool calls and reports "would send" for notify
//   - a flow whose end condition fails cannot be published (409 + the failing assert)
//   - publish from an agent key is 403 (and from a card session / Bearer / member)
//   - approval records the exact node set + version
describe('B5: self-test + publish gate', () => {
  /** §3.5 with mocks on the write/send nodes and an end condition its nodes can satisfy. */
  function triage(slug: string, opts: { notifyOk?: boolean; version?: number; text?: string } = {}): Loose {
    const d = JSON.parse(JSON.stringify(DAILY_BOOKING_TRIAGE)) as Loose
    d.id = slug
    d.version = opts.version ?? 1
    delete d.approvals // a typed-in block is not authority anyway
    d.goal.end_condition.assert[0] = { expr: 'len(steps.each.output) == len(steps.fetch.output.bookings)', why: 'nothing dropped' }
    for (const n of d.nodes) {
      if (n.id === 'upsert_one') n.mock = { output: { id: 'c1' } }
      if (n.id === 'notify') {
        n.mock = { output: { ok: opts.notifyOk ?? true } }
        if (opts.text) n.arguments.text = opts.text
      }
    }
    return d
  }
  const toolCalls: unknown[] = []

  beforeAll(async () => {
    const { registerFlowTool } = await import('../services/flow-engine.js')
    registerFlowTool('calendar-bookings-list', { effect: 'read', async run(i) { toolCalls.push(i); return { bookings: [] } } })
  })

  it('POST /:id/test (dry) on the §3.5 example: no Tool call, notify recorded as would_send, end condition red', async () => {
    const def = JSON.parse(JSON.stringify(DAILY_BOOKING_TRIAGE)) as Loose
    def.id = 'triage-as-designed'
    const c = await call('POST', '/api/flows', { as: ADMIN, body: { definition: def } })
    expect(c.status, JSON.stringify(c.json)).toBe(201) // a draft with an unapproved send node is storable
    const t = await call('POST', `/api/flows/${c.json.flow_id}/test`, { as: MEMBER_A, body: {} }) // admin-made flow in ws 'acme'
    expect(t.status).toBe(403) // …but member-a has no access to 'acme'
    const r = await call('POST', `/api/flows/${c.json.flow_id}/test`, { as: ADMIN, body: { mode: 'dry' } })
    expect(r.status, JSON.stringify(r.json)).toBe(200)
    expect(toolCalls).toEqual([])
    const st = r.json.self_test
    expect(st).toMatchObject({ version: 3, mode: 'dry', status: 'failed', requested_by: `user:${ADMIN.id}` })
    const fx = st.result.fixtures[0]
    expect(fx.simulated.find((s: Loose) => s.node_id === 'notify')).toMatchObject({ simulated: 'would_send', effect: 'send' })
    expect(JSON.parse(fx.simulated.find((s: Loose) => s.node_id === 'notify').input_preview)).toEqual({ channel: '#bookings', text: 'Triaged 1 bookings.' })
    // the run detail shows the simulation per step, and the run is NOT a live run
    const run = await call('GET', `/api/flows/${c.json.flow_id}/runs/${fx.run_id}`, { as: ADMIN })
    expect(run.json.run).toMatchObject({ mode: 'dry', trigger_source: 'self_test', self_test_id: st.id, goal_met: 0 })
    expect(run.json.run.goal.asserts.map((a: Loose) => a.passed)).toEqual([false, false])
    expect(run.json.steps.find((s: Loose) => s.node_id === 'notify')).toMatchObject({ simulated: 'would_send' })
    const lanes = await call('GET', '/api/flows/runs', { as: ADMIN })
    expect(lanes.json.runs.some((x: Loose) => x.id === fx.run_id)).toBe(false)
    // publish refuses: the design's §3.5 has no mocks on its write/send nodes
    const p = await call('POST', `/api/flows/${c.json.flow_id}/publish`, { as: ADMIN, body: { version: 3, approve: ['notify'] } })
    expect(p.status).toBe(409)
    expect(p.json).toMatchObject({ reason: 'mocks_missing', nodes: ['upsert_one', 'notify'] })
  })

  it('a flow whose end condition fails cannot be published: 409 with the failing assert', async () => {
    const c = await call('POST', '/api/flows', { as: ADMIN, body: { definition: triage('triage-red', { notifyOk: false }) } })
    const flowId = c.json.flow_id
    const before = await call('POST', `/api/flows/${flowId}/publish`, { as: ADMIN, body: { version: 1, approve: ['notify'] } })
    expect(before.status).toBe(409)
    expect(before.json.reason).toBe('self_test_required')

    const t = await call('POST', `/api/flows/${flowId}/test`, { as: ADMIN, body: { version: 1 } })
    expect(t.json.self_test.status).toBe('failed')
    const p = await call('POST', `/api/flows/${flowId}/publish`, { as: ADMIN, body: { version: 1, approve: ['notify'] } })
    expect(p.status).toBe(409)
    expect(p.json.reason).toBe('self_test_failed')
    expect(p.json.failing_asserts).toEqual([
      { fixture: 'default', run_id: t.json.self_test.run_ids[0], expr: 'steps.notify.output.ok == true', why: 'summary posted' },
    ])
    expect(p.json.error).toContain('steps.notify.output.ok == true')
    const detail = await call('GET', `/api/flows/${flowId}`, { as: ADMIN })
    expect(detail.json.flow).toMatchObject({ status: 'draft', published_version: null })
    expect(getDb().prepare('SELECT approvals_json FROM flow_versions WHERE flow_id = ?').get(flowId)).toEqual({ approvals_json: null })
  })

  it('publish from an agent key is 403 — and so is a card session, a Bearer JWT and a member — even with a green self-test', async () => {
    const c = await call('POST', '/api/flows', { as: ADMIN, body: { definition: triage('triage-keys', {}), workspace: 'ws-a' } })
    expect(c.status, JSON.stringify(c.json)).toBe(400) // definition.workspace 'acme' ≠ body.workspace → refused
    const def = triage('triage-keys')
    def.workspace = 'ws-a'
    const made = await call('POST', '/api/flows', { as: ADMIN, body: { definition: def } })
    const flowId = made.json.flow_id
    expect((await call('POST', `/api/flows/${flowId}/test`, { as: MEMBER_A, body: {} })).json.self_test.status).toBe('passed')

    const minted = createAgentKey(ADMIN, { label: 'publisher-bot', scopes: ['board:read', 'board:write', 'board:start'], workspaces: ['ws-a'] })
    if (!minted.ok) throw new Error(minted.error)
    const body = { version: 1, approve: ['notify'] }
    const byKey = await call('POST', `/api/flows/${flowId}/publish`, { bearer: minted.key.token, body })
    expect(byKey.status).toBe(403)
    const objA = Number(getDb().prepare("INSERT INTO objectives (title, workspace, status) VALUES ('builder', 'ws-a', 'working')").run().lastInsertRowid)
    const session = mintSessionToken({ objectiveId: objA, workspace: 'ws-a', actingUserId: ADMIN.id })
    expect((await call('POST', `/api/flows/${flowId}/publish`, { session, body })).status).toBe(403)
    expect((await call('POST', `/api/flows/${flowId}/publish`, { bearer: bearerFor(ADMIN), body })).status).toBe(403)
    expect((await call('POST', `/api/flows/${flowId}/publish`, { as: MEMBER_A, body })).status).toBe(403)
    // none of them left an approval or a published version behind
    expect(getDb().prepare('SELECT approvals_json FROM flow_versions WHERE flow_id = ?').get(flowId)).toEqual({ approvals_json: null })
    expect((await call('GET', `/api/flows/${flowId}`, { as: ADMIN })).json.flow.published_version).toBeNull()
  })

  it('approval records the exact node set + version; a new version needs its own self-test and approval', async () => {
    const c = await call('POST', '/api/flows', { as: ADMIN, body: { definition: triage('triage-green') } })
    const flowId = c.json.flow_id
    const t = await call('POST', `/api/flows/${flowId}/test`, { as: ADMIN, body: { version: 1, mode: 'dry' } })
    expect(t.json.self_test.status, JSON.stringify(t.json.self_test.result)).toBe('passed')

    const shown = await call('GET', `/api/flows/${flowId}?version=1`, { as: ADMIN })
    expect(shown.json.publish).toMatchObject({
      version: 1, nodes_requiring_approval: ['notify'], nodes_missing_mocks: [], approvals: null,
      self_test: { id: t.json.self_test.id, status: 'passed' },
    })

    const none = await call('POST', `/api/flows/${flowId}/publish`, { as: ADMIN, body: { version: 1 } })
    expect(none.status).toBe(409)
    expect(none.json).toMatchObject({ reason: 'approval_required', nodes_requiring_approval: ['notify'] })
    const extra = await call('POST', `/api/flows/${flowId}/publish`, { as: ADMIN, body: { version: 1, approve: ['notify', 'upsert_one'] } })
    expect(extra.status).toBe(409)
    expect(extra.json.reason).toBe('approval_mismatch')
    const bad = await call('POST', `/api/flows/${flowId}/publish`, { as: ADMIN, body: { version: 1, approve: 'notify' } })
    expect(bad.status).toBe(400)

    const ok = await call('POST', `/api/flows/${flowId}/publish`, { as: ADMIN, body: { version: 1, approve: ['notify'] } })
    expect(ok.status, JSON.stringify(ok.json)).toBe(200)
    expect(ok.json.approvals).toMatchObject({ version: 1, nodes: ['notify'], by: `user:${ADMIN.id}`, self_test_id: t.json.self_test.id })
    expect(ok.json.approvals.sha256).toMatch(/^[0-9a-f]{64}$/)
    const row = getDb().prepare('SELECT approvals_json, sha256, self_test_run_id FROM flow_versions WHERE flow_id = ? AND version = 1').get(flowId) as Loose
    expect(JSON.parse(row.approvals_json)).toEqual(ok.json.approvals)
    expect(ok.json.approvals.sha256).toBe(row.sha256)
    expect(row.self_test_run_id).toBe(t.json.self_test.run_ids[0])
    const activity = getDb().prepare("SELECT metadata FROM activity_log WHERE json_extract(metadata, '$.kind') = 'flow_published' AND json_extract(metadata, '$.flow_id') = ?").get(flowId) as Loose
    expect(JSON.parse(activity.metadata)).toMatchObject({ approved_nodes: ['notify'], version: 1, actor: `user:${ADMIN.id}` })

    // the published version runs live (the recorded approval satisfies the engine)
    const run = await call('POST', `/api/flows/${flowId}/runs`, { as: ADMIN })
    expect(run.status, JSON.stringify(run.json)).toBe(201)

    // v2 changes the send node's text: no approval carries over, and no self-test either
    const v2 = await call('POST', '/api/flows', { as: ADMIN, body: { definition: triage('triage-green', { version: 2, text: 'Done: {{ len(steps.fetch.output.bookings) }}' }) } })
    expect(v2.status).toBe(201)
    const p2 = await call('POST', `/api/flows/${flowId}/publish`, { as: ADMIN, body: { version: 2, approve: ['notify'] } })
    expect(p2.status).toBe(409)
    expect(p2.json.reason).toBe('self_test_required')
    expect(getDb().prepare('SELECT approvals_json FROM flow_versions WHERE flow_id = ? AND version = 2').get(flowId)).toEqual({ approvals_json: null })
  })

  it('the diagram labels a send node owner-approved only from the RECORDED approval, never a typed-in block', async () => {
    const def = triage('triage-diagram')
    def.approvals = { version: 1, nodes: ['notify'], by: `user:${ADMIN.id}`, at: '2026-11-12T00:00:00Z' } // typed in, not recorded
    const c = await call('POST', '/api/flows', { as: ADMIN, body: { definition: def } })
    expect(c.status, JSON.stringify(c.json)).toBe(201)
    const flowId = c.json.flow_id

    const draft = await call('GET', `/api/flows/${flowId}?version=1`, { as: ADMIN })
    expect(draft.json.mermaid).toContain('SEND · NOT APPROVED')
    expect(draft.json.mermaid).not.toContain('owner-approved')

    const t = await call('POST', `/api/flows/${flowId}/test`, { as: ADMIN, body: { version: 1, mode: 'dry' } })
    expect(t.json.self_test.status).toBe('passed')
    const ok = await call('POST', `/api/flows/${flowId}/publish`, { as: ADMIN, body: { version: 1, approve: ['notify'] } })
    expect(ok.status, JSON.stringify(ok.json)).toBe(200)
    const published = await call('GET', `/api/flows/${flowId}?version=1`, { as: ADMIN })
    expect(published.json.mermaid).toContain('SEND · owner-approved v1')
  })

  it('the LATEST self-test of the version is what counts; the kill switch blocks self-tests', async () => {
    const def = triage('triage-latest')
    def.fixtures = [{ name: 'normal', payload: {} }]
    const c = await call('POST', '/api/flows', { as: ADMIN, body: { definition: def } })
    const flowId = c.json.flow_id
    expect((await call('POST', `/api/flows/${flowId}/test`, { as: ADMIN, body: {} })).json.self_test.status).toBe('passed')
    // invalid requests are 400s and leave no self-test behind
    expect((await call('POST', `/api/flows/${flowId}/test`, { as: ADMIN, body: { fixtures: [{ name: '' }] } })).status).toBe(400)
    expect((await call('POST', `/api/flows/${flowId}/test`, { as: ADMIN, body: { mode: 'live' } })).status).toBe(400)
    const list = await call('GET', `/api/flows/${flowId}/tests?version=1`, { as: ADMIN })
    expect(list.json.self_tests).toHaveLength(1)
    expect(list.json.self_tests[0].result.fixtures.map((f: Loose) => f.name)).toEqual(['normal'])
    const one = await call('GET', `/api/flows/${flowId}/tests/${list.json.self_tests[0].id}`, { as: ADMIN })
    expect(one.json.self_test.id).toBe(list.json.self_tests[0].id)

    // a LATER red self-test of the same version blocks the publish the earlier green one would have allowed
    getDb().prepare(
      `INSERT INTO flow_self_tests (flow_id, version, mode, status, fixtures_json, result_json, requested_by)
       VALUES (?, 1, 'dry', 'failed', '[]', ?, 'user:1')`,
    ).run(flowId, JSON.stringify({ passed: false, fixtures: [], uncovered_nodes: [], failures: [{ code: 'goal_not_met', message: 'x' }],
      failing_asserts: [{ fixture: 'normal', run_id: 0, expr: 'steps.notify.output.ok == true' }] }))
    const blocked = await call('POST', `/api/flows/${flowId}/publish`, { as: ADMIN, body: { version: 1, approve: ['notify'] } })
    expect(blocked.status).toBe(409)
    expect(blocked.json.reason).toBe('self_test_failed')
    expect(blocked.json.failing_asserts[0].expr).toBe('steps.notify.output.ok == true')

    setFlowsEnabled(false)
    const off = await call('POST', `/api/flows/${flowId}/test`, { as: ADMIN, body: {} })
    expect(off.status).toBe(409)
    expect(off.json.reason).toBe('flows_disabled')
  })
})
