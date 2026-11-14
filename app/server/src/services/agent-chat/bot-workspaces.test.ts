// Per-bot workspace access list (obj 900797).
//
// Bots stay global; each bot has an explicit list of workspaces it may work in.
// Proves, through the real chat tools and DB:
//   - a bot added after the list shipped has NO workspace (fail-closed);
//   - the one-time seed keeps bots that already existed unrestricted, once;
//   - grant: the bot reaches exactly the granted workspaces — board reads,
//     card chips, create_objective, knowledge-base read/search/list — and
//     never wider than the person chatting;
//   - revoke: access ends on the next call, and the last revoke leaves the bot
//     with nothing (never back to unrestricted);
//   - denied cross-workspace access on every one of those surfaces;
//   - a High Agency wake for a non-granted workspace is refused at fire time,
//     and the refusal does not count toward auto-pause.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

process.env.JWT_SECRET = 'test-secret-bot-workspaces-xxxx'
const TMP_DB = path.join(os.tmpdir(), `cc-bot-workspaces-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB
const TMP_KB = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-bot-workspaces-kb-'))

const { initDb, getDb } = await import('../../db/index.js')
const { runTool, runChatTool, visibleCardStatuses, ToolUseError } = await import('./tools.js')
const {
  getBotWorkspaceAccess,
  grantBotWorkspace,
  revokeBotWorkspace,
  setBotWorkspaces,
  seedExistingBotsOnce,
  forgetBotWorkspaceAccess,
  botMayUseWorkspace,
  highAgencyFireRefusal,
  BotWorkspaceError,
  SEED_MARKER,
} = await import('./bot-workspaces.js')
const { workspaceFor, systemPromptFor } = await import('./engine.js')
const { classifyAiFireResult } = await import('../routine-auto-pause.js')
type Agent = import('./agent-defs.js').ChatAgent

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any

const ADMIN = 1
const ALICE = 2 // member of growth + other-co
const BOB = 3 // member of other-co only
const GROWTH = 'growth'
const OTHER = 'other-co'
const QUIET = 'quiet-co'

function bot(slug: string, extra: Partial<Agent> = {}): Agent {
  return {
    slug,
    name: `Bot ${slug}`,
    description: '',
    avatar: '',
    colour: 'blue',
    system_prompt: 'You help.',
    knowledge_folders: ['workspaces', 'shared'],
    tools: ['search', 'list_folders', 'read_file', 'write_doc', 'get_objective', 'list_objectives', 'board_briefing', 'create_objective', 'secrets'],
    model: null,
    provider: null,
    schedules: [],
    version: null,
    author: null,
    how_to_use: '',
    example_prompts: [],
    source: 'file',
    file: '/dev/null',
    ...extra,
  }
}

/** A chat context the way runTurn builds it: the chat workspace comes from workspaceFor(user, bot). */
function ctx(userId: number, a: Agent) {
  return { userId, username: `user${userId}`, workspace: workspaceFor(userId, a.slug), agent: a, kbRoot: TMP_KB, connectors: { mail: null, calendar: null } }
}

const ids: Record<string, number> = {}
/** A card owned by `owner`, also assigned to `alsoSeenBy` (members see their own cards). */
function card(key: string, workspace: string, status: string, owner: number, alsoSeenBy: number[] = []) {
  const db = getDb()
  const r = db
    .prepare(
      `INSERT INTO objectives (title, description, workspace, status, type, category, created_by, assigned_user_id, updated_at)
       VALUES (?, '', ?, ?, 'task', 'general', ?, ?, datetime('now'))`,
    )
    .run(key, workspace, status, owner, owner)
  ids[key] = Number(r.lastInsertRowid)
  for (const u of alsoSeenBy) db.prepare('INSERT INTO objective_assignees (objective_id, user_id) VALUES (?, ?)').run(ids[key], u)
}
const SEEDED = ['growth-review', 'growth-queue', 'other-review-SECRET']

function refused(fn: () => unknown, pattern: RegExp) {
  let err: unknown
  try { fn() } catch (e) { err = e }
  expect(err, 'expected the tool to refuse').toBeInstanceOf(ToolUseError)
  expect((err as Error).message).toMatch(pattern)
}

const titles = (r: Loose) => (r.cards as Loose[]).map(c => c.title).sort()

beforeAll(() => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
  const db = getDb()
  for (const [id, role] of [[ADMIN, 'admin'], [ALICE, 'member'], [BOB, 'member']] as const) {
    db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, 'x', ?)`).run(id, `user${id}`, role)
  }
  for (const ws of [GROWTH, OTHER, QUIET]) db.prepare(`INSERT OR IGNORE INTO workspaces (slug, name) VALUES (?, ?)`).run(ws, ws)
  db.prepare(`INSERT INTO user_workspaces (user_id, workspace, role, objective_visibility) VALUES (?, ?, 'member', 'all')`).run(ALICE, GROWTH)
  db.prepare(`INSERT INTO user_workspaces (user_id, workspace, role, objective_visibility) VALUES (?, ?, 'member', 'all')`).run(ALICE, OTHER)
  db.prepare(`INSERT INTO user_workspaces (user_id, workspace, role, objective_visibility) VALUES (?, ?, 'member', 'all')`).run(BOB, OTHER)

  card('growth-review', GROWTH, 'review', ALICE)
  card('growth-queue', GROWTH, 'queue', ALICE)
  card('other-review-SECRET', OTHER, 'review', BOB, [ALICE])

  // The knowledge base: one folder per workspace, plus shared notes in no workspace.
  for (const [rel, text] of [
    ['workspaces/growth/plan.md', 'growth plan: launch the pricing page'],
    ['workspaces/other-co/payroll.md', 'other-co payroll: launch numbers SECRET'],
    ['shared/handbook.md', 'handbook: how we launch things'],
  ]) {
    fs.mkdirSync(path.dirname(path.join(TMP_KB, rel)), { recursive: true })
    fs.writeFileSync(path.join(TMP_KB, rel), text)
  }
})

afterAll(() => {
  try { getDb().close() } catch { /* already closed */ }
  for (const s of ['', '-wal', '-shm']) { const f = `${TMP_DB}${s}`; if (fs.existsSync(f)) fs.unlinkSync(f) }
  fs.rmSync(TMP_KB, { recursive: true, force: true })
})

beforeEach(() => {
  const db = getDb()
  db.prepare('DELETE FROM agent_chat_bot_access').run()
  db.prepare('DELETE FROM agent_chat_bot_workspaces').run()
  db.prepare('DELETE FROM settings WHERE key = ?').run(SEED_MARKER)
  // Cards a test filed through create_objective do not leak into the next test.
  db.prepare(`DELETE FROM objectives WHERE title NOT IN (${SEEDED.map(() => '?').join(',')})`).run(...SEEDED)
})

describe('default: a bot with no access decision has no workspace (fail-closed)', () => {
  const cos = bot('new-cos')

  it('reads no board, files no card, uses no secret, and reads no workspace notes', () => {
    const a = getBotWorkspaceAccess(cos.slug)
    expect(a).toMatchObject({ mode: 'restricted', configured: false, workspaces: [] })
    expect(botMayUseWorkspace(cos.slug, GROWTH)).toBe(false)
    expect(workspaceFor(ALICE, cos.slug)).toBe('')
    expect(workspaceFor(ADMIN, cos.slug)).toBe('')

    const list = runTool(ctx(ALICE, cos), 'list_objectives', {}).result as Loose
    expect(list.empty).toBe(true)
    expect(list.cards).toEqual([])
    expect(list.note).toMatch(/not been granted any workspace/)
    refused(() => runTool(ctx(ALICE, cos), 'get_objective', { id: ids['growth-review'] }), /not on a board you can see/)
    refused(() => runTool(ctx(ADMIN, cos), 'get_objective', { id: ids['growth-review'] }), /not on a board you can see/)
    refused(() => runTool(ctx(ALICE, cos), 'create_objective', { title: 't', description: 'd' }), /no workspace it may work in/)
    refused(() => runTool(ctx(ALICE, cos), 'read_file', { path: 'workspaces/growth/plan.md' }), /growth workspace, which .* has no access/)
    // Shared notes in no workspace are still governed by knowledge_folders alone.
    expect((runTool(ctx(ALICE, cos), 'read_file', { path: 'shared/handbook.md' }).result as Loose).content).toMatch(/handbook/)
    const hits = (runTool(ctx(ALICE, cos), 'search', { q: 'launch' }).result as Loose).results.map((h: Loose) => h.path)
    expect(hits).toEqual(['shared/handbook.md'])
    expect(visibleCardStatuses(ALICE, [ids['growth-review'], ids['other-review-SECRET']], cos.slug)).toEqual([])
  })

  it('secrets refuse when the chat has no workspace', async () => {
    await expect(runChatTool(ctx(ALICE, cos), 'secrets_list', {})).rejects.toThrow(/no workspace it may work in/)
  })

  it('the system prompt says so instead of letting the model guess', () => {
    const c = ctx(ALICE, cos)
    expect(systemPromptFor(cos, { username: 'alice', now: new Date(), connectors: [], workspace: c.workspace })).toMatch(/no workspace you may work in/)
  })
})

describe('the one-time seed: bots that already existed keep today\'s access', () => {
  it('marks existing bots unrestricted once; a bot appearing later stays fail-closed', () => {
    expect(seedExistingBotsOnce(['old-cos', 'old-cfo'])).toBe(2)
    expect(seedExistingBotsOnce(['old-cos', 'brand-new'])).toBe(0) // the marker is set: never again
    expect(getBotWorkspaceAccess('old-cos')).toMatchObject({ mode: 'unrestricted', configured: true, workspaces: [] })
    expect(getBotWorkspaceAccess('brand-new')).toMatchObject({ mode: 'restricted', configured: false, workspaces: [] })
  })

  it('an unrestricted bot behaves exactly as before: the person\'s own view, no workspace granted', () => {
    seedExistingBotsOnce(['old-cos'])
    const old = bot('old-cos')
    expect(workspaceFor(ALICE, old.slug)).toBe(GROWTH)
    expect(titles(runTool(ctx(ALICE, old), 'list_objectives', {}).result)).toEqual(['growth-queue', 'growth-review', 'other-review-SECRET'])
    // Never wider than the person: Bob is only in other-co.
    expect(titles(runTool(ctx(BOB, old), 'list_objectives', {}).result)).toEqual(['other-review-SECRET'])
    expect((runTool(ctx(ALICE, old), 'read_file', { path: 'workspaces/other-co/payroll.md' }).result as Loose).content).toMatch(/payroll/)
    // create_objective's new workspace argument does not widen an unrestricted bot: chat workspace only, as before.
    refused(() => runTool(ctx(ALICE, old), 'create_objective', { title: 'x', description: 'x', workspace: OTHER }), /can't file cards in "other-co"/)
    const made = runTool(ctx(ALICE, old), 'create_objective', { title: 'Legacy card', description: 'x', workspace: GROWTH })
    expect((getDb().prepare('SELECT workspace FROM objectives WHERE id = ?').get(made.objective_id) as Loose).workspace).toBe(GROWTH)
  })

  it('an empty agent list never burns the one-time marker', () => {
    expect(seedExistingBotsOnce([])).toBe(0)
    expect(getDb().prepare('SELECT 1 FROM settings WHERE key = ?').get(SEED_MARKER)).toBeUndefined()
    expect(seedExistingBotsOnce(['old-cos'])).toBe(1)
  })
})

describe('grant: the bot reaches exactly the workspaces it is granted', () => {
  const cos = bot('cos')

  it('board reads, card chips and the briefing see only granted workspaces — even for an admin', () => {
    const g = grantBotWorkspace(cos.slug, GROWTH, 'admin')
    expect(g.changed).toBe(true)
    expect(g.access).toMatchObject({ mode: 'restricted', configured: true, workspaces: [GROWTH] })
    expect(g.access.grants[0]).toMatchObject({ workspace: GROWTH, granted_by: 'admin' })

    expect(titles(runTool(ctx(ALICE, cos), 'list_objectives', {}).result)).toEqual(['growth-queue', 'growth-review'])
    expect(titles(runTool(ctx(ADMIN, cos), 'list_objectives', {}).result)).toEqual(['growth-queue', 'growth-review'])
    expect((runTool(ctx(ALICE, cos), 'get_objective', { id: ids['growth-review'] }).result as Loose).workspace).toBe(GROWTH)
    const brief = runTool(ctx(ALICE, cos), 'board_briefing', {}).result as Loose
    expect(brief.workspaces).toEqual([GROWTH])
    expect(brief.waiting_on_you.map((i: Loose) => i.id)).not.toContain(ids['other-review-SECRET'])
    expect(visibleCardStatuses(ALICE, [ids['growth-review'], ids['other-review-SECRET']], cos.slug).map(c => c.id)).toEqual([ids['growth-review']])
  })

  it('denies the other workspace the person CAN see: board, card, chip, briefing', () => {
    grantBotWorkspace(cos.slug, GROWTH, 'admin')
    refused(() => runTool(ctx(ALICE, cos), 'list_objectives', { workspace: OTHER }), /can't see the "other-co" board from this chat/)
    refused(() => runTool(ctx(ADMIN, cos), 'list_objectives', { workspace: OTHER }), /can't see the "other-co" board/)
    refused(() => runTool(ctx(ALICE, cos), 'board_briefing', { workspace: OTHER }), /can't see the "other-co" board/)
    refused(() => runTool(ctx(ALICE, cos), 'get_objective', { id: ids['other-review-SECRET'] }), /not on a board you can see/)
    refused(() => runTool(ctx(ADMIN, cos), 'get_objective', { id: ids['other-review-SECRET'] }), /not on a board you can see/)
  })

  it('create_objective files in the granted workspace and refuses any other', () => {
    grantBotWorkspace(cos.slug, GROWTH, 'admin')
    const c = ctx(ALICE, cos)
    expect(c.workspace).toBe(GROWTH)
    const made = runTool(c, 'create_objective', { title: 'Draft the pricing page', description: 'x' })
    const row = getDb().prepare('SELECT workspace FROM objectives WHERE id = ?').get(made.objective_id) as Loose
    expect(row.workspace).toBe(GROWTH)
    refused(() => runTool(c, 'create_objective', { title: 'Sneak', description: 'x', workspace: OTHER }), /can't file cards in "other-co"/)
    refused(() => runTool(c, 'create_objective', { title: 'Sneak', description: 'x', workspace: 'no-such-ws' }), /can't file cards in "no-such-ws"/)
    const sneaks = getDb().prepare("SELECT COUNT(*) AS n FROM objectives WHERE title = 'Sneak'").get() as Loose
    expect(sneaks.n).toBe(0)
  })

  it('knowledge base: granted workspace notes are readable; another workspace\'s are not — read, write, search, list', () => {
    grantBotWorkspace(cos.slug, GROWTH, 'admin')
    const c = ctx(ALICE, cos)
    expect((runTool(c, 'read_file', { path: 'workspaces/growth/plan.md' }).result as Loose).content).toMatch(/growth plan/)
    refused(() => runTool(c, 'read_file', { path: 'workspaces/other-co/payroll.md' }), /other-co workspace, which .* has no access/)
    refused(() => runTool(c, 'write_doc', { path: 'workspaces/other-co/pwned.md', content: 'x' }), /other-co workspace/)
    expect(fs.existsSync(path.join(TMP_KB, 'workspaces/other-co/pwned.md'))).toBe(false)
    // Traversal through a granted folder does not get around the wall.
    refused(() => runTool(c, 'read_file', { path: 'workspaces/growth/../other-co/payroll.md' }), /other-co workspace/)
    const hits = (runTool(c, 'search', { q: 'launch' }).result as Loose).results.map((h: Loose) => h.path).sort()
    expect(hits).toEqual(['shared/handbook.md', 'workspaces/growth/plan.md'])
    const listed = (runTool(c, 'list_folders', { path: 'workspaces' }).result as Loose).items.map((i: Loose) => i.name)
    expect(listed).toEqual([GROWTH])
  })

  it('a symlink inside a granted folder that points into another workspace is refused', () => {
    grantBotWorkspace(cos.slug, GROWTH, 'admin')
    const link = path.join(TMP_KB, 'workspaces/growth/leak.md')
    try { fs.symlinkSync(path.join(TMP_KB, 'workspaces/other-co/payroll.md'), link) } catch { return /* no symlinks on this fs */ }
    try {
      refused(() => runTool(ctx(ALICE, cos), 'read_file', { path: 'workspaces/growth/leak.md' }), /other-co workspace/)
    } finally {
      fs.rmSync(link, { force: true })
    }
  })

  it('a workspace whose vault_path is the whole knowledge base does not wall off everything; the deepest folder decides', () => {
    const db = getDb()
    db.prepare(`INSERT OR IGNORE INTO workspaces (slug, name, vault_path) VALUES ('everything', 'Everything', ?)`).run(TMP_KB)
    // A workspace whose notes live INSIDE the growth folder, not granted.
    fs.mkdirSync(path.join(TMP_KB, 'workspaces/growth/nested-co'), { recursive: true })
    fs.writeFileSync(path.join(TMP_KB, 'workspaces/growth/nested-co/deal.md'), 'nested deal')
    db.prepare(`INSERT OR IGNORE INTO workspaces (slug, name, vault_path) VALUES ('nested-co', 'Nested', ?)`).run(path.join(TMP_KB, 'workspaces/growth/nested-co'))
    try {
      grantBotWorkspace(cos.slug, GROWTH, 'admin')
      const c = ctx(ALICE, cos)
      expect((runTool(c, 'read_file', { path: 'shared/handbook.md' }).result as Loose).content).toMatch(/handbook/)
      expect((runTool(c, 'read_file', { path: 'workspaces/growth/plan.md' }).result as Loose).content).toMatch(/growth plan/)
      refused(() => runTool(c, 'read_file', { path: 'workspaces/other-co/payroll.md' }), /other-co workspace/)
      refused(() => runTool(c, 'read_file', { path: 'workspaces/growth/nested-co/deal.md' }), /nested-co workspace/)
    } finally {
      db.prepare(`DELETE FROM workspaces WHERE slug IN ('everything', 'nested-co')`).run()
      fs.rmSync(path.join(TMP_KB, 'workspaces/growth/nested-co'), { recursive: true, force: true })
    }
  })

  it('never wider than the person: a granted workspace the person is not in stays invisible', () => {
    setBotWorkspaces(cos.slug, [GROWTH, OTHER], 'admin')
    expect(titles(runTool(ctx(BOB, cos), 'list_objectives', {}).result)).toEqual(['other-review-SECRET'])
    refused(() => runTool(ctx(BOB, cos), 'get_objective', { id: ids['growth-review'] }), /not on a board you can see/)
    refused(() => runTool(ctx(BOB, cos), 'create_objective', { title: 'x', description: 'x', workspace: GROWTH }), /can't file cards in "growth"/)
    expect(workspaceFor(BOB, cos.slug)).toBe(OTHER)
    expect(workspaceFor(ALICE, cos.slug)).toBe(GROWTH)
    // The knowledge base follows the same rule: Bob is not in growth.
    refused(() => runTool(ctx(BOB, cos), 'read_file', { path: 'workspaces/growth/plan.md' }), /growth workspace/)
    const bobHits = (runTool(ctx(BOB, cos), 'search', { q: 'launch' }).result as Loose).results.map((h: Loose) => h.path).sort()
    expect(bobHits).toEqual(['shared/handbook.md', 'workspaces/other-co/payroll.md'])
    // …and the system prompt only names workspaces Bob can see.
    const prompt = systemPromptFor(cos, { username: 'bob', now: new Date(), connectors: [], workspace: workspaceFor(BOB, cos.slug), userId: BOB })
    expect(prompt).toContain('You may only work in these workspaces: other-co.')
    expect(prompt).not.toContain(GROWTH)
  })

  it('granting to an unrestricted bot restricts it to the granted list', () => {
    seedExistingBotsOnce(['old-cos'])
    const old = bot('old-cos')
    const g = grantBotWorkspace(old.slug, OTHER, 'admin')
    expect(g.restrictedNow).toBe(true)
    expect(getBotWorkspaceAccess(old.slug)).toMatchObject({ mode: 'restricted', workspaces: [OTHER] })
    expect(titles(runTool(ctx(ALICE, old), 'list_objectives', {}).result)).toEqual(['other-review-SECRET'])
    expect(workspaceFor(ALICE, old.slug)).toBe(OTHER)
  })

  it('refuses a workspace that does not exist or is not a slug; granting twice is a no-op', () => {
    expect(() => grantBotWorkspace(cos.slug, 'nope', 'admin')).toThrow(BotWorkspaceError)
    expect(() => grantBotWorkspace(cos.slug, '../etc', 'admin')).toThrow(/workspace slug/)
    expect(() => setBotWorkspaces(cos.slug, 'growth', 'admin')).toThrow(/list/)
    expect(grantBotWorkspace(cos.slug, GROWTH, 'admin').changed).toBe(true)
    expect(grantBotWorkspace(cos.slug, GROWTH, 'admin').changed).toBe(false)
  })
})

describe('revoke: access ends on the next call', () => {
  const cos = bot('cos')

  it('a revoked workspace disappears from board, cards, KB and the chat workspace', () => {
    setBotWorkspaces(cos.slug, [GROWTH, OTHER], 'admin')
    expect(titles(runTool(ctx(ALICE, cos), 'list_objectives', {}).result)).toEqual(['growth-queue', 'growth-review', 'other-review-SECRET'])

    const r = revokeBotWorkspace(cos.slug, GROWTH, 'admin')
    expect(r.changed).toBe(true)
    expect(r.access.workspaces).toEqual([OTHER])
    expect(titles(runTool(ctx(ALICE, cos), 'list_objectives', {}).result)).toEqual(['other-review-SECRET'])
    refused(() => runTool(ctx(ALICE, cos), 'get_objective', { id: ids['growth-review'] }), /not on a board you can see/)
    refused(() => runTool(ctx(ALICE, cos), 'read_file', { path: 'workspaces/growth/plan.md' }), /growth workspace/)
    expect(workspaceFor(ALICE, cos.slug)).toBe(OTHER)
  })

  it('revoking the last workspace leaves NO access — never falls back to unrestricted', () => {
    grantBotWorkspace(cos.slug, GROWTH, 'admin')
    revokeBotWorkspace(cos.slug, GROWTH, 'admin')
    expect(getBotWorkspaceAccess(cos.slug)).toMatchObject({ mode: 'restricted', configured: true, workspaces: [] })
    expect((runTool(ctx(ALICE, cos), 'list_objectives', {}).result as Loose).cards).toEqual([])
    expect(workspaceFor(ALICE, cos.slug)).toBe('')
  })

  it('revoking from an unrestricted bot is refused (grant its list first)', () => {
    seedExistingBotsOnce(['old-cos'])
    expect(() => revokeBotWorkspace('old-cos', GROWTH, 'admin')).toThrow(/not restricted yet/)
    expect(getBotWorkspaceAccess('old-cos').mode).toBe('unrestricted')
  })

  it('a deleted workspace is not access to anything', () => {
    getDb().prepare(`INSERT OR IGNORE INTO workspaces (slug, name) VALUES ('temp-ws', 'Temp')`).run()
    grantBotWorkspace(cos.slug, 'temp-ws', 'admin')
    getDb().prepare(`DELETE FROM workspaces WHERE slug = 'temp-ws'`).run()
    expect(getBotWorkspaceAccess(cos.slug).workspaces).toEqual([])
    expect(botMayUseWorkspace(cos.slug, 'temp-ws')).toBe(false)
  })

  it('a deleted bot loses its list: a bot that reuses the slug starts with no workspace', () => {
    seedExistingBotsOnce(['gone-bot'])
    grantBotWorkspace(cos.slug, GROWTH, 'admin')
    forgetBotWorkspaceAccess(cos.slug)
    forgetBotWorkspaceAccess('gone-bot')
    expect(getBotWorkspaceAccess(cos.slug)).toMatchObject({ mode: 'restricted', configured: false, workspaces: [] })
    expect(getBotWorkspaceAccess('gone-bot')).toMatchObject({ mode: 'restricted', workspaces: [] })
    expect(botMayUseWorkspace(cos.slug, GROWTH)).toBe(false)
    expect((runTool(ctx(ALICE, cos), 'list_objectives', {}).result as Loose).cards).toEqual([])
  })
})

describe('High Agency wakes: the fire-time guard', () => {
  const routine = (slug: string, ws: string | null) => ({ name: `high-agency:${slug}`, objective_template: JSON.stringify(ws ? { title: 'wake', workspace: ws } : { title: 'wake' }) })

  it('refuses a wake for a workspace the bot is not granted, allows a granted one', () => {
    grantBotWorkspace('cos', GROWTH, 'admin')
    expect(highAgencyFireRefusal(routine('cos', GROWTH))).toBeNull()
    const why = highAgencyFireRefusal(routine('cos', OTHER))
    expect(why).toMatch(/^bot workspace guard: bot "cos" is not granted workspace "other-co"/)
    expect(highAgencyFireRefusal(routine('fresh-bot', GROWTH))).toMatch(/^bot workspace guard/)
    expect(highAgencyFireRefusal(routine('cos', null))).toMatch(/has no workspace/)
    // A refusal by policy — nothing ran — never counts toward the K-failure auto-pause.
    expect(classifyAiFireResult({ ok: false, reason: why! })).toBe('neutral')
  })

  it('leaves unrestricted bots and every other routine alone', () => {
    seedExistingBotsOnce(['old-cos'])
    expect(highAgencyFireRefusal(routine('old-cos', OTHER))).toBeNull()
    expect(highAgencyFireRefusal({ name: 'nightly-report', objective_template: '{"workspace":"other-co"}' })).toBeNull()
    expect(highAgencyFireRefusal({ name: 'agent:cos:daily', objective_template: '{"workspace":"other-co"}' })).toBeNull()
  })
})
