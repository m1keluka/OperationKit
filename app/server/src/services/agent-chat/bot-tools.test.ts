// Per-bot tool assignment, "all tools", editable default model, and web tools
// reaching the model only when assigned (obj 900671).
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'

process.env.JWT_SECRET = 'test-secret-bot-tools-xxxx'
const TMP_DB = path.join(os.tmpdir(), `cc-chat-bot-tools-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB
const TMP_AGENTS = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-chat-bot-tools-agents-'))
const TMP_KB = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-chat-bot-tools-kb-'))
process.env.AGENT_FILES_DIR = TMP_AGENTS
process.env.KNOWLEDGE_BASE_DIR = TMP_KB
process.env.AGENT_CHAT_BUILTINS = '0'

const { initDb, getDb } = await import('../../db/index.js')
const { toolSpecsFor, runChatTool, effectiveTools, agentHasTool, ToolUseError } = await import('./tools.js')
const { ALL_TOOLS_GRANT, KNOWN_TOOL_NAMES } = await import('./tool-names.js')
const { setBotConfig, clearBotConfig, getBotConfig, BotConfigError } = await import('./bot-config.js')
const { findAgent, runTurn } = await import('./engine.js')
const { chooseProviderId, createProvider, resolveModel, DEFAULT_MODELS } = await import('./providers.js')
const { mcpToolSetFor } = await import('./mcp-tools.js')
type Agent = import('./agent-defs.js').ChatAgent

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any

const USER = 1
const WS = 'bots-ws'

function writeAgent(slug: string, yaml: string) {
  fs.mkdirSync(path.join(TMP_AGENTS, slug), { recursive: true })
  fs.writeFileSync(path.join(TMP_AGENTS, slug, 'agent.yaml'), yaml)
}

const names = (a: Pick<Agent, 'tools'>) => toolSpecsFor(a as Agent).map(s => s.function.name)

function ctx(a: Agent, web: Loose = {}) {
  return { userId: USER, username: 'user1', workspace: WS, agent: a, kbRoot: TMP_KB, connectors: { mail: null, calendar: null }, web }
}

const searchFetch = async () =>
  new Response(JSON.stringify({ success: true, data: [{ url: 'https://news.example/today', title: 'Today', description: 'What happened today.' }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
const pageFetch = async () => new Response('<title>Today</title><p>Full story.</p>', { headers: { 'content-type': 'text/html' } })
const WEB_ENV = { FIRECRAWL_API_KEY: 'fc-test' } as NodeJS.ProcessEnv

beforeAll(() => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
  const db = getDb()
  db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (1, 'user1', 'x', 'admin')`).run()
  db.prepare(`INSERT OR IGNORE INTO workspaces (slug, name) VALUES (?, 'Bots')`).run(WS)
  db.prepare('INSERT INTO user_workspaces (user_id, workspace) VALUES (?, ?)').run(USER, WS)
  // The trial CTO bot exactly as shipped: no provider and no model (so it lands on the Claude default), web tools listed.
  writeAgent('your-org-cto', fs.readFileSync(fileURLToPath(new URL('../../../../../docs/bots/trial-roster/cto.agent.yaml', import.meta.url)), 'utf8'))
  writeAgent('researcher', 'name: Researcher\nsystem_prompt: You research.\ntools: [web_search, web_fetch]\n')
  writeAgent('everything', 'name: Everything\nsystem_prompt: You do it all.\ntools: [all]\n')
  writeAgent('notes-only', 'name: Notes\nsystem_prompt: Notes only.\ntools: [search, read_file]\nprovider: openai\nmodel: gpt-5\n')
})

afterAll(() => {
  for (const p of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) fs.rmSync(p, { force: true })
  fs.rmSync(TMP_AGENTS, { recursive: true, force: true })
  fs.rmSync(TMP_KB, { recursive: true, force: true })
})

beforeEach(() => {
  getDb().prepare('DELETE FROM agent_chat_bot_config').run()
})

describe('tool assignment from the agent file', () => {
  it('offers web_search and web_fetch only to a bot that lists them', () => {
    expect(names(findAgent('researcher')!)).toEqual(['web_search', 'web_fetch'])
    expect(names(findAgent('notes-only')!)).not.toContain('web_search')
    expect(names(findAgent('your-org-cto')!)).toEqual(expect.arrayContaining(['web_search', 'web_fetch', 'create_objective']))
  })

  it('`tools: [all]` gives every built-in tool, web included', () => {
    const a = findAgent('everything')!
    expect(new Set(effectiveTools(a))).toEqual(ALL_TOOLS_GRANT)
    const fns = names(a)
    for (const fn of ['web_search', 'web_fetch', 'search', 'write_doc', 'create_objective', 'board_briefing', 'email_create_draft', 'calendar_draft_event']) {
      expect(fns, fn).toContain(fn)
    }
    // MCP is gated the same way, not by a literal `includes('mcp')`.
    expect(agentHasTool(a, 'mcp')).toBe(true)
    expect(mcpToolSetFor({ tools: ['all'] }, WS).specs).toEqual([])
  })

  it('ignores names that are not chat tools', () => {
    expect(effectiveTools({ tools: ['web_search', 'rm_rf'] })).toEqual(['web_search'])
  })
})

describe('web tools run only when assigned', () => {
  it('web_search runs for a bot that has it', async () => {
    const out = await runChatTool(ctx(findAgent('researcher')!, { env: WEB_ENV, fetch: searchFetch }), 'web_search', { query: 'news today' })
    expect(out.summary).toBe('Searched the web for "news today" (1 found)')
    expect((out.result as Loose).results[0].url).toBe('https://news.example/today')
  })

  it('web_fetch runs for a bot that has it', async () => {
    const out = await runChatTool(ctx(findAgent('researcher')!, { pageFetch }), 'web_fetch', { url: 'https://news.example/today' })
    expect((out.result as Loose).content).toContain('Full story.')
    expect(out.summary).toContain('news.example')
  })

  it('a bot without web tools is refused, even if the model asks', async () => {
    const a = findAgent('notes-only')!
    await expect(runChatTool(ctx(a, { env: WEB_ENV, fetch: searchFetch }), 'web_search', { query: 'x' })).rejects.toBeInstanceOf(ToolUseError)
    await expect(runChatTool(ctx(a, { pageFetch }), 'web_fetch', { url: 'https://x.example' })).rejects.toThrow(/not allowed/)
  })

  it('a vendor failure becomes a ToolUseError the model can read', async () => {
    await expect(runChatTool(ctx(findAgent('researcher')!, { env: {} }), 'web_search', { query: 'x' })).rejects.toThrow(/not set up/)
  })

  it('non-web tools still go through the synchronous runner', async () => {
    const out = await runChatTool(ctx(findAgent('notes-only')!), 'search', { q: 'nothing' })
    expect(out.summary).toMatch(/Searched knowledge/)
  })
})

describe('bot-page overrides (model, provider, tools, all tools)', () => {
  it('why the CTO bot was on Sonnet: no provider/model in its file → Claude pool → claude-sonnet-5', () => {
    const cto = findAgent('your-org-cto')!
    expect(cto.provider).toBeNull()
    expect(cto.model).toBeNull()
    const id = chooseProviderId(cto, null, { env: {}, hasPoolAccount: () => true })
    expect(id).toBe('claude')
    expect(resolveModel(id, cto, {})).toBe('claude-sonnet-5')
    expect(DEFAULT_MODELS.claude).toBe('claude-sonnet-5')
  })

  it('an admin sets the CTO bot\'s default model; the provider actually uses it', () => {
    setBotConfig('your-org-cto', { model: 'claude-opus-5-5' }, 'admin')
    const cto = findAgent('your-org-cto')!
    expect(cto.model).toBe('claude-opus-5-5')
    expect(cto.file_defaults?.model).toBeNull()
    const p = createProvider('claude', cto, { env: {}, claudeBackend: async () => ({ text: 'hi' }) as Loose })
    expect(p.model).toBe('claude-opus-5-5')
    // The bot list shows the same model the turn uses.
    expect(resolveModel('claude', cto, { AGENT_CHAT_CLAUDE_MODEL: 'claude-sonnet-5' })).toBe('claude-opus-5-5')
  })

  it('provider override wins over the file', () => {
    setBotConfig('notes-only', { provider: 'xai', model: 'grok-4' }, 'admin')
    const a = findAgent('notes-only')!
    expect(a.provider).toBe('xai')
    expect(chooseProviderId(a, 'claude', { env: {} })).toBe('xai')
    expect(a.file_defaults).toEqual({ provider: 'openai', model: 'gpt-5', tools: ['search', 'read_file'] })
  })

  it('per-bot tool assignment replaces the file\'s list', () => {
    setBotConfig('your-org-cto', { tools: ['web_search', 'web_fetch', 'list_objectives'] }, 'admin')
    const cto = findAgent('your-org-cto')!
    expect(names(cto)).toEqual(['web_search', 'web_fetch', 'list_objectives', 'board_briefing'])
    expect(names(cto)).not.toContain('create_objective')
  })

  it('"all tools" gives every tool and beats a saved list', () => {
    setBotConfig('notes-only', { tools: ['search'], all_tools: true }, 'admin')
    const a = findAgent('notes-only')!
    expect(a.tools).toEqual(['all'])
    expect(new Set(effectiveTools(a))).toEqual(ALL_TOOLS_GRANT)
    setBotConfig('notes-only', { all_tools: false }, 'admin')
    expect(findAgent('notes-only')!.tools).toEqual(['search'])
  })

  it('a partial update keeps the other overrides; null clears one back to the file', () => {
    setBotConfig('notes-only', { model: 'gpt-5-mini', tools: ['search'] }, 'admin')
    setBotConfig('notes-only', { model: null }, 'admin')
    const cfg = getBotConfig('notes-only')!
    expect(cfg.model).toBeNull()
    expect(cfg.tools).toEqual(['search'])
    expect(findAgent('notes-only')!.model).toBe('gpt-5')
  })

  it('reset puts the bot back to exactly its file', () => {
    setBotConfig('researcher', { all_tools: true, model: 'x-1' }, 'admin')
    expect(clearBotConfig('researcher')).toBe(true)
    const a = findAgent('researcher')!
    expect(a.tools).toEqual(['web_search', 'web_fetch'])
    expect(a.model).toBeNull()
    expect(a.config).toBeNull()
  })

  it('rejects unknown tools, bad providers and malformed model ids', () => {
    expect(() => setBotConfig('researcher', { tools: ['shell'] }, 'admin')).toThrow(BotConfigError)
    expect(() => setBotConfig('researcher', { provider: 'skynet' }, 'admin')).toThrow(/provider must be one of/)
    expect(() => setBotConfig('researcher', { model: 'bad model; drop table' }, 'admin')).toThrow(/model must be/)
    expect(() => setBotConfig('researcher', { all_tools: 'yes' }, 'admin')).toThrow(/all_tools/)
    expect(getBotConfig('researcher')).toBeNull()
  })
})

describe('a full chat turn: web tools reach the model only when assigned', () => {
  /** A fake OpenAI endpoint: asks for web_search once, then answers. Records what tools it was offered. */
  function scriptedOpenAi() {
    const offered: string[][] = []
    let n = 0
    const f = async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body))
      offered.push((body.tools ?? []).map((t: Loose) => t.function.name))
      n++
      const message = n === 1
        ? { content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'web_search', arguments: JSON.stringify({ query: 'news today' }) } }] }
        : { content: 'Here is the news: https://news.example/today' }
      return new Response(JSON.stringify({ choices: [{ message }] }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return { f, offered }
  }

  it('an assigned bot searches the web and answers with the result', async () => {
    setBotConfig('notes-only', { tools: ['web_search', 'web_fetch'] }, 'admin')
    const { f, offered } = scriptedOpenAi()
    const env = { ...WEB_ENV, OPENAI_API_KEY: 'sk-test' } as NodeJS.ProcessEnv
    const r = await runTurn({ userId: USER, username: 'user1', agent: findAgent('notes-only')!, text: 'What is in the news?', env, deps: { env, fetch: f as Loose }, webDeps: { fetch: searchFetch } })
    expect(offered[0]).toEqual(['web_search', 'web_fetch'])
    const tool = r.messages.find(m => m.role === 'tool')!
    expect(tool.tool_name).toBe('web_search')
    expect(tool.meta?.ok).toBe(true)
    expect(tool.content).toBe('Searched the web for "news today" (1 found)')
    expect(r.messages.at(-1)).toMatchObject({ role: 'assistant', model: 'gpt-5' })
  })

  it('an unassigned bot is never offered web tools, and a forced call is refused', async () => {
    const { f, offered } = scriptedOpenAi()
    const env = { ...WEB_ENV, OPENAI_API_KEY: 'sk-test' } as NodeJS.ProcessEnv
    const r = await runTurn({ userId: USER, username: 'user1', agent: findAgent('notes-only')!, text: 'news?', env, deps: { env, fetch: f as Loose }, webDeps: { fetch: searchFetch } })
    expect(offered[0]).toEqual(['search', 'read_file'])
    const tool = r.messages.find(m => m.role === 'tool')!
    expect(tool.meta?.ok).toBe(false)
    expect(tool.content).toMatch(/not allowed/)
  })
})
