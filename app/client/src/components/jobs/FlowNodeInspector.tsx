import { useEffect, useState } from 'react'
import { ShieldCheck, X } from 'lucide-react'
import type { FlowNodeAttempt, FlowNodeInspectResponse } from '../../../../shared/flow/api'
import { fetchFlowNode } from '../../hooks/useFlows'
import { Alert, Badge, Button } from '../ui'

/**
 * Click-to-inspect side panel (card B7, docs/design/WORKFLOWS.md §6.2): the
 * node's config, its attempts in the selected run (input / output / error) and
 * the same node in the last good run.
 *
 * EVERY value shown comes from GET /api/flows/:id/[runs/:runId/]nodes/:nodeId,
 * which redacts with live-redaction at read time and only then caps. The panel
 * deliberately does NOT read the definition the canvas was drawn from — a
 * literal a definition carries is shown only as the server redacted it.
 */

const STATUS_TONE: Record<string, 'verify' | 'alarm' | 'info' | 'amber' | 'neutral'> = {
  succeeded: 'verify', failed: 'alarm', running: 'info', interrupted: 'amber', unknown: 'amber', waiting: 'amber', skipped: 'neutral',
}

function Block({ title, text, testId }: { title: string; text: string | null; testId: string }) {
  if (text == null) return null
  return (
    <details className="group rounded-md border border-line" open={title !== 'Input'}>
      <summary className="cursor-pointer select-none px-2 py-1 text-[12px] font-semibold uppercase tracking-[0.06em] text-fg-3">{title}</summary>
      <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all border-t border-line px-2 py-1.5 font-mono text-[12px] leading-snug text-fg-1" data-testid={testId}>
        {text}
      </pre>
    </details>
  )
}

function dur(a: FlowNodeAttempt): string {
  if (!a.ended_at) return 'in flight'
  const ms = Math.max(0, Date.parse(a.ended_at) - Date.parse(a.started_at))
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
}

function AttemptView({ a, label }: { a: FlowNodeAttempt; label?: string }) {
  return (
    <div className="space-y-1.5 rounded-md border border-line bg-surface-0 p-2" data-testid="flow-inspector-attempt">
      <div className="flex flex-wrap items-center gap-1.5 text-[12px] text-fg-2">
        {label && <span className="font-semibold text-fg-1">{label}</span>}
        <Badge tone={STATUS_TONE[a.status] ?? 'neutral'} mono>{a.status}</Badge>
        <span className="font-mono">attempt {a.attempt}</span>
        {a.iteration > 0 && <span className="font-mono">item #{a.iteration}</span>}
        {a.effect && <span className="font-mono">{a.effect}</span>}
        {a.simulated && <Badge tone="amber" mono>{a.simulated.replace('_', ' ')}</Badge>}
        <span className="font-mono">{dur(a)}</span>
        {a.cost_usd > 0 && <span className="font-mono">${a.cost_usd.toFixed(4)}</span>}
        {a.truncated && <span className="font-mono text-fg-3">(capped)</span>}
      </div>
      <Block title="Error" text={a.error} testId="flow-inspector-error" />
      <Block title="Output" text={a.output} testId="flow-inspector-output" />
      <Block title="Input" text={a.input} testId="flow-inspector-input" />
    </div>
  )
}

export function FlowNodeInspector({
  flowId,
  nodeId,
  runId,
  version,
  refreshKey,
  onClose,
}: {
  flowId: number
  nodeId: string
  /** The run the overlay shows; null = no run, inspect the version only. */
  runId: number | null
  version: number
  /** Bump to refetch (live overlay events for this run). */
  refreshKey?: number
  onClose: () => void
}) {
  const [data, setData] = useState<FlowNodeInspectResponse | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    fetchFlowNode(flowId, { nodeId, runId, version })
      .then(d => { if (!cancelled) { setData(d); setError(null) } })
      .catch(e => { if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load node') })
    return () => { cancelled = true }
  }, [flowId, nodeId, runId, version, refreshKey])

  const shown = data && data.node_id === nodeId ? data : null
  return (
    <aside
      className="flex max-h-[760px] min-w-0 flex-col gap-2 overflow-y-auto rounded-lg border border-line bg-surface-1 p-3"
      aria-label={`Node ${nodeId}`}
      data-testid="flow-node-inspector"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="font-mono text-[13px] font-semibold text-fg-0">{nodeId}</div>
          <div className="flex flex-wrap items-center gap-1.5 text-[12px] text-fg-2">
            {shown?.kind && <Badge tone="neutral" mono>{shown.kind}</Badge>}
            {shown?.status && <Badge tone={STATUS_TONE[shown.status] ?? 'neutral'} mono>{shown.status}</Badge>}
            <span className="font-mono">{runId != null ? `run #${runId}` : 'no run selected'} · v{shown?.version ?? version}</span>
          </div>
        </div>
        <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close node panel" leftIcon={<X className="h-3.5 w-3.5" strokeWidth={1.75} />}>
          Close
        </Button>
      </div>
      <p className="flex items-center gap-1 text-[12px] text-fg-3">
        <ShieldCheck className="h-3 w-3 shrink-0" strokeWidth={1.75} /> Values that look like secrets are shown as [REDACTED:…].
      </p>
      {error && <Alert tone="alarm" title="Could not load node">{error}</Alert>}
      {!shown && !error && <div className="h-24 animate-pulse rounded-md bg-surface-2" />}
      {shown && (
        <>
          <Block title="Config" text={shown.config} testId="flow-inspector-config" />
          {runId != null && (
            <section className="space-y-1.5">
              <h5 className="text-[12px] font-semibold uppercase tracking-[0.06em] text-fg-3">
                This run{shown.attempt_count > shown.attempts.length ? ` — last ${shown.attempts.length} of ${shown.attempt_count} rows` : ''}
              </h5>
              {shown.attempts.length === 0
                ? <p className="text-[12px] text-fg-3">This node has not run in run #{runId}.</p>
                : shown.attempts.map(a => <AttemptView key={`${a.iteration}-${a.attempt}`} a={a} />)}
            </section>
          )}
          <section className="space-y-1.5">
            <h5 className="text-[12px] font-semibold uppercase tracking-[0.06em] text-fg-3">Last good run</h5>
            {shown.last_good
              ? <AttemptView a={shown.last_good.attempt} label={`run #${shown.last_good.run_id} · v${shown.last_good.version}`} />
              : <p className="text-[12px] text-fg-3">No other live run where this node succeeded.</p>}
          </section>
        </>
      )}
    </aside>
  )
}
