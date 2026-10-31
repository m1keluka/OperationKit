import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'
import cookieParser from 'cookie-parser'
import jwt from 'jsonwebtoken'

// Isolated DB, agents dir and knowledge base BEFORE importing anything that reads them.
process.env.JWT_SECRET = 'test-secret-agent-chat-xxxx'
const TMP_DB = path.join(os.tmpdir(), `cc-agent-chat-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB
const TMP_AGENTS = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-agent-chat-agents-'))
const TMP_KB = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-agent-chat-kb-'))
process.env.AGENT_FILES_DIR = TMP_AGENTS
process.env.KNOWLEDGE_BASE_DIR = TMP_KB
// No AI account in this test: every turn runs on the scripted demo provider.
process.env.AGENT_CHAT_PROVIDER = 'demo'

const { initDb, getDb } = await import('../db/index.js')
const { default: router } = await import('./agent-chat.js')
const { runTool } = await import('../services/agent-chat/tools.js')
const { findAgent } = await import('../services/agent-chat/engine.js')

const ADMIN = 1
const OWNER = 2
const OTHER = 3
const WS = 'client-ws'

let server: http.Server
let baseUrl: string

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any

function tokenFor(id: number, role = 'member') {
  return jwt.sign({ id, username: `user${id}`, role }, process.env.JWT_SECRET as string, { expiresIn: '1h' })
}

async function call(method: string, p: string, opts: { as?: number; role?: string; body?: unknown; bearer?: boolean } = {}) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (opts.as) {
    const t = tokenFor(opts.as, opts.role)
    if (opts.bearer) headers.Authorization = `Bearer ${t}`
    else headers.Cookie = `token=${t}`
  }
  const res = await fetch(`${baseUrl}/api/agent-chat${p}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) })
  const text = await res.text()
  let json: Loose = null
  try { json = text ? JSON.parse(text) : null } catch { /* not json */ }
  return { status: res.status, json }
}

const say = (as: number, text: string, slug = 'demo-assistant') => call('POST', `/agents/${slug}/messages`, { as, body: { text } })

beforeAll(async () => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
  const db = getDb()
  db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (1, 'user1', 'x', 'admin')`).run()
  db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (2, 'user2', 'x', 'member')`).run()
  db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (3, 'user3', 'x', 'member')`).run()
  db.prepare(`INSERT OR IGNORE INTO workspaces (slug, name) VALUES (?, 'Client')`).run(WS)
  for (const u of [OWNER, OTHER]) db.prepare('INSERT INTO user_workspaces (user_id, workspace) VALUES (?, ?)').run(u, WS)

  // A file agent with a narrow knowledge folder, to prove confinement.
  fs.mkdirSync(path.join(TMP_AGENTS, 'librarian'))
  fs.writeFileSync(path.join(TMP_AGENTS, 'librarian', 'agent.yaml'), 'name: Librarian\nsystem_prompt: You keep notes.\nknowledge_folders: [team/notes]\ntools: [search, read_file, write_doc]\ncolour: blue\nversion: 1.0.0\nauthor: Test\n')
  fs.mkdirSync(path.join(TMP_KB, 'team', 'notes'), { recursive: true })
  fs.mkdirSync(path.join(TMP_KB, 'private'), { recursive: true })
  fs.writeFileSync(path.join(TMP_KB, 'team', 'notes', 'welcome.md'), '# Welcome\nThe office wifi is on the fridge.\n')
  fs.writeFileSync(path.join(TMP_KB, 'private', 'salaries.md'), 'secret numbers')

  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  app.use('/api/agent-chat', router)
  await new Promise<void>(resolve => { server = app.listen(0, () => resolve()) })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no address')
  baseUrl = `http://127.0.0.1:${addr.port}`
})

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
  try { getDb().close() } catch { /* already closed */ }
  for (const s of ['', '-wal', '-shm']) { const f = `${TMP_DB}${s}`; if (fs.existsSync(f)) fs.unlinkSync(f) }
  fs.rmSync(TMP_AGENTS, { recursive: true, force: true })
  fs.rmSync(TMP_KB, { recursive: true, force: true })
})

describe('agent chat', () => {
  it('requires sign-in', async () => {
    expect((await call('GET', '/agents')).status).toBe(401)
  })

  it('lists file agents; the demo agent appears only after an admin switches the demo on', async () => {
    const before = await call('GET', '/agents', { as: OWNER })
    expect(before.status).toBe(200)
    expect(before.json.agents.map((a: Loose) => a.slug)).toEqual(['librarian'])
    expect(before.json.agents[0]).toMatchObject({ name: 'Librarian', colour: 'blue', answered_by: { id: 'demo' } })
    expect(before.json.agents[0].system_prompt).toBeUndefined()

    expect((await call('PUT', '/settings', { as: OWNER, body: { demo: true } })).status).toBe(403)
    const on = await call('PUT', '/settings', { as: ADMIN, role: 'admin', body: { demo: true } })
    expect(on.json.demo).toBe(true)
    // The demo's sample notes were copied into the knowledge base.
    expect(fs.existsSync(path.join(TMP_KB, 'demo', 'personal-assistant', 'todo.md'))).toBe(true)

    const after = await call('GET', '/agents', { as: OWNER })
    expect(after.json.agents.map((a: Loose) => a.slug)).toEqual(['librarian', 'demo-assistant'])
    const one = await call('GET', '/agents/demo-assistant', { as: OWNER })
    expect(one.json.agent.system_prompt).toMatch(/personal assistant/)
  })

  it('reads the sample inbox, and every reply says which provider answered', async () => {
    const r = await say(OWNER, "What's in my inbox?")
    expect(r.status).toBe(200)
    const roles = r.json.messages.map((m: Loose) => m.role)
    expect(roles).toEqual(['user', 'tool', 'assistant'])
    expect(r.json.messages[1]).toMatchObject({ tool_name: 'email_list_inbox', content: expect.stringMatching(/Checked inbox/) })
    const reply = r.json.messages[2]
    expect(reply).toMatchObject({ provider: 'demo', model: 'scripted', meta: { provider_label: 'Demo (no AI account)' } })
    expect(reply.content).toMatch(/Priya/)
  })

  it('drafts a reply but never sends it; only the person, signed in, can press Send', async () => {
    const r = await say(OWNER, 'Reply to Priya')
    expect(r.status).toBe(200)
    expect(r.json.messages.map((m: Loose) => m.tool_name).filter(Boolean)).toEqual(['email_list_inbox', 'email_read', 'email_create_draft'])
    expect(r.json.drafts).toHaveLength(1)
    const draft = r.json.drafts[0]
    expect(draft).toMatchObject({ kind: 'email', status: 'draft', connector: 'demo', payload: { to: 'priya@harbor-coffee.example', subject: "Re: Can we move Thursday's review?" } })
    expect(r.json.messages.at(-1).content).toMatch(/press \*\*Send\*\*/)

    // Another person cannot see or send it.
    expect((await call('POST', `/drafts/${draft.id}/send`, { as: OTHER })).status).toBe(404)
    // An API caller (bearer, not the browser session) cannot send it.
    expect((await call('POST', `/drafts/${draft.id}/send`, { as: OWNER, bearer: true })).status).toBe(403)
    // The person can edit, then send.
    const edited = await call('PUT', `/drafts/${draft.id}`, { as: OWNER, body: { body: 'Friday 10:00 works. — Jordan' } })
    expect(edited.json.draft.payload.body).toBe('Friday 10:00 works. — Jordan')
    const sent = await call('POST', `/drafts/${draft.id}/send`, { as: OWNER })
    expect(sent.status).toBe(200)
    expect(sent.json.draft.status).toBe('sent')
    expect((await call('POST', `/drafts/${draft.id}/send`, { as: OWNER })).status).toBe(409)
  })

  it('drafts a calendar invite that is only added on click', async () => {
    const r = await say(OWNER, 'Move the meeting with Priya to Friday')
    const d = r.json.drafts[0]
    expect(d).toMatchObject({ kind: 'event', status: 'draft', payload: { title: 'Menu-board review' } })
    expect(new Date(d.payload.start).getDay()).toBe(5)
    const added = await call('POST', `/drafts/${d.id}/send`, { as: OWNER })
    expect(added.json.draft.status).toBe('added')
  })

  it('reads and updates the to-do list inside its knowledge folder', async () => {
    const add = await say(OWNER, 'Add call the printer to my to-do list')
    expect(add.json.messages.at(-1).content).toMatch(/call the printer/)
    expect(fs.readFileSync(path.join(TMP_KB, 'demo', 'personal-assistant', 'todo.md'), 'utf8')).toMatch(/- \[ \] call the printer/)
    const list = await say(OWNER, "What's on my to-do list?")
    expect(list.json.messages.at(-1).content).toMatch(/call the printer/)
  })

  it('hands bigger work to the board as a card and shows its status back in the chat', async () => {
    const r = await say(OWNER, 'Prepare a website quote for Elena')
    expect(r.status).toBe(200)
    expect(r.json.cards).toHaveLength(1)
    const card = r.json.cards[0]
    expect(card).toMatchObject({ status: 'queue', url: `/o/${card.id}` })
    const row = getDb().prepare('SELECT workspace, origin, created_by, assigned_user_id, description FROM objectives WHERE id = ?').get(card.id) as Loose
    expect(row).toMatchObject({ workspace: WS, origin: 'agent_chat', created_by: OWNER, assigned_user_id: OWNER })
    expect(row.description).toMatch(/Requested in chat with "Personal assistant \(demo\)"/)

    // The board moves the card on; the chat reads the live status.
    getDb().prepare("UPDATE objectives SET status = 'working' WHERE id = ?").run(card.id)
    const hist = await call('GET', '/agents/demo-assistant/messages', { as: OWNER })
    expect(hist.json.cards.find((c: Loose) => c.id === card.id).status).toBe('working')
    const status = await say(OWNER, 'How are my cards doing?')
    expect(status.json.messages.at(-1).content).toMatch(new RegExp(`#${card.id}.*working`))
  })

  it('keeps one chat per person per agent, private to that person', async () => {
    const mine = await call('GET', '/agents/demo-assistant/messages', { as: OWNER })
    expect(mine.json.messages.length).toBeGreaterThan(10)
    const theirs = await call('GET', '/agents/demo-assistant/messages', { as: OTHER })
    expect(theirs.json.messages).toEqual([])
    const after = mine.json.messages.at(-2).id
    const tail = await call('GET', `/agents/demo-assistant/messages?after=${after}`, { as: OWNER })
    expect(tail.json.messages).toHaveLength(1)
    const cleared = await call('DELETE', '/agents/demo-assistant/messages', { as: OTHER })
    expect(cleared.json.removed).toBe(0)
  })

  it('confines knowledge tools to the agent\'s folders', () => {
    const agent = findAgent('librarian')!
    const ctx = { userId: OWNER, username: 'user2', workspace: WS, agent, kbRoot: TMP_KB, connectors: { mail: null, calendar: null } }
    expect(runTool(ctx, 'read_file', { path: 'team/notes/welcome.md' }).result).toMatchObject({ content: expect.stringMatching(/wifi/) })
    expect(() => runTool(ctx, 'read_file', { path: 'private/salaries.md' })).toThrow(/outside this agent's knowledge folders/)
    expect(() => runTool(ctx, 'read_file', { path: 'team/notes/../../private/salaries.md' })).toThrow(/outside/)
    expect(() => runTool(ctx, 'read_file', { path: '/etc/passwd' })).toThrow(/outside/)
    fs.symlinkSync(path.join(TMP_KB, 'private'), path.join(TMP_KB, 'team', 'notes', 'sneaky'))
    expect(() => runTool(ctx, 'read_file', { path: 'team/notes/sneaky/salaries.md' })).toThrow(/outside/)
    expect(() => runTool(ctx, 'write_doc', { path: 'private/x.md', content: 'x' })).toThrow(/outside/)
    expect(runTool(ctx, 'write_doc', { path: 'team/notes/new.md', content: '# New' }).summary).toBe('Saved team/notes/new.md')
    expect(() => runTool(ctx, 'write_doc', { path: 'team/notes/run.sh', content: 'x' })).toThrow(/Only \.md/)
    const hits = runTool(ctx, 'search', { q: 'wifi' }).result as Loose
    expect(hits.results.map((h: Loose) => h.path)).toEqual(['team/notes/welcome.md'])
    // Tools not in the agent file are refused even if the model asks for them.
    expect(() => runTool(ctx, 'email_create_draft', { to: 'a', subject: 'b', body: 'c' })).toThrow(/not allowed/)
    expect(() => runTool(ctx, 'create_objective', { title: 'x' })).toThrow(/not allowed/)
  })

  it('re-seeds the demo notes on first use when the demo was switched on by env, not the button', async () => {
    fs.rmSync(path.join(TMP_KB, 'demo'), { recursive: true, force: true })
    const r = await say(OTHER, "What's on my to-do list?")
    expect(r.json.messages.at(-1).content).toMatch(/Reply to Marcus/)
  })

  it('validates input', async () => {
    expect((await say(OWNER, '   ')).status).toBe(400)
    expect((await say(OWNER, 'hi', 'nope')).status).toBe(404)
    expect((await call('PUT', '/settings', { as: ADMIN, role: 'admin', body: { default_provider: 'bogus' } })).status).toBe(400)
  })
})
