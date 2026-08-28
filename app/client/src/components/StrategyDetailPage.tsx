import { useCallback, useMemo, useState } from 'react'
import { ShieldCheck, ChevronLeft } from 'lucide-react'
import {
  OBJECTIVE_STATUSES,
  type Objective,
  type ObjectiveStatus,
  type Workspace,
} from '@command-center/shared'
import { useObjectives } from '../hooks/useObjectives'
import { useIsBoardMobile } from '../hooks/useMediaQuery'
import { boardColumnOf, orderBoardColumns } from '../lib/boardColumns'
import { groupObjectives } from '../lib/groupObjectives'
import { scopeObjectives } from '../lib/scopeObjectives'
import { useNavigate } from '../context/nav'
import { KanbanColumn } from './KanbanColumn'
import { SessionViewer } from './SessionViewer'
import { StrategyGovernancePanel, type GovernanceData } from './StrategyGovernancePanel'
import { Skeleton } from './ui'
import './board.css'

/* ─────────────────────────────────────────────────────────
   StrategyDetailPage — the /strategy/:id surface (UI-B / obj 700134).
   Two regions:
     (a) a NESTED Kanban board of ONLY this strategy's child objectives
         (reusing KanbanColumn + ObjectiveCard, grouped by pipeline
         status exactly like the main board), and
     (b) a PERSISTENT inline governance rail (the extracted
         <StrategyGovernancePanel>: pending decision approve/deny,
         budget + kill-switch meters, child list, decision history).

   Children are the strategy's managed objectives: strategy_id === id OR
   a direct child (parent_id === id) — mirroring the backend governance
   endpoint's parent-chain ownership. Sourced from the live workspace
   list so status changes + WebSocket updates reflect immediately.

   Graceful not-found: a non-numeric id, or a governance load error
   (404 missing / 400 not-a-strategy), renders a friendly empty screen
   instead of crashing.
   ───────────────────────────────────────────────────────── */

interface StrategyDetailPageProps {
  workspace: Workspace
}

function parseStrategyId(pathname: string): number | null {
  const m = pathname.match(/^\/strategy\/(\d+)\/?$/)
  if (!m) return null
  const n = Number(m[1])
  return Number.isFinite(n) ? n : null
}

export function StrategyDetailPage({ workspace }: StrategyDetailPageProps) {
  const navigate = useNavigate()
  const strategyId = parseStrategyId(window.location.pathname)

  const {
    objectives: rawObjectives, loading, changeStatus,
  } = useObjectives(workspace)

  // Render-time workspace scope gate (obj 700082): never derive this strategy's
  // header/children from another org's rows, however they entered state (WS race,
  // workspace-switch lag). Pure + race-free — mirrors KanbanBoard.
  const objectives = useMemo(
    () => scopeObjectives(rawObjectives, workspace),
    [rawObjectives, workspace],
  )

  const [govData, setGovData] = useState<GovernanceData | null>(null)
  const [govError, setGovError] = useState<string | null>(null)
  const [sessionObjective, setSessionObjective] = useState<Objective | null>(null)
  const [pendingStatusId, setPendingStatusId] = useState<number | null>(null)
  const [statusError, setStatusError] = useState<string | null>(null)

  // The strategy row itself (for the header). Prefer the governance payload
  // (authoritative) and fall back to the live list.
  const strategy = useMemo(
    () => govData?.strategy ?? objectives.find(o => o.id === strategyId) ?? null,
    [govData, objectives, strategyId],
  )

  // This strategy's managed children, drawn from the live workspace list so the
  // board reacts to WebSocket updates and optimistic status changes.
  const children = useMemo(() => {
    if (strategyId == null) return []
    return objectives.filter(
      o => !o.is_strategy && (o.strategy_id === strategyId || o.parent_id === strategyId),
    )
  }, [objectives, strategyId])

  // Full nesting map (computed across everything) so a child card that is itself
  // a delegator still shows its own worker rollup.
  const childrenByParent = useMemo(() => groupObjectives(objectives).childrenByParent, [objectives])

  const grouped = useMemo(() => {
    const map: Record<ObjectiveStatus, Objective[]> = {
      planning: [], queue: [], working: [], ai_review: [], review: [], done: [], cancelled: [],
    }
    for (const obj of children) {
      const col = boardColumnOf(obj, childrenByParent.get(obj.id))
      map[col]?.push(obj)
    }
    return map
  }, [children, childrenByParent])

  const isMobile = useIsBoardMobile()
  const visibleColumns = useMemo(() => {
    const optional: ObjectiveStatus[] = ['planning', 'ai_review', 'review']
    const cols = OBJECTIVE_STATUSES.filter(s => !optional.includes(s) || grouped[s].length > 0)
    return orderBoardColumns(cols, isMobile)
  }, [grouped, isMobile])

  const handleChangeStatus = useCallback(
    async (id: number, status: ObjectiveStatus) => {
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
    [changeStatus],
  )

  const handleOpenChild = useCallback((objective: Objective) => {
    setSessionObjective(objective)
  }, [])

  // ── Not-found / invalid id ──
  if (strategyId == null || govError) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 bg-surface-0 px-6 text-center">
        <ShieldCheck className="h-9 w-9 text-fg-3" />
        <h1 className="text-[16px] font-semibold text-fg-0">Strategy not found</h1>
        <p className="max-w-md text-[13px] leading-relaxed text-fg-3">
          {strategyId == null
            ? 'That URL does not point to a valid strategy.'
            : govError || 'This objective is not a strategy, or no longer exists.'}
        </p>
        <button
          type="button"
          onClick={() => navigate('/strategies')}
          className="mt-1 inline-flex items-center gap-1.5 rounded-md border border-line bg-surface-2 px-3 py-1.5 text-[13px] text-fg-1 transition-colors duration-fast ease-out hover:border-line-strong hover:text-fg-0"
        >
          <ChevronLeft className="h-4 w-4" />
          All strategies
        </button>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col bg-surface-0">
      {/* ── Header ── */}
      <div className="flex items-center gap-2.5 border-b border-line-soft bg-surface-0 px-4 py-2.5 sm:px-5">
        <button
          type="button"
          onClick={() => navigate('/strategies')}
          aria-label="Back to strategies"
          className="inline-flex items-center gap-1 rounded-md border border-line bg-surface-2 px-2 py-1 text-[12px] text-fg-2 transition-colors duration-fast ease-out hover:border-line-strong hover:text-fg-0"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
          Strategies
        </button>
        <ShieldCheck className="h-4 w-4 text-accent" />
        <h1 className="min-w-0 truncate text-[15px] font-semibold tracking-tight text-fg-0">
          {strategy ? strategy.title : (loading ? 'Loading…' : `Strategy #${strategyId}`)}
        </h1>
        <span className="font-mono text-[12px] text-fg-3">#{strategyId}</span>
      </div>

      {statusError && (
        <div className="border-b border-line-soft bg-surface-0 px-4 py-1.5 sm:px-5">
          <span className="rounded-md border border-line bg-surface-1 px-3 py-1 text-xs text-[color:var(--ok-alarm)]">
            {statusError}
          </span>
        </div>
      )}

      {/* ── Body: nested board + persistent governance rail ── */}
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        {/* Nested board */}
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
          {loading ? (
            <div className="grid grid-cols-3 gap-3 p-4">
              {[0, 1, 2].map(i => (
                <Skeleton key={i} className="h-40 w-full rounded-md" />
              ))}
            </div>
          ) : children.length === 0 ? (
            <div className="m-4 rounded-md border border-dashed border-line bg-surface-1 px-6 py-10 text-center">
              <p className="text-sm font-medium text-fg-1">No managed projects yet</p>
              <p className="mt-1 text-[13px] text-fg-3">
                This strategy hasn’t spawned any sub-objectives. Decisions appear in the governance
                rail when it’s ready to act.
              </p>
            </div>
          ) : (
            <div className="ok-board" style={{ ['--ok-cols' as string]: visibleColumns.length }}>
              {visibleColumns.map(status => (
                <KanbanColumn
                  key={status}
                  status={status}
                  objectives={grouped[status]}
                  onOpenTerminal={handleOpenChild}
                  onCardEdit={handleOpenChild}
                  onChangeStatus={handleChangeStatus}
                  pendingId={pendingStatusId}
                  childrenByParent={childrenByParent}
                />
              ))}
            </div>
          )}
        </div>

        {/* Governance rail — persistent, not a modal */}
        <aside className="min-h-0 w-full shrink-0 border-t border-line bg-surface-1 lg:w-[380px] lg:border-l lg:border-t-0">
          <StrategyGovernancePanel
            objectiveId={strategyId}
            onData={setGovData}
            onError={setGovError}
            className="h-full"
          />
        </aside>
      </div>

      {sessionObjective && (
        <SessionViewer
          objective={sessionObjective}
          onClose={() => setSessionObjective(null)}
          onChangeStatus={handleChangeStatus}
        />
      )}
    </div>
  )
}
