import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'
import cookieParser from 'cookie-parser'
import jwt from 'jsonwebtoken'

// SAFETY: temp DB bound before db/index is imported, so this never touches the
// live board. The MCP router is mounted next to the REAL REST routers it
// forwards to, behind the real agentKeyGuard — every tool call below goes
// MCP → loopback → guard → REST route, exactly as in index.ts.
const TMP_DB = path.join(os.tmpdir(), `cc-agent-mcp-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB
process.env.JWT_SECRET = 'test-secret-agent-mcp-xxxx'

// Isolated vault fixture — never point this test at the real second-brain.
const TMP_VAULT = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-agent-mcp-vault-'))
const TMP_UPLOADS = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-agent-mcp-uploads-'))
process.env.CC_FILE_ROOTS = JSON.stringify([{ id: 'vault', path: TMP_VAULT, kind: 'vault' }])
process.env.CC_FILE_SHARED_PATHS = ''
process.env.SECOND_BRAIN_ROOT = TMP_VAULT
// Built-in chat agents (obj 719987): one agent file in an isolated agents dir.
const TMP_AGENTS = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-agent-mcp-agents-'))
fs.mkdirSync(path.join(TMP_AGENTS, 'librarian'))
fs.writeFileSync(path.join(TMP_AGENTS, 'librarian', 'agent.yaml'), 'name: Librarian\nsystem_prompt: You organise the knowledge base.\nknowledge_folders: [team]\ntools: [search, read_file]\n')
process.env.AGENT_FILES_DIR = TMP_AGENTS

const { initDb, getDb } = await import('../db/index.js')
const { issueApiKey } = await import('../lib/api-keys.js')
const { createAgentKey } = await import('../lib/agent-keys.js')
const { agentKeyGuard } = await import('../middleware/agent-key-guard.js')
const { invalidateWorkspacesCache } = await import('../services/workspaces.js')
const { default: authRouter } = await import('./auth.js')
const { default: objectivesRouter } = await import('./objectives.js')
const { default: objectivesSearchRouter } = await import('./objectives-search.js')
const { default: docsRouter } = await import('./docs.js')
const { default: filesRouter } = await import('./files.js')
const { default: workspacesRouter } = await import('./workspaces.js')
const { default: agentsRouter } = await import('./agents.js')
const { default: briefingRouter } = await import('./briefing.js')
const { default: agentControlRouter } = await import('./agent-control.js')
const { default: agentChatRouter } = await import('./agent-chat.js')
const { default: agentMcpRouter, MCP_TOOLS, ToolError, patchStatus, cardUrl } = await import('./agent-mcp.js')
const { AGENT_DISCOVERY } = await import('../api/agent-openapi.js')

const ADMIN_ID = 1
const MEMBER_ID = 2
const WS = 'example'
const OTHER_WS = 'example2'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any

let server: http.Server
let baseUrl: string
/** Legacy per-user key — what the knowledge connector was first set up with. */
let memberKey: string
const adminJwt = () => jwt.sign({ id: ADMIN_ID, username: 'admin', role: 'admin' }, process.env.JWT_SECRET as string, { expiresIn: '1h' })

/** The obj 716490 contract: these names must never disappear or change shape. */
const KNOWLEDGE_TOOLS = ['search', 'search_files', 'list_folders', 'read_file', 'get_card', 'search_cards']
// obj 719987: the built-in chat agents, readable from any MCP client.
const CHAT_AGENT_TOOLS = ['list_chat_agents', 'get_chat_agent']
const BOARD_TOOLS = [
  'board_briefing', 'get_attention', 'get_seat_pool', 'get_changes', 'list_objectives', 'search_objectives', 'get_objective',
  'create_objective', 'update_objective', 'update_status', 'start_objective', 'send_message', 'get_output',
  'get_progress', 'get_artifacts', 'stop_objective', 'list_workspaces', 'list_agents', 'whoami',
  'list_secret_requests', 'fulfill_secret_request',
]

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

const statusOf = (id: number) => (getDb().prepare('SELECT status FROM objectives WHERE id = ?').get(id) as { status: string }).status

beforeAll(async () => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
  const ins = getDb().prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, 'x', ?)`)
  ins.run(ADMIN_ID, 'admin', 'admin')
  ins.run(MEMBER_ID, 'grokbot', 'member')
  getDb().prepare(`INSERT INTO user_workspaces (user_id, workspace, role) VALUES (?, ?, 'member')`).run(MEMBER_ID, WS)
  memberKey = issueApiKey(MEMBER_ID).token

  // Doc fixture under the member's workspace folder (docs.ts scopes members to workspaces/<slug>).
  const wsDocDir = path.join(TMP_VAULT, 'workspaces', WS)
  fs.mkdirSync(wsDocDir, { recursive: true })
  fs.mkdirSync(path.join(TMP_VAULT, 'workspaces', OTHER_WS), { recursive: true })
  fs.writeFileSync(path.join(wsDocDir, 'active.md'), '# Active\n\nThe rotation-home onboarding doc lives here.\n')
  fs.writeFileSync(path.join(TMP_VAULT, 'workspaces', OTHER_WS, 'pasture.pptx'), Buffer.from('example2-deck'))

  // The 'example' workspace row is DB-seeded at migration time with real
  // /home/operator/second-brain doc roots. Repoint it at the temp vault fixture
  // so docs.ts getDocRoots() resolves inside TMP_VAULT for this test process.
  getDb().prepare('UPDATE workspaces SET doc_read_roots = ?, doc_write_roots = ? WHERE slug = ?')
    .run(JSON.stringify([wsDocDir]), JSON.stringify([wsDocDir]), WS)
  invalidateWorkspacesCache()

  // Non-markdown file fixture (PR #533 files API).
  const deckPath = path.join(wsDocDir, 'deck.pptx')
  fs.writeFileSync(deckPath, Buffer.from('fake-pptx-bytes'))

  const insId = getDb().prepare(
    `INSERT INTO objectives (title, description, status, workspace, agent_context, created_by) VALUES (?, ?, 'queue', ?, 'cto', ?)`,
  ).run('Fixture card', 'a description with the word rotation-home in it', WS, MEMBER_ID)
  const cardId = Number(insId.lastInsertRowid)

  const app = express()
  app.set('trust proxy', true)
  app.use(express.json())
  app.use(cookieParser())
  app.use(agentKeyGuard)
  app.use('/api/auth', authRouter)
  app.use('/api/objectives/search', objectivesSearchRouter)
  app.use('/api/objectives', objectivesRouter)
  app.use('/api/docs', docsRouter)
  app.use('/api/files', filesRouter)
  app.use('/api', agentMcpRouter)
  app.use('/api/briefing', briefingRouter)
  app.use('/api/workspaces', workspacesRouter)
  app.use('/api/agents', agentsRouter)
  app.use('/api/agent', agentControlRouter)
  app.use('/api/agent-chat', agentChatRouter)
  await new Promise<void>(r => { server = app.listen(0, '127.0.0.1', () => r()) })
  const addr = server.address(); if (!addr || typeof addr === 'string') throw new Error('no address')
  baseUrl = `http://127.0.0.1:${addr.port}`
  ;(globalThis as Loose).__fixtureCardId = cardId
  ;(globalThis as Loose).__docPath = path.join(wsDocDir, 'active.md')
  ;(globalThis as Loose).__filePath = deckPath
})

afterAll(async () => {
  await new Promise<void>(r => server.close(() => r()))
  try { getDb().close() } catch {}
  for (const s of ['', '-wal', '-shm']) { const f = `${TMP_DB}${s}`; if (fs.existsSync(f)) fs.unlinkSync(f) }
  fs.rmSync(TMP_VAULT, { recursive: true, force: true })
  fs.rmSync(TMP_UPLOADS, { recursive: true, force: true })
})

let nextId = 1
async function rpc(method: string, params: unknown, auth: string | null = memberKey, extra: Record<string, string> = {}) {
  const res = await fetch(`${baseUrl}/api/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
      ...extra,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
  })
  const text = await res.text()
  return { status: res.status, headers: res.headers, json: text ? JSON.parse(text) : null }
}

async function callTool(name: string, args: Record<string, unknown> = {}, auth: string | null = memberKey) {
  const r = await rpc('tools/call', { name, arguments: args }, auth)
  expect(r.status).toBe(200)
  const result = r.json.result as { content: { type: string; text: string }[]; isError?: boolean; structuredContent?: Loose }
  return { result, data: result.isError ? null : JSON.parse(result.content[0].text) }
}

async function listToolNames(auth: string): Promise<string[]> {
  const r = await rpc('tools/list', {}, auth)
  expect(r.status).toBe(200)
  return (r.json.result.tools as { name: string }[]).map(t => t.name)
}

describe('MCP handshake', () => {
  it('initialize negotiates the protocol, keeps the connector name, and teaches the read-before-write loop', async () => {
    const r = await rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'vitest', version: '0' },
    })
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toMatch(/application\/json/)
    expect(r.json.jsonrpc).toBe('2.0')
    expect(r.json.result.protocolVersion).toBe('2025-06-18')
    expect(r.json.result.capabilities.tools).toBeDefined()
    // Same server name the Grok Bot connector registered under (obj 716490).
    expect(r.json.result.serverInfo.name).toBe('command-center-knowledge')
    const instr = r.json.result.instructions as string
    expect(instr).toMatch(/READ BEFORE YOU WRITE/)
    expect(instr).toMatch(/get_attention.*get_changes/)
    expect(instr).toMatch(/HUMAN SIGNATURE/)
    // A legacy-key caller is told up front that writes need a named key.
    expect(instr).toMatch(/LEGACY KEY/)
  })

  it('answers an unknown protocol version with the newest supported one', async () => {
    const r = await rpc('initialize', { protocolVersion: '1999-01-01', capabilities: {}, clientInfo: { name: 'x', version: '0' } })
    expect(r.json.result.protocolVersion).toBe('2025-11-25')
  })

  it('notifications/initialized is accepted with 202 and no body', async () => {
    const res = await fetch(`${baseUrl}/api/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${memberKey}` },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    })
    expect(res.status).toBe(202)
    expect(await res.text()).toBe('')
  })

  it('tools/list includes every knowledge tool AND every board tool, with object schemas', async () => {
    const full = mint('grok-full', ['board:read', 'board:write', 'board:start', 'board:cancel', 'vault:read', 'vault:write', 'board:secrets_request'])
    const r = await rpc('tools/list', {}, full.token)
    const tools = r.json.result.tools as { name: string; description: string; inputSchema: { type: string; required?: string[] }; annotations: Loose }[]
    const names = tools.map(t => t.name)
    for (const t of [...KNOWLEDGE_TOOLS, ...BOARD_TOOLS, ...CHAT_AGENT_TOOLS]) expect(names, t).toContain(t)
    for (const t of tools) expect(t.inputSchema.type).toBe('object')
    // Knowledge tools stay read-only annotated, as they were.
    for (const t of KNOWLEDGE_TOOLS) expect(tools.find(x => x.name === t)!.annotations.readOnlyHint, t).toBe(true)
    expect(tools.find(t => t.name === 'create_objective')!.inputSchema.required).toEqual(['title', 'workspace'])
    expect(tools.find(t => t.name === 'update_status')!.description).toMatch(/HUMAN SIGNATURE/)
  })

  it('tools/list hides tools a named key has no scope for (the guard stays the authority)', async () => {
    const reader = mint('grok-reader', ['board:read'])
    const names = await listToolNames(reader.token)
    expect(names).toContain('get_attention')
    expect(names).toContain('whoami')
    expect(names).not.toContain('create_objective')
    expect(names).not.toContain('start_objective')
    expect(names).not.toContain('search') // vault:read
  })

  it('unknown method → JSON-RPC -32601; ping → {}', async () => {
    expect((await rpc('resources/subscribe', {})).json.error.code).toBe(-32601)
    expect((await rpc('ping', {})).json.result).toEqual({})
  })

  it('GET is 405 (stateless: no SSE stream)', async () => {
    const res = await fetch(`${baseUrl}/api/mcp`, { headers: { Authorization: `Bearer ${memberKey}` } })
    expect(res.status).toBe(405)
  })
})

describe('MCP auth', () => {
  it('unauthenticated request → 401 with WWW-Authenticate: Bearer', async () => {
    const r = await rpc('tools/list', {}, null)
    expect(r.status).toBe(401)
    expect(r.headers.get('www-authenticate')).toMatch(/^Bearer/)
  })

  it('a bad key → 401; a cookie alone is not accepted', async () => {
    expect((await rpc('tools/list', {}, 'cc_live_not-a-real-key')).status).toBe(401)
    const cookieOnly = await rpc('tools/list', {}, null, { Cookie: `token=${adminJwt()}` })
    expect(cookieOnly.status).toBe(401)
  })

  it('cc_live_ legacy key, named agent key and JWT all authenticate', async () => {
    expect((await rpc('tools/list', {}, memberKey)).status).toBe(200)
    expect((await rpc('tools/list', {}, mint('grok-auth').token)).status).toBe(200)
    expect((await rpc('tools/list', {}, adminJwt())).status).toBe(200)
  })

  it('a foreign browser Origin is refused (DNS-rebinding guard)', async () => {
    const r = await rpc('tools/list', {}, memberKey, { Origin: 'https://evil.example' })
    expect(r.status).toBe(403)
  })
})

describe('knowledge tools are unchanged (obj 716490 contract, legacy key)', () => {
  it('search finds the vault doc fixture', async () => {
    const { data } = await callTool('search', { q: 'rotation-home' })
    expect(data.results.length).toBeGreaterThan(0)
    expect(data.results[0].path).toBe((globalThis as Loose).__docPath)
  })

  it('list_folders returns the workspace doc tree', async () => {
    const { data } = await callTool('list_folders', {})
    expect(data.root).toBeDefined()
    expect(JSON.stringify(data.tree)).toMatch(/active\.md/)
  })

  it('read_file reads a markdown doc as plain text', async () => {
    const { data } = await callTool('read_file', { path: (globalThis as Loose).__docPath })
    expect(data.encoding).toBe('utf8')
    expect(data.content).toMatch(/Active/)
  })

  it('search_files finds the non-markdown fixture', async () => {
    const { data } = await callTool('search_files', { q: 'deck' })
    expect(data.results.some((r: { path: string }) => r.path === (globalThis as Loose).__filePath)).toBe(true)
  })

  it('read_file reads a non-markdown file via files/stat+download, base64-encoded', async () => {
    const { data } = await callTool('read_file', { path: (globalThis as Loose).__filePath })
    expect(data.encoding).toBe('base64')
    expect(Buffer.from(data.content, 'base64').toString('utf8')).toBe('fake-pptx-bytes')
  })

  it('get_card returns the full fixture card; get_objective (canonical) returns the same card', async () => {
    const id = (globalThis as Loose).__fixtureCardId
    const { data } = await callTool('get_card', { id })
    expect(data).toMatchObject({ id, title: 'Fixture card' })
    const canonical = await callTool('get_objective', { id })
    expect(canonical.data).toEqual(data)
  })

  it('search_cards finds the fixture card by keyword; search_objectives is the same search', async () => {
    const { data } = await callTool('search_cards', { q: 'Fixture' })
    expect(data.results.some((r: { id: number }) => r.id === (globalThis as Loose).__fixtureCardId)).toBe(true)
    const canonical = await callTool('search_objectives', { q: 'Fixture' })
    expect(canonical.data).toEqual(data)
  })

  it('existing REST workspace gate applies: a workspace the member is not in is refused', async () => {
    const { result } = await callTool('search_files', { q: 'deck', workspace: OTHER_WS })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toMatch(/^Error 403/)
  })

  it('a path outside the member\'s doc roots is refused', async () => {
    const { result } = await callTool('read_file', { path: '/etc/passwd.md' })
    expect(result.isError).toBe(true)
  })

  it('the legacy key is read-only over MCP: write tools are refused before anything is forwarded', async () => {
    const before = (getDb().prepare('SELECT COUNT(*) AS n FROM objectives').get() as { n: number }).n
    const { result } = await callTool('create_objective', { title: 'legacy write', workspace: WS, type: 'task' })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toMatch(/legacy full-access key/)
    expect((getDb().prepare('SELECT COUNT(*) AS n FROM objectives').get() as { n: number }).n).toBe(before)
    const id = (globalThis as Loose).__fixtureCardId
    const done = await callTool('update_status', { id, status: 'done' })
    expect(done.result.isError).toBe(true)
    expect(statusOf(id)).toBe('queue')
  })
})

describe('board tools through a named agent key', () => {
  it('create_objective requires workspace — no silent example default', async () => {
    const bot = mint('grok-cos')
    const before = (getDb().prepare('SELECT COUNT(*) AS n FROM objectives').get() as { n: number }).n
    const { result } = await callTool('create_objective', { title: 'no workspace', type: 'task' }, bot.token)
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toMatch(/workspace is required/)
    expect((getDb().prepare('SELECT COUNT(*) AS n FROM objectives').get() as { n: number }).n).toBe(before)
  })

  it('create_objective rejects an unknown workspace with the valid slugs', async () => {
    const bot = mint('grok-typo')
    const { result } = await callTool('create_objective', { title: 'typo', workspace: 'axai', type: 'task' }, bot.token)
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toMatch(/Unknown or inaccessible workspace 'axai'.*example/)
  })

  it('create_objective lands in the workspace it was given and returns a receipt with id + card url', async () => {
    const bot = mint('grok-example2-create')
    const { result, data } = await callTool('create_objective', {
      title: 'Pasture rotation report', workspace: OTHER_WS, type: 'task', description: 'from MCP', idempotency_key: 'example2-1',
    }, bot.token)
    expect(result.isError).toBeFalsy()
    expect(data.workspace).toBe(OTHER_WS)
    expect(data.url).toBe(cardUrl(data.id))
    expect(data.confirmation).toMatch(new RegExp(`^Created #${data.id} "Pasture rotation report" in ${OTHER_WS}`))
    const row = getDb().prepare('SELECT workspace, status, origin, agent_key_label FROM objectives WHERE id = ?').get(data.id)
    expect(row).toEqual({ workspace: OTHER_WS, status: 'queue', origin: 'agent_api', agent_key_label: 'grok-example2-create' })
  })

  it('idempotent create: the same idempotency_key returns the original card, not a second one', async () => {
    const bot = mint('grok-idem')
    const args = { title: 'Idempotent card', workspace: WS, type: 'task', idempotency_key: 'mcp-idem-1' }
    const first = await callTool('create_objective', args, bot.token)
    const retry = await callTool('create_objective', args, bot.token)
    expect(retry.result.isError).toBeFalsy()
    expect(retry.data.id).toBe(first.data.id)
    expect((getDb().prepare(`SELECT COUNT(*) AS n FROM objectives WHERE title = 'Idempotent card'`).get() as { n: number }).n).toBe(1)
  })

  it('a key without board:done cannot set done via MCP (same missing_scope as REST); it can cancel a duplicate', async () => {
    const bot = mint('grok-default') // default scopes: no board:done
    const id = seed(WS, 'review', 'awaiting Mike')
    const done = await callTool('update_status', { id, status: 'done' }, bot.token)
    expect(done.result.isError).toBe(true)
    expect(done.result.structuredContent.missing_scope).toBe('board:done')
    expect(statusOf(id)).toBe('review')

    const dup = seed(WS, 'queue', 'duplicate card')
    const cancel = await callTool('update_status', { id: dup, status: 'cancelled' }, bot.token)
    expect(cancel.result.isError).toBeFalsy()
    expect(cancel.data.confirmation).toBe(`Moved #${dup} to cancelled.`)
    expect(statusOf(dup)).toBe('cancelled')
  })

  it('a workspace-pinned key cannot touch another workspace through any board tool', async () => {
    const pinned = mint('grok-example', undefined, [WS])
    const theirs = seed(OTHER_WS, 'review', 'example2 card')
    for (const [tool, args] of [
      ['get_objective', { id: theirs }],
      ['get_progress', { id: theirs }],
      ['update_status', { id: theirs, status: 'cancelled' }],
      ['send_message', { id: theirs, message: 'hi' }],
      ['update_objective', { id: theirs, title: 'hijacked' }],
      ['stop_objective', { id: theirs }],
    ] as const) {
      const { result } = await callTool(tool, args as Loose, pinned.token)
      expect(result.isError, tool).toBe(true)
      expect(result.content[0].text, tool).toMatch(/^Error 403/)
    }
    const create = await callTool('create_objective', { title: 'cross-org', workspace: OTHER_WS, type: 'task' }, pinned.token)
    expect(create.result.isError).toBe(true)
    expect(getDb().prepare(`SELECT COUNT(*) AS n FROM objectives WHERE title = 'cross-org'`).get()).toEqual({ n: 0 })
    const row = getDb().prepare('SELECT title, status FROM objectives WHERE id = ?').get(theirs)
    expect(row).toEqual({ title: 'example2 card', status: 'review' })

    const list = await callTool('list_objectives', { status: 'review' }, pinned.token)
    expect(list.data.objectives.every((o: { workspace: string }) => o.workspace === WS)).toBe(true)
    const files = await callTool('search_files', { q: 'pasture', workspace: OTHER_WS }, pinned.token)
    expect(files.result.isError).toBe(true)
  })

  it('update_objective edits fields and returns a receipt', async () => {
    const bot = mint('grok-edit')
    const id = seed(WS, 'queue', 'old title')
    const { data } = await callTool('update_objective', { id, title: 'new title' }, bot.token)
    expect(data).toMatchObject({ id, title: 'new title', url: cardUrl(id) })
    expect(data.confirmation).toBe(`Updated #${id} (title).`)
  })

  it('whoami reports the key label, scopes and workspaces', async () => {
    const pinned = mint('grok-whoami', ['board:read', 'board:write'], [WS])
    const { data } = await callTool('whoami', {}, pinned.token)
    expect(data).toMatchObject({ key_kind: 'agent', key_label: 'grok-whoami', scopes: ['board:read', 'board:write'], workspaces: [WS], can_write_via_mcp: true })
  })

  it('get_progress and get_artifacts answer for a readable card', async () => {
    const bot = mint('grok-progress')
    const id = seed(WS, 'working', 'running card')
    const p = await callTool('get_progress', { id }, bot.token)
    expect(p.result.isError).toBeFalsy()
    expect(p.data).toMatchObject({ id, status: 'working', url: cardUrl(id) })
    const a = await callTool('get_artifacts', { id }, bot.token)
    expect(a.result.isError).toBeFalsy()
    expect(Array.isArray(a.data.entries)).toBe(true)
  })

  it('files API: an unpinned agent key must name a workspace; system roots stay off-limits', async () => {
    const bot = mint('grok-files')
    const noWs = await callTool('search_files', { q: 'deck' }, bot.token)
    expect(noWs.result.isError).toBe(true)
    expect(noWs.result.content[0].text).toMatch(/workspace is required/)
    const withWs = await callTool('search_files', { q: 'deck', workspace: WS }, bot.token)
    expect(withWs.data.results.some((r: { path: string }) => r.path === (globalThis as Loose).__filePath)).toBe(true)
    const sys = await fetch(`${baseUrl}/api/files/search?q=x&workspace=${WS}&system=1`, { headers: { Authorization: `Bearer ${bot.token}` } })
    expect(sys.status).toBe(403)
  })

  it('board_briefing, list_workspaces and list_agents work for a reader', async () => {
    const reader = mint('grok-briefing', ['board:read'], [WS])
    const b = await callTool('board_briefing', {}, reader.token)
    expect(b.data).toHaveProperty('needs_review')
    const ws = await callTool('list_workspaces', {}, reader.token)
    expect(ws.data.workspaces.map((w: { slug: string }) => w.slug)).toEqual([WS])
    const ag = await callTool('list_agents', {}, reader.token)
    expect(Array.isArray(ag.data.agents)).toBe(true)
  })

  it('list_chat_agents / get_chat_agent hand an outside AI the same chat agent (obj 719987)', async () => {
    const reader = mint('claude-desktop', ['vault:read'], [WS])
    const list = await callTool('list_chat_agents', {}, reader.token)
    expect(list.data.agents).toEqual([expect.objectContaining({ slug: 'librarian', name: 'Librarian', knowledge_folders: ['team'], tools: ['search', 'read_file'] })])
    const one = await callTool('get_chat_agent', { slug: 'librarian' }, reader.token)
    expect(one.data.system_prompt).toBe('You organise the knowledge base.')
    // Board-only keys don't get agent instructions, and chat history stays off the agent surface.
    const boardOnly = mint('board-only', ['board:read'], [WS])
    expect((await callTool('list_chat_agents', {}, boardOnly.token)).result.isError).toBe(true)
    const hist = await fetch(`${baseUrl}/api/agent-chat/agents/librarian/messages`, { headers: { Authorization: `Bearer ${reader.token}` } })
    expect(hist.status).toBe(403)
  })

  it('bad arguments are a tool error, unknown tools a JSON-RPC error', async () => {
    const bad = await callTool('get_card', { id: 'abc' })
    expect(bad.result.isError).toBe(true)
    const unknown = await rpc('tools/call', { name: 'delete_everything', arguments: {} })
    expect(unknown.json.error.code).toBe(-32602)
  })
})

describe('REST create honours ?workspace= (no silent example default)', () => {
  it('POST /api/objectives?workspace=example2 with no body workspace lands in example2', async () => {
    const res = await fetch(`${baseUrl}/api/objectives?workspace=${OTHER_WS}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminJwt()}` },
      body: JSON.stringify({ title: 'query-ws card', type: 'task' }),
    })
    expect(res.status).toBe(201)
    const row = await res.json() as { id: number; workspace: string }
    expect(row.workspace).toBe(OTHER_WS)
  })
})

describe('start_objective retry-once semantics', () => {
  function fakeRest(script: Array<unknown>): { rest: Loose; calls: string[] } {
    const calls: string[] = []
    const rest = async (method: string, p: string) => {
      calls.push(`${method} ${p}`)
      const next = script.shift()
      if (next instanceof Error) throw next
      return next
    }
    return { rest, calls }
  }

  it('retries a 5xx once and reports it', async () => {
    const { rest, calls } = fakeRest([new ToolError(500, 'spawn hiccup'), { id: 7, status: 'queue' }, { id: 7, status: 'working' }])
    const r = await patchStatus(rest, 7, 'working')
    expect(r).toEqual({ row: { id: 7, status: 'working' }, retried: true })
    expect(calls).toEqual(['PATCH /api/objectives/7/status', 'GET /api/objectives/7', 'PATCH /api/objectives/7/status'])
  })

  it('never double-starts: if the first attempt landed, it does not PATCH again', async () => {
    const { rest, calls } = fakeRest([new ToolError(502, 'gateway'), { id: 7, status: 'working' }])
    const r = await patchStatus(rest, 7, 'working')
    expect(r.retried).toBe(false)
    expect(calls).toEqual(['PATCH /api/objectives/7/status', 'GET /api/objectives/7'])
  })

  it('does not retry a 4xx (scope, transition, cap)', async () => {
    const { rest, calls } = fakeRest([new ToolError(409, 'session cap')])
    await expect(patchStatus(rest, 7, 'working')).rejects.toThrow('session cap')
    expect(calls).toHaveLength(1)
  })
})

describe('tool table', () => {
  it('GET /api/agent discovery advertises the MCP endpoint and exactly these tools', () => {
    expect(AGENT_DISCOVERY.mcp.url).toBe('/api/mcp')
    expect(AGENT_DISCOVERY.mcp.transport).toBe('streamable-http')
    expect([...AGENT_DISCOVERY.mcp.tools].sort()).toEqual(MCP_TOOLS.map(t => t.name).sort())
    expect([...AGENT_DISCOVERY.mcp.tools].sort()).toEqual([...KNOWLEDGE_TOOLS, ...BOARD_TOOLS, ...CHAT_AGENT_TOOLS, 'file_info', 'write_doc', 'file_answer', 'kb_related', 'kb_who_knows'].sort())
  })

  it('the write set is exactly these — no merge / deploy / spend / delete tool', () => {
    expect(MCP_TOOLS.filter(t => t.access === 'write').map(t => t.name).sort())
      .toEqual(['create_objective', 'file_answer', 'fulfill_secret_request', 'send_message', 'start_objective', 'stop_objective', 'update_objective', 'update_status', 'write_doc'])
    // obj 719065: the only secret tools are the write-only request relay pair —
    // neither can read a value (fulfill mints a one-time upload link).
    const SECRET_RELAY = new Set(['list_secret_requests', 'fulfill_secret_request'])
    for (const t of MCP_TOOLS) {
      if (SECRET_RELAY.has(t.name)) continue
      expect(t.name).not.toMatch(/merge|deploy|delete|secret|spend|admin|shell/)
    }
    expect(MCP_TOOLS.find(t => t.name === 'fulfill_secret_request')!.scope).toBe('board:secrets_request')
  })

  it('aliases point at a canonical tool that exists', () => {
    for (const t of MCP_TOOLS.filter(x => x.aliasOf)) expect(MCP_TOOLS.some(x => x.name === t.aliasOf), t.name).toBe(true)
  })
})
