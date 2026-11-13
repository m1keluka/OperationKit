// A bot's About (obj 900747): the "i" panel's read-only instructions, and an
// About (description summary, how-to, example prompts) generated from the bot
// and refreshed whenever it is created or changed.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'
import cookieParser from 'cookie-parser'
import jwt from 'jsonwebtoken'

process.env.JWT_SECRET = 'test-secret-bot-about-xxxx'
const TMP_DB = path.join(os.tmpdir(), `cc-bot-about-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB
const TMP_AGENTS = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-bot-about-agents-'))
process.env.AGENT_FILES_DIR = TMP_AGENTS
process.env.AGENT_CHAT_BUILTINS = '0'
process.env.AGENT_CHAT_PROVIDER = 'demo'

const { initDb, getDb } = await import('../db/index.js')
const { default: chatRouter } = await import('./agent-chat.js')
const { agentTemplatesRouter } = await import('./agent-templates.js')
const about = await import('../services/agent-chat/bot-about.js')
const { findAgent } = await import('../services/agent-chat/engine.js')
type Agent = import('../services/agent-chat/agent-defs.js').ChatAgent

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any

const ADMIN = 1
const MEMBER = 2

let server: http.Server
let baseUrl: string
/** Every bot the fake model was asked about, in order. */
let asked: Array<{ slug: string; tools: string[]; prompt: string }> = []
let failNext = false

function tokenFor(id: number, role: string) {
  return jwt.sign({ id, username: `user${id}`, role }, process.env.JWT_SECRET as string, { expiresIn: '1h' })
}

async function call(method: string, p: string, opts: { as?: number; role?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (opts.as) headers.Cookie = `token=${tokenFor(opts.as, opts.role ?? 'member')}`
  const res = await fetch(`${baseUrl}${p}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) })
  const text = await res.text()
  let json: Loose = null
  try { json = text ? JSON.parse(text) : null } catch { /* not json */ }
  return { status: res.status, json }
}

function writeAgent(slug: string, yaml: string) {
  fs.mkdirSync(path.join(TMP_AGENTS, slug), { recursive: true })
  fs.writeFileSync(path.join(TMP_AGENTS, slug, 'agent.yaml'), yaml)
}

const RESEARCHER = [
  'name: Researcher',
  'slug: researcher',
  'description: ""',
  'tools: [search, read_file, web_search]',
  'knowledge_folders: [market]',
  'system_prompt: |',
  '  You are a research assistant for the sales team. You find facts about prospects before calls.',
  '',
  '  ## Rules',
  '  - Cite the note you used.',
].join('\n') + '\n'

beforeAll(async () => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
  const db = getDb()
  db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (1, 'user1', 'x', 'admin')`).run()
  db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (2, 'user2', 'x', 'member')`).run()
  writeAgent('researcher', RESEARCHER)
  // A bot whose file already says everything: no generation needed.
  writeAgent('curated', [
    'name: Curated',
    'description: Hand-written description.',
    'how_to_use: Hand-written how-to.',
    'example_prompts: [Hand-written prompt]',
    'system_prompt: You are curated.',
  ].join('\n') + '\n')

  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  app.use('/api/agent-chat', chatRouter)
  app.use('/api/agent-templates', agentTemplatesRouter)
  await new Promise<void>(resolve => { server = app.listen(0, () => resolve()) })
  const addr = server.address()
  baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
})

beforeEach(() => {
  asked = []
  failNext = false
  about.__resetAboutQueueForTests()
  about.setAboutGeneratorForTests(async (a: Agent) => {
    asked.push({ slug: a.slug, tools: [...a.tools], prompt: a.system_prompt })
    if (failNext) {
      failNext = false
      throw new Error('model unavailable')
    }
    return {
      summary: `${a.name} finds facts about prospects.`,
      how_to_use: `Ask ${a.name} about a prospect.\n\n- Name the company\n- Say when the call is`,
      example_prompts: [`What should I know about Acme before my call? (${a.tools.join('+')})`],
      model: 'fake-model',
    }
  })
})

afterAll(async () => {
  about.setAboutGeneratorForTests(null)
  await new Promise<void>(resolve => server.close(() => resolve()))
  for (const p of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) fs.rmSync(p, { force: true })
  fs.rmSync(TMP_AGENTS, { recursive: true, force: true })
})

describe('rules About (no model): filled in immediately, from the bot itself', () => {
  it('summarises the instructions as a description, not an order', () => {
    expect(about.summaryFromInstructions('You are a research assistant for the sales team. You find facts.')).toBe('A research assistant for the sales team.')
    expect(about.summaryFromInstructions('# Title\n\nHelps the finance team close the month. Uses the ledger.')).toBe('Helps the finance team close the month. Uses the ledger.')
    expect(about.summaryFromInstructions('')).toBe('')
    expect(about.summaryFromInstructions('x '.repeat(400)).length).toBeLessThanOrEqual(240)
  })

  it('writes how-to and prompts that match the tools and folders the bot really has', () => {
    const a = findAgent('researcher')!
    const r = about.rulesAbout(a)
    expect(r.how_to_use).toContain('your notes in market')
    expect(r.how_to_use).toContain('look something up on the web')
    expect(r.how_to_use).not.toMatch(/email|calendar/i)
    expect(r.example_prompts).toContain('What do my notes in market say about this week?')
    const bare = about.rulesAbout({ ...a, tools: [], knowledge_folders: [] })
    expect(bare.how_to_use).toContain('It has no tools')
    expect(bare.example_prompts.length).toBeGreaterThanOrEqual(2)
  })

  it('the input hash moves with instructions, tools and folders, and with nothing else', () => {
    const a = findAgent('researcher')!
    const h = about.aboutInputHash(a)
    expect(about.aboutInputHash({ ...a })).toBe(h)
    expect(about.aboutInputHash({ ...a, system_prompt: `${a.system_prompt} More.` })).not.toBe(h)
    expect(about.aboutInputHash({ ...a, tools: [...a.tools, 'email'] })).not.toBe(h)
    expect(about.aboutInputHash({ ...a, knowledge_folders: ['other'] })).not.toBe(h)
    expect(about.aboutInputHash({ ...a, how_to_use: 'changed' })).toBe(h)
  })

  it('parses a model reply defensively: JSON only, capped, secrets masked', () => {
    expect(about.parseGeneratedAbout('not json')).toBeNull()
    expect(about.parseGeneratedAbout('{"summary": 3}')).toBeNull()
    const leaked = 'sk-ant-api03-' + 'A'.repeat(90)
    const r = about.parseGeneratedAbout(`Sure!\n{"summary":"Helps.\\nTwo lines","how_to_use":"Use ${leaked}","example_prompts":["a","a","${'x'.repeat(400)}",7]}`)!
    expect(r.summary).toBe('Helps. Two lines')
    expect(r.how_to_use).not.toContain(leaked)
    expect(r.example_prompts[0]).toBe('a')
    expect(r.example_prompts.length).toBe(2)
    expect(r.example_prompts[1].length).toBeLessThanOrEqual(300)
  })
})

describe('the About on the wire', () => {
  it('a bot whose file has no About text is filled in on the very first read, then refreshed by the model', async () => {
    const first = await call('GET', '/api/agent-chat/agents', { as: MEMBER })
    const r = first.json.agents.find((a: Loose) => a.slug === 'researcher')
    expect(r.about.description).toBe('A research assistant for the sales team.')
    expect(r.about.how_to_use).toContain('your notes in market')
    expect(r.about.example_prompts.length).toBeGreaterThan(0)
    expect(r.about.sources).toEqual({ description: 'generated', how_to_use: 'generated', example_prompts: 'generated' })
    expect(r.about.generated_by).toBe('rules')
    expect(r.about.pending).toBe(true)

    await about.aboutQueueIdle()
    expect(asked.map(x => x.slug)).toEqual(['researcher'])
    asked = []
    const second = await call('GET', '/api/agent-chat/agents', { as: MEMBER })
    const r2 = second.json.agents.find((a: Loose) => a.slug === 'researcher')
    expect(r2.about.generated_by).toBe('model')
    expect(r2.about.pending).toBe(false)
    expect(r2.about.description).toBe('Researcher finds facts about prospects.')
    expect(r2.about.how_to_use).toContain('Name the company')
    expect(r2.about.example_prompts[0]).toContain('search+read_file+web_search')
    expect(r2.about.generated_at).toBeTruthy()
    // Nothing is re-generated while the bot is unchanged.
    await about.aboutQueueIdle()
    expect(asked).toEqual([])
  })

  it('text the file sets wins per field, and a fully written file costs no model call', async () => {
    const r = await call('GET', '/api/agent-chat/agents', { as: MEMBER })
    const c = r.json.agents.find((a: Loose) => a.slug === 'curated')
    expect(c.about).toMatchObject({
      description: 'Hand-written description.',
      how_to_use: 'Hand-written how-to.',
      example_prompts: ['Hand-written prompt'],
      sources: { description: 'file', how_to_use: 'file', example_prompts: 'file' },
      generated_by: null,
      pending: false,
    })
    await about.aboutQueueIdle()
    expect(asked.some(x => x.slug === 'curated')).toBe(false)
  })

  it('GET /agents/:slug carries the instructions for the read-only panel, with secret shapes masked', async () => {
    const leaked = 'ghp_' + 'B'.repeat(36)
    writeAgent('leaky', `name: Leaky\nsystem_prompt: |\n  You help. Old key ${leaked} do not use.\n`)
    const r = await call('GET', '/api/agent-chat/agents/leaky', { as: MEMBER })
    expect(r.status).toBe(200)
    expect(r.json.agent.instructions).toContain('You help.')
    expect(r.json.agent.instructions).not.toContain(leaked)
    // The list stays light: no instructions in it.
    const list = await call('GET', '/api/agent-chat/agents', { as: MEMBER })
    expect(list.json.agents.find((a: Loose) => a.slug === 'leaky')).not.toHaveProperty('instructions')
    expect(list.json.agents.find((a: Loose) => a.slug === 'leaky')).not.toHaveProperty('system_prompt')
    fs.rmSync(path.join(TMP_AGENTS, 'leaky'), { recursive: true })
  })
})

describe('refreshed whenever the bot is created or changed', () => {
  it('a bot-page settings change (tools) refreshes the About at once; resetting refreshes it again', async () => {
    await call('GET', '/api/agent-chat/agents', { as: MEMBER })
    await about.aboutQueueIdle()
    asked = []

    const put = await call('PUT', '/api/agent-chat/agents/researcher/config', { as: ADMIN, role: 'admin', body: { tools: ['email'] } })
    expect(put.status).toBe(200)
    // Shown straight away: the rules About for the NEW tools, never the old model text.
    expect(put.json.agent.about.generated_by).toBe('rules')
    expect(put.json.agent.about.pending).toBe(true)
    expect(put.json.agent.about.how_to_use).toContain('draft email replies')
    expect(put.json.agent.about.how_to_use).not.toContain('look something up on the web')
    await about.aboutQueueIdle()
    expect(asked).toEqual([expect.objectContaining({ slug: 'researcher', tools: ['email'] })])
    const after = await call('GET', '/api/agent-chat/agents/researcher', { as: MEMBER })
    expect(after.json.agent.about.generated_by).toBe('model')
    expect(after.json.agent.about.example_prompts[0]).toContain('(email)')

    asked = []
    const del = await call('DELETE', '/api/agent-chat/agents/researcher/config', { as: ADMIN, role: 'admin' })
    expect(del.status).toBe(200)
    await about.aboutQueueIdle()
    expect(asked).toEqual([expect.objectContaining({ slug: 'researcher', tools: ['search', 'read_file', 'web_search'] })])
  })

  it('an instructions edit made outside the app (the file by hand) is picked up by the next list read', async () => {
    await call('GET', '/api/agent-chat/agents', { as: MEMBER })
    await about.aboutQueueIdle()
    asked = []
    writeAgent('researcher', RESEARCHER.replace('for the sales team', 'for the hiring team'))
    const r = await call('GET', '/api/agent-chat/agents', { as: MEMBER })
    const a = r.json.agents.find((x: Loose) => x.slug === 'researcher')
    expect(a.about.description).toBe('A research assistant for the hiring team.')
    await about.aboutQueueIdle()
    expect(asked.map(x => x.prompt)).toEqual([expect.stringContaining('hiring team')])
    writeAgent('researcher', RESEARCHER)
    await call('GET', '/api/agent-chat/agents', { as: MEMBER })
    await about.aboutQueueIdle()
  })

  it('creating a bot (import) queues its About straight away', async () => {
    const content = [
      'name: Onboarder',
      'slug: onboarder',
      'description: ""',
      'version: 1.0.0',
      'author: test',
      'tools: [create_objective]',
      'system_prompt: |',
      '  You are the onboarding guide for new customers.',
    ].join('\n') + '\n'
    const r = await call('POST', '/api/agent-templates/import', { as: ADMIN, role: 'admin', body: { content, filename: 'agent.yaml' } })
    expect(r.status).toBe(201)
    await about.aboutQueueIdle()
    expect(asked.map(x => x.slug)).toEqual(['onboarder'])
    const got = await call('GET', '/api/agent-chat/agents/onboarder', { as: MEMBER })
    expect(got.json.agent.about.generated_by).toBe('model')
    expect(got.json.agent.about.description).toBe('Onboarder finds facts about prospects.')
  })

  it('a failed model call leaves the rules About showing and is not retried on every read', async () => {
    writeAgent('flaky', 'name: Flaky\nsystem_prompt: You are a flaky helper.\n')
    failNext = true
    await call('GET', '/api/agent-chat/agents', { as: MEMBER })
    await about.aboutQueueIdle()
    expect(asked.filter(x => x.slug === 'flaky').length).toBe(1)
    const r = await call('GET', '/api/agent-chat/agents', { as: MEMBER })
    const f = r.json.agents.find((a: Loose) => a.slug === 'flaky')
    expect(f.about.generated_by).toBe('rules')
    expect(f.about.description).toBe('A flaky helper.')
    expect(f.about.pending).toBe(false)
    await about.aboutQueueIdle()
    expect(asked.filter(x => x.slug === 'flaky').length).toBe(1)
    expect(about.getStoredAbout('flaky')?.last_error).toContain('model unavailable')
  })

  it('the kill switch turns the model step off; the rules About still shows', async () => {
    getDb().prepare("INSERT INTO settings (key, value) VALUES ('agent_chat_about_autogen', '0') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run()
    writeAgent('quiet', 'name: Quiet\nsystem_prompt: You are a quiet helper.\n')
    const r = await call('GET', '/api/agent-chat/agents', { as: MEMBER })
    const q = r.json.agents.find((a: Loose) => a.slug === 'quiet')
    expect(q.about).toMatchObject({ description: 'A quiet helper.', generated_by: 'rules', pending: false })
    await about.aboutQueueIdle()
    expect(asked).toEqual([])
    getDb().prepare("DELETE FROM settings WHERE key = 'agent_chat_about_autogen'").run()
  })
})
