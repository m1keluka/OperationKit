import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { Crosshair, Maximize2, Minimize2, Minus, Network, Plus } from 'lucide-react'
import { matchPages, shortTitle, visibleGraph, type WorkspaceGraphNode, type WorkspaceGraphResponse } from '../../lib/kbWiki'
import {
  boundsOf, createSimulation, fitView, nodeRadius, reheat, settle, tick, zoomAt, ALPHA_MIN,
  type Simulation, type View,
} from '../../lib/kbGraphLayout'
import { Alert, EmptyState, IconButton, SearchInput, Skeleton, cn } from '../ui'
import { kindName, toneOf } from './kinds'
import { wikiApi, wsQuery } from './wikiApi'

/* WorkspaceGraph (obj 900674) — the whole knowledge base as one Obsidian-style
   graph: every page a dot, every connection a line, read from the kb_edges
   table that #720162 added (GET /api/kb-wiki/graph). Pages that link a lot are
   bigger; hover a page to light up its neighbours, click to open it, drag to
   pull it around, scroll or pinch-buttons to zoom. Plain SVG + a small force
   layout (lib/kbGraphLayout) — no graph library, and only theme tokens, so it
   reads the same in light and dark. */

const HEIGHT = 560
const HEIGHT_PHONE = 420
/** Hubs whose names are always shown, however far out you zoom. */
const ALWAYS_LABELLED = 12
/** Past this many pages, the dots leave the Tab order — the "Find a page" box is the keyboard route. */
const MAX_TABBABLE = 150
const LABEL_ZOOM = 1.15
const DRAG_SLOP = 4

type Drag =
  | { kind: 'pan'; id: number; sx: number; sy: number; vx: number; vy: number; moved: boolean }
  | { kind: 'node'; id: number; index: number; sx: number; sy: number; moved: boolean }

export function WorkspaceGraph({
  workspace,
  onOpenNote,
  refreshKey = 0,
  fill = false,
}: {
  workspace: string
  /** Open a page; `root` is the absolute folder `rel` is relative to. */
  onOpenNote: (rel: string, root?: string) => void
  refreshKey?: number
  /** Grow to the height of the parent (a flex column) instead of a fixed height. */
  fill?: boolean
}) {
  const [data, setData] = useState<WorkspaceGraphResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [hiddenKinds, setHiddenKinds] = useState<Set<string>>(() => new Set())
  const [showIsolated, setShowIsolated] = useState(true)
  const [query, setQuery] = useState('')
  const [hover, setHover] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [size, setSize] = useState({ w: 800, h: HEIGHT })
  const [view, setView] = useState<View | null>(null)
  // Bumped every animation frame while the layout moves (after a drag).
  const [, setFrame] = useState(0)

  const box = useRef<HTMLDivElement>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const drag = useRef<Drag | null>(null)
  const raf = useRef<number | null>(null)

  // ── Data ──
  useEffect(() => {
    let live = true
    setLoading(true)
    wikiApi<WorkspaceGraphResponse>(`/graph?${wsQuery(workspace)}`)
      .then(g => { if (live) { setData(g); setError(null) } })
      .catch(e => { if (live) { setData(null); setError((e as Error).message) } })
      .finally(() => { if (live) setLoading(false) })
    return () => { live = false }
  }, [workspace, refreshKey])

  const shown = useMemo(() => (data ? visibleGraph(data, { hiddenKinds, showIsolated }) : null), [data, hiddenKinds, showIsolated])

  // ── Layout: a fresh simulation whenever the drawn set changes, settled before first paint ──
  const sim = useMemo<Simulation | null>(() => {
    if (!shown) return null
    const index = new Map(shown.nodes.map((n, i) => [n.rel, i]))
    const s = createSimulation(
      shown.nodes.map(n => n.rel),
      shown.nodes.map(n => n.degree),
      shown.links.map(l => [index.get(l.a)!, index.get(l.b)!] as [number, number]),
    )
    settle(s)
    return s
  }, [shown])

  const byRel = useMemo(() => new Map((shown?.nodes ?? []).map((n, i) => [n.rel, { node: n, i }])), [shown])
  const neighbours = useMemo(() => {
    const m = new Map<string, Set<string>>()
    for (const l of shown?.links ?? []) {
      if (!m.has(l.a)) m.set(l.a, new Set())
      if (!m.has(l.b)) m.set(l.b, new Set())
      m.get(l.a)!.add(l.b); m.get(l.b)!.add(l.a)
    }
    return m
  }, [shown])
  // The best-connected people, companies, projects and topics keep their names at any zoom (not sources: there are many, and they read as files).
  const hubs = useMemo(() => new Set([...(shown?.nodes ?? [])].filter(n => n.kind !== 'source' && n.degree > 0).sort((a, b) => b.degree - a.degree).slice(0, ALWAYS_LABELLED).map(n => n.rel)), [shown])
  const matches = useMemo(() => (shown ? matchPages(shown.nodes, query) : []), [shown, query])
  const matchSet = useMemo(() => new Set(matches.map(m => m.rel)), [matches])

  // ── Size ──
  useEffect(() => {
    const el = box.current
    if (!el) return
    const fit = () => {
      const w = Math.max(280, Math.round(el.clientWidth || 800))
      const h = expanded || fill ? Math.max(360, Math.round(el.clientHeight || window.innerHeight - 160)) : (w < 640 ? HEIGHT_PHONE : HEIGHT)
      setSize(s => (s.w === w && s.h === h ? s : { w, h }))
    }
    fit()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(fit)
    ro.observe(el)
    return () => ro.disconnect()
  }, [expanded, fill, data])

  const fit = useCallback(() => {
    if (sim) setView(fitView(boundsOf(sim.nodes), size.w, size.h))
  }, [sim, size.w, size.h])
  // Re-fit when the drawn set or the box changes.
  useEffect(() => { fit() }, [fit])

  // Escape closes the full-screen view.
  useEffect(() => {
    if (!expanded) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setExpanded(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [expanded])

  // Wheel zoom needs a non-passive listener to keep the page from scrolling.
  useEffect(() => {
    const el = svgRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const r = el.getBoundingClientRect()
      setView(v => (v ? zoomAt(v, Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top) : v))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [sim])

  useEffect(() => () => { if (raf.current !== null) cancelAnimationFrame(raf.current) }, [])

  // ── Animation (only while something moves) ──
  const animate = useCallback(() => {
    if (!sim || raf.current !== null) return
    const step = () => {
      tick(sim)
      setFrame(f => f + 1)
      if (sim.alpha > ALPHA_MIN || drag.current?.kind === 'node') raf.current = requestAnimationFrame(step)
      else raf.current = null
    }
    raf.current = requestAnimationFrame(step)
  }, [sim])

  // ── Pointer: drag a dot, pan the background, click to open ──
  const toGraph = (clientX: number, clientY: number) => {
    const r = svgRef.current!.getBoundingClientRect()
    const v = view ?? { x: 0, y: 0, k: 1 }
    return { x: (clientX - r.left - v.x) / v.k, y: (clientY - r.top - v.y) / v.k }
  }

  /** The dot under the pointer: the nearest one within its tap radius (≥ 22px on screen), so close dots never steal each other's taps. */
  const nodeAt = (clientX: number, clientY: number): { node: WorkspaceGraphNode; i: number } | undefined => {
    if (!sim || !shown || !svgRef.current) return undefined
    const p = toGraph(clientX, clientY)
    const k = view?.k ?? 1
    let best = -1, bestD = Infinity
    for (let i = 0; i < sim.nodes.length; i++) {
      const n = sim.nodes[i]
      const d = Math.hypot(n.x - p.x, n.y - p.y)
      if (d <= Math.max(nodeRadius(n.degree) + 4 / k, 22 / k) && d < bestD) { best = i; bestD = d }
    }
    return best < 0 ? undefined : { node: shown.nodes[best], i: best }
  }

  const onPointerDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (e.button !== 0 || !view) return
    const hit = nodeAt(e.clientX, e.clientY)
    svgRef.current?.setPointerCapture?.(e.pointerId)
    if (hit) drag.current = { kind: 'node', id: e.pointerId, index: hit.i, sx: e.clientX, sy: e.clientY, moved: false }
    else drag.current = { kind: 'pan', id: e.pointerId, sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y, moved: false }
  }

  const onPointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    const d = drag.current
    if (!d) {
      const rel = nodeAt(e.clientX, e.clientY)?.node.rel ?? null
      setHover(h => (h === rel ? h : rel))
      return
    }
    if (d.id !== e.pointerId) return
    if (!d.moved && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < DRAG_SLOP) return
    d.moved = true
    if (d.kind === 'pan') {
      setView(v => (v ? { ...v, x: d.vx + e.clientX - d.sx, y: d.vy + e.clientY - d.sy } : v))
    } else if (sim) {
      const p = toGraph(e.clientX, e.clientY)
      const n = sim.nodes[d.index]
      n.fx = p.x; n.fy = p.y
      reheat(sim)
      animate()
    }
  }

  const onPointerUp = (e: ReactPointerEvent<SVGSVGElement>) => {
    const d = drag.current
    if (!d || d.id !== e.pointerId) return
    drag.current = null
    if (d.kind === 'node' && sim) {
      const n = sim.nodes[d.index]
      n.fx = null; n.fy = null
      if (!d.moved) onOpenNote(n.id, data?.root)
    }
  }

  const zoomBy = (factor: number) => setView(v => (v ? zoomAt(v, factor, size.w / 2, size.h / 2) : v))
  const focusOn = (rel: string) => {
    const hit = byRel.get(rel)
    if (!hit || !sim) return
    const p = sim.nodes[hit.i]
    setView(v => { const k = Math.max(v?.k ?? 1, 1.4); return { k, x: size.w / 2 - p.x * k, y: size.h / 2 - p.y * k } })
    setHover(rel)
  }

  const toggleKind = (kind: string) => setHiddenKinds(s => {
    const next = new Set(s)
    if (next.has(kind)) next.delete(kind); else next.add(kind)
    return next
  })

  // ── Render ──
  if (loading && !data) {
    return (
      <div className="flex flex-col gap-3" aria-busy="true">
        <span className="sr-only">Loading the graph…</span>
        <Skeleton className="h-9 w-full sm:w-72" />
        <Skeleton className="h-[420px] w-full rounded-md sm:h-[560px]" />
      </div>
    )
  }
  if (error) return <Alert tone="alarm" title="Couldn't load the graph">{error}</Alert>
  if (!data || !shown || !sim) return null
  if (data.nodes.length === 0) {
    return (
      <EmptyState
        compact
        icon={<Network className="h-5 w-5" aria-hidden="true" />}
        title="Nothing to graph yet"
        description="Upload files above or import your chats and calls. Every page they create shows up here as a dot, linked to the people, companies and topics it mentions."
      />
    )
  }

  const kinds = Object.entries(data.counts.by_kind).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  const focus = hover && byRel.has(hover) ? hover : null
  const lit = focus ? new Set([focus, ...(neighbours.get(focus) ?? [])]) : null
  const searching = query.trim().length > 0
  const v = view ?? { x: size.w / 2, y: size.h / 2, k: 1 }
  const showAllLabels = v.k >= LABEL_ZOOM
  const tabbable = shown.nodes.length <= MAX_TABBABLE
  const pos = (rel: string) => sim.nodes[byRel.get(rel)!.i]
  const focusNode: WorkspaceGraphNode | null = focus ? byRel.get(focus)!.node : null
  const fp = focus ? pos(focus) : null
  const dim = (rel: string) => (lit ? !lit.has(rel) : searching ? !matchSet.has(rel) : false)
  const fontSize = 12 / v.k
  // Names that would overlap one already placed are skipped (the focused page and its neighbours win, then the hubs).
  const labels = new Set<string>()
  {
    const want = shown.nodes.filter(n => n.rel === focus || (lit?.has(n.rel) ?? false) || (searching && matchSet.has(n.rel)) || (!lit && !searching && (showAllLabels || hubs.has(n.rel))))
    want.sort((a, b) => Number(b.rel === focus) - Number(a.rel === focus) || b.degree - a.degree)
    const boxes: Array<[number, number, number, number]> = []
    for (const n of want) {
      const p = pos(n.rel)
      const text = shortTitle(n.title, n.rel === focus ? 40 : 22)
      const w = text.length * fontSize * (n.rel === focus ? 0.66 : 0.6)
      const x0 = p.x - w / 2, y0 = p.y + nodeRadius(n.degree) + 2 / v.k, x1 = x0 + w, y1 = y0 + fontSize * 1.25
      if (n.rel !== focus && boxes.some(b => x0 < b[2] && x1 > b[0] && y0 < b[3] && y1 > b[1])) continue
      boxes.push([x0, y0, x1, y1])
      labels.add(n.rel)
    }
  }

  return (
    <div
      className={cn(
        'flex flex-col gap-3',
        fill && 'min-h-0 flex-1',
        expanded && 'fixed inset-0 z-50 bg-surface-0 p-3 sm:p-5',
      )}
      role={expanded ? 'dialog' : undefined}
      aria-modal={expanded || undefined}
      aria-label={expanded ? 'Knowledge base graph, full screen' : undefined}
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <SearchInput
          value={query}
          onChange={e => { setQuery(e.target.value); setHover(null) }}
          onKeyDown={e => {
            if (e.key === 'Enter' && matches[0]) { e.preventDefault(); onOpenNote(matches[0].rel, data.root) }
          }}
          placeholder="Find a page"
          aria-label="Find a page in the graph (Enter opens the best match)"
          wrapClassName="w-full sm:w-72"
        />
        <span className="text-[12px] text-fg-3" aria-live="polite">
          {searching
            ? `${matches.length} match${matches.length === 1 ? '' : 'es'}${matches[0] ? ` — Enter opens “${shortTitle(matches[0].title, 28)}”` : ''}`
            : `${shown.nodes.length} page${shown.nodes.length === 1 ? '' : 's'} · ${shown.links.length} connection${shown.links.length === 1 ? '' : 's'}`}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Show or hide page kinds">
        {kinds.map(([kind, count]) => {
          const on = !hiddenKinds.has(kind)
          return (
            <button
              key={kind}
              type="button"
              aria-pressed={on}
              onClick={() => toggleKind(kind)}
              className={cn(
                'inline-flex min-h-[44px] items-center gap-1.5 rounded-full border px-2.5 text-[12px] transition-colors duration-fast focus:outline-none focus-visible:ring-2 focus-visible:ring-accent sm:min-h-[28px]',
                on ? 'border-line bg-surface-2 text-fg-1 hover:border-line-strong' : 'border-dashed border-line-soft text-fg-3 hover:text-fg-2',
              )}
            >
              <span className={cn('h-2 w-2 rounded-full', toneOf(kind).bg, !on && 'opacity-30')} aria-hidden="true" />
              {kindName(kind)}
              <span className="font-mono text-[12px] text-fg-3">{count}</span>
            </button>
          )
        })}
        <label className="ml-auto inline-flex min-h-[44px] cursor-pointer items-center gap-2 text-[12px] text-fg-2 sm:min-h-[28px]">
          <input type="checkbox" className="h-4 w-4 accent-accent" checked={showIsolated} onChange={e => setShowIsolated(e.target.checked)} />
          Unconnected pages
        </label>
      </div>

      <div
        ref={box}
        className={cn('relative overflow-hidden rounded-md border border-line-soft bg-surface-1', (expanded || fill) && 'min-h-[360px] flex-1')}
      >
        <svg
          ref={svgRef}
          width={size.w}
          height={size.h}
          viewBox={`0 0 ${size.w} ${size.h}`}
          className={cn('block touch-none select-none', (expanded || fill) && 'absolute inset-0', drag.current ? 'cursor-grabbing' : focus ? 'cursor-pointer' : 'cursor-grab')}
          role="group"
          aria-label={`Graph of ${shown.nodes.length} knowledge-base pages and ${shown.links.length} connections between them`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onPointerLeave={() => { if (!drag.current) setHover(null) }}
        >
          <g transform={`translate(${v.x} ${v.y}) scale(${v.k})`}>
            <g aria-hidden="true">
              {shown.links.map(l => {
                const a = pos(l.a), b = pos(l.b)
                const on = focus !== null && (l.a === focus || l.b === focus)
                const faded = (lit && !on) || (searching && !lit && !(matchSet.has(l.a) || matchSet.has(l.b)))
                return (
                  <line
                    key={`${l.a}|${l.b}`}
                    x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                    className={cn(on ? 'stroke-accent' : 'stroke-line-strong', faded && 'opacity-15')}
                    strokeWidth={(on ? 1.6 : 0.9) / Math.sqrt(v.k)}
                    strokeDasharray={l.kinds.length === 1 && l.kinds[0] === 'cited_by' ? `${3 / v.k} ${3 / v.k}` : undefined}
                  />
                )
              })}
            </g>
            {shown.nodes.map(n => {
              const p = pos(n.rel)
              const r = nodeRadius(n.degree)
              const isFocus = n.rel === focus
              const faded = dim(n.rel)
              return (
                <g
                  key={n.rel}
                  data-rel={n.rel}
                  role="button"
                  tabIndex={tabbable ? 0 : -1}
                  aria-label={`Open ${n.title} (${kindName(n.kind)}, ${n.degree} connection${n.degree === 1 ? '' : 's'})`}
                  onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpenNote(n.rel, data.root) } }}
                  onFocus={() => focusOn(n.rel)}
                  onBlur={() => setHover(h => (h === n.rel ? null : h))}
                  className={cn('outline-none transition-opacity duration-fast', faded && 'opacity-20')}
                >
                  {(isFocus || (searching && matchSet.has(n.rel))) && (
                    <circle cx={p.x} cy={p.y} r={r + 3.5 / v.k} className="fill-none stroke-accent" strokeWidth={2 / v.k} />
                  )}
                  <circle cx={p.x} cy={p.y} r={r} className={cn(toneOf(n.kind).fill, 'stroke-surface-1')} strokeWidth={1.2 / v.k} />
                </g>
              )
            })}
            {/* Names in their own layer, above every dot, so a neighbour never covers one. */}
            <g aria-hidden="true" className="pointer-events-none">
              {shown.nodes.filter(n => labels.has(n.rel)).map(n => {
                const p = pos(n.rel)
                const isFocus = n.rel === focus
                return (
                  <text
                    key={n.rel}
                    x={p.x}
                    y={p.y + nodeRadius(n.degree) + fontSize + 2 / v.k}
                    textAnchor="middle"
                    paintOrder="stroke"
                    strokeWidth={3.5 / v.k}
                    strokeLinejoin="round"
                    fontSize={fontSize}
                    className={cn('stroke-surface-1', isFocus ? 'fill-fg-0 font-semibold' : 'fill-fg-1', dim(n.rel) && 'opacity-20')}
                  >
                    {shortTitle(n.title, isFocus ? 40 : 22)}
                  </text>
                )
              })}
            </g>
          </g>
        </svg>

        {focusNode && fp && !drag.current && (
          <div
            className="pointer-events-none absolute z-10 max-w-[260px] rounded-md border border-line bg-surface-2 px-3 py-2 shadow-lg"
            style={{
              left: Math.min(size.w - 270, Math.max(8, fp.x * v.k + v.x + 14)),
              top: Math.min(size.h - 80, Math.max(8, fp.y * v.k + v.y - 12)),
            }}
          >
            <div className="flex items-center gap-1.5 text-[12px] uppercase tracking-[0.06em] text-fg-3">
              <span className={cn('h-2 w-2 rounded-full', toneOf(focusNode.kind).bg)} aria-hidden="true" />
              {kindName(focusNode.kind)}
            </div>
            <div className="mt-0.5 text-[13px] font-medium leading-snug text-fg-0">{focusNode.title}</div>
            <div className="mt-0.5 text-[12px] text-fg-2">
              {focusNode.degree} connection{focusNode.degree === 1 ? '' : 's'} · click to open
            </div>
          </div>
        )}

        <div className="absolute right-2 top-2 flex flex-col gap-1 rounded-md border border-line-soft bg-surface-2/90 p-0.5 backdrop-blur">
          <IconButton label="Zoom in" onClick={() => zoomBy(1.3)}><Plus className="h-4 w-4" aria-hidden="true" /></IconButton>
          <IconButton label="Zoom out" onClick={() => zoomBy(1 / 1.3)}><Minus className="h-4 w-4" aria-hidden="true" /></IconButton>
          <IconButton label="Fit the whole graph" onClick={fit}><Crosshair className="h-4 w-4" aria-hidden="true" /></IconButton>
          <IconButton label={expanded ? 'Exit full screen' : 'Full screen'} onClick={() => setExpanded(x => !x)}>
            {expanded ? <Minimize2 className="h-4 w-4" aria-hidden="true" /> : <Maximize2 className="h-4 w-4" aria-hidden="true" />}
          </IconButton>
        </div>
      </div>

      <p className="text-[12px] leading-relaxed text-fg-3">
        Bigger dots link to more pages. Hover a page to light up what it connects to, click to open it, drag it to pull its
        neighbours along. Dashed lines are “cited by a source” only.
        {data.truncated && ` The ${data.nodes.length} best-connected of ${data.counts.pages} pages are drawn.`}
        {!!data.counts.unresolved && ` ${data.counts.unresolved} link${data.counts.unresolved === 1 ? ' points' : 's point'} at a page that is not in this knowledge base.`}
      </p>
    </div>
  )
}
