/**
 * owner_bot on cards (obj 900270).
 *
 * Real DB, real auth + objectives + MCP routers behind the real agentKeyGuard.
 * Fixtures only — every card here is created in a throwaway temp DB.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'
import cookieParser from 'cookie-parser'
import jwt from 'jsonwebtoken'

const TMP_DB = path.join(os.tmpdir(), `cc-owner-bot-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB
process.env.JWT_SECRET = 'test-secret-owner-bot-xxxx'

const { initDb, getDb } = await import('../db/index.js')
const { createAgentKey } = await import('../lib/agent-keys.js')
const { agentKeyGuard } = await import('../middleware/agent-key-guard.js')
const { default: authRouter } = await import('./auth.js')
const { default: objectivesRouter } = await import('./objectives.js')
const { default: objectivesSearchRouter } = await import('./objectives-search.js')
const { default: workspacesRouter } = await import('./workspaces.js')
const { default: agentMcpRouter, MCP_TOOLS } = await import('./agent-mcp.js')
const { validateOwnerBot, OWNER_BOT_MAX_LENGTH } = await import('@operationkit/shared')

const ADMIN_ID = 1
const WS = 'example'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any

let server: http.Server
let baseUrl: string
const adminCookie = () => `token=${jwt.sign({ id: ADMIN_ID, username: 'admin', role: 'admin' }, process.env.JWT_SECRET as string, { expiresIn: '1h' })}`

function mint(label: string): { token: string; id: number } {
  const r = createAgentKey({ id: ADMIN_ID, role: 'admin' }, { label })
  if (!r.ok) throw new Error(r.error)
  return { token: r.key.token, id: r.key.id }
}

async function call(method: string, p: string, opts: { bearer?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (opts.bearer) headers.Authorization = `Bearer ${opts.bearer}`
  else headers.Cookie = adminCookie()
  const res = await fetch(`${baseUrl}${p}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) })
  const text = await res.text()
  let json: Loose = null
  try { json = JSON.parse(text) } catch { json = text }
  return { status: res.status, json }
}

let rpcId = 1
async function callTool(name: string, args: Record<string, unknown>, token: string) {
  const res = await fetch(`${baseUrl}/api/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method: 'tools/call', params: { name, arguments: args } }),
  })
  expect(res.status).toBe(200)
  const json = await res.json() as Loose
  const result = json.result as { content: { text: string }[]; isError?: boolean }
  return { result, data: result.isError ? null : JSON.parse(result.content[0].text) }
}

const ownerOf = (id: number) => (getDb().prepare('SELECT owner_bot FROM objectives WHERE id = ?').get(id) as { owner_bot: string | null }).owner_bot

beforeAll(async () => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
  getDb().prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (?, 'admin', 'x', 'admin')`).run(ADMIN_ID)
  // The duplicate-title guard is not under test here.
  getDb().prepare(`INSERT INTO settings (key, value) VALUES ('duplicate_guard_enabled', '0') ON CONFLICT(key) DO UPDATE SET value = '0'`).run()
  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  app.use(agentKeyGuard)
  app.use('/api/auth', authRouter)
  app.use('/api/objectives/search', objectivesSearchRouter)
  app.use('/api/objectives', objectivesRouter)
  app.use('/api/workspaces', workspacesRouter)
  app.use('/api', agentMcpRouter)
  await new Promise<void>(r => { server = app.listen(0, '127.0.0.1', () => r()) })
  const addr = server.address() as { port: number }
  baseUrl = `http://127.0.0.1:${addr.port}`
})

afterAll(async () => {
  await new Promise<void>(r => server.close(() => r()))
  try { getDb().close() } catch { /* ignore */ }
  for (const s of ['', '-wal', '-shm']) { const f = `${TMP_DB}${s}`; if (fs.existsSync(f)) fs.unlinkSync(f) }
})

describe('validateOwnerBot', () => {
  it('trims, caps length, keeps a safe charset; absent = unchanged, null/blank = unowned', () => {
    expect(validateOwnerBot(undefined)).toEqual({ ok: true, value: undefined })
    expect(validateOwnerBot(null)).toEqual({ ok: true, value: null })
    expect(validateOwnerBot('   ')).toEqual({ ok: true, value: null })
    expect(validateOwnerBot('  Grok: Research  ')).toEqual({ ok: true, value: 'Grok: Research' })
    for (const ok of ['grok-research', 'bot_12', 'Grok: Inbox', 'grok.cos@v2', 'A', 'x'.repeat(OWNER_BOT_MAX_LENGTH)]) {
      expect(validateOwnerBot(ok), ok).toEqual({ ok: true, value: ok })
    }
    for (const bad of [
      'x'.repeat(OWNER_BOT_MAX_LENGTH + 1), '<script>', 'a"b', "a'b", 'a/b', 'a\\b', 'line\nbreak', 'tab\there',
      'two  spaces', '-leading-dash', ':colon', 'emoji 🤖', 'semi;colon', 'a\u0000b', 'a‮b',
    ]) {
      expect(validateOwnerBot(bad).ok, JSON.stringify(bad)).toBe(false)
    }
    for (const notString of [42, true, {}, ['grok']]) expect(validateOwnerBot(notString).ok).toBe(false)
  })
})

describe('owner_bot over REST', () => {
  it('create: absent → null (unowned); explicit value is stored trimmed and returned', async () => {
    const plain = await call('POST', '/api/objectives', { body: { title: 'unowned card', description: '', workspace: WS } })
    expect(plain.status).toBe(201)
    expect(plain.json.owner_bot).toBeNull()
    expect(ownerOf(plain.json.id)).toBeNull()

    const owned = await call('POST', '/api/objectives', { body: { title: 'owned card', description: '', workspace: WS, owner_bot: '  Grok: Research ' } })
    expect(owned.status).toBe(201)
    expect(owned.json.owner_bot).toBe('Grok: Research')
    expect(ownerOf(owned.json.id)).toBe('Grok: Research')
  })

  it('read: GET /:id and the board list both carry owner_bot', async () => {
    const owned = await call('POST', '/api/objectives', { body: { title: 'list me', description: '', workspace: WS, owner_bot: 'grok-inbox' } })
    const one = await call('GET', `/api/objectives/${owned.json.id}`)
    expect(one.json.owner_bot).toBe('grok-inbox')
    const list = await call('GET', `/api/objectives?workspace=${WS}`)
    expect(list.status).toBe(200)
    const rows: Loose[] = Array.isArray(list.json) ? list.json : (list.json.objectives ?? list.json.items ?? [])
    expect(rows.find(r => r.id === owned.json.id)?.owner_bot).toBe('grok-inbox')
  })

  it('update: set, change, leave unchanged when omitted, clear with null or ""', async () => {
    const c = await call('POST', '/api/objectives', { body: { title: 'update me', description: '', workspace: WS } })
    const id = c.json.id
    expect((await call('PUT', `/api/objectives/${id}`, { body: { owner_bot: 'grok-ops' } })).json.owner_bot).toBe('grok-ops')
    expect((await call('PUT', `/api/objectives/${id}`, { body: { title: 'renamed' } })).json.owner_bot).toBe('grok-ops')
    expect((await call('PUT', `/api/objectives/${id}`, { body: { owner_bot: ' Grok: Sales ' } })).json.owner_bot).toBe('Grok: Sales')
    expect((await call('PUT', `/api/objectives/${id}`, { body: { owner_bot: null } })).json.owner_bot).toBeNull()
    await call('PUT', `/api/objectives/${id}`, { body: { owner_bot: 'grok-ops' } })
    expect((await call('PUT', `/api/objectives/${id}`, { body: { owner_bot: '' } })).json.owner_bot).toBeNull()
  })

  it('invalid values are rejected with 400 and nothing is written', async () => {
    const before = (getDb().prepare('SELECT COUNT(*) AS n FROM objectives').get() as { n: number }).n
    for (const owner_bot of ['x'.repeat(OWNER_BOT_MAX_LENGTH + 1), '<img src=x>', 'a\nb', 42, { name: 'x' }]) {
      const r = await call('POST', '/api/objectives', { body: { title: 'bad owner', description: '', workspace: WS, owner_bot } })
      expect(r.status, JSON.stringify(owner_bot)).toBe(400)
      expect(r.json.error).toMatch(/owner_bot/)
    }
    expect((getDb().prepare('SELECT COUNT(*) AS n FROM objectives').get() as { n: number }).n).toBe(before)

    const c = await call('POST', '/api/objectives', { body: { title: 'keep owner', description: '', workspace: WS, owner_bot: 'grok-keep' } })
    const bad = await call('PUT', `/api/objectives/${c.json.id}`, { body: { owner_bot: 'no/slashes', title: 'should not apply' } })
    expect(bad.status).toBe(400)
    const row = getDb().prepare('SELECT title, owner_bot FROM objectives WHERE id = ?').get(c.json.id)
    expect(row).toEqual({ title: 'keep owner', owner_bot: 'grok-keep' })
  })

  it('never inferred from the calling credential: a key that files without owner_bot leaves it null', async () => {
    const shared = mint('OpKit')
    const r = await call('POST', '/api/objectives', { bearer: shared.token, body: { title: 'filed by the shared key', description: '', workspace: WS } })
    expect(r.status).toBe(201)
    expect(r.json.agent_key_label).toBe('OpKit')
    expect(r.json.owner_bot).toBeNull()
    const named = await call('POST', '/api/objectives', { bearer: shared.token, body: { title: 'filed for a bot', description: '', workspace: WS, owner_bot: 'Grok: Research' } })
    expect(named.json).toMatchObject({ agent_key_label: 'OpKit', owner_bot: 'Grok: Research' })
  })
})

describe('owner_bot over MCP', () => {
  it('create_objective and update_objective advertise owner_bot', () => {
    for (const name of ['create_objective', 'update_objective']) {
      const t = MCP_TOOLS.find(x => x.name === name)!
      expect((t.inputSchema as Loose).properties.owner_bot).toMatchObject({ maxLength: OWNER_BOT_MAX_LENGTH })
    }
  })

  it('create → get → update → clear, through the shared key', async () => {
    const shared = mint('OpKit-mcp')
    const created = await callTool('create_objective', { title: 'MCP owned card', workspace: WS, type: 'task', owner_bot: 'Grok: Research', idempotency_key: 'owner-bot-1' }, shared.token)
    expect(created.result.isError).toBeFalsy()
    expect(created.data.owner_bot).toBe('Grok: Research')
    const id = created.data.id
    expect(ownerOf(id)).toBe('Grok: Research')

    const got = await callTool('get_objective', { id }, shared.token)
    expect(got.data.owner_bot).toBe('Grok: Research')
    const listed = await callTool('list_objectives', { workspace: WS }, shared.token)
    const rows: Loose[] = listed.data.objectives ?? listed.data.results ?? listed.data.cards ?? listed.data
    expect(JSON.stringify(rows)).toContain('Grok: Research')

    const upd = await callTool('update_objective', { id, owner_bot: 'grok-inbox' }, shared.token)
    expect(upd.result.isError).toBeFalsy()
    expect(upd.data.owner_bot).toBe('grok-inbox')
    expect(ownerOf(id)).toBe('grok-inbox')

    await callTool('update_objective', { id, owner_bot: null }, shared.token)
    expect(ownerOf(id)).toBeNull()
  })

  it('absent on MCP create → null; invalid → tool error (400) and no card', async () => {
    const shared = mint('OpKit-mcp-2')
    const plain = await callTool('create_objective', { title: 'MCP unowned', workspace: WS, type: 'task', idempotency_key: 'owner-bot-2' }, shared.token)
    expect(ownerOf(plain.data.id)).toBeNull()

    const before = (getDb().prepare('SELECT COUNT(*) AS n FROM objectives').get() as { n: number }).n
    const bad = await callTool('create_objective', { title: 'MCP bad owner', workspace: WS, type: 'task', owner_bot: '<b>bot</b>', idempotency_key: 'owner-bot-3' }, shared.token)
    expect(bad.result.isError).toBe(true)
    expect(bad.result.content[0].text).toMatch(/400.*owner_bot/s)
    expect((getDb().prepare('SELECT COUNT(*) AS n FROM objectives').get() as { n: number }).n).toBe(before)
  })
})
