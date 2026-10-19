import type { SessionMessage, ThreadSegment } from '@operationkit/shared'

// The trailing gap of an active session is auto-expanded by the UI and
// re-fetched every poll (see ThreadTimeline's trailingLiveKey). Cap how many of
// the most-recent messages that live tail contains so the auto-refetched slice
// — and its markdown render — stay small no matter how long the session has run
// since its last summary. Older activity splits into a normal collapsed gap the
// user can expand on demand.
const LIVE_TAIL_CAP = 40

/**
 * Collapse a session's full SessionMessage[] into a timeline of visible anchors
 * (summaries, dividers, errors, the trailing in-progress agent message) with
 * collapsed "actions" gaps in between that the UI can expand on demand.
 *
 * Pure: depends only on its input. See thread-timeline.test.ts for the pinned
 * behaviour.
 *
 * Algorithm: walk by index, folding consecutive non-visible messages
 * (tool/assistant/system/user) into a pending gap. A VISIBLE message
 * (result/followup/error) first flushes the pending gap as an `actions` segment
 * for [gapStart, i) when it is non-empty, then emits its own segment. The
 * trailing region (anything after the last visible anchor) gets special
 * treatment: the LAST assistant message there is promoted to a `question`
 * segment so the latest in-progress agent text is never hidden, while assistant
 * messages before a result stay folded (the result already carries final text).
 */
export function buildThreadTimeline(messages: SessionMessage[]): ThreadSegment[] {
  const segments: ThreadSegment[] = []
  const n = messages.length

  let gapStart = 0
  let count = 0
  let toolCount = 0

  // Emit an `actions` segment for [start, end) only when it folds ≥1 message.
  const flushGap = (start: number, end: number, c: number, tc: number) => {
    if (c > 0) segments.push({ type: 'actions', startIndex: start, endIndex: end, count: c, toolCount: tc })
  }

  // Flush a trailing gap that will become the live (auto-expanded) tail. If it
  // exceeds LIVE_TAIL_CAP, split into an earlier collapsed gap + a bounded tail
  // gap so the live slice the UI re-polls stays small.
  const flushTrailingGap = (start: number, end: number) => {
    const size = end - start
    if (size <= 0) return
    if (size <= LIVE_TAIL_CAP) {
      flushGap(start, end, size, countTools(messages, start, end))
      return
    }
    const tailStart = end - LIVE_TAIL_CAP
    flushGap(start, tailStart, tailStart - start, countTools(messages, start, tailStart))
    flushGap(tailStart, end, LIVE_TAIL_CAP, countTools(messages, tailStart, end))
  }

  for (let i = 0; i < n; i++) {
    const m = messages[i]
    const isVisible = m.type === 'result' || m.type === 'followup' || m.type === 'error'

    if (!isVisible) {
      // Fold non-visible kinds (tool/assistant/system/user) into the pending gap.
      if (count === 0) gapStart = i
      count++
      if (m.type === 'tool') toolCount++
      continue
    }

    // Visible anchor: flush the pending gap, then emit the anchor's segment.
    flushGap(gapStart, i, count, toolCount)
    count = 0
    toolCount = 0

    if (m.type === 'result') {
      segments.push({ type: 'summary', index: i, text: m.text || '', cost: m.cost, duration: m.duration, timestamp: m.timestamp })
    } else if (m.type === 'followup') {
      segments.push({ type: 'divider', index: i, text: m.text || '', timestamp: m.timestamp })
    } else {
      // error
      segments.push({ type: 'error', index: i, text: m.text || '', timestamp: m.timestamp })
    }
  }

  // Trailing region: the pending gap (if any) after the final visible anchor.
  // Promote the LAST assistant message there to a `question` so the latest
  // in-progress agent text stays visible.
  if (count > 0) {
    let lastAssistant = -1
    for (let i = gapStart; i < n; i++) {
      if (messages[i].type === 'assistant') lastAssistant = i
    }

    if (lastAssistant !== -1) {
      flushGap(gapStart, lastAssistant, lastAssistant - gapStart, countTools(messages, gapStart, lastAssistant))
      const a = messages[lastAssistant]
      segments.push({ type: 'question', index: lastAssistant, text: a.text || '', timestamp: a.timestamp })
      flushTrailingGap(lastAssistant + 1, n)
    } else {
      flushTrailingGap(gapStart, n)
    }
  }

  return compactSystemWakes(segments)
}

function isChildCompleteDivider(s: ThreadSegment): s is Extract<ThreadSegment, { type: 'divider' }> {
  return s.type === 'divider' && s.text.startsWith('[child-complete]')
}

function isSystemish(s: ThreadSegment): boolean {
  return s.type === 'actions' || s.type === 'summary' || isChildCompleteDivider(s)
}

/**
 * Collapse a run of machine wakes (child-complete dividers + session-end
 * summaries) into one divider and the latest summary. Human follow-ups,
 * errors, and the live question stay. Fixes threads like obj 707801 where
 * 28 identical "worker completed" lines stacked.
 */
export function compactSystemWakes(segments: ThreadSegment[]): ThreadSegment[] {
  const out: ThreadSegment[] = []
  let i = 0
  while (i < segments.length) {
    if (!isSystemish(segments[i])) {
      out.push(segments[i])
      i++
      continue
    }
    const runStart = i
    let childN = 0
    let lastChild: Extract<ThreadSegment, { type: 'divider' }> | null = null
    while (i < segments.length && isSystemish(segments[i])) {
      const s = segments[i]
      if (isChildCompleteDivider(s)) {
        childN++
        lastChild = s
      }
      i++
    }
    const run = segments.slice(runStart, i)
    // Ordinary session results (no worker-finished ping) stay as they are.
    if (childN === 0 || !lastChild) {
      out.push(...run)
      continue
    }
    // Keep the parent work that landed BEFORE the first worker ping, then
    // collapse the ping stack to one divider + the latest wake summary.
    const firstChildAt = run.findIndex(isChildCompleteDivider)
    const prefix = run.slice(0, firstChildAt)
    const rest = run.slice(firstChildAt)
    out.push(...prefix)
    const restActions = rest.filter((s): s is Extract<ThreadSegment, { type: 'actions' }> => s.type === 'actions')
    const restSummary = [...rest].reverse().find(s => s.type === 'summary')
    if (restActions.length === 1) {
      out.push(restActions[0])
    } else if (restActions.length > 1) {
      const first = restActions[0]
      const last = restActions[restActions.length - 1]
      out.push({
        type: 'actions',
        startIndex: first.startIndex,
        endIndex: last.endIndex,
        count: restActions.reduce((n, a) => n + a.count, 0),
        toolCount: restActions.reduce((n, a) => n + a.toolCount, 0),
      })
    }
    out.push({
      ...lastChild,
      text: childN > 1 ? `[child-complete] ×${childN}` : lastChild.text,
    })
    if (restSummary) out.push(restSummary)
  }
  return out
}

/** Count `tool` messages in messages[start, end). */
function countTools(messages: SessionMessage[], start: number, end: number): number {
  let tc = 0
  for (let i = start; i < end; i++) if (messages[i].type === 'tool') tc++
  return tc
}

// ── Timeline memoization ──
// buildThreadTimeline is O(n) over the full message array. The thread viewer
// polls ?view=timeline every 2s for a working session, so recomputing the whole
// timeline on every poll is wasted work once a session has thousands of
// messages. The parsed message array (from getSessionOutput) is append-only —
// existing entries never change type/text (tool results attach to `toolResult`,
// which the timeline ignores) — so the segment list is a pure function of the
// message COUNT for a given session. We cache the last-built segments keyed by
// sessionId and reuse them whenever the count is unchanged; a new message
// invalidates the entry and triggers exactly one rebuild.
interface TimelineCacheEntry {
  count: number
  segments: ThreadSegment[]
}
const timelineCache = new Map<string, TimelineCacheEntry>()

/**
 * Memoized wrapper around buildThreadTimeline, keyed by (sessionId, message
 * count). Returns the cached segment list when the session's message count is
 * unchanged since the last build, so a steady-state poll costs a Map lookup
 * instead of an O(n) full-array walk. `buildThreadTimeline` itself stays pure.
 */
export function buildThreadTimelineCached(sessionId: string, messages: SessionMessage[]): ThreadSegment[] {
  const cached = timelineCache.get(sessionId)
  if (cached && cached.count === messages.length) return cached.segments
  const segments = buildThreadTimeline(messages)
  timelineCache.set(sessionId, { count: messages.length, segments })
  return segments
}

/** Evict a session's memoized timeline (call alongside evictOutputCache). */
export function evictTimelineCache(sessionId: string) {
  timelineCache.delete(sessionId)
}
