/**
 * Abnormal-end auto-retry (obj 900547) — built on the PR 673 stall watchdog
 * (obj 900372), not beside it.
 *
 * A worker whose process dies MID-TURN — real work in the transcript, but no
 * terminal `result` event — used to fall straight through to `review` as if it had
 * finished (#900543, twice on 2026-11-11: 44 then 86 tool calls, "Session ended
 * unexpectedly, no completion message was received"). A human then had to notice
 * and restart it.
 *
 * Now, on the poller's dead-session path:
 *   1. The FIRST abnormal end of an episode resumes the SAME session with context
 *      (`sendFollowUp`, which falls back to the history-flattening respawn when the
 *      CLI transcript is not resumable) and keeps the card `working`.
 *   2. The NEXT one flags the card exactly the way the stall watchdog flags a
 *      second stall: `stalled_at` + `stall_reason` (→ objective_events kind
 *      `stalled` → `needs_agent` webhook to the owner bot), a high-severity alert
 *      in the AlertBell and an activity_log row — then the card parks in `review`
 *      with a visible `blocked` verdict carrying the cause.
 *
 * The once-only cap IS the watchdog's: `objectives.stall_restarts`, claimed with
 * the same compare-and-set, bounded by the same `resolveStallConfig()`
 * (`stall_watchdog_max_restarts`, hard-capped at 1; `stall_watchdog_enabled='0'`
 * turns this off too). A stall restart and an abnormal-end retry therefore share
 * ONE budget per episode, and the counter only re-arms when something other than
 * these two automatic paths starts the card (session-start-reasons.ts).
 */
import type Database from 'better-sqlite3'
import type { Objective } from '@operationkit/shared'
import { resolveStallConfig, flagStalled, type StallCardRow, type StallDeps } from './stall-watchdog.js'

export const ABNORMAL_END_START_REASON = 'abnormal_end_retry'

/** Server-written lines that open a new spawn segment. */
const SEGMENT_MARKERS = new Set(['prompt', 'followup'])

export interface SegmentEnd {
  /** The current spawn segment wrote a terminal `result` (or Codex turn.completed). */
  hasResult: boolean
  /** Distinct assistant API messages in the segment — evidence the model ran. */
  assistantMessages: number
  toolCalls: number
}

/** Pure: classify the transcript's CURRENT spawn segment (after the last prompt/followup). */
export function analyzeSegmentEnd(lines: string[]): SegmentEnd {
  let hasResult = false
  const ids = new Set<string>()
  let toolCalls = 0
  for (const raw of lines) {
    const t = raw.trim()
    if (!t) continue
    let ev: Record<string, unknown>
    try { ev = JSON.parse(t) } catch { continue }
    const type = ev.type
    if (typeof type === 'string' && SEGMENT_MARKERS.has(type)) {
      hasResult = false; ids.clear(); toolCalls = 0
      continue
    }
    if (type === 'result' || type === 'turn.completed') { hasResult = true; continue }
    if (type === 'assistant') {
      const msg = ev.message as { id?: unknown; content?: unknown } | undefined
      if (typeof msg?.id === 'string') ids.add(msg.id)
      if (Array.isArray(msg?.content)) {
        for (const b of msg!.content as Array<{ type?: string }>) if (b?.type === 'tool_use') toolCalls++
      }
    }
  }
  return { hasResult, assistantMessages: ids.size, toolCalls }
}

export type AbnormalEndAction = 'none' | 'retry' | 'flag'

/** Pure decision. */
export function decideAbnormalEnd(input: {
  status: string
  delegateMode: boolean
  segment: SegmentEnd
  autoRestarts: number
  maxAutoRestarts: number
  enabled: boolean
}): AbnormalEndAction {
  if (!input.enabled || input.delegateMode || input.status !== 'working') return 'none'
  // A clean end, or a spawn that never ran the model (the no-op / startup-failure
  // machinery owns that case) is not an abnormal end.
  if (input.segment.hasResult || input.segment.assistantMessages === 0) return 'none'
  return input.autoRestarts < input.maxAutoRestarts ? 'retry' : 'flag'
}

export function describeAbnormalEnd(sessionId: string, seg: SegmentEnd): string {
  return (
    `Session ${sessionId} ended abnormally: the process stopped mid-turn after ` +
    `${seg.toolCalls} tool call(s) / ${seg.assistantMessages} model turn(s) without writing a final result ` +
    `(killed — e.g. its tmux session or jail was torn down — or crashed).`
  )
}

export function retryMessage(seg: SegmentEnd): string {
  return (
    `[auto-retry] Your previous session was cut off mid-turn (after ${seg.toolCalls} tool calls) with no final ` +
    `result — this is the ONE automatic retry. Continue where you left off: check \`git status\` / \`git log\` ` +
    `in your worktree first so you do not redo committed work. If you were running a scratch Command Center ` +
    `server, start it the safe way (CC_SCRATCH_SERVER=1, a non-3002 PORT, a temp DB_PATH — see CLAUDE.md ` +
    `"Scratch server for screenshots") and stop it with \`kill <its pid>\`, never \`pkill -f\`.`
  )
}

export interface AbnormalEndDeps {
  db: Database.Database
  now: () => number
  readLines: (sessionId: string) => string[]
  resume: (objective: Objective, message: string) => void
  noteStartReason: (objectiveId: number, detail: string) => void
  notify: StallDeps['notify']
  broadcast: (objectiveId: number) => void
  log?: (msg: string) => void
}

function logActivity(db: Database.Database, o: Objective, eventType: 'milestone' | 'error', title: string, detail: string, meta: Record<string, unknown>): void {
  try {
    db.prepare(
      'INSERT INTO activity_log (project, workspace, objective_id, session_id, event_type, title, detail, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(o.project || 'unknown', o.workspace, o.id, o.session_id, eventType, title, detail, JSON.stringify(meta))
  } catch { /* telemetry never blocks */ }
}

/**
 * Returns true when it RESUMED the card (caller skips review routing). Returns
 * false otherwise — including after flagging, so the caller's normal dead-session
 * routing still releases leases and parks the card in `review`.
 */
export function handleAbnormalEnd(objective: Objective, deps: AbnormalEndDeps): boolean {
  if (!objective.session_id) return false
  const db = deps.db
  const row = db.prepare(
    `SELECT id, title, status, workspace, project, session_id, delegate_mode, last_activity_at, last_start_at,
            updated_at, stalled_at, stall_restarts FROM objectives WHERE id = ?`,
  ).get(objective.id) as StallCardRow | undefined
  if (!row) return false

  let lines: string[]
  try { lines = deps.readLines(objective.session_id) } catch { return false }
  const segment = analyzeSegmentEnd(lines)
  const cfg = resolveStallConfig(db)
  const action = decideAbnormalEnd({
    status: row.status,
    delegateMode: Number(row.delegate_mode) > 0,
    segment,
    autoRestarts: Number(row.stall_restarts) || 0,
    maxAutoRestarts: cfg.maxAutoRestarts,
    enabled: cfg.enabled,
  })
  if (action === 'none') return false
  const reason = describeAbnormalEnd(objective.session_id, segment)

  if (action === 'retry') {
    // Same durable compare-and-set the stall watchdog uses: claim BEFORE the side
    // effect, so a crash mid-retry still counts and the next abnormal end flags.
    const claim = db.prepare(
      "UPDATE objectives SET stall_restarts = COALESCE(stall_restarts, 0) + 1 WHERE id = ? AND status = 'working' AND COALESCE(stall_restarts, 0) = ?",
    ).run(row.id, Number(row.stall_restarts) || 0)
    if (claim.changes !== 1) return false
    logActivity(db, objective, 'milestone', 'abnormal_end_auto_retry', `Auto-retrying once: ${reason}`, {
      kind: 'abnormal_end_auto_retry', tool_calls: segment.toolCalls, model_turns: segment.assistantMessages,
    })
    try {
      deps.noteStartReason(objective.id, reason)
      deps.resume(objective, retryMessage(segment))
      db.prepare("UPDATE objectives SET stall_reason = ?, updated_at = datetime('now') WHERE id = ?")
        .run(`auto-retried after abnormal end: ${reason}`.slice(0, 500), row.id)
      deps.broadcast(row.id)
      deps.log?.(`[abnormal-end] #${row.id} ${objective.session_id} ended mid-turn — auto-retried once (resume with context)`)
      return true
    } catch (err) {
      const msg = (err as Error)?.message?.split('\n')[0] ?? String(err)
      flagAndBlock(deps, objective, { ...row, stall_restarts: (Number(row.stall_restarts) || 0) + 1 }, `${reason} Auto-retry failed: ${msg}`)
      return false
    }
  }

  flagAndBlock(deps, objective, row, `${reason} This is the second abnormal end in a row; the one automatic retry is already spent.`)
  return false
}

function flagAndBlock(deps: AbnormalEndDeps, objective: Objective, row: StallCardRow, reason: string): void {
  // The watchdog's flag path: stalled_at → objective_events 'stalled' → needs_agent,
  // AlertBell, activity_log. Requires status='working', which holds here.
  flagStalled(
    { db: deps.db, now: deps.now, notify: deps.notify, broadcast: deps.broadcast, log: deps.log },
    row,
    reason,
    null,
  )
  try {
    deps.db.prepare(
      "UPDATE objectives SET ai_review_verdict = 'blocked', ai_review_findings = ?, updated_at = datetime('now') WHERE id = ?",
    ).run(`Blocked: ${reason}`.slice(0, 2000), objective.id)
  } catch { /* the flag + alert above already make it visible */ }
  deps.log?.(`[abnormal-end] #${objective.id} ended abnormally again — flagged (needs_agent kind=stalled) + alert, parked blocked`)
}
