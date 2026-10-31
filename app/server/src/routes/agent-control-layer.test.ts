/**
 * Grok control-layer seam (obj 714100): the glue between scoped agent keys
 * (obj 714090), the changes/attention/idempotency control endpoints (obj 714091)
 * and the remote MCP server (obj 714092).
 *
 * Boots the real routers behind the real agentKeyGuard in index.ts order, on a
 * throwaway DB. MCP tool calls go MCP → loopback → REST → guard, exactly as in
 * production.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'
import cookieParser from 'cookie-parser'
import jwt from 'jsonwebtoken'

const TMP_DB = path.join(os.tmpdir(), `cc-control-layer-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB
process.env.JWT_SECRET = 'test-secret-control-layer-xxxx'

const { initDb, getDb } = await import('../db/index.js')
const { default: authRouter } = await import('./auth.js')
const { default: objectivesRouter } = await import('./objectives.js')
const { default: agentControlRouter } = await import('./agent-control.js')
const { default: workspacesRouter } = await import('./workspaces.js')
const { default: agentMcpRouter } = await import('./agent-mcp.js')
const { agentKeyGuard } = await import('../middleware/agent-key-guard.js')
const { createAgentKey } = await import('../lib/agent-keys.js')
const { issueApiKey } = await import('../lib/api-keys.js')
const { AGENT_DEFAULT_LIST_LIMIT } = await import('./objectives-crud.js')

const ADMIN_ID = 1
const WS = 'example'
const OTHER_WS = 'example2'

let server: http.Server
let baseUrl: string
const cookie = () =>
  `token=${jwt.sign({ id: ADMIN_ID, username: 'mike', role: 'admin' }, process.env.JWT_SECRET as string, { expiresIn: '1h' })}`

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any

async function call(
  method: string,
  p: string,
  opts: { bearer?: string; body?: unknown; headers?: Record<string, string> } = {},
) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...opts.headers }
  if (opts.bearer) headers.Authorization = `Bearer ${opts.bearer}`
  else headers.Cookie = cookie()
  const res = await fetch(`${baseUrl}${p}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  })
  const text = await res.text()
  let json: unknown = null
  try { json = JSON.parse(text) } catch { json = text }
  return { status: res.status, json: json as Loose, headers: res.headers }
}

let rpcId = 1
async function mcpTool(bearer: string, name: string, args: Record<string, unknown> = {}) {
  const r = await call('POST', '/api/mcp', {
    bearer,
    headers: { Accept: 'application/json, text/event-stream' },
    body: { jsonrpc: '2.0', id: rpcId++, method: 'tools/call', params: { name, arguments: args } },
  })
  expect(r.status).toBe(200)
  const result = r.json.result as {
    content: { type: string; text: string }[]
    isError?: boolean
    structuredContent?: Loose
  }
  return { result, data: result.isError ? null : JSON.parse(result.content[0].text) }
}

function mint(label: string, scopes?: string[], workspaces?: string[] | null): { token: string; id: number } {
  const r = createAgentKey({ id: ADMIN_ID, role: 'admin' }, { label, scopes, workspaces })
  if (!r.ok) throw new Error(r.error)
  return { token: r.key.token, id: r.key.id }
}

function seed(workspace: string, status = 'review', title = 'seeded'): number {
  const r = getDb()
    .prepare(`INSERT INTO objectives (title, agent_context, workspace, created_by, status) VALUES (?, 'cto', ?, ?, ?)`)
    .run(title, workspace, ADMIN_ID, status)
  return Number(r.lastInsertRowid)
}

beforeAll(async () => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
  getDb().prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (?, 'mike', 'x', 'admin')`).run(ADMIN_ID)
  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  app.use(agentKeyGuard)
  app.use('/api/auth', authRouter)
  app.use('/api/agent', agentControlRouter)
  app.use('/api', agentMcpRouter)
  app.use('/api/objectives', objectivesRouter)
  app.use('/api/workspaces', workspacesRouter)
  await new Promise<void>(r => { server = app.listen(0, '127.0.0.1', () => r()) })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no address')
  baseUrl = `http://127.0.0.1:${addr.port}`
})

afterAll(async () => {
  await new Promise<void>(r => server.close(() => r()))
  try { getDb().close() } catch { /* already closed */ }
  for (const s of ['', '-wal', '-shm']) {
    const f = `${TMP_DB}${s}`
    if (fs.existsSync(f)) fs.unlinkSync(f)
  }
})

describe('agent-key guard covers /api/agent/changes + /api/agent/attention', () => {
  it('a key without board:read gets 403 missing_scope on both', async () => {
    const writer = mint('writer-only', ['board:write'])
    for (const p of ['/api/agent/changes', '/api/agent/attention']) {
      const r = await call('GET', p, { bearer: writer.token })
      expect(r.status, p).toBe(403)
      expect(r.json.missing_scope, p).toBe('board:read')
    }
  })

  it('a workspace-restricted key sees no other-workspace events or attention items', async () => {
    const mine = seed(WS, 'review', 'mine in review')
    const theirs = seed(OTHER_WS, 'review', 'theirs in review')
    // Status moves fire more events on both cards.
    getDb().prepare(`UPDATE objectives SET status = 'working' WHERE id IN (?, ?)`).run(mine, theirs)
    getDb().prepare(`UPDATE objectives SET status = 'review' WHERE id IN (?, ?)`).run(mine, theirs)

    // Sanity: an unrestricted key DOES see the other workspace, so the filter
    // below is doing the work.
    const open = mint('open-reader', ['board:read'])
    const all = await call('GET', '/api/agent/changes?since=0', { bearer: open.token })
    expect(all.status).toBe(200)
    expect(all.json.events.some((e: Loose) => e.workspace === OTHER_WS)).toBe(true)

    const pinned = mint('example-only', ['board:read'], [WS])
    const changes = await call('GET', '/api/agent/changes?since=0', { bearer: pinned.token })
    expect(changes.status).toBe(200)
    expect(changes.json.events.length).toBeGreaterThan(0)
    expect(changes.json.events.every((e: Loose) => e.workspace === WS)).toBe(true)
    expect(changes.json.events.some((e: Loose) => e.objective_id === theirs)).toBe(false)
    expect(changes.json.events.some((e: Loose) => e.objective_id === mine)).toBe(true)

    const attention = await call('GET', '/api/agent/attention', { bearer: pinned.token })
    expect(attention.status).toBe(200)
    const ids = attention.json.items.map((i: Loose) => i.id)
    expect(ids).toContain(mine)
    expect(ids).not.toContain(theirs)
    // counts are computed after the filter, not before.
    const total = Object.values(attention.json.counts as Record<string, number>).reduce((a, b) => a + b, 0)
    expect(total).toBe(attention.json.items.length)

    // Asking for the other workspace explicitly is refused outright.
    const asked = await call('GET', `/api/agent/changes?workspace=${OTHER_WS}`, { bearer: pinned.token })
    expect(asked.status).toBe(403)
    expect(asked.json.workspace).toBe(OTHER_WS)
  })

  it('a hard-deleted card in another workspace never reaches a pinned key', async () => {
    const gone = seed(OTHER_WS, 'queue', 'about to vanish')
    getDb().prepare('DELETE FROM objectives WHERE id = ?').run(gone)
    const pinned = mint('example-only-2', ['board:read'], [WS])
    const r = await call('GET', '/api/agent/changes?since=0&limit=500', { bearer: pinned.token })
    expect(r.status).toBe(200)
    expect(r.json.events.some((e: Loose) => e.objective_id === gone)).toBe(false)
  })
})

describe('MCP tool calls get the same scope + workspace checks as REST', () => {
  it('update_status to done with a key lacking board:done fails with missing_scope (set_status → done)', async () => {
    const id = seed(WS, 'review', 'awaiting Mike')
    const bot = mint('grok-default') // default scopes: everything except board:done + board:delete
    const { result } = await mcpTool(bot.token, 'update_status', { id, status: 'done' })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toMatch(/^Error 403/)
    expect(result.content[0].text).toContain('missing_scope: board:done')
    expect(result.structuredContent.missing_scope).toBe('board:done')
    const row = getDb().prepare('SELECT status FROM objectives WHERE id = ?').get(id) as { status: string }
    expect(row.status).toBe('review')

    // The REST equivalent answers the same thing.
    const rest = await call('PATCH', `/api/objectives/${id}/status`, { bearer: bot.token, body: { status: 'done' } })
    expect(rest.status).toBe(403)
    expect(rest.json.missing_scope).toBe('board:done')
  })

  it('get_changes / get_attention need board:read through MCP too', async () => {
    const writer = mint('mcp-writer-only', ['board:write'])
    for (const tool of ['get_changes', 'get_attention']) {
      const { result } = await mcpTool(writer.token, tool)
      expect(result.isError, tool).toBe(true)
      expect(result.structuredContent.missing_scope, tool).toBe('board:read')
    }
    const reader = mint('mcp-reader', ['board:read'], [WS])
    const changes = await mcpTool(reader.token, 'get_changes', { since: '0' })
    expect(changes.result.isError).toBeFalsy()
    expect(typeof changes.data.next_cursor).toBe('string')
    expect(changes.data.events.every((e: Loose) => e.workspace === WS)).toBe(true)
    const attention = await mcpTool(reader.token, 'get_attention')
    expect(attention.result.isError).toBeFalsy()
    expect(Array.isArray(attention.data.items)).toBe(true)
  })

  it('a workspace-pinned key cannot read another workspace card through MCP', async () => {
    const theirs = seed(OTHER_WS, 'queue', 'other org card')
    const pinned = mint('mcp-example-only', undefined, [WS])
    const { result } = await mcpTool(pinned.token, 'get_objective', { id: theirs })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toMatch(/^Error 403/)
  })

  it('create_objective via MCP carries agent_api attribution and honours idempotency_key', async () => {
    const bot = mint('grok-pm')
    const args = { title: 'MCP-created card', workspace: WS, type: 'task', idempotency_key: 'mcp-create-1' }
    const first = await mcpTool(bot.token, 'create_objective', args)
    expect(first.result.isError).toBeFalsy()
    expect(first.data.origin).toBe('agent_api')
    expect(first.data.agent_key_label).toBe('grok-pm')
    const row = getDb().prepare('SELECT origin, agent_key_id, agent_key_label FROM objectives WHERE id = ?')
      .get(first.data.id) as { origin: string; agent_key_id: number; agent_key_label: string }
    expect(row).toEqual({ origin: 'agent_api', agent_key_id: bot.id, agent_key_label: 'grok-pm' })

    const retry = await mcpTool(bot.token, 'create_objective', args)
    expect(retry.data.id).toBe(first.data.id)
  })

  it('create with start:true needs board:start (REST and MCP)', async () => {
    const noStart = mint('no-start', ['board:read', 'board:write'])
    const rest = await call('POST', '/api/objectives', {
      bearer: noStart.token,
      body: { title: 'start me', workspace: WS, type: 'task', start: true },
    })
    expect(rest.status).toBe(403)
    expect(rest.json.missing_scope).toBe('board:start')
    const { result } = await mcpTool(noStart.token, 'create_objective', { title: 'start me', workspace: WS, type: 'task', start: true })
    expect(result.isError).toBe(true)
    expect(result.structuredContent.missing_scope).toBe('board:start')
  })
})

describe('Idempotency-Key is namespaced per agent key', () => {
  it('two keys of the same user + same key → two cards; a repeat from one key → its original', async () => {
    const botA = mint('grok-a')
    const botB = mint('grok-b')
    const body = { title: 'same request from two bots', workspace: WS, type: 'task' }
    const headers = { 'Idempotency-Key': 'shared-across-bots-1' }

    const a1 = await call('POST', '/api/objectives', { bearer: botA.token, body, headers })
    const b1 = await call('POST', '/api/objectives', { bearer: botB.token, body, headers })
    expect(a1.status).toBe(201)
    expect(b1.status).toBe(201)
    expect(b1.json.id).not.toBe(a1.json.id)
    expect(a1.json.agent_key_label).toBe('grok-a')
    expect(b1.json.agent_key_label).toBe('grok-b')

    const a2 = await call('POST', '/api/objectives', { bearer: botA.token, body, headers })
    expect(a2.status).toBe(201)
    expect(a2.json.id).toBe(a1.json.id)
    expect(a2.headers.get('idempotent-replayed')).toBe('true')

    const n = getDb().prepare('SELECT COUNT(*) AS n FROM objectives WHERE title = ?').get(body.title) as { n: number }
    expect(n.n).toBe(2)
  })

  it('the legacy key and the browser session have their own namespaces too', async () => {
    const legacy = issueApiKey(ADMIN_ID).token
    const body = { title: 'legacy vs session', workspace: WS, type: 'task' }
    const headers = { 'Idempotency-Key': 'legacy-vs-session' }
    const viaLegacy = await call('POST', '/api/objectives', { bearer: legacy, body, headers })
    const viaSession = await call('POST', '/api/objectives', { body, headers })
    expect(viaLegacy.status).toBe(201)
    expect(viaSession.status).toBe(201)
    expect(viaSession.json.id).not.toBe(viaLegacy.json.id)
  })
})

describe('GET /api/objectives default page for agent callers', () => {
  it('agent key and legacy key get the default page; session callers get the whole board', async () => {
    for (let i = 0; i < AGENT_DEFAULT_LIST_LIMIT + 15; i++) seed(WS, 'queue', `bulk ${i}`)
    const active = (getDb().prepare(
      `SELECT COUNT(*) AS n FROM objectives WHERE status NOT IN ('done','cancelled') AND deleted_at IS NULL`,
    ).get() as { n: number }).n
    expect(active).toBeGreaterThan(AGENT_DEFAULT_LIST_LIMIT)

    const bot = mint('grok-lister', ['board:read'])
    const agent = await call('GET', '/api/objectives', { bearer: bot.token })
    expect(agent.status).toBe(200)
    expect(agent.json.length).toBe(AGENT_DEFAULT_LIST_LIMIT)
    expect(agent.headers.get('x-default-limit')).toBe(String(AGENT_DEFAULT_LIST_LIMIT))

    const legacy = await call('GET', '/api/objectives', { bearer: issueApiKey(ADMIN_ID).token })
    expect(legacy.status).toBe(200)
    expect(legacy.json.length).toBe(AGENT_DEFAULT_LIST_LIMIT)

    const session = await call('GET', '/api/objectives')
    expect(session.status).toBe(200)
    expect(session.json.length).toBe(active)
    expect(session.headers.get('x-default-limit')).toBeNull()

    // An explicit limit still wins for an agent (capped at 200 as before).
    const explicit = await call('GET', `/api/objectives?limit=${AGENT_DEFAULT_LIST_LIMIT + 10}`, { bearer: bot.token })
    expect(explicit.json.length).toBe(AGENT_DEFAULT_LIST_LIMIT + 10)
    expect(explicit.headers.get('x-default-limit')).toBeNull()
  })
})
