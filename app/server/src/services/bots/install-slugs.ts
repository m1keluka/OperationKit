/**
 * Install-local chat slugs + agent-file localization (obj 900430).
 *
 * The problem this exists for: the trial chat bots (obj 900371) shipped as
 * agent files AND registry entries carrying one org's slugs and knowledge
 * folder. The OSS public sync name-scrubs business identity out of the public
 * tree (it must — `scripts/oss-sync-gate.sh` fails closed on it), so on a
 * public install the files and the registry carried placeholder slugs, and the
 * placeholder knowledge folder did not exist. There was no supported way to
 * register the org's real slugs.
 *
 * The fix keeps the org's identity out of SOURCE entirely and moves it into
 * install-local DATA:
 *
 *  1. `settings.bot_agent_slugs` (`bot-registry.ts`) — extra chat slugs per
 *     existing bot, written here, additively.
 *  2. `localizeAgentFileText` — turns a generic example agent file (folder
 *     `workspaces/your-org`, display "Your Org", placeholder slug) into this
 *     install's file at import time. Purely textual; the normal
 *     `parseAgentFile` validation then runs on the result.
 *
 * Neither path widens anything: no tool, model, provider, permission, budget
 * or ceiling field is read or written. The file's tool list is the template's
 * and a bot's job budget stays the install's default ceiling.
 */
import type { Database } from 'better-sqlite3'
import {
  BOT_AGENT_SLUGS_SETTING,
  findBotIndex,
  isValidChatSlug,
  listBots,
  readInstallSlugMap,
  registryKey,
  resolveBot,
} from './bot-registry.js'

/** Placeholders the shipped example agent files use (`docs/bots/trial-roster/`). */
export const TEMPLATE_PLACEHOLDER = 'your-org'
export const TEMPLATE_DISPLAY_NAME = 'Your Org'
export const TEMPLATE_KNOWLEDGE_FOLDER = `workspaces/${TEMPLATE_PLACEHOLDER}`

const KNOWLEDGE_FOLDER_RE = /^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9 _-]+)*$/
const DISPLAY_NAME_RE = /^[\p{L}\p{N} &.,'()-]{1,60}$/u

export interface LocalizeOptions {
  /** The agent slug to install under, e.g. `acme-cfo`. Must already belong to a bot. */
  slug: string
  /** Knowledge folder, relative to the KB root, replacing `workspaces/your-org`. */
  knowledge_folder: string
  /** Human-readable org name replacing "Your Org". Default: the folder's last segment. */
  display_name: string
}

export type LocalizeParse = { ok: true; options: LocalizeOptions } | { ok: false; error: string }

/** Validate a caller-supplied `localize` object. Nothing is coerced silently. */
export function parseLocalizeOptions(raw: unknown): LocalizeParse {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'localize must be an object: { slug, knowledge_folder, display_name? }' }
  }
  const o = raw as Record<string, unknown>
  const slug = typeof o.slug === 'string' ? o.slug.trim() : ''
  if (!isValidChatSlug(slug)) {
    return { ok: false, error: 'localize.slug must be 2–41 characters: lowercase letters, numbers and hyphens' }
  }
  if (slug.includes(TEMPLATE_PLACEHOLDER)) {
    return { ok: false, error: `localize.slug still contains the placeholder "${TEMPLATE_PLACEHOLDER}" — import the file without localize instead` }
  }
  const folder = typeof o.knowledge_folder === 'string' ? o.knowledge_folder.trim().replace(/\/+$/, '') : ''
  if (!folder || !KNOWLEDGE_FOLDER_RE.test(folder) || folder.split('/').some(seg => seg.trim() === '.' || seg.trim() === '..')) {
    return { ok: false, error: 'localize.knowledge_folder is required: a relative folder inside the knowledge base (e.g. "workspaces/acme")' }
  }
  if (folder.includes(TEMPLATE_PLACEHOLDER)) {
    return { ok: false, error: `localize.knowledge_folder still contains the placeholder "${TEMPLATE_PLACEHOLDER}"` }
  }
  let display = folder.split('/').pop() as string
  if (o.display_name !== undefined) {
    const d = typeof o.display_name === 'string' ? o.display_name.trim() : ''
    if (!DISPLAY_NAME_RE.test(d)) {
      return { ok: false, error: 'localize.display_name must be 1–60 characters of plain text (letters, numbers, spaces, & . , \' ( ) -)' }
    }
    display = d
  }
  return { ok: true, options: { slug, knowledge_folder: folder, display_name: display } }
}

export type LocalizeResult = { ok: true; text: string } | { ok: false; error: string }

/**
 * Rewrite the placeholders: the knowledge folder, the display name, and the
 * `slug:` line (replaced whole, so it does not matter what placeholder slug the
 * file carried). Refuses when a placeholder survives — that means the file is
 * not one of the generic examples and a partial rewrite would install a bot
 * pointing at a folder or name that does not exist.
 */
export function localizeAgentFileText(text: string, opts: LocalizeOptions): LocalizeResult {
  const slugLine = /^slug:[^\n]*$/m
  if (!slugLine.test(text)) return { ok: false, error: 'the file has no top-level "slug:" line to localize' }
  const out = text
    .split(TEMPLATE_KNOWLEDGE_FOLDER).join(opts.knowledge_folder)
    .split(TEMPLATE_DISPLAY_NAME).join(opts.display_name)
    .replace(slugLine, `slug: ${opts.slug}`)
  if (out.toLowerCase().includes(TEMPLATE_PLACEHOLDER)) {
    return { ok: false, error: `the file still mentions "${TEMPLATE_PLACEHOLDER}" after localizing — it is not one of the generic example files` }
  }
  return { ok: true, text: out }
}

/** Install slug state, for GET and for the result of a write. */
export interface InstallSlugState {
  /** Exactly what `settings.bot_agent_slugs` holds (parsed). */
  configured: Record<string, string[]>
  /** Chat-agent slugs each bot owns on this install, built-in + configured. */
  bots: Array<{ id: string; name: string; agent_slugs: string[] }>
}

export function installSlugState(db: Database): InstallSlugState {
  return {
    configured: readInstallSlugMap(db),
    bots: listBots(db).map(b => ({ id: b.id, name: b.name, agent_slugs: b.agent_slugs })),
  }
}

export type InstallSlugWrite = { ok: true; state: InstallSlugState } | { ok: false; status: number; error: string }

/**
 * Add or remove ONE chat slug for ONE bot in `settings.bot_agent_slugs`. Only
 * that settings row is written.
 *
 * The entry is stored under the bot key the caller typed (e.g. `cos`), and any
 * other key that resolves to the same bot is merged into it. Storing the typed
 * key rather than the canonical id matters on a build where two bots share an
 * id (the public build's name-scrub renames one bot onto another's id): a
 * short alias still resolves to exactly the bot the operator meant.
 *
 * Refused, never silently ignored: an unknown bot; a malformed slug; adding a
 * slug another bot already owns; removing a slug that is not install-configured
 * (built-in slugs are source, not settings).
 */
export function updateInstallSlugs(db: Database, change: { bot?: unknown; add?: unknown; remove?: unknown }): InstallSlugWrite {
  const resolved = resolveBot(change.bot, db)
  if (!resolved.ok) return { ok: false, status: 400, error: resolved.error }
  const botKey = String(change.bot).trim()
  const bots = listBots(db)
  const target = findBotIndex(bots, botKey)
  const botId = bots[target].id
  const add = change.add
  const remove = change.remove
  if ((add === undefined) === (remove === undefined)) {
    return { ok: false, status: 400, error: 'send exactly one of { add: "<slug>" } or { remove: "<slug>" }' }
  }
  const slug = (add ?? remove) as unknown
  if (!isValidChatSlug(slug)) {
    return { ok: false, status: 400, error: 'slug must be 2–41 characters: lowercase letters, numbers and hyphens' }
  }

  const map = readInstallSlugMap(db)
  const current: string[] = []
  for (const [k, v] of Object.entries(map)) {
    if (findBotIndex(bots, k) !== target) continue
    for (const s of v) if (!current.includes(s)) current.push(s)
    delete map[k]
  }

  if (add !== undefined) {
    // Same lookup order as botForAgentSlug, but by position in ONE list, so two
    // bots that share an id are still told apart.
    const k = registryKey(slug)
    const ownerIdx = bots.findIndex(b => b.agent_slugs.some(x => registryKey(x) === k) || registryKey(b.id) === k || registryKey(b.name) === k)
    if (ownerIdx >= 0 && ownerIdx !== target) {
      return { ok: false, status: 409, error: `"${slug}" already belongs to ${bots[ownerIdx].id} — a slug can only route to one bot` }
    }
    if (!current.includes(slug)) current.push(slug)
  } else {
    const at = current.indexOf(slug)
    if (at < 0) {
      return { ok: false, status: 404, error: `"${slug}" is not an install-configured slug of ${botId} (built-in slugs cannot be removed here)` }
    }
    current.splice(at, 1)
  }
  if (current.length) map[botKey] = current

  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(BOT_AGENT_SLUGS_SETTING, JSON.stringify(map))
  return { ok: true, state: installSlugState(db) }
}
