// Chat board tools read the REAL board, scoped exactly like the board UI (obj 900623).
//
// The bug: list_objectives / get_objective only read agent_chat_cards (cards the
// chat itself filed), so a General asked "what is waiting on me?" got zero
// rows and reported an empty board while the workspace had cards in review.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

process.env.JWT_SECRET = 'test-secret-board-tools-xxxx'
const TMP_DB = path.join(os.tmpdir(), `cc-chat-board-tools-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB
const TMP_KB = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-chat-board-kb-'))

const { initDb, getDb } = await import('../../db/index.js')
const { runTool, toolSpecsFor, ToolUseError } = await import('./tools.js')
const { seedExistingBotsOnce } = await import('./bot-workspaces.js')
type Agent = import('./agent-defs.js').ChatAgent

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any

const ADMIN = 1
const ALICE = 2 // member of growth + quiet-co; owns the growth cards (the trial General's person)
const BOB = 3 // member of other-co only
const CAROL = 4 // member of growth too, but owns only one card there
const NOBODY = 5 // no memberships at all
const GROWTH = 'growth'
const OTHER = 'other-co'
const EMPTY_WS = 'quiet-co'

const agent: Agent = {
  slug: 'growth-general',
  name: 'General',
  description: '',
  avatar: '',
  colour: 'blue',
  system_prompt: 'You keep the person on top of their board.',
  knowledge_folders: [],
  tools: ['get_objective', 'list_objectives'],
  model: null,
  provider: null,
  schedules: [],
  version: null,
  author: null,
  how_to_use: '',
  example_prompts: [],
  source: 'file',
  file: '/dev/null',
}

function ctx(userId: number, a: Agent = agent) {
  return { userId, username: `user${userId}`, workspace: GROWTH, agent: a, kbRoot: TMP_KB, connectors: { mail: null, calendar: null } }
}

const ids: Record<string, number> = {}
function card(key: string, workspace: string, status: string, extra: { created_by?: number; has_blockers?: number; ai_review_verdict?: string; deleted?: boolean } = {}) {
  const r = getDb()
    .prepare(
      `INSERT INTO objectives (title, description, workspace, status, type, category, created_by, assigned_user_id, has_blockers, ai_review_verdict, deleted_at, updated_at)
       VALUES (?, '', ?, ?, 'task', 'general', ?, ?, ?, ?, ?, datetime('now'))`,
    )
    .run(key, workspace, status, extra.created_by ?? ADMIN, extra.created_by ?? ADMIN, extra.has_blockers ?? 0, extra.ai_review_verdict ?? null, extra.deleted ? new Date().toISOString() : null)
  ids[key] = Number(r.lastInsertRowid)
}

beforeAll(() => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
  const db = getDb()
  const users: [number, string][] = [[ADMIN, 'admin'], [ALICE, 'member'], [BOB, 'member'], [CAROL, 'member'], [NOBODY, 'member']]
  for (const [id, role] of users) db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, 'x', ?)`).run(id, `user${id}`, role)
  // obj 900797: these bots stand for bots that existed before per-bot workspace
  // access lists, so the one-time boot seed keeps them unrestricted (today's
  // behaviour). The restricted path is covered in bot-workspaces.test.ts.
  seedExistingBotsOnce(['growth-general', 'librarian', 'operation-kit-dev', 'notes-only'])
  for (const ws of [GROWTH, OTHER, EMPTY_WS]) db.prepare(`INSERT OR IGNORE INTO workspaces (slug, name) VALUES (?, ?)`).run(ws, ws)
  db.prepare(`INSERT INTO user_workspaces (user_id, workspace, role) VALUES (?, ?, 'member')`).run(ALICE, GROWTH)
  db.prepare(`INSERT INTO user_workspaces (user_id, workspace, role) VALUES (?, ?, 'member')`).run(ALICE, EMPTY_WS)
  db.prepare(`INSERT INTO user_workspaces (user_id, workspace, role) VALUES (?, ?, 'member')`).run(BOB, OTHER)
  db.prepare(`INSERT INTO user_workspaces (user_id, workspace, role) VALUES (?, ?, 'member')`).run(CAROL, GROWTH)

  // The growth board as the trial found it: several cards in review, none filed from chat.
  card('growth-review-1', GROWTH, 'review', { created_by: ALICE })
  card('growth-review-2', GROWTH, 'review', { created_by: ALICE, ai_review_verdict: 'fail' })
  card('growth-queue', GROWTH, 'queue', { created_by: ALICE })
  card('growth-working-blocked', GROWTH, 'working', { created_by: ALICE, has_blockers: 1 })
  card('growth-done', GROWTH, 'done', { created_by: ALICE })
  card('growth-deleted', GROWTH, 'review', { created_by: ALICE, deleted: true })
  card('growth-carols', GROWTH, 'queue', { created_by: CAROL })
  // Another tenant's board.
  card('other-review-SECRET', OTHER, 'review', { created_by: BOB })
  card('other-working-SECRET', OTHER, 'working', { created_by: BOB })
})

afterAll(() => {
  try { getDb().close() } catch { /* already closed */ }
  for (const s of ['', '-wal', '-shm']) { const f = `${TMP_DB}${s}`; if (fs.existsSync(f)) fs.unlinkSync(f) }
  fs.rmSync(TMP_KB, { recursive: true, force: true })
})

const titles = (r: Loose) => (r.cards as Loose[]).map(c => c.title).sort()

describe('chat list_objectives reads the real board', () => {
  it('a workspace member sees their workspace cards (review, queue, working, blocked) — not just chat-filed ones', () => {
    const r = runTool(ctx(ALICE), 'list_objectives', {}).result as Loose
    expect(titles(r)).toEqual(['growth-queue', 'growth-review-1', 'growth-review-2', 'growth-working-blocked'])
    expect(r.counts).toEqual({ review: 2, queue: 1, working: 1, blocked: 1 })
    expect(r.total).toBe(4)
    expect(r.empty).toBe(false)
    expect(r.cards.every((c: Loose) => c.from_this_chat === false)).toBe(true)
    expect(r.cards.find((c: Loose) => c.title === 'growth-working-blocked').has_blockers).toBe(true)
  })

  it('still marks the cards this chat filed', () => {
    getDb().prepare('INSERT INTO agent_chat_cards (objective_id, user_id, agent_slug) VALUES (?, ?, ?)').run(ids['growth-queue'], ALICE, agent.slug)
    const r = runTool(ctx(ALICE), 'list_objectives', {}).result as Loose
    expect(r.cards.filter((c: Loose) => c.from_this_chat).map((c: Loose) => c.title)).toEqual(['growth-queue'])
    getDb().prepare('DELETE FROM agent_chat_cards WHERE objective_id = ?').run(ids['growth-queue'])
  })

  it('filters one column, including the blocked flag', () => {
    expect(titles(runTool(ctx(ALICE), 'list_objectives', { status: 'review' }).result)).toEqual(['growth-review-1', 'growth-review-2'])
    expect(titles(runTool(ctx(ALICE), 'list_objectives', { status: 'blocked' }).result)).toEqual(['growth-working-blocked'])
    expect(titles(runTool(ctx(ALICE), 'list_objectives', { status: 'done' }).result)).toEqual(['growth-done'])
    expect(() => runTool(ctx(ALICE), 'list_objectives', { status: 'bogus' })).toThrow(/status must be one of/)
  })

  it('never shows another workspace\'s cards, and refuses to read a board the person is not on', () => {
    const r = runTool(ctx(ALICE), 'list_objectives', {}).result as Loose
    expect(JSON.stringify(r)).not.toMatch(/SECRET/)
    expect(r.workspaces).not.toContain(OTHER)
    expect(() => runTool(ctx(ALICE), 'list_objectives', { workspace: OTHER })).toThrow(ToolUseError)
    expect(() => runTool(ctx(ALICE), 'list_objectives', { workspace: OTHER })).toThrow(/can't see the "other-co" board/)
    // A workspace that does not exist reads the same as one that does: no existence oracle.
    expect(() => runTool(ctx(ALICE), 'list_objectives', { workspace: 'no-such-ws' })).toThrow(/can't see the "no-such-ws" board/)

    const bob = runTool(ctx(BOB), 'list_objectives', {}).result as Loose
    expect(titles(bob)).toEqual(['other-review-SECRET', 'other-working-SECRET'])
    expect(JSON.stringify(bob)).not.toMatch(/growth-/)
  })

  it('honours own-only visibility inside a workspace (never wider than the board UI)', () => {
    // Same workspace, but Carol neither created nor is assigned Alice's cards: the
    // board UI hides them from her, so the chat does too.
    const r = runTool(ctx(CAROL), 'list_objectives', {}).result as Loose
    expect(titles(r)).toEqual(['growth-carols'])
    // Being added as an assignee is what puts a card on her board.
    getDb().prepare('INSERT INTO objective_assignees (objective_id, user_id) VALUES (?, ?)').run(ids['growth-review-1'], CAROL)
    expect(titles(runTool(ctx(CAROL), 'list_objectives', {}).result)).toEqual(['growth-carols', 'growth-review-1'])
    getDb().prepare('DELETE FROM objective_assignees WHERE objective_id = ? AND user_id = ?').run(ids['growth-review-1'], CAROL)
  })

  it('admins see every workspace, and can narrow to one', () => {
    const all = runTool(ctx(ADMIN), 'list_objectives', {}).result as Loose
    expect(all.total).toBe(7)
    const other = runTool(ctx(ADMIN), 'list_objectives', { workspace: OTHER }).result as Loose
    expect(titles(other)).toEqual(['other-review-SECRET', 'other-working-SECRET'])
  })

  it('reports empty ONLY when the board truly has nothing open', () => {
    const quiet = runTool(ctx(ALICE), 'list_objectives', { workspace: EMPTY_WS }).result as Loose
    expect(quiet).toMatchObject({ empty: true, total: 0, cards: [] })
    expect(quiet.note).toMatch(/real board/)

    const busy = runTool(ctx(ALICE), 'list_objectives', { workspace: GROWTH }).result as Loose
    expect(busy.empty).toBe(false)

    // Truncation is not emptiness: a small page still says how many there are.
    const page = runTool(ctx(ALICE), 'list_objectives', { limit: 1 }).result as Loose
    expect(page).toMatchObject({ empty: false, total: 4, truncated: true })
    expect(page.cards).toHaveLength(1)

    const lonely = runTool(ctx(NOBODY), 'list_objectives', {}).result as Loose
    expect(lonely).toMatchObject({ empty: true, total: 0, cards: [] })
  })

  it('a deleted card is not on the board', () => {
    const r = runTool(ctx(ADMIN), 'list_objectives', { status: 'review', workspace: GROWTH }).result as Loose
    expect(titles(r)).not.toContain('growth-deleted')
  })

  it('a membership removed mid-conversation takes effect on the next call', () => {
    getDb().prepare('INSERT INTO user_workspaces (user_id, workspace, role) VALUES (?, ?, \'member\')').run(BOB, GROWTH)
    getDb().prepare('INSERT INTO objective_assignees (objective_id, user_id) VALUES (?, ?)').run(ids['growth-review-1'], BOB)
    expect(titles(runTool(ctx(BOB), 'list_objectives', { workspace: GROWTH }).result)).toEqual(['growth-review-1'])
    getDb().prepare('DELETE FROM user_workspaces WHERE user_id = ? AND workspace = ?').run(BOB, GROWTH)
    expect(() => runTool(ctx(BOB), 'list_objectives', { workspace: GROWTH })).toThrow(/can't see/)
  })
})

describe('chat get_objective reads any card the person can see', () => {
  it('opens a board card the chat did not file', () => {
    const r = runTool(ctx(ALICE), 'get_objective', { id: ids['growth-review-2'] })
    expect(r.result).toMatchObject({ id: ids['growth-review-2'], status: 'review', workspace: GROWTH, ai_review_verdict: 'fail' })
    expect(r.objective_id).toBe(ids['growth-review-2'])
  })

  it('refuses another workspace\'s card with the same words as a missing one', () => {
    expect(() => runTool(ctx(ALICE), 'get_objective', { id: ids['other-review-SECRET'] })).toThrow(/is not on a board you can see/)
    expect(() => runTool(ctx(ALICE), 'get_objective', { id: 99_999_999 })).toThrow(/is not on a board you can see/)
    expect(() => runTool(ctx(CAROL), 'get_objective', { id: ids['growth-review-1'] })).toThrow(/is not on a board you can see/)
    expect(() => runTool(ctx(ALICE), 'get_objective', { id: ids['growth-deleted'] })).toThrow(/is not on a board you can see/)
  })
})

describe('chat board_briefing: what is waiting on me', () => {
  it('is available to any agent that already lists a board read, and to nobody else', () => {
    expect(toolSpecsFor(agent).map(s => s.function.name)).toContain('board_briefing')
    const noBoard: Agent = { ...agent, slug: 'librarian', tools: ['search'] }
    expect(toolSpecsFor(noBoard).map(s => s.function.name)).not.toContain('board_briefing')
    expect(() => runTool(ctx(ALICE, noBoard), 'board_briefing', {})).toThrow(/not allowed/)
    // Implying a read never implies a write.
    expect(toolSpecsFor(agent).map(s => s.function.name)).not.toContain('create_objective')
  })

  it('lists the cards waiting on the person in their workspace, failed review first', () => {
    const r = runTool(ctx(ALICE), 'board_briefing', {}).result as Loose
    expect(r.empty).toBe(false)
    expect(r.open_total).toBe(4)
    expect(r.columns).toEqual({ review: 2, queue: 1, working: 1, blocked: 1 })
    const waiting = r.waiting_on_you as Loose[]
    expect(waiting.map(i => i.kind)).toEqual(['failed_review', 'blocked', 'review'])
    expect(waiting.map(i => i.id).sort()).toEqual([ids['growth-review-1'], ids['growth-review-2'], ids['growth-working-blocked']].sort())
    expect(waiting[0].url).toBe(`/o/${ids['growth-review-2']}`)
    expect(JSON.stringify(r)).not.toMatch(/SECRET/)
  })

  it('stays inside the person\'s workspaces', () => {
    const bob = runTool(ctx(BOB), 'board_briefing', {}).result as Loose
    expect((bob.waiting_on_you as Loose[]).map(i => i.id)).toEqual([ids['other-review-SECRET']])
    expect(JSON.stringify(bob)).not.toMatch(/growth-/)
    expect(() => runTool(ctx(BOB), 'board_briefing', { workspace: GROWTH })).toThrow(/can't see/)
  })

  it('says empty only when the board is empty, and "nothing waiting" when it is not', () => {
    const quiet = runTool(ctx(ALICE), 'board_briefing', { workspace: EMPTY_WS }).result as Loose
    expect(quiet).toMatchObject({ empty: true, open_total: 0, waiting_on_you: [] })

    const carol = runTool(ctx(CAROL), 'board_briefing', {}).result as Loose
    expect(carol).toMatchObject({ empty: false, open_total: 1, waiting_on_you: [] })
    expect(carol.note).toMatch(/Nothing needs a decision right now, but 1 open card/)
  })
})

// obj 900745: Operation Kit Dev stalled on a fresh install — business/profile.md
// did not exist, read_file said only "does not exist", and the model answered
// "I don't have a profile for your business yet" instead of using the board.
describe('missing knowledge file → fallback to folders and board (obj 900745)', () => {
  const okDev: Agent = {
    ...agent,
    slug: 'operation-kit-dev',
    name: 'Operation Kit Dev',
    knowledge_folders: ['business', 'projects'],
    tools: ['search', 'list_folders', 'read_file', 'write_doc', 'create_objective', 'get_objective', 'list_objectives', 'board_briefing'],
  }

  it('the missing-profile error tells the bot how to fall back, naming only tools it has', () => {
    fs.mkdirSync(path.join(TMP_KB, 'projects'), { recursive: true })
    fs.writeFileSync(path.join(TMP_KB, 'projects', 'launch.md'), '# Spring launch\n')
    let msg = ''
    try {
      runTool(ctx(ALICE, okDev), 'read_file', { path: 'business/profile.md' })
    } catch (e) {
      expect(e).toBeInstanceOf(ToolUseError)
      msg = (e as Error).message
    }
    expect(msg).toMatch(/^File "business\/profile\.md" does not exist\./)
    expect(msg).toMatch(/do not stop/)
    expect(msg).toMatch(/list_folders/)
    expect(msg).toMatch(/search the knowledge folders/)
    expect(msg).toMatch(/board_briefing or list_objectives/)

    // …and the fallback it points at actually works in the same state.
    const folders = runTool(ctx(ALICE, okDev), 'list_folders', {}).result as Loose
    expect(folders.folders).toEqual(['business', 'projects'])
    const projects = runTool(ctx(ALICE, okDev), 'list_folders', { path: 'projects' }).result as Loose
    expect(projects.items).toEqual([{ name: 'launch.md', type: 'file' }])
    const brief = runTool(ctx(ALICE, okDev), 'board_briefing', {}).result as Loose
    expect(brief.empty).toBe(false)
    expect(brief.open_total).toBeGreaterThan(0)
  })

  it('a missing folder gets the same hint; a bot without board tools is not told to use them', () => {
    const notesOnly: Agent = { ...okDev, slug: 'notes-only', tools: ['read_file', 'list_folders'] }
    expect(() => runTool(ctx(ALICE, okDev), 'list_folders', { path: 'business' })).toThrow(/Folder "business" does not exist\. .*list_folders/)
    let msg = ''
    try { runTool(ctx(ALICE, notesOnly), 'read_file', { path: 'business/profile.md' }) } catch (e) { msg = (e as Error).message }
    expect(msg).toMatch(/list_folders/)
    expect(msg).not.toMatch(/board_briefing|list_objectives|search the knowledge/)
  })
})
