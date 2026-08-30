import { useCallback, useEffect, useMemo, useState } from 'react'
import { Pencil, Search } from 'lucide-react'
import type { Objective, ObjectiveStatus, UpdateObjectiveRequest, Workspace } from '@operationkit/shared'
import { useArchiveLibrary } from '../hooks/useArchiveLibrary'
import { useSlashSearch } from '../hooks/useSlashSearch'
import { useNavigate } from '../context/nav'
import { useWorkspaces } from '../hooks/useWorkspaces'
import { useAuth } from '../context/AuthContext'
import { groupObjectives } from '../lib/groupObjectives'
import { scopeObjectives } from '../lib/scopeObjectives'
import { api } from '../lib/api'
import { relativeTime } from '../lib/time'
import { AgentMonogram, STATUS_META } from '../components/design/primitives'
import { ObjectiveModal } from '../components/ObjectiveModal'
import { ObjectiveSearchPanel } from '../components/ObjectiveSearchPanel'
import { SessionViewer } from '../components/SessionViewer'

type Tab = 'done' | 'cancelled'

function matchesQuery(obj: Objective, q: string): boolean {
  if (!q) return true
  const hay = [
    obj.title,
    obj.project,
    obj.agent_context,
    obj.workspace,
    String(obj.id),
    ...(obj.assigned_usernames ?? []),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
  return hay.includes(q)
}

export function PreviewArchive({ workspaces }: { workspaces: Workspace[] }) {
  const {
    done, cancelled, doneLoading, cancelledLoading, cancelledLoaded, error, loadCancelled, applyUpdate,
  } = useArchiveLibrary(workspaces)
  const { shortOf } = useWorkspaces()
  const { user } = useAuth()
  const navigate = useNavigate()
  const [tab, setTab] = useState<Tab>('done')
  const [query, setQuery] = useState('')
  const [searchOpen, setSearchOpen] = useSlashSearch()
  const [sessionObjective, setSessionObjective] = useState<Objective | null>(null)
  const [editingObjective, setEditingObjective] = useState<Objective | null>(null)
  // Defensive: a non-admin member of one org still gets a scoped workspace
  // while selectedWorkspaces is resolving from [] to [org] in App.tsx.
  const searchWorkspace: Workspace = (() => {
    if (workspaces.length === 1) return workspaces[0]
    if (workspaces.length === 0 && user?.role !== 'admin') {
      const userWs = user?.workspaces
      if (userWs?.length === 1) return userWs[0].workspace as Workspace
    }
    return 'all'
  })()

  useEffect(() => {
    if (tab === 'cancelled' && !cancelledLoaded && !cancelledLoading) {
      void loadCancelled()
    }
  }, [tab, cancelledLoaded, cancelledLoading, loadCancelled])

  const source = tab === 'done' ? done : cancelled
  const loading = tab === 'done' ? doneLoading : cancelledLoading

  const { childrenByParent, topLevel } = useMemo(() => {
    const scoped = scopeObjectives(source, workspaces)
    const grouped = groupObjectives(scoped)
    return {
      childrenByParent: grouped.childrenByParent,
      topLevel: grouped.topLevel.filter(o => o.routine_id == null),
    }
  }, [source, workspaces])

  const q = query.trim().toLowerCase()
  const rows = useMemo(
    () => topLevel.filter(o => matchesQuery(o, q)),
    [topLevel, q],
  )

  const openById = useCallback(async (id: number) => {
    try {
      const full = await api.get<Objective>(`/objectives/${id}`)
      setSessionObjective(full)
    } catch {
      /* search result may 404 if RBAC hides it */
    }
  }, [])

  const handleChangeStatus = useCallback(async (id: number, status: ObjectiveStatus) => {
    const updated = await api.patch<Objective>(`/objectives/${id}/status`, { status })
    applyUpdate(updated)
    setSessionObjective(null)
    setEditingObjective(null)
    if (status !== 'done' && status !== 'cancelled') navigate('/')
  }, [navigate, applyUpdate])

  const handleReopen = useCallback((obj: Objective) => {
    const target = obj.status === 'cancelled' ? 'queue' : 'working'
    return handleChangeStatus(obj.id, target)
  }, [handleChangeStatus])

  const handleUpdate = useCallback(async (id: number, data: UpdateObjectiveRequest) => {
    const updated = await api.put<Objective>(`/objectives/${id}`, data)
    applyUpdate(updated)
    return updated
  }, [applyUpdate])

  const handleDelete = useCallback(async (id: number) => {
    await api.del(`/objectives/${id}`)
    applyUpdate({ id, status: 'working' } as Objective)
  }, [applyUpdate])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-2">
        <h1 className="text-sm font-medium text-fg-0">Archive</h1>
        <div className="flex items-center gap-1">
          {([
            { key: 'done' as const, label: 'Done', count: done.length },
            { key: 'cancelled' as const, label: 'Retired', count: cancelledLoaded ? cancelled.length : null },
          ]).map(t => (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              aria-pressed={tab === t.key}
              className={`rounded-full border px-2.5 py-1 text-[12px] ${
                tab === t.key
                  ? 'border-accent bg-surface-2 text-fg-0'
                  : 'border-line text-fg-2 hover:border-line-strong hover:text-fg-1'
              }`}
            >
              {t.label}
              {t.count != null && (
                <span className="ml-1.5 font-mono text-[11px] text-fg-3">{t.count}</span>
              )}
            </button>
          ))}
        </div>
        <label className="relative min-w-[180px] flex-1 max-w-md">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-fg-3" />
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Filter this library…"
            className="w-full rounded-md border border-line bg-surface-2 py-1.5 pl-8 pr-3 text-sm text-fg-0 placeholder-fg-3 outline-none focus:border-line-strong"
          />
        </label>
        <button
          type="button"
          onClick={() => setSearchOpen(true)}
          title="Search objectives (all stages) — press /"
          className="inline-flex items-center gap-1.5 rounded-md border border-line bg-surface-2 px-2.5 py-1.5 text-sm text-fg-2 hover:border-line-strong hover:text-fg-1"
        >
          <Search className="h-4 w-4" />
          <span className="hidden md:inline">Search</span>
          <span className="hidden font-mono text-[10.5px] text-fg-3 md:inline">/</span>
        </button>
        <button
          type="button"
          onClick={() => navigate('/')}
          className="text-[12px] text-fg-2 hover:text-fg-0"
        >
          Back to board
        </button>
      </div>

      {error && (
        <div className="border-b border-line px-4 py-2 text-sm text-[color:var(--ok-alarm)]">{error}</div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {rows.length === 0 && !loading ? (
          <div className="px-4 py-12 text-center text-sm text-fg-3">
            {q ? 'No matches in this library.' : tab === 'done' ? 'No done objectives.' : 'No retired objectives.'}
          </div>
        ) : (
          <ul>
            {rows.map(obj => {
              const kids = childrenByParent.get(obj.id) ?? []
              const meta = STATUS_META[obj.status]
              return (
                <li key={obj.id} className="border-b border-line">
                  <div className="flex items-start gap-1 px-2 py-1 hover:bg-surface-3">
                    <button
                      type="button"
                      onClick={() => setSessionObjective(obj)}
                      className="flex min-w-0 flex-1 items-start gap-3 px-2 py-2 text-left"
                    >
                      <AgentMonogram agent={obj.agent_context} size="sm" />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline gap-2">
                          <span className="truncate text-[14px] font-medium text-fg-0">{obj.title || 'Untitled'}</span>
                          <span className="shrink-0 font-mono text-[10.5px] uppercase tracking-wide text-fg-3">
                            {shortOf(obj.workspace as Workspace)}
                          </span>
                        </div>
                        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11.5px] text-fg-2">
                          <span className={meta.tone}>{meta.label}</span>
                          {obj.project && <span>{obj.project}</span>}
                          {obj.assigned_usernames && obj.assigned_usernames.length > 0 ? (
                            <span>{obj.assigned_usernames.join(', ')}</span>
                          ) : (
                            <span className="text-fg-3">Unassigned</span>
                          )}
                          {kids.length > 0 && <span>{kids.length} nested</span>}
                          {obj.pr_url && <span>#{obj.pr_number ?? 'PR'}</span>}
                        </div>
                      </div>
                      <span className="shrink-0 font-mono text-[11px] text-fg-3">{relativeTime(obj.updated_at)}</span>
                    </button>
                    <div className="mt-1.5 flex shrink-0 items-center gap-1">
                      {(obj.status === 'cancelled' || obj.status === 'done') && (
                        <button
                          type="button"
                          onClick={() => void handleReopen(obj)}
                          className="rounded-md bg-accent px-2.5 py-1 text-xs font-medium text-accent-fg hover:bg-accent-hover"
                        >
                          Re-open
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => setEditingObjective(obj)}
                        aria-label="Edit objective"
                        title="Edit objective"
                        className="inline-flex h-7 w-7 items-center justify-center rounded-md text-fg-3 hover:bg-surface-4 hover:text-fg-0"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
        {loading && (
          <div className="px-4 py-3 text-center text-[12px] text-fg-3">
            {source.length > 0 ? `Loading archive… ${source.length} so far` : 'Loading archive…'}
          </div>
        )}
        {!loading && q && rows.length !== topLevel.length && (
          <div className="px-4 py-3 text-center text-[12px] text-fg-3">
            Showing {rows.length} of {topLevel.length}
          </div>
        )}
      </div>

      <ObjectiveSearchPanel
        open={searchOpen}
        workspace={searchWorkspace}
        onClose={() => setSearchOpen(false)}
        onSelect={openById}
      />

      {editingObjective && (
        <ObjectiveModal
          objective={editingObjective}
          workspace={searchWorkspace}
          onClose={() => setEditingObjective(null)}
          onCreate={async () => { throw new Error('create is not available from archive') }}
          onUpdate={handleUpdate}
          onDelete={handleDelete}
          onReopen={() => {
            if (editingObjective) void handleReopen(editingObjective)
          }}
        />
      )}

      {sessionObjective && (
        <SessionViewer
          objective={sessionObjective}
          chrome="dialog"
          onClose={() => setSessionObjective(null)}
          onChangeStatus={handleChangeStatus}
          onOpenInNewTab={() => window.open(`/o/${sessionObjective.id}`, '_blank', 'noopener')}
          onEdit={() => {
            setEditingObjective(sessionObjective)
            setSessionObjective(null)
          }}
        />
      )}
    </div>
  )
}
