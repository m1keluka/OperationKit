import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'
import cookieParser from 'cookie-parser'
import jwt from 'jsonwebtoken'

/*
 * The HTTP surface of bot side threads (obj 900370).
 *
 * The service-level proof lives in services/agent-chat/side-threads.test.ts.
 * THIS file is about the boundary: that `thread_id` reaches the right lane, and
 * — the part that matters — that a thread_id which is not the caller's own, or
 * belongs to another bot, is refused rather than silently answered from the main
 * conversation. A silent fallback is the failure mode that would quietly write
 * one lane's message into another's history, so it is asserted explicitly.
 */
process.env.JWT_SECRET = 'test-secret-agent-chat-threads-xxxx'
const TMP_DB = path.join(os.tmpdir(), `cc-agent-chat-threads-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB
const TMP_AGENTS = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-act-agents-'))
const TMP_KB = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-act-kb-'))
process.env.AGENT_FILES_DIR = TMP_AGENTS
process.env.KNOWLEDGE_BASE_DIR = TMP_KB
// No AI account in this test: every turn runs on the scripted demo provider.
process.env.AGENT_CHAT_PROVIDER = 'demo'

const { initDb, getDb } = await import('../db/index.js')
const { default: router } = await import('./agent-chat.js')

const OWNER = 2
const OTHER = 3
const SLUG = 'librarian'

let server: http.Server
let baseUrl: string

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any

function tokenFor(id: number, role = 'member') {
  return jwt.sign({ id, username: `user${id}`, role }, process.env.JWT_SECRET as string, { expiresIn: '1h' })
}

async function call(method: string, p: string, opts: { as?: number; role?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (opts.as) headers.Cookie = `token=${tokenFor(opts.as, opts.role)}`
  const res = await fetch(`${baseUrl}/api/agent-chat${p}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  })
  const text = await res.text()
  let json: Loose = null
  try { json = text ? JSON.parse(text) : null } catch { /* not json */ }
  return { status: res.status, json }
}

const newThread = (as: number, title: string, slug = SLUG) => call('POST', `/agents/${slug}/threads`, { as, body: { title } })
const say = (as: number, text: string, threadId?: number, slug = SLUG) =>
  call('POST', `/agents/${slug}/messages`, { as, body: { text, ...(threadId === undefined ? {} : { thread_id: threadId }) } })
const read = (as: number, threadId?: number, slug = SLUG) =>
  call('GET', `/agents/${slug}/messages${threadId === undefined ? '' : `?thread_id=${threadId}`}`, { as })
const contentsOf = (r: Loose): string[] => (r.json.messages as { content: string }[]).map(m => m.content)

beforeAll(async () => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
  const db = getDb()
  db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (?, 'user2', 'x', 'member')`).run(OWNER)
  db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (?, 'user3', 'x', 'member')`).run(OTHER)
  for (const slug of [SLUG, 'second-bot']) {
    fs.mkdirSync(path.join(TMP_AGENTS, slug))
    fs.writeFileSync(
      path.join(TMP_AGENTS, slug, 'agent.yaml'),
      'name: Librarian\nsystem_prompt: You keep notes.\nknowledge_folders: []\ntools: []\ncolour: blue\nversion: 1.0.0\nauthor: Test\n',
    )
  }

  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  app.use('/api/agent-chat', router)
  await new Promise<void>(resolve => { server = app.listen(0, () => resolve()) })
  const addr = server.address()
  baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
})

beforeEach(() => {
  const db = getDb()
  db.prepare('DELETE FROM agent_chat_messages').run()
  db.prepare('DELETE FROM agent_chat_threads').run()
})

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
  try { getDb().close() } catch { /* already closed */ }
  for (const s of ['', '-wal', '-shm']) { const f = `${TMP_DB}${s}`; if (fs.existsSync(f)) fs.unlinkSync(f) }
  fs.rmSync(TMP_AGENTS, { recursive: true, force: true })
  fs.rmSync(TMP_KB, { recursive: true, force: true })
})

describe('opening and listing side threads', () => {
  it('starts with none and reports the per-bot ceiling', async () => {
    const r = await call('GET', `/agents/${SLUG}/threads`, { as: OWNER })
    expect(r.status).toBe(200)
    expect(r.json.threads).toEqual([])
    expect(r.json.max_open).toBe(10)
  })

  it('opens a named lane and lists it', async () => {
    const c = await newThread(OWNER, '  Quarterly  numbers  ')
    expect(c.status).toBe(201)
    // Whitespace is collapsed, so a pasted title is not stored ragged.
    expect(c.json.thread.title).toBe('Quarterly numbers')
    expect(c.json.thread.archived).toBe(false)

    const list = await call('GET', `/agents/${SLUG}/threads`, { as: OWNER })
    expect(list.json.threads.map((t: Loose) => t.id)).toEqual([c.json.thread.id])
  })

  it('two lanes can be open for one bot at once', async () => {
    await newThread(OWNER, 'A')
    await newThread(OWNER, 'B')
    const list = await call('GET', `/agents/${SLUG}/threads`, { as: OWNER })
    expect(list.json.threads).toHaveLength(2)
  })

  it('one person does not see another person’s lanes', async () => {
    await newThread(OWNER, 'Mine')
    const theirs = await call('GET', `/agents/${SLUG}/threads`, { as: OTHER })
    expect(theirs.json.threads).toEqual([])
  })

  it('404s for a bot that is not on this install', async () => {
    expect((await call('GET', '/agents/nope/threads', { as: OWNER })).status).toBe(404)
  })
})

describe('messages are confined to the lane they were posted in', () => {
  it('a side-thread message is invisible in the main conversation and in the other lane', async () => {
    const a = (await newThread(OWNER, 'Lane A')).json.thread.id
    const b = (await newThread(OWNER, 'Lane B')).json.thread.id

    expect((await say(OWNER, 'main text', undefined)).status).toBe(200)
    expect((await say(OWNER, 'lane a text', a)).status).toBe(200)
    expect((await say(OWNER, 'lane b text', b)).status).toBe(200)

    expect(contentsOf(await read(OWNER))).toContain('main text')
    expect(contentsOf(await read(OWNER)).join('\n')).not.toContain('lane a text')

    expect(contentsOf(await read(OWNER, a))).toContain('lane a text')
    expect(contentsOf(await read(OWNER, a)).join('\n')).not.toContain('lane b text')
    expect(contentsOf(await read(OWNER, a)).join('\n')).not.toContain('main text')

    expect(contentsOf(await read(OWNER, b))).toContain('lane b text')
    expect(contentsOf(await read(OWNER, b)).join('\n')).not.toContain('lane a text')
  })

  it('another person’s thread_id is 404, not a quiet fall-back to their own main chat', async () => {
    const mine = (await newThread(OWNER, 'Mine')).json.thread.id
    await say(OWNER, 'private note', mine)

    expect((await read(OTHER, mine)).status).toBe(404)
    expect((await say(OTHER, 'sneak', mine)).status).toBe(404)
    // Nothing of theirs was written into my lane.
    expect(contentsOf(await read(OWNER, mine)).join('\n')).not.toContain('sneak')
  })

  it('a lane that belongs to a DIFFERENT bot is 404 on this bot', async () => {
    const other = (await newThread(OWNER, 'Other bot lane', 'second-bot')).json.thread.id
    expect((await read(OWNER, other, SLUG)).status).toBe(404)
    expect((await read(OWNER, other, 'second-bot')).status).toBe(200)
  })

  it('a junk thread_id is a 400, and an unknown one a 404', async () => {
    expect((await call('GET', `/agents/${SLUG}/messages?thread_id=abc`, { as: OWNER })).status).toBe(400)
    expect((await call('GET', `/agents/${SLUG}/messages?thread_id=-4`, { as: OWNER })).status).toBe(400)
    expect((await call('GET', `/agents/${SLUG}/messages?thread_id=987654`, { as: OWNER })).status).toBe(404)
  })

  it('omitting thread_id still means the main conversation, exactly as before', async () => {
    await say(OWNER, 'hello there', undefined)
    const main = await read(OWNER)
    expect(main.status).toBe(200)
    expect(contentsOf(main)).toContain('hello there')
  })
})

describe('closing a side thread leaves the main conversation unchanged', () => {
  async function seed() {
    const a = (await newThread(OWNER, 'Lane A')).json.thread.id
    await say(OWNER, 'main one', undefined)
    await say(OWNER, 'main two', undefined)
    await say(OWNER, 'lane one', a)
    return a
  }

  it('archiving hides the lane, keeps its messages, and does not touch the main history', async () => {
    const a = await seed()
    const before = (await read(OWNER)).json.messages

    const closed = await call('PATCH', `/agents/${SLUG}/threads/${a}`, { as: OWNER, body: { archived: true } })
    expect(closed.status).toBe(200)
    expect(closed.json.thread.archived).toBe(true)

    expect((await read(OWNER)).json.messages).toEqual(before)
    expect((await call('GET', `/agents/${SLUG}/threads`, { as: OWNER })).json.threads).toEqual([])
    expect((await call('GET', `/agents/${SLUG}/threads?archived=1`, { as: OWNER })).json.threads).toHaveLength(1)
    // Archive is not delete: the lane's own history survives.
    expect(contentsOf(await read(OWNER, a))).toContain('lane one')
  })

  it('clearing a side thread empties that lane only', async () => {
    const a = await seed()
    const before = (await read(OWNER)).json.messages

    const cleared = await call('DELETE', `/agents/${SLUG}/messages?thread_id=${a}`, { as: OWNER })
    expect(cleared.status).toBe(200)
    expect(cleared.json.removed).toBeGreaterThan(0)

    expect((await read(OWNER, a)).json.messages).toEqual([])
    expect((await read(OWNER)).json.messages).toEqual(before)
  })

  it('deleting a side thread outright leaves the main conversation alone', async () => {
    const a = await seed()
    const before = (await read(OWNER)).json.messages

    const gone = await call('DELETE', `/agents/${SLUG}/threads/${a}`, { as: OWNER })
    expect(gone.status).toBe(200)

    expect((await read(OWNER, a)).status).toBe(404)
    expect((await read(OWNER)).json.messages).toEqual(before)
    expect((await call('GET', `/agents/${SLUG}/threads?archived=1`, { as: OWNER })).json.threads).toEqual([])
  })

  it('clearing the main conversation leaves the side thread alone', async () => {
    const a = await seed()
    expect((await call('DELETE', `/agents/${SLUG}/messages`, { as: OWNER })).status).toBe(200)
    expect((await read(OWNER)).json.messages).toEqual([])
    expect(contentsOf(await read(OWNER, a))).toContain('lane one')
  })

  it('a person cannot close or delete someone else’s lane', async () => {
    const a = await seed()
    expect((await call('PATCH', `/agents/${SLUG}/threads/${a}`, { as: OTHER, body: { archived: true } })).status).toBe(404)
    expect((await call('DELETE', `/agents/${SLUG}/threads/${a}`, { as: OTHER })).status).toBe(404)
    expect((await call('GET', `/agents/${SLUG}/threads`, { as: OWNER })).json.threads).toHaveLength(1)
  })
})

describe('renaming', () => {
  it('renames a lane and refuses an empty name', async () => {
    const a = (await newThread(OWNER, 'Before')).json.thread.id
    const ok = await call('PATCH', `/agents/${SLUG}/threads/${a}`, { as: OWNER, body: { title: 'After' } })
    expect(ok.json.thread.title).toBe('After')
    const bad = await call('PATCH', `/agents/${SLUG}/threads/${a}`, { as: OWNER, body: { title: '   ' } })
    expect(bad.status).toBe(400)
    expect((await call('GET', `/agents/${SLUG}/threads`, { as: OWNER })).json.threads[0].title).toBe('After')
  })

  it('pins a lane to the top of the strip', async () => {
    const a = (await newThread(OWNER, 'A')).json.thread.id
    await newThread(OWNER, 'B')
    await call('PATCH', `/agents/${SLUG}/threads/${a}`, { as: OWNER, body: { pinned: true } })
    expect((await call('GET', `/agents/${SLUG}/threads`, { as: OWNER })).json.threads[0].id).toBe(a)
  })
})

describe('the per-bot ceiling is enforced at the boundary', () => {
  it('refuses to open past the configured ceiling with a 409', async () => {
    getDb()
      .prepare("INSERT INTO settings (key, value) VALUES ('agent_chat_max_threads_per_bot', '2') ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run()
    try {
      expect((await newThread(OWNER, 'A')).status).toBe(201)
      expect((await newThread(OWNER, 'B')).status).toBe(201)
      const third = await newThread(OWNER, 'C')
      expect(third.status).toBe(409)
      expect(String(third.json.error)).toMatch(/open side/i)
    } finally {
      getDb().prepare("DELETE FROM settings WHERE key = 'agent_chat_max_threads_per_bot'").run()
    }
  })
})
