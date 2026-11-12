import { useCallback, useEffect, useMemo, useState } from 'react'
import { Archive, Plus, Search, Workflow } from 'lucide-react'
import {
  OBJECTIVE_STATUSES,
  type Objective,
  type ObjectiveStatus,
  type Workspace,
} from '@operationkit/shared'
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
import { useProjects, ALL_ORGS } from '../hooks/useProjects'
import { useWorkspaces } from '../hooks/useWorkspaces'
import { ProjectFilterBar } from '../components/ProjectFilterBar'
import { OwnerFilterSelect } from '../components/OwnerFilterSelect'
import { api } from '../lib/api'
import { STATUS_META } from '../components/design/primitives'
import { SessionViewer } from '../components/SessionViewer'
import { ObjectiveModal } from '../components/ObjectiveModal'
import { ObjectiveSearchPanel } from '../components/ObjectiveSearchPanel'
import { NewWorkflowDialog } from '../components/jobs/NewWorkflowDialog'
import { PreviewCard } from './PreviewCard'

interface PreviewBoardProps {
  /** Selected org slugs. Empty = All organizations. */
  workspaces: Workspace[]
}

export function PreviewBoard({ workspaces }: PreviewBoardProps) {
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
  // obj 900197: the project row used to vanish whenever the board spanned more
  // than one org (`projectWorkspace` null), which is the default
  // All-Organizations view — so most of the time there was no project filter at
  // all. Now the scope follows the board: one org → that org, a multi-select →
  // those orgs, All → every org the caller can access.
  const projectScope = projectWorkspace ?? (workspaces.length > 0 ? workspaces : ALL_ORGS)
  const {
    projects, refresh: refreshProjects, createProject, renameProject, deleteProject,
  } = useProjects(projectScope)
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

  // ── Organizations (obj 900197; the switcher moved to the top bar in obj 900666)───────────────────────────────
  // Admins see every active org; a member sees only the ones they belong to.
  const { workspaces: orgRecords, shortOf: orgShortOf, labelOf: orgLabelOf } =
    useWorkspaces()
  // "New workflow" (obj 900642, card B6): a goal → a builder card on this board.
  const [workflowOpen, setWorkflowOpen] = useState(false)
  const isAdmin = user?.role === 'admin'
  const orgOptions = useMemo(() => {
    const memberSlugs = new Set((user?.workspaces ?? []).map(w => w.workspace))
    return orgRecords
      .filter(w => isAdmin || memberSlugs.has(w.slug))
      .map(w => ({ slug: w.slug, label: w.name || w.slug }))
  }, [orgRecords, isAdmin, user?.workspaces])

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
      {/* ── One-line board header (obj 900666) ─────────────────────────────
          Project ▾ and Owner ▾ on the left, Search / Archive / New on the
          right — everything on one line, then the board. The organization is
          no longer chosen here: the top-bar switcher next to "Jump to" sets it
          for the whole app. */}
      <div
        data-testid="board-header"
        className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2 md:flex-nowrap"
      >
        <ProjectFilterBar
          projects={projects}
          selection={projectSel}
          onSelect={selectProject}
          workspace={projectWorkspace}
          orgOptions={orgOptions}
          orgLabelOf={orgShortOf}
          onCreate={(name, ws) => createProject(name, ws ? { workspace: ws } : undefined)}
          onRename={renameProject}
          onDelete={deleteProject}
        />
        <OwnerFilterSelect
          options={assigneeOptions}
          selected={selectedAssignees}
          everyoneSelected={everyoneSelected}
          currentUser={user?.username}
          onToggle={toggleAssignee}
          onEveryone={selectEveryone}
        />

        <div className="ml-auto flex items-center gap-2">
          {/* obj 900669 — the "need you" count is the Needs You column's own
              length (same array, same filters), so the header can never report
              fewer cards than the column shows. Cards with an agent still
              running on them sit in Working, not here (boardColumnOf). */}
          {grouped.review.length > 0 && (
            <span
              data-testid="board-needs-you-count"
              className="inline-flex items-center gap-1 whitespace-nowrap text-[12px] text-fg-1"
            >
              <span className="font-mono font-semibold text-[color:var(--accent-hover)]">{grouped.review.length}</span>
              need you
            </span>
          )}
          <span
            className="hidden items-center gap-1.5 whitespace-nowrap text-[12px] text-fg-3 lg:inline-flex"
            title={connectionState === 'connected' ? 'Live updates on' : 'Live updates paused'}
          >
            <span
              aria-hidden="true"
              className={`h-1.5 w-1.5 rounded-full ${
                connectionState === 'connected' ? 'bg-[color:var(--ok-verify)]'
                  : connectionState === 'reconnecting' ? 'bg-[color:var(--ok-amber)]'
                  : 'bg-[color:var(--ok-alarm)]'
              }`}
            />
            {connectionState === 'connected' ? '' : connectionState === 'reconnecting' ? 'Reconnecting… · ' : 'Disconnected · '}
            {filteredTopLevel.length === topLevel.length
              ? `${topLevel.length} cards`
              : `${filteredTopLevel.length} of ${topLevel.length} cards`}
          </span>
          {/* The ONE card search. It is not the top bar's "Jump to" (⌘K),
              which goes to pages; this one finds cards — so it says so. */}
          <button
            type="button"
            onClick={() => setSearchOpen(true)}
            aria-label="Search cards"
            title="Search cards — every stage, including done. Press /. (To go to a page, use Jump to ⌘K in the top bar.)"
            className="inline-flex items-center gap-1.5 rounded-md border border-line bg-surface-2 px-2.5 py-1.5 text-sm text-fg-2 hover:border-line-strong hover:text-fg-1"
          >
            <Search className="h-4 w-4" />
            <span className="hidden md:inline">Search cards</span>
            <span className="hidden font-mono text-[12px] text-fg-3 md:inline">/</span>
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
          {orgRecords.length > 0 && (
            <button
              type="button"
              onClick={() => setWorkflowOpen(true)}
              title="New workflow: describe a goal and a builder agent drafts and self-tests it"
              aria-label="New workflow"
              data-testid="board-new-workflow"
              className="inline-flex items-center gap-1.5 rounded-md border border-line bg-surface-2 px-2.5 py-1.5 text-sm text-fg-2 hover:border-line-strong hover:text-fg-1"
            >
              <Workflow className="h-4 w-4" />
              <span className="hidden md:inline">Workflow</span>
            </button>
          )}
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
      {error && (
        <div className="border-b border-line px-4 py-1.5 text-[12px] text-[color:var(--ok-alarm)]">{error}</div>
      )}
      <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto p-3 sm:p-4">
        {columns.map(status => (
          <section key={status} data-status={status} className="cc-ws-col max-h-full w-[300px] shrink-0 overflow-hidden">
            <div className="flex items-center px-3 py-2">
              <span className="text-[12px] font-medium uppercase tracking-[0.1em] text-fg-2">
                {STATUS_META[status].label}
              </span>
              <span data-testid={`column-count-${status}`} className="ml-auto font-mono text-[12px] text-fg-3">{grouped[status].length}</span>
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
                  showOrgChip={workspaces.length !== 1}
                />
              ))}
              {status === 'done' && (
                <>
                  {doneLoading && (
                    <div className="px-2 py-3 text-center text-[12px] text-fg-3">Loading done…</div>
                  )}
                  {!doneLoading && (doneHasMore || !doneLoaded) && (
                    <button
                      type="button"
                      onClick={() => loadMoreDone()}
                      className="w-full rounded-md border border-dashed border-line px-3 py-2 text-[12px] text-fg-2 hover:border-line-strong hover:text-fg-0"
                    >
                      {doneLoaded ? 'Load more done' : 'Load done'}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => navigate('/archive')}
                    className="w-full rounded-md px-3 py-2 text-[12px] text-fg-2 hover:text-fg-0"
                  >
                    View full archive
                  </button>
                </>
              )}
            </div>
          </section>
        ))}
      </div>

      {/* Mounted only while open, like ObjectiveModal below: the board does not
          render the dialog's Modal until someone asks for a workflow. */}
      {workflowOpen && (
        <NewWorkflowDialog
          open
          onClose={() => setWorkflowOpen(false)}
          workspaces={orgOptions.map(o => o.slug)}
          defaultWorkspace={projectWorkspace}
          labelOf={orgLabelOf}
        />
      )}

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
