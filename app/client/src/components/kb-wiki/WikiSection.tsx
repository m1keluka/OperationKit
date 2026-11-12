import { useCallback, useEffect, useState } from 'react'
import { useAuth } from '../../context/AuthContext'
import type { WikiPageSummary, WikiPagesResponse } from '../../lib/kbWiki'
import { Alert, Card, CardBody, CardHeader, Tabs } from '../ui'
import { CleanupPanel } from './CleanupPanel'
import { ImportsPanel } from './ImportsPanel'
import { WikiBrowser } from './WikiBrowser'
import { WorkspaceGraph } from './WorkspaceGraph'
import { wikiApi, wsQuery } from './wikiApi'

type Tab = 'graph' | 'wiki' | 'imports' | 'cleanup'

const TAB_KEY = 'cc.kbWiki.tab'
const TABS: Tab[] = ['graph', 'wiki', 'imports', 'cleanup']

/** The tab last used on this browser; the graph on a first visit (obj 900674). */
function initialTab(): Tab {
  try {
    const t = window.localStorage.getItem(TAB_KEY) as Tab | null
    return t && TABS.includes(t) ? t : 'graph'
  } catch {
    return 'graph'
  }
}

/* WikiSection (obj 720117) — the knowledge base as a linked wiki, mounted under
   the import panel's Ask/Files grid. Four tabs: the graph of how every page
   connects (the default, obj 900674), the page list, import chats & calls, and
   the cleanup pass. Pages open in the panel's own note viewer. */
export function WikiSection({
  workspace,
  onOpenNote,
  onPages,
  refreshKey = 0,
}: {
  workspace: string
  onOpenNote: (rel: string) => void
  /** Hands the page list up so the note viewer can resolve [[Bare Name]] links. */
  onPages?: (pages: WikiPageSummary[]) => void
  /** Bump to reload (e.g. after an answer is saved or a file finishes). */
  refreshKey?: number
}) {
  const { user } = useAuth()
  const [tab, setTabState] = useState<Tab>(initialTab)
  const setTab = (t: Tab) => {
    setTabState(t)
    // codeql[js/clear-text-storage-of-sensitive-data] -- persists a UI tab id ('graph' | 'wiki' | 'imports' | 'cleanup'), never a secret
    try { window.localStorage.setItem(TAB_KEY, t) } catch { /* private mode */ }
  }
  const [data, setData] = useState<WikiPagesResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [localKey, setLocalKey] = useState(0)

  const load = useCallback(async () => {
    if (!workspace) return
    setLoading(true)
    try {
      const b = await wikiApi<WikiPagesResponse>(`/pages?${wsQuery(workspace)}`)
      setData(b)
      setError(null)
      onPages?.(b.pages)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
    // onPages is a setter from the parent; leaving it out keeps this from refetching every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace])

  useEffect(() => { setData(null) }, [workspace])
  useEffect(() => { void load() }, [load, refreshKey, localKey])

  const changed = useCallback(() => setLocalKey(k => k + 1), [])
  const pageCount = data ? data.pages.filter(p => p.kind !== 'generated').length : undefined

  return (
    <Card inset className="mt-5">
      <CardHeader eyebrow="Wiki" title="Your knowledge base" />
      <CardBody className="flex flex-col gap-4">
        <p className="max-w-[72ch] text-[13px] leading-relaxed text-fg-2">
          Everything you upload or import is turned into linked pages — one per person, company and topic — each
          fact pointing back to where it came from. Answers you save become pages too, and a regular cleanup keeps
          the links tidy. The graph shows how every page connects.
        </p>
        <Tabs
          items={[
            { key: 'graph', label: 'Graph' },
            { key: 'wiki', label: 'Pages', count: pageCount },
            { key: 'imports', label: 'Import chats & calls' },
            { key: 'cleanup', label: 'Cleanup' },
          ]}
          value={tab}
          onChange={k => setTab(k as Tab)}
        />
        {tab === 'graph' && <WorkspaceGraph workspace={workspace} onOpenNote={onOpenNote} refreshKey={refreshKey + localKey} />}
        {error && tab === 'wiki' && <Alert tone="alarm" title="Couldn't load the wiki">{error}</Alert>}
        {tab === 'wiki' && (
          <WikiBrowser
            workspace={workspace}
            pages={data?.pages ?? null}
            logRel={data?.log ?? null}
            loading={loading || (!data && !error)}
            refreshKey={refreshKey + localKey}
            onOpenNote={onOpenNote}
          />
        )}
        {tab === 'imports' && <ImportsPanel workspace={workspace} onOpenNote={onOpenNote} onChanged={changed} />}
        {tab === 'cleanup' && (
          <CleanupPanel workspace={workspace} pages={data?.pages ?? null} isAdmin={user?.role === 'admin'} onOpenNote={onOpenNote} onChanged={changed} />
        )}
      </CardBody>
    </Card>
  )
}
