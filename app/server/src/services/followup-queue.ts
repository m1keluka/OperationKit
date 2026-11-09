/**
 * Follow-up queue (obj 900412): a message sent while the card's worker is
 * mid-turn waits for that turn instead of killing it.
 *
 * Before this, every message to a `working` card went straight through
 * `sendFollowUp`, whose respawn path tears the live process down (`docker rm -f`
 * on the jail, `tmux kill-session` otherwise) and starts it again with only the
 * new text. The collapsed thread hides tool activity, so a worker that is busy
 * looks idle. The owner then sends "???" and each one restarts the work from
 * scratch, so a long answer never finishes. Card #900408 shows the loop: four
 * messages in 39s (18:56:22 to 18:57:01Z, 2026-11-09) produced four `resume`
 * starts, and only the fourth run lived long enough to answer.
 *
 * Now:
 *  - `/message` on a card whose worker is ALIVE and MID-TURN (last transcript
 *    event is not a `result`) and whose transcript was written recently records
 *    the bubble in the thread (flagged `queued`) and parks the text in
 *    `followup_queue`. Nothing is killed.
 *  - When that turn ends, the poller calls `deliverQueuedFollowUps` before it
 *    routes the card to review. Every queued message goes to the SAME session
 *    in one resume, so the worker reads all of them in order.
 *  - A worker that has been silent for longer than the stale window is treated
 *    as hung, and the message restarts it the old way. A queued message must
 *    never sit behind a session that will not finish.
 *  - Stop drops the queue, so a stopped card stays stopped.
 *
 * Kill switch: `settings.followup_queue_enabled = '0'`.
 * Stale window: `settings.followup_queue_stale_minutes` (default 5).
 */
import fs from 'fs'
import type Database from 'better-sqlite3'
import type { MessageSender, Objective } from '@operationkit/shared'
export { initFollowUpQueueSchema } from '../db/schema/followup-queue.js'

export const FOLLOWUP_QUEUE_ENABLED_KEY = 'followup_queue_enabled'
export const FOLLOWUP_QUEUE_STALE_KEY = 'followup_queue_stale_minutes'
export const DEFAULT_STALE_MINUTES = 5
/** Event type written after a turn's `result` when queued messages are handed over. */
export const FOLLOWUP_DELIVERY_EVENT_TYPE = 'followup_delivery'

const WORKER_SESSION_ID = /^cc-\d+-\d+$/

export interface QueuedFollowUp {
  id: number
  objective_id: number
  session_id: string
  message: string
  sender: MessageSender | null
  created_at: string
}

function readSetting(db: Database.Database, key: string): string | undefined {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
    return row?.value
  } catch {
    return undefined
  }
}

export interface FollowUpQueueConfig {
  enabled: boolean
  staleMs: number
}

export function resolveFollowUpQueueConfig(db: Database.Database): FollowUpQueueConfig {
  const enabled = readSetting(db, FOLLOWUP_QUEUE_ENABLED_KEY) !== '0'
  const raw = Number(readSetting(db, FOLLOWUP_QUEUE_STALE_KEY))
  const minutes = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_STALE_MINUTES
  return { enabled, staleMs: minutes * 60_000 }
}

export interface QueueDecisionInput {
  config: FollowUpQueueConfig
  status: string
  /** The session the message is addressed to. */
  sessionId: string | null
  /** objectives.session_id: the queue only applies to the card's CURRENT session. */
  currentSessionId: string | null
  /** getSessionState(sessionId): 'working' = alive and the last event is not a `result`. */
  sessionState: 'working' | 'review' | 'dead'
  /** Transcript mtime in ms, or null when it cannot be read. */
  transcriptMtimeMs: number | null
  nowMs: number
}

export type QueueDecision =
  | { queue: true }
  | { queue: false; reason: 'disabled' | 'not_working' | 'not_worker' | 'not_current' | 'not_mid_turn' | 'stale' | 'no_transcript' }

/** Pure: should this follow-up wait for the running turn instead of restarting it? */
export function decideFollowUpQueue(i: QueueDecisionInput): QueueDecision {
  if (!i.config.enabled) return { queue: false, reason: 'disabled' }
  if (i.status !== 'working') return { queue: false, reason: 'not_working' }
  if (!i.sessionId || !WORKER_SESSION_ID.test(i.sessionId)) return { queue: false, reason: 'not_worker' }
  if (i.sessionId !== i.currentSessionId) return { queue: false, reason: 'not_current' }
  if (i.sessionState !== 'working') return { queue: false, reason: 'not_mid_turn' }
  if (i.transcriptMtimeMs === null) return { queue: false, reason: 'no_transcript' }
  // Silent for longer than the window: probably hung. Restart it the old way so
  // the owner's message can still unstick the card.
  if (i.nowMs - i.transcriptMtimeMs > i.config.staleMs) return { queue: false, reason: 'stale' }
  return { queue: true }
}

export function transcriptMtimeMs(jsonlPath: string): number | null {
  try {
    return fs.statSync(jsonlPath).mtimeMs
  } catch {
    return null
  }
}

export function enqueueFollowUp(
  db: Database.Database,
  objectiveId: number,
  sessionId: string,
  message: string,
  sender?: MessageSender,
): number {
  const r = db
    .prepare('INSERT INTO followup_queue (objective_id, session_id, message, sender_json) VALUES (?, ?, ?, ?)')
    .run(objectiveId, sessionId, message, sender ? JSON.stringify(sender) : null)
  return Number(r.lastInsertRowid)
}

function rowToQueued(r: {
  id: number; objective_id: number; session_id: string; message: string; sender_json: string | null; created_at: string
}): QueuedFollowUp {
  let sender: MessageSender | null = null
  if (r.sender_json) {
    try { sender = JSON.parse(r.sender_json) as MessageSender } catch { sender = null }
  }
  return { id: r.id, objective_id: r.objective_id, session_id: r.session_id, message: r.message, sender, created_at: r.created_at }
}

export function listPendingFollowUps(db: Database.Database, objectiveId: number): QueuedFollowUp[] {
  try {
    const rows = db
      .prepare('SELECT * FROM followup_queue WHERE objective_id = ? AND delivered_at IS NULL AND dropped_at IS NULL ORDER BY id')
      .all(objectiveId) as Parameters<typeof rowToQueued>[0][]
    return rows.map(rowToQueued)
  } catch {
    // Table missing (uninitialised test DB): nothing is queued.
    return []
  }
}

/** Atomically claim every pending message for delivery. Returns them oldest first. */
export function takePendingFollowUps(db: Database.Database, objectiveId: number): QueuedFollowUp[] {
  const take = db.transaction(() => {
    const items = listPendingFollowUps(db, objectiveId)
    if (items.length === 0) return items
    const mark = db.prepare("UPDATE followup_queue SET delivered_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND delivered_at IS NULL")
    for (const it of items) mark.run(it.id)
    return items
  })
  return take()
}

/** Put claimed messages back (delivery failed) so the next end-of-turn can retry. */
export function releaseFollowUps(db: Database.Database, ids: number[]): void {
  const un = db.prepare('UPDATE followup_queue SET delivered_at = NULL WHERE id = ?')
  for (const id of ids) un.run(id)
}

export function dropPendingFollowUps(db: Database.Database, objectiveId: number, reason: string): number {
  try {
    const r = db
      .prepare(
        "UPDATE followup_queue SET dropped_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), drop_reason = ? WHERE objective_id = ? AND delivered_at IS NULL AND dropped_at IS NULL",
      )
      .run(reason, objectiveId)
    return r.changes
  } catch {
    return 0
  }
}

/**
 * Pure: the text the worker receives for a batch of queued messages. One
 * message passes through unchanged. Several are numbered in the order they
 * were sent. `stamp` applies the per-message sender stamp (obj 718944) so each
 * message keeps its own provenance.
 */
export function combineQueuedFollowUps(
  items: Pick<QueuedFollowUp, 'message' | 'sender'>[],
  stamp: (message: string, sender?: MessageSender) => string,
): string {
  if (items.length === 1) return stamp(items[0].message, items[0].sender ?? undefined)
  const parts = items.map((it, i) => `--- Message ${i + 1} of ${items.length} ---\n${stamp(it.message, it.sender ?? undefined)}`)
  return (
    `While you were working, ${items.length} messages arrived in this card's thread. ` +
    'Read them all, then answer the latest intent (later messages may repeat or update earlier ones).\n\n' +
    parts.join('\n\n')
  )
}

/** The sender recorded for the batch: the least-trusted one, so a batch never reads as more verified than its weakest message. */
export function batchSender(items: Pick<QueuedFollowUp, 'sender'>[]): MessageSender | undefined {
  const senders = items.map(i => i.sender).filter((s): s is MessageSender => !!s)
  if (senders.length === 0) return undefined
  return senders.find(s => !s.verified) ?? senders[senders.length - 1]
}

export function markFollowUpDelivery(jsonlPath: string, count: number, now = new Date()): void {
  fs.appendFileSync(
    jsonlPath,
    JSON.stringify({ type: FOLLOWUP_DELIVERY_EVENT_TYPE, count, timestamp: now.toISOString() }) + '\n',
  )
}

export type DeliverFn = (sessionId: string, message: string, objective: Objective, opts: { skipJsonl: boolean; sender?: MessageSender; sessionTextOverride: string }) => string

export interface DeliverDeps {
  db: Database.Database
  deliver: DeliverFn
  stamp: (message: string, sender?: MessageSender) => string
  jsonlPathFor: (sessionId: string) => string
  noteStart: (objectiveId: number, actor: string | null) => void
}

/**
 * Called by the poller when a worker's turn has ended (or its process died),
 * BEFORE the card is routed to review. If messages were queued during the turn,
 * resume the same session with all of them and return true: the card stays
 * `working`. Returns false when nothing was queued or delivery failed (the
 * messages are put back and the normal end-of-session routing proceeds).
 */
export function deliverQueuedFollowUps(objective: Objective, deps: DeliverDeps): boolean {
  const sessionId = objective.session_id
  if (!sessionId) return false
  const items = takePendingFollowUps(deps.db, objective.id)
  if (items.length === 0) return false
  const sender = batchSender(items)
  const text = combineQueuedFollowUps(items, deps.stamp)
  try {
    // The bubbles were written at enqueue time, BEFORE this turn's `result`.
    // A marker after the result keeps getSessionState from reading the resumed
    // session as already finished.
    try { markFollowUpDelivery(deps.jsonlPathFor(sessionId), items.length) } catch {}
    deps.noteStart(objective.id, sender?.username ?? null)
    deps.deliver(sessionId, items.map(i => i.message).join('\n\n'), objective, { skipJsonl: true, sender, sessionTextOverride: text })
    console.log(`[followup-queue] delivered ${items.length} queued message(s) to ${sessionId} (objective ${objective.id})`)
    return true
  } catch (err) {
    // Put them back: the next /message respawn takes every pending message
    // along with it, so nothing the owner typed is lost.
    console.error(`[followup-queue] delivery to ${sessionId} failed (objective ${objective.id}); messages kept for the next send:`, err)
    try { releaseFollowUps(deps.db, items.map(i => i.id)) } catch {}
    return false
  }
}
