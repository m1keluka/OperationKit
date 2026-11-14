// Claude Fable 5.2 for bots and agents (obj 900796). Proves over HTTP, on a
// fresh DB that ran the real initDb seed:
//   - the bot page's Claude model suggestions offer `claude-fable-5-2`
//     (they come from the ENABLED model registry — the gap was that Fable 5.2
//     had no registry row, so nothing could pick it);
//   - an admin can set a bot to it, and that bot's High Agency wake routine and
//     the wake card it files carry `model: claude-fable-5-2` (before, every
//     wake ran on the board default whatever the bot was set to);
//   - "any allowed model": a model that is not an enabled registry row (a chat-
//     only id, or one an admin switched off) leaves the wake on the board default.
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'
import cookieParser from 'cookie-parser'
import jwt from 'jsonwebtoken'

process.env.JWT_SECRET = 'test-secret-fable-5-2-xxxxxxxx'
const TMP_DB = path.join(os.tmpdir(), `cc-fable52-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB
process.env.PORT = '59947' // dead port: the scheduler's spawn PATCH never reaches a live server
const TMP_AGENTS = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-fable52-agents-'))
process.env.AGENT_FILES_DIR = TMP_AGENTS
process.env.AGENT_CHAT_BUILTINS = '0'
process.env.AGENT_CHAT_PROVIDER = 'demo'

const { initDb, getDb } = await import('../db/index.js')
const { default: router } = await import('./agent-chat.js')
const { getDefaultModelId } = await import('../services/model-registry.js')

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any

let server: http.Server
let baseUrl: string
const realFetch = globalThis.fetch

function cookie(id: number, role: string) {
  return `token=${jwt.sign({ id, username: `user${id}`, role }, process.env.JWT_SECRET as string, { expiresIn: '1h' })}`
}

async function admin(method: string, p: string, body?: unknown) {
  const res = await realFetch(`${baseUrl}/api/agent-chat${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', Cookie: cookie(1, 'admin') },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  return { status: res.status, json: (text ? JSON.parse(text) : null) as Loose }
}

function stubSpawn() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input)
    if (url.includes('/api/internal/objectives/') && url.endsWith('/status')) return Promise.resolve(new Response('{}', { status: 200 }))
    return realFetch(input, init)
  }) as typeof fetch)
}

const routine = (slug: string) => getDb().prepare('SELECT * FROM routines WHERE name = ?').get(`high-agency:${slug}`) as Loose
const templateModel = (slug: string) => (JSON.parse(routine(slug).objective_template) as { model?: string }).model

beforeAll(async () => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
  const db = getDb()
  db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (1, 'user1', 'x', 'admin')`).run()
  db.prepare(`INSERT OR IGNORE INTO workspaces (slug, name) VALUES ('ops', 'Ops')`).run()
  db.prepare(`INSERT INTO user_workspaces (user_id, workspace, role) VALUES (1, 'ops', 'admin')`).run()
  fs.mkdirSync(path.join(TMP_AGENTS, 'cto'), { recursive: true })
  fs.writeFileSync(path.join(TMP_AGENTS, 'cto', 'agent.yaml'), 'name: CTO\nsystem_prompt: You own engineering.\n')
  // obj 900797: 'cto' stands for a bot that predates per-bot workspace access lists.
  const { seedExistingBotsOnce } = await import('../services/agent-chat/bot-workspaces.js')
  seedExistingBotsOnce(['cto'])
  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  app.use('/api/agent-chat', router)
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

describe('Claude Fable 5.2 in the bot model picker', () => {
  it('is offered for the Claude providers, and Mythos 5.2 is not', async () => {
    const r = await admin('GET', '/agents')
    expect(r.status).toBe(200)
    expect(r.json.model_suggestions.claude).toContain('claude-fable-5-2')
    expect(r.json.model_suggestions.anthropic).toContain('claude-fable-5-2')
    expect(r.json.model_suggestions.claude).not.toContain('claude-mythos-5-2')
  })

  it('an admin can put a bot on it', async () => {
    const r = await admin('PUT', '/agents/cto/config', { model: 'claude-fable-5-2' })
    expect(r.status).toBe(200)
    expect(r.json.agent.model).toBe('claude-fable-5-2')
  })
})

describe('High Agency wakes run on the bot\'s model', () => {
  it('the wake routine and the card it files carry claude-fable-5-2', async () => {
    const on = await admin('PUT', '/agents/cto/high-agency', { enabled: true, workspace: 'ops' })
    expect(on.status).toBe(200)
    expect(templateModel('cto')).toBe('claude-fable-5-2')

    stubSpawn()
    const wake = await admin('POST', '/agents/cto/high-agency/wake')
    expect(wake.status).toBe(200)
    const card = getDb().prepare('SELECT model, agent_context FROM objectives WHERE routine_id = ? ORDER BY id DESC LIMIT 1').get(routine('cto').id) as Loose
    expect(card).toMatchObject({ model: 'claude-fable-5-2', agent_context: 'cto' })
    expect(getDefaultModelId()).not.toBe('claude-fable-5-2') // it really came from the bot, not the default
  })

  it('changing the bot\'s model re-renders the wake template — no save of the High Agency panel needed', async () => {
    expect((await admin('PUT', '/agents/cto/config', { model: 'claude-opus-5-5' })).status).toBe(200)
    expect(templateModel('cto')).toBe('claude-opus-5-5')
    expect((await admin('PUT', '/agents/cto/config', { model: 'claude-fable-5-2' })).status).toBe(200)
    expect(templateModel('cto')).toBe('claude-fable-5-2')
    expect(routine('cto').enabled).toBe(1) // a model change never flips the schedule
  })

  it('a model a card session cannot run leaves the wake on the board default', async () => {
    // chat-only id: not a registry row
    expect((await admin('PUT', '/agents/cto/config', { model: 'gpt-5' })).status).toBe(200)
    expect(templateModel('cto')).toBeUndefined()
    // switched off in Settings → Models
    getDb().prepare("UPDATE models SET enabled = 0 WHERE id = 'claude-fable-5-2'").run()
    expect((await admin('PUT', '/agents/cto/config', { model: 'claude-fable-5-2' })).status).toBe(200)
    expect(templateModel('cto')).toBeUndefined()
    getDb().prepare("UPDATE models SET enabled = 1 WHERE id = 'claude-fable-5-2'").run()
    // Reset to file (no model) → board default
    expect((await admin('DELETE', '/agents/cto/config')).status).toBe(200)
    expect(templateModel('cto')).toBeUndefined()
  })
})
