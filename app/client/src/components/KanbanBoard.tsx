import { useState, useCallback, useMemo, useEffect, lazy, Suspense } from 'react'
import { Plus, Search } from 'lucide-react'
import {
  OBJECTIVE_STATUSES,
  type Objective,
  type ObjectiveStatus,
  type Workspace,
} from '@operationkit/shared'
import { useObjectives } from '../hooks/useObjectives'
import { useIsBoardMobile } from '../hooks/useMediaQuery'
import { boardColumnOf, orderBoardColumns } from '../lib/boardColumns'
import { useAuth } from '../context/AuthContext'
import { groupObjectives } from '../lib/groupObjectives'
import { scopeObjectives } from '../lib/scopeObjectives'
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
import { ProjectFilterBar } from './ProjectFilterBar'
import { KanbanColumn } from './KanbanColumn'
import { ObjectiveModal } from './ObjectiveModal'
import { ObjectiveSearchPanel } from './ObjectiveSearchPanel'
import { SessionViewer } from './SessionViewer'
import { api } from '../lib/api'
// Lazy: the planning overlay pulls in the heavy BlockNote editor (via
// FileEditorOverlay) and only mounts when an objective is opened for planning —
// keeping it out of the board chunk shrinks the initial bundle (obj 700585).
const PlanningPanel = lazy(() => import('./PlanningPanel').then(m => ({ default: m.PlanningPanel })))
import { ConnectionPulse, StatusDot } from './design/primitives'
import { Skeleton, useConfirm } from './ui'
import './board.css'

interface KanbanBoardProps {
  /** Selected workspace slugs. Empty means All Workspaces. */
  workspaces: Workspace[]
}

export function KanbanBoard({ workspaces }: KanbanBoardProps) {
  const {
    objectives, loading, error, changeStatus, createObjective, updateObjective,
    deleteObjective, connectionState,
    doneObjectives, doneLoading, doneLoaded, doneHasMore, loadMoreDone,
    cancelledObjectives, cancelledLoading, cancelledLoaded, cancelledHasMore, loadMoreCancelled,
  } = useObjectives(workspaces)

  // Create-modal / search still take a single workspace. Multi-select and All
  // collapse to 'all' so the modal falls back to its own default.
  const workspace: Workspace = workspaces.length === 1 ? workspaces[0] : 'all'
  const wsKey = workspaces.slice().sort().join(',')

  // Column-visibility toggles (obj 700872). Done + Retired (cancelled) are HIDDEN
  // by default and each revealed by its own independent, persisted toggle. Read
  // the stored prefs on mount (default OFF when nothing is stored); a bad/blocked
  // localStorage read falls back to OFF rather than throwing.
  const [showDone, setShowDone] = useState<boolean>(() => {
    try { return localStorage.getItem('cc.board.showDone') === '1' } catch { return false }
  })
  const [showRetired, setShowRetired] = useState<boolean>(() => {
    try { return localStorage.getItem('cc.board.showRetired') === '1' } catch { return false }
  })
  useEffect(() => {
    try { localStorage.setItem('cc.board.showDone', showDone ? '1' : '0') } catch { /* ignore */ }
  }, [showDone])
  useEffect(() => {
    try { localStorage.setItem('cc.board.showRetired', showRetired ? '1' : '0') } catch { /* ignore */ }
  }, [showRetired])

  // Lazy fetch each terminal column ONLY when first revealed — never on board
  // load. The `!doneLoaded`/`!cancelledLoaded` guard makes this fire exactly once
  // per column per workspace (the hook resets loaded=false on workspace change);
  // the `!loading` guard avoids a double-fetch in flight.
  useEffect(() => {
    if (showDone && !doneLoaded && !doneLoading) loadMoreDone()
  }, [showDone, doneLoaded, doneLoading, loadMoreDone])
  useEffect(() => {
    if (showRetired && !cancelledLoaded && !cancelledLoading) loadMoreCancelled()
  }, [showRetired, cancelledLoaded, cancelledLoading, loadMoreCancelled])

  const [modalOpen, setModalOpen] = useState(false)
  const [editingObjective, setEditingObjective] = useState<Objective | null>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [sessionObjective, setSessionObjective] = useState<Objective | null>(null)
  const [planningObjective, setPlanningObjective] = useState<Objective | null>(null)
  const [statusError, setStatusError] = useState<string | null>(null)
  const { user } = useAuth()

  // Multi-select assignee filter (obj 700857). Tokens = usernames + the
  // UNASSIGNED sentinel. Persisted per workspace in localStorage so the default
  // (Unassigned + current user) only applies on first use; init lazily from the
  // stored pref so the board doesn't flash the default before the effect runs.
  const [assigneeSel, setAssigneeSel] = useState<string[]>(
    () => loadAssigneeSelection(wsKey || 'all') ?? defaultAssigneeSelection(user?.username)
  )
  // Re-derive when the workspace selection changes (per-ws pref) or once the
  // current user resolves (auth loads after first paint): apply the stored pref
  // if any, else fall back to the default. Never clobbers an in-session toggle
  // because those are persisted immediately, so the stored branch wins on re-run.
  useEffect(() => {
    setAssigneeSel(loadAssigneeSelection(wsKey || 'all') ?? defaultAssigneeSelection(user?.username))
  }, [wsKey, user?.username])

  const selectedAssignees = useMemo(() => new Set(assigneeSel), [assigneeSel])

  // ── Project (org subfolder) filter — obj 708826 ──────────────────────────
  // Projects belong to exactly one organization, so the picker only has meaning
  // in a single-org view; All/multi-select shows no projects and the filter is
  // inert ('all'). Selection is persisted PER workspace key, which is also what
  // makes it reset when the organization changes: the new org reads its own
  // (usually empty) slot and falls back to All projects.
  const projectWorkspace = workspaces.length === 1 ? workspaces[0] : null
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
  // A stored id can outlive its project (deleted in another tab, or the org has
  // no such project) — fall back to All rather than showing an empty board with
  // no visible cause.
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
  // Id of the objective whose status PATCH is in flight — drives per-card
  // button loading/disabled so a second click can't double-submit (OK-7).
  const [pendingStatusId, setPendingStatusId] = useState<number | null>(null)
  const { confirm, confirmDialog } = useConfirm()

  // Child nesting: any objective with a parent_id whose parent is ALSO on the
  // board is pulled OUT of the columns and rendered inside its parent's card
  // (WorkerRollup) instead of floating as its own top-level card.
  const { childrenByParent, topLevel } = useMemo(() => {
    // Bulletproof scope gate (obj 700082). The board must NEVER render an
    // objective outside the active workspace, no matter how it got into state:
    // a WebSocket reconnect race (frequent on mobile — backgrounding / network
    // switches reopen the socket before the server re-applies view-scope), an
    // error-recovery refetch, or the PREVIOUS workspace's objectives still
    // sitting in state during the gap between a workspace switch and the new
    // fetch resolving (very visible on slow mobile connections). Filtering here
    // — the single point where objectives become columns — makes the board
    // immune to all of them and is race-free: it re-derives the instant the
    // `workspace` prop changes, before any network round-trip. The useObjectives
    // and server WS guards are defense-in-depth behind this authoritative gate.
    const grouped = groupObjectives(scopeObjectives(objectives, workspaces))
    // Exclude jobs (routine-spawned objectives) — they live on the Jobs board.
    return {
      childrenByParent: grouped.childrenByParent,
      topLevel: grouped.topLevel.filter(o => o.routine_id == null),
    }
  }, [objectives, wsKey, workspaces])

  // Assignee options: every distinct assignee present in this workspace's
  // objectives (derived, not hardcoded — arbitrary future users appear
  // automatically), plus the current user so the default is actionable even
  // before they own anything.
  const assigneeOptions = useMemo(() => {
    const roster = assigneeRoster(topLevel)
    if (user?.username && !roster.includes(user.username)) {
      roster.push(user.username)
      roster.sort((a, b) => a.localeCompare(b))
    }
    return roster
  }, [topLevel, user?.username])

  // Assignee (multi-select) filter. The category filter tabs were removed with
  // the create-form simplification (obj 708817) — category is no longer a human
  // input, so every new objective carries the server default and the tabs had
  // nothing left to discriminate on.
  const filtered = useMemo(() => {
    return topLevel.filter(o =>
      matchesAssigneeFilter(o, selectedAssignees) && matchesProjectFilter(o, projectSel)
    )
  }, [topLevel, selectedAssignees, projectSel])

  const grouped = useMemo(() => {
    const map: Record<ObjectiveStatus, Objective[]> = {
      planning: [], queue: [], working: [], ai_review: [], review: [], done: [], cancelled: [],
    }
    for (const obj of filtered) {
      const col = boardColumnOf(obj, childrenByParent.get(obj.id))
      map[col]?.push(obj)
    }
    return map
  }, [filtered, childrenByParent])

  // Done column (obj 700512) — the active list EXCLUDES done, so `grouped.done`
  // holds only cards that transitioned to done live (via WS) while the board was
  // open. Merge those ahead of the lazily-fetched done backlog, deduped by id, so
  // a just-completed card shows immediately without waiting for a refetch and
  // never double-renders against the paginated fetch.
  const doneColumn = useMemo(() => {
    const merged = [...grouped.done]
    const seen = new Set(merged.map(o => o.id))
    for (const o of doneObjectives) {
      // The lazily-fetched backlog bypasses `filtered`, so the project gate is
      // re-applied here — otherwise opening a project folder would still show
      // every organization-wide Done card.
      if (!seen.has(o.id) && matchesProjectFilter(o, projectSel)) { merged.push(o); seen.add(o.id) }
    }
    return merged
  }, [grouped.done, doneObjectives, projectSel])

  // Retired column (obj 700872) — identical merge to Done: cards that transitioned
  // to cancelled live (via WS) while the board was open sit in `grouped.cancelled`
  // and merge ahead of the lazily-fetched cancelled backlog, deduped by id, so a
  // just-retired card shows immediately and never double-renders.
  const cancelledColumn = useMemo(() => {
    const merged = [...grouped.cancelled]
    const seen = new Set(merged.map(o => o.id))
    for (const o of cancelledObjectives) {
      // Same project gate as the Done merge above — the paginated backlog never
      // passed through `filtered`.
      if (!seen.has(o.id) && matchesProjectFilter(o, projectSel)) { merged.push(o); seen.add(o.id) }
    }
    return merged
  }, [grouped.cancelled, cancelledObjectives, projectSel])

  const isMobile = useIsBoardMobile()

  // Column visibility (obj 700872). Default board = Queue, Working, Review (always
  // shown; Review is now a PERMANENT column) plus planning/ai_review ONLY when
  // non-empty (unchanged transient behavior). `done` and `cancelled` are no longer
  // in the always/optional-visible sets — each is gated STRICTLY behind its own
  // persisted toggle (showDone / showRetired) and mounts on the right when on.
  // Mobile stacks vertically so Needs You is first (then Working, Queue, Done,
  // Retired) — desktop keeps pipeline left-to-right.
  const visibleColumns = useMemo(() => {
    const transient: ObjectiveStatus[] = ['planning', 'ai_review']
    const cols = OBJECTIVE_STATUSES.filter(s => {
      if (s === 'done') return showDone
      if (s === 'cancelled') return showRetired
      if (transient.includes(s)) return grouped[s].length > 0
      return true // queue, working, review — permanent
    })
    return orderBoardColumns(cols, isMobile)
  }, [grouped, showDone, showRetired, isMobile])

  // What needs me. `review` is the human gate — including a delegator parked
  // in review (fireWake will not auto-wake it).
  const needsYouCount = useMemo(
    () => grouped.review.length,
    [grouped.review]
  )
  const blockedCount = useMemo(
    () => topLevel.filter(o => !!o.has_blockers && !o.session_id).length,
    [topLevel]
  )
  // Live sessions — objectives actively running a Claude session right now.
  const liveCount = useMemo(
    () => topLevel.filter(o =>
      (o.status === 'working' || o.status === 'review' || o.status === 'ai_review') && o.session_id !== null
    ).length,
    [topLevel]
  )

  const handleChangeStatus = useCallback(
    async (id: number, status: ObjectiveStatus) => {
      if (status === 'done') {
        const obj = objectives.find(o => o.id === id)
        if (obj && Number(obj.session_count) === 0 && !(await confirm({
          title: 'Mark as done anyway?',
          message: 'This objective has never been worked on (0 sessions).',
          confirmLabel: 'Mark Done',
        }))) return
      }
      try {
        setStatusError(null)
        setPendingStatusId(id)
        await changeStatus(id, status)
      } catch (err) {
        setStatusError(err instanceof Error ? err.message : 'Status change failed')
        setTimeout(() => setStatusError(null), 4000)
      } finally {
        setPendingStatusId(null)
      }
    },
    [changeStatus, objectives, confirm]
  )

  const handleOpenTerminal = useCallback((objective: Objective) => {
    if (objective.status === 'planning') {
      setPlanningObjective(objective)
      return
    }
    setSessionObjective(objective)
  }, [])

  const handleCardEdit = useCallback((objective: Objective) => {
    setEditingObjective(objective)
    setModalOpen(true)
  }, [])

  const handleNewObjective = useCallback(() => {
    setEditingObjective(null)
    setModalOpen(true)
  }, [])

  // Stable identity so Modal's focus/scroll-lock effect doesn't thrash on every
  // board re-render (the state-poller re-renders us every ~3s per live session).
  const handleModalClose = useCallback(() => {
    setModalOpen(false)
    setEditingObjective(null)
  }, [])

  // Open an objective from a search result. Search rows are slim, and the board
  // LIST omits fields the modal needs (description is hydrated by the modal, but
  // agent_context/project/flags come from the passed object), so fetch the FULL
  // objective before opening — this also lets DONE objectives in any scope be
  // reopened from search, not just the ones currently loaded on the board.
  const openObjectiveById = useCallback(async (id: number) => {
    setSearchOpen(false)
    try {
      const full = await api.get<Objective>(`/objectives/${id}`)
      setEditingObjective(full)
      setModalOpen(true)
    } catch {
      setStatusError('Could not open that objective')
    }
  }, [])

  // Reopen a terminal-state objective from the modal (e.g. a DONE objective
  // opened via search). Target 'working' — matches the card's Re-Open and the
  // authoritative type-aware rules (TRANSITIONS_BY_TYPE: done -> ['working'] for
  // every type; done -> 'queue' is rejected for task/bug/project). Close after.
  const handleReopen = useCallback((id: number) => {
    handleChangeStatus(id, 'working')
    handleModalClose()
  }, [handleChangeStatus, handleModalClose])

  // "/" opens objective search (unless typing in a field); Esc is handled by the
  // panel itself. Kept off ⌘K, which Layout owns for the nav palette.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return
      const el = e.target as HTMLElement | null
      const tag = el?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || el?.isContentEditable) return
      e.preventDefault()
      setSearchOpen(true)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  if (loading) {
    // Skeleton scaffold mirroring the real board geometry so the grid doesn't
    // pop in / shift when data lands (OK-6). Three anchor columns, a few
    // placeholder cards each.
    const SKELETON_COLS: { label: string; status: ObjectiveStatus }[] = [
      { label: 'Queue', status: 'queue' },
      { label: 'Working', status: 'working' },
      { label: 'Needs You', status: 'review' },
    ]
    return (
      <div className="flex h-full flex-col bg-surface-0">
        <div className="ok-board" style={{ ['--ok-cols' as string]: SKELETON_COLS.length }} aria-busy="true">
          {SKELETON_COLS.map(({ label, status }, ci) => (
            <section key={status} className="ok-col" data-status={status}>
              <div className="ok-colhead">
                <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-fg-3">{label}</span>
              </div>
              <div className="ok-cards">
                {Array.from({ length: 3 - ci }).map((_, i) => (
                  <div
                    key={i}
                    className="flex gap-2.5 rounded-md border border-line bg-surface-2 p-[11px]"
                  >
                    <Skeleton className="h-[26px] w-[26px] flex-shrink-0 rounded-sm" />
                    <div className="min-w-0 flex-1">
                      <Skeleton className="h-[13px] w-3/4" />
                      <Skeleton className="mt-[9px] h-3 w-full" />
                      <Skeleton className="mt-[9px] h-[11px] w-2/5" />
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col bg-surface-0">
      {/* ── Status strip — operator chips + filter tabs + New ── */}
      <div className="flex items-center gap-3 overflow-x-auto border-b border-line-soft bg-surface-0 px-4 py-2.5 sm:px-5">
        {/* Chips */}
        <div className="flex shrink-0 items-center gap-3.5 text-[12.5px]">
          {needsYouCount > 0 && (
            <span className="inline-flex items-center gap-1.5 text-[color:var(--accent-hover)]">
              <span aria-hidden="true" className="text-[15px] leading-none">›</span>
              <span className="font-mono font-semibold">{needsYouCount}</span>
              <span className="text-fg-1">need your review</span>
            </span>
          )}
          {blockedCount > 0 && (
            <span className="inline-flex items-center gap-1.5 text-fg-1">
              <span className="ok-dot" style={{ ['--c' as string]: 'var(--ok-alarm)' }} aria-hidden="true" />
              <span className="font-mono font-semibold text-fg-0">{blockedCount}</span>
              blocked
            </span>
          )}
          {liveCount > 0 && (
            <span className="inline-flex items-center gap-1.5 text-fg-1">
              <span className="ok-dot live" style={{ ['--c' as string]: 'var(--ok-verify)' }} aria-hidden="true" />
              <span className="font-mono font-semibold text-fg-0">{liveCount}</span>
              live {liveCount === 1 ? 'session' : 'sessions'}
            </span>
          )}
        </div>

        <div className="ml-auto" />

        {/* Column-visibility toggles (obj 700872) — reveal the hidden terminal
            columns. Each is an independent, persisted toggle; the leading dot uses
            the column's own status color so the control reads as "show this
            column". aria-pressed drives the on/off surface + AT semantics. */}
        <div className="flex shrink-0 items-center gap-0.5 border-l border-line-soft pl-2">
          {([
            { key: 'done' as ObjectiveStatus, on: showDone, toggle: () => setShowDone(v => !v), label: 'Done' },
            { key: 'cancelled' as ObjectiveStatus, on: showRetired, toggle: () => setShowRetired(v => !v), label: 'Retired' },
          ]).map(t => (
            <button
              key={t.key}
              onClick={t.toggle}
              aria-pressed={t.on}
              title={t.on ? `Hide ${t.label} column` : `Show ${t.label} column`}
              className={`inline-flex items-center gap-1.5 rounded-sm px-2.5 py-1.5 text-[12.5px] transition-colors duration-fast ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 min-h-[36px] ${
                t.on ? 'bg-surface-2 text-fg-0' : 'text-fg-2 hover:text-fg-1'
              }`}
            >
              <StatusDot status={t.key} size={7} />
              <span className="whitespace-nowrap">{t.label}</span>
            </button>
          ))}
        </div>

        {/* Connection + Search + New */}
        <div className="flex shrink-0 items-center gap-3 pl-1">
          <button
            onClick={() => setSearchOpen(true)}
            aria-label="Search objectives"
            title="Search objectives (all stages) — press /"
            className="inline-flex items-center gap-1.5 rounded-md border border-line bg-surface-2 px-2.5 py-1.5 text-sm text-fg-2 transition-colors duration-fast ease-out hover:border-line-strong hover:text-fg-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 min-h-[36px]"
          >
            <Search className="h-4 w-4" />
            <span className="hidden md:inline">Search</span>
            <span className="hidden font-mono text-[10.5px] text-fg-3 md:inline">/</span>
          </button>
          <ConnectionPulse
            state={connectionState}
            label={connectionState === 'connected' ? 'Connected'
                 : connectionState === 'reconnecting' ? 'Reconnecting…'
                 : 'Disconnected'}
          />
          <button
            onClick={handleNewObjective}
            className="inline-flex items-center gap-1 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg transition-colors duration-fast ease-out hover:bg-accent-hover active:bg-accent-press min-h-[36px]"
          >
            <Plus className="h-4 w-4" />
            <span>New</span>
          </button>
        </div>
      </div>

      {/* ── Project filter — org subfolders (obj 708826). Only meaningful in a
          single-organization view; hidden for All / multi-select, where a
          project (which belongs to one org) has nothing to scope. ── */}
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

      {/* ── Assignee filter — multi-select toggle chips (obj 700857) ── */}
      <div className="flex items-center gap-2 overflow-x-auto border-b border-line-soft bg-surface-0 px-4 py-2 sm:px-5">
        <span className="shrink-0 font-mono text-[11px] uppercase tracking-[0.12em] text-fg-3">Assignee</span>
        <div className="flex shrink-0 items-center gap-1">
          {[{ token: UNASSIGNED_TOKEN, label: 'Unassigned' }, ...assigneeOptions.map(u => ({ token: u, label: u }))].map(opt => {
            const active = selectedAssignees.has(opt.token)
            return (
              <button
                key={opt.token}
                onClick={() => toggleAssignee(opt.token)}
                aria-pressed={active}
                className={`whitespace-nowrap rounded-full border px-2.5 py-1 text-[12px] transition-colors duration-fast ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 ${
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

      {(error || statusError) && (
        <div className="border-b border-line-soft bg-surface-0 px-4 py-1.5 sm:px-5">
          <span className="rounded-md border border-line bg-surface-1 px-3 py-1 text-xs text-[color:var(--ok-alarm)]">
            {error || statusError}
          </span>
        </div>
      )}

      {/* ── Board — hairline grid; single stack on mobile ── */}
      <div className="ok-board" style={{ ['--ok-cols' as string]: visibleColumns.length }}>
        {visibleColumns.map(status => (
          <KanbanColumn
            key={status}
            status={status}
            objectives={status === 'done' ? doneColumn : status === 'cancelled' ? cancelledColumn : grouped[status]}
            onOpenTerminal={handleOpenTerminal}
            onCardEdit={handleCardEdit}
            onChangeStatus={handleChangeStatus}
            pendingId={pendingStatusId}
            childrenByParent={childrenByParent}
            {...(status === 'done' ? {
              lazyLoaded: doneLoaded,
              lazyLoading: doneLoading,
              lazyHasMore: doneHasMore,
              onLoadMore: loadMoreDone,
            } : status === 'cancelled' ? {
              lazyLoaded: cancelledLoaded,
              lazyLoading: cancelledLoading,
              lazyHasMore: cancelledHasMore,
              onLoadMore: loadMoreCancelled,
            } : {})}
          />
        ))}
      </div>

      {/* ── Mobile FAB — the New-objective entry point on small screens, where
          the status-strip button scrolls off the right edge. Sits above the
          fixed bottom tab bar (3.5rem) + safe-area inset. Desktop unaffected. ── */}
      <button
        onClick={handleNewObjective}
        aria-label="New objective"
        className="fixed right-4 z-30 flex h-14 w-14 items-center justify-center rounded-full bg-accent text-accent-fg shadow-float transition-[transform,background-color] duration-fast ease-out hover:bg-accent-hover hover:scale-105 active:bg-accent-press active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:ring-offset-2 focus-visible:ring-offset-surface-0 sm:hidden"
        style={{ bottom: 'calc(3.5rem + env(safe-area-inset-bottom) + 1rem)' }}
      >
        <Plus className="h-6 w-6" />
      </button>

      <ObjectiveSearchPanel
        open={searchOpen}
        workspace={workspace}
        onClose={() => setSearchOpen(false)}
        onSelect={openObjectiveById}
      />

      {modalOpen && (
        <ObjectiveModal
          objective={editingObjective}
          workspace={workspace}
          defaultProjectId={typeof projectSel === 'number' ? projectSel : null}
          onClose={handleModalClose}
          onCreate={createObjectiveInProject}
          onUpdate={updateObjectiveInProject}
          onDelete={deleteObjective}
          onReopen={handleReopen}
        />
      )}

      {sessionObjective && (
        <SessionViewer
          objective={sessionObjective}
          onClose={() => setSessionObjective(null)}
          onChangeStatus={handleChangeStatus}
        />
      )}

      {planningObjective && (
        <Suspense fallback={null}>
          <PlanningPanel
            objective={planningObjective}
            onClose={() => setPlanningObjective(null)}
            onApproved={() => setPlanningObjective(null)}
          />
        </Suspense>
      )}

      {confirmDialog}
    </div>
  )
}
