/**
 * Results go back to the conversation that asked (obj 900323, gates G7/G8).
 *
 * A chat-created card today has NO path home: `agent_chat_cards` records which
 * thread filed it, and nothing ever reads that on completion. The person is
 * told "card #123 is on the board" and then hears nothing, forever, unless they
 * ask again. Obj 900309's webhook notifications cannot cover this — they JOIN
 * `objectives.agent_key_id`, which is NULL for every chat-created card, so that
 * path can never reach one. This module is the missing edge, and because it
 * keys on `bot_job_origins` (not on agent keys) the two paths are disjoint by
 * construction: no card can be delivered twice, and nothing here re-implements
 * or weakens the opt-in/dedupe contract 900309 established.
 *
 * Two steps, same shape as the webhook outbox so the dedupe reasoning is the
 * one that is already proven:
 *
 *  1. `enqueueBotThreadDeliveries` — scan new `objective_events` past a cursor,
 *     classify, `INSERT OR IGNORE` a row whose `delivery_id` is DETERMINISTIC
 *     (`bot_<kind>_<objective>`). PRIMARY KEY does the deduping, so a replayed
 *     event, a reopen→done cycle, two overlapping ticks and a restart mid-tick
 *     all collapse to ONE message. The first run anchors the cursor at the
 *     current head, so turning this on never replays history into somebody's
 *     chat.
 *  2. `deliverBotThreadMessages` — drain pending rows into
 *     `agent_chat_messages` for the ORIGINATING (user, agent) thread. Delivery
 *     is a local DB insert, so there is no network, no retry storm and no
 *     outbound surface; a failure marks the row and leaves the text alone.
 *
 * The body is assembled from FINAL values only (title, status, summary, PR
 * url). The worker's private scratch is never read — a thread message is the
 * deliverable's statement, not the worker's opinion of itself.
 */
import type { Database } from 'better-sqlite3'
import { redactLive } from '../live-redaction.js'

const CURSOR_SETTING = 'bot_thread_delivery_cursor'
const BATCH = 200

export type ThreadDeliveryKind = 'completed' | 'blocked' | 'clarification'

export interface ThreadDeliveryRow {
  delivery_id: string
  objective_id: number
  thread_user_id: number
  thread_agent_slug: string
  kind: string
  body: string
  status: string
  message_id: number | null
  last_error: string | null
  created_at: string
  delivered_at: string | null
}

/** Deterministic, and that IS the dedupe. One per (card, kind), for the card's whole life. */
export function threadDeliveryId(kind: ThreadDeliveryKind, objectiveId: number): string {
  return `bot_${kind}_${objectiveId}`
}

interface EventRow {
  id: number
  objective_id: number
  kind: string
  from_value: string | null
  to_value: string | null
  detail: string | null
  title: string
  status: string
  pr_url: string | null
  summary: string | null
  deleted_at: string | null
  thread_user_id: number
  thread_agent_slug: string
  owner_bot: string
}

/**
 * Which events are worth interrupting a person for.
 *
 * `completed` — the card reached a terminal `done`. `blocked` — it needs the
 * person (that is the clarification case: a worker that cannot proceed). A
 * `cancelled` card is NOT a completion and says nothing shipped; it is
 * reported as blocked so the thread still learns the job stopped.
 */
export function classifyThreadEvent(ev: { kind: string; to_value: string | null; deleted_at?: string | null }): ThreadDeliveryKind | null {
  if (ev.deleted_at) return null
  if (ev.kind === 'status' && ev.to_value === 'done') return 'completed'
  if (ev.kind === 'status' && ev.to_value === 'cancelled') return 'blocked'
  if (ev.kind === 'blocked' || ev.kind === 'needs_secret') return 'clarification'
  return null
}

export function buildThreadBody(kind: ThreadDeliveryKind, row: Pick<EventRow, 'objective_id' | 'title' | 'status' | 'pr_url' | 'summary'>): string {
  const summary = (row.summary ?? '').trim()
  // A completion with NOTHING to show must not read like a result (obj 900322's
  // truthful no-output rule). The thread message is the only thing the person
  // sees, so "finished" over an empty body would put the lie in its most
  // load-bearing position.
  const head =
    kind === 'completed'
      ? summary
        ? `Your job finished — card #${row.objective_id} "${row.title}".`
        : `Card #${row.objective_id} "${row.title}" reached done but reported NO output. Nothing was produced to show you — open the card before treating this as a result.`
      : kind === 'blocked'
        ? `Your job stopped — card #${row.objective_id} "${row.title}" is now ${row.status}.`
        : `Card #${row.objective_id} "${row.title}" needs something from you before it can go on.`
  const lines = [head]
  if (summary) lines.push('', summary.slice(0, 4000))
  if (row.pr_url) lines.push('', `Pull request: ${row.pr_url}`)
  lines.push('', `Open the card: /o/${row.objective_id}`)
  // Redact LAST, over the assembled text, through the same function the live
  // artifact API already uses (services/live-redaction.ts) rather than a second
  // copy of the rules. A worker summary is untrusted text that may quote a key.
  return redactLive(lines.join('\n')).text
}

function readCursor(db: Database): number | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(CURSOR_SETTING) as { value: string } | undefined
  if (!row) return null
  const n = Number(row.value)
  return Number.isFinite(n) && n >= 0 ? n : null
}

function writeCursor(db: Database, v: number): void {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(CURSOR_SETTING, String(v))
}

/** Queue thread messages for new events. Returns how many rows were queued. */
export function enqueueBotThreadDeliveries(db: Database): number {
  return db.transaction((): number => {
    const head = (db.prepare('SELECT COALESCE(MAX(id), 0) AS head FROM objective_events').get() as { head: number }).head
    const cursor = readCursor(db)
    if (cursor === null) {
      writeCursor(db, head)
      return 0
    }
    if (head <= cursor) return 0

    const rows = db
      .prepare(
        `SELECT e.id, e.objective_id, e.kind, e.from_value, e.to_value, e.detail,
                o.title, o.status, o.pr_url, o.last_session_summary AS summary, o.deleted_at,
                g.thread_user_id, g.thread_agent_slug, g.owner_bot
           FROM objective_events e
           JOIN bot_job_origins g ON g.objective_id = e.objective_id
           JOIN objectives o ON o.id = e.objective_id
          WHERE e.id > ? AND e.id <= ?
          ORDER BY e.id ASC
          LIMIT ?`,
      )
      .all(cursor, head, BATCH) as EventRow[]

    const insert = db.prepare(
      `INSERT OR IGNORE INTO bot_thread_deliveries (delivery_id, objective_id, thread_user_id, thread_agent_slug, kind, body)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    let queued = 0
    for (const row of rows) {
      const kind = classifyThreadEvent(row)
      if (!kind) continue
      queued += insert.run(threadDeliveryId(kind, row.objective_id), row.objective_id, row.thread_user_id, row.thread_agent_slug, kind, buildThreadBody(kind, row)).changes
    }
    writeCursor(db, rows.length ? rows[rows.length - 1].id : head)
    return queued
  })()
}

export interface DeliverResult {
  delivered: number
  failed: number
}

/**
 * Write queued messages into their originating threads. The message lands as an
 * `assistant` turn in `agent_chat_messages` for (thread_user_id, agent_slug) —
 * the SAME conversation the person is already reading, not a new one.
 */
export function deliverBotThreadMessages(db: Database, limit = 50): DeliverResult {
  const pending = db
    .prepare("SELECT * FROM bot_thread_deliveries WHERE status = 'pending' ORDER BY rowid ASC LIMIT ?")
    .all(limit) as ThreadDeliveryRow[]
  let delivered = 0
  let failed = 0
  for (const row of pending) {
    try {
      const info = db
        .prepare(
          `INSERT INTO agent_chat_messages (user_id, agent_slug, role, content, meta)
           VALUES (?, ?, 'assistant', ?, ?)`,
        )
        .run(row.thread_user_id, row.thread_agent_slug, row.body, JSON.stringify({ bot_job: row.objective_id, delivery: row.delivery_id, kind: row.kind }))
      db.prepare("UPDATE bot_thread_deliveries SET status = 'delivered', message_id = ?, delivered_at = datetime('now') WHERE delivery_id = ?").run(
        Number(info.lastInsertRowid),
        row.delivery_id,
      )
      delivered++
    } catch (err) {
      db.prepare("UPDATE bot_thread_deliveries SET status = 'failed', last_error = ? WHERE delivery_id = ?").run((err as Error).message, row.delivery_id)
      failed++
    }
  }
  return { delivered, failed }
}

/** One tick: scan, then drain. What a poller calls. */
export function runBotThreadDeliveryTick(db: Database): { queued: number } & DeliverResult {
  const queued = enqueueBotThreadDeliveries(db)
  return { queued, ...deliverBotThreadMessages(db) }
}
