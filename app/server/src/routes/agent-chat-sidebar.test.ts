import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'
import cookieParser from 'cookie-parser'
import jwt from 'jsonwebtoken'

/*
 * The Bots sidebar (obj 900798): pins, sections, hidden, unread + previews,
 * and the two bot-wide actions in its context menu (Rename, Delete).
 *
 * What is asserted here is the part that must hold at the boundary:
 *   - everything sidebar-shaped is the CALLER'S OWN (another person never sees
 *     or edits it, and cannot move a bot into someone else's section);
 *   - unread agrees with side threads: a reply in an open side thread counts, a
 *     reply in a closed one does not, and replying in a lane reads that lane;
 *   - existing history does NOT light up as unread the day this ships;
 *   - Rename and Delete keep the admin + signed-in-browser gate, and Delete
 *     moves the agent folder aside instead of erasing it.
 */
process.env.JWT_SECRET = 'test-secret-agent-chat-sidebar-xxxxx'
const TMP_DB = path.join(os.tmpdir(), `cc-agent-chat-sidebar-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB
const TMP_AGENTS = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-acs-agents-'))
const TMP_KB = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-acs-kb-'))
process.env.AGENT_FILES_DIR = TMP_AGENTS
process.env.KNOWLEDGE_BASE_DIR = TMP_KB
process.env.AGENT_CHAT_PROVIDER = 'demo'
// Only this test's own agent files, so the slugs below are the whole list.
process.env.AGENT_CHAT_BUILTINS = '0'

const { initDb, getDb } = await import('../db/index.js')
const { default: router } = await import('./agent-chat.js')

const OWNER = 2
const OTHER = 3
const ADMIN = 4
const BOTS = ['dev-bot', 'marketing-bot', 'ops-bot']

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
  const res = await fetch(`${baseUrl}/api/agent-chat${p}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) })
  const text = await res.text()
  let json: Loose = null
  try { json = text ? JSON.parse(text) : null } catch { /* not json */ }
  return { status: res.status, json }
}

const sidebar = (as: number) => call('GET', '/sidebar', { as })
const patchBot = (as: number, slug: string, body: unknown) => call('PATCH', `/sidebar/bots/${slug}`, { as, body })

function writeBot(slug: string, name: string) {
  fs.mkdirSync(path.join(TMP_AGENTS, slug), { recursive: true })
  fs.writeFileSync(
    path.join(TMP_AGENTS, slug, 'agent.yaml'),
    `name: ${name}\nsystem_prompt: You help.\nknowledge_folders: []\ntools: []\ncolour: blue\nversion: 1.0.0\nauthor: Test\n`,
  )
}

/** Insert a chat row directly, so unread can be asserted message by message. */
function msg(user: number, slug: string, role: 'user' | 'assistant', content: string, threadId: number | null = null): number {
  return Number(
    getDb()
      .prepare('INSERT INTO agent_chat_messages (user_id, agent_slug, role, content, thread_id) VALUES (?, ?, ?, ?, ?)')
      .run(user, slug, role, content, threadId).lastInsertRowid,
  )
}

beforeAll(async () => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
  const db = getDb()
  for (const [id, role] of [[OWNER, 'member'], [OTHER, 'member'], [ADMIN, 'admin']] as const) {
    db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, 'x', ?)`).run(id, `user${id}`, role)
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
  fs.rmSync(TMP_AGENTS, { recursive: true, force: true })
  fs.mkdirSync(TMP_AGENTS, { recursive: true })
  writeBot('dev-bot', 'Dev Bot')
  writeBot('marketing-bot', 'Marketing Bot')
  writeBot('ops-bot', 'Ops Bot')
  const db = getDb()
  db.prepare('DELETE FROM agent_chat_messages').run()
  db.prepare('DELETE FROM agent_chat_threads').run()
  db.prepare('DELETE FROM agent_chat_sidebar_bots').run()
  db.prepare('DELETE FROM agent_chat_sidebar_sections').run()
  db.prepare('DELETE FROM agent_chat_bot_config').run()
})

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
  try { getDb().close() } catch { /* already closed */ }
  for (const s of ['', '-wal', '-shm']) { const f = `${TMP_DB}${s}`; if (fs.existsSync(f)) fs.unlinkSync(f) }
  fs.rmSync(TMP_AGENTS, { recursive: true, force: true })
  fs.rmSync(TMP_KB, { recursive: true, force: true })
})

describe('GET /sidebar', () => {
  it('starts with the defaults for every bot: nothing pinned, no sections, nothing hidden or unread', async () => {
    const r = await sidebar(OWNER)
    expect(r.status).toBe(200)
    expect(r.json.sections).toEqual([])
    expect(Object.keys(r.json.bots).sort()).toEqual(BOTS)
    for (const b of Object.values(r.json.bots) as Loose[]) {
      expect(b).toMatchObject({ pinned: false, section_id: null, hidden: false, unread: false, unread_count: 0, last_message: null })
    }
  })

  it('needs a signed-in person', async () => {
    expect((await call('GET', '/sidebar')).status).toBe(401)
  })
})

describe('pinning', () => {
  it('pins in order, reorders, and unpins — persisted per person', async () => {
    await patchBot(OWNER, 'ops-bot', { pinned: true })
    const r = await patchBot(OWNER, 'dev-bot', { pinned: true })
    expect(r.status).toBe(200)
    expect(r.json.bots['ops-bot']).toMatchObject({ pinned: true, pin_position: 0 })
    expect(r.json.bots['dev-bot']).toMatchObject({ pinned: true, pin_position: 1 })

    const re = await call('PUT', '/sidebar/pins/order', { as: OWNER, body: { slugs: ['dev-bot', 'ops-bot'] } })
    expect(re.json.bots['dev-bot'].pin_position).toBe(0)
    expect(re.json.bots['ops-bot'].pin_position).toBe(1)
    // A partial order is refused rather than guessed at.
    expect((await call('PUT', '/sidebar/pins/order', { as: OWNER, body: { slugs: ['dev-bot'] } })).status).toBe(409)

    // Another person's sidebar is untouched.
    const other = await sidebar(OTHER)
    expect(other.json.bots['dev-bot'].pinned).toBe(false)

    const un = await patchBot(OWNER, 'dev-bot', { pinned: false })
    expect(un.json.bots['dev-bot'].pinned).toBe(false)
    expect((await sidebar(OWNER)).json.bots['ops-bot'].pinned).toBe(true)
  })

  it('rejects a non-boolean and a bot that does not exist', async () => {
    expect((await patchBot(OWNER, 'dev-bot', { pinned: 'yes' })).status).toBe(400)
    expect((await patchBot(OWNER, 'no-such-bot', { pinned: true })).status).toBe(404)
  })
})

describe('hide from sidebar', () => {
  it('hides (and unpins), and pinning again shows it', async () => {
    await patchBot(OWNER, 'dev-bot', { pinned: true })
    const h = await patchBot(OWNER, 'dev-bot', { hidden: true })
    expect(h.json.bots['dev-bot']).toMatchObject({ hidden: true, pinned: false })
    const p = await patchBot(OWNER, 'dev-bot', { pinned: true })
    expect(p.json.bots['dev-bot']).toMatchObject({ hidden: false, pinned: true })
    const s = await patchBot(OWNER, 'dev-bot', { hidden: false })
    expect(s.json.bots['dev-bot'].hidden).toBe(false)
  })
})

describe('sections', () => {
  it('creates, renames, reorders, moves a bot in, and deleting a section keeps its bots', async () => {
    const dev = await call('POST', '/sidebar/sections', { as: OWNER, body: { name: '  Development ' } })
    expect(dev.status).toBe(201)
    expect(dev.json.section).toMatchObject({ name: 'Development', position: 0, collapsed: false })
    const mkt = await call('POST', '/sidebar/sections', { as: OWNER, body: { name: 'Marketing' } })
    const devId = dev.json.section.id as number
    const mktId = mkt.json.section.id as number

    const moved = await patchBot(OWNER, 'dev-bot', { section_id: devId })
    expect(moved.json.bots['dev-bot'].section_id).toBe(devId)
    await patchBot(OWNER, 'marketing-bot', { section_id: mktId })

    const renamed = await call('PATCH', `/sidebar/sections/${mktId}`, { as: OWNER, body: { name: 'Growth', collapsed: true } })
    expect(renamed.json.section).toMatchObject({ name: 'Growth', collapsed: true })

    const order = await call('PUT', '/sidebar/sections/order', { as: OWNER, body: { ids: [mktId, devId] } })
    expect(order.json.sections.map((s: Loose) => s.id)).toEqual([mktId, devId])
    expect((await call('PUT', '/sidebar/sections/order', { as: OWNER, body: { ids: [mktId] } })).status).toBe(409)

    // Move to "Other bots".
    const out = await patchBot(OWNER, 'marketing-bot', { section_id: null })
    expect(out.json.bots['marketing-bot'].section_id).toBeNull()

    const del = await call('DELETE', `/sidebar/sections/${devId}`, { as: OWNER })
    expect(del.status).toBe(200)
    expect(del.json.moved).toBe(1)
    expect(del.json.sections.map((s: Loose) => s.id)).toEqual([mktId])
    expect(del.json.bots['dev-bot']).toMatchObject({ section_id: null, hidden: false })
  })

  it('keeps sections private: another person cannot see, edit or move a bot into them', async () => {
    const mine = await call('POST', '/sidebar/sections', { as: OWNER, body: { name: 'Mine' } })
    const id = mine.json.section.id as number
    expect((await sidebar(OTHER)).json.sections).toEqual([])
    expect((await call('PATCH', `/sidebar/sections/${id}`, { as: OTHER, body: { name: 'Taken' } })).status).toBe(404)
    expect((await call('DELETE', `/sidebar/sections/${id}`, { as: OTHER })).status).toBe(404)
    expect((await patchBot(OTHER, 'dev-bot', { section_id: id })).status).toBe(404)
    expect((await sidebar(OWNER)).json.sections[0].name).toBe('Mine')
  })

  it('validates names', async () => {
    expect((await call('POST', '/sidebar/sections', { as: OWNER, body: { name: '   ' } })).status).toBe(400)
    expect((await call('POST', '/sidebar/sections', { as: OWNER, body: { name: 'x'.repeat(41) } })).status).toBe(400)
  })
})

describe('unread + last-message preview', () => {
  it('does not mark history from before the sidebar existed as unread', async () => {
    msg(OWNER, 'dev-bot', 'user', 'old question')
    msg(OWNER, 'dev-bot', 'assistant', 'old answer')
    const r = await sidebar(OWNER)
    expect(r.json.bots['dev-bot']).toMatchObject({ unread: false, unread_count: 0 })
    expect(r.json.bots['dev-bot'].last_message).toMatchObject({ role: 'assistant', preview: 'old answer', thread_id: null })
  })

  it('counts a new reply, clears on read, and Mark as unread sticks until the next read', async () => {
    await sidebar(OWNER) // first look: everything so far is read
    msg(OWNER, 'dev-bot', 'assistant', 'A **new** reply arrived\n\nwith `markdown`')
    let r = await sidebar(OWNER)
    expect(r.json.bots['dev-bot']).toMatchObject({ unread: true, unread_count: 1 })
    expect(r.json.bots['dev-bot'].last_message.preview).toBe('A new reply arrived with markdown')

    r = await call('POST', '/sidebar/bots/dev-bot/read', { as: OWNER })
    expect(r.json.bots['dev-bot']).toMatchObject({ unread: false, unread_count: 0 })

    r = await call('POST', '/sidebar/bots/dev-bot/unread', { as: OWNER })
    expect(r.json.bots['dev-bot']).toMatchObject({ unread: true, marked_unread: true, unread_count: 0 })
    r = await call('POST', '/sidebar/bots/dev-bot/read', { as: OWNER })
    expect(r.json.bots['dev-bot']).toMatchObject({ unread: false, marked_unread: false })

    // Per person: the other person never had that reply.
    expect((await sidebar(OTHER)).json.bots['dev-bot'].unread).toBe(false)
  })

  it('agrees with side threads: open lanes count, a closed lane does not, and replying reads that lane', async () => {
    await sidebar(OWNER)
    const db = getDb()
    const open = Number(db.prepare("INSERT INTO agent_chat_threads (user_id, agent_slug, title) VALUES (?, 'dev-bot', 'Quarterly numbers')").run(OWNER).lastInsertRowid)
    const closed = Number(
      db.prepare("INSERT INTO agent_chat_threads (user_id, agent_slug, title, archived) VALUES (?, 'dev-bot', 'Old lane', 1)").run(OWNER).lastInsertRowid,
    )
    msg(OWNER, 'dev-bot', 'assistant', 'main reply')
    msg(OWNER, 'dev-bot', 'assistant', 'side reply', open)
    msg(OWNER, 'dev-bot', 'assistant', 'closed-lane reply', closed)
    let r = await sidebar(OWNER)
    expect(r.json.bots['dev-bot'].unread_count).toBe(2)
    // The preview is the newest message in an OPEN lane, and names that lane.
    expect(r.json.bots['dev-bot'].last_message).toMatchObject({ preview: 'side reply', thread_id: open, thread_title: 'Quarterly numbers' })

    // Answering in the side thread reads that lane only; the main reply is still unread.
    msg(OWNER, 'dev-bot', 'user', 'thanks', open)
    r = await sidebar(OWNER)
    expect(r.json.bots['dev-bot'].unread_count).toBe(1)
    expect(r.json.bots['dev-bot'].last_message).toMatchObject({ role: 'user', preview: 'thanks' })
  })

  it('counts a real turn through the HTTP chat path', async () => {
    await sidebar(OWNER)
    const sent = await call('POST', '/agents/ops-bot/messages', { as: OWNER, body: { text: 'hello' } })
    expect(sent.status).toBe(200)
    const r = await sidebar(OWNER)
    expect(r.json.bots['ops-bot'].unread_count).toBeGreaterThanOrEqual(1)
    expect(r.json.bots['ops-bot'].last_message).not.toBeNull()
    expect((await call('POST', '/sidebar/bots/ops-bot/read', { as: OWNER })).json.bots['ops-bot'].unread).toBe(false)
  })
})

describe('Rename (admin, for everyone)', () => {
  it('lets a signed-in admin rename a bot, keeps the slug, and resets to the file name', async () => {
    const r = await call('PUT', '/agents/dev-bot/config', { as: ADMIN, role: 'admin', body: { name: '  Engineering   lead ' } })
    expect(r.status).toBe(200)
    expect(r.json.agent).toMatchObject({ slug: 'dev-bot', name: 'Engineering lead', file_name: 'Dev Bot' })
    const list = await call('GET', '/agents', { as: OWNER })
    expect(list.json.agents.find((a: Loose) => a.slug === 'dev-bot').name).toBe('Engineering lead')

    // Changing the model later keeps the name.
    await call('PUT', '/agents/dev-bot/config', { as: ADMIN, role: 'admin', body: { model: 'claude-opus-5-5' } })
    expect((await call('GET', '/agents/dev-bot', { as: OWNER })).json.agent.name).toBe('Engineering lead')

    const back = await call('PUT', '/agents/dev-bot/config', { as: ADMIN, role: 'admin', body: { name: '' } })
    expect(back.json.agent.name).toBe('Dev Bot')
    expect((await call('PUT', '/agents/dev-bot/config', { as: ADMIN, role: 'admin', body: { name: 'x'.repeat(61) } })).status).toBe(400)
  })

  it('refuses a member (the same gate as changing a bot\'s model or tools)', async () => {
    expect((await call('PUT', '/agents/dev-bot/config', { as: OWNER, body: { name: 'Mine' } })).status).toBe(403)
    expect((await call('GET', '/agents/dev-bot', { as: OWNER })).json.agent.name).toBe('Dev Bot')
  })
})

describe('Delete (admin, for everyone)', () => {
  it('refuses a member and changes nothing', async () => {
    expect((await call('DELETE', '/agents/dev-bot', { as: OWNER })).status).toBe(403)
    expect(fs.existsSync(path.join(TMP_AGENTS, 'dev-bot', 'agent.yaml'))).toBe(true)
  })

  it('moves the agent folder to .deleted/, drops it from the list and from every sidebar, keeps chat history', async () => {
    await patchBot(OWNER, 'dev-bot', { pinned: true })
    msg(OWNER, 'dev-bot', 'user', 'keep me')
    getDb().prepare("INSERT OR IGNORE INTO agent_chat_bot_access (slug, mode) VALUES ('dev-bot', 'unrestricted')").run()
    getDb().prepare("INSERT OR IGNORE INTO agent_chat_bot_workspaces (slug, workspace) VALUES ('dev-bot', 'growth')").run()
    const r = await call('DELETE', '/agents/dev-bot', { as: ADMIN, role: 'admin' })
    expect(r.status).toBe(200)
    expect(r.json).toMatchObject({ ok: true, slug: 'dev-bot', still_listed: false })
    expect(r.json.moved_to).toMatch(/^\.deleted\/dev-bot-\d{8}T\d{6}Z$/)
    expect(fs.existsSync(path.join(TMP_AGENTS, 'dev-bot'))).toBe(false)
    expect(fs.existsSync(path.join(TMP_AGENTS, r.json.moved_to, 'agent.yaml'))).toBe(true)

    const list = await call('GET', '/agents', { as: OWNER })
    expect(list.json.agents.map((a: Loose) => a.slug)).not.toContain('dev-bot')
    const sb = await sidebar(OWNER)
    expect(sb.json.bots['dev-bot']).toBeUndefined()
    const row = getDb().prepare("SELECT COUNT(*) AS n FROM agent_chat_sidebar_bots WHERE agent_slug = 'dev-bot'").get() as { n: number }
    expect(row.n).toBe(0)
    const kept = getDb().prepare("SELECT COUNT(*) AS n FROM agent_chat_messages WHERE agent_slug = 'dev-bot'").get() as { n: number }
    expect(kept.n).toBe(1)
    // Its workspace access goes too (obj 900797), so a re-created bot starts with none.
    const access = getDb().prepare("SELECT (SELECT COUNT(*) FROM agent_chat_bot_access WHERE slug = 'dev-bot') + (SELECT COUNT(*) FROM agent_chat_bot_workspaces WHERE slug = 'dev-bot') AS n").get() as { n: number }
    expect(access.n).toBe(0)
    expect((await call('DELETE', '/agents/dev-bot', { as: ADMIN, role: 'admin' })).status).toBe(404)
  })
})
