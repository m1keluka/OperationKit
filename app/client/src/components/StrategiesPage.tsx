import { useEffect, useMemo, useState } from 'react'
import { ShieldCheck, ChevronRight } from 'lucide-react'
import type { Objective, Workspace } from '@command-center/shared'
import { api } from '../lib/api'
import { scopeObjectives } from '../lib/scopeObjectives'
import { useNavigate } from '../context/nav'
import { useObjectives } from '../hooks/useObjectives'
import { Badge, Skeleton } from './ui'
import { DecisionAwaitingBadge } from './StrategyGovernancePanel'

/* ─────────────────────────────────────────────────────────
   StrategiesPage — the /strategies INDEX (UI-B / obj 700134).
   Lists every Strategy (is_strategy=1) for the active workspace as a
   rich, clickable row: title + north-star, trust stage, child-project
   counts, spend vs ceiling, and a prominent "decision awaiting" badge
   when a gate is parked. A row navigates (SPA) to /strategy/:id.

   Rollups: each strategy carries an optional `rollup` (added server-side
   by sibling worker UI-A). When present we render its authoritative
   counts/budget/pendingDecisionId. When ABSENT (UI-A not merged yet) we
   degrade gracefully — child counts are derived client-side from the
   workspace objective list, budget/decision are simply omitted. Never
   crashes on a missing rollup.
   ───────────────────────────────────────────────────────── */

interface StrategyRollup {
  children: { total: number; done: number; working: number; queued: number; review: number }
  budget?: {
    spendUsd: number
    spendCeilingUsd: number
    projectCount: number
    projectCeiling: number
    killSwitchTripped: boolean
  }
  pendingDecisionId: number | null
}

type StrategyRow = Objective & { rollup?: StrategyRollup }

const TRUST_STAGE_LABEL: Record<number, string> = {
  0: 'Full-gate',
  1: 'Partial-autonomy',
  2: 'Supervised',
  3: 'Autonomous',
}

interface CountSet {
  total: number
  done: number
  working: number
  queued: number
  review: number
}

// Bucket a child objective's pipeline status into the rollup count groups.
function bucketCounts(children: Objective[]): CountSet {
  const c: CountSet = { total: children.length, done: 0, working: 0, queued: 0, review: 0 }
  for (const o of children) {
    if (o.status === 'done') c.done++
    else if (o.status === 'working' || o.status === 'ai_review') c.working++
    else if (o.status === 'review') c.review++
    else c.queued++ // queue + planning
  }
  return c
}

function CountChip({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <span className="inline-flex items-center gap-1 font-mono text-[11px] text-fg-2">
      <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: tone }} aria-hidden="true" />
      <span className="font-semibold text-fg-1">{value}</span>
      {label}
    </span>
  )
}

interface StrategiesPageProps {
  workspace: Workspace
}

export function StrategiesPage({ workspace }: StrategiesPageProps) {
  const navigate = useNavigate()
  const [strategies, setStrategies] = useState<StrategyRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Full workspace objective list — used only to derive child counts when a
  // strategy row arrives without a server-computed rollup. Render-time scope gate
  // (obj 700082) so counts can never include another org's rows if state goes
  // dirty (WS race / workspace-switch lag). Pure + race-free; mirrors KanbanBoard.
  const { objectives: rawObjectives } = useObjectives(workspace)
  const objectives = useMemo(
    () => scopeObjectives(rawObjectives, workspace),
    [rawObjectives, workspace],
  )

  useEffect(() => {
    setLoading(true)
    setError(null)
    const params = workspace && workspace !== 'all' ? `?workspace=${workspace}` : ''
    api
      .get<StrategyRow[]>(`/objectives/strategies${params}`)
      .then(rows => setStrategies(rows))
      .catch(err => setError(err instanceof Error ? err.message : 'Failed to load strategies'))
      .finally(() => setLoading(false))
  }, [workspace])

  // Pre-index children by strategy for the degrade path (no rollup): an
  // objective belongs to a strategy when strategy_id matches OR it's a direct
  // child (parent_id) of the strategy.
  const childrenByStrategy = useMemo(() => {
    const map = new Map<number, Objective[]>()
    for (const o of objectives) {
      if (o.is_strategy) continue
      const sid = o.strategy_id ?? null
      const keys = new Set<number>()
      if (sid != null) keys.add(sid)
      if (o.parent_id != null) keys.add(o.parent_id)
      for (const k of keys) {
        const arr = map.get(k) || []
        arr.push(o)
        map.set(k, arr)
      }
    }
    return map
  }, [objectives])

  if (loading) {
    return (
      <div className="h-full overflow-y-auto bg-surface-0 px-4 py-5 sm:px-6">
        <div className="mx-auto max-w-4xl space-y-3">
          <Skeleton className="h-7 w-40" />
          {[0, 1, 2].map(i => (
            <Skeleton key={i} className="h-[72px] w-full rounded-md" />
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="h-full overflow-y-auto bg-surface-0 px-4 py-5 sm:px-6">
      <div className="mx-auto max-w-4xl">
        {/* ── Header ── */}
        <div className="mb-4 flex items-center gap-2">
          <ShieldCheck className="h-5 w-5 text-accent" />
          <h1 className="text-[17px] font-semibold tracking-tight text-fg-0">Strategies</h1>
          <span className="font-mono text-[12px] text-fg-3">{strategies.length}</span>
        </div>

        {error && (
          <div className="mb-3 rounded-md border border-signal-alarm/30 bg-signal-alarm/10 px-3 py-2 text-sm text-signal-alarm">
            {error}
          </div>
        )}

        {/* ── Empty state ── */}
        {!error && strategies.length === 0 ? (
          <div className="rounded-md border border-dashed border-line bg-surface-1 px-6 py-12 text-center">
            <ShieldCheck className="mx-auto mb-3 h-8 w-8 text-fg-3" />
            <p className="text-sm font-medium text-fg-1">No strategies yet</p>
            <p className="mx-auto mt-1 max-w-md text-[13px] leading-relaxed text-fg-3">
              A strategy is a persistent top-tier objective that owns sub-projects and decides what
              to spawn next. Create one by checking “Strategy” when adding a new objective.
            </p>
          </div>
        ) : (
          <ul className="space-y-2">
            {strategies.map(s => {
              const counts: CountSet = s.rollup?.children ?? bucketCounts(childrenByStrategy.get(s.id) ?? [])
              const budget = s.rollup?.budget
              const pending = s.rollup?.pendingDecisionId != null
              const stage = s.trust_stage ?? 0
              const halted = budget?.killSwitchTripped
              return (
                <li key={s.id}>
                  <button
                    type="button"
                    onClick={() => navigate(`/strategy/${s.id}`)}
                    className="group flex w-full items-center gap-4 rounded-md border border-line bg-surface-2 px-4 py-3 text-left outline-none transition-colors duration-fast ease-out hover:border-line-strong hover:bg-surface-3 focus-visible:ring-2 focus-visible:ring-accent/50"
                  >
                    {/* Title + north-star + meta */}
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate text-[14px] font-semibold text-fg-0">{s.title}</span>
                        <span className="font-mono text-[11px] text-fg-3">#{s.id}</span>
                        <Badge tone={stage >= 2 ? 'verify' : stage === 1 ? 'amber' : 'neutral'}>
                          Stage {stage} · {TRUST_STAGE_LABEL[stage] ?? 'Full-gate'}
                        </Badge>
                        {halted && (
                          <Badge tone="alarm" mono>
                            HALTED
                          </Badge>
                        )}
                        {pending && <DecisionAwaitingBadge />}
                      </div>
                      {s.completion_goal && (
                        <p className="mt-1 line-clamp-1 text-[12.5px] leading-snug text-fg-2">
                          {s.completion_goal}
                        </p>
                      )}
                      <div className="mt-2 flex flex-wrap items-center gap-x-3.5 gap-y-1">
                        <CountChip label="done" value={counts.done} tone="var(--ok-verify)" />
                        <CountChip label="running" value={counts.working} tone="var(--accent)" />
                        <CountChip label="needs you" value={counts.review} tone="var(--ok-amber)" />
                        <CountChip label="queued" value={counts.queued} tone="var(--fg-3)" />
                        <span className="font-mono text-[11px] text-fg-3">{counts.total} total</span>
                        {budget && (
                          <span className="font-mono text-[11px] text-fg-2">
                            <span className="font-semibold text-fg-1">${budget.spendUsd.toFixed(2)}</span>
                            <span className="text-fg-3"> / ${budget.spendCeilingUsd.toFixed(2)}</span> spend
                          </span>
                        )}
                      </div>
                    </div>
                    <ChevronRight className="h-4 w-4 shrink-0 text-fg-3 transition-transform duration-fast ease-out group-hover:translate-x-0.5 group-hover:text-fg-1" />
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}
