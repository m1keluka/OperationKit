import { describe, it, expect } from 'vitest'
import { detectPendingWork, DEFAULT_PENDING_WORK_HORIZON_MS } from './session-pending-work.js'

// Fixture tails mirror the real stream-json shapes from obj 712937's transcripts
// (cc-712937-1790528444371 / -1790536709527, 2026-09-27): the ScheduleWakeup /
// Agent / Monitor tool_result texts, `background_tasks_changed`, `task_*` and
// the trailing `result` (which carries no timestamp).

const T0 = Date.parse('2026-09-27T19:19:35.000Z')
const iso = (ms: number) => new Date(ms).toISOString()
const J = (o: unknown) => JSON.stringify(o)

const assistantText = (ms: number, text: string) =>
  J({ type: 'assistant', timestamp: iso(ms), message: { role: 'assistant', content: [{ type: 'text', text }] }, session_id: 's1' })
const toolResult = (ms: number, text: string, id = 'toolu_x') =>
  J({
    type: 'user',
    timestamp: iso(ms),
    message: { role: 'user', content: [{ tool_use_id: id, type: 'tool_result', content: [{ type: 'text', text }] }] },
    parent_tool_use_id: null,
    session_id: 's1',
  })
const bgChanged = (ids: string[]) =>
  J({ type: 'system', subtype: 'background_tasks_changed', tasks: ids.map(task_id => ({ task_id, task_type: 'local_agent', description: 'x' })), session_id: 's1' })
const notification = (task_id: string, status = 'completed') =>
  J({ type: 'system', subtype: 'task_notification', task_id, status, summary: 'done', session_id: 's1' })
const taskUpdated = (task_id: string, status: string) =>
  J({ type: 'system', subtype: 'task_updated', task_id, patch: { status, end_time: 0 }, session_id: 's1' })
const result = (over: Record<string, unknown> = {}) =>
  J({ type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn', result: 'Waiting…', total_cost_usd: 3.41, session_id: 's1', uuid: 'r1', ...over })

const agentLaunched = (ms: number, id = 'a1bebe1ab05678b8b') =>
  toolResult(ms, `Async agent launched successfully. (This tool result is internal metadata.)\nagentId: ${id} (internal ID - do not mention to user.)`)
const wakeupScheduled = (ms: number, inSeconds: number) =>
  toolResult(ms, `Next wakeup scheduled for 19:45:00 (in ${inSeconds}s). Nothing more to do this turn — the harness re-invokes you when the wakeup fires or a task-notification arrives.`)
const monitorStarted = (ms: number, id: string, expires: string) =>
  toolResult(ms, `Monitor started (task ${id}, expires in ${expires} unless the source ends first; you get one notice at expiry — re-arm if you still need the watch).`)

describe('detectPendingWork (obj 712954)', () => {
  it('result followed by a pending ScheduleWakeup → pending (keep working)', () => {
    const lines = [
      assistantText(T0, 'Launching verification'),
      wakeupScheduled(T0 + 3_000, 1521),
      assistantText(T0 + 4_000, "Background verification agent is running. I'll report back."),
      result(),
    ]
    const v = detectPendingWork(lines, { nowMs: T0 + 60_000 })
    expect(v.pending).toBe(true)
    expect(v.reasons).toContain('wakeup')
    expect(v.wakeupAtMs).toBe(T0 + 3_000 + 1521 * 1000)
  })

  it('result followed by a pending async Agent → pending', () => {
    const lines = [agentLaunched(T0), bgChanged(['a1bebe1ab05678b8b']), assistantText(T0 + 1_000, 'Agent running'), result()]
    const v = detectPendingWork(lines, { nowMs: T0 + 30_000 })
    expect(v.pending).toBe(true)
    expect(v.reasons).toEqual(expect.arrayContaining(['async_agent', 'background_task']))
  })

  it('async Agent without a background_tasks_changed event still counts until its notification', () => {
    const lines = [agentLaunched(T0), result()]
    expect(detectPendingWork(lines, { nowMs: T0 + 30_000 }).reasons).toEqual(['async_agent'])
    const done = [agentLaunched(T0), notification('a1bebe1ab05678b8b'), result()]
    expect(detectPendingWork(done, { nowMs: T0 + 30_000 }).pending).toBe(false)
  })

  it('result followed by an armed Monitor → pending until it expires', () => {
    const lines = [monitorStarted(T0, 'b9s80rgv2', '2m'), assistantText(T0 + 1_000, 'Waiting for the queued run'), result()]
    expect(detectPendingWork(lines, { nowMs: T0 + 60_000 })).toMatchObject({ pending: true, reasons: ['monitor'] })
    // 2 minutes later the monitor has expired and nothing else is pending.
    expect(detectPendingWork(lines, { nowMs: T0 + 121_000 }).pending).toBe(false)
  })

  it('result with nothing pending → not pending (routes to review exactly as before)', () => {
    const lines = [assistantText(T0, 'All CI checks are green. Summary: …'), result({ result: 'Summary' })]
    expect(detectPendingWork(lines, { nowMs: T0 + 5_000 })).toMatchObject({ pending: false, detail: 'nothing-pending' })
  })

  it('work that finished before the result (killed/completed + empty task list) → not pending', () => {
    // The tail of obj 712937 session 3: the CLI killed every task, emptied the
    // list, THEN wrote the final result and exited.
    const lines = [
      agentLaunched(T0),
      monitorStarted(T0 + 1_000, 'bo03377kj', '5m'),
      bgChanged(['a1bebe1ab05678b8b', 'bo03377kj']),
      taskUpdated('a1bebe1ab05678b8b', 'killed'),
      notification('a1bebe1ab05678b8b', 'stopped'),
      bgChanged(['bo03377kj']),
      taskUpdated('bo03377kj', 'killed'),
      bgChanged([]),
      result(),
    ]
    expect(detectPendingWork(lines, { nowMs: T0 + 30_000 }).pending).toBe(false)
  })

  it('a task that ended via task_updated (no bg list event) is not pending', () => {
    const lines = [monitorStarted(T0, 'm1', '10m'), bgChanged(['m1']), taskUpdated('m1', 'completed'), result()]
    expect(detectPendingWork(lines, { nowMs: T0 + 30_000 }).pending).toBe(false)
  })

  it('a wakeup beyond the horizon does not pin the card', () => {
    const lines = [wakeupScheduled(T0, 3 * 3600), result()]
    expect(detectPendingWork(lines, { nowMs: T0 + 1_000 }).pending).toBe(false)
    // …but it counts once it is inside a wider configured horizon.
    expect(detectPendingWork(lines, { nowMs: T0 + 1_000, horizonMs: 4 * 3600_000 }).pending).toBe(true)
  })

  it('a wakeup already in the past is not pending', () => {
    const lines = [wakeupScheduled(T0, 60), result()]
    expect(detectPendingWork(lines, { nowMs: T0 + 61_000 }).pending).toBe(false)
  })

  it('agent evidence older than the horizon is stale → not pending', () => {
    const lines = [agentLaunched(T0), bgChanged(['a1bebe1ab05678b8b']), result()]
    const v = detectPendingWork(lines, { nowMs: T0 + DEFAULT_PENDING_WORK_HORIZON_MS + 1 })
    expect(v).toMatchObject({ pending: false, detail: 'stale' })
  })

  it('an errored / max-turns result is a real end even with work pending', () => {
    const pendingTail = [agentLaunched(T0), bgChanged(['a1bebe1ab05678b8b'])]
    expect(detectPendingWork([...pendingTail, result({ is_error: true, api_error_status: 429 })], { nowMs: T0 + 1_000 }))
      .toMatchObject({ pending: false, detail: 'error-result' })
    expect(detectPendingWork([...pendingTail, result({ subtype: 'error_max_turns' })], { nowMs: T0 + 1_000 }))
      .toMatchObject({ pending: false, detail: 'error-result' })
  })

  it('last typed event is not a result → not pending (caller already says working)', () => {
    const lines = [agentLaunched(T0), bgChanged(['a1bebe1ab05678b8b'])]
    expect(detectPendingWork(lines, { nowMs: T0 + 1_000 })).toMatchObject({ pending: false, detail: 'no-result' })
  })

  it('malformed lines are skipped (fail-safe to today’s behaviour)', () => {
    const lines = ['{"type":"user","message":', 'not json at all', '', '42', 'null', result()]
    expect(detectPendingWork(lines, { nowMs: T0 })).toMatchObject({ pending: false })
    // A clipped leading line (tail read) does not hide pending work after it.
    const clipped = ['ult","content":"trunc', wakeupScheduled(T0, 600), '{broken', result()]
    expect(detectPendingWork(clipped, { nowMs: T0 + 1_000 }).pending).toBe(true)
    // Garbage input never throws.
    expect(detectPendingWork(undefined as unknown as string[], { nowMs: T0 }).pending).toBe(false)
  })

  it('obj 712937 session 1 shape: Monitor armed, interim result, later continuation', () => {
    // "Waiting for the queued 220500 run to finish before re-triggering…" —
    // the card was parked here; the CLI resumed 2 min later on the monitor.
    const lines = [
      monitorStarted(T0, 'b9s80rgv2', '2m'),
      bgChanged(['b9s80rgv2']),
      assistantText(T0 + 2_000, 'Waiting for the queued 220500 run to finish before re-triggering the two that got cancelled.'),
      result({ uuid: 'da3b95fe' }),
    ]
    expect(detectPendingWork(lines, { nowMs: T0 + 10_000 }).pending).toBe(true)
  })
})
