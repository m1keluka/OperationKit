import { useCallback, useEffect, useMemo, useState } from 'react'
import { Archive, Plus, Search } from 'lucide-react'
import {
  OBJECTIVE_STATUSES,
  type Objective,
  type ObjectiveStatus,
  type Workspace,
} from '@command-center/shared'
import { useObjectives } from '../hooks/useObjectives'
import { useSlashSearch } from '../hooks/useSlashSearch'
import { useIsBoardMobile } from '../hooks/useMediaQuery'
import { useAuth } from '../context/AuthContext'
import { useNavigate } from '../context/nav'
import { groupObjectives } from '../lib/groupObjectives'
import { scopeObjectives } from '../lib/scopeObjectives'
import { boardColumnOf, orderBoardColumns } from '../lib/boardColumns'
import {
  UNASSIGNED_TOKEN,
  matchesAssigneeFilter,
  assigneeRoster,
  defaultAssigneeSelection,
  loadAssigneeSelection,
  saveAssigneeSelection,
} from '../lib/assigneeFilter'
import {
  ALL_PROJECTS,
  matchesProjectFilter,
  loadProjectSelection,
  saveProjectSelection,
  type ProjectSelection,
} from '../lib/projectFilter'
import { useProjects } from '../hooks/useProjects'
import { ProjectFilterBar } from '../components/ProjectFilterBar'
import { api } from '../lib/api'
import { STATUS_META } from '../components/design/primitives'
import { SessionViewer } from '../components/SessionViewer'
import { ObjectiveModal } from '../components/ObjectiveModal'
import { ObjectiveSearchPanel } from '../components/ObjectiveSearchPanel'
import { PreviewCard } from './PreviewCard'

export function PreviewBoard({ workspaces }: { workspaces: Workspace[] }) {
  const {
    objectives, loading, error, changeStatus, connectionState,
    createObjective, updateObjective, deleteObjective,
    doneObjectives, doneLoading, doneLoaded, doneHasMore, loadMoreDone,
  } = useObjectives(workspaces)
  const isMobile = useIsBoardMobile()
  const { user } = useAuth()
  const navigate = useNavigate()
  const [sessionObjective, setSessionObjective] = useState<Objective | null>(null)
  const [modalOpen, setModalOpen] = useState(false)
  const [editingObjective, setEditingObjective] = useState<Objective | null>(null)
  const [searchOpen, setSearchOpen] = useSlashSearch()
  // For a non-admin member of exactly one org, effectiveOrg is that org even
  // when selectedWorkspaces is still [] (the brief window between auth
  // resolving and the App.tsx clamp effect firing).  Admins are kept on their
  // selected value.
  const effectiveOrg: Workspace | null = (() => {
    if (workspaces.length === 1) return workspaces[0]
    if (workspaces.length === 0 && user?.role !== 'admin') {
      const userWs = user?.workspaces
      if (userWs?.length === 1) return userWs[0].workspace as Workspace
    }
    return null
  })()
  const modalWorkspace: Workspace = effectiveOrg ?? 'all'
  const wsKey = workspaces.slice().sort().join(',')

  const [assigneeSel, setAssigneeSel] = useState<string[]>(
    () => loadAssigneeSelection(wsKey || 'all') ?? defaultAssigneeSelection(user?.username)
  )
  useEffect(() => {
    setAssigneeSel(loadAssigneeSelection(wsKey || 'all') ?? defaultAssigneeSelection(user?.username))
  }, [wsKey, user?.username])

  const selectedAssignees = useMemo(() => new Set(assigneeSel), [assigneeSel])

  // ── Project (organization subfolder) filter — obj 708826 ─────────────────
  // A project belongs to exactly ONE organization, so the picker only appears
  // in a single-org view. The selection is stored under the workspace key,
  // which is also what makes it reset on an org switch: the new org reads its
  // own (usually empty) slot and falls back to All projects.
  const projectWorkspace = effectiveOrg
  const {
    projects, refresh: refreshProjects, createProject, renameProject, deleteProject,
  } = useProjects(projectWorkspace)
  const [projectSel, setProjectSel] = useState<ProjectSelection>(
    () => loadProjectSelection(wsKey || 'all') ?? ALL_PROJECTS
  )
  useEffect(() => {
    setProjectSel(loadProjectSelection(wsKey || 'all') ?? ALL_PROJECTS)
  }, [wsKey])
  const selectProject = useCallback((next: ProjectSelection) => {
    setProjectSel(next)
    saveProjectSelection(wsKey || 'all', next)
  }, [wsKey])
  // Saving an objective can move it into or out of a project, which changes the
  // per-chip objective counts — re-read them rather than leaving a stale number
  // on the chip the user just filled.
  const createObjectiveInProject = useCallback(async (data: Parameters<typeof createObjective>[0]) => {
    const created = await createObjective(data)
    void refreshProjects()
    return created
  }, [createObjective, refreshProjects])
  const updateObjectiveInProject = useCallback(async (id: number, data: Parameters<typeof updateObjective>[1]) => {
    const updated = await updateObjective(id, data)
    void refreshProjects()
    return updated
  }, [updateObjective, refreshProjects])
  // A stored id can outlive its project (deleted here or in another tab) — fall
  // back to All rather than showing an empty board with no visible cause.
  useEffect(() => {
    if (typeof projectSel !== 'number') return
    if (projects.length === 0) return
    if (!projects.some(p => p.id === projectSel)) selectProject(ALL_PROJECTS)
  }, [projects, projectSel, selectProject])

  const toggleAssignee = useCallback((token: string) => {
    setAssigneeSel(prev => {
      const next = prev.includes(token) ? prev.filter(t => t !== token) : [...prev, token]
      saveAssigneeSelection(wsKey || 'all', next)
      return next
    })
  }, [wsKey])

  useEffect(() => {
    if (!loading && !doneLoaded && !doneLoading) loadMoreDone()
  }, [loading, doneLoaded, doneLoading, loadMoreDone])

  const { childrenByParent, topLevel } = useMemo(() => {
    const live = groupObjectives(scopeObjectives(objectives, workspaces))
    const done = groupObjectives(scopeObjectives(doneObjectives, workspaces))
    const byParent = new Map(live.childrenByParent)
    for (const [id, kids] of done.childrenByParent) {
      const existing = byParent.get(id) || []
      byParent.set(id, [...existing, ...kids.filter(k => !existing.some(e => e.id === k.id))])
    }
    return {
      childrenByParent: byParent,
      topLevel: live.topLevel.filter(o => o.routine_id == null),
    }
  }, [objectives, doneObjectives, workspaces])

  const assigneeOptions = useMemo(() => {
    const roster = assigneeRoster([...topLevel, ...doneObjectives])
    if (user?.username && !roster.includes(user.username)) {
      roster.push(user.username)
      roster.sort((a, b) => a.localeCompare(b))
    }
    return roster
  }, [topLevel, doneObjectives, user?.username])

  const allOwnerTokens = useMemo(
    () => [UNASSIGNED_TOKEN, ...assigneeOptions],
    [assigneeOptions],
  )
  const everyoneSelected = allOwnerTokens.length > 0 && allOwnerTokens.every(t => selectedAssignees.has(t))

  const selectEveryone = useCallback(() => {
    const next = everyoneSelected
      ? defaultAssigneeSelection(user?.username)
      : allOwnerTokens
    saveAssigneeSelection(wsKey || 'all', next)
    setAssigneeSel(next)
  }, [allOwnerTokens, everyoneSelected, user?.username, wsKey])

  const filteredTopLevel = useMemo(
    () => topLevel.filter(o =>
      matchesAssigneeFilter(o, selectedAssignees) && matchesProjectFilter(o, projectSel)
    ),
    [topLevel, selectedAssignees, projectSel],
  )

  const grouped = useMemo(() => {
    const map: Record<ObjectiveStatus, Objective[]> = {
      planning: [], queue: [], working: [], ai_review: [], review: [], done: [], cancelled: [],
    }
    for (const obj of filteredTopLevel) {
      const col = boardColumnOf(obj, childrenByParent.get(obj.id))
      map[col]?.push(obj)
    }
    const seen = new Set(map.done.map(o => o.id))
    for (const o of doneObjectives) {
      if (o.routine_id != null) continue
      if (!matchesAssigneeFilter(o, selectedAssignees)) continue
      // The lazily-fetched Done backlog bypasses `filteredTopLevel`, so the
      // project gate is re-applied here too.
      if (!matchesProjectFilter(o, projectSel)) continue
      if (!seen.has(o.id)) {
        map.done.push(o)
        seen.add(o.id)
      }
    }
    return map
  }, [filteredTopLevel, childrenByParent, doneObjectives, selectedAssignees, projectSel])

  const columns = useMemo(() => {
    const transient: ObjectiveStatus[] = ['planning', 'ai_review']
    const cols = OBJECTIVE_STATUSES.filter(s => {
      if (s === 'cancelled') return false
      if (transient.includes(s)) return grouped[s].length > 0
      return true
    })
    return orderBoardColumns(cols, isMobile)
  }, [grouped, isMobile])

  const handleOpen = useCallback((o: Objective) => {
    setSessionObjective(o)
  }, [])

  const handleNewObjective = useCallback(() => {
    setEditingObjective(null)
    setModalOpen(true)
  }, [])

  const handleEditObjective = useCallback((o: Objective) => {
    setEditingObjective(o)
    setModalOpen(true)
  }, [])

  const handleModalClose = useCallback(() => {
    setModalOpen(false)
    setEditingObjective(null)
  }, [])

  const handleChangeStatus = useCallback(async (id: number, status: ObjectiveStatus) => {
    await changeStatus(id, status)
  }, [changeStatus])

  const openInNewTab = useCallback((id: number) => {
    window.open(`/o/${id}`, '_blank', 'noopener')
  }, [])

  const openObjectiveById = useCallback(async (id: number) => {
    try {
      const full = await api.get<Objective>(`/objectives/${id}`)
      setSessionObjective(full)
    } catch {
      /* search result may 404 if RBAC hides it */
    }
  }, [])

  if (loading) {
    return <div className="flex flex-1 items-center justify-center text-sm text-fg-2">Loading board…</div>
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-2">
        <span className="text-[12px] text-fg-2">
          {connectionState === 'connected' ? 'Live' : connectionState === 'reconnecting' ? 'Reconnecting…' : 'Disconnected'}
          {error ? ` · ${error}` : ''}
        </span>
        <div className="flex items-center gap-3">
          <span className="text-[12px] text-fg-3">
            {filteredTopLevel.length === topLevel.length
              ? `${topLevel.length} cards`
              : `${filteredTopLevel.length} of ${topLevel.length}`}
          </span>
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
            onClick={() => navigate('/archive')}
            title="Full done / retired library"
            className="inline-flex items-center gap-1.5 rounded-md border border-line bg-surface-2 px-2.5 py-1.5 text-sm text-fg-2 hover:border-line-strong hover:text-fg-1"
          >
            <Archive className="h-4 w-4" />
            <span className="hidden md:inline">Archive</span>
          </button>
          <button
            type="button"
            onClick={handleNewObjective}
            className="inline-flex items-center gap-1 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg hover:bg-accent-hover"
          >
            <Plus className="h-4 w-4" />
            New
          </button>
        </div>
      </div>
      {/* Project (org subfolder) picker — hidden for All / multi-org, where a
          project has nothing to scope. Also the create/rename/delete surface. */}
      {projectWorkspace && (
        <ProjectFilterBar
          projects={projects}
          selection={projectSel}
          onSelect={selectProject}
          workspace={projectWorkspace}
          onCreate={createProject}
          onRename={renameProject}
          onDelete={deleteProject}
        />
      )}
      <div className="flex items-center gap-2 overflow-x-auto border-b border-line px-4 py-2">
        <span className="shrink-0 text-[11px] font-medium uppercase tracking-[0.1em] text-fg-3">Owner</span>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={selectEveryone}
            aria-pressed={everyoneSelected}
            className={`whitespace-nowrap rounded-full border px-2.5 py-1 text-[12px] ${
              everyoneSelected
                ? 'border-accent bg-surface-2 text-fg-0'
                : 'border-line text-fg-2 hover:border-line-strong hover:text-fg-1'
            }`}
          >
            Everyone
          </button>
          {[{ token: UNASSIGNED_TOKEN, label: 'Unassigned' }, ...assigneeOptions.map(u => ({ token: u, label: u }))].map(opt => {
            const active = selectedAssignees.has(opt.token)
            return (
              <button
                key={opt.token}
                type="button"
                onClick={() => toggleAssignee(opt.token)}
                aria-pressed={active}
                className={`whitespace-nowrap rounded-full border px-2.5 py-1 text-[12px] ${
                  active
                    ? 'border-accent bg-surface-2 text-fg-0'
                    : 'border-line text-fg-2 hover:border-line-strong hover:text-fg-1'
                }`}
              >
                {opt.label}
              </button>
            )
          })}
        </div>
      </div>
      <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto p-3 sm:p-4">
        {columns.map(status => (
          <section key={status} className="cc-ws-col max-h-full w-[300px] shrink-0 overflow-hidden">
            <div className="flex items-center px-3 py-2">
              <span className="text-[11px] font-medium uppercase tracking-[0.1em] text-fg-2">
                {STATUS_META[status].label}
              </span>
              <span className="ml-auto font-mono text-[11px] text-fg-3">{grouped[status].length}</span>
            </div>
            <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-2 pb-3">
              {grouped[status].map(obj => (
                <PreviewCard
                  key={obj.id}
                  objective={obj}
                  children={childrenByParent.get(obj.id)}
                  onOpen={handleOpen}
                  onEdit={handleEditObjective}
                  onChangeStatus={handleChangeStatus}
                />
              ))}
              {status === 'done' && (
                <>
                  {doneLoading && (
                    <div className="px-2 py-3 text-center text-[11px] text-fg-3">Loading done…</div>
                  )}
                  {!doneLoading && (doneHasMore || !doneLoaded) && (
                    <button
                      type="button"
                      onClick={() => loadMoreDone()}
                      className="w-full rounded-md border border-dashed border-line px-3 py-2 text-[11px] text-fg-2 hover:border-line-strong hover:text-fg-0"
                    >
                      {doneLoaded ? 'Load more done' : 'Load done'}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => navigate('/archive')}
                    className="w-full rounded-md px-3 py-2 text-[11px] text-fg-2 hover:text-fg-0"
                  >
                    View full archive
                  </button>
                </>
              )}
            </div>
          </section>
        ))}
      </div>

      <ObjectiveSearchPanel
        open={searchOpen}
        workspace={modalWorkspace}
        onClose={() => setSearchOpen(false)}
        onSelect={openObjectiveById}
      />

      {modalOpen && (
        <ObjectiveModal
          objective={editingObjective}
          workspace={modalWorkspace}
          defaultProjectId={typeof projectSel === 'number' ? projectSel : null}
          onClose={handleModalClose}
          onCreate={createObjectiveInProject}
          onUpdate={updateObjectiveInProject}
          onDelete={deleteObjective}
          onReopen={(id) => {
            const target = editingObjective?.status === 'cancelled' ? 'queue' : 'working'
            void handleChangeStatus(id, target)
            handleModalClose()
          }}
        />
      )}

      {sessionObjective && (
        <SessionViewer
          objective={sessionObjective}
          chrome="dialog"
          onClose={() => setSessionObjective(null)}
          onChangeStatus={handleChangeStatus}
          onOpenInNewTab={() => openInNewTab(sessionObjective.id)}
          onEdit={() => {
            handleEditObjective(sessionObjective)
            setSessionObjective(null)
          }}
        />
      )}
    </div>
  )
}
