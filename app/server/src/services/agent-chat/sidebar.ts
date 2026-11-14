// ── The Bots sidebar: pins, sections, previews, unread (obj 900798) ──
//
// Everything here is ONE person's view of the bot list. Nothing in this file
// changes a bot, another person's sidebar, or any conversation: pinning,
// sections, hiding and read state are per (person, bot) rows in
// agent_chat_sidebar_bots / agent_chat_sidebar_sections. A person with no rows
// sees the defaults (nothing pinned, no sections, nothing hidden).
//
// UNREAD, and why it agrees with side threads (obj 900370). A bot has a main
// conversation plus side threads. A bot is unread when ANY open lane holds an
// assistant message newer than both
//   - the person's last_read_message_id for that bot (set by opening the bot), and
//   - the person's own most recent message IN THAT LANE (replying is reading),
// or when the person marked it unread. Archived (closed) side threads are left
// out of the count and the preview, the same way they are left out of the lane
// strip.
//
// BACK-COMPAT. Every conversation that already exists ends on a bot reply, so
// a read marker starting at 0 would light up every bot the moment this ships.
// Instead a person's row is created with last_read_message_id = their newest
// message with that bot at that moment (ensureRows): history from before the
// sidebar existed counts as read, and only what arrives afterwards is unread.
import { getDb } from '../../db/index.js'

export class SidebarRejected extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

export const MAX_SECTIONS = 20
export const MAX_SECTION_NAME = 40
export const MAX_PINS = 12
const PREVIEW_CHARS = 140

export interface SidebarSection {
  id: number
  name: string
  position: number
  collapsed: boolean
}

export interface SidebarLastMessage {
  id: number
  role: 'user' | 'assistant'
  preview: string
  created_at: string
  /** Set when the newest message is in a side thread rather than the main conversation. */
  thread_id: number | null
  thread_title: string | null
}

export interface SidebarBot {
  pinned: boolean
  pin_position: number
  section_id: number | null
  hidden: boolean
  /** The person pressed "Mark as unread". */
  marked_unread: boolean
  /** Unanswered, unopened assistant replies across the main conversation and open side threads. */
  unread_count: number
  unread: boolean
  last_message: SidebarLastMessage | null
}

export interface SidebarState {
  sections: SidebarSection[]
  bots: Record<string, SidebarBot>
  max_pins: number
  max_sections: number
}

interface PrefRow {
  agent_slug: string
  pinned: number
  pin_position: number
  section_id: number | null
  hidden: number
  marked_unread: number
  last_read_message_id: number
}

interface SectionRow {
  id: number
  name: string
  position: number
  collapsed: number
}

const mapSection = (r: SectionRow): SidebarSection => ({ id: r.id, name: r.name, position: r.position, collapsed: Number(r.collapsed) === 1 })

/** Plain one-line preview text: markdown markers and runs of whitespace flattened, then clipped. */
export function previewText(content: string): string {
  const flat = content
    .replace(/```[\s\S]*?```/g, ' [code] ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    // Heading / quote markers only at the start of a line, so "#4" and "a > b" survive.
    .replace(/^[ \t]{0,3}(#{1,6}|>)[ \t]?/gm, '')
    .replace(/^[ \t]*[*+-][ \t]+/gm, '')
    .replace(/(\*\*|__|~~|`)/g, '')
    .replace(/(^|[\s(])[*_](\S)/g, '$1$2')
    .replace(/(\S)[*_](?=[\s).,!?:;]|$)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
  return flat.length > PREVIEW_CHARS ? `${flat.slice(0, PREVIEW_CHARS - 1).trimEnd()}…` : flat
}

export function listSections(userId: number): SidebarSection[] {
  const rows = getDb()
    .prepare('SELECT id, name, position, collapsed FROM agent_chat_sidebar_sections WHERE user_id = ? ORDER BY position, id')
    .all(userId) as SectionRow[]
  return rows.map(mapSection)
}

/** Unread replies per bot slug for this person (see the header for the rule). */
export function unreadCounts(userId: number): Map<string, number> {
  const rows = getDb()
    .prepare(
      `SELECT m.agent_slug AS slug, COUNT(*) AS n
         FROM agent_chat_messages m
         LEFT JOIN agent_chat_threads t ON t.id = m.thread_id
         LEFT JOIN agent_chat_sidebar_bots p ON p.user_id = m.user_id AND p.agent_slug = m.agent_slug
        WHERE m.user_id = ?
          AND m.role = 'assistant'
          AND (m.thread_id IS NULL OR t.archived = 0)
          AND m.id > COALESCE(p.last_read_message_id, 0)
          AND m.id > COALESCE((
                SELECT MAX(u.id) FROM agent_chat_messages u
                 WHERE u.user_id = m.user_id AND u.agent_slug = m.agent_slug
                   AND u.thread_id IS m.thread_id AND u.role = 'user'
              ), 0)
        GROUP BY m.agent_slug`,
    )
    .all(userId) as { slug: string; n: number }[]
  return new Map(rows.map(r => [r.slug, Number(r.n)]))
}

/** The newest user/assistant message per bot, over the main conversation and open side threads. */
export function lastMessages(userId: number): Map<string, SidebarLastMessage> {
  const rows = getDb()
    .prepare(
      `SELECT m.id, m.agent_slug, m.role, m.content, m.created_at, m.thread_id, t.title AS thread_title,
              (SELECT COUNT(*) FROM agent_chat_attachments a WHERE a.message_id = m.id) AS images
         FROM agent_chat_messages m
         LEFT JOIN agent_chat_threads t ON t.id = m.thread_id
        WHERE m.id IN (
          SELECT MAX(m2.id) FROM agent_chat_messages m2
            LEFT JOIN agent_chat_threads t2 ON t2.id = m2.thread_id
           WHERE m2.user_id = ? AND m2.role IN ('user', 'assistant')
             AND (m2.thread_id IS NULL OR t2.archived = 0)
           GROUP BY m2.agent_slug
        )`,
    )
    .all(userId) as {
      id: number
      agent_slug: string
      role: 'user' | 'assistant'
      content: string
      created_at: string
      thread_id: number | null
      thread_title: string | null
      images: number
    }[]
  const out = new Map<string, SidebarLastMessage>()
  for (const r of rows) {
    let preview = previewText(r.content ?? '')
    if (!preview && Number(r.images) > 0) preview = Number(r.images) === 1 ? 'Sent an image' : `Sent ${r.images} images`
    out.set(r.agent_slug, {
      id: r.id,
      role: r.role,
      preview,
      created_at: r.created_at,
      thread_id: r.thread_id ?? null,
      thread_title: r.thread_id == null ? null : r.thread_title ?? null,
    })
  }
  return out
}

/** The person's whole sidebar, for the bots that exist now. A row for a bot that is gone is ignored. */
export function sidebarState(userId: number, slugs: string[]): SidebarState {
  const db = getDb()
  const existing = new Set(
    (db.prepare('SELECT agent_slug FROM agent_chat_sidebar_bots WHERE user_id = ?').all(userId) as { agent_slug: string }[]).map(r => r.agent_slug),
  )
  ensureRows(userId, slugs.filter(s => !existing.has(s)))
  const prefs = new Map(
    (db
      .prepare('SELECT agent_slug, pinned, pin_position, section_id, hidden, marked_unread, last_read_message_id FROM agent_chat_sidebar_bots WHERE user_id = ?')
      .all(userId) as PrefRow[]).map(r => [r.agent_slug, r]),
  )
  const sections = listSections(userId)
  const known = new Set(sections.map(s => s.id))
  const unread = unreadCounts(userId)
  const last = lastMessages(userId)
  const bots: Record<string, SidebarBot> = {}
  for (const slug of slugs) {
    const p = prefs.get(slug)
    const count = unread.get(slug) ?? 0
    const marked = Number(p?.marked_unread ?? 0) === 1
    bots[slug] = {
      pinned: Number(p?.pinned ?? 0) === 1,
      pin_position: Number(p?.pin_position ?? 0),
      section_id: p?.section_id != null && known.has(p.section_id) ? p.section_id : null,
      hidden: Number(p?.hidden ?? 0) === 1,
      marked_unread: marked,
      unread_count: count,
      unread: marked || count > 0,
      last_message: last.get(slug) ?? null,
    }
  }
  return { sections, bots, max_pins: MAX_PINS, max_sections: MAX_SECTIONS }
}

/**
 * Create the person's row for these bots if it is missing, with everything
 * they have so far counted as read (see BACK-COMPAT above). An existing row is
 * never touched.
 */
export function ensureRows(userId: number, slugs: string[]): void {
  if (slugs.length === 0) return
  const db = getDb()
  const insert = db.prepare(
    `INSERT OR IGNORE INTO agent_chat_sidebar_bots (user_id, agent_slug, last_read_message_id)
     VALUES (?, ?, (SELECT COALESCE(MAX(id), 0) FROM agent_chat_messages WHERE user_id = ? AND agent_slug = ?))`,
  )
  db.transaction(() => { for (const slug of slugs) insert.run(userId, slug, userId, slug) })()
}

function ensureRow(userId: number, slug: string): void {
  ensureRows(userId, [slug])
}

function sectionOwned(userId: number, id: number): SectionRow {
  const r = getDb().prepare('SELECT id, name, position, collapsed FROM agent_chat_sidebar_sections WHERE id = ? AND user_id = ?').get(id, userId) as
    | SectionRow
    | undefined
  // 404, not 403: whether someone else's section id exists is none of the caller's business.
  if (!r) throw new SidebarRejected(404, 'No such section')
  return r
}

export interface BotPrefsPatch {
  pinned?: unknown
  section_id?: unknown
  hidden?: unknown
}

/**
 * Pin / unpin, move to a section (null = "Other bots"), hide / show. Only the
 * fields present change. Pinning a hidden bot shows it again; hiding a bot
 * also unpins it, so the rail never holds a bot the sidebar says is hidden.
 */
export function updateBotPrefs(userId: number, slug: string, patch: BotPrefsPatch): void {
  const db = getDb()
  if (patch.pinned !== undefined && typeof patch.pinned !== 'boolean') throw new SidebarRejected(400, 'pinned must be true or false')
  if (patch.hidden !== undefined && typeof patch.hidden !== 'boolean') throw new SidebarRejected(400, 'hidden must be true or false')
  let sectionId: number | null | undefined
  if (patch.section_id !== undefined) {
    if (patch.section_id === null) sectionId = null
    else if (typeof patch.section_id === 'number' && Number.isInteger(patch.section_id)) sectionId = sectionOwned(userId, patch.section_id).id
    else throw new SidebarRejected(400, 'section_id must be a section id or null')
  }
  db.transaction(() => {
    ensureRow(userId, slug)
    const cur = db.prepare('SELECT pinned FROM agent_chat_sidebar_bots WHERE user_id = ? AND agent_slug = ?').get(userId, slug) as { pinned: number }
    if (patch.pinned === true && Number(cur.pinned) !== 1) {
      const { n } = db.prepare('SELECT COUNT(*) AS n FROM agent_chat_sidebar_bots WHERE user_id = ? AND pinned = 1').get(userId) as { n: number }
      if (Number(n) >= MAX_PINS) throw new SidebarRejected(409, `You can pin up to ${MAX_PINS} bots. Unpin one first.`)
      const { p } = db.prepare('SELECT COALESCE(MAX(pin_position), -1) + 1 AS p FROM agent_chat_sidebar_bots WHERE user_id = ? AND pinned = 1').get(userId) as { p: number }
      db.prepare("UPDATE agent_chat_sidebar_bots SET pinned = 1, pin_position = ?, hidden = 0, updated_at = datetime('now') WHERE user_id = ? AND agent_slug = ?").run(p, userId, slug)
    } else if (patch.pinned === false) {
      db.prepare("UPDATE agent_chat_sidebar_bots SET pinned = 0, pin_position = 0, updated_at = datetime('now') WHERE user_id = ? AND agent_slug = ?").run(userId, slug)
    }
    if (patch.hidden === true) {
      db.prepare("UPDATE agent_chat_sidebar_bots SET hidden = 1, pinned = 0, pin_position = 0, updated_at = datetime('now') WHERE user_id = ? AND agent_slug = ?").run(userId, slug)
    } else if (patch.hidden === false) {
      db.prepare("UPDATE agent_chat_sidebar_bots SET hidden = 0, updated_at = datetime('now') WHERE user_id = ? AND agent_slug = ?").run(userId, slug)
    }
    if (sectionId !== undefined) {
      db.prepare("UPDATE agent_chat_sidebar_bots SET section_id = ?, updated_at = datetime('now') WHERE user_id = ? AND agent_slug = ?").run(sectionId, userId, slug)
    }
  })()
}

/** Opening a bot reads it: every message so far (all lanes) is read, and "Mark as unread" is cleared. */
export function markRead(userId: number, slug: string): void {
  const db = getDb()
  const { last } = db.prepare('SELECT COALESCE(MAX(id), 0) AS last FROM agent_chat_messages WHERE user_id = ? AND agent_slug = ?').get(userId, slug) as {
    last: number
  }
  ensureRow(userId, slug)
  db.prepare(
    `UPDATE agent_chat_sidebar_bots SET marked_unread = 0, last_read_message_id = MAX(last_read_message_id, ?), updated_at = datetime('now')
      WHERE user_id = ? AND agent_slug = ?`,
  ).run(Number(last), userId, slug)
}

export function markUnread(userId: number, slug: string): void {
  ensureRow(userId, slug)
  getDb().prepare("UPDATE agent_chat_sidebar_bots SET marked_unread = 1, updated_at = datetime('now') WHERE user_id = ? AND agent_slug = ?").run(userId, slug)
}

function sectionName(v: unknown): string {
  if (typeof v !== 'string') throw new SidebarRejected(400, 'name is required')
  // eslint-disable-next-line no-control-regex
  const n = v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
  if (!n) throw new SidebarRejected(400, 'name is required')
  if (n.length > MAX_SECTION_NAME) throw new SidebarRejected(400, `A section name is at most ${MAX_SECTION_NAME} characters`)
  return n
}

export function createSection(userId: number, rawName: unknown): SidebarSection {
  const db = getDb()
  const name = sectionName(rawName)
  return db.transaction(() => {
    const { n, p } = db
      .prepare('SELECT COUNT(*) AS n, COALESCE(MAX(position), -1) + 1 AS p FROM agent_chat_sidebar_sections WHERE user_id = ?')
      .get(userId) as { n: number; p: number }
    if (Number(n) >= MAX_SECTIONS) throw new SidebarRejected(409, `You can have up to ${MAX_SECTIONS} sections.`)
    const id = Number(db.prepare('INSERT INTO agent_chat_sidebar_sections (user_id, name, position) VALUES (?, ?, ?)').run(userId, name, p).lastInsertRowid)
    return mapSection(sectionOwned(userId, id))
  })()
}

export function updateSection(userId: number, id: number, patch: { name?: unknown; collapsed?: unknown }): SidebarSection {
  const db = getDb()
  sectionOwned(userId, id)
  if (patch.collapsed !== undefined && typeof patch.collapsed !== 'boolean') throw new SidebarRejected(400, 'collapsed must be true or false')
  const name = patch.name !== undefined ? sectionName(patch.name) : undefined
  if (name !== undefined) db.prepare("UPDATE agent_chat_sidebar_sections SET name = ?, updated_at = datetime('now') WHERE id = ?").run(name, id)
  if (patch.collapsed !== undefined) {
    db.prepare("UPDATE agent_chat_sidebar_sections SET collapsed = ?, updated_at = datetime('now') WHERE id = ?").run(patch.collapsed ? 1 : 0, id)
  }
  return mapSection(sectionOwned(userId, id))
}

/**
 * Put the person's sections in this order. The list must name every one of
 * their sections exactly once: a partial list is refused rather than guessed
 * at, so two tabs reordering at once cannot silently drop a section's place.
 */
export function reorderSections(userId: number, ids: unknown): SidebarSection[] {
  const db = getDb()
  if (!Array.isArray(ids) || !ids.every(x => typeof x === 'number' && Number.isInteger(x))) {
    throw new SidebarRejected(400, 'ids must be a list of section ids')
  }
  const mine = listSections(userId).map(s => s.id)
  const asked = ids as number[]
  if (asked.length !== mine.length || new Set(asked).size !== asked.length || !asked.every(id => mine.includes(id))) {
    throw new SidebarRejected(409, 'The list must name each of your sections once. Reload and try again.')
  }
  const set = db.prepare("UPDATE agent_chat_sidebar_sections SET position = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?")
  db.transaction(() => asked.forEach((id, i) => set.run(i, id, userId)))()
  return listSections(userId)
}

/** Delete a section. Its bots are NOT deleted or hidden — they move back to "Other bots". */
export function deleteSection(userId: number, id: number): { moved: number } {
  const db = getDb()
  sectionOwned(userId, id)
  return db.transaction(() => {
    const moved = db
      .prepare("UPDATE agent_chat_sidebar_bots SET section_id = NULL, updated_at = datetime('now') WHERE user_id = ? AND section_id = ?")
      .run(userId, id).changes
    db.prepare('DELETE FROM agent_chat_sidebar_sections WHERE id = ? AND user_id = ?').run(id, userId)
    return { moved }
  })()
}

/** Reorder the pinned rail. Same whole-list rule as sections. */
export function reorderPins(userId: number, slugs: unknown): void {
  const db = getDb()
  if (!Array.isArray(slugs) || !slugs.every(x => typeof x === 'string')) throw new SidebarRejected(400, 'slugs must be a list of bot ids')
  const pinned = (db.prepare('SELECT agent_slug FROM agent_chat_sidebar_bots WHERE user_id = ? AND pinned = 1').all(userId) as { agent_slug: string }[]).map(
    r => r.agent_slug,
  )
  const asked = slugs as string[]
  if (asked.length !== pinned.length || new Set(asked).size !== asked.length || !asked.every(s => pinned.includes(s))) {
    throw new SidebarRejected(409, 'The list must name each pinned bot once. Reload and try again.')
  }
  const set = db.prepare("UPDATE agent_chat_sidebar_bots SET pin_position = ?, updated_at = datetime('now') WHERE user_id = ? AND agent_slug = ?")
  db.transaction(() => asked.forEach((s, i) => set.run(i, userId, s)))()
}

/** A bot was deleted for everyone: drop every person's sidebar row for it (not their chat history). */
export function forgetBotEverywhere(slug: string): number {
  return getDb().prepare('DELETE FROM agent_chat_sidebar_bots WHERE agent_slug = ?').run(slug).changes
}
