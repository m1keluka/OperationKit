/**
 * Unanswered follow-up net (obj 900412, round 2).
 *
 * The owner kept having to send a message three or four times before a card
 * started working. Every way a follow-up can fail to start a worker used to be
 * SILENT: the bubble was already in the thread, then
 *  - the start "attached" to a lease holder that was never spawned
 *    (fixed separately in session-start.ts),
 *  - no seat was free, so sendFollowUp parked the card in the account queue
 *    whose drain later does a FRESH start that never sees the message,
 *  - the resumed process died before it wrote a single assistant event,
 *  - the deferred spawn threw and /message quietly reverted the status.
 * In each case the poller found a dead session and routed the card back to
 * review. The thread looked like the agent was ignoring the owner.
 *
 * This net is cause-agnostic. When the poller sees a worker that is no longer
 * running and the LAST thing in its transcript is the owner's message with no
 * assistant reply after it, the message was never answered. The poller then
 * re-sends it to the same session (up to MAX_RETRIES times, spaced out), and if
 * that still produces nothing it writes a visible error into the thread instead
 * of going quiet.
 */
import fs from 'fs'
import type { MessageSender, Objective } from '@operationkit/shared'
import { readJsonlTail } from './session-jsonl.js'
import { batchSender, combineQueuedFollowUps } from './followup-queue.js'

export const MAX_RETRIES = 2
/** Do not judge a message younger than this: its own spawn may still be on the way. */
export const MIN_AGE_MS = 15_000
/** Gap between two automatic re-sends of the same message. */
export const RETRY_GAP_MS = 20_000

export interface UnansweredMessage {
  text: string
  sender: MessageSender | null
  timestamp: string
}

/** Events that mean the agent actually ran a turn after the message. */
const ANSWER_TYPES = new Set(['assistant', 'result'])
/** Our own markers / bubbles: they are neither an answer nor agent activity. */
const NEUTRAL_TYPES = new Set(['followup_delivery', 'chain_reset', 'prompt'])

/**
 * Pure: the trailing owner/agent messages that have no assistant reply after
 * them, oldest first. Returns [] when the latest message was answered (or there
 * is no message at all). A visible error we wrote ourselves (`type:"error"` with
 * text) also ends the scan, so a message we already gave up on is not retried
 * forever.
 */
export function findUnansweredFollowUps(lines: string[]): UnansweredMessage[] {
  const out: UnansweredMessage[] = []
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trim()
    if (!trimmed) continue
    let e: { type?: string; text?: string; sender?: MessageSender; timestamp?: string }
    try { e = JSON.parse(trimmed) } catch { continue }
    if (!e || typeof e.type !== 'string') continue
    if (ANSWER_TYPES.has(e.type)) break
    if (e.type === 'error' && typeof e.text === 'string') break
    if (e.type === 'followup') {
      out.push({ text: e.text || '', sender: e.sender ?? null, timestamp: e.timestamp || '' })
      continue
    }
    if (NEUTRAL_TYPES.has(e.type)) continue
    // Anything else (system init, stream_event, user tool results …) is not an
    // answer, keep scanning back for the message itself.
  }
  return out.reverse().filter(m => m.text.trim())
}

interface RetryState {
  key: string
  attempts: number
  lastAt: number
  lastError: string | null
}
const retryState = new Map<number, RetryState>()

/** Test-only. */
export function __resetUnansweredState(): void {
  retryState.clear()
}

export type UnansweredDecision =
  | { action: 'none' }
  | { action: 'wait' }
  | { action: 'retry'; messages: UnansweredMessage[]; attempt: number }
  | { action: 'give_up'; messages: UnansweredMessage[]; attempts: number; lastError: string | null }

/** Pure-ish: what to do for this card right now (reads/updates the in-memory retry ledger). */
export function decideUnanswered(
  objectiveId: number,
  messages: UnansweredMessage[],
  nowMs: number,
): UnansweredDecision {
  if (messages.length === 0) {
    retryState.delete(objectiveId)
    return { action: 'none' }
  }
  const newest = messages[messages.length - 1]
  const newestMs = Date.parse(newest.timestamp)
  if (Number.isFinite(newestMs) && nowMs - newestMs < MIN_AGE_MS) return { action: 'wait' }
  const key = `${newest.timestamp}|${messages.length}`
  let st = retryState.get(objectiveId)
  if (!st || st.key !== key) {
    st = { key, attempts: 0, lastAt: 0, lastError: null }
    retryState.set(objectiveId, st)
  }
  if (st.attempts >= MAX_RETRIES) {
    return { action: 'give_up', messages, attempts: st.attempts, lastError: st.lastError }
  }
  if (st.lastAt && nowMs - st.lastAt < RETRY_GAP_MS) return { action: 'wait' }
  st.attempts += 1
  st.lastAt = nowMs
  return { action: 'retry', messages, attempt: st.attempts }
}

export function noteRetryError(objectiveId: number, err: unknown): void {
  const st = retryState.get(objectiveId)
  if (st) st.lastError = (err as Error)?.message?.split('\n')[0]?.slice(0, 300) || String(err)
}

export function forgetUnanswered(objectiveId: number): void {
  retryState.delete(objectiveId)
}

/** The thread line shown when we give up. Plain words; the owner reads it. */
export function giveUpText(attempts: number, lastError: string | null): string {
  const why = lastError ? ` Last error: ${lastError}` : ''
  return (
    `The agent did not start for your last message (tried ${attempts + 1} times). ` +
    `Your message is saved. Send it again or press Resume to retry.${why}`
  )
}

export function appendVisibleError(jsonlPath: string, text: string, now = new Date()): void {
  fs.appendFileSync(
    jsonlPath,
    JSON.stringify({ type: 'error', subtype: 'followup_unanswered', text, timestamp: now.toISOString() }) + '\n',
  )
}

export interface UnansweredDeps {
  jsonlPathFor: (sessionId: string) => string
  deliver: (sessionId: string, message: string, objective: Objective, opts: { skipJsonl: boolean; sender?: MessageSender; sessionTextOverride: string }) => string
  stamp: (message: string, sender?: MessageSender) => string
  noteStart: (objectiveId: number, actor: string | null) => void
  now?: () => number
  log?: (msg: string) => void
}

/**
 * Called by the poller for a `working` card whose worker is no longer running,
 * AFTER the limit / overload / turns / queued-message handlers and BEFORE it is
 * routed to review. Returns true when the caller must leave the card alone this
 * tick (a retry was started, or we are waiting before the next one).
 */
export function handleUnansweredFollowUp(objective: Objective, deps: UnansweredDeps): boolean {
  const sessionId = objective.session_id
  if (!sessionId || objective.delegate_mode || objective.status !== 'working') return false
  const jsonlPath = deps.jsonlPathFor(sessionId)
  let lines: string[]
  try { lines = readJsonlTail(jsonlPath, 256_000).split('\n') } catch { return false }
  const messages = findUnansweredFollowUps(lines)
  const nowMs = (deps.now ?? Date.now)()
  const decision = decideUnanswered(objective.id, messages, nowMs)
  const log = deps.log ?? ((m: string) => console.warn(m))

  if (decision.action === 'none') return false
  if (decision.action === 'wait') return true
  if (decision.action === 'give_up') {
    try { appendVisibleError(jsonlPath, giveUpText(decision.attempts, decision.lastError)) } catch {}
    forgetUnanswered(objective.id)
    log(`[unanswered-followup] obj ${objective.id} (${sessionId}): ${decision.attempts} re-sends produced no reply — wrote a visible error and routing normally.`)
    return false
  }

  const sender = batchSender(messages.map(m => ({ sender: m.sender })))
  const text = combineQueuedFollowUps(messages.map(m => ({ message: m.text, sender: m.sender })), deps.stamp)
  try {
    deps.noteStart(objective.id, sender?.username ?? null)
    deps.deliver(sessionId, messages.map(m => m.text).join('\n\n'), objective, { skipJsonl: true, sender, sessionTextOverride: text })
    log(`[unanswered-followup] obj ${objective.id} (${sessionId}): message had no reply and the worker is gone — re-sent (attempt ${decision.attempt}/${MAX_RETRIES}).`)
  } catch (err) {
    noteRetryError(objective.id, err)
    log(`[unanswered-followup] obj ${objective.id} (${sessionId}): re-send attempt ${decision.attempt} failed: ${(err as Error)?.message ?? err}`)
  }
  return true
}
