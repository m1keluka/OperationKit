// ── Bot side threads / concurrent task lanes (obj 900370) ──
//
// A (person, bot) pair used to be exactly ONE conversation. It is now a MAIN
// conversation plus any number of named SIDE THREADS, and each of those is a
// LANE: its own history, its own model context, its own in-flight slot, so two
// lanes of the same bot can be working at the same time.
//
// Reimplemented from observed behaviour only. The row shape is lifted from this
// install's own `mentor_threads` / `thread_folders` prior art (title, pinned,
// archived, last_active_at, timestamps) rather than inventing a third
// threading model, and NOTHING here is derived from any third-party source.
//
// ── the isolation invariant ──
//
// Every read and every write of `agent_chat_messages` is scoped by exactly one
// lane predicate, produced here by `lanePredicate()`:
//
//     main     →  thread_id IS NULL
//     thread N →  thread_id = N
//
// There is deliberately no predicate that spans lanes and no OR. Leaking thread
// A's message into thread B's context would take someone writing a NEW query
// that ignores this helper — it cannot happen by forgetting a filter, because a
// query without the filter does not compile into any of the call sites.
import { getDb } from '../../db/index.js'

/** Which conversation of a (person, bot) pair a message belongs to. */
export type ChatLane = { kind: 'main' } | { kind: 'thread'; id: number }

export const MAIN_LANE: ChatLane = { kind: 'main' }

/** Default ceiling on OPEN side threads per (person, bot). Archived never count. */
export const DEFAULT_MAX_THREADS_PER_BOT = 10
export const MAX_THREAD_TITLE = 120

export interface ChatThreadRow {
  id: number
  title: string
  pinned: boolean
  archived: boolean
  last_active_at: string | null
  created_at: string
  updated_at: string
  /** Messages in this lane — what the UI shows next to the title. */
  message_count: number
}

/** A rejected thread operation — routes turn this into a 400/409 a person can act on. */
export class ThreadRejected extends Error {
  constructor(message: string, readonly status = 400) {
    super(message)
  }
}

/**
 * The ONE place a lane becomes SQL. `params` is spread straight after the
 * (user_id, agent_slug) pair every caller already binds.
 */
export function lanePredicate(lane: ChatLane): { sql: string; params: number[] } {
  return lane.kind === 'main' ? { sql: 'thread_id IS NULL' as const, params: [] } : { sql: 'thread_id = ?' as const, params: [lane.id] }
}

/** The lane's id as stored on a message row: NULL for main. */
export function laneThreadId(lane: ChatLane): number | null {
  return lane.kind === 'main' ? null : lane.id
}

/** A stable key for the in-flight set, so lanes of one bot do not block each other. */
export function laneKey(lane: ChatLane): string {
  return lane.kind === 'main' ? 'main' : `t${lane.id}`
}

// ── settings ──

function setting(key: string): string | null {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
  return row?.value ?? null
}

/**
 * Per-bot lane ceiling (obj 900370). Read at the point of use, so an operator
 * can change it without a restart — the repo's standing convention for settings.
 * `0` or a negative number means "no ceiling".
 */
export function maxThreadsPerBot(): number {
  const raw = setting('agent_chat_max_threads_per_bot')
  if (raw === null || raw.trim() === '') return DEFAULT_MAX_THREADS_PER_BOT
  const n = Number(raw)
  return Number.isFinite(n) ? Math.trunc(n) : DEFAULT_MAX_THREADS_PER_BOT
}

// ── rows ──

function mapThread(r: Record<string, unknown>): ChatThreadRow {
  return {
    id: Number(r.id),
    title: String(r.title ?? 'Untitled'),
    pinned: Number(r.pinned) > 0,
    archived: Number(r.archived) > 0,
    last_active_at: (r.last_active_at as string) ?? null,
    created_at: String(r.created_at),
    updated_at: String(r.updated_at),
    message_count: Number(r.message_count ?? 0),
  }
}

const SELECT_THREADS = `
  SELECT t.*, (
    SELECT COUNT(*) FROM agent_chat_messages m WHERE m.thread_id = t.id
  ) AS message_count
  FROM agent_chat_threads t
  WHERE t.user_id = ? AND t.agent_slug = ?`

/**
 * This person's side threads for this bot. Open lanes first (pinned above the
 * rest, newest first within each group), archived last — "what am I running
 * right now" is the question this list answers.
 */
export function listThreads(userId: number, slug: string, opts: { includeArchived?: boolean } = {}): ChatThreadRow[] {
  const sql = `${SELECT_THREADS}${opts.includeArchived ? '' : ' AND t.archived = 0'}
    ORDER BY t.archived ASC, t.pinned DESC, t.id DESC`
  return (getDb().prepare(sql).all(userId, slug) as Record<string, unknown>[]).map(mapThread)
}

/** One thread, but ONLY if it belongs to this person AND this bot. */
export function getThread(userId: number, slug: string, id: number): ChatThreadRow | null {
  if (!Number.isInteger(id) || id <= 0) return null
  const r = getDb()
    .prepare(`${SELECT_THREADS} AND t.id = ?`)
    .get(userId, slug, id) as Record<string, unknown> | undefined
  return r ? mapThread(r) : null
}

export function countOpenThreads(userId: number, slug: string): number {
  const r = getDb()
    .prepare('SELECT COUNT(*) AS n FROM agent_chat_threads WHERE user_id = ? AND agent_slug = ? AND archived = 0')
    .get(userId, slug) as { n: number }
  return Number(r.n)
}

export function cleanThreadTitle(raw: unknown): string {
  const s = (typeof raw === 'string' ? raw : '').replace(/\s+/g, ' ').trim()
  return s.slice(0, MAX_THREAD_TITLE)
}

/**
 * Open a new side thread. The main conversation is never created here — it
 * exists implicitly for every (person, bot) and has no row.
 */
export function createThread(userId: number, slug: string, title: unknown): ChatThreadRow {
  const clean = cleanThreadTitle(title) || 'New side thread'
  const cap = maxThreadsPerBot()
  if (cap > 0 && countOpenThreads(userId, slug) >= cap) {
    throw new ThreadRejected(
      `You already have ${cap} open side ${cap === 1 ? 'thread' : 'threads'} with this bot. Close or archive one first.`,
      409,
    )
  }
  const info = getDb()
    .prepare("INSERT INTO agent_chat_threads (user_id, agent_slug, title, last_active_at) VALUES (?, ?, ?, datetime('now'))")
    .run(userId, slug, clean)
  const row = getThread(userId, slug, Number(info.lastInsertRowid))
  if (!row) throw new ThreadRejected('The side thread could not be opened.', 500)
  return row
}

export interface ThreadPatch {
  title?: unknown
  pinned?: unknown
  archived?: unknown
}

/**
 * Rename / pin / archive. Archiving is what "closing" a side thread means: the
 * lane stops showing in the open list, its messages are KEPT, and the main
 * conversation is not touched in any way.
 */
export function updateThread(userId: number, slug: string, id: number, patch: ThreadPatch): ChatThreadRow {
  const current = getThread(userId, slug, id)
  if (!current) throw new ThreadRejected('Side thread not found', 404)
  const sets: string[] = []
  const params: (string | number)[] = []
  if (patch.title !== undefined) {
    const clean = cleanThreadTitle(patch.title)
    if (!clean) throw new ThreadRejected('A side thread needs a name.')
    sets.push('title = ?')
    params.push(clean)
  }
  if (patch.pinned !== undefined) {
    sets.push('pinned = ?')
    params.push(patch.pinned === true || patch.pinned === 1 ? 1 : 0)
  }
  if (patch.archived !== undefined) {
    const next = patch.archived === true || patch.archived === 1 ? 1 : 0
    // Re-opening is capped the same way opening is, or the ceiling is a door
    // you can walk around by archiving and un-archiving.
    if (next === 0 && current.archived) {
      const cap = maxThreadsPerBot()
      if (cap > 0 && countOpenThreads(userId, slug) >= cap) {
        throw new ThreadRejected(`You already have ${cap} open side threads with this bot. Close one first.`, 409)
      }
    }
    sets.push('archived = ?')
    params.push(next)
  }
  if (sets.length === 0) return current
  getDb()
    .prepare(`UPDATE agent_chat_threads SET ${sets.join(', ')}, updated_at = datetime('now') WHERE id = ? AND user_id = ? AND agent_slug = ?`)
    .run(...params, id, userId, slug)
  return getThread(userId, slug, id) as ChatThreadRow
}

/**
 * Remove a side thread's ROW. The caller clears the lane's messages first
 * (`clearChat`); the `ON DELETE CASCADE` on `thread_id` is the backstop, not the
 * plan. The main conversation has no row and is therefore undeletable here —
 * which is the point.
 */
export function deleteThread(userId: number, slug: string, id: number): boolean {
  return (
    getDb().prepare('DELETE FROM agent_chat_threads WHERE id = ? AND user_id = ? AND agent_slug = ?').run(id, userId, slug).changes > 0
  )
}

/** Mark a lane as just-used. Main has no row, so this is a no-op for it. */
export function touchThread(lane: ChatLane): void {
  if (lane.kind !== 'thread') return
  getDb().prepare("UPDATE agent_chat_threads SET last_active_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(lane.id)
}

/**
 * Resolve the lane a request is talking about. A `thread_id` that is not this
 * person's, or belongs to a different bot, is NOT FOUND — never silently
 * treated as the main conversation, which would write one bot's lane message
 * into another's history.
 */
export function resolveLane(userId: number, slug: string, raw: unknown): ChatLane {
  if (raw === undefined || raw === null || raw === '' || raw === 'main') return MAIN_LANE
  const id = Number(raw)
  if (!Number.isInteger(id) || id <= 0) throw new ThreadRejected('thread_id must be a side thread id, or omitted for the main conversation.')
  if (!getThread(userId, slug, id)) throw new ThreadRejected('Side thread not found', 404)
  return { kind: 'thread', id }
}
