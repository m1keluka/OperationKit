import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Inbox, Keyboard, Plus, RefreshCw,
} from 'lucide-react'
import type { Workspace } from '@command-center/shared'
import {
  Alert, Button, DataTable, EmptyState, PageContainer, PageHeader,
  Tabs, Toast, useConfirm, type TabItem,
} from './ui'
import { useWorkspaces } from '../hooks/useWorkspaces'
import { useNavigate } from '../context/nav'
import { DevItemDrawer } from './development/DevItemDrawer'
import { ChangelogPanel } from './development/ChangelogPanel'
import { NewItemModal } from './development/NewItemModal'
import { BoardToolbar } from './development/BoardToolbar'
import { KeyboardHelpModal } from './development/KeyboardHelpModal'
import { buildDevColumns } from './development/boardColumns'
import {
  TABS, TAB_LABEL, TAB_STATUS, TAB_SORT, DATE_PRESETS, EMPTY_FILTERS,
  filtersFromUrl, urlFor, activeFilterCount, idFromPath,
  type Tab, type UiFilters,
} from './development/types'
import {
  bulkDevItems, deleteDevItem, hexColor, isFixtureMode, listDevItems, onFixtureMode,
  promoteDevItem, rankDevItem, triageDevItem,
  type DevItemQuery, type DevListResponse,
} from '../lib/devItems'

/* ─────────────────────────────────────────────────────────────────────────
   /development — the universal development board (PRD §5).

   Six lanes over ONE dev_items store (§5.3), every filter URL-addressable
   (§5.4), drag-to-rank (§5.5), bulk actions (§5.6), a detail drawer (§5.7) and
   the keyboard layer (§5.8). Built entirely from the existing ui/ primitives —
   no new design system, per §5.10.

   Data access is 100% `lib/devItems.ts`, which is a verbatim binding of the
   locked admin contract A1–A16 in `universal-development-api.md`. This page
   contains ZERO server-side assumptions beyond that document.
   ───────────────────────────────────────────────────────────────────────── */

export function DevelopmentPage({ workspace }: { workspace: Workspace }) {
  const navigate = useNavigate()
  const { workspaces, shortOf, badgeOf, labelOf } = useWorkspaces()
  const { confirm, confirmDialog } = useConfirm()

  const initial = useMemo(() => filtersFromUrl(), [])
  const [tab, setTab] = useState<Tab>(initial.tab)
  const [filters, setFilters] = useState<UiFilters>(() => {
    // The Layout workspace switcher seeds the platform filter, but /development
    // deliberately allows "All platforms" (G2) — unlike KanbanBoard, which is
    // strictly workspace-scoped. An explicit ?workspace= in the URL wins.
    if (initial.filters.wsExplicit) return initial.filters
    return { ...initial.filters, workspace: workspace && workspace !== 'all' ? [workspace] : [] }
  })
  const [sortOverride, setSortOverride] = useState<NonNullable<DevItemQuery['sort']> | null>(initial.sort)
  const [searchDraft, setSearchDraft] = useState(initial.filters.q)

  const [resp, setResp] = useState<DevListResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [toast, setToast] = useState<{ tone: 'alarm' | 'verify'; text: string } | null>(null)
  const [fixture, setFixture] = useState(isFixtureMode())

  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [focusIdx, setFocusIdx] = useState(0)
  const [openId, setOpenId] = useState<number | null>(() => idFromPath(window.location.pathname))
  const [newOpen, setNewOpen] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const [dragId, setDragId] = useState<number | null>(null)

  const sort = sortOverride ?? TAB_SORT[tab]
  const rows = resp?.data ?? []

  useEffect(() => onFixtureMode(setFixture), [])

  /* Debounced search → filters.q */
  useEffect(() => {
    const t = window.setTimeout(() => setFilters(f => (f.q === searchDraft ? f : { ...f, q: searchDraft })), 250)
    return () => window.clearTimeout(t)
  }, [searchDraft])

  /* Filters/tab/sort → URL (replace, so the back button isn't filter noise) */
  useEffect(() => {
    const qs = urlFor(tab, filters, sortOverride)
    const path = openId ? `/development/DEV-${openId}` : '/development'
    window.history.replaceState({}, '', `${path}${qs}`)
  }, [tab, filters, sortOverride, openId])

  /* Back/forward → drawer state */
  useEffect(() => {
    const onPop = () => setOpenId(idFromPath(window.location.pathname))
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  const query = useMemo<DevItemQuery>(() => {
    const preset = filters.date ?? (tab === 'shipped' || tab === 'closed' ? '30d' : null)
    const days = DATE_PRESETS.find(d => d.value === preset)?.days ?? null
    return {
      workspace: filters.workspace.length ? filters.workspace : undefined,
      project: filters.project.length ? filters.project : undefined,
      type: filters.type.length ? filters.type : undefined,
      status: filters.status.length ? filters.status : (TAB_STATUS[tab].length ? TAB_STATUS[tab] : undefined),
      severity: filters.severity.length ? filters.severity : undefined,
      area: filters.area ?? undefined,
      route: filters.route ?? undefined,
      has_replay: filters.has_replay,
      has_screenshot: filters.has_screenshot,
      unassigned: filters.unassigned || undefined,
      // NOTE (deviation from PRD §5.4, deliberate): the Inbox lane is
      // status='new', so ALSO forcing untriaged=1 would make A1's facets — which
      // are computed with the same WHERE minus the faceted dimension — return 0
      // for every other lane, and the tab count badges would all read 0. The
      // Untriaged chip stays a real, user-controllable filter instead.
      untriaged: filters.untriaged || undefined,
      q: filters.q || undefined,
      date_from: days ? new Date(Date.now() - days * 86_400_000).toISOString() : undefined,
      sort,
      limit: 200,
    }
  }, [filters, tab, sort])

  const [reloadKey, setReloadKey] = useState(0)
  const reload = useCallback(() => setReloadKey(k => k + 1), [])

  useEffect(() => {
    // The Changelog tab renders its own list, but the A1 call still runs so the
    // five lane badges + the header counts stay live while you are on it.
    let cancelled = false
    setLoading(true)
    listDevItems(query)
      .then(r => { if (!cancelled) { setResp(r); setError(null) } })
      .catch(err => { if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load items') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [query, tab, reloadKey])

  /* Tab counts come from A1's facets, which are computed with the same WHERE
     clause minus the faceted dimension — so a tab badge tells you what
     selecting it would give you (api.md §5.1). */
  const facets = resp?.facets.status ?? {}
  const tabItems: TabItem[] = TABS.map(t => ({
    key: t,
    label: TAB_LABEL[t],
    count: t === 'changelog'
      ? undefined
      : TAB_STATUS[t].reduce((n, s) => n + (facets[s] ?? 0), 0),
  }))

  const wsOptions = useMemo(
    () => workspaces.map(w => ({ value: w.slug, label: labelOf(w.slug), color: hexColor(badgeOf(w.slug)), count: resp?.facets.workspace[w.slug] })),
    [workspaces, labelOf, badgeOf, resp],
  )
  const areaOptions = useMemo(() => {
    const set = new Set(rows.map(r => r.area).filter(Boolean) as string[])
    return [...set].sort().map(a => ({ value: a, label: a }))
  }, [rows])
  const routeOptions = useMemo(() => {
    const set = new Set(rows.map(r => r.route).filter(Boolean) as string[])
    return [...set].sort().map(a => ({ value: a, label: a }))
  }, [rows])
  const projectOptions = useMemo(() => {
    const set = new Set(rows.map(r => r.project ?? '__none__'))
    return [...set].sort().map(p => ({ value: p, label: p === '__none__' ? 'Organization-wide' : p }))
  }, [rows])

  const filterCount = activeFilterCount(filters)
  const clearAll = () => { setFilters({ ...EMPTY_FILTERS }); setSearchDraft(''); setSortOverride(null) }

  const openItem = (id: number) => {
    setOpenId(id)
    window.history.pushState({}, '', `/development/DEV-${id}${urlFor(tab, filters, sortOverride)}`)
  }
  const closeItem = () => {
    setOpenId(null)
    window.history.pushState({}, '', `/development${urlFor(tab, filters, sortOverride)}`)
  }

  const toggleSel = (id: number) => setSelected(prev => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id); else next.add(id)
    return next
  })
  const allSelected = rows.length > 0 && rows.every(r => selected.has(r.id))

  /* ── Bulk ops (A11) ─────────────────────────────────────────────────── */
  const runBulk = async (label: string, op: Parameters<typeof bulkDevItems>[1], destructive = false) => {
    const ids = [...selected]
    if (!ids.length) return
    if (destructive) {
      const ok = await confirm({
        title: `${label} ${ids.length} item${ids.length === 1 ? '' : 's'}?`,
        message: 'Bulk writes are one all-or-nothing request.',
        confirmLabel: label,
        danger: true,
      })
      if (!ok) return
    }
    try {
      await bulkDevItems(ids, op)
      setSelected(new Set())
      reload()
      setToast({ tone: 'verify', text: `${label}: ${ids.length} item${ids.length === 1 ? '' : 's'} updated` })
    } catch (err) {
      setToast({ tone: 'alarm', text: err instanceof Error ? err.message : 'Bulk action failed' })
    }
  }

  const bulkPromote = async () => {
    const ids = [...selected]
    if (!ids.length) return
    const ok = await confirm({
      title: `Promote ${ids.length} item${ids.length === 1 ? '' : 's'} to objectives?`,
      message: ids.map(i => `DEV-${i}`).join(', '),
      confirmLabel: 'Promote',
    })
    if (!ok) return
    try {
      for (const id of ids) await promoteDevItem(id, {})
      setSelected(new Set())
      reload()
      setToast({ tone: 'verify', text: `Promoted ${ids.length} item${ids.length === 1 ? '' : 's'}` })
    } catch (err) {
      setToast({ tone: 'alarm', text: err instanceof Error ? err.message : 'Promote failed' })
    }
  }

  /* ── Drag-to-rank (A7). Enabled only on sort=rank + exactly one platform. ── */
  const canRank = sort === 'rank' && filters.workspace.length === 1
  const onDrop = async (targetId: number) => {
    if (!dragId || dragId === targetId || !canRank) return
    const order = rows.map(r => r.id)
    const from = order.indexOf(dragId)
    const to = order.indexOf(targetId)
    if (from < 0 || to < 0) return
    const before = to > 0 ? order[to > from ? to : to - 1] : undefined
    const after = to > from ? order[to + 1] : order[to]
    setDragId(null)
    try {
      await rankDevItem(dragId, { before_id: before, after_id: after })
      reload()
    } catch (err) {
      setToast({ tone: 'alarm', text: err instanceof Error ? err.message : 'Reorder failed' })
      reload()
    }
  }

  /* ── Keyboard layer (§5.8) ──────────────────────────────────────────── */
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const el = document.activeElement
      const typing = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return
      if (openId && e.key !== 'Escape') return
      const row = rows[focusIdx]
      switch (e.key) {
        case 'j': e.preventDefault(); setFocusIdx(i => Math.min(rows.length - 1, i + 1)); break
        case 'k': e.preventDefault(); setFocusIdx(i => Math.max(0, i - 1)); break
        case 'Enter': case 'o': if (row) { e.preventDefault(); openItem(row.id) } break
        case 'Escape':
          if (openId) { closeItem() } else if (selected.size) { setSelected(new Set()) }
          break
        case 'x': if (row) { e.preventDefault(); toggleSel(row.id) } break
        case '/': e.preventDefault(); document.getElementById('dev-search')?.focus(); break
        case '?': e.preventDefault(); setHelpOpen(true); break
        case 'p': if (row) { e.preventDefault(); void promoteDevItem(row.id, {}).then(reload) } break
        case 'e':
          if (row) {
            e.preventDefault()
            void confirm({ title: `Decline DEV-${row.id}?`, confirmLabel: 'Decline', danger: true })
              .then(ok => { if (ok) bulkDevItems([row.id], { op: 'set_status', params: { status: 'declined' } }).then(reload) })
          }
          break
        case 't':
          if (row) {
            e.preventDefault()
            void triageDevItem(row.id, { suggest_rank: true }).then(reload)
          }
          break
        default:
          if (/^[1-6]$/.test(e.key)) { e.preventDefault(); setTab(TABS[Number(e.key) - 1]); setSelected(new Set()); setFocusIdx(0) }
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [rows, focusIdx, openId, selected.size, confirm, reload])

  useEffect(() => { if (toast) { const t = window.setTimeout(() => setToast(null), 4000); return () => window.clearTimeout(t) } }, [toast])

  const columns = buildDevColumns({
    allSelected, rows, selected, toggleSel, setSelected,
    canRank, dragId, setDragId, onDrop, shortOf,
  })

  const counts = {
    untriaged: facets.new ?? 0,
    inProgress: (facets.planned ?? 0) + (facets.in_progress ?? 0),
  }

  const emptyState = filterCount > 0
    ? {
        title: 'No items match these filters',
        description: 'Widen the filters or clear them to see the whole lane.',
        icon: <Inbox className="h-5 w-5" strokeWidth={1.6} />,
        action: <Button variant="ghost" onClick={clearAll}>Clear all filters</Button>,
      }
    : {
        title: tab === 'inbox' ? 'Nothing new' : `No ${TAB_LABEL[tab].toLowerCase()} items`,
        description: tab === 'inbox' ? 'All submissions are triaged.' : undefined,
        icon: <Inbox className="h-5 w-5" strokeWidth={1.6} />,
      }

  return (
    <PageContainer width="full">
      <PageHeader
        title="Development"
        breadcrumbs={openId ? [{ label: 'Development', href: '/development' }, { label: `DEV-${openId}` }] : undefined}
        description={`${counts.untriaged} untriaged · ${counts.inProgress} in flight · ${resp?.meta.total_matching ?? 0} matching this view`}
        actions={
          <>
            <Button variant="ghost" leftIcon={<Keyboard className="h-4 w-4" />} onClick={() => setHelpOpen(true)}>Shortcuts</Button>
            <Button variant="ghost" leftIcon={<RefreshCw className="h-4 w-4" />} onClick={reload}>Refresh</Button>
            <Button leftIcon={<Plus className="h-4 w-4" />} onClick={() => setNewOpen(true)}>New item</Button>
          </>
        }
      />

      {fixture && (
        <Alert tone="amber" title="Fixture data" className="mb-4">
          <code className="font-mono text-[12px]">/api/dev-items</code> is not mounted on this server yet
          (the backend for this contract is landing separately), so the board is rendering the local
          fixture in <code className="font-mono text-[12px]">lib/devItemsFixture.ts</code>. Every request
          shape below is the real A1–A16 contract; delete that one file to go live.
        </Alert>
      )}

      <div className="mb-3">
        <Tabs items={tabItems} value={tab} onChange={k => { setTab(k as Tab); setSelected(new Set()); setFocusIdx(0) }} />
      </div>

      <BoardToolbar
        tab={tab}
        filters={filters}
        setFilters={setFilters}
        searchDraft={searchDraft}
        setSearchDraft={setSearchDraft}
        wsOptions={wsOptions}
        projectOptions={projectOptions}
        areaOptions={areaOptions}
        routeOptions={routeOptions}
        resp={resp}
        facets={facets}
        filterCount={filterCount}
        clearAll={clearAll}
        selected={selected}
        setSelected={setSelected}
        runBulk={runBulk}
        bulkPromote={bulkPromote}
        sortOverride={sortOverride}
        setSortOverride={setSortOverride}
      />

      {tab === 'changelog' ? (
        <ChangelogPanel workspaces={filters.workspace} search={filters.q} />
      ) : (
        <>
          {error && (
            <Alert tone="alarm" title="Could not load the board" className="mb-3">
              {error} <button className="underline" onClick={reload}>Retry</button>
            </Alert>
          )}

          {!canRank && sort === 'rank' && (
            <p className="mb-2 text-[11.5px] text-fg-3">Select exactly one platform to drag-reorder — ranks are per-platform.</p>
          )}

          <DataTable
            columns={columns}
            rows={rows}
            rowKey={r => r.id}
            loading={loading}
            loadingRows={8}
            onRowClick={r => openItem(r.id)}
            mobileTitle={r => <span>{r.ref} · {r.title}</span>}
            empty={emptyState}
            rowActions={row => (
              <>
                <Button size="sm" variant="ghost" onClick={e => { e.stopPropagation(); void triageDevItem(row.id, { suggest_rank: true }).then(reload) }}>
                  Triage
                </Button>
                {row.objective_id === null && row.status === 'triaged' && (
                  <Button size="sm" variant="ghost" onClick={e => { e.stopPropagation(); void promoteDevItem(row.id, {}).then(reload) }}>
                    Promote
                  </Button>
                )}
                <Button
                  size="sm" variant="ghost"
                  onClick={async e => {
                    e.stopPropagation()
                    const ok = await confirm({ title: `Delete ${row.ref}?`, confirmLabel: 'Delete', danger: true })
                    if (ok) { await deleteDevItem(row.id); reload() }
                  }}
                >Delete</Button>
              </>
            )}
          />

          {rows.length > 0 && (
            <p className="mt-2 font-mono text-[10.5px] text-fg-3">
              row {Math.min(focusIdx + 1, rows.length)} of {rows.length} · j/k to move · enter to open · ? for shortcuts
            </p>
          )}
        </>
      )}

      {openId !== null && (
        <DevItemDrawer
          key={openId}
          itemId={openId}
          onClose={closeItem}
          onChanged={reload}
          onFilterRoute={r => { setFilters(f => ({ ...f, route: r })); closeItem() }}
        />
      )}

      <NewItemModal
        open={newOpen}
        onClose={() => setNewOpen(false)}
        onCreated={reload}
        workspaces={workspaces.map(w => ({ slug: w.slug, label: labelOf(w.slug) }))}
        defaultWorkspace={filters.workspace[0] ?? (workspace !== 'all' ? workspace : workspaces[0]?.slug ?? '')}
      />

      <KeyboardHelpModal open={helpOpen} onClose={() => setHelpOpen(false)} />

      {toast && (
        <div className="pointer-events-none fixed bottom-4 right-4 z-[60]">
          <Toast tone={toast.tone} onDismiss={() => setToast(null)}>{toast.text}</Toast>
        </div>
      )}

      {!loading && !error && rows.length === 0 && workspaces.length === 0 && tab !== 'changelog' && (
        <div className="mt-3 rounded-lg border border-line bg-surface-2">
          <EmptyState
            title="No platforms connected"
            description="Connect a platform integration (kind='development') before items can arrive."
            action={<Button variant="ghost" onClick={() => navigate('/settings/org')}>Open Settings</Button>}
          />
        </div>
      )}

      {confirmDialog}
    </PageContainer>
  )
}
