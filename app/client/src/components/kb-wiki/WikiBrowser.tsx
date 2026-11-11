import { useEffect, useMemo, useState, type MouseEvent } from 'react'
import { BookOpen, History } from 'lucide-react'
import { renderMarkdown } from '../../lib/markdown'
import { groupPages, resolveFrom, stripFrontmatter, wikilinksToLinks, type WikiPageSummary } from '../../lib/kbWiki'
import { Alert, Button, EmptyState, SearchInput, Skeleton, SkeletonText } from '../ui'
import { wikiApi, wsQuery } from './wikiApi'

const GROUP_PREVIEW = 12
const LOG_ENTRIES = 15

/** Keep the newest `n` "## [date] …" entries of log.md (it is newest-first). */
function recentLog(md: string, n: number): string {
  const body = stripFrontmatter(md)
  const starts = [...body.matchAll(/^## \[/gm)].map(m => m.index ?? 0)
  if (starts.length <= n) return starts.length ? body.slice(starts[0]) : ''
  return body.slice(starts[0], starts[n])
}

/** Click handler for rendered wiki markdown: relative .md links open in the note viewer. */
export function openLinksIn(fromRel: string, onOpenNote: (rel: string) => void) {
  return (e: MouseEvent<HTMLDivElement>) => {
    const a = (e.target as HTMLElement).closest('a')
    const href = a?.getAttribute('href')
    if (!a || !href || /^[a-z]+:/i.test(href) || href.startsWith('#')) return
    e.preventDefault()
    const rel = resolveFrom(fromRel, href.split('#')[0])
    if (rel.endsWith('.md')) onOpenNote(rel)
  }
}

/* WikiBrowser (obj 720117) — the wiki's table of contents: every page grouped
   by kind with its one-line summary, a filter box, and the "Recent changes" log. */
export function WikiBrowser({
  workspace,
  pages,
  logRel,
  loading,
  refreshKey,
  onOpenNote,
}: {
  workspace: string
  pages: WikiPageSummary[] | null
  logRel: string | null
  loading: boolean
  refreshKey: number
  onOpenNote: (rel: string) => void
}) {
  const [filter, setFilter] = useState('')
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [log, setLog] = useState<string | null>(null)
  const [logError, setLogError] = useState<string | null>(null)

  const groups = useMemo(() => groupPages(pages ?? [], filter), [pages, filter])
  const shown = groups.reduce((n, g) => n + g.pages.length, 0)
  const total = useMemo(() => (pages ?? []).filter(p => p.kind !== 'generated').length, [pages])

  useEffect(() => {
    if (!workspace || !logRel) { setLog(null); return }
    let live = true
    wikiApi<{ content: string }>(`/page?${wsQuery(workspace)}&path=${encodeURIComponent(logRel)}`)
      .then(b => { if (live) { setLog(b.content); setLogError(null) } })
      .catch(e => { if (live) { setLog(null); setLogError((e as Error).message) } })
    return () => { live = false }
  }, [workspace, logRel, refreshKey])

  const recent = useMemo(() => (log ? recentLog(log, LOG_ENTRIES) : ''), [log])

  if (loading && !pages) {
    return (
      <div className="flex flex-col gap-3" aria-busy="true">
        <span className="sr-only">Loading the wiki…</span>
        <Skeleton className="h-9 w-full sm:w-72" />
        <SkeletonText lines={6} />
      </div>
    )
  }

  if (pages && total === 0) {
    return (
      <EmptyState
        compact
        icon={<BookOpen className="h-5 w-5" aria-hidden="true" />}
        title="Your wiki is empty"
        description="Upload files above or import your chats and calls. Each one is read and turned into linked pages — one per person, company and topic — that show up here."
      />
    )
  }

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
      <div className="flex min-w-0 flex-col gap-4">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <SearchInput
            value={filter}
            onChange={e => setFilter(e.target.value)}
            placeholder="Filter pages"
            aria-label="Filter pages"
            wrapClassName="w-full sm:w-72"
          />
          <span className="text-[12px] text-fg-3">
            {filter ? `${shown} of ${total} pages` : `${total} page${total === 1 ? '' : 's'}`}
          </span>
        </div>

        {groups.length === 0 && (
          <p className="text-[13px] text-fg-2">No pages match “{filter}”.</p>
        )}

        {groups.map(g => {
          const open = expanded[g.kind] || !!filter
          const list = open ? g.pages : g.pages.slice(0, GROUP_PREVIEW)
          return (
            <section key={g.kind} aria-labelledby={`wiki-group-${g.kind}`} className="flex flex-col gap-1.5">
              <h4 id={`wiki-group-${g.kind}`} className="flex items-baseline gap-2 font-display text-[13.5px] font-semibold tracking-[-0.01em] text-fg-0">
                {g.label}
                <span className="font-mono text-[11px] font-normal text-fg-3">{g.pages.length}</span>
              </h4>
              <ul className="flex flex-col divide-y divide-line-soft rounded-md border border-line-soft bg-surface-1">
                {list.map(p => (
                  <li key={p.rel}>
                    <button
                      type="button"
                      onClick={() => onOpenNote(p.rel)}
                      className="flex min-h-[44px] w-full flex-col items-start gap-0.5 px-3 py-2 text-left transition-colors duration-fast hover:bg-surface-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
                    >
                      <span className="text-[13.5px] font-medium text-fg-0">{p.title}</span>
                      {p.summary && <span className="line-clamp-2 text-[12.5px] leading-snug text-fg-2">{p.summary}</span>}
                    </button>
                  </li>
                ))}
              </ul>
              {!open && g.pages.length > GROUP_PREVIEW && (
                <Button size="sm" variant="ghost" className="min-h-[44px] self-start sm:min-h-[32px]" onClick={() => setExpanded(x => ({ ...x, [g.kind]: true }))}>
                  Show all {g.pages.length}
                </Button>
              )}
            </section>
          )
        })}
      </div>

      <aside className="flex min-w-0 flex-col gap-2" aria-labelledby="wiki-recent-title">
        <h4 id="wiki-recent-title" className="flex items-center gap-2 font-display text-[13.5px] font-semibold tracking-[-0.01em] text-fg-0">
          <History className="h-4 w-4 text-fg-2" aria-hidden="true" />
          Recent changes
        </h4>
        {logError && <Alert tone="amber" title="Couldn't load recent changes">{logError}</Alert>}
        {!logError && !recent && (
          <p className="text-[12.5px] text-fg-3">Nothing has changed yet. Every file read, chat imported, answer saved and cleanup run is listed here.</p>
        )}
        {recent && (
          <div
            className="cc-prose max-h-[520px] overflow-y-auto break-words rounded-md border border-line-soft bg-surface-1 px-3 py-2 text-[12.5px] [&_h2]:mb-1 [&_h2]:mt-3 [&_h2]:text-[13px] [&_h2]:font-medium [&_h2]:leading-snug [&_h2]:text-fg-1"
            onClick={openLinksIn(logRel ?? 'log.md', onOpenNote)}
            dangerouslySetInnerHTML={{ __html: renderMarkdown(wikilinksToLinks(recent, logRel ?? 'log.md', pages ?? undefined)) }}
          />
        )}
      </aside>
    </div>
  )
}
