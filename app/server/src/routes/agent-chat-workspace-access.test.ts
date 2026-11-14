// Per-bot workspace access over HTTP (obj 900797). Proves:
//   - bots stay global: one list of bots for the install, each carrying its
//     workspace access; a member only sees workspace names they belong to;
//   - grant / revoke / set are a signed-in admin's click only — never a member,
//     never an API key (a bot must not widen its own reach); every change is
//     recorded in the activity log;
//   - High Agency can only wake in a granted workspace; revoking that workspace
//     switches High Agency off and disables its routine; a wake that still
//     points at a revoked workspace is refused at fire time;
//   - a card a High Agency wake files must land in a granted workspace
//     (POST /api/internal/objectives).
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'
import cookieParser from 'cookie-parser'
import jwt from 'jsonwebtoken'

process.env.JWT_SECRET = 'test-secret-bot-ws-access-xxxx'
const TMP_DB = path.join(os.tmpdir(), `cc-bot-ws-access-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB
// A dead port: the scheduler's spawn PATCH must never reach a live Command Center.
process.env.PORT = '59947'
const TMP_AGENTS = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-bot-ws-access-agents-'))
process.env.AGENT_FILES_DIR = TMP_AGENTS
process.env.AGENT_CHAT_BUILTINS = '0'
process.env.AGENT_CHAT_PROVIDER = 'demo'

const { initDb, getDb } = await import('../db/index.js')
const { default: router } = await import('./agent-chat.js')
const { default: internalRouter } = await import('./internal.js')
const { createAgentKey } = await import('../lib/agent-keys.js')
const { fireRoutine } = await import('../services/routine-scheduler.js')
const { seedExistingBotsOnce } = await import('../services/agent-chat/bot-workspaces.js')

const ADMIN = 1
const MEMBER = 2 // member of ops only

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any

let server: http.Server
let baseUrl: string
let agentKey = ''
const realFetch = globalThis.fetch

function tokenFor(id: number, role: string) {
  return jwt.sign({ id, username: `user${id}`, role }, process.env.JWT_SECRET as string, { expiresIn: '1h' })
}

async function call(method: string, p: string, opts: { as?: number; role?: string; body?: unknown; key?: string; base?: string } = {}) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (opts.key) headers.Authorization = `Bearer ${opts.key}`
  else if (opts.as) headers.Cookie = `token=${tokenFor(opts.as, opts.role ?? 'member')}`
  const res = await realFetch(`${baseUrl}${opts.base ?? '/api/agent-chat'}${p}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) })
  const text = await res.text()
  let json: Loose = null
  try { json = text ? JSON.parse(text) : null } catch { /* not json */ }
  return { status: res.status, json }
}

const admin = (method: string, p: string, body?: unknown) => call(method, p, { as: ADMIN, role: 'admin', body })

/** The scheduler's spawn PATCH answers 200; every other request is real. */
function stubSpawn() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input)
    if (url.includes('/api/internal/objectives/') && url.endsWith('/status')) {
      return Promise.resolve(new Response('{}', { status: 200 }))
    }
    return realFetch(input, init)
  }) as typeof fetch)
}

function writeBot(slug: string, yaml: string) {
  fs.mkdirSync(path.join(TMP_AGENTS, slug), { recursive: true })
  fs.writeFileSync(path.join(TMP_AGENTS, slug, 'agent.yaml'), yaml)
}

function routine(slug: string) {
  return getDb().prepare('SELECT * FROM routines WHERE name = ?').get(`high-agency:${slug}`) as Loose
}

function activity(kind: string): Loose[] {
  return getDb().prepare("SELECT * FROM activity_log WHERE json_extract(metadata, '$.kind') = ? ORDER BY id").all(kind) as Loose[]
}

beforeAll(async () => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
  const db = getDb()
  db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (1, 'user1', 'x', 'admin')`).run()
  db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (2, 'user2', 'x', 'member')`).run()
  db.prepare(`INSERT OR IGNORE INTO workspaces (slug, name) VALUES ('ops', 'Ops'), ('sales', 'Sales'), ('finance', 'Finance')`).run()
  db.prepare(`INSERT INTO user_workspaces (user_id, workspace, role) VALUES (1, 'ops', 'admin'), (1, 'sales', 'admin'), (1, 'finance', 'admin'), (2, 'ops', 'member')`).run()
  writeBot('cto', 'name: CTO\nsystem_prompt: You own engineering.\ntools: [list_objectives, create_objective]\n')
  writeBot('legacy', 'name: Legacy\nsystem_prompt: Old bot.\n')
  // 'legacy' existed before access lists; 'cto' is a bot added afterwards.
  seedExistingBotsOnce(['legacy'])
  const k = createAgentKey({ id: ADMIN, role: 'admin' }, { label: 'grok-bot' })
  if (!k.ok) throw new Error(k.error)
  agentKey = k.key.token

  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  app.use('/api/agent-chat', router)
  app.use('/api/internal', internalRouter)
  await new Promise<void>(resolve => { server = app.listen(0, () => resolve()) })
  const addr = server.address()
  baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
})

afterEach(() => { vi.restoreAllMocks() })

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
  for (const p of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) fs.rmSync(p, { force: true })
  fs.rmSync(TMP_AGENTS, { recursive: true, force: true })
})

describe('bots stay global; each carries its workspace access', () => {
  it('the bot list shows each bot\'s access: a new bot has none, an existing one is not restricted yet', async () => {
    const list = await admin('GET', '/agents')
    expect(list.status).toBe(200)
    const by = Object.fromEntries((list.json.agents as Loose[]).map(a => [a.slug, a]))
    expect(by.cto.workspace_access).toEqual({ mode: 'restricted', workspaces: [], count: 0 })
    expect(by.legacy.workspace_access).toEqual({ mode: 'unrestricted', workspaces: [], count: 0 })

    const one = await admin('GET', '/agents/cto/workspaces')
    expect(one.status).toBe(200)
    expect(one.json.access).toMatchObject({ slug: 'cto', mode: 'restricted', configured: false, workspaces: [] })
    expect(one.json.workspace_options.map((w: Loose) => w.slug)).toEqual(expect.arrayContaining(['finance', 'ops', 'sales']))
  })
})

describe('grant and revoke: a signed-in admin only', () => {
  it('a member and an API key cannot grant, revoke or set', async () => {
    for (const [method, p, body] of [
      ['POST', '/agents/cto/workspaces', { workspace: 'ops' }],
      ['PUT', '/agents/cto/workspaces', { workspaces: ['ops'] }],
      ['DELETE', '/agents/cto/workspaces/ops', undefined],
    ] as const) {
      expect((await call(method, p, { as: MEMBER, body })).status).toBe(403)
      expect((await call(method, p, { key: agentKey, body })).status).toBe(403)
    }
    expect((await admin('GET', '/agents/cto/workspaces')).json.access.workspaces).toEqual([])
  })

  it('grant adds a workspace (201), is recorded, and is idempotent', async () => {
    const r = await admin('POST', '/agents/cto/workspaces', { workspace: 'ops' })
    expect(r.status).toBe(201)
    expect(r.json.access).toMatchObject({ mode: 'restricted', configured: true, workspaces: ['ops'] })
    expect(r.json.access.grants[0]).toMatchObject({ workspace: 'ops', granted_by: 'user1' })
    expect((await admin('POST', '/agents/cto/workspaces', { workspace: 'ops' })).status).toBe(200)
    expect(activity('bot_workspace_granted').map(a => JSON.parse(a.metadata))).toEqual([
      expect.objectContaining({ slug: 'cto', workspaces: ['ops'], actor: 'user1' }),
    ])
  })

  it('refuses an unknown workspace (404) and a non-slug (400)', async () => {
    expect((await admin('POST', '/agents/cto/workspaces', { workspace: 'nope' })).status).toBe(404)
    expect((await admin('POST', '/agents/cto/workspaces', { workspace: '../x' })).status).toBe(400)
    expect((await admin('PUT', '/agents/cto/workspaces', { workspaces: 'ops' })).status).toBe(400)
    expect((await admin('POST', '/agents/no-such-bot/workspaces', { workspace: 'ops' })).status).toBe(404)
  })

  it('a member sees the bot\'s access only for workspaces they belong to', async () => {
    await admin('PUT', '/agents/cto/workspaces', { workspaces: ['ops', 'finance'] })
    const r = await call('GET', '/agents/cto/workspaces', { as: MEMBER })
    expect(r.status).toBe(200)
    expect(r.json.access.workspaces).toEqual(['ops'])
    expect(r.json.workspace_options).toBeUndefined()
    const list = await call('GET', '/agents', { as: MEMBER })
    const cto = (list.json.agents as Loose[]).find(a => a.slug === 'cto')
    // The member sees only their own workspace and no count hinting at the others.
    expect(cto.workspace_access).toEqual({ mode: 'restricted', workspaces: ['ops'], count: 1 })
  })

  it('revoke removes a workspace; revoking the last leaves the bot with none', async () => {
    await admin('PUT', '/agents/cto/workspaces', { workspaces: ['ops', 'finance'] })
    let r = await admin('DELETE', '/agents/cto/workspaces/finance')
    expect(r.status).toBe(200)
    expect(r.json.access.workspaces).toEqual(['ops'])
    r = await admin('DELETE', '/agents/cto/workspaces/ops')
    expect(r.json.access).toMatchObject({ mode: 'restricted', workspaces: [] })
    expect(activity('bot_workspace_revoked').length).toBeGreaterThanOrEqual(2)
  })

  it('revoking from a not-yet-restricted bot is a 409; granting restricts it', async () => {
    expect((await admin('DELETE', '/agents/legacy/workspaces/ops')).status).toBe(409)
    const r = await admin('POST', '/agents/legacy/workspaces', { workspace: 'sales' })
    expect(r.status).toBe(201)
    expect(r.json.access).toMatchObject({ mode: 'restricted', workspaces: ['sales'] })
  })
})

describe('High Agency only wakes in a granted workspace', () => {
  it('cannot be switched on, or woken, without a granted workspace', async () => {
    await admin('PUT', '/agents/cto/workspaces', { workspaces: [] })
    let r = await admin('PUT', '/agents/cto/high-agency', { enabled: true })
    expect(r.status).toBe(409)
    expect(r.json.error).toMatch(/no workspace it may wake in/)
    r = await admin('POST', '/agents/cto/high-agency/wake')
    expect(r.status).toBe(409)
    expect(routine('cto')).toBeUndefined()
  })

  it('the wake picker only offers granted workspaces, and a non-granted one is refused', async () => {
    await admin('PUT', '/agents/cto/workspaces', { workspaces: ['sales'] })
    const view = await admin('GET', '/agents/cto/high-agency')
    expect(view.json.workspace_options).toEqual(['sales'])
    const r = await admin('PUT', '/agents/cto/high-agency', { enabled: true, workspace: 'ops' })
    expect(r.status).toBe(403)
    expect(r.json.error).toMatch(/not granted workspace "ops"/)
  })

  it('revoking the wake workspace switches High Agency off and disables its routine', async () => {
    await admin('PUT', '/agents/cto/workspaces', { workspaces: ['sales', 'ops'] })
    const on = await admin('PUT', '/agents/cto/high-agency', { enabled: true, workspace: 'sales' })
    expect(on.status).toBe(200)
    expect(on.json.high_agency).toMatchObject({ enabled: true, workspace: 'sales' })
    expect(Number(routine('cto').enabled)).toBe(1)

    const r = await admin('DELETE', '/agents/cto/workspaces/sales')
    expect(r.status).toBe(200)
    expect(r.json.high_agency_switched_off).toBe(true)
    const after = await admin('GET', '/agents/cto/high-agency')
    expect(after.json.high_agency).toMatchObject({ enabled: false, workspace: null })
    expect(Number(routine('cto').enabled)).toBe(0)
  })

  it('a wake whose workspace was revoked behind its back is refused at fire time, filing nothing', async () => {
    await admin('PUT', '/agents/cto/workspaces', { workspaces: ['ops'] })
    await admin('PUT', '/agents/cto/high-agency', { enabled: true, workspace: 'ops' })
    // Revoke straight in the DB, bypassing the route's High Agency switch-off.
    getDb().prepare("DELETE FROM agent_chat_bot_workspaces WHERE slug = 'cto' AND workspace = 'ops'").run()
    stubSpawn()
    const before = (getDb().prepare('SELECT COUNT(*) AS n FROM objectives').get() as Loose).n
    const res = await fireRoutine(routine('cto'), 'run-now')
    expect(res.ok).toBe(false)
    expect(res.reason).toMatch(/^bot workspace guard: bot "cto" is not granted workspace "ops"/)
    expect((getDb().prepare('SELECT COUNT(*) AS n FROM objectives').get() as Loose).n).toBe(before)
  })
})

describe('cards filed by a High Agency wake land only in granted workspaces', () => {
  it('POST /api/internal/objectives refuses a wake child outside the bot\'s list and accepts a granted one', async () => {
    await admin('PUT', '/agents/cto/workspaces', { workspaces: ['ops'] })
    await admin('PUT', '/agents/cto/high-agency', { enabled: true, workspace: 'ops' })
    stubSpawn()
    const wake = await fireRoutine(routine('cto'), 'run-now')
    expect(wake.ok).toBe(true)
    const wakeId = wake.objective_id!
    expect((getDb().prepare('SELECT workspace, agent_context FROM objectives WHERE id = ?').get(wakeId) as Loose)).toMatchObject({ workspace: 'ops', agent_context: 'cto' })

    const denied = await call('POST', '/objectives', {
      base: '/api/internal',
      body: [{ title: 'Audit the finance close', description: 'x', workspace: 'finance', type: 'task', source_job_id: wakeId }],
    })
    expect(denied.status).toBe(403)
    expect(denied.json.error).toMatch(/bot 'cto' is not granted workspace 'finance'/)
    expect((getDb().prepare("SELECT COUNT(*) AS n FROM objectives WHERE title = 'Audit the finance close'").get() as Loose).n).toBe(0)

    const ok = await call('POST', '/objectives', {
      base: '/api/internal',
      body: [{ title: 'Fix the flaky deploy check', description: 'x', workspace: 'ops', type: 'task', source_job_id: wakeId }],
    })
    expect(ok.status, JSON.stringify(ok.json)).toBe(201)

    // A child linked by parent_id instead of source_job_id is gated the same way.
    const viaParent = await call('POST', '/objectives', {
      base: '/api/internal',
      body: [{ title: 'Child in finance', description: 'x', workspace: 'finance', type: 'task', parent_id: wakeId }],
    })
    expect(viaParent.status).toBe(403)
  })

  it('cards from anything other than a High Agency wake are not affected', async () => {
    const parent = Number(getDb().prepare("INSERT INTO objectives (title, workspace, status, type) VALUES ('plain job', 'ops', 'working', 'task')").run().lastInsertRowid)
    const r = await call('POST', '/objectives', {
      base: '/api/internal',
      body: [{ title: 'Unrelated follow-up', description: 'x', workspace: 'finance', type: 'task', source_job_id: parent }],
    })
    expect(r.status, JSON.stringify(r.json)).toBe(201)
  })
})
