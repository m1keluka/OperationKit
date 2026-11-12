import { useState, type ReactNode } from 'react'
import { Bot, CheckCircle2, Clock, ExternalLink, Hourglass, Radio, ShieldQuestion, XCircle } from 'lucide-react'
import type { FlowWaitSummary } from '../../../../shared/flow/api'
import { answerFlowApproval, confirmFlowOutcome } from '../../hooks/useFlows'
import { relativeFuture, relativeTime } from '../../lib/time'
import { Alert, Badge, Button } from '../ui'

/**
 * "Waiting for" panel of a workflow run (obj 900645, card B9; WORKFLOWS.md §5.4).
 * One row per open wait token:
 *  - approval         → the prompt, the exact payload the next step will send, Approve / Reject
 *  - unknown_outcome  → "it was sent" / "it was not sent" after a crash mid-send
 *  - agent            → a link to the child card the run is waiting on
 *  - event / timed    → what it listens for, or when it resumes on its own
 * The server only accepts a click from an owner/admin signed in to the web app;
 * anyone else gets its 403 shown inline.
 */
export function FlowRunWaitsPanel({
  flowId,
  runId,
  waits,
  onChanged,
}: {
  flowId: number
  runId: number
  waits: FlowWaitSummary[]
  onChanged: () => void
}) {
  if (waits.length === 0) return null
  return (
    <div className="space-y-1" data-testid="flow-run-waits">
      <h4 className="text-[12px] font-semibold uppercase tracking-[0.06em] text-fg-3">Run #{runId} is waiting for</h4>
      <ul className="space-y-2">
        {waits.map(w => (
          <li key={`${w.node_id}:${w.iteration}:${w.reason}`} className="rounded-md border border-line bg-surface-0 p-3 text-[12px]">
            <WaitRow flowId={flowId} runId={runId} wait={w} onChanged={onChanged} />
          </li>
        ))}
      </ul>
    </div>
  )
}

function nodeRef(w: FlowWaitSummary): string {
  return `${w.node_id}${w.iteration ? `[${w.iteration}]` : ''}`
}

function WaitRow({ flowId, runId, wait: w, onChanged }: { flowId: number; runId: number; wait: FlowWaitSummary; onChanged: () => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState('')

  const act = async (fn: () => Promise<{ ok: boolean; error?: string }>) => {
    setBusy(true)
    setError(null)
    const r = await fn()
    setBusy(false)
    if (!r.ok) setError(r.error ?? 'Request failed')
    else onChanged()
  }

  const header = (icon: ReactNode, title: ReactNode, tone: 'amber' | 'info' | 'neutral' = 'amber') => (
    <div className="flex flex-wrap items-center gap-2">
      {icon}
      <span className="font-semibold text-fg-0">{title}</span>
      <Badge tone={tone} mono>{nodeRef(w)}</Badge>
      <span className="text-fg-3">since {relativeTime(w.created_at)} ago</span>
      {w.expires_at && w.reason !== 'duration' && w.reason !== 'until' && (
        <span className="text-fg-3">· times out {relativeFuture(w.expires_at)}</span>
      )}
    </div>
  )

  if (w.reason === 'approval') {
    return (
      <div className="space-y-2" data-testid="flow-wait-approval">
        {header(<ShieldQuestion className="h-4 w-4 text-signal-amber" strokeWidth={1.75} />, 'Owner approval')}
        {w.approval?.prompt && <p className="text-[13px] text-fg-0">{w.approval.prompt}</p>}
        {w.next && (
          <div className="space-y-1">
            <div className="text-fg-2">
              If approved, <span className="font-mono">{w.next.node_id}</span> ({w.next.kind}{w.next.effect ? `, ${w.next.effect}` : ''}) runs with:
            </div>
            <pre className="max-h-48 overflow-auto rounded bg-surface-2 p-2 font-mono text-[12px] text-fg-1" data-testid="flow-wait-payload">
              {JSON.stringify(w.next.input, null, 2)}
            </pre>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <input
            aria-label="Note"
            className="min-w-[12rem] flex-1 rounded-md border border-line bg-surface-1 px-2 py-1 text-[12px] text-fg-0"
            placeholder="Note (optional)"
            value={note}
            onChange={e => setNote(e.target.value)}
          />
          <Button
            size="sm"
            disabled={busy}
            onClick={() => void act(() => answerFlowApproval(flowId, runId, { decision: 'approve', node_id: w.node_id, iteration: w.iteration, ...(note ? { note } : {}) }))}
          >
            <CheckCircle2 className="h-3.5 w-3.5" strokeWidth={1.75} /> Approve
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => void act(() => answerFlowApproval(flowId, runId, { decision: 'reject', node_id: w.node_id, iteration: w.iteration, ...(note ? { note } : {}) }))}
          >
            <XCircle className="h-3.5 w-3.5" strokeWidth={1.75} /> Reject
          </Button>
        </div>
        {error && <Alert tone="alarm" title="Not recorded">{error}</Alert>}
      </div>
    )
  }

  if (w.reason === 'unknown_outcome') {
    return (
      <div className="space-y-2" data-testid="flow-wait-unknown">
        {header(<ShieldQuestion className="h-4 w-4 text-signal-alarm" strokeWidth={1.75} />, 'Confirm: did this step happen?')}
        <p className="text-fg-2">
          The engine stopped while <span className="font-mono">{w.node_id}</span> was in flight. It is not re-run automatically, so it cannot send twice.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" disabled={busy} onClick={() => void act(() => confirmFlowOutcome(flowId, runId, { node_id: w.node_id, outcome: 'sent' }))}>
            It happened — continue
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void act(() => confirmFlowOutcome(flowId, runId, { node_id: w.node_id, outcome: 'not_sent' }))}>
            It did not — run it again
          </Button>
        </div>
        {error && <Alert tone="alarm" title="Not recorded">{error}</Alert>}
      </div>
    )
  }

  if (w.reason === 'agent') {
    return header(
      <Bot className="h-4 w-4 text-accent-hover" strokeWidth={1.75} />,
      w.objective_id != null ? (
        <a className="inline-flex items-center gap-1 text-accent-hover hover:underline" href={`/o/${w.objective_id}`}>
          Agent card #{w.objective_id} <ExternalLink className="h-3 w-3" strokeWidth={1.75} />
          {w.objective_status && <Badge tone="neutral" mono>{w.objective_status}</Badge>}
        </a>
      ) : 'Agent card',
      'info',
    )
  }

  if (w.reason === 'event') {
    return header(<Radio className="h-4 w-4 text-accent-hover" strokeWidth={1.75} />, <>Event <span className="font-mono">{w.event_name}</span></>, 'info')
  }

  return header(
    w.reason === 'duration' ? <Hourglass className="h-4 w-4 text-fg-2" strokeWidth={1.75} /> : <Clock className="h-4 w-4 text-fg-2" strokeWidth={1.75} />,
    w.expires_at ? <>Resumes {relativeFuture(w.expires_at)}</> : 'Timer',
    'neutral',
  )
}
