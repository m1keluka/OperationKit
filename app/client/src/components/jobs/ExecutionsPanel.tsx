import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle, CheckCircle2, ChevronRight, CircleSlash, Clock, ExternalLink, Loader2, PauseCircle, Workflow, X, XCircle,
} from 'lucide-react'
import type { FlowRunDetailResponse, FlowRunSummary, FlowStepSummary } from '../../../../shared/flow/api'
import type {
  JobExecutionDetailResponse, JobExecutionLogEntry, JobExecutionStatus, JobExecutionSummary, JobExecutionsResponse,
} from '../../../../shared/job-executions'
import { fetchFlowRun } from '../../hooks/useFlows'
import { Alert, Badge, Button, Modal, cn } from '../ui'

/**
 * Jobs → Executions (obj 900676) — every recorded run of a routine or workflow, and
 * the log of the one you click, in the style of n8n's executions view: the run list
 * on the left, what happened in the selected run on the right.
 *
 *  - routine target  → GET /api/admin/routines/:id/executions[/:key] (routine_runs +
 *                      older routine cards / flow runs); a workflow run additionally
 *                      shows its step log from GET /api/flows/:flowId/runs/:runId.
 *  - flow target     → GET /api/flows/:id/runs (live, manual and scheduled runs alike).
 */
export type ExecutionsTarget =
  | { type: 'routine'; routineId: number; title: string; focus?: { objectiveId?: number; flowRunId?: number } }
  | { type: 'flow'; flowId: number; title: string; focus?: { flowRunId?: number } }

const STATUS_META: Record<JobExecutionStatus, { label: string; tone: 'verify' | 'alarm' | 'info' | 'amber' | 'neutral'; icon: typeof CheckCircle2 }> = {
  running: { label: 'Running', tone: 'info', icon: Loader2 },
  waiting: { label: 'Waiting', tone: 'amber', icon: PauseCircle },
  succeeded: { label: 'Succeeded', tone: 'verify', icon: CheckCircle2 },
  needs_review: { label: 'Needs review', tone: 'amber', icon: AlertTriangle },
  alert: { label: 'Alert', tone: 'amber', icon: AlertTriangle },
  failed: { label: 'Failed', tone: 'alarm', icon: XCircle },
  skipped: { label: 'Skipped', tone: 'neutral', icon: CircleSlash },
  cancelled: { label: 'Cancelled', tone: 'neutral', icon: CircleSlash },
}

const STATUS_TEXT: Record<string, string> = {
  verify: 'text-signal-verify',
  alarm: 'text-signal-alarm',
  info: 'text-status-working',
  amber: 'text-signal-amber',
  neutral: 'text-fg-3',
}

const LEVEL_DOT: Record<JobExecutionLogEntry['level'], string> = {
  info: 'bg-fg-3',
  success: 'bg-signal-verify',
  warn: 'bg-signal-amber',
  error: 'bg-signal-alarm',
}

export function ExecutionStatusBadge({ status }: { status: JobExecutionStatus }) {
  const m = STATUS_META[status] ?? STATUS_META.running
  return <Badge tone={m.tone} mono>{m.label}</Badge>
}

/** "Nov 12, 06:03:12" in the viewer's zone; the UTC ISO stamp is the tooltip. */
export function formatStamp(iso: string | null | undefined): string {
  if (!iso) return '—'
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return '—'
  return new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return '—'
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const m = Math.floor(ms / 60_000)
  if (m < 60) return `${m}m ${Math.round((ms % 60_000) / 1000)}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

function span(a: string | null, b: string | null): number | null {
  if (!a || !b) return null
  const d = Date.parse(b) - Date.parse(a)
  return Number.isFinite(d) && d >= 0 ? d : null
}

/** A flow run as an execution row (the flow target lists GET /api/flows/:id/runs). */
export function flowRunToExecution(r: FlowRunSummary): JobExecutionSummary {
  const status: JobExecutionStatus =
    r.status === 'succeeded' ? (r.goal_met === 0 ? 'failed' : 'succeeded')
      : r.status === 'failed' ? 'failed'
        : r.status === 'cancelled' ? 'cancelled'
          : r.status === 'waiting' ? 'waiting'
            : 'running'
  const started = r.started_at ?? r.created_at
  return {
    key: `flow-${r.id}`,
    routine_id: null,
    routine_run_id: null,
    kind: 'flow',
    source: r.trigger_source === 'schedule' ? 'cron' : r.trigger_source ?? 'unknown',
    status,
    started_at: r.created_at,
    ended_at: r.ended_at,
    duration_ms: span(started, r.ended_at),
    reason: r.error ? [r.error.type, r.error.title].filter(Boolean).join(': ') : r.status === 'succeeded' && r.goal_met === 0 ? 'goal not met' : null,
    objective_id: null,
    objective_title: null,
    flow_id: r.flow_id,
    flow_run_id: r.id,
    exit_code: null,
    cost_usd: r.spent_usd,
  }
}

const SOURCE_LABEL: Record<string, string> = { cron: 'schedule', 'run-now': 'run now', manual: 'manual', unknown: '' }

function pickFocus(list: JobExecutionSummary[], target: ExecutionsTarget): string | null {
  const f = target.focus
  if (f) {
    const hit = list.find(e =>
      (('objectiveId' in f) && f.objectiveId != null && e.objective_id === f.objectiveId) ||
      (f.flowRunId != null && e.flow_run_id === f.flowRunId))
    if (hit) return hit.key
  }
  return list[0]?.key ?? null
}

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url, { credentials: 'include' })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return (await r.json()) as T
}

export function ExecutionsPanel({
  target,
  onClose,
  onOpenSession,
  onOpenDiagram,
}: {
  target: ExecutionsTarget
  onClose: () => void
  /** Open the card's session transcript (AI runs, script escalations). */
  onOpenSession?: (objectiveId: number) => void
  /** Open the workflow diagram (Jobs → Workflows). */
  onOpenDiagram?: (flowId: number) => void
}) {
  const [list, setList] = useState<JobExecutionSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)

  const listUrl = target.type === 'routine'
    ? `/api/admin/routines/${target.routineId}/executions?limit=200`
    : `/api/flows/${target.flowId}/runs?limit=200`

  const load = useCallback(async () => {
    try {
      const next = target.type === 'routine'
        ? (await getJson<JobExecutionsResponse>(listUrl)).executions
        : ((await getJson<{ runs: FlowRunSummary[] }>(listUrl)).runs ?? []).filter(r => r.mode === 'live').map(flowRunToExecution)
      setList(next)
      setError(null)
      setSelected(cur => (cur && next.some(e => e.key === cur) ? cur : pickFocus(next, target)))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load executions')
      setList(cur => cur ?? [])
    }
    // target identity changes on every parent render; its fields are what matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listUrl])

  useEffect(() => { void load() }, [load, nonce])

  // Keep a live run live: poll while anything is still running or waiting.
  const anyActive = !!list?.some(e => e.status === 'running' || e.status === 'waiting')
  useEffect(() => {
    if (!anyActive) return
    const t = setInterval(() => setNonce(n => n + 1), 5_000)
    return () => clearInterval(t)
  }, [anyActive])

  const current = useMemo(() => list?.find(e => e.key === selected) ?? null, [list, selected])

  return (
    <Modal
      open
      onClose={onClose}
      variant="sheet"
      labelledBy="executions-title"
      panelClassName="flex flex-col sm:w-[min(1080px,96vw)]"
    >
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-line px-4 py-3">
        <div className="min-w-0">
          <div className="text-[12px] font-semibold uppercase tracking-[0.08em] text-fg-3">Executions</div>
          <h2 id="executions-title" className="truncate text-[15px] font-semibold text-fg-0" title={target.title}>{target.title}</h2>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md p-1 text-fg-2 hover:bg-surface-3 hover:text-fg-0"
          aria-label="Close"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {error && <Alert tone="alarm" title="Could not load executions" className="m-3">{error}</Alert>}

      <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
        {/* Run list */}
        <nav aria-label="Runs" className="max-h-[38vh] shrink-0 overflow-y-auto border-b border-line sm:max-h-none sm:w-[300px] sm:border-b-0 sm:border-r">
          {list == null ? (
            <div className="flex items-center gap-2 p-4 text-[13px] text-fg-2"><Loader2 className="h-4 w-4 animate-spin" /> Loading runs…</div>
          ) : list.length === 0 ? (
            <div className="p-4 text-[13px] text-fg-2">No runs recorded yet. A run appears here the moment it fires.</div>
          ) : (
            <ul role="listbox" aria-label="Recorded runs">
              {list.map(e => (
                <ExecutionRow key={e.key} e={e} active={e.key === selected} onClick={() => setSelected(e.key)} />
              ))}
            </ul>
          )}
        </nav>

        {/* Selected run */}
        <section aria-label="Run log" className="min-h-0 flex-1 overflow-y-auto p-4">
          {current ? (
            <ExecutionDetail
              key={current.key}
              routineId={target.type === 'routine' ? target.routineId : null}
              refresh={nonce}
              execution={current}
              onOpenSession={onOpenSession}
              onOpenDiagram={onOpenDiagram}
            />
          ) : list && list.length > 0 ? (
            <p className="text-[13px] text-fg-2">Pick a run on the left to read its log.</p>
          ) : null}
        </section>
      </div>
    </Modal>
  )
}

function ExecutionRow({ e, active, onClick }: { e: JobExecutionSummary; active: boolean; onClick: () => void }) {
  const m = STATUS_META[e.status] ?? STATUS_META.running
  const Icon = m.icon
  const src = SOURCE_LABEL[e.source] ?? e.source
  return (
    <li role="option" aria-selected={active}>
      <button
        type="button"
        onClick={onClick}
        data-testid={`execution-${e.key}`}
        className={cn(
          'flex w-full items-start gap-2.5 border-b border-line px-3 py-2.5 text-left hover:bg-surface-3',
          active && 'bg-surface-selected shadow-[inset_2px_0_0_var(--accent-text)]',
        )}
      >
        <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', STATUS_TEXT[m.tone], e.status === 'running' && 'animate-spin')} strokeWidth={1.75} />
        <span className="min-w-0 flex-1">
          <span className="block font-mono text-[12.5px] text-fg-0" title={e.started_at}>{formatStamp(e.started_at)}</span>
          <span className="block text-[12px] text-fg-2">
            <span className={STATUS_TEXT[m.tone]}>{m.label}</span>
            {e.duration_ms != null && e.status !== 'skipped' ? ` in ${formatDuration(e.duration_ms)}` : ''}
            {src ? <span className="text-fg-3"> · {src}</span> : null}
          </span>
          {e.reason && (e.status === 'failed' || e.status === 'skipped' || e.status === 'alert') && (
            <span className="mt-0.5 block truncate text-[12px] text-fg-3" title={e.reason}>{e.reason}</span>
          )}
        </span>
        <span className="shrink-0 font-mono text-[12px] text-fg-3">{runLabel(e)}</span>
      </button>
    </li>
  )
}

function runLabel(e: JobExecutionSummary): string {
  if (e.flow_run_id != null) return `run #${e.flow_run_id}`
  if (e.objective_id != null) return `card #${e.objective_id}`
  return ''
}

function ExecutionDetail({
  routineId,
  refresh,
  execution: e,
  onOpenSession,
  onOpenDiagram,
}: {
  routineId: number | null
  /** Bumped by the list poll so a live run's log keeps up. */
  refresh: number
  execution: JobExecutionSummary
  onOpenSession?: (objectiveId: number) => void
  onOpenDiagram?: (flowId: number) => void
}) {
  const [detail, setDetail] = useState<JobExecutionDetailResponse | null>(null)
  const [flowRun, setFlowRun] = useState<FlowRunDetailResponse | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setError(null)
    if (routineId != null) {
      getJson<JobExecutionDetailResponse>(`/api/admin/routines/${routineId}/executions/${encodeURIComponent(e.key)}`)
        .then(d => { if (!cancelled) setDetail(d) })
        .catch(err => { if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load the run') })
    }
    if (e.flow_id != null && e.flow_run_id != null) {
      fetchFlowRun(e.flow_id, e.flow_run_id)
        .then(d => { if (!cancelled) setFlowRun(d) })
        .catch(err => { if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load the workflow run') })
    }
    return () => { cancelled = true }
  }, [routineId, refresh, e.key, e.flow_id, e.flow_run_id])

  const objectiveId = detail?.objective?.id ?? e.objective_id
  return (
    <div className="space-y-4" data-testid="execution-detail">
      <header className="flex flex-wrap items-center gap-2">
        <ExecutionStatusBadge status={e.status} />
        <span className="font-mono text-[13px] text-fg-0" title={e.started_at}>{formatStamp(e.started_at)}</span>
        <span className="text-[12px] text-fg-2">
          {e.status === 'skipped' ? 'nothing ran' : `took ${e.ended_at ? formatDuration(e.duration_ms) : '…'}`}
          {SOURCE_LABEL[e.source] ? ` · ${SOURCE_LABEL[e.source]}` : ''}
          {e.cost_usd ? ` · $${e.cost_usd.toFixed(2)}` : ''}
          {e.exit_code != null ? ` · exit ${e.exit_code}` : ''}
        </span>
        <span className="ml-auto flex gap-2">
          {objectiveId != null && onOpenSession && (
            <Button variant="secondary" size="sm" onClick={() => onOpenSession(objectiveId)} leftIcon={<ExternalLink className="h-3.5 w-3.5" />}>
              Open session #{objectiveId}
            </Button>
          )}
          {e.flow_id != null && onOpenDiagram && (
            <Button variant="secondary" size="sm" onClick={() => onOpenDiagram(e.flow_id as number)} leftIcon={<Workflow className="h-3.5 w-3.5" />}>
              Diagram
            </Button>
          )}
        </span>
      </header>

      {/* A failed workflow run shows its error (with the failing node) above its step log instead. */}
      {e.reason && !(e.flow_run_id != null && e.status === 'failed') &&
        (e.status === 'failed' || e.status === 'skipped' || e.status === 'alert' || e.status === 'needs_review') && (
        <Alert tone={e.status === 'failed' ? 'alarm' : 'amber'} title={e.status === 'skipped' ? 'Why it did not run' : 'Outcome'}>
          {e.reason}
        </Alert>
      )}

      {error && <Alert tone="alarm" title="Could not load this run">{error}</Alert>}

      {detail && detail.log.length > 0 && <Timeline entries={detail.log} />}

      {detail?.command && (
        <div>
          <h4 className="mb-1 text-[12px] font-semibold uppercase tracking-[0.08em] text-fg-3">Command</h4>
          <code className="block break-all rounded-md border border-line bg-surface-2 px-2 py-1.5 font-mono text-[12px] text-fg-1">{detail.command}</code>
        </div>
      )}

      {detail && e.kind === 'script' && (
        <div>
          <h4 className="mb-1 text-[12px] font-semibold uppercase tracking-[0.08em] text-fg-3">
            Output{detail.output_truncated ? ' (last 64KB)' : ''}
          </h4>
          {detail.output
            ? <pre data-testid="execution-output" className="max-h-[50vh] overflow-auto whitespace-pre-wrap break-words rounded-md border border-line bg-surface-0 p-3 font-mono text-[12px] leading-relaxed text-fg-1">{detail.output}</pre>
            : <p className="text-[12.5px] text-fg-3">{e.status === 'running' ? 'The script is still running.' : e.routine_run_id == null ? 'Output was not kept for runs before execution history.' : 'No output.'}</p>}
        </div>
      )}

      {flowRun && <FlowSteps run={flowRun} />}

      {!detail && !flowRun && !error && (
        <div className="flex items-center gap-2 text-[13px] text-fg-2"><Loader2 className="h-4 w-4 animate-spin" /> Loading the run…</div>
      )}
    </div>
  )
}

function Timeline({ entries }: { entries: JobExecutionLogEntry[] }) {
  return (
    <div>
      <h4 className="mb-2 text-[12px] font-semibold uppercase tracking-[0.08em] text-fg-3">What happened</h4>
      <ol className="relative space-y-2.5 border-l border-line pl-4" data-testid="execution-log">
        {entries.map((l, i) => (
          <li key={i} className="relative">
            <span className={cn('absolute -left-[21px] top-1.5 h-2 w-2 rounded-full ring-2 ring-surface-1', LEVEL_DOT[l.level])} aria-hidden />
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className={cn('text-[13px] font-medium', l.level === 'error' ? 'text-signal-alarm' : l.level === 'warn' ? 'text-signal-amber' : 'text-fg-0')}>{l.label}</span>
              {l.at && <span className="font-mono text-[12px] text-fg-3" title={l.at}>{formatStamp(l.at)}</span>}
            </div>
            {l.detail && <p className="mt-0.5 whitespace-pre-wrap break-words text-[12.5px] leading-snug text-fg-2">{l.detail}</p>}
          </li>
        ))}
      </ol>
    </div>
  )
}

function stepTone(status: string): 'verify' | 'alarm' | 'info' | 'amber' | 'neutral' {
  if (status === 'succeeded') return 'verify'
  if (status === 'failed') return 'alarm'
  if (status === 'running') return 'info'
  if (status === 'unknown' || status === 'interrupted') return 'amber'
  return 'neutral'
}

function prettyJson(s: string | null): string | null {
  if (!s) return null
  try { return JSON.stringify(JSON.parse(s), null, 2) } catch { return s }
}

/** The workflow run's step log — one row per node attempt, like n8n's node list. */
function FlowSteps({ run }: { run: FlowRunDetailResponse }) {
  const steps = run.steps
  return (
    <div>
      <h4 className="mb-2 flex items-center gap-2 text-[12px] font-semibold uppercase tracking-[0.08em] text-fg-3">
        <Workflow className="h-3.5 w-3.5" /> Workflow run #{run.run.id} · v{run.run.version} · {steps.length} {steps.length === 1 ? 'step' : 'steps'}
      </h4>
      {run.run.error && (
        <Alert tone="alarm" title={`${run.run.error.type}${run.run.error.node_id ? ` at ${run.run.error.node_id}` : ''}`} className="mb-2">
          {run.run.error.title}
        </Alert>
      )}
      {steps.length === 0 ? (
        <p className="text-[12.5px] text-fg-3">{run.run.status === 'queued' ? 'Queued — the engine has not started it yet.' : 'No steps recorded.'}</p>
      ) : (
        <ol className="space-y-1.5" data-testid="execution-steps">
          {steps.map((s, i) => <FlowStepRow key={`${s.node_id}-${s.iteration}-${s.attempt}-${i}`} step={s} />)}
        </ol>
      )}
      {run.waits.length > 0 && (
        <p className="mt-2 flex items-center gap-1.5 text-[12.5px] text-signal-amber">
          <Clock className="h-3.5 w-3.5" /> Parked on {run.waits.map(w => `${w.node_id} (${w.reason})`).join(', ')} — resolve it from the workflow diagram.
        </p>
      )}
    </div>
  )
}

function FlowStepRow({ step: s }: { step: FlowStepSummary }) {
  const [open, setOpen] = useState(s.status === 'failed')
  const input = prettyJson(s.input_preview)
  const output = prettyJson(s.output_preview)
  const hasBody = !!(input || output || s.error)
  return (
    <li className="rounded-md border border-line bg-surface-1">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        disabled={!hasBody}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left disabled:cursor-default"
        aria-expanded={open}
      >
        <ChevronRight className={cn('h-3.5 w-3.5 shrink-0 text-fg-3 transition-transform', open && 'rotate-90', !hasBody && 'opacity-0')} />
        <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-fg-0">
          {s.node_id}
          {s.iteration > 0 && <span className="text-fg-3"> [{s.iteration}]</span>}
          {s.attempt > 1 && <span className="text-fg-3"> · attempt {s.attempt}</span>}
        </span>
        {s.simulated && <Badge tone="neutral" mono>{s.simulated}</Badge>}
        {s.effect && s.effect !== 'read' && <Badge tone="neutral" mono>{s.effect}</Badge>}
        <Badge tone={stepTone(s.status)} mono>{s.status}</Badge>
        <span className="w-16 shrink-0 text-right font-mono text-[12px] text-fg-3">{formatDuration(span(s.started_at, s.ended_at))}</span>
      </button>
      {open && hasBody && (
        <div className="space-y-2 border-t border-line px-3 py-2">
          {s.error && (
            <p className="text-[12.5px] text-signal-alarm">
              {[s.error.type, s.error.title].filter(Boolean).join(': ')}
              {s.error.detail ? <span className="block whitespace-pre-wrap text-fg-2">{s.error.detail}</span> : null}
            </p>
          )}
          {input && <JsonBlock label="Input" body={input} />}
          {output && <JsonBlock label="Output" body={output} />}
          {s.cost_usd > 0 && <p className="font-mono text-[12px] text-fg-3">cost ${s.cost_usd.toFixed(4)}</p>}
        </div>
      )}
    </li>
  )
}

function JsonBlock({ label, body }: { label: string; body: string }) {
  return (
    <div>
      <div className="mb-0.5 text-[12px] font-semibold uppercase tracking-[0.08em] text-fg-3">{label}</div>
      <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded border border-line bg-surface-0 p-2 font-mono text-[12px] text-fg-1">{body}</pre>
    </div>
  )
}
