/**
 * The bot registry (obj 900323, constraint C1 / decision D2 / gate G4).
 *
 * `validateOwnerBot` in `@operationkit/shared` checks a STRING — length and
 * charset. It answers "is this text safe to store", never "is this a bot that
 * exists". So `owner_bot: "Operaton Kit"` is accepted today and the card is
 * owned by a typo; `"Operation Kit"` and `"Grok: Operation Kit"` are stored as
 * two different owners of the same thing. Four competing spellings with silent
 * misroutes is worse than no field.
 *
 * This module is the existence check. It is deliberately SMALL and deliberately
 * DATA:
 *
 *  - A bot is `{ id, name, aliases }`. `id` is the canonical form written to
 *    `objectives.owner_bot`; everything in `aliases` resolves to it.
 *  - Resolution is case-insensitive and whitespace-insensitive, so a model that
 *    writes "operation kit" is routed, not silently misfiled.
 *  - An unknown name is a REFUSAL that names the valid bots. It is never
 *    coerced to a default and never inferred from the calling credential: a
 *    shared agent key files for every bot, and a key LABEL is the key owner's
 *    free text — deriving ownership from it would be guessing with extra steps.
 *
 * ## What this registry does NOT claim
 *
 * Registry membership is an identity, not an assignment. The exposed connector
 * schema still carries no `owner_bot` field, so nothing here asserts that a
 * named bot is wired to a connector, a seat, or a webhook destination. A bot
 * that resolves is a bot whose NAME is known; what it can reach is decided
 * elsewhere, by the authorizing person's own access.
 *
 * ## Operator-extensible without a deploy
 *
 * `settings.bot_registry` may hold a JSON array of `{id, name, aliases}` which
 * REPLACES the built-in list. Malformed JSON falls back to the built-in list and
 * logs — a broken settings row must not make every card unownable.
 *
 * ## Install-local chat slugs (obj 900430)
 *
 * `settings.bot_agent_slugs` may hold a JSON object `{ "<bot>": ["slug", ...] }`
 * which ADDS chat-agent slugs to an existing bot (the key resolves like an
 * `owner_bot` value: id, name or alias). It never removes a slug, never
 * creates a bot, and never moves a slug another bot already owns.
 *
 * This is how an install registers chat bots under its OWN org-specific slugs
 * (e.g. `<org>-cfo`). Those slugs must not live in this file: the OSS public
 * sync name-scrubs business identity out of source, so an org's slugs written
 * here ship to a public install as placeholders that no real install can use.
 * As install DATA they are never scrubbed, and the public source stays generic.
 * The `your-org-*` slugs below are the shipped example files'
 * (`docs/bots/trial-roster/`) placeholders, generic in both trees.
 */
import type { Database } from 'better-sqlite3'
import { validateOwnerBot } from '@operationkit/shared'

export interface BotDefinition {
  /** Canonical `owner_bot` value. Must satisfy validateOwnerBot. */
  id: string
  /** What a person sees. */
  name: string
  /** Other spellings that resolve to `id`. Matched case/space-insensitively. */
  aliases: string[]
  /** Chat agent slugs whose threads this bot owns. */
  agent_slugs: string[]
}

/**
 * The built-in registry. One entry per bot that actually exists as a thing a
 * person talks to. Keep it short: an entry here is a promise that the name
 * routes somewhere.
 */
export const BUILT_IN_BOTS: BotDefinition[] = [
  {
    id: 'Operation Kit',
    name: 'Operation Kit',
    aliases: ['Grok: Operation Kit', 'OperationKit', 'operation-kit', 'operationkit', 'okit'],
    agent_slugs: ['operation-kit', 'operationkit'],
  },
  {
    id: 'Grok: General',
    name: 'General',
    aliases: ['General', 'general', 'cos'],
    // 'your-org-general' is the trial example chat bot's slug (obj
    // 900371) — same identity, a second chat surface, scoped to one workspace.
    // An install adds its real slug via settings.bot_agent_slugs (obj 900430).
    agent_slugs: ['general', 'your-org-general'],
  },
  {
    id: 'Grok: General',
    name: 'General',
    aliases: ['General', 'grok-general'],
    agent_slugs: ['general'],
  },
  {
    // New bots (obj 900371, Operator-approved trial). Namespaced agent_slugs
    // deliberately avoid the bare 'cfo'/'cto' slugs: those already belong to
    // the session-worker executive roster in the `agents` registry table
    // (DEFAULT_AGENT_SEED / an operator's seed.agents.json) and reusing them
    // for a chat-bot agent file would either 409 on install or, with
    // overwrite:true, silently clobber the production card-routing roster.
    id: 'Grok: CFO',
    name: 'CFO',
    aliases: ['CFO', 'Example CFO', 'grok-cfo'],
    agent_slugs: ['your-org-cfo'],
  },
  {
    id: 'Grok: CTO',
    name: 'CTO',
    aliases: ['CTO', 'Example CTO', 'grok-cto'],
    agent_slugs: ['your-org-cto'],
  },
]

/** Lower-cased, collapsed whitespace, `:` and `-`/`_` folded out — the match key. */
export function registryKey(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[\s_-]+/g, ' ')
    .replace(/:/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function parseOverride(raw: string | null | undefined): BotDefinition[] | null {
  if (!raw || !raw.trim()) return null
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed) || parsed.length === 0) return null
    const out: BotDefinition[] = []
    for (const item of parsed) {
      const b = item as Partial<BotDefinition>
      if (typeof b.id !== 'string' || !validateOwnerBot(b.id).ok) return null
      out.push({
        id: b.id.trim(),
        name: typeof b.name === 'string' && b.name.trim() ? b.name.trim() : b.id.trim(),
        aliases: Array.isArray(b.aliases) ? b.aliases.filter((a): a is string => typeof a === 'string') : [],
        agent_slugs: Array.isArray(b.agent_slugs) ? b.agent_slugs.filter((a): a is string => typeof a === 'string') : [],
      })
    }
    return out
  } catch {
    return null
  }
}

/** The settings key holding install-local chat slugs per bot. */
export const BOT_AGENT_SLUGS_SETTING = 'bot_agent_slugs'

/** Same shape rule as an agent file's slug (`AGENT_SLUG_RE` in agent-file.ts). */
const CHAT_SLUG_RE = /^[a-z0-9][a-z0-9-]{1,40}$/
export function isValidChatSlug(raw: unknown): raw is string {
  return typeof raw === 'string' && CHAT_SLUG_RE.test(raw)
}

/**
 * Parse `settings.bot_agent_slugs`. Returns null when the row is not a JSON
 * object; otherwise each key with its valid, de-duplicated slugs (invalid
 * slugs are dropped with a warning — never coerced).
 */
export function parseInstallSlugMap(raw: string | null | undefined): Record<string, string[]> | null {
  if (!raw || !raw.trim()) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const out: Record<string, string[]> = {}
  for (const [key, val] of Object.entries(parsed as Record<string, unknown>)) {
    const list = Array.isArray(val) ? val : [val]
    const slugs: string[] = []
    for (const s of list) {
      if (!isValidChatSlug(s)) {
        console.warn(`[bots] settings.${BOT_AGENT_SLUGS_SETTING}: ignoring invalid slug ${JSON.stringify(s)} for "${key}"`)
        continue
      }
      if (!slugs.includes(s)) slugs.push(s)
    }
    out[key] = slugs
  }
  return out
}

/** The raw install slug map (`{}` when unset or unreadable). */
export function readInstallSlugMap(db?: Database): Record<string, string[]> {
  if (!db) return {}
  let raw: string | null = null
  try {
    raw = (db.prepare('SELECT value FROM settings WHERE key = ?').get(BOT_AGENT_SLUGS_SETTING) as { value: string } | undefined)?.value ?? null
  } catch {
    return {}
  }
  const map = parseInstallSlugMap(raw)
  if (!map) {
    console.warn(`[bots] settings.${BOT_AGENT_SLUGS_SETTING} is not a JSON object — ignoring it`)
    return {}
  }
  return map
}

/** First bot whose id, name or alias matches `raw` — the same order `resolveBot` uses. */
export function findBotIndex(bots: BotDefinition[], raw: string): number {
  const key = registryKey(raw)
  return bots.findIndex(b => registryKey(b.id) === key || registryKey(b.name) === key || b.aliases.some(a => registryKey(a) === key))
}

function findBot(bots: BotDefinition[], raw: string): BotDefinition | undefined {
  const key = registryKey(raw)
  return bots.find(b => registryKey(b.id) === key || registryKey(b.name) === key || b.aliases.some(a => registryKey(a) === key))
}

/**
 * Fold the install slug map into a bot list. Additive only: an unknown bot key
 * is skipped, and a slug that already belongs to a DIFFERENT bot stays with
 * that bot (first owner wins), so a settings row can never reroute an
 * existing thread.
 */
export function applyInstallSlugs(bots: BotDefinition[], map: Record<string, string[]>): BotDefinition[] {
  const out = bots.map(b => ({ ...b, agent_slugs: [...b.agent_slugs] }))
  const owner = new Map<string, string>()
  for (const b of out) for (const s of b.agent_slugs) if (!owner.has(registryKey(s))) owner.set(registryKey(s), b.id)
  for (const [botKey, slugs] of Object.entries(map)) {
    const bot = findBot(out, botKey)
    if (!bot) {
      console.warn(`[bots] settings.${BOT_AGENT_SLUGS_SETTING}: "${botKey}" is not a bot in this registry — ignoring its slugs`)
      continue
    }
    for (const slug of slugs) {
      const held = owner.get(registryKey(slug))
      if (held && held !== bot.id) {
        console.warn(`[bots] settings.${BOT_AGENT_SLUGS_SETTING}: "${slug}" already belongs to ${held} — not adding it to ${bot.id}`)
        continue
      }
      if (!held) {
        bot.agent_slugs.push(slug)
        owner.set(registryKey(slug), bot.id)
      }
    }
  }
  return out
}

/**
 * Every bot this install knows about: built-ins unless an operator overrode
 * them, plus the install-local chat slugs from `settings.bot_agent_slugs`.
 */
export function listBots(db?: Database): BotDefinition[] {
  const base = baseBots(db)
  const map = readInstallSlugMap(db)
  return Object.keys(map).length ? applyInstallSlugs(base, map) : base
}

function baseBots(db?: Database): BotDefinition[] {
  if (!db) return BUILT_IN_BOTS
  let raw: string | null = null
  try {
    raw = (db.prepare('SELECT value FROM settings WHERE key = ?').get('bot_registry') as { value: string } | undefined)?.value ?? null
  } catch {
    return BUILT_IN_BOTS
  }
  if (raw === null) return BUILT_IN_BOTS
  const parsed = parseOverride(raw)
  if (!parsed) {
    console.warn('[bots] settings.bot_registry is not a valid bot list — using the built-in registry')
    return BUILT_IN_BOTS
  }
  return parsed
}

export type BotResolution =
  | { ok: true; bot: BotDefinition }
  | { ok: false; error: string; known: string[] }

/**
 * Resolve a caller-supplied owner name to a registry bot.
 *
 * Two layers, in this order, because they answer different questions:
 *   1. `validateOwnerBot` — is the string safe to store at all?
 *   2. the registry — does that bot exist?
 * A failure at either layer is a 400 that NAMES the valid bots, so a typo is a
 * loud, self-correcting error instead of a card owned by nobody.
 */
export function resolveBot(raw: unknown, db?: Database): BotResolution {
  const bots = listBots(db)
  const known = bots.map(b => b.id)
  const shape = validateOwnerBot(raw)
  if (!shape.ok) return { ok: false, error: shape.error, known }
  if (shape.value === undefined || shape.value === null) {
    return {
      ok: false,
      error: 'owner_bot is required for a bot-created job and must name a bot in the registry',
      known,
    }
  }
  const key = registryKey(shape.value)
  for (const bot of bots) {
    if (registryKey(bot.id) === key) return { ok: true, bot }
    if (registryKey(bot.name) === key) return { ok: true, bot }
    if (bot.aliases.some(a => registryKey(a) === key)) return { ok: true, bot }
  }
  return {
    ok: false,
    error: `Unknown owner_bot "${shape.value}". Known bots: ${known.join(', ')}.`,
    known,
  }
}

/**
 * The bot that owns a chat agent's threads, or null when the agent is not a
 * registered bot. Returning null is the honest answer — the caller must then
 * refuse rather than invent an owner.
 */
export function botForAgentSlug(slug: string, db?: Database): BotDefinition | null {
  const key = registryKey(slug)
  for (const bot of listBots(db)) {
    if (bot.agent_slugs.some(s => registryKey(s) === key)) return bot
    if (registryKey(bot.id) === key || registryKey(bot.name) === key) return bot
  }
  return null
}
