import { useEffect, useState } from 'react'
import { CheckCircle2, FlaskConical, ShieldCheck, XCircle } from 'lucide-react'
import type { FlowPublishState, FlowSelfTest } from '../../../../shared/flow/api'
import { publishFlow, runFlowSelfTest } from '../../hooks/useFlows'
import { relativeTime } from '../../lib/time'
import { Alert, Badge, Button } from '../ui'

/**
 * Self-test + publish for one workflow version (obj 900641, card B5;
 * docs/design/WORKFLOWS.md §5.2, §5.4).
 *
 * The ENGINE decides whether a self-test passed; this panel only shows the
 * verdict: failing asserts, uncovered nodes, and every step it did NOT perform
 * ("would send …"). Publishing needs a green self-test of this exact version
 * and, when the version sends or spends, the owner ticking exactly those nodes.
 * The server enforces all of it (and that the publisher is a signed-in
 * owner/admin); the button never decides anything on its own.
 */

const SIM_LABEL: Record<string, string> = {
  would_send: 'would send',
  would_write: 'would write',
  would_spend: 'would spend',
}

export function FlowSelfTestPanel({
  flowId,
  publish,
  publishedVersion,
  flowsEnabled,
  onChanged,
  onOpenRun,
}: {
  flowId: number
  publish: FlowPublishState
  publishedVersion: number | null
  flowsEnabled: boolean
  onChanged: () => void
  onOpenRun: (runId: number) => void
}) {
  const [busy, setBusy] = useState<'dry' | 'test' | 'publish' | null>(null)
  const [message, setMessage] = useState<{ tone: 'alarm' | 'verify'; text: string } | null>(null)
  const [approved, setApproved] = useState<Set<string>>(new Set())
  const st: FlowSelfTest | null = publish.self_test
  const need = publish.nodes_requiring_approval
  const isPublished = publishedVersion === publish.version

  useEffect(() => { setApproved(new Set()); setMessage(null) }, [publish.version])

  const test = async (mode: 'dry' | 'test') => {
    setBusy(mode)
    setMessage(null)
    const r = await runFlowSelfTest(flowId, { version: publish.version, mode })
    setBusy(null)
    if (!r.ok) setMessage({ tone: 'alarm', text: r.reason === 'flows_disabled' ? 'Workflows are switched off (settings.flows_enabled).' : `Self-test did not run: ${r.reason ?? 'error'}` })
    onChanged()
  }

  const doPublish = async () => {
    setBusy('publish')
    setMessage(null)
    const r = await publishFlow(flowId, { version: publish.version, approve: [...approved].sort() })
    setBusy(null)
    setMessage(r.ok
      ? { tone: 'verify', text: `v${publish.version} published${r.approvals?.nodes.length ? ` — you approved ${r.approvals.nodes.join(', ')}` : ''}.` }
      : { tone: 'alarm', text: r.error ?? r.reason ?? 'Publish refused' })
    onChanged()
  }

  const green = st?.status === 'passed'
  const allTicked = need.every(n => approved.has(n))
  const blocker = publish.nodes_missing_mocks.length
    ? `Add a mock to ${publish.nodes_missing_mocks.join(', ')} first (every write/send/spend node needs one).`
    : !st ? 'Run a self-test of this version first.'
      : st.status === 'running' ? 'The self-test is still running.'
        : !green ? 'The latest self-test of this version failed.'
          : need.length && !allTicked ? 'Tick every send/spend node to approve it.'
            : null

  return (
    <section className="space-y-2 rounded-md border border-line p-3" data-testid="flow-self-test">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="inline-flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-[0.06em] text-fg-3">
          <FlaskConical className="h-3.5 w-3.5" strokeWidth={1.75} /> Self-test &amp; publish · v{publish.version}
        </h4>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="secondary" loading={busy === 'dry'} disabled={!flowsEnabled || busy !== null} onClick={() => void test('dry')}
            title="No outbound calls: mocks, schema stubs and “would send …”">
            Dry run
          </Button>
          <Button size="sm" variant="ghost" loading={busy === 'test'} disabled={!flowsEnabled || busy !== null} onClick={() => void test('test')}
            title="Reads and the model run live; writes and sends stay stubbed">
            Test (live reads)
          </Button>
        </div>
      </div>

      {!st && <p className="text-[12px] text-fg-2">No self-test of this version yet.</p>}
      {st && (
        <div className="space-y-2 text-[12px]" data-testid="self-test-result">
          <div className="flex flex-wrap items-center gap-2">
            {st.status === 'passed'
              ? <Badge tone="verify" mono><CheckCircle2 className="mr-1 inline h-3 w-3" strokeWidth={2} />passed</Badge>
              : st.status === 'failed'
                ? <Badge tone="alarm" mono><XCircle className="mr-1 inline h-3 w-3" strokeWidth={2} />failed</Badge>
                : <Badge tone="info" mono>running</Badge>}
            <span className="font-mono text-fg-2">#{st.id} · {st.mode} · {st.requested_by} · {relativeTime(st.created_at)} ago</span>
          </div>
          {st.result && st.result.failing_asserts.length > 0 && (
            <div>
              <div className="text-fg-3">End condition failed:</div>
              <ul className="ml-4 list-disc">
                {st.result.failing_asserts.map((a, i) => (
                  <li key={i} className="text-signal-alarm">
                    <code className="font-mono">{a.expr}</code>{a.why ? ` — ${a.why}` : ''} <span className="text-fg-3">(fixture “{a.fixture}”{a.error ? `: ${a.error}` : ''})</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {st.result && st.result.failures.filter(f => f.code !== 'goal_not_met').map((f, i) => (
            <div key={i} className="text-signal-alarm">{f.message}</div>
          ))}
          {st.result && st.result.fixtures.map(fx => (
            <div key={fx.run_id} className="rounded border border-line px-2 py-1.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-fg-0">{fx.name}</span>
                <button type="button" className="font-mono text-accent-hover hover:underline" onClick={() => onOpenRun(fx.run_id)}>run #{fx.run_id}</button>
                <Badge tone={fx.status !== 'succeeded' ? 'alarm' : fx.goal_met === 1 ? 'verify' : 'amber'} mono>
                  {fx.status !== 'succeeded' ? fx.status : fx.goal_met === 1 ? 'goal met' : 'goal not met'}
                </Badge>
                {fx.goal?.judge && <span className="text-fg-3">judge: {fx.goal.judge.status}</span>}
                {fx.spent_usd > 0 && <span className="font-mono text-fg-3">${fx.spent_usd.toFixed(3)}</span>}
              </div>
              {fx.simulated.length > 0 && (
                <ul className="mt-1 space-y-0.5">
                  {fx.simulated.map((s, i) => (
                    <li key={i} className="flex min-w-0 items-baseline gap-2" data-testid="would-step">
                      <Badge tone="amber" mono>{SIM_LABEL[s.simulated] ?? s.simulated}</Badge>
                      <span className="font-mono text-fg-0">{s.node_id}{s.iteration ? `[${s.iteration}]` : ''}</span>
                      <span className="min-w-0 truncate font-mono text-fg-3" title={s.input_preview ?? ''}>{s.input_preview}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="space-y-1.5 border-t border-line pt-2 text-[12px]">
        {isPublished && publish.approvals ? (
          <div className="inline-flex items-center gap-1.5 text-fg-2" data-testid="flow-approval-record">
            <ShieldCheck className="h-3.5 w-3.5 text-signal-verify" strokeWidth={1.75} />
            Published by {publish.approvals.by} {relativeTime(publish.approvals.at)} ago
            {publish.approvals.nodes.length ? <> · approved <span className="font-mono">{publish.approvals.nodes.join(', ')}</span></> : ' · no send/spend nodes'}
          </div>
        ) : (
          <>
            {need.length > 0 && (
              <fieldset className="space-y-1">
                <legend className="text-fg-2">This version sends or spends through these nodes. Approve exactly these to publish:</legend>
                {need.map(n => (
                  <label key={n} className="flex items-center gap-2 font-mono text-fg-0">
                    <input
                      type="checkbox"
                      checked={approved.has(n)}
                      onChange={e => setApproved(prev => {
                        const next = new Set(prev)
                        if (e.target.checked) next.add(n); else next.delete(n)
                        return next
                      })}
                    />
                    {n}
                  </label>
                ))}
              </fieldset>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="primary" loading={busy === 'publish'} disabled={blocker !== null || busy !== null} onClick={() => void doPublish()}>
                Publish v{publish.version}
              </Button>
              {blocker && <span className="text-fg-3">{blocker}</span>}
            </div>
          </>
        )}
        {message && <Alert tone={message.tone} title={message.tone === 'verify' ? 'Published' : 'Not done'}>{message.text}</Alert>}
      </div>
    </section>
  )
}
