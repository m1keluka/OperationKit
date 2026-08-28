import { useCallback, useEffect, useRef, useState } from 'react'
import type { SessionMessage, ThreadSegment, ThreadTimeline as ThreadTimelineData, ThreadTimelineUnchanged } from '@command-center/shared'
import { renderMarkdown } from '../lib/markdown'
import { api } from '../lib/api'
import { echoLandedInSegments } from '../lib/followup-echo'
import { GroupedMessages, ResultCard, ErrorCard } from './SessionMessages'
import type { ConnState } from './ConnStatusPill'

// Collapsed session thread. Renders the `?view=timeline` segments — visible
// anchors (summary/divider/question/error) interleaved with collapsed `actions`
// gaps. Each gap lazily fetches its raw messages (`?from&to`) and renders them
// inline with the existing <GroupedMessages> so an expanded gap looks exactly
// like the un-collapsed thread.

interface ThreadTimelineProps {
  objectiveId: number
  /** Drives polling cadence + trailing-gap live behaviour. */
  status: string
  /** Bubble status changes detected from the timeline payload up to the viewer. */
  onStatus?: (status: string) => void
  /** Container the selection-preservation guard checks against (the scroll area). */
  scrollContainerRef: React.RefObject<HTMLElement | null>
  /** Notifies the viewer when the rendered content grows, so it can auto-scroll. */
  onContentChange?: () => void
  /** Bubbles the live-stream connection state (SSE open / connecting / poll fallback)
   *  up to the viewer so it can render the header connection pill. */
  onConnState?: (state: ConnState) => void
  /** Optimistic send text — retire it once this text is a real divider. */
  pendingEcho?: string | null
  onEchoLanded?: () => void
}

const gapKey = (s: { startIndex: number; endIndex: number }) => `${s.startIndex}:${s.endIndex}`

// ── Collapsed action-gap bar ──

function ActionsGap({
  seg,
  expanded,
  live,
  slice,
  loading,
  onToggle,
}: {
  seg: Extract<ThreadSegment, { type: 'actions' }>
  expanded: boolean
  live: boolean
  slice: SessionMessage[] | undefined
  loading: boolean
  onToggle: () => void
}) {
  const label = (seg.toolCount || seg.count)
  if (expanded) {
    return (
      <div className="my-1">
        {!live && (
          <button
            onClick={onToggle}
            className="mb-1 flex w-full items-center gap-2 rounded-lg border border-line bg-surface-2 px-3 py-1.5 text-left text-xs text-fg-2 hover:text-fg-1"
          >
            <span className="text-[10px] text-fg-3 transition-transform rotate-90">{'▸'}</span>
            <span className="font-medium">Collapse {label} action{label !== 1 ? 's' : ''}</span>
          </button>
        )}
        {slice && slice.length > 0 ? (
          <div className="border-l border-line/60 pl-3">
            <GroupedMessages messages={slice} />
          </div>
        ) : (
          <div className="pl-3 text-xs text-fg-3">{loading || !slice ? 'Loading…' : 'No activity'}</div>
        )}
      </div>
    )
  }
  return (
    <div className="my-1">
      <button
        onClick={onToggle}
        className="flex w-full items-center gap-2 rounded-lg border border-line bg-surface-2 px-3 py-1.5 text-left text-xs text-fg-2 hover:bg-surface-3 hover:text-fg-1"
      >
        <span className="text-[10px] text-fg-3">{'▸'}</span>
        <span className="font-medium">Expand to show {label} action{label !== 1 ? 's' : ''}</span>
        {loading && <span className="ml-auto text-[10px] text-fg-3">Loading…</span>}
      </button>
    </div>
  )
}

// ── Divider (followup): child-complete nudge OR a user message ──

function Divider({ seg }: { seg: Extract<ThreadSegment, { type: 'divider' }> }) {
  const childMatch = seg.text.match(/^\[child-complete\](?:\s*×(\d+))?/)
  if (childMatch) {
    const n = childMatch[1] ? parseInt(childMatch[1], 10) : 1
    const label = n > 1 ? `${n} workers finished` : 'worker finished'
    return (
      <div className="my-3 flex items-center gap-2" title={seg.text}>
        <div className="h-px flex-1 bg-line" />
        <span className="shrink-0 font-mono text-[10.5px] uppercase tracking-wider text-fg-3">
          {label}
        </span>
        <div className="h-px flex-1 bg-line" />
      </div>
    )
  }
  // A user message Mike typed into the thread — render it visibly (right-aligned,
  // matching the followup bubble in GroupedMessages).
  return (
    <div className="my-1 flex justify-end">
      <div
        className="overflow-hidden break-words rounded-lg bg-accent px-4 py-3 text-[14px] leading-relaxed text-accent-fg"
        style={{ maxWidth: 'min(85%, 64ch)' }}
      >
        {seg.text}
      </div>
    </div>
  )
}

// ── Question (trailing in-progress agent message) ──

function Question({ seg }: { seg: Extract<ThreadSegment, { type: 'question' }> }) {
  return (
    <div className="my-1 flex justify-start">
      <div className="w-full max-w-full rounded-lg border border-status-working/30 bg-status-working/[0.06] px-4 py-3">
        <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-status-working">Awaiting</div>
        <div
          className="cc-prose overflow-hidden break-words"
          dangerouslySetInnerHTML={{ __html: renderMarkdown(seg.text) }}
        />
      </div>
    </div>
  )
}

export function ThreadTimeline({ objectiveId, status, onStatus, scrollContainerRef, onContentChange, onConnState, pendingEcho, onEchoLanded }: ThreadTimelineProps) {
  const [segments, setSegments] = useState<ThreadSegment[]>([])
  const [total, setTotal] = useState(0)
  const [loaded, setLoaded] = useState(false)

  // Manually-opened gaps survive across polls. Keyed by "start:end" — completed
  // gap ranges are stable, so a cached slice stays valid; only the trailing gap
  // (it grows) is re-fetched each poll.
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set())
  // Slice cache keyed by "start:end". Held in a ref (mutated in place) plus a
  // bump counter so a newly-arrived slice triggers one re-render.
  const sliceCache = useRef<Map<string, SessionMessage[]>>(new Map())
  // Increments on every slice fetch start/finish; drives re-render + auto-scroll
  // (a trailing live gap re-fetches into the same key, so size alone is stale).
  const [sliceVersion, bumpSlices] = useState(0)
  const inFlight = useRef<Set<string>>(new Set())

  const working = status === 'working'
  const fetchingTimeline = useRef(false)
  // Last message count the server reported. Sent back as ?known=<count> so an
  // unchanged session short-circuits to a tiny body instead of re-shipping the
  // whole segment list every poll. A ref (not state) so the poll callback stays
  // stable and doesn't re-create the interval on every growth.
  const lastCountRef = useRef(0)
  // Bumped once per completed poll. Drives the live trailing-gap refetch even
  // when the segment list is unchanged — a tool *result* attaches to an existing
  // tool message without adding a message, so the count (and timeline) can be
  // unchanged while the live tail's content still grew.
  const [pollTick, setPollTick] = useState(0)

  // The trailing segment, when it's an actions gap during an active session, is
  // auto-expanded and re-fetched each poll so current activity streams in.
  const lastSeg = segments[segments.length - 1]
  const trailingLiveKey = working && lastSeg?.type === 'actions' ? gapKey(lastSeg) : null

  const isExpanded = useCallback(
    (seg: Extract<ThreadSegment, { type: 'actions' }>) => {
      const k = gapKey(seg)
      return k === trailingLiveKey || expandedKeys.has(k)
    },
    [expandedKeys, trailingLiveKey],
  )

  // Fetch a gap's raw messages. `force` re-fetches even if cached (trailing gap).
  const fetchSlice = useCallback(async (startIndex: number, endIndex: number, force = false) => {
    const k = `${startIndex}:${endIndex}`
    if (inFlight.current.has(k)) return
    if (!force && sliceCache.current.has(k)) return
    inFlight.current.add(k)
    bumpSlices(n => n + 1) // reflect loading state
    try {
      const data = await api.get<{ messages: SessionMessage[] }>(
        `/objectives/${objectiveId}/output?from=${startIndex}&to=${endIndex}`,
      )
      sliceCache.current.set(k, data.messages || [])
    } catch {
      // Leave uncached so a later poll/click can retry.
    } finally {
      inFlight.current.delete(k)
      bumpSlices(n => n + 1)
    }
  }, [objectiveId])

  const fetchTimeline = useCallback(async () => {
    // Don't disturb a user's active text selection inside the scroll container
    // (a re-render would collapse it). Mirrors SessionViewer's poll guard.
    const selection = window.getSelection()
    const container = scrollContainerRef.current
    if (selection && selection.toString().length > 0 && container) {
      const anchor = selection.anchorNode
      if (anchor && container.contains(anchor)) return
    }
    if (fetchingTimeline.current) return
    fetchingTimeline.current = true
    try {
      const data = await api.get<ThreadTimelineData | ThreadTimelineUnchanged>(
        `/objectives/${objectiveId}/output?view=timeline&known=${lastCountRef.current}`,
      )
      setLoaded(true)
      if (data.status && data.status !== status) onStatus?.(data.status)
      // Bump the poll tick every completed poll so the live trailing gap
      // refetches even when the segment list itself is unchanged.
      setPollTick(t => t + 1)
      // Session hasn't grown since our last poll — server sent the tiny
      // {unchanged} body. Nothing to re-render; keep the current segments.
      if ('unchanged' in data && data.unchanged) return
      const full = data as ThreadTimelineData
      lastCountRef.current = full.total ?? 0
      setSegments(full.segments || [])
      setTotal(full.total ?? 0)
    } catch {
      setLoaded(true)
    } finally {
      fetchingTimeline.current = false
    }
  }, [objectiveId, status, onStatus, scrollContainerRef])

  // Reset all per-objective state when the objective changes.
  useEffect(() => {
    setSegments([])
    setTotal(0)
    setLoaded(false)
    setExpandedKeys(new Set())
    sliceCache.current = new Map()
    inFlight.current = new Set()
    lastCountRef.current = 0 // force a full timeline fetch for the new objective
  }, [objectiveId])

  // Keep the latest fetchTimeline in a ref so the SSE effect (which we only want
  // to re-run when objective/working changes) can call the current closure
  // without listing fetchTimeline as a dep — otherwise every segment growth
  // (which re-creates fetchTimeline via `status`) would tear down + reopen the
  // EventSource.
  const fetchTimelineRef = useRef(fetchTimeline)
  useEffect(() => { fetchTimelineRef.current = fetchTimeline }, [fetchTimeline])

  // Report connection state up to the viewer (drives the header pill). Guarded
  // so we don't spam identical states.
  const connStateRef = useRef<ConnState | null>(null)
  const reportConn = useCallback((s: ConnState) => {
    if (connStateRef.current === s) return
    connStateRef.current = s
    onConnState?.(s)
  }, [onConnState])

  // Live streaming: replace the 2s poll with the SSE poke endpoint
  // GET /objectives/:id/stream. It emits `event: changed {total,status}` on
  // connect and on every output/status change; on each we run the SAME fetch
  // routine the poll used to run (timeline fetch → trailing-gap refetch via the
  // slice effect). A LONGER safety poll (10s) backstops missed pokes. If
  // EventSource is unavailable, or the connection reaches CLOSED, we tear it
  // down and fall back to the EXISTING 2s poll. A settled (not-working)
  // objective's transcript is static, so we fetch once, close the stream, and
  // rest in the quiet 'offline' state.
  useEffect(() => {
    // Always do an immediate fetch on mount / objective / status change.
    fetchTimelineRef.current()

    if (!working) {
      // Done/settled: static transcript. No stream, no poll — just the one
      // fetch above. Report the resting state.
      reportConn('offline')
      return
    }

    // ── Fallback: the classic 2s poll. Used when SSE is unavailable or dies. ──
    let pollInterval: ReturnType<typeof setInterval> | null = null
    const startFallbackPoll = () => {
      if (pollInterval) return
      reportConn('offline')
      pollInterval = setInterval(() => fetchTimelineRef.current(), 2000)
    }

    // ── SSE: primary path. ──
    let es: EventSource | null = null
    let safetyPoll: ReturnType<typeof setInterval> | null = null

    if (typeof EventSource === 'undefined') {
      startFallbackPoll()
    } else {
      reportConn('connecting')
      try {
        es = new EventSource(`/api/objectives/${objectiveId}/stream`, { withCredentials: true })
      } catch {
        startFallbackPoll()
      }
      if (es) {
        es.addEventListener('open', () => reportConn('live'))
        // Any `changed` poke → run the same fetch a poll tick would. We ignore
        // the payload body (total/status) and let fetchTimeline reconcile via
        // its own ?known= short-circuit + trailing-gap logic.
        es.addEventListener('changed', () => {
          reportConn('live')
          fetchTimelineRef.current()
        })
        es.onerror = () => {
          // CLOSED = the browser gave up (e.g. auth/404) — fall back to polling.
          // Otherwise (CONNECTING) it's a transient blip and EventSource will
          // auto-retry; surface that as 'connecting' and keep the stream.
          if (es && es.readyState === EventSource.CLOSED) {
            es.close()
            es = null
            startFallbackPoll()
          } else {
            reportConn('connecting')
          }
        }
        // Backstop: a longer poll in case a poke is dropped while the stream is
        // nominally open. Cheap thanks to the ?known= short-circuit.
        safetyPoll = setInterval(() => fetchTimelineRef.current(), 10000)
      }
    }

    return () => {
      if (es) es.close()
      if (safetyPoll) clearInterval(safetyPoll)
      if (pollInterval) clearInterval(pollInterval)
    }
  }, [objectiveId, working, reportConn])

  // Keep slices loaded for: every manually-expanded gap (cached, fetch-once) and
  // the live trailing gap (force re-fetch as it grows). Runs after each segment
  // update — total is in the dep list so trailing growth re-triggers the refetch.
  useEffect(() => {
    for (const seg of segments) {
      if (seg.type !== 'actions') continue
      const k = gapKey(seg)
      if (k === trailingLiveKey) {
        fetchSlice(seg.startIndex, seg.endIndex, true)
      } else if (expandedKeys.has(k)) {
        fetchSlice(seg.startIndex, seg.endIndex, false)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [segments, total, pollTick, expandedKeys, trailingLiveKey, fetchSlice])

  // Notify the viewer to auto-scroll when content grows (new segment, expanded
  // gap, or fresh slice data from the live trailing gap).
  useEffect(() => {
    onContentChange?.()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [segments.length, total, sliceVersion, expandedKeys])

  // Retire the optimistic send bubble only once the real follow-up is in the
  // timeline — not on every poll/live-tail tick (that was wiping the bubble
  // before jsonl caught up, so people retyped the same message).
  useEffect(() => {
    if (pendingEcho && echoLandedInSegments(segments, pendingEcho)) onEchoLanded?.()
  }, [segments, pendingEcho, onEchoLanded])

  const toggleGap = useCallback((seg: Extract<ThreadSegment, { type: 'actions' }>) => {
    const k = gapKey(seg)
    setExpandedKeys(prev => {
      const next = new Set(prev)
      if (next.has(k)) next.delete(k)
      else {
        next.add(k)
        fetchSlice(seg.startIndex, seg.endIndex, false)
      }
      return next
    })
  }, [fetchSlice])

  const actionGaps = segments.filter((s): s is Extract<ThreadSegment, { type: 'actions' }> => s.type === 'actions')
  const collapsibleGaps = actionGaps.filter(s => gapKey(s) !== trailingLiveKey)
  const allExpanded = collapsibleGaps.length > 0 && collapsibleGaps.every(s => expandedKeys.has(gapKey(s)))

  const toggleAll = useCallback(() => {
    if (allExpanded) {
      setExpandedKeys(new Set())
    } else {
      const next = new Set<string>()
      for (const s of collapsibleGaps) {
        next.add(gapKey(s))
        fetchSlice(s.startIndex, s.endIndex, false)
      }
      setExpandedKeys(next)
    }
  }, [allExpanded, collapsibleGaps, fetchSlice])

  if (!loaded && segments.length === 0) return null

  return (
    <div className="space-y-1">
      {collapsibleGaps.length > 0 && (
        <div className="flex justify-end">
          <button
            onClick={toggleAll}
            className="rounded px-2 py-0.5 text-[11px] text-fg-3 hover:text-fg-1"
          >
            {allExpanded ? 'Collapse all' : 'Expand all'}
          </button>
        </div>
      )}
      {segments.map(seg => {
        switch (seg.type) {
          case 'summary':
            return <ResultCard key={`s${seg.index}`} text={seg.text} cost={seg.cost} duration={seg.duration} />
          case 'error':
            return <ErrorCard key={`e${seg.index}`} text={seg.text} />
          case 'divider':
            return <Divider key={`d${seg.index}`} seg={seg} />
          case 'question':
            return <Question key={`q${seg.index}`} seg={seg} />
          case 'actions': {
            const k = gapKey(seg)
            const live = k === trailingLiveKey
            return (
              <ActionsGap
                key={`a${k}`}
                seg={seg}
                expanded={isExpanded(seg)}
                live={live}
                slice={sliceCache.current.get(k)}
                loading={inFlight.current.has(k)}
                onToggle={() => toggleGap(seg)}
              />
            )
          }
          default:
            return null
        }
      })}
    </div>
  )
}
