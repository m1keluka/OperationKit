import { useState, useCallback, useMemo, useEffect } from 'react'
import { useBranding } from '../hooks/useBranding'
import { ExternalLink, AlertCircle, Clock, Play, Pause, Inbox, CheckCircle2, Loader2, Target, Plus, Workflow, History } from 'lucide-react'
import type { Objective, ObjectiveStatus, Workspace } from '@operationkit/shared'
import { useObjectives } from '../hooks/useObjectives'
import { useRoutines, isAutoPaused, type RoutineSummary, type StrategyOption, type StrategyJobInput } from '../hooks/useRoutines'
import { RoutineAutoPauseBanner } from './RoutineAutoPauseBanner'
import { HostCronJobs } from './jobs/HostCronJobs'
import { QueueAutostartPanel } from './settings/QueueAutostartPanel'
import { useAuth } from '../context/AuthContext'
import { ExecutionsPanel, type ExecutionsTarget } from './jobs/ExecutionsPanel'
import { WorkflowsPanel, RunStatusBadge } from './jobs/WorkflowsPanel'
import { useFlows } from '../hooks/useFlows'
import { flowRunLane } from '../../../shared/flow/run-status'
import type { FlowRunSummary } from '../../../shared/flow/api'
import { HOST_CRON_ANCHOR } from '../lib/routes'
import { useWorkspaces } from '../hooks/useWorkspaces'
import { SessionViewer } from './SessionViewer'
import { relativeTime, relativeFuture } from '../lib/time'
import {
  PageContainer,
  PageHeader,
  Toolbar,
  Tabs,
  Badge,
  Button,
  StatusPill,
  DataTable,
  Alert,
  Modal,
  cn,
  type Column,
  type TabItem,
  type PipelineStatus,
} from './ui'

// Form field tokens (mirrors ConfigPage's input/select styling).
const fieldCls =
  'w-full min-w-0 rounded-md border border-line bg-surface-1 px-3 py-2 text-[13px] text-fg-0 ' +
  'placeholder-fg-3 transition-colors focus:border-accent focus:outline-none'
const selectCls =
  'w-full rounded-md border border-line bg-surface-1 px-2.5 py-2 text-[13px] text-fg-0 focus:border-accent focus:outline-none'
const labelCls = 'block text-[12px] font-medium uppercase tracking-[0.08em] text-fg-3 mb-1'

interface JobsBoardProps {
  workspace: Workspace
}

// Jobs lanes are derived from objective status + the orthogonal job_disposition.
// A "job" is a routine-spawned objective (routine_id != null).
type JobLane = 'running' | 'needs_review' | 'complete'

const LANE_META: Record<JobLane, { label: string; hint: string; icon: typeof Loader2 }> = {
  running:      { label: 'Running',      hint: 'Automated runs in flight',                                  icon: Loader2 },
  needs_review: { label: 'Needs Review', hint: 'Has a question or a system-improvement opportunity',        icon: AlertCircle },
  complete:     { label: 'Complete',     hint: 'Clean runs, nothing for you to do',                         icon: CheckCircle2 },
}
const LANE_ORDER: JobLane[] = ['running', 'needs_review', 'complete']

const ALL = 'all'

// obj 900640 (B4) — Jobs = agent jobs ∪ workflow runs (docs/design/WORKFLOWS.md §7.1).
// `view` switches the page between the Workflows tab (flow charts) and the Runs lanes;
// `kind` filters routines and lanes. Both live in the query string (?view=runs,
// ?view=workflows&flow=12, ?kind=flow) so a workflow's home card can deep-link
// straight to its diagram.
// obj 900675: the page is "Workflows" in the main nav and opens on the flow-chart
// view. The lanes moved to the "Runs" tab (?view=runs; the old ?view=jobs still
// works). A lane-only deep link (?kind=…, #host-cron) still lands on the lanes.
type JobsView = 'runs' | 'workflows'
type KindFilter = 'all' | 'agent' | 'flow'
const VIEW_TABS: TabItem[] = [
  { key: 'workflows', label: 'Workflows' },
  { key: 'runs', label: 'Runs' },
]

export function readQuery(): { view: JobsView; kind: KindFilter; flow: number | null } {
  const q = new URLSearchParams(typeof window === 'undefined' ? '' : window.location.search)
  const hash = typeof window === 'undefined' ? '' : window.location.hash
  const flow = Number(q.get('flow'))
  const kind: KindFilter = q.get('kind') === 'flow' ? 'flow' : q.get('kind') === 'agent' ? 'agent' : 'all'
  const v = q.get('view')
  const view: JobsView =
    v === 'workflows' ? 'workflows'
    : v === 'runs' || v === 'jobs' ? 'runs'
    : q.has('kind') || hash === '#' + HOST_CRON_ANCHOR ? 'runs'
    : 'workflows'
  return { view, kind, flow: Number.isInteger(flow) && flow > 0 ? flow : null }
}

function writeQuery(next: { view: JobsView; kind: KindFilter; flow: number | null }): void {
  if (typeof window === 'undefined') return
  const q = new URLSearchParams(window.location.search)
  const set = (k: string, v: string | null) => (v ? q.set(k, v) : q.delete(k))
  set('view', next.view === 'runs' ? 'runs' : null)
  set('kind', next.kind === 'all' ? null : next.kind)
  set('flow', next.view === 'workflows' && next.flow != null ? String(next.flow) : null)
  const qs = q.toString()
  window.history.replaceState(window.history.state, '', `${window.location.pathname}${qs ? `?${qs}` : ''}${window.location.hash}`)
}

/** Compact USD formatter for job cost (sub-cent runs round to $0.00). */
function formatCost(n: number): string {
  return `$${(Number(n) || 0).toFixed(2)}`
}

/** Map an ObjectiveStatus onto the canonical pipeline StatusPill status. */
function pipelineStatus(s: ObjectiveStatus): PipelineStatus {
  return s === 'ai_review' ? 'ai' : (s as PipelineStatus)
}

export function laneOf(o: Pick<Objective, 'status' | 'job_disposition'>): JobLane {
  if (o.status !== 'done') return 'running'
  return o.job_disposition === 'needs_review' ? 'needs_review' : 'complete'
}

export function JobsBoard(_props: JobsBoardProps) {
  const brandName = useBranding().name
  // Jobs are workspace-agnostic automated runs; show them all regardless of the
  // board's workspace selector (admin-only surface). useObjectives('all') still
  // wires the same WebSocket live-update path the main board uses.
  // NOTE (obj 700082): the `scopeObjectives` render gate is INTENTIONALLY omitted
  // here — this surface is cross-workspace by design and filters via its own
  // `wsFilter` dropdown below. Do NOT add the gate; it would hide valid jobs.
  const { objectives, loading, error, changeStatus, connectionState } = useObjectives('all')
  const { routines, routinesEnabled, strategies, runNow, createStrategyJob, resume } = useRoutines()
  const { labelOf, workspaces } = useWorkspaces()
  const { flows, runs: flowRuns, flowsEnabled, loading: flowsLoading, runNow: runFlowNow, refresh: refreshFlows } = useFlows()
  const initialQuery = useMemo(readQuery, [])
  const [view, setView] = useState<JobsView>(initialQuery.view)
  const [kindFilter, setKindFilter] = useState<KindFilter>(initialQuery.kind)
  const [selectedFlow, setSelectedFlow] = useState<number | null>(initialQuery.flow)
  useEffect(() => { writeQuery({ view, kind: kindFilter, flow: selectedFlow }) }, [view, kindFilter, selectedFlow])

  const [sessionObjective, setSessionObjective] = useState<Objective | null>(null)
  const [wsFilter, setWsFilter] = useState<string>(ALL)
  const [authoring, setAuthoring] = useState(false)
  const isAdmin = useAuth().user?.role === 'admin'
  // obj 900676 — the n8n-style Executions view (run list + the selected run's log).
  const [executions, setExecutions] = useState<ExecutionsTarget | null>(null)

  // /settings/platform redirects to /jobs#host-cron (obj 900495): land on that section.
  useEffect(() => {
    if (window.location.hash !== '#' + HOST_CRON_ANCHOR) return
    const t = setTimeout(() => document.getElementById(HOST_CRON_ANCHOR)?.scrollIntoView({ block: 'start' }), 50)
    return () => clearTimeout(t)
  }, [])

  // jobs = routine-spawned objectives. Newest run first within each lane.
  const allJobs = useMemo(
    () => objectives.filter(o => o.routine_id != null).sort((a, b) => b.id - a.id),
    [objectives]
  )

  // Workspace filter options: the union of workspaces present across scheduled
  // routines AND past job runs — so e.g. a example3 job/routine shows up
  // without any hardcoded list (workspaces are created dynamically).
  const wsOptions = useMemo(() => {
    const set = new Set<string>()
    for (const r of routines) set.add(r.workspace)
    for (const j of allJobs) if (j.workspace) set.add(j.workspace)
    for (const f of flows) set.add(f.workspace)
    return Array.from(set).sort()
  }, [routines, allJobs, flows])

  const jobs = useMemo(
    () => (kindFilter === 'flow' ? [] : wsFilter === ALL ? allJobs : allJobs.filter(j => j.workspace === wsFilter)),
    [allJobs, wsFilter, kindFilter]
  )
  const visibleRoutines = useMemo(
    () => routines
      .filter(r => wsFilter === ALL || r.workspace === wsFilter)
      .filter(r => kindFilter === 'all' || (kindFilter === 'flow') === (r.kind === 'flow')),
    [routines, wsFilter, kindFilter]
  )
  // Auto-pause banner: every auto-paused routine of the workspace, whatever the kind filter.
  const bannerRoutines = useMemo(
    () => (wsFilter === ALL ? routines : routines.filter(r => r.workspace === wsFilter)),
    [routines, wsFilter]
  )
  const visibleFlows = useMemo(
    () => (wsFilter === ALL ? flows : flows.filter(f => f.workspace === wsFilter)),
    [flows, wsFilter]
  )
  const visibleFlowRuns = useMemo(
    () => (kindFilter === 'agent' ? [] : wsFilter === ALL ? flowRuns : flowRuns.filter(r => r.workspace === wsFilter)),
    [flowRuns, wsFilter, kindFilter]
  )
  const flowLanes = useMemo(() => {
    const map: Record<JobLane, FlowRunSummary[]> = { running: [], needs_review: [], complete: [] }
    for (const r of visibleFlowRuns) map[flowRunLane(r)].push(r)
    return map
  }, [visibleFlowRuns])
  const openFlow = useCallback((flowId: number) => {
    setSelectedFlow(flowId)
    setView('workflows')
  }, [])

  // obj 900676 — clicking a routine, a job run or a workflow run opens its executions.
  const openRoutineRuns = useCallback((r: RoutineSummary) => {
    setExecutions({ type: 'routine', routineId: r.id, title: r.title })
  }, [])
  const openJobRun = useCallback((job: Objective) => {
    if (job.routine_id == null) { setSessionObjective(job); return }
    const routine = routines.find(r => r.id === job.routine_id)
    setExecutions({ type: 'routine', routineId: job.routine_id, title: routine?.title ?? job.title, focus: { objectiveId: job.id } })
  }, [routines])
  const openFlowRun = useCallback((run: FlowRunSummary) => {
    setExecutions({ type: 'flow', flowId: run.flow_id, title: run.flow_name, focus: { flowRunId: run.id } })
  }, [])
  const openSessionById = useCallback(async (id: number) => {
    const known = objectives.find(o => o.id === id)
    if (known) { setSessionObjective(known); return }
    try {
      const r = await fetch(`/api/objectives/${id}`, { credentials: 'include' })
      if (r.ok) setSessionObjective((await r.json()) as Objective)
    } catch { /* the executions view stays open */ }
  }, [objectives])

  // Backlinks: objectives any job spawned via an in-thread handoff.
  const spawnedByJob = useMemo(() => {
    const map = new Map<number, Objective[]>()
    for (const o of objectives) {
      if (o.source_job_id == null) continue
      const arr = map.get(o.source_job_id) || []
      arr.push(o)
      map.set(o.source_job_id, arr)
    }
    return map
  }, [objectives])

  const lanes = useMemo(() => {
    const map: Record<JobLane, Objective[]> = { running: [], needs_review: [], complete: [] }
    for (const j of jobs) map[laneOf(j)].push(j)
    return map
  }, [jobs])

  const handleChangeStatus = useCallback(
    async (id: number, status: ObjectiveStatus) => {
      try {
        await changeStatus(id, status)
      } catch {
        /* surfaced via the hook's error state */
      }
    },
    [changeStatus]
  )

  // Workspace filter as Tabs (chips collapsed onto the accent token system —
  // no per-workspace color sprawl).
  const wsTabs: TabItem[] = useMemo(
    () => [
      { key: ALL, label: 'All', count: allJobs.length + flowRuns.length },
      ...wsOptions.map(ws => ({
        key: ws,
        label: labelOf(ws),
        count: allJobs.filter(j => j.workspace === ws).length + flowRuns.filter(r => r.workspace === ws).length,
      })),
    ],
    [wsOptions, allJobs, flowRuns, labelOf]
  )
  const kindTabs: TabItem[] = useMemo(
    () => [
      { key: 'all', label: 'All' },
      { key: 'agent', label: 'Agent jobs' },
      { key: 'flow', label: 'Workflows' },
    ],
    []
  )

  const enabledCount = visibleRoutines.filter(r => r.enabled).length

  // ── Routines table — routines are the global DataTable. ──
  const routineColumns: Column<RoutineSummary>[] = [
    {
      key: 'title',
      header: 'Routine',
      cell: r => (
        <div className="flex items-center gap-2">
          <span
            className={cn(
              'inline-flex h-1.5 w-1.5 shrink-0 rounded-full',
              r.enabled ? 'bg-status-working' : 'bg-fg-3',
            )}
            aria-label={r.enabled ? 'enabled' : 'disabled'}
          />
          <span className="truncate font-medium text-fg-0" title={r.title}>{r.title}</span>
          {r.kind === 'flow' && r.flow_id != null && (
            <button
              type="button"
              className="shrink-0 text-[12px] text-accent-hover hover:underline"
              onClick={e => { e.stopPropagation(); openFlow(r.flow_id as number) }}
            >
              diagram
            </button>
          )}
        </div>
      ),
    },
    {
      key: 'workspace',
      header: 'Organization',
      cell: r => <Badge tone="neutral">{labelOf(r.workspace)}</Badge>,
    },
    {
      key: 'strategy',
      header: 'Owner',
      cell: r =>
        r.strategy_title ? (
          <span className="inline-flex items-center gap-1 text-[12px] text-accent-hover" title={`Owned by strategy #${r.strategy_objective_id}`}>
            <Target className="h-3 w-3 shrink-0" strokeWidth={1.75} />
            <span className="truncate max-w-[160px]">{r.strategy_title}</span>
          </span>
        ) : (
          <span className="text-fg-3">Standalone</span>
        ),
    },
    {
      // obj 64 Part B — script kind, last script result, failure streak, auto-pause.
      key: 'health',
      header: 'Health',
      cell: r => <RoutineHealthBadges routine={r} />,
    },
    {
      key: 'cadence',
      header: 'Cadence',
      mono: true,
      cell: r => r.cadence,
    },
    {
      key: 'next',
      header: 'Next in',
      mono: true,
      sortable: true,
      sortValue: r => r.next_run_at ?? '',
      cell: r =>
        r.enabled && r.next_run_at
          ? relativeFuture(r.next_run_at)
          : <span className="text-fg-3">paused</span>,
    },
    {
      key: 'last',
      header: 'Last run',
      mono: true,
      align: 'right',
      sortable: true,
      sortValue: r => r.last_run_at ?? '',
      cell: r => (r.last_run_at ? `${relativeTime(r.last_run_at)} ago` : '—'),
    },
    {
      key: 'inflight',
      header: 'In flight',
      align: 'right',
      sortable: true,
      sortValue: r => r.pending,
      cell: r =>
        r.pending > 0 ? <Badge tone="info" mono>{r.pending} in flight</Badge> : <span className="text-fg-3">—</span>,
    },
  ]

  // ── Lane table columns — shared across the three outcome lanes. ──
  const laneColumns: Column<Objective>[] = [
    {
      key: 'title',
      header: 'Run',
      cell: job => {
        const summary = job.last_session_summary?.trim()
        const spawned = spawnedByJob.get(job.id) ?? []
        return (
          <div className="min-w-0">
            <div className="truncate font-medium text-fg-0" title={job.title}>{job.title}</div>
            {job.job_disposition === 'needs_review' && job.job_review_note && (
              <div className="mt-1 rounded-md bg-signal-amber/10 px-2 py-1 text-[12px] leading-snug text-signal-amber">
                {job.job_review_note}
              </div>
            )}
            {summary && (
              <p className="mt-1 line-clamp-2 text-[12px] leading-snug text-fg-2">{summary}</p>
            )}
            {spawned.length > 0 && (
              <div className="mt-1 flex flex-col gap-0.5">
                {spawned.map(s => (
                  <span key={s.id} className="inline-flex items-center gap-1 text-[12px] text-accent-hover">
                    <ExternalLink className="h-3 w-3" strokeWidth={1.75} />
                    spawned #{s.id}: {s.title}
                  </span>
                ))}
              </div>
            )}
          </div>
        )
      },
    },
    {
      key: 'workspace',
      header: 'Organization',
      hideOnMobile: true,
      cell: job => <Badge tone="neutral">{labelOf(job.workspace)}</Badge>,
    },
    {
      key: 'status',
      header: 'Status',
      cell: job =>
        job.job_disposition === 'needs_review'
          ? <StatusPill status="human" />
          : <StatusPill status={pipelineStatus(job.status)} />,
    },
    {
      key: 'id',
      header: 'Run',
      mono: true,
      hideOnMobile: true,
      cell: job => <Badge tone="neutral" mono>#{job.id}</Badge>,
    },
    {
      key: 'created',
      header: 'Age',
      mono: true,
      align: 'right',
      sortable: true,
      sortValue: job => job.created_at,
      cell: job => relativeTime(job.created_at),
    },
    {
      key: 'cost',
      header: 'Cost',
      mono: true,
      align: 'right',
      hideOnMobile: true,
      sortable: true,
      sortValue: job => Number(job.total_cost_usd) || 0,
      cell: job => {
        const c = Number(job.total_cost_usd) || 0
        return c > 0 ? formatCost(c) : <span className="text-fg-3">—</span>
      },
    },
  ]

  // ── Workflow-run lane columns (obj 900640) — the same lanes, one row per flow run. ──
  const flowRunColumns: Column<FlowRunSummary>[] = [
    {
      key: 'title',
      header: 'Workflow run',
      cell: r => (
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <Workflow className="h-3.5 w-3.5 shrink-0 text-fg-3" strokeWidth={1.75} aria-label="workflow" />
            <span className="truncate font-medium text-fg-0" title={r.flow_name}>{r.flow_name}</span>
          </div>
          {r.error && (
            <p className="mt-1 line-clamp-2 text-[12px] leading-snug text-signal-alarm">
              {r.error.type}: {r.error.title}
            </p>
          )}
        </div>
      ),
    },
    { key: 'workspace', header: 'Organization', hideOnMobile: true, cell: r => <Badge tone="neutral">{labelOf(r.workspace)}</Badge> },
    { key: 'status', header: 'Status', cell: r => <RunStatusBadge run={r} /> },
    { key: 'id', header: 'Run', mono: true, hideOnMobile: true, cell: r => <Badge tone="neutral" mono>run #{r.id}</Badge> },
    { key: 'created', header: 'Age', mono: true, align: 'right', sortable: true, sortValue: r => r.created_at, cell: r => relativeTime(r.created_at) },
    {
      key: 'cost',
      header: 'Cost',
      mono: true,
      align: 'right',
      hideOnMobile: true,
      cell: r => (r.spent_usd > 0 ? formatCost(r.spent_usd) : <span className="text-fg-3">—</span>),
    },
  ]

  const workflowRunCount = visibleFlowRuns.length
  const needsReviewCount = lanes.needs_review.length + flowLanes.needs_review.length

  return (
    <PageContainer width="wide">
      <PageHeader
        title="Workflows"
        breadcrumbs={[{ label: brandName }, { label: 'Workflows' }]}
        description={
          `${jobs.length + workflowRunCount} automated ${jobs.length + workflowRunCount === 1 ? 'run' : 'runs'}` +
          ` · ${visibleRoutines.length} ${visibleRoutines.length === 1 ? 'routine' : 'routines'} · ${enabledCount} active` +
          ` · ${visibleFlows.length} ${visibleFlows.length === 1 ? 'workflow' : 'workflows'}`
        }
        actions={
          <div className="flex items-center gap-2">
            {needsReviewCount > 0 && (
              <Badge tone="amber">{needsReviewCount} {needsReviewCount === 1 ? 'needs' : 'need'} review</Badge>
            )}
            {!routinesEnabled && (
              <Badge tone="alarm">
                <Pause className="h-3 w-3" strokeWidth={1.75} /> scheduler paused
              </Badge>
            )}
            <Button
              variant="primary"
              size="sm"
              onClick={() => setAuthoring(true)}
              leftIcon={<Plus className="h-3.5 w-3.5" strokeWidth={2} />}
            >
              New strategy job
            </Button>
          </div>
        }
      />

      {error && (
        <Alert tone="alarm" title="Jobs feed degraded" className="mb-4">
          {error}
        </Alert>
      )}

      {/* Workflows | Runs (obj 900640; Workflows first since obj 900675) */}
      <Toolbar
        left={<Tabs items={VIEW_TABS} value={view} onChange={k => setView(k === 'runs' ? 'runs' : 'workflows')} />}
        right={view === 'runs' ? <Tabs items={kindTabs} value={kindFilter} onChange={k => setKindFilter(k as KindFilter)} /> : undefined}
      />

      {/* Workspace filter */}
      {wsOptions.length > 0 && (
        <Toolbar
          left={<Tabs items={wsTabs} value={wsFilter} onChange={setWsFilter} />}
        />
      )}

      {/* Auto-paused routines (K consecutive failures) with one-click Resume —
          agent, script and workflow routines alike. */}
      <RoutineAutoPauseBanner routines={bannerRoutines} onResume={resume} />

      {view === 'workflows' ? (
        <WorkflowsPanel
          flows={visibleFlows}
          flowsEnabled={flowsEnabled}
          loading={flowsLoading}
          labelOf={labelOf}
          selectedId={selectedFlow}
          onSelect={setSelectedFlow}
          onRunNow={runFlowNow}
          onRunLifecycle={refreshFlows}
          workspaces={workspaces.map(w => w.slug)}
          defaultWorkspace={wsFilter !== ALL ? wsFilter : null}
          onCreated={r => { void refreshFlows(); setSelectedFlow(r.flow_id) }}
          onOpenRunLog={(f, runId) => setExecutions({ type: 'flow', flowId: f.id, title: f.name, ...(runId != null ? { focus: { flowRunId: runId } } : {}) })}
        />
      ) : (<>

      {/* ── Scheduled routines — the global DataTable. ── */}
      <section className="mb-6 space-y-2">
        <h3 className="flex items-center gap-2 text-[12px] uppercase tracking-[0.12em] text-fg-3 font-semibold tracking-[0.06em]">
          <Clock className="h-3.5 w-3.5" strokeWidth={1.75} /> Scheduled routines
        </h3>
        <p className="max-w-3xl text-[12.5px] leading-snug text-fg-2">
          Recurring work the app schedules itself. An agent job opens a card for each run; a workflow run is a row in the lanes below, with no card and no session. Click a routine or a run to open its executions: every recorded run and what happened in it.
        </p>
        <DataTable
          columns={routineColumns}
          rows={visibleRoutines}
          rowKey={r => r.id}
          loading={loading}
          initialSort={{ key: 'next', dir: 'asc' }}
          mobileTitle={r => (
            <span className="font-medium text-fg-0" title={r.title}>{r.title}</span>
          )}
          onRowClick={openRoutineRuns}
          rowActions={r => (
            <div className="flex items-center gap-1" onClick={e => e.stopPropagation()}>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => openRoutineRuns(r)}
                leftIcon={<History className="h-3.5 w-3.5" strokeWidth={1.75} />}
              >
                Runs
              </Button>
              <RunNowButton routine={r} onRunNow={runNow} />
            </div>
          )}
          empty={{
            icon: <Clock className="h-5 w-5" strokeWidth={1.6} />,
            title: 'No scheduled routines',
            description: wsFilter !== ALL ? `Nothing scheduled for ${labelOf(wsFilter)}.` : 'Routines you schedule will appear here.',
          }}
        />
      </section>

      {/* ── Host cron (obj 900495; was Settings → Platform). ── */}
      {kindFilter !== 'flow' && <HostCronJobs />}

      {/* ── Queue auto-start (obj 900686; the last thing that was on Settings → Platform). Admin API. ── */}
      {kindFilter !== 'flow' && isAdmin && <QueueAutostartPanel />}

      {/* ── Outcome lanes — Running / Needs Review / Complete. ── */}
      {LANE_ORDER.map(lane => {
        const meta = LANE_META[lane]
        const Icon = meta.icon
        const rows = lanes[lane]
        const runRows = flowLanes[lane]
        return (
          <section key={lane} className="mb-6 space-y-2">
            <h3
              className={cn(
                'flex items-center gap-2 text-[12px] uppercase tracking-[0.12em] font-semibold tracking-[0.06em]',
                lane === 'needs_review' ? 'text-signal-amber' : 'text-fg-3',
              )}
            >
              <Icon className={cn('h-3.5 w-3.5', lane === 'running' && 'animate-spin')} strokeWidth={1.75} />
              {meta.label}
              <span className="font-mono text-fg-3">{rows.length + runRows.length}</span>
            </h3>
            {kindFilter !== 'flow' && (rows.length > 0 || runRows.length === 0 || loading) && (
            <DataTable
              columns={laneColumns}
              rows={rows}
              rowKey={job => job.id}
              loading={loading}
              onRowClick={openJobRun}
              mobileTitle={job => (
                <span className="font-medium text-fg-0" title={job.title}>{job.title}</span>
              )}
              rowActions={job => (
                <div className="flex items-center gap-1" onClick={e => e.stopPropagation()}>
                  <Button variant="ghost" size="sm" onClick={() => openJobRun(job)}>
                    Log
                  </Button>
                  <Button variant="secondary" size="sm" onClick={() => setSessionObjective(job)}>
                    Open
                  </Button>
                </div>
              )}
              empty={{
                icon: <Inbox className="h-5 w-5" strokeWidth={1.6} />,
                title: meta.label === 'Running' ? 'Nothing running' : `Nothing in ${meta.label}`,
                description: meta.hint,
              }}
            />
            )}
            {(kindFilter === 'flow' || runRows.length > 0) && (
              <DataTable
                columns={flowRunColumns}
                rows={runRows}
                rowKey={r => `flow-run-${r.id}`}
                loading={flowsLoading}
                onRowClick={openFlowRun}
                mobileTitle={r => <span className="font-medium text-fg-0">{r.flow_name}</span>}
                rowActions={r => (
                  <div className="flex items-center gap-1" onClick={e => e.stopPropagation()}>
                    <Button variant="ghost" size="sm" onClick={() => openFlowRun(r)}>
                      Log
                    </Button>
                    <Button variant="secondary" size="sm" onClick={() => openFlow(r.flow_id)}>
                      Diagram
                    </Button>
                  </div>
                )}
                empty={{
                  icon: <Workflow className="h-5 w-5" strokeWidth={1.6} />,
                  title: `No workflow runs in ${meta.label}`,
                  description: meta.hint,
                }}
              />
            )}
          </section>
        )
      })}
      </>)}

      {executions && (
        <ExecutionsPanel
          target={executions}
          onClose={() => setExecutions(null)}
          onOpenSession={id => { void openSessionById(id) }}
          onOpenDiagram={flowId => { setExecutions(null); openFlow(flowId) }}
        />
      )}

      {sessionObjective && (() => {
        const live = objectives.find(o => o.id === sessionObjective.id) ?? sessionObjective
        return (
          <SessionViewer
            objective={live}
            onClose={() => setSessionObjective(null)}
            onChangeStatus={handleChangeStatus}
          />
        )
      })()}

      {authoring && (
        <NewStrategyJobModal
          strategies={strategies}
          workspaces={workspaces.map(w => ({ slug: w.slug, name: w.name }))}
          defaultWorkspace={wsFilter !== ALL ? wsFilter : (workspaces[0]?.slug ?? 'operator')}
          onClose={() => setAuthoring(false)}
          onCreate={createStrategyJob}
        />
      )}
    </PageContainer>
  )
}

const CADENCES: { value: StrategyJobInput['cadence']; label: string }[] = [
  { value: 'weekly', label: 'Weekly' },
  { value: 'weekdays', label: 'Every weekday' },
  { value: 'daily', label: 'Daily' },
  { value: 'monthly', label: 'Monthly' },
  { value: 'hourly', label: 'Hourly' },
]
const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/**
 * Author a Strategy-owned recurring Job (obj 2384). A strategy is created (or an
 * existing one chosen) and a recurring research routine is linked to it — the
 * cadence picker + prompt translate to cron + objective_template server-side, so
 * nobody hand-writes a cron or a JSON template.
 */
function NewStrategyJobModal({
  strategies,
  workspaces,
  defaultWorkspace,
  onClose,
  onCreate,
}: {
  strategies: StrategyOption[]
  workspaces: { slug: string; name: string }[]
  defaultWorkspace: string
  onClose: () => void
  onCreate: (input: StrategyJobInput) => Promise<{ ok: boolean; error?: string }>
}) {
  const NEW = '__new__'
  const [strategyChoice, setStrategyChoice] = useState<string>(strategies.length ? String(strategies[0].id) : NEW)
  const [strategyTitle, setStrategyTitle] = useState('')
  const [workspace, setWorkspace] = useState(defaultWorkspace)
  const [jobTitle, setJobTitle] = useState('')
  const [jobPrompt, setJobPrompt] = useState('')
  const [cadence, setCadence] = useState<StrategyJobInput['cadence']>('weekly')
  const [dow, setDow] = useState(1)
  const [dom, setDom] = useState(1)
  const [hour, setHour] = useState(9)
  const [enabled, setEnabled] = useState(true)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const creatingNew = strategyChoice === NEW
  const valid =
    jobTitle.trim() && jobPrompt.trim() && workspace.trim() &&
    (!creatingNew || strategyTitle.trim())

  const submit = useCallback(async () => {
    setBusy(true)
    setErr(null)
    const input: StrategyJobInput = {
      workspace,
      job_title: jobTitle.trim(),
      job_prompt: jobPrompt.trim(),
      cadence,
      hour,
      minute: 7,
      day_of_week: dow,
      day_of_month: dom,
      enabled,
      ...(creatingNew
        ? { strategy_title: strategyTitle.trim() }
        : { strategy_objective_id: Number(strategyChoice) }),
    }
    const res = await onCreate(input)
    setBusy(false)
    if (res.ok) onClose()
    else setErr(res.error || 'Failed to create')
  }, [workspace, jobTitle, jobPrompt, cadence, hour, dow, dom, enabled, creatingNew, strategyTitle, strategyChoice, onCreate, onClose])

  return (
    <Modal open onClose={onClose} labelledBy="new-strategy-job-title" panelClassName="w-full max-w-lg">
      <div className="p-5">
        <h2 id="new-strategy-job-title" className="flex items-center gap-2 text-[15px] font-semibold text-fg-0">
          <Target className="h-4 w-4 text-accent" strokeWidth={1.75} /> New strategy job
        </h2>
        <p className="mt-1 text-[12px] text-fg-2">
          A strategy owns a recurring research routine; each run becomes a child of the strategy and its
          summary feeds back into the strategy&apos;s context.
        </p>

        <div className="mt-4 space-y-3">
          <div>
            <label className={labelCls}>Owning strategy</label>
            <select className={selectCls} value={strategyChoice} onChange={e => setStrategyChoice(e.target.value)}>
              {strategies.map(s => (
                <option key={s.id} value={String(s.id)}>{s.title} (#{s.id})</option>
              ))}
              <option value={NEW}>➕ New strategy…</option>
            </select>
          </div>

          {creatingNew && (
            <div>
              <label className={labelCls}>New strategy name</label>
              <input
                className={fieldCls}
                placeholder="e.g. GEO/SEO competitive positioning"
                value={strategyTitle}
                onChange={e => setStrategyTitle(e.target.value)}
              />
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls}>Organization</label>
              <select className={selectCls} value={workspace} onChange={e => setWorkspace(e.target.value)}>
                {workspaces.map(w => <option key={w.slug} value={w.slug}>{w.name}</option>)}
              </select>
            </div>
            <div>
              <label className={labelCls}>Cadence</label>
              <select className={selectCls} value={cadence} onChange={e => setCadence(e.target.value as StrategyJobInput['cadence'])}>
                {CADENCES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            {cadence === 'weekly' && (
              <div>
                <label className={labelCls}>Day of week</label>
                <select className={selectCls} value={dow} onChange={e => setDow(Number(e.target.value))}>
                  {DOW.map((d, i) => <option key={i} value={i}>{d}</option>)}
                </select>
              </div>
            )}
            {cadence === 'monthly' && (
              <div>
                <label className={labelCls}>Day of month</label>
                <select className={selectCls} value={dom} onChange={e => setDom(Number(e.target.value))}>
                  {Array.from({ length: 28 }, (_, i) => i + 1).map(d => <option key={d} value={d}>{d}</option>)}
                </select>
              </div>
            )}
            {cadence !== 'hourly' && (
              <div>
                <label className={labelCls}>Hour (24h, server time)</label>
                <select className={selectCls} value={hour} onChange={e => setHour(Number(e.target.value))}>
                  {Array.from({ length: 24 }, (_, i) => i).map(h => <option key={h} value={h}>{String(h).padStart(2, '0')}:07</option>)}
                </select>
              </div>
            )}
          </div>

          <div>
            <label className={labelCls}>Job title</label>
            <input
              className={fieldCls}
              placeholder="e.g. Weekly competitor research"
              value={jobTitle}
              onChange={e => setJobTitle(e.target.value)}
            />
          </div>

          <div>
            <label className={labelCls}>What should each run do?</label>
            <textarea
              className={cn(fieldCls, 'min-h-[88px] resize-y')}
              placeholder="e.g. Research what our top 3 competitors shipped this week, summarize positioning shifts, and flag anything that affects our GEO/SEO strategy."
              value={jobPrompt}
              onChange={e => setJobPrompt(e.target.value)}
            />
          </div>

          <label className="flex items-center gap-2 text-[13px] text-fg-1">
            <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} />
            Enable on the schedule immediately
          </label>

          {err && <Alert tone="alarm" title="Could not create">{err}</Alert>}
        </div>

        <div className="mt-5 flex items-center justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" size="sm" onClick={submit} disabled={!valid || busy}>
            {busy ? 'Creating…' : 'Create strategy job'}
          </Button>
        </div>
      </div>
    </Modal>
  )
}

const SCRIPT_STATUS_TONE = { ok: 'verify', alert: 'amber', failed: 'alarm' } as const

/** Compact per-routine health: kind, last script result, failure streak, auto-pause. */
function RoutineHealthBadges({ routine: r }: { routine: RoutineSummary }) {
  const streak = r.consecutive_failures ?? 0
  const tip = [r.last_error, r.last_output_tail?.slice(-300)].filter(Boolean).join('\n')
  return (
    <div className="flex flex-wrap items-center gap-1" title={tip || undefined}>
      {r.kind === 'script' && <Badge tone="neutral" mono>script</Badge>}
      {r.kind === 'flow' && <Badge tone="accent" mono>workflow</Badge>}
      {r.kind === 'script' && r.last_run_status && (
        <Badge tone={SCRIPT_STATUS_TONE[r.last_run_status]} mono>
          {r.last_run_status}
          {r.last_run_status === 'failed' && r.last_exit_code != null ? ` (${r.last_exit_code})` : ''}
        </Badge>
      )}
      {isAutoPaused(r) ? (
        <Badge tone="alarm">auto-paused</Badge>
      ) : streak > 0 ? (
        <Badge tone="amber" mono>
          {streak}/{r.auto_pause_threshold || '∞'} failed
        </Badge>
      ) : r.kind !== 'script' && r.kind !== 'flow' ? (
        <span className="text-fg-3">—</span>
      ) : null}
    </div>
  )
}

/** "Run now" affordance for a routine row — preserves the runNow handler,
 *  busy state, and the started/blocked toast inline. */
function RunNowButton({
  routine,
  onRunNow,
}: {
  routine: RoutineSummary
  onRunNow: (id: number) => Promise<{ ok: boolean; reason?: string }>
}) {
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState<string | null>(null)

  const handleRun = useCallback(async () => {
    setBusy(true)
    setToast(null)
    try {
      const res = await onRunNow(routine.id)
      setToast(res.ok ? 'Started' : (res.reason ? `Blocked: ${res.reason}` : 'Blocked'))
    } catch (e) {
      setToast(e instanceof Error ? e.message : 'Run failed')
    } finally {
      setBusy(false)
    }
  }, [routine.id, onRunNow])

  return (
    <div className="flex items-center gap-2">
      {toast && (
        <span className="max-w-[140px] truncate font-mono text-[12px] text-fg-2" title={toast}>{toast}</span>
      )}
      <Button
        variant="secondary"
        size="sm"
        onClick={handleRun}
        disabled={busy}
        leftIcon={<Play className={cn('h-3.5 w-3.5', busy && 'animate-pulse')} strokeWidth={1.75} />}
      >
        {busy ? 'Running…' : 'Run now'}
      </Button>
    </div>
  )
}
