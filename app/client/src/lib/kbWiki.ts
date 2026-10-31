/* kb-wiki client helpers (obj 720117) — pure, no React, no fetch.
   Types mirror app/server/src/services/kb-wiki/{wiki,imports,lint,settings}.ts
   as served by /api/kb-wiki/*. */

export interface WikiPageSummary {
  rel: string
  title: string
  /** An entity type ('person', 'company', …), 'answer', 'source' or 'generated'. */
  kind: string
  summary: string
  updated?: string
  aliases?: string[]
}

export interface WikiPagesResponse {
  pages: WikiPageSummary[]
  counts: Record<string, number>
  index: string
  log: string
}

export type ImportJobKind = 'claude-export' | 'chatgpt-export' | 'transcripts'
export type ImportJobStatus = 'review' | 'running' | 'paused' | 'done' | 'failed' | 'cancelled'
export type ImportItemStatus = 'pending' | 'queued' | 'working' | 'done' | 'skipped' | 'failed'

export interface ImportCounts {
  total: number
  selected: number
  pending: number
  queued: number
  working: number
  done: number
  skipped: number
  failed: number
}

export interface ImportJobSummary {
  id: string
  kind: ImportJobKind
  label: string
  raw_files: string[]
  created_at: string
  created_by?: string
  status: ImportJobStatus
  error?: string
  counts: ImportCounts
  started_at?: string
  finished_at?: string
}

export interface ImportItem {
  key: string
  title: string
  started_at?: string
  participants: string[]
  message_count: number
  chars: number
  preview: string
  selected: boolean
  status: ImportItemStatus
  source_note?: string
  pages?: string[]
  skip_reason?: string
  error?: string
}

export interface ItemFilter {
  q?: string
  from?: string
  to?: string
  status?: ImportItemStatus
  min_messages?: number
}

export type LintKind = 'broken_link' | 'broken_edge' | 'orphan' | 'isolated' | 'duplicate' | 'stale' | 'missing_topic' | 'contradiction'

export interface LintItem {
  kind: LintKind
  page?: string
  detail: string
  pages?: string[]
}

export interface LintReport {
  ran_at: string
  fixed: LintItem[]
  needs_human: LintItem[]
  stats: Record<string, number>
  notes?: string[]
}

export type LintSchedule = 'nightly' | 'weekly' | 'off'

export interface WikiSettings {
  lint_schedule: LintSchedule
  lint_hour_utc: number
  lint_stale_days: number
  lint_ai_pages: number
}

// ── Paths ────────────────────────────────────────────────────────────────────

/** Resolve a relative href against the page it appears on (KB-relative result). */
export function resolveFrom(fromRel: string, href: string): string {
  const parts = fromRel ? fromRel.split('/').slice(0, -1) : []
  for (const seg of href.split('/')) {
    if (seg === '..') parts.pop()
    else if (seg && seg !== '.') parts.push(seg)
  }
  return parts.join('/')
}

/** The relative path from the page `fromRel` to the KB-relative `toRel`. '' = KB root. */
export function relativePath(fromRel: string, toRel: string): string {
  if (!fromRel) return toRel
  const from = fromRel.split('/').slice(0, -1)
  const to = toRel.split('/')
  let i = 0
  while (i < from.length && i < to.length - 1 && from[i] === to[i]) i++
  const up = from.slice(i).map(() => '..')
  return [...up, ...to.slice(i)].join('/')
}

function stemOf(rel: string): string {
  const file = rel.split('/').pop() ?? rel
  return file.replace(/\.md$/i, '')
}

/** "people/dana-ruiz.md" → "dana ruiz". */
export function labelFromRel(rel: string): string {
  return stemOf(rel).replace(/[-_]+/g, ' ').trim()
}

// ── Wikilinks ────────────────────────────────────────────────────────────────

const WIKI_COMMENT = /<!--\s*\/?kb-wiki:[^>]*?-->\n?/g
const WIKILINK = /\[\[([^\]|#\n]*)(#[^\]|\n]*)?(?:\|([^\]\n]*))?\]\]/g

/** Find the page a `[[target]]` points at: a path (with or without .md) or a bare name. */
export function resolveWikiTarget(target: string, pages?: WikiPageSummary[]): WikiPageSummary | { rel: string; title?: undefined } | null {
  const t = target.trim()
  if (!t) return null
  const lower = t.toLowerCase()
  if (t.includes('/') || /\.md$/i.test(t)) {
    const rel = /\.md$/i.test(t) ? t : `${t}.md`
    const hit = pages?.find(p => p.rel.toLowerCase() === rel.toLowerCase())
    return hit ?? { rel }
  }
  if (!pages?.length) return null
  return (
    pages.find(p => stemOf(p.rel).toLowerCase() === lower) ??
    pages.find(p => p.title.toLowerCase() === lower) ??
    pages.find(p => (p.aliases ?? []).some(a => a.toLowerCase() === lower)) ??
    null
  )
}

function cleanLabel(s: string): string {
  return s.replace(/[[\]]/g, '').trim()
}

/**
 * Turn `[[path]]`, `[[path|label]]`, `[[path#heading]]` and `[[Bare Name]]` into
 * ordinary markdown links relative to `fromRel`, so the Knowledge base page's link handler
 * opens them like any other note link. A bare name that matches no page stays as
 * plain text. Also strips the wiki's hidden `<!-- kb-wiki:… -->` markers.
 */
export function wikilinksToLinks(md: string, fromRel: string, pages?: WikiPageSummary[]): string {
  return md.replace(WIKI_COMMENT, '').replace(WIKILINK, (_m, target: string, _hash: string | undefined, label: string | undefined) => {
    const hit = resolveWikiTarget(target, pages)
    const text = cleanLabel(label ?? '') || cleanLabel(hit?.title ?? '') || cleanLabel(hit ? labelFromRel(hit.rel) : target)
    if (!hit) return text
    return `[${text}](${encodeURI(relativePath(fromRel, hit.rel))})`
  })
}

export function stripFrontmatter(md: string): string {
  return md.replace(/^---\n[\s\S]*?\n---\n?/, '')
}

// ── Grouping the index ───────────────────────────────────────────────────────

const LAST_KINDS = ['answer', 'source']

/** "person" → "People", "company" → "Companies", "answer" → "Saved answers". */
export function kindLabel(kind: string): string {
  if (kind === 'answer') return 'Saved answers'
  if (kind === 'source') return 'Readable copies of your files and chats'
  if (kind === 'person') return 'People'
  const k = kind.replace(/[-_]+/g, ' ')
  const plural = /[^aeiou]y$/.test(k) ? `${k.slice(0, -1)}ies` : /(s|x|ch|sh)$/.test(k) ? `${k}es` : `${k}s`
  return plural.charAt(0).toUpperCase() + plural.slice(1)
}

export interface PageGroup { kind: string; label: string; pages: WikiPageSummary[] }

/** Pages grouped by kind (topics alphabetical, then saved answers, then sources), filtered by text. */
export function groupPages(pages: WikiPageSummary[], filter = ''): PageGroup[] {
  const terms = filter.toLowerCase().split(/\s+/).filter(Boolean)
  const match = (p: WikiPageSummary) => {
    if (!terms.length) return true
    const hay = `${p.title}\n${p.summary}\n${p.rel}\n${(p.aliases ?? []).join(' ')}`.toLowerCase()
    return terms.every(t => hay.includes(t))
  }
  const byKind = new Map<string, WikiPageSummary[]>()
  for (const p of pages) {
    if (p.kind === 'generated' || !match(p)) continue
    const list = byKind.get(p.kind) ?? []
    list.push(p)
    byKind.set(p.kind, list)
  }
  const kinds = [...byKind.keys()].sort((a, b) => {
    const ia = LAST_KINDS.indexOf(a), ib = LAST_KINDS.indexOf(b)
    if (ia !== ib) return ia - ib
    return a.localeCompare(b)
  })
  return kinds.map(kind => ({
    kind,
    label: kindLabel(kind),
    pages: byKind.get(kind)!.slice().sort((a, b) => a.title.localeCompare(b.title)),
  }))
}

// ── Imports ──────────────────────────────────────────────────────────────────

/** Progress of a job: chats finished (imported, skipped or failed) out of those ticked. */
export function importProgress(c: ImportCounts): { finished: number; of: number; pct: number } {
  const finished = c.done + c.skipped + c.failed
  const of = Math.max(c.selected, finished)
  return { finished, of, pct: of ? Math.round((finished / of) * 100) : 0 }
}

export function itemQuery(f: ItemFilter, offset: number, limit: number): string {
  const p = new URLSearchParams()
  if (f.q?.trim()) p.set('q', f.q.trim())
  if (f.from) p.set('from', f.from)
  if (f.to) p.set('to', f.to)
  if (f.status) p.set('status', f.status)
  if (f.min_messages) p.set('min_messages', String(f.min_messages))
  p.set('offset', String(offset))
  p.set('limit', String(limit))
  return p.toString()
}

/** Strip empty fields so `all_matching` only carries what the person actually filtered on. */
export function compactFilter(f: ItemFilter): ItemFilter {
  const out: ItemFilter = {}
  if (f.q?.trim()) out.q = f.q.trim()
  if (f.from) out.from = f.from
  if (f.to) out.to = f.to
  if (f.status) out.status = f.status
  if (f.min_messages) out.min_messages = f.min_messages
  return out
}

export const IMPORT_ACCEPT = '.zip,.vtt,.srt,.txt,.docx,.json,.md'

export const JOB_KIND_LABEL: Record<ImportJobKind, string> = {
  'claude-export': 'Claude chats',
  'chatgpt-export': 'ChatGPT chats',
  transcripts: 'Call transcripts',
}

export function shortDate(iso?: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

// ── Cleanup ──────────────────────────────────────────────────────────────────

export const LINT_KIND_LABEL: Record<LintKind, string> = {
  broken_link: 'Broken link',
  broken_edge: 'Missing source',
  orphan: 'Nothing links here',
  isolated: 'No connections',
  duplicate: 'Possible duplicate',
  stale: 'Not updated in a while',
  missing_topic: 'New topic page',
  contradiction: 'Facts disagree',
}

/** "03:00 UTC" for an hour 0–23. */
export function hourLabel(h: number): string {
  return `${String(Math.max(0, Math.min(23, Math.floor(h)))).padStart(2, '0')}:00 UTC`
}

// ── Link graph (obj 720162) ──────────────────────────────────────────────────
// Mirrors app/server/src/services/kb-wiki/graph.ts as served by GET /api/kb-wiki/graph/related.

export type EdgeKind = 'related' | 'mentions' | 'cited_by' | 'answer_used'

export interface GraphEdge { from: string; to: string; kind: EdgeKind; label: string | null }
export interface GraphNodeRef { rel: string; title: string; kind: string }
export interface GraphNeighbour extends GraphNodeRef { depth: number; via: GraphEdge[] }
export interface RelatedResponse { page: GraphNodeRef; related: GraphNeighbour[]; truncated: boolean }

/**
 * One connection as a plain sentence, e.g. "Tom Whitfield works for Greenway
 * Growers" or "Supplier call is a source for Tom Whitfield".
 */
export function edgeSentence(e: GraphEdge, titleOf: (rel: string) => string): string {
  const from = titleOf(e.from)
  const to = titleOf(e.to)
  switch (e.kind) {
    case 'related': return e.label ? `${from} ${e.label} ${to}` : `${from} is related to ${to}`
    case 'mentions': return `${from} mentions ${to}`
    case 'cited_by': return `${to} is a source for ${from}`
    case 'answer_used': return `The answer “${from}” used ${to}`
  }
}

export interface GraphPoint { x: number; y: number }

/**
 * Where to draw `n` neighbours around a centre: evenly on an ellipse, starting
 * at the top and going clockwise. Pure, so the layout is stable between renders.
 */
export function radialLayout(n: number, width: number, height: number, pad = 44): { centre: GraphPoint; points: GraphPoint[] } {
  const centre = { x: width / 2, y: height / 2 }
  const rx = Math.max(0, width / 2 - pad)
  const ry = Math.max(0, height / 2 - pad / 1.6)
  const points = Array.from({ length: n }, (_, i) => {
    const a = -Math.PI / 2 + (2 * Math.PI * i) / Math.max(1, n)
    return { x: Math.round((centre.x + rx * Math.cos(a)) * 10) / 10, y: Math.round((centre.y + ry * Math.sin(a)) * 10) / 10 }
  })
  return { centre, points }
}

/** "Tom Whitfield" → "Tom Whitfield"; long titles are cut to fit under a graph node. */
export function shortTitle(s: string, max = 18): string {
  return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`
}
