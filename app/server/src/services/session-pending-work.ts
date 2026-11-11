/**
 * Interim turn-end detection (obj 712954).
 *
 * The Claude CLI writes a `result` event at the end of EVERY turn, not just the
 * last one. A turn that ends by launching a background `Agent`, arming a
 * `Monitor`, or calling `ScheduleWakeup` still emits `result`, and the CLI then
 * keeps running: a task notification or the wakeup starts the next turn in the
 * same process. `getSessionState` used to read "last typed event is `result`"
 * as "session over" and parked the card in `review` mid-work (obj 712937 was
 * parked three times this way; its worker finished PR 717 after the card had
 * already been routed).
 *
 * `detectPendingWork` is the pure verdict: given a transcript tail whose last
 * typed event is a successful `result`, is there still background work that
 * will start another turn? The caller (getSessionState) only consults it while
 * tmux is alive — a dead tmux keeps today's behaviour.
 *
 * Everything is bounded by `horizonMs` (default 60 min, PENDING_WORK_HORIZON_MS):
 *   - a ScheduleWakeup only counts if it fires within the horizon from now, so a
 *     far-off wakeup cannot pin a card in `working`;
 *   - agent/monitor/background-task evidence only counts if the transcript saw
 *     a timestamped event within the horizon, so a crashed CLI that never
 *     writes a notification cannot pin it either.
 * The idle / wall-clock watchdog stays the outer backstop.
 *
 * Fail-safe: malformed lines are skipped; no parseable trailing `result` → not
 * pending, which is exactly the pre-712954 behaviour.
 */

export type PendingWorkKind = 'wakeup' | 'async_agent' | 'monitor' | 'background_task'

export interface PendingWorkVerdict {
  pending: boolean
  reasons: PendingWorkKind[]
  /** Epoch ms of the most recent ScheduleWakeup (whether or not it counts). */
  wakeupAtMs: number | null
  /** Why the verdict is `false` when it is (for logs/tests). */
  detail?: 'no-result' | 'error-result' | 'stale' | 'nothing-pending'
}

export const DEFAULT_PENDING_WORK_HORIZON_MS = 60 * 60 * 1000

const TERMINAL_TASK_STATUSES = new Set(['completed', 'failed', 'killed', 'stopped', 'cancelled', 'canceled', 'error'])

const ASYNC_AGENT_RE = /Async agent launched[\s\S]*?agentId:\s*([A-Za-z0-9_-]+)/
const MONITOR_RE = /Monitor started \(task ([A-Za-z0-9_-]+), expires in (\d+)\s*(ms|s|m|h)\b/
const WAKEUP_RE = /Next wakeup scheduled for [^(\n]*\(in (\d+)s\)/

function unitMs(unit: string): number {
  if (unit === 'ms') return 1
  if (unit === 's') return 1000
  if (unit === 'h') return 3_600_000
  return 60_000
}

function toolResultTexts(event: Record<string, unknown>): string[] {
  const msg = event.message as { content?: unknown } | undefined
  const content = msg?.content
  if (!Array.isArray(content)) return []
  const out: string[] = []
  for (const block of content as Array<Record<string, unknown>>) {
    if (!block || block.type !== 'tool_result') continue
    const c = block.content
    if (typeof c === 'string') out.push(c)
    else if (Array.isArray(c)) {
      for (const inner of c as Array<Record<string, unknown>>) {
        if (inner && typeof inner.text === 'string') out.push(inner.text)
      }
    }
  }
  return out
}

function parseTs(v: unknown): number | null {
  if (typeof v !== 'string') return null
  const ms = Date.parse(v)
  return Number.isFinite(ms) ? ms : null
}

/**
 * Pure: is the trailing `result` in `lines` an INTERIM turn-end (background
 * work still pending) rather than the end of the session?
 */
export function detectPendingWork(
  lines: string[],
  opts: { nowMs: number; horizonMs?: number },
): PendingWorkVerdict {
  const horizonMs = opts.horizonMs && opts.horizonMs > 0 ? opts.horizonMs : DEFAULT_PENDING_WORK_HORIZON_MS
  const nowMs = opts.nowMs
  const open = new Map<string, { kind: 'async_agent' | 'monitor'; expiresMs: number | null }>()
  let bgTasks: string[] | null = null
  let wakeupAtMs: number | null = null
  let lastTsMs: number | null = null
  let last: Record<string, unknown> | null = null

  if (!Array.isArray(lines)) return { pending: false, reasons: [], wakeupAtMs: null, detail: 'no-result' }

  for (const raw of lines) {
    const trimmed = typeof raw === 'string' ? raw.trim() : ''
    if (!trimmed) continue
    let event: Record<string, unknown>
    try {
      const parsed = JSON.parse(trimmed)
      if (!parsed || typeof parsed !== 'object') continue
      event = parsed as Record<string, unknown>
    } catch {
      continue
    }
    if (!event.type) continue
    last = event
    const ts = parseTs(event.timestamp)
    if (ts != null) lastTsMs = ts

    if (event.type === 'user') {
      const at = ts ?? lastTsMs
      for (const text of toolResultTexts(event)) {
        const agent = text.match(ASYNC_AGENT_RE)
        if (agent) open.set(agent[1], { kind: 'async_agent', expiresMs: null })
        const mon = text.match(MONITOR_RE)
        if (mon) {
          const dur = parseInt(mon[2], 10) * unitMs(mon[3])
          open.set(mon[1], { kind: 'monitor', expiresMs: at != null ? at + dur : null })
        }
        const wake = text.match(WAKEUP_RE)
        if (wake && at != null) wakeupAtMs = at + parseInt(wake[1], 10) * 1000
      }
      continue
    }

    if (event.type === 'system') {
      const subtype = event.subtype
      const taskId = typeof event.task_id === 'string' ? event.task_id : null
      const status = subtype === 'task_updated'
        ? (event.patch as { status?: unknown } | undefined)?.status
        : undefined
      const ended = subtype === 'task_notification' ||
        (subtype === 'task_updated' && typeof status === 'string' && TERMINAL_TASK_STATUSES.has(status))
      if (ended && taskId) {
        open.delete(taskId)
        if (bgTasks) bgTasks = bgTasks.filter(id => id !== taskId)
      }
      if (subtype === 'background_tasks_changed' && Array.isArray(event.tasks)) {
        bgTasks = (event.tasks as Array<{ task_id?: unknown }>)
          .map(t => (t && typeof t.task_id === 'string' ? t.task_id : ''))
          .filter(Boolean)
        // The CLI's own list is authoritative for anything it no longer tracks.
        const live = new Set(bgTasks)
        for (const id of [...open.keys()]) if (!live.has(id)) open.delete(id)
      }
    }
  }

  if (!last || last.type !== 'result') return { pending: false, reasons: [], wakeupAtMs, detail: 'no-result' }
  // Errored / max-turns / rate-limited results are real ends — the limit and
  // max-turns handlers downstream must still see them.
  if (last.is_error === true || (typeof last.subtype === 'string' && last.subtype !== 'success')) {
    return { pending: false, reasons: [], wakeupAtMs, detail: 'error-result' }
  }

  const reasons: PendingWorkKind[] = []
  if (wakeupAtMs != null && wakeupAtMs > nowMs && wakeupAtMs - nowMs <= horizonMs) reasons.push('wakeup')

  const fresh = lastTsMs != null && nowMs - lastTsMs <= horizonMs
  if (fresh) {
    for (const t of open.values()) {
      if (t.kind === 'monitor' && t.expiresMs != null && t.expiresMs <= nowMs) continue
      if (!reasons.includes(t.kind)) reasons.push(t.kind)
    }
    if (bgTasks && bgTasks.length > 0 && !reasons.includes('background_task')) reasons.push('background_task')
  }

  if (reasons.length > 0) return { pending: true, reasons, wakeupAtMs }
  return { pending: false, reasons, wakeupAtMs, detail: lastTsMs != null && !fresh ? 'stale' : 'nothing-pending' }
}
