import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronRight, ShieldCheck } from 'lucide-react'
import { api } from '../lib/api'
import { Button, Badge } from './ui'
import { StatusDot } from './design/primitives'
import type { Objective, ObjectiveStatus } from '@command-center/shared'

/* ─────────────────────────────────────────────────────────
   StrategyGovernancePanel — the body of the Stage-0 human-confirm
   gate, lifted OUT of the center modal (StrategyGovernance.tsx) so
   it can render both inline (the /strategy/:id governance rail) and
   inside the modal. It owns the governance fetch + resolve flow:
   kill-switch status, budget/usage meters, the pending decision card
   with approve/deny, the spawned-children list, and a collapsed
   decision history. All colour reads from W6 tokens.

   Self-loading by design (so the modal keeps working with no extra
   wiring). Optional callbacks let a host (the detail page) observe
   the loaded data — e.g. to drive a nested board from `children` —
   without a second fetch; they re-fire after a resolve refetch.
   ───────────────────────────────────────────────────────── */

// ── Backend contract (server-implemented; see route docstring) ──
export interface DecisionOption {
  id: string
  label: string
  rationale?: string
  est_cost?: string
}
export interface DecisionRequest {
  kind: 'spawn-next' | 'pivot' | 'stop' | 're-scope'
  decision: string
  evidence: string[]
  options: DecisionOption[]
  recommendation: string
  recommendation_why?: string
  reversible?: boolean
}
export interface DecisionResolution {
  choice: 'approve' | 'deny'
  option_id?: string
  note?: string
  resolved_by?: string
  resolved_at?: string
}
export interface DecisionRow {
  id: number
  objective_id: number
  iteration: number
  verdict: 'pending' | 'pass' | 'fail'
  created_at: string
  request: DecisionRequest
  resolution?: DecisionResolution
}
export interface GovernanceBudget {
  spendUsd: number
  spendCeilingUsd: number
  projectCount: number
  projectCeiling: number
  totalTokens: number
  killSwitchTripped: boolean
  killSwitchReasons: string[]
}
export interface GovernanceData {
  strategy: Objective
  children: Objective[]
  decisions: DecisionRow[]
  pendingDecision: DecisionRow | null
  budget: GovernanceBudget
}

const KIND_LABEL: Record<DecisionRequest['kind'], string> = {
  'spawn-next': 'Spawn next',
  pivot: 'Pivot',
  stop: 'Stop',
  're-scope': 'Re-scope',
}

function statusOf(o: Objective): ObjectiveStatus {
  return o.status
}

/* ─────────────────────────────────────────────────────────
   DecisionAwaitingBadge — the prominent "a gate is parked"
   indicator, reused on the /strategies index rows and atop the
   detail-page rail. Accent-toned + a pulse so a parked decision is
   obvious at a glance.
   ───────────────────────────────────────────────────────── */
export function DecisionAwaitingBadge({ className = '' }: { className?: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border border-[color:var(--accent-line)] bg-accent px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-accent-fg shadow-pop ${className}`}
      title="A strategy decision is parked and awaiting your approval"
    >
      <span className="ok-dot live h-1.5 w-1.5 rounded-full bg-accent-fg" aria-hidden="true" />
      Decision awaiting
    </span>
  )
}

// ── Usage meter ─────────────────────────────────────────────
function UsageMeter({
  label,
  value,
  ceiling,
  format,
}: {
  label: string
  value: number
  ceiling: number
  format: (n: number) => string
}) {
  const pct = ceiling > 0 ? (value / ceiling) * 100 : 0
  const clamped = Math.min(100, Math.max(0, pct))
  // >=100% alarm, >=80% amber, else accent.
  const barTw =
    pct >= 100 ? 'bg-signal-alarm' : pct >= 80 ? 'bg-signal-amber' : 'bg-accent'
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <span className="text-[12.5px] font-medium text-fg-1">{label}</span>
        <span className="font-mono text-[11px] text-fg-2">
          {format(value)} <span className="text-fg-3">/ {format(ceiling)}</span>
        </span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-surface-3">
        <div
          className={`h-full rounded-full transition-[width] duration-fast ease-out ${barTw}`}
          style={{ width: `${clamped}%` }}
        />
      </div>
    </div>
  )
}

interface StrategyGovernancePanelProps {
  objectiveId: number
  /** When provided, renders a close (X) affordance in the header (modal use). */
  onClose?: () => void
  /** Observe the loaded governance payload (fires on initial load + every
   *  refetch, including after a resolve). Lets a host drive a nested board off
   *  `children` without a second fetch. */
  onData?: (data: GovernanceData) => void
  /** Observe load failures (404 missing / 400 not-a-strategy / network). Lets a
   *  host render a page-level not-found instead of just the inline error box. */
  onError?: (message: string) => void
  /** Sizing hook for the root — e.g. `max-h-[88vh]` (modal) or `h-full` (rail). */
  className?: string
}

export function StrategyGovernancePanel({
  objectiveId,
  onClose,
  onData,
  onError,
  className = '',
}: StrategyGovernancePanelProps) {
  const [data, setData] = useState<GovernanceData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Resolve flow state.
  const [resolving, setResolving] = useState(false)
  const [resolveError, setResolveError] = useState<string | null>(null)
  const [denyNote, setDenyNote] = useState('')

  // Disclosure state.
  const [evidenceOpen, setEvidenceOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)

  // Keep host callbacks in refs so `load` stays keyed only on objectiveId — the
  // host can pass inline closures without thrashing the fetch effect.
  const onDataRef = useRef(onData)
  const onErrorRef = useRef(onError)
  useEffect(() => {
    onDataRef.current = onData
    onErrorRef.current = onError
  })

  const load = useCallback(() => {
    setLoading(true)
    setError(null)
    api
      .get<GovernanceData>(`/objectives/${objectiveId}/governance`)
      .then(d => {
        setData(d)
        onDataRef.current?.(d)
      })
      .catch(err => {
        const msg = err instanceof Error ? err.message : 'Failed to load governance'
        setError(msg)
        onErrorRef.current?.(msg)
      })
      .finally(() => setLoading(false))
  }, [objectiveId])

  useEffect(() => {
    load()
  }, [load])

  const pending = data?.pendingDecision ?? null

  const resolve = useCallback(
    async (choice: 'approve' | 'deny', optionId?: string) => {
      if (!pending || resolving) return
      setResolving(true)
      setResolveError(null)
      try {
        await api.post(`/objectives/${objectiveId}/decisions/${pending.id}/resolve`, {
          choice,
          optionId,
          note: denyNote.trim() || undefined,
        })
        setDenyNote('')
        load() // refetch — strategy resumed, decision history updated
      } catch (err) {
        setResolveError(err instanceof Error ? err.message : 'Failed to resolve decision')
      } finally {
        setResolving(false)
      }
    },
    [pending, resolving, objectiveId, denyNote, load],
  )

  const budget = data?.budget
  const strategy = data?.strategy

  return (
    <div className={`flex min-h-0 flex-col ${className}`}>
      {/* ── Header ── */}
      <div className="flex items-start justify-between gap-3 border-b border-line bg-surface-2 px-5 py-3">
        <div className="min-w-0">
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <Badge tone="accent" className="gap-1">
              <ShieldCheck className="h-3 w-3" />
              Strategy
            </Badge>
            {budget &&
              (budget.killSwitchTripped ? (
                <span title={budget.killSwitchReasons.join('; ')}>
                  <Badge tone="alarm" mono>
                    HALTED — {budget.killSwitchReasons.join('; ') || 'kill switch tripped'}
                  </Badge>
                </span>
              ) : (
                <Badge tone="verify">Active</Badge>
              ))}
            {pending && <DecisionAwaitingBadge />}
          </div>
          <h2
            id="strategy-gov-title"
            className="truncate text-[15px] font-semibold tracking-tight text-fg-0"
          >
            {strategy ? strategy.title : 'Strategy Governance'}{' '}
            <span className="font-mono text-[12px] font-normal text-fg-3">#{objectiveId}</span>
          </h2>
        </div>
        {onClose && (
          <button
            onClick={onClose}
            aria-label="Close"
            className="shrink-0 rounded-md p-1.5 text-fg-2 transition-colors duration-fast ease-out hover:bg-surface-3 hover:text-fg-0"
          >
            <ChevronRight className="h-4 w-4 rotate-90" />
          </button>
        )}
      </div>

      {/* ── Body ── */}
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4">
        {loading && <div className="py-8 text-center text-sm text-fg-3">Loading governance…</div>}
        {error && !loading && (
          <div className="rounded-md border border-signal-alarm/30 bg-signal-alarm/10 px-3 py-2 text-sm text-signal-alarm">
            {error}
          </div>
        )}

        {data && budget && !loading && (
          <>
            {/* ── Budget / usage ── */}
            <section>
              <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-fg-3">
                Budget &amp; Usage
              </h3>
              <div className="space-y-3 rounded-md border border-line bg-surface-2 p-3">
                <UsageMeter
                  label="Spend"
                  value={budget.spendUsd}
                  ceiling={budget.spendCeilingUsd}
                  format={n => `$${n.toFixed(2)}`}
                />
                <UsageMeter
                  label="Projects spawned"
                  value={budget.projectCount}
                  ceiling={budget.projectCeiling}
                  format={n => `${n}`}
                />
                <div className="flex items-center justify-between border-t border-line-soft pt-2 text-[12px]">
                  <span className="text-fg-2">Total tokens</span>
                  <span className="font-mono text-fg-1">
                    {budget.totalTokens.toLocaleString()}
                  </span>
                </div>
              </div>
            </section>

            {/* ── Pending decision ── */}
            {pending && (
              <section>
                <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-accent-hover">
                  Pending Decision
                </h3>
                <div className="rounded-md border border-[color:var(--accent-line)] bg-[var(--accent-tint)] p-3">
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <Badge tone="accent">{KIND_LABEL[pending.request.kind]}</Badge>
                    <span className="font-mono text-[11px] text-fg-3">
                      iteration {pending.iteration}
                    </span>
                    {pending.request.reversible != null && (
                      <Badge tone={pending.request.reversible ? 'verify' : 'amber'}>
                        {pending.request.reversible ? 'Reversible' : 'Irreversible'}
                      </Badge>
                    )}
                  </div>

                  <p className="text-[13px] font-medium leading-snug text-fg-0">
                    {pending.request.decision}
                  </p>

                  {/* Evidence — expandable */}
                  {pending.request.evidence.length > 0 && (
                    <div className="mt-3">
                      <button
                        type="button"
                        onClick={() => setEvidenceOpen(o => !o)}
                        aria-expanded={evidenceOpen}
                        className="flex items-center gap-1 text-[12px] font-medium text-fg-2 transition-colors duration-fast ease-out hover:text-fg-1"
                      >
                        <ChevronRight
                          className={`h-3.5 w-3.5 transition-transform ${evidenceOpen ? 'rotate-90' : ''}`}
                        />
                        Evidence ({pending.request.evidence.length})
                      </button>
                      {evidenceOpen && (
                        <ul className="mt-1.5 list-disc space-y-1 pl-7 text-[12px] text-fg-2">
                          {pending.request.evidence.map((e, i) => (
                            <li key={i}>{e}</li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}

                  {/* Options */}
                  {pending.request.options.length > 0 && (
                    <div className="mt-3 space-y-2">
                      {pending.request.options.map(opt => {
                        const recommended = opt.id === pending.request.recommendation
                        return (
                          <div
                            key={opt.id}
                            className={`rounded-md border p-2.5 ${
                              recommended
                                ? 'border-[color:var(--accent-line)] bg-surface-1'
                                : 'border-line bg-surface-1'
                            }`}
                          >
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0">
                                <div className="flex items-center gap-2">
                                  <span className="text-[12.5px] font-medium text-fg-0">
                                    {opt.label}
                                  </span>
                                  {recommended && <Badge tone="accent">Recommended</Badge>}
                                </div>
                                {opt.rationale && (
                                  <p className="mt-0.5 text-[12px] leading-relaxed text-fg-2">
                                    {opt.rationale}
                                  </p>
                                )}
                                {opt.est_cost && (
                                  <p className="mt-0.5 font-mono text-[11px] text-fg-3">
                                    est. {opt.est_cost}
                                  </p>
                                )}
                              </div>
                              <Button
                                size="sm"
                                variant={recommended ? 'primary' : 'secondary'}
                                loading={resolving}
                                disabled={resolving}
                                onClick={() => resolve('approve', opt.id)}
                                className="shrink-0"
                              >
                                Approve
                              </Button>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  )}

                  {pending.request.recommendation_why && (
                    <p className="mt-2 text-[12px] italic leading-relaxed text-fg-2">
                      Why: {pending.request.recommendation_why}
                    </p>
                  )}

                  {/* Deny */}
                  <div className="mt-3 border-t border-line-soft pt-3">
                    <label className="mb-1 block text-[12px] font-medium text-fg-2">
                      Deny note (optional)
                    </label>
                    <textarea
                      value={denyNote}
                      onChange={e => setDenyNote(e.target.value)}
                      rows={2}
                      disabled={resolving}
                      placeholder="Why are you denying / what should change?"
                      className="w-full resize-none rounded-md border border-line-strong bg-surface-3 px-3 py-2 text-[13px] text-fg-0 placeholder-fg-3 outline-none transition-colors duration-fast ease-out focus:border-accent disabled:opacity-50"
                    />
                    <div className="mt-2 flex items-center justify-between gap-2">
                      {resolveError ? (
                        <span className="text-[12px] text-signal-alarm">{resolveError}</span>
                      ) : (
                        <span />
                      )}
                      <Button
                        size="sm"
                        variant="danger"
                        loading={resolving}
                        disabled={resolving}
                        onClick={() => resolve('deny')}
                      >
                        Deny
                      </Button>
                    </div>
                  </div>
                </div>
              </section>
            )}

            {/* ── Spawned children ── */}
            <section>
              <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-fg-3">
                Spawned Projects ({data.children.length})
              </h3>
              {data.children.length === 0 ? (
                <div className="rounded-md border border-dashed border-line bg-surface-2 px-3 py-4 text-center text-[12px] text-fg-3">
                  No projects spawned yet.
                </div>
              ) : (
                <ul className="space-y-1.5">
                  {data.children.map(child => (
                    <li
                      key={child.id}
                      className="flex items-center gap-2 rounded-md border border-line bg-surface-2 px-3 py-2"
                    >
                      <StatusDot status={statusOf(child)} size={8} />
                      <span className="font-mono text-[11px] text-fg-3">#{child.id}</span>
                      <span className="min-w-0 flex-1 truncate text-[12.5px] text-fg-1">
                        {child.title}
                      </span>
                      {Number(child.total_cost_usd) > 0 && (
                        <span className="shrink-0 font-mono text-[11px] text-fg-2">
                          ${Number(child.total_cost_usd).toFixed(2)}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {/* ── Decision history ── */}
            {data.decisions.length > 0 && (
              <section>
                <button
                  type="button"
                  onClick={() => setHistoryOpen(o => !o)}
                  aria-expanded={historyOpen}
                  className="flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wider text-fg-3 transition-colors duration-fast ease-out hover:text-fg-2"
                >
                  <ChevronRight
                    className={`h-3.5 w-3.5 transition-transform ${historyOpen ? 'rotate-90' : ''}`}
                  />
                  Decision History ({data.decisions.length})
                </button>
                {historyOpen && (
                  <ul className="mt-2 space-y-1.5">
                    {data.decisions.map(d => (
                      <li
                        key={d.id}
                        className="flex items-start gap-2 rounded-md border border-line bg-surface-2 px-3 py-2"
                      >
                        {d.verdict === 'pass' ? (
                          <Badge tone="verify">Approved</Badge>
                        ) : d.verdict === 'fail' ? (
                          <Badge tone="alarm">Denied</Badge>
                        ) : (
                          <Badge tone="amber">Pending</Badge>
                        )}
                        <Badge tone="neutral">{KIND_LABEL[d.request.kind]}</Badge>
                        <span className="min-w-0 flex-1 text-[12px] leading-snug text-fg-2">
                          {d.request.decision}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            )}
          </>
        )}
      </div>
    </div>
  )
}
