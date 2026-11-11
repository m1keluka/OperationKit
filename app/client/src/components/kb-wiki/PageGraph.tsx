import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { Share2 } from 'lucide-react'
import { edgeSentence, radialLayout, shortTitle, type GraphNeighbour, type RelatedResponse } from '../../lib/kbWiki'
import { Alert, Badge, Button, Skeleton, SkeletonText, cn } from '../ui'
import { wikiApi, wsQuery } from './wikiApi'

/* PageGraph (obj 720162) — the neighbourhood of one knowledge-base page: the
   page in the middle, every page it connects to around it, and the same list
   in words underneath. Plain SVG, no graph library: the server already did the
   work (GET /api/kb-wiki/graph/related, read from the kb_edges table). */

// The drawing is laid out at its real on-screen width (no scaling), so text
// stays readable and every node keeps a 44×44px tap target on a phone.
const MIN_W = 300
const MAX_W = 640
const heightFor = (w: number) => (w < 420 ? 300 : 260)
/** Keep a centred name (≈ 18 chars) inside the drawing. */
const NAME_HALF = 54
const MAX_DRAWN = 12
const LIST_PREVIEW = 6

/** Token colour per page kind — fill for the SVG dot, bg for the list dot. */
const KIND_TONE: Record<string, { fill: string; bg: string }> = {
  person: { fill: 'fill-agent-cto', bg: 'bg-agent-cto' },
  organization: { fill: 'fill-agent-cfo', bg: 'bg-agent-cfo' },
  project: { fill: 'fill-agent-coo', bg: 'bg-agent-coo' },
  product: { fill: 'fill-agent-cmo', bg: 'bg-agent-cmo' },
  topic: { fill: 'fill-status-planning', bg: 'bg-status-planning' },
  answer: { fill: 'fill-status-ai', bg: 'bg-status-ai' },
  source: { fill: 'fill-fg-3', bg: 'bg-fg-3' },
}
const toneOf = (kind: string) => KIND_TONE[kind] ?? { fill: 'fill-fg-2', bg: 'bg-fg-2' }

function kindName(kind: string): string {
  if (kind === 'answer') return 'Saved answer'
  if (kind === 'source') return 'Source'
  return kind.charAt(0).toUpperCase() + kind.slice(1).replace(/[-_]+/g, ' ')
}

export function PageGraph({ workspace, rel, onOpenNote }: { workspace: string; rel: string; onOpenNote: (rel: string) => void }) {
  const [data, setData] = useState<RelatedResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [hover, setHover] = useState<string | null>(null)
  const [showAll, setShowAll] = useState(false)
  const [W, setW] = useState(480)
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let live = true
    setLoading(true); setError(null); setShowAll(false)
    wikiApi<RelatedResponse>(`/graph/related?${wsQuery(workspace)}&page=${encodeURIComponent(rel)}&depth=1&limit=40`)
      .then(r => { if (live) setData(r) })
      // A page outside the wiki (index, log) simply has no neighbourhood.
      .catch(e => { if (live) { setData(null); setError(/no page called/i.test((e as Error).message) ? null : (e as Error).message) } })
      .finally(() => { if (live) setLoading(false) })
    return () => { live = false }
  }, [workspace, rel])

  useEffect(() => {
    const el = box.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const fit = () => setW(Math.round(Math.max(MIN_W, Math.min(MAX_W, el.clientWidth || 480))))
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(el)
    return () => ro.disconnect()
  }, [data])

  const titles = useMemo(() => {
    const m = new Map<string, string>()
    if (data) { m.set(data.page.rel, data.page.title); for (const n of data.related) m.set(n.rel, n.title) }
    return m
  }, [data])
  const titleOf = (r: string) => titles.get(r) ?? r.split('/').pop()!.replace(/\.md$/, '')

  if (loading) {
    return (
      <section className="flex flex-col gap-3 border-t border-line-soft px-5 py-4" aria-busy="true">
        <span className="sr-only">Loading connections…</span>
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-[180px] w-full rounded-md" />
        <SkeletonText lines={2} />
      </section>
    )
  }
  if (error) {
    return (
      <section className="border-t border-line-soft px-5 py-4">
        <Alert tone="amber" title="Couldn't load connections">{error}</Alert>
      </section>
    )
  }
  if (!data) return null

  const drawn = data.related.slice(0, MAX_DRAWN)
  const H = heightFor(W)
  const { centre, points } = radialLayout(drawn.length, W, H)
  const nameX = (x: number) => Math.max(NAME_HALF, Math.min(W - NAME_HALF, x))
  const list = showAll ? data.related : data.related.slice(0, LIST_PREVIEW)
  const open = (r: string) => () => onOpenNote(r)
  const onKey = (r: string) => (e: KeyboardEvent<SVGGElement>) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpenNote(r) }
  }
  // Read each connection from this page's side first ("Tom works for Greenway" on Tom's page).
  const viaOf = (n: GraphNeighbour) => [...n.via].sort((a, b) => Number(b.from === data.page.rel) - Number(a.from === data.page.rel) || Number(!!b.label) - Number(!!a.label))
  const labelOf = (n: GraphNeighbour) => viaOf(n).find(v => v.label)?.label ?? null

  return (
    <section aria-labelledby="kb-graph-title" className="flex flex-col gap-3 border-t border-line-soft px-5 py-4">
      <h3 id="kb-graph-title" className="flex items-center gap-2 font-display text-[13.5px] font-semibold tracking-[-0.01em] text-fg-0">
        <Share2 className="h-4 w-4 text-fg-2" aria-hidden="true" />
        Connections
        <span className="font-mono text-[11px] font-normal text-fg-3">{data.related.length}{data.truncated ? '+' : ''}</span>
      </h3>

      {data.related.length === 0 ? (
        <p className="rounded-md border border-dashed border-line px-3 py-4 text-[12.5px] leading-relaxed text-fg-2">
          No connections yet. They appear when another page links here, when a file, chat or call mentions this page, or when a saved answer uses it.
        </p>
      ) : (
        <>
          <div ref={box} className="rounded-md border border-line-soft bg-surface-1">
            <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full" role="group" aria-label={`${data.page.title} and the pages connected to it`}>
              {drawn.map((n, i) => {
                const label = labelOf(n)
                const p = points[i]
                const lit = hover === n.rel
                return (
                  <g key={`e-${n.rel}`} aria-hidden="true">
                    <line
                      x1={centre.x} y1={centre.y} x2={p.x} y2={p.y}
                      className={cn('transition-colors duration-fast', lit ? 'stroke-accent' : label ? 'stroke-fg-3' : 'stroke-line-strong')}
                      strokeWidth={lit ? 1.75 : 1.25}
                      strokeDasharray={n.via.every(v => v.kind === 'cited_by') ? '3 3' : undefined}
                    />
                    {label && (
                      <text x={(centre.x + p.x) / 2} y={(centre.y + p.y) / 2 + 3} textAnchor="middle" paintOrder="stroke" strokeWidth={4} strokeLinejoin="round" className="fill-fg-2 stroke-surface-1 text-[10px]">
                        {shortTitle(label, 16)}
                      </text>
                    )}
                  </g>
                )
              })}

              <g aria-hidden="true">
                <circle cx={centre.x} cy={centre.y} r={13} className="fill-accent" />
                <text x={centre.x} y={centre.y + 29} textAnchor="middle" paintOrder="stroke" strokeWidth={4} strokeLinejoin="round" className="fill-fg-0 stroke-surface-1 text-[12px] font-semibold">
                  {shortTitle(data.page.title, 24)}
                </text>
              </g>

              {drawn.map((n, i) => {
                const p = points[i]
                return (
                  <g
                    key={`n-${n.rel}`}
                    role="button"
                    tabIndex={0}
                    aria-label={`Open ${n.title} (${kindName(n.kind)})`}
                    onClick={open(n.rel)}
                    onKeyDown={onKey(n.rel)}
                    onMouseEnter={() => setHover(n.rel)}
                    onMouseLeave={() => setHover(h => (h === n.rel ? null : h))}
                    onFocus={() => setHover(n.rel)}
                    onBlur={() => setHover(h => (h === n.rel ? null : h))}
                    className="group cursor-pointer outline-none"
                  >
                    {/* 44×44 hit area */}
                    <circle cx={p.x} cy={p.y} r={22} className="fill-transparent" />
                    <circle cx={p.x} cy={p.y} r={12} className="fill-none stroke-transparent transition-colors duration-fast group-hover:stroke-accent group-focus-visible:stroke-accent" strokeWidth={2} />
                    <circle cx={p.x} cy={p.y} r={7} className={cn('origin-center transition-transform duration-fast [transform-box:fill-box] group-hover:scale-125 group-focus-visible:scale-125', toneOf(n.kind).fill)} />
                    {/* Name above nodes in the top half and at the sides, so neither a line nor the centre name crosses it. */}
                    <text x={nameX(p.x)} y={p.y <= centre.y + 10 ? p.y - 14 : p.y + 22} textAnchor="middle" paintOrder="stroke" strokeWidth={4} strokeLinejoin="round" className="fill-fg-1 stroke-surface-1 text-[11px] transition-colors duration-fast group-hover:fill-fg-0">
                      {shortTitle(n.title)}
                    </text>
                  </g>
                )
              })}
            </svg>
          </div>
          {data.related.length > MAX_DRAWN && (
            <p className="text-[12px] text-fg-3">The closest {MAX_DRAWN} are drawn; all {data.related.length}{data.truncated ? '+' : ''} are listed below.</p>
          )}

          <ul className="flex flex-col divide-y divide-line-soft rounded-md border border-line-soft bg-surface-1">
            {list.map(n => (
              <li key={n.rel}>
                <button
                  type="button"
                  onClick={open(n.rel)}
                  onMouseEnter={() => setHover(n.rel)}
                  onMouseLeave={() => setHover(h => (h === n.rel ? null : h))}
                  className="flex min-h-[44px] w-full items-center gap-3 px-3 py-2 text-left transition-colors duration-fast hover:bg-surface-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
                >
                  <span className={cn('h-2 w-2 shrink-0 rounded-full', toneOf(n.kind).bg)} aria-hidden="true" />
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="truncate text-[13px] font-medium text-fg-0">{n.title}</span>
                    {n.via.length > 0 && <span className="line-clamp-2 text-[12px] leading-snug text-fg-2">{edgeSentence(viaOf(n)[0], titleOf)}</span>}
                  </span>
                  <Badge className="shrink-0">{kindName(n.kind)}</Badge>
                </button>
              </li>
            ))}
          </ul>
          {!showAll && data.related.length > LIST_PREVIEW && (
            <Button size="sm" variant="ghost" className="min-h-[44px] self-start sm:min-h-[32px]" onClick={() => setShowAll(true)}>
              Show all {data.related.length}
            </Button>
          )}
        </>
      )}
    </section>
  )
}
