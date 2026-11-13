// ── Per-bot settings edited on the bot's page (obj 900671) ──
//
// A bot is defined by its agent file, and before this its model, provider and
// tools could only be changed by editing that file on the server. That is why
// the trial CTO bot ran on Sonnet: its file names no provider and no model, so
// chat picked the first provider that is set up (the Claude seat pool) and that
// provider's hard-coded default model, claude-sonnet-5 — and nothing on the
// page could change it.
//
// This table holds an admin's overrides, one row per bot slug, applied on top
// of the file every time agents are listed:
//
//   provider   NULL = the file's provider (or automatic)
//   model      NULL = the file's model (or the provider default)
//   tools      NULL = the file's tool list; else a JSON array of tool names
//   all_tools  1 = every tool this release knows (beats `tools`)
//
// The agent file itself is never rewritten: a built-in bot ships read-only
// inside the app, and an install's own files may be managed elsewhere. Reset
// = delete the row, and the bot is exactly what its file says again.
import { getDb } from '../../db/index.js'
import { CHAT_PROVIDERS, type ChatAgent, type ChatProviderId } from './agent-defs.js'
import { EXPLICIT_ONLY_TOOLS, KNOWN_TOOL_NAMES, listsAllTools } from './tool-names.js'

export interface BotConfig {
  slug: string
  provider: ChatProviderId | null
  model: string | null
  tools: string[] | null
  all_tools: boolean
  updated_by: string | null
  updated_at: string
}

/** What the agent file itself says, before any override. */
export interface BotFileDefaults {
  provider: ChatProviderId | null
  model: string | null
  tools: string[]
}

export class BotConfigError extends Error {
  readonly status = 400
}

const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,119}$/

interface Row {
  slug: string
  provider: string | null
  model: string | null
  tools: string | null
  all_tools: number
  updated_by: string | null
  updated_at: string
}

function mapRow(r: Row): BotConfig {
  let tools: string[] | null = null
  if (typeof r.tools === 'string') {
    try {
      const parsed = JSON.parse(r.tools)
      if (Array.isArray(parsed)) tools = parsed.filter((t): t is string => typeof t === 'string')
    } catch { /* a corrupt row falls back to the file's tools */ }
  }
  return {
    slug: r.slug,
    provider: r.provider && (CHAT_PROVIDERS as readonly string[]).includes(r.provider) ? (r.provider as ChatProviderId) : null,
    model: r.model || null,
    tools,
    all_tools: Number(r.all_tools) === 1,
    updated_by: r.updated_by,
    updated_at: r.updated_at,
  }
}

export function getBotConfig(slug: string): BotConfig | null {
  const r = getDb().prepare('SELECT * FROM agent_chat_bot_config WHERE slug = ?').get(slug) as Row | undefined
  return r ? mapRow(r) : null
}

export function allBotConfigs(): Map<string, BotConfig> {
  const rows = getDb().prepare('SELECT * FROM agent_chat_bot_config').all() as Row[]
  return new Map(rows.map(r => [r.slug, mapRow(r)]))
}

export interface BotConfigPatch {
  provider?: unknown
  model?: unknown
  tools?: unknown
  all_tools?: unknown
}

function normaliseProvider(v: unknown): ChatProviderId | null {
  if (v === null || v === '') return null
  if (typeof v === 'string' && (CHAT_PROVIDERS as readonly string[]).includes(v)) return v as ChatProviderId
  throw new BotConfigError(`provider must be one of ${CHAT_PROVIDERS.join(', ')} (or empty for the file's default)`)
}

function normaliseModel(v: unknown): string | null {
  if (v === null) return null
  if (typeof v !== 'string') throw new BotConfigError('model must be text')
  const m = v.trim()
  if (!m) return null
  if (!MODEL_RE.test(m)) throw new BotConfigError('model must be a model id like claude-opus-5-5 or grok-4 (letters, digits, . _ - : / @ +; at most 120 characters)')
  return m
}

function normaliseTools(v: unknown): string[] | null {
  if (v === null) return null
  if (!Array.isArray(v)) throw new BotConfigError('tools must be a list of tool names (or null for the file\'s tools)')
  const out: string[] = []
  for (const t of v) {
    if (typeof t !== 'string' || !KNOWN_TOOL_NAMES.has(t)) {
      throw new BotConfigError(`"${String(t)}" is not a chat tool. Known tools: ${[...KNOWN_TOOL_NAMES].join(', ')}`)
    }
    if (!out.includes(t)) out.push(t)
  }
  return out
}

/**
 * Save an admin's change. Only the fields present in `patch` change; `null`
 * (or "" for provider/model) clears that override back to the file's value.
 */
export function setBotConfig(slug: string, patch: BotConfigPatch, updatedBy: string): BotConfig {
  const cur = getBotConfig(slug)
  const next = {
    provider: patch.provider !== undefined ? normaliseProvider(patch.provider) : cur?.provider ?? null,
    model: patch.model !== undefined ? normaliseModel(patch.model) : cur?.model ?? null,
    tools: patch.tools !== undefined ? normaliseTools(patch.tools) : cur?.tools ?? null,
    all_tools: patch.all_tools !== undefined ? patch.all_tools === true : cur?.all_tools ?? false,
  }
  if (patch.all_tools !== undefined && typeof patch.all_tools !== 'boolean') throw new BotConfigError('all_tools must be true or false')
  getDb()
    .prepare(
      `INSERT INTO agent_chat_bot_config (slug, provider, model, tools, all_tools, updated_by, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(slug) DO UPDATE SET provider = excluded.provider, model = excluded.model, tools = excluded.tools,
         all_tools = excluded.all_tools, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    )
    .run(slug, next.provider, next.model, next.tools ? JSON.stringify(next.tools) : null, next.all_tools ? 1 : 0, updatedBy)
  return getBotConfig(slug)!
}

/** Reset: the bot goes back to exactly what its agent file says. */
export function clearBotConfig(slug: string): boolean {
  return getDb().prepare('DELETE FROM agent_chat_bot_config WHERE slug = ?').run(slug).changes > 0
}

/** The agent as its file defines it, with the admin's overrides applied. */
export function applyBotConfig(agent: ChatAgent, cfg: BotConfig | null | undefined): ChatAgent {
  const file_defaults: BotFileDefaults = agent.file_defaults ?? { provider: agent.provider, model: agent.model, tools: agent.tools }
  if (!cfg) return { ...agent, file_defaults, config: null }
  return {
    ...agent,
    provider: cfg.provider ?? file_defaults.provider,
    model: cfg.model ?? file_defaults.model,
    // obj 900749: 'all' keeps any explicit-only tool (secret use) the bot was given by name.
    tools: cfg.all_tools
      ? ['all', ...(cfg.tools ?? file_defaults.tools).filter(t => EXPLICIT_ONLY_TOOLS.has(t))]
      : cfg.tools ?? file_defaults.tools,
    file_defaults,
    config: cfg,
  }
}

/** Does this agent (after overrides) have every tool? */
export function hasAllTools(agent: Pick<ChatAgent, 'tools'>): boolean {
  return listsAllTools(agent.tools)
}
