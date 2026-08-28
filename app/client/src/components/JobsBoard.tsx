import { useState, useCallback, useMemo } from 'react'
import { ExternalLink, AlertCircle, Clock, Play, Pause, Inbox, CheckCircle2, Loader2, Target, Plus } from 'lucide-react'
import type { Objective, ObjectiveStatus, Workspace } from '@command-center/shared'
import { useObjectives } from '../hooks/useObjectives'
import { useRoutines, type RoutineSummary, type StrategyOption, type StrategyJobInput } from '../hooks/useRoutines'
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
const labelCls = 'block text-[11px] font-medium uppercase tracking-[0.08em] text-fg-3 mb-1'

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
  // Jobs are workspace-agnostic automated runs; show them all regardless of the
  // board's workspace selector (admin-only surface). useObjectives('all') still
  // wires the same WebSocket live-update path the main board uses.
  // NOTE (obj 700082): the `scopeObjectives` render gate is INTENTIONALLY omitted
  // here — this surface is cross-workspace by design and filters via its own
  // `wsFilter` dropdown below. Do NOT add the gate; it would hide valid jobs.
  const { objectives, loading, error, changeStatus, connectionState } = useObjectives('all')
  const { routines, routinesEnabled, strategies, runNow, createStrategyJob } = useRoutines()
  const { labelOf, workspaces } = useWorkspaces()

  const [sessionObjective, setSessionObjective] = useState<Objective | null>(null)
  const [wsFilter, setWsFilter] = useState<string>(ALL)
  const [authoring, setAuthoring] = useState(false)

  // jobs = routine-spawned objectives. Newest run first within each lane.
  const allJobs = useMemo(
    () => objectives.filter(o => o.routine_id != null).sort((a, b) => b.id - a.id),
    [objectives]
  )

  // Workspace filter options: the union of workspaces present across scheduled
  // routines AND past job runs — so e.g. a grass-fed job/routine shows up
  // without any hardcoded list (workspaces are created dynamically).
  const wsOptions = useMemo(() => {
    const set = new Set<string>()
    for (const r of routines) set.add(r.workspace)
    for (const j of allJobs) if (j.workspace) set.add(j.workspace)
    return Array.from(set).sort()
  }, [routines, allJobs])

  const jobs = useMemo(
    () => (wsFilter === ALL ? allJobs : allJobs.filter(j => j.workspace === wsFilter)),
    [allJobs, wsFilter]
  )
  const visibleRoutines = useMemo(
    () => (wsFilter === ALL ? routines : routines.filter(r => r.workspace === wsFilter)),
    [routines, wsFilter]
  )

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
      { key: ALL, label: 'All', count: allJobs.length },
      ...wsOptions.map(ws => ({
        key: ws,
        label: labelOf(ws),
        count: allJobs.filter(j => j.workspace === ws).length,
      })),
    ],
    [wsOptions, allJobs, labelOf]
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
                  <span key={s.id} className="inline-flex items-center gap-1 text-[11.5px] text-accent-hover">
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

  return (
    <PageContainer width="wide">
      <PageHeader
        title="Jobs"
        breadcrumbs={[{ label: 'OperationKit' }, { label: 'Jobs' }]}
        description={
          `${jobs.length} automated ${jobs.length === 1 ? 'run' : 'runs'}` +
          ` · ${visibleRoutines.length} ${visibleRoutines.length === 1 ? 'routine' : 'routines'} · ${enabledCount} active`
        }
        actions={
          <div className="flex items-center gap-2">
            {lanes.needs_review.length > 0 && (
              <Badge tone="amber">{lanes.needs_review.length} need review</Badge>
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

      {/* Workspace filter */}
      {wsOptions.length > 0 && (
        <Toolbar
          left={<Tabs items={wsTabs} value={wsFilter} onChange={setWsFilter} />}
        />
      )}

      {/* ── Scheduled routines — the global DataTable. ── */}
      <section className="mb-6 space-y-2">
        <h3 className="flex items-center gap-2 font-mono text-[11px] font-medium uppercase tracking-[0.12em] text-fg-3">
          <Clock className="h-3.5 w-3.5" strokeWidth={1.75} /> Scheduled routines
        </h3>
        <DataTable
          columns={routineColumns}
          rows={visibleRoutines}
          rowKey={r => r.id}
          loading={loading}
          initialSort={{ key: 'next', dir: 'asc' }}
          mobileTitle={r => (
            <span className="font-medium text-fg-0" title={r.title}>{r.title}</span>
          )}
          rowActions={r => <RunNowButton routine={r} onRunNow={runNow} />}
          empty={{
            icon: <Clock className="h-5 w-5" strokeWidth={1.6} />,
            title: 'No scheduled routines',
            description: wsFilter !== ALL ? `Nothing scheduled for ${labelOf(wsFilter)}.` : 'Routines you schedule will appear here.',
          }}
        />
      </section>

      {/* ── Outcome lanes — Running / Needs Review / Complete. ── */}
      {LANE_ORDER.map(lane => {
        const meta = LANE_META[lane]
        const Icon = meta.icon
        const rows = lanes[lane]
        return (
          <section key={lane} className="mb-6 space-y-2">
            <h3
              className={cn(
                'flex items-center gap-2 font-mono text-[11px] font-medium uppercase tracking-[0.12em]',
                lane === 'needs_review' ? 'text-signal-amber' : 'text-fg-3',
              )}
            >
              <Icon className={cn('h-3.5 w-3.5', lane === 'running' && 'animate-spin')} strokeWidth={1.75} />
              {meta.label}
              <span className="font-mono text-fg-3">{rows.length}</span>
            </h3>
            <DataTable
              columns={laneColumns}
              rows={rows}
              rowKey={job => job.id}
              loading={loading}
              onRowClick={job => setSessionObjective(job)}
              mobileTitle={job => (
                <span className="font-medium text-fg-0" title={job.title}>{job.title}</span>
              )}
              rowActions={job => (
                <Button variant="secondary" size="sm" onClick={() => setSessionObjective(job)}>
                  Open
                </Button>
              )}
              empty={{
                icon: <Inbox className="h-5 w-5" strokeWidth={1.6} />,
                title: meta.label === 'Running' ? 'Nothing running' : `Nothing in ${meta.label}`,
                description: meta.hint,
              }}
            />
          </section>
        )
      })}

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
          defaultWorkspace={wsFilter !== ALL ? wsFilter : (workspaces[0]?.slug ?? 'personal')}
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
        <span className="max-w-[140px] truncate font-mono text-[11px] text-fg-2" title={toast}>{toast}</span>
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
