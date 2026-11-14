// ── Per-bot workspace access list (obj 900797) ──
//
// Bots stay GLOBAL: a bot is defined once for the whole install (its agent
// file), never created inside a workspace. What changes per bot is WHERE it may
// work. An admin keeps, per bot, an explicit list of the workspaces it may read,
// write and be woken in, and grants or revokes them from the bot's settings
// panel. Everything a bot can touch that belongs to a workspace is checked
// against that list:
//
//   - chat tools: the board reads (list_objectives / get_objective /
//     board_briefing / card chips), create_objective, the knowledge-base tools,
//     secrets and workspace MCP servers (tools.ts, engine.ts);
//   - High Agency: the wake workspace must be granted, a revoke switches the
//     wake off, and a wake that still points at a revoked workspace is refused
//     at fire time (high-agency.ts, routine-scheduler.ts);
//   - cards a High Agency wake files must land in a granted workspace
//     (routes/internal-create.ts).
//
// The list never WIDENS anything. A bot acts for the person chatting with it,
// so what it may reach is (the person's own access) ∩ (the bot's list). Workspace
// access grants no connector, no secret, no merge / deploy / send right: those
// stay where they were (the bot's tools, the secrets broker's per-workspace
// grants, the owner's approvals).
//
// ## Three states, and what happens to existing bots
//
//   restricted   — a row with mode 'restricted': the bot may use exactly the
//                  workspaces in agent_chat_bot_workspaces (ones that still
//                  exist). An EMPTY list means no workspace at all: chat still
//                  answers, but every board / knowledge-base / secrets / MCP
//                  tool refuses and High Agency cannot wake.
//   unrestricted — a row with mode 'unrestricted'. Written ONLY by the one-time
//                  boot migration for bots that already existed when this
//                  shipped, so nothing that works today breaks: the bot keeps
//                  today's behaviour (bounded by the person chatting with it).
//                  No workspace is granted for it — the list stays empty and the
//                  UI flags the bot as "not restricted yet" until an admin
//                  restricts it. There is no route back to unrestricted:
//                  tightening is one-way.
//   no row       — a bot that appeared AFTER the migration (a new agent file, a
//                  template install). Fail-closed: treated as restricted with an
//                  empty list until an admin grants a workspace.
//
// This module only touches the DB, so the routine scheduler can import it
// without pulling the chat engine in.
import { getDb } from '../../db/index.js'

export const WORKSPACE_SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i

/** settings key of the one-time "existing bots keep today's access" migration. */
export const SEED_MARKER = 'bot_workspace_access_seeded_at'

export type BotAccessMode = 'restricted' | 'unrestricted'

export interface BotWorkspaceGrant {
  workspace: string
  granted_by: string | null
  granted_at: string
}

export interface BotWorkspaceAccess {
  slug: string
  /** 'unrestricted' only for a bot that predates access lists and was never restricted. */
  mode: BotAccessMode
  /** False = no row: a bot added after the migration, fail-closed. */
  configured: boolean
  /** Granted workspaces that still exist, in slug order. */
  workspaces: string[]
  grants: BotWorkspaceGrant[]
  updated_by: string | null
  updated_at: string | null
}

export class BotWorkspaceError extends Error {
  readonly status: number
  constructor(message: string, status = 400) {
    super(message)
    this.status = status
  }
}

interface AccessRow { slug: string; mode: string; updated_by: string | null; updated_at: string }

function existingWorkspaces(): Set<string> {
  try {
    return new Set((getDb().prepare('SELECT slug FROM workspaces').all() as { slug: string }[]).map(r => r.slug))
  } catch {
    return new Set()
  }
}

export function getBotWorkspaceAccess(slug: string): BotWorkspaceAccess {
  const db = getDb()
  const row = db.prepare('SELECT * FROM agent_chat_bot_access WHERE slug = ?').get(slug) as AccessRow | undefined
  const exists = existingWorkspaces()
  const grants = (db
    .prepare('SELECT workspace, granted_by, granted_at FROM agent_chat_bot_workspaces WHERE slug = ? ORDER BY workspace')
    .all(slug) as BotWorkspaceGrant[])
    // A deleted workspace is not access to anything; it drops out of the list.
    .filter(g => exists.has(g.workspace))
  return {
    slug,
    mode: row?.mode === 'unrestricted' ? 'unrestricted' : 'restricted',
    configured: !!row,
    workspaces: grants.map(g => g.workspace),
    grants,
    updated_by: row?.updated_by ?? null,
    updated_at: row?.updated_at ?? null,
  }
}

/** Every bot's access in one read (for the bot list). Bots with no row are absent → restricted, empty. */
export function allBotWorkspaceAccess(): Map<string, Pick<BotWorkspaceAccess, 'mode' | 'workspaces' | 'configured'>> {
  const db = getDb()
  const exists = existingWorkspaces()
  const out = new Map<string, Pick<BotWorkspaceAccess, 'mode' | 'workspaces' | 'configured'>>()
  for (const r of db.prepare('SELECT slug, mode FROM agent_chat_bot_access').all() as { slug: string; mode: string }[]) {
    out.set(r.slug, { mode: r.mode === 'unrestricted' ? 'unrestricted' : 'restricted', workspaces: [], configured: true })
  }
  for (const g of db.prepare('SELECT slug, workspace FROM agent_chat_bot_workspaces ORDER BY workspace').all() as { slug: string; workspace: string }[]) {
    if (!exists.has(g.workspace)) continue
    const cur = out.get(g.slug) ?? { mode: 'restricted' as const, workspaces: [], configured: false }
    cur.workspaces.push(g.workspace)
    out.set(g.slug, cur)
  }
  return out
}

/**
 * The bot's workspace allowlist for an access check. `null` = unrestricted
 * (a pre-existing bot nobody has restricted yet: today's behaviour). An empty
 * array = no workspace at all. Fails CLOSED: a read error is "no workspace".
 */
export function botWorkspaceAllowlist(slug: string): string[] | null {
  try {
    const a = getBotWorkspaceAccess(slug)
    return a.mode === 'unrestricted' ? null : a.workspaces
  } catch {
    return []
  }
}

/** May this bot work in `workspace`? (The person's own access is checked separately.) */
export function botMayUseWorkspace(slug: string, workspace: string | null | undefined): boolean {
  if (!workspace) return false
  const allow = botWorkspaceAllowlist(slug)
  if (allow === null) return true
  return allow.includes(workspace)
}

/** Narrow a list of workspaces the person can reach to the ones this bot may use, keeping order. */
export function narrowToBot(slug: string, workspaces: string[]): string[] {
  const allow = botWorkspaceAllowlist(slug)
  return allow === null ? workspaces : workspaces.filter(w => allow.includes(w))
}

function upsertMode(slug: string, mode: BotAccessMode, actor: string | null): void {
  getDb()
    .prepare(
      `INSERT INTO agent_chat_bot_access (slug, mode, updated_by, updated_at) VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(slug) DO UPDATE SET mode = excluded.mode, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    )
    .run(slug, mode, actor)
}

function assertWorkspace(workspace: unknown): string {
  if (typeof workspace !== 'string' || !WORKSPACE_SLUG_RE.test(workspace)) throw new BotWorkspaceError('workspace must be a workspace slug')
  if (!existingWorkspaces().has(workspace)) throw new BotWorkspaceError(`There is no workspace "${workspace}" on this install`, 404)
  return workspace
}

/**
 * Grant one workspace. Granting to an unrestricted bot RESTRICTS it: from now
 * on it may use exactly the granted workspaces (this one, plus any granted
 * later). That is the "tighten" step for a bot that predates access lists.
 */
export function grantBotWorkspace(slug: string, workspace: unknown, actor: string): { access: BotWorkspaceAccess; changed: boolean; restrictedNow: boolean } {
  const ws = assertWorkspace(workspace)
  const db = getDb()
  const before = getBotWorkspaceAccess(slug)
  const changed = db.transaction(() => {
    upsertMode(slug, 'restricted', actor)
    return db
      .prepare('INSERT OR IGNORE INTO agent_chat_bot_workspaces (slug, workspace, granted_by) VALUES (?, ?, ?)')
      .run(slug, ws, actor).changes > 0
  })()
  return { access: getBotWorkspaceAccess(slug), changed, restrictedNow: before.mode === 'unrestricted' }
}

/**
 * Revoke one workspace. The bot stays restricted, so revoking the last one
 * leaves it with NO workspace (never falls back to unrestricted). Revoking from
 * an unrestricted bot is refused: it has no list to remove from yet.
 */
export function revokeBotWorkspace(slug: string, workspace: unknown, actor: string): { access: BotWorkspaceAccess; changed: boolean } {
  if (typeof workspace !== 'string' || !WORKSPACE_SLUG_RE.test(workspace)) throw new BotWorkspaceError('workspace must be a workspace slug')
  const before = getBotWorkspaceAccess(slug)
  if (before.mode === 'unrestricted') {
    throw new BotWorkspaceError('This bot is not restricted yet. Grant the workspaces it may use (or set its list) — every other workspace is then off for it.', 409)
  }
  const db = getDb()
  const changed = db.transaction(() => {
    upsertMode(slug, 'restricted', actor)
    return db.prepare('DELETE FROM agent_chat_bot_workspaces WHERE slug = ? AND workspace = ?').run(slug, workspace).changes > 0
  })()
  return { access: getBotWorkspaceAccess(slug), changed }
}

/**
 * Replace the whole list (the panel's "Restrict to these workspaces"). Always
 * leaves the bot restricted; an empty list = no workspace.
 */
export function setBotWorkspaces(slug: string, workspaces: unknown, actor: string): { access: BotWorkspaceAccess; added: string[]; removed: string[] } {
  if (!Array.isArray(workspaces)) throw new BotWorkspaceError('workspaces must be a list of workspace slugs')
  const wanted = [...new Set(workspaces.map(assertWorkspace))]
  const db = getDb()
  const before = getBotWorkspaceAccess(slug)
  const current = new Set(before.workspaces)
  const added = wanted.filter(w => !current.has(w))
  const removed = before.workspaces.filter(w => !wanted.includes(w))
  db.transaction(() => {
    upsertMode(slug, 'restricted', actor)
    for (const w of removed) db.prepare('DELETE FROM agent_chat_bot_workspaces WHERE slug = ? AND workspace = ?').run(slug, w)
    for (const w of added) db.prepare('INSERT OR IGNORE INTO agent_chat_bot_workspaces (slug, workspace, granted_by) VALUES (?, ?, ?)').run(slug, w, actor)
  })()
  return { access: getBotWorkspaceAccess(slug), added, removed }
}

/**
 * The one-time migration: every bot that exists the first time this code boots
 * keeps today's access ('unrestricted', no grants). Runs once per install
 * (marker in settings), so a bot added later starts fail-closed. Returns how
 * many bots were marked.
 */
export function seedExistingBotsOnce(slugs: string[]): number {
  const db = getDb()
  const done = db.prepare('SELECT value FROM settings WHERE key = ?').get(SEED_MARKER) as { value: string } | undefined
  if (done) return 0
  // An empty list is a failed agent load, not "no bots": do not burn the
  // one-time marker on it, or every existing bot would wake up fail-closed.
  if (slugs.length === 0) return 0
  let n = 0
  db.transaction(() => {
    const ins = db.prepare("INSERT OR IGNORE INTO agent_chat_bot_access (slug, mode, updated_by) VALUES (?, 'unrestricted', 'migration')")
    for (const s of new Set(slugs)) n += ins.run(s).changes
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(SEED_MARKER, new Date().toISOString())
  })()
  return n
}

/**
 * Drop a bot's access row and grants (a deleted bot, obj 900798). A later bot
 * that reuses the slug, or the same bot moved back by hand, then has no row and
 * starts fail-closed rather than inheriting the old list or 'unrestricted'.
 */
export function forgetBotWorkspaceAccess(slug: string): void {
  const db = getDb()
  db.transaction(() => {
    db.prepare('DELETE FROM agent_chat_bot_workspaces WHERE slug = ?').run(slug)
    db.prepare('DELETE FROM agent_chat_bot_access WHERE slug = ?').run(slug)
  })()
}

// ── High Agency wakes (fire-time guard) ──

const HIGH_AGENCY_PREFIX = 'high-agency:'

/** The bot slug of a `high-agency:<slug>` routine, else null. */
export function highAgencyRoutineSlug(name: string | null | undefined): string | null {
  return typeof name === 'string' && name.startsWith(HIGH_AGENCY_PREFIX) ? name.slice(HIGH_AGENCY_PREFIX.length) || null : null
}

/**
 * Why a High Agency wake must NOT fire, or null when it may. A wake files a card
 * in its template's workspace; that workspace has to be one the bot is granted.
 * The reason starts with 'bot workspace guard' so the auto-pause streak treats
 * it as a refusal (nothing ran), not a failure.
 */
export function highAgencyFireRefusal(routine: { name: string; objective_template: string | null }): string | null {
  const slug = highAgencyRoutineSlug(routine.name)
  if (!slug) return null
  // An unrestricted bot (predates access lists) wakes exactly as before.
  if (botWorkspaceAllowlist(slug) === null) return null
  let ws: string | null = null
  try {
    const tpl = JSON.parse(routine.objective_template || '{}') as { workspace?: unknown }
    ws = typeof tpl.workspace === 'string' && tpl.workspace ? tpl.workspace : null
  } catch { /* unreadable template → no workspace → refused below */ }
  if (botMayUseWorkspace(slug, ws)) return null
  return ws
    ? `bot workspace guard: bot "${slug}" is not granted workspace "${ws}"`
    : `bot workspace guard: bot "${slug}" wake has no workspace`
}
