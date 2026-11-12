// The bot page's settings over HTTP (obj 900671): who may change a bot's
// default model and tools, and what the bot list reports back.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'
import cookieParser from 'cookie-parser'
import jwt from 'jsonwebtoken'

process.env.JWT_SECRET = 'test-secret-bot-config-xxxx'
const TMP_DB = path.join(os.tmpdir(), `cc-bot-config-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB
const TMP_AGENTS = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-bot-config-agents-'))
process.env.AGENT_FILES_DIR = TMP_AGENTS
process.env.AGENT_CHAT_BUILTINS = '0'
process.env.AGENT_CHAT_PROVIDER = 'demo'

const { initDb, getDb } = await import('../db/index.js')
const { default: router } = await import('./agent-chat.js')
const { createAgentKey } = await import('../lib/agent-keys.js')

const ADMIN = 1
const MEMBER = 2

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any

let server: http.Server
let baseUrl: string
let agentKey = ''

function tokenFor(id: number, role: string) {
  return jwt.sign({ id, username: `user${id}`, role }, process.env.JWT_SECRET as string, { expiresIn: '1h' })
}

async function call(method: string, p: string, opts: { as?: number; role?: string; body?: unknown; key?: string } = {}) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (opts.key) headers.Authorization = `Bearer ${opts.key}`
  else if (opts.as) headers.Cookie = `token=${tokenFor(opts.as, opts.role ?? 'member')}`
  const res = await fetch(`${baseUrl}/api/agent-chat${p}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) })
  const text = await res.text()
  let json: Loose = null
  try { json = text ? JSON.parse(text) : null } catch { /* not json */ }
  return { status: res.status, json }
}

beforeAll(async () => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
  const db = getDb()
  db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (1, 'user1', 'x', 'admin')`).run()
  db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (2, 'user2', 'x', 'member')`).run()
  fs.mkdirSync(path.join(TMP_AGENTS, 'cto'))
  fs.writeFileSync(path.join(TMP_AGENTS, 'cto', 'agent.yaml'), 'name: CTO\nsystem_prompt: Engineering support.\ntools: [list_objectives, create_objective]\n')
  const k = createAgentKey({ id: ADMIN, role: 'admin' }, { label: 'grok-bot' })
  if (!k.ok) throw new Error(k.error)
  agentKey = k.key.token

  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  app.use('/api/agent-chat', router)
  await new Promise<void>(resolve => { server = app.listen(0, () => resolve()) })
  const addr = server.address()
  baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
})

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
  for (const p of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) fs.rmSync(p, { force: true })
  fs.rmSync(TMP_AGENTS, { recursive: true, force: true })
})

describe('GET /agents carries what the bot page needs', () => {
  it('lists the tool catalog (web tools included), model suggestions, web status and each bot\'s effective tools', async () => {
    const r = await call('GET', '/agents', { as: MEMBER })
    expect(r.status).toBe(200)
    const catalog = r.json.tool_catalog.map((t: Loose) => t.name)
    expect(catalog.slice(0, 2)).toEqual(['web_search', 'web_fetch'])
    expect(catalog).toContain('mcp')
    expect(r.json.web).toHaveProperty('available')
    expect(r.json.model_suggestions.claude).toContain('claude-sonnet-5')
    const cto = r.json.agents.find((a: Loose) => a.slug === 'cto')
    expect(cto.all_tools).toBe(false)
    expect(cto.effective_tools).toEqual(['list_objectives', 'create_objective', 'board_briefing'])
    expect(cto.config).toBeNull()
    expect(cto.file_defaults).toEqual({ provider: null, model: null, tools: ['list_objectives', 'create_objective'] })
  })
})

describe('PUT /agents/:slug/config', () => {
  it('an admin sets the default model, tools and all-tools, and the bot list reflects it', async () => {
    const put = await call('PUT', '/agents/cto/config', { as: ADMIN, role: 'admin', body: { provider: 'claude', model: 'claude-opus-5-5', tools: ['web_search', 'web_fetch', 'list_objectives'] } })
    expect(put.status).toBe(200)
    expect(put.json.agent.model).toBe('claude-opus-5-5')
    expect(put.json.agent.answered_by).toEqual({ id: 'claude', model: 'claude-opus-5-5' })
    expect(put.json.agent.effective_tools).toEqual(['web_search', 'web_fetch', 'list_objectives', 'board_briefing'])
    expect(put.json.agent.config).toMatchObject({ provider: 'claude', model: 'claude-opus-5-5', all_tools: false, updated_by: 'user1' })

    const all = await call('PUT', '/agents/cto/config', { as: ADMIN, role: 'admin', body: { all_tools: true } })
    expect(all.status).toBe(200)
    expect(all.json.agent.all_tools).toBe(true)
    expect(all.json.agent.effective_tools).toEqual(expect.arrayContaining(['web_search', 'web_fetch', 'write_doc', 'email', 'calendar', 'mcp']))
    // The model override survived the partial update.
    expect(all.json.agent.model).toBe('claude-opus-5-5')

    const list = await call('GET', '/agents', { as: MEMBER })
    expect(list.json.agents.find((a: Loose) => a.slug === 'cto').all_tools).toBe(true)
  })

  it('400s on an unknown tool or provider and changes nothing', async () => {
    const before = (await call('GET', '/agents/cto', { as: ADMIN, role: 'admin' })).json.agent
    const bad = await call('PUT', '/agents/cto/config', { as: ADMIN, role: 'admin', body: { tools: ['shell'] } })
    expect(bad.status).toBe(400)
    expect(bad.json.error).toMatch(/not a chat tool/)
    expect((await call('PUT', '/agents/cto/config', { as: ADMIN, role: 'admin', body: { provider: 'nope' } })).status).toBe(400)
    const after = (await call('GET', '/agents/cto', { as: ADMIN, role: 'admin' })).json.agent
    expect(after.effective_tools).toEqual(before.effective_tools)
  })

  it('a member cannot change a bot', async () => {
    const r = await call('PUT', '/agents/cto/config', { as: MEMBER, body: { all_tools: true } })
    expect(r.status).toBe(403)
  })

  it('an API key cannot change a bot, even an admin\'s (a bot must not grant itself tools)', async () => {
    const r = await call('PUT', '/agents/cto/config', { key: agentKey, body: { all_tools: true } })
    expect(r.status).toBe(403)
    expect((await call('DELETE', '/agents/cto/config', { key: agentKey })).status).toBe(403)
  })

  it('404s for a bot that does not exist', async () => {
    expect((await call('PUT', '/agents/ghost/config', { as: ADMIN, role: 'admin', body: { model: 'x' } })).status).toBe(404)
  })

  it('DELETE resets the bot to its file', async () => {
    const r = await call('DELETE', '/agents/cto/config', { as: ADMIN, role: 'admin' })
    expect(r.status).toBe(200)
    expect(r.json.agent.config).toBeNull()
    expect(r.json.agent.model).toBeNull()
    expect(r.json.agent.all_tools).toBe(false)
    expect(r.json.agent.effective_tools).toEqual(['list_objectives', 'create_objective', 'board_briefing'])
  })
})
