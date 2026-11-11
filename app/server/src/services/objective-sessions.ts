/**
 * Single source of truth for "which session transcripts make up an objective's
 * thread" and "which session should a human follow-up be appended to".
 *
 * Both questions used to be answered by copy-pasted snippets scattered across
 * four route/service files, and the two answers disagreed — which is exactly the
 * bug this module exists to kill (obj 712524):
 *
 *   1. `POST /:id/message` (and three siblings) resolved a null `objective.session_id`
 *      to `SELECT session_id FROM session_intel ... ORDER BY ended_at DESC LIMIT 1`.
 *      After any AI review the newest row by `ended_at` is the `cc-review-*` row, so
 *      the human's message was appended to the REVIEWER's JSONL and `sendFollowUp`
 *      resumed the adversarial reviewer's Claude context instead of the worker's.
 *   2. `GET /:id/output` and `GET /:id/stream` both dropped every `cc-review-*` /
 *      `cc-plan-*` transcript from the thread — correct for a pure reviewer run, but
 *      it then ERASED everything defect (1) had just routed there.
 *
 * Measured fallout before the fix: 81 objectives / 255 human messages stranded in
 * aux transcripts (obj 712444 alone: 7).
 *
 * The rule now:
 *   - Follow-ups NEVER target an aux session (`resolveFollowUpSessionId`).
 *   - The thread INCLUDES an aux session if and only if a human actually spoke in
 *     it, i.e. its parsed messages contain a `{ type: 'followup' }` message other
 *     than the synthetic opener the parser makes from the session's own `prompt`
 *     event (`listObjectiveThreadSessionIds`). A pure reviewer/planner run stays
 *     hidden; one polluted by defect (1) becomes visible again.
 */
import type { Database } from 'better-sqlite3'
import type { Objective, SessionMessage } from '@operationkit/shared'
import { getSessionOutput } from './stream-parser.js'

/** The prefix test for reviewer / planner transcripts. */
export function isAuxSession(sessionId: string): boolean {
  return sessionId.startsWith('cc-review-') || sessionId.startsWith('cc-plan-')
}

/** Only the two objective fields these helpers read. */
export type ThreadObjective = Pick<Objective, 'id' | 'session_id'>

/** Injectable for tests; production always uses the cached incremental parser. */
export type SessionMessageLoader = (sessionId: string) => SessionMessage[]

// Memo for the "did a human speak here?" predicate, keyed by session id and
// invalidated by message count. getSessionOutput is already cached + incremental
// (it only reads bytes appended since the last call), so the scan below is an
// array walk, not a file read — the memo just avoids re-walking a multi-MB
// reviewer transcript on every 1s /stream tick. NO new file-reading path.
const followUpMemo = new Map<string, { count: number; hasFollowUp: boolean }>()

/** True when a human actually spoke in this session's transcript. */
export function sessionHasHumanFollowUp(
  sessionId: string,
  load: SessionMessageLoader = getSessionOutput,
): boolean {
  let messages: SessionMessage[]
  try {
    messages = load(sessionId)
  } catch {
    return false
  }
  if (!Array.isArray(messages)) return false
  const cached = followUpMemo.get(sessionId)
  if (cached && cached.count === messages.length) return cached.hasFollowUp
  // IMPORTANT: the stream parser renders the session's own opening `prompt`
  // event as a synthetic `{type:'followup'}` at index 0 (stream-parser.ts:190).
  // Every reviewer/planner run has one, so counting it would re-admit EVERY aux
  // transcript into the thread — the opposite of the rule. Skip that leading
  // opener; a followup anywhere after it is a real human turn.
  const start = messages[0]?.type === 'followup' ? 1 : 0
  let hasFollowUp = false
  for (let i = start; i < messages.length; i++) {
    if (messages[i]?.type === 'followup') { hasFollowUp = true; break }
  }
  followUpMemo.set(sessionId, { count: messages.length, hasFollowUp })
  return hasFollowUp
}

/** Test seam — drop the memo so a re-seeded session id is re-scanned. */
export function clearFollowUpMemo(): void {
  followUpMemo.clear()
}

/**
 * The ordered session ids whose transcripts are concatenated into the objective's
 * thread, oldest first. `GET /:id/output` and `GET /:id/stream` MUST both call this
 * — /stream computes the `total` the client compares against /output's `total`, and
 * a mismatch makes the live tail thrash.
 *
 * Ordering is `session_intel.started_at ASC`, then the objective's own current
 * session appended last (it is the live one and may not have an intel row yet).
 * Only the newest session's file ever grows, so the concatenation stays
 * stable-prefix + growing-tail and timeline indices survive across polls.
 *
 * NOTE on index stability: newly including a previously-excluded aux session does
 * change the array length and therefore every downstream timeline index. That is a
 * one-time shift at deploy, and the timeline memo is keyed on `orderedIds.join('|')`
 * (see thread-timeline.ts callers), so the changed session set produces a new key
 * rather than reusing a stale entry.
 */
export function listObjectiveThreadSessionIds(
  db: Database,
  objective: ThreadObjective,
  load: SessionMessageLoader = getSessionOutput,
): string[] {
  const priorSessions = db
    .prepare('SELECT session_id FROM session_intel WHERE objective_id = ? ORDER BY started_at ASC')
    .all(objective.id) as { session_id: string }[]

  const orderedIds: string[] = []
  for (const s of priorSessions) {
    if (!s?.session_id || orderedIds.includes(s.session_id)) continue
    // An aux transcript earns a place in the thread only by containing a human
    // message (which it only ever does because of the routing defect above).
    if (isAuxSession(s.session_id) && !sessionHasHumanFollowUp(s.session_id, load)) continue
    orderedIds.push(s.session_id)
  }
  // The objective's CURRENT session is always included (even if aux) so an
  // actively-running session is never invisible.
  if (objective.session_id && !orderedIds.includes(objective.session_id)) {
    orderedIds.push(objective.session_id)
  }
  // Fallback: nothing survived — e.g. a done objective whose only sessions are a
  // silent reviewer run. Show them rather than a blank thread. `orderedIds` is
  // empty here by definition, so this cannot double-add.
  if (orderedIds.length === 0) {
    for (const s of priorSessions) {
      if (s?.session_id && !orderedIds.includes(s.session_id)) orderedIds.push(s.session_id)
    }
  }
  return orderedIds
}

/**
 * The session a human/machine follow-up must be appended to (and whose Claude
 * context `sendFollowUp` resumes).
 *
 * `objective.session_id` when set; otherwise the most recent NON-aux
 * `session_intel` row; otherwise a freshly minted worker session id. Never an
 * aux session — resuming the adversarial reviewer's context is the original bug.
 */
export function resolveFollowUpSessionId(db: Database, objective: ThreadObjective): string {
  if (objective.session_id) return objective.session_id
  try {
    const rows = db
      .prepare('SELECT session_id FROM session_intel WHERE objective_id = ? ORDER BY ended_at DESC')
      .all(objective.id) as { session_id: string }[]
    for (const r of rows) {
      if (r?.session_id && !isAuxSession(r.session_id)) return r.session_id
    }
  } catch {
    /* fall through to a fresh id */
  }
  return `cc-${objective.id}-${Date.now()}`
}
