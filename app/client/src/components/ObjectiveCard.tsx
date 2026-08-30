import { useState, memo } from 'react'
import { Pencil, ExternalLink, ShieldCheck, Clock, User as UserIcon } from 'lucide-react'
import type { Objective, ObjectiveStatus } from '@operationkit/shared'
import { STRATEGY_BADGE, ORIGIN_BADGES, isInFlightStatus } from '@operationkit/shared'
import { relativeTime } from '../lib/time'
import { getAgentMeta, AIReviewDots, BlockedFlag } from './design/primitives'
import { StatusGlyph } from './StatusGlyph'
import { WorkerRollup } from './WorkerRollup'
import { Button } from './ui'
import { StrategyGovernance } from './StrategyGovernance'

/* ─────────────────────────────────────────────────────────
   ObjectiveCard — Mission Control (Direction A) rebuild.
   Left agent-identity tile (coloured per --agent-<role>) + body:
   circular status glyph beside the title, two mono meta rows
   (#id · branch · sessions · $cost · live  /  PR · model · ws),
   an optional worker-rollup bar for delegators, and a hover/
   mobile-persistent action cluster (View · primary action).
   All colour comes from W6 tokens; machine data is Geist Mono.
   ───────────────────────────────────────────────────────── */

const STATUS_ACTIONS: Record<ObjectiveStatus, { label: string; target: ObjectiveStatus; variant: 'primary' | 'secondary' }[]> = {
  planning:  [{ label: 'Skip Planning', target: 'queue',   variant: 'secondary' }],
  queue:     [{ label: 'Start',         target: 'working', variant: 'primary' }],
  working:   [{ label: 'Done',          target: 'done',    variant: 'primary' }],
  ai_review: [],
  review:    [
    { label: 'Approve', target: 'done',    variant: 'primary' },
    { label: 'Rework',  target: 'working', variant: 'secondary' },
  ],
  done:      [{ label: 'Re-Open', target: 'working', variant: 'secondary' }],
  // obj 700595 — a soft-retired card can be reopened by hand (cancelled → queue).
  cancelled: [{ label: 'Re-Open', target: 'queue', variant: 'secondary' }],
}

/* Positive model-attribution badge (obj 701053). Short labels for the badge
   chip; unknown ids fall back to the raw model id. */
const MODEL_SHORT_LABEL: Record<string, string> = {
  'claude-fable-5': 'Fable 5',
  'claude-opus-4-8': 'Opus 4.8',
  'claude-sonnet-4-6': 'Sonnet 4.6',
  'claude-haiku-4-5-20251001': 'Haiku 4.5',
}

/** True when the transcript-derived main-loop attribution confirms the
 *  objective's requested model actually ran (and no fallback was flagged). */
function ranOnRequestedModel(o: Objective): boolean {
  if (!o.model || !o.ran_model) return false
  // Only premium-model (Fable) selections get the positive confirmation chip —
  // stamping ✓ on every default-model card would be board-wide noise.
  if (!o.model.includes('fable')) return false
  return o.ran_model.split(',').includes(o.model)
}

interface ObjectiveCardProps {
  objective: Objective
  onOpenTerminal: (objective: Objective) => void
  onEdit: (objective: Objective) => void
  onChangeStatus: (id: number, status: ObjectiveStatus) => void
  /** True while a status PATCH for THIS card is in flight (OK-7): action
      buttons show a spinner + disable so a second click can't double-submit. */
  pending?: boolean
  /** Worker objectives nested under this card (delegator mode only). */
  children?: Objective[]
}

function ObjectiveCardImpl({ objective, onOpenTerminal, onEdit, onChangeStatus, pending = false, children }: ObjectiveCardProps) {
  // Strategy governance overlay (Stage-0 human-confirm gate) — only strategies
  // surface the entry point. is_strategy is now an EXPLICIT stored marker (obj
  // 2835); derive purely from it, never from delegate_mode/parent_id inference.
  const [govOpen, setGovOpen] = useState(false)
  const isStrategy = !!objective.is_strategy

  const isActive =
    (objective.status === 'working' || objective.status === 'review' || objective.status === 'ai_review') &&
    objective.session_id !== null

  const hasAnyThread =
    objective.session_id !== null ||
    objective.planning_session_id !== null ||
    objective.ai_review_session_id !== null ||
    Number(objective.session_count) > 0
  const opensViewer = isActive || objective.status === 'planning' || hasAnyThread

  // Delegator orchestration: in-flight workers mean the parent is waiting on
  // the machine, not the human. A parent already in `review` is human-owned
  // (fireWake will not auto-wake) — keep review actions visible (obj 704132).
  const pendingWorkers = objective.delegate_mode ? (children?.filter(w => w.status !== 'done').length ?? 0) : 0
  const runningWorkers = objective.delegate_mode ? (children?.filter(w => w.status === 'working' && w.session_id).length ?? 0) : 0
  const readyWorkers = objective.delegate_mode ? (children?.filter(w => w.status === 'review' || w.status === 'ai_review').length ?? 0) : 0
  const inFlightWorkers = objective.delegate_mode
    ? (children?.filter(w => isInFlightStatus(w.status)).length ?? 0)
    : 0
  const orchestrating = !!objective.delegate_mode && inFlightWorkers > 0 && objective.status !== 'review'
  const orchestratingLabel = readyWorkers > 0
    ? `${readyWorkers} to process`
    : runningWorkers > 0
      ? `${runningWorkers} running`
      : `${pendingWorkers} pending`

  // Glyph reflects what the card is really doing — an orchestrating delegator
  // reads as `working` (it lives in the Working column between wakes).
  const glyphStatus: ObjectiveStatus = orchestrating ? 'working' : objective.status
  const actions = orchestrating ? [] : (STATUS_ACTIONS[objective.status] || [])

  const agent = getAgentMeta(objective.agent_context)
  const isBlocked = !!objective.has_blockers && !objective.session_id
  const aiIter = objective.ai_review_iteration ?? 0
  const showAIDots = (objective.status === 'ai_review' || aiIter > 0) && aiIter > 0

  // Mono meta — machine data only. Omit fields the record doesn't carry.
  const sessions = Number(objective.session_count)
  const cost = Number(objective.total_cost_usd)

  // Last activity = the last time the agent side did/sent something (obj 700857).
  // Denormalized as last_activity_at on the board payload; fall back to
  // updated_at when the objective has never had session activity.
  const lastActivityIso = objective.last_activity_at ?? objective.updated_at
  const lastActivityLabel = relativeTime(lastActivityIso)
  // Assignee usernames (primary first), resolved server-side into
  // assigned_usernames alongside assigned_user_ids.
  const assignees = objective.assigned_usernames ?? []

  const open = () => (opensViewer ? onOpenTerminal(objective) : onEdit(objective))

  return (
    <article
      className="ok-card cc-land group relative flex cursor-pointer gap-2.5 rounded-md border border-line bg-surface-2 p-[11px] transition-colors duration-fast ease-out hover:border-line-strong hover:bg-surface-3"
      onClick={open}
    >
      {/* Action cluster — hover-reveal (desktop) / persistent row (mobile) */}
      <div className="ok-cact" onClick={e => e.stopPropagation()}>
        <button
          onClick={open}
          className="inline-flex items-center whitespace-nowrap rounded-sm border border-line-strong bg-surface-1 px-2 py-0.5 font-mono text-[11px] text-fg-1 transition-colors duration-fast ease-out hover:border-fg-3 hover:text-fg-0"
        >
          {objective.status === 'planning' ? 'Plan' : 'View'}
        </button>
        {!orchestrating && actions.map(action => (
          <Button
            key={action.target}
            size="sm"
            variant={action.variant}
            loading={pending}
            onClick={() => onChangeStatus(objective.id, action.target)}
            className="h-auto whitespace-nowrap rounded-sm px-2 py-0.5 font-mono text-[11px] font-normal"
          >
            {action.label}
          </Button>
        ))}
        <button
          onClick={() => onEdit(objective)}
          aria-label="Edit objective"
          className="inline-flex items-center rounded-sm border border-line-strong bg-surface-1 px-1.5 py-0.5 text-fg-3 transition-colors duration-fast ease-out hover:border-fg-3 hover:text-fg-1"
        >
          <Pencil className="h-3 w-3" />
        </button>
        {isStrategy && (
          <button
            onClick={() => setGovOpen(true)}
            aria-label="Strategy governance"
            title="Strategy governance — children, decisions, budget"
            className="inline-flex items-center rounded-sm border border-line-strong bg-surface-1 px-1.5 py-0.5 text-fg-3 transition-colors duration-fast ease-out hover:border-fg-3 hover:text-fg-1"
          >
            <ShieldCheck className="h-3 w-3" />
          </button>
        )}
      </div>

      {govOpen && (
        <StrategyGovernance objectiveId={objective.id} onClose={() => setGovOpen(false)} />
      )}

      {/* Agent identity tile */}
      <span
        className={`ok-tile ${agent.tw} flex h-[26px] w-[26px] flex-shrink-0 items-center justify-center rounded-sm font-mono text-[10.5px] font-semibold tracking-[0.02em] text-surface-0`}
        aria-label={`agent ${objective.agent_context || 'general'}`}
      >
        {agent.mono}
      </span>

      {/* Body */}
      <div className="ok-cbody min-w-0 flex-1">
        {/* Title row — status glyph + title (title is a real button for keyboard
            operability + a focus-visible ring; OK-30). */}
        <div className="flex items-center gap-[7px] md:pr-16">
          <StatusGlyph status={glyphStatus} size={13} />
          <button
            type="button"
            onClick={e => { e.stopPropagation(); open() }}
            className="min-w-0 flex-1 truncate rounded-sm text-left text-[13px] font-medium leading-snug tracking-[-0.01em] text-fg-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
          >
            {objective.title}
          </button>
        </div>

        {/* Optional summary — one quiet line */}
        {(objective.last_session_summary || objective.description) && (
          <p className="mt-1 line-clamp-1 text-[12px] leading-relaxed text-fg-2">
            {objective.last_session_summary || objective.description}
          </p>
        )}

        {/* Meta row 1 — mono machine data */}
        <div className="mt-[7px] flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[11px] text-fg-3">
          <span className="text-fg-2">#{objective.id}</span>
          {objective.branch_name && <span className="max-w-[150px] truncate">{objective.branch_name}</span>}
          {sessions > 0 && <span>{sessions} sess</span>}
          {cost > 0 && <span>${cost.toFixed(2)}</span>}
          {lastActivityLabel && (
            <span
              className="inline-flex items-center gap-1"
              title={`Last activity: ${new Date(lastActivityIso).toLocaleString()}`}
            >
              <Clock className="h-3 w-3 opacity-70" aria-hidden="true" />
              Active {lastActivityLabel} ago
            </span>
          )}
          {assignees.length > 0 ? (
            <span className="inline-flex items-center gap-1 text-fg-2" title={`Assigned to ${assignees.join(', ')}`}>
              <UserIcon className="h-3 w-3 opacity-70" aria-hidden="true" />
              {assignees.join(', ')}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 text-fg-3/70" title="Unassigned">
              <UserIcon className="h-3 w-3 opacity-60" aria-hidden="true" />
              Unassigned
            </span>
          )}
          {isActive && (
            <span className="inline-flex items-center gap-1 text-status-done">
              <span className="ok-dot live" style={{ ['--c' as string]: 'var(--ok-verify)' }} aria-hidden="true" />
              live
            </span>
          )}
        </div>

        {/* Meta row 2 — tags */}
        {(objective.is_strategy || (objective.origin && ORIGIN_BADGES[objective.origin]) || objective.pr_number || objective.model || objective.workspace) && (
          <div className="mt-[7px] flex flex-wrap items-center gap-2 font-mono text-[10.5px]">
            {objective.is_strategy && (
              <span
                className={`rounded-full border px-1.5 py-px font-semibold tracking-[0.04em] ${STRATEGY_BADGE.cls}`}
                title={STRATEGY_BADGE.description}
              >
                {STRATEGY_BADGE.label}
              </span>
            )}
            {/* Provenance (obj 2386): strategy-invoked / routine / job-reply each
                get a chip; manual is the unmarked baseline. A Strategy itself
                already shows the STRATEGY badge above, so skip the redundant
                origin chip on a row that is itself a Strategy. */}
            {!objective.is_strategy && objective.origin && ORIGIN_BADGES[objective.origin] && (
              <span
                className={`rounded-full border px-1.5 py-px font-semibold tracking-[0.04em] ${ORIGIN_BADGES[objective.origin].cls}`}
                title={ORIGIN_BADGES[objective.origin].description}
              >
                {ORIGIN_BADGES[objective.origin].label}
              </span>
            )}
            {objective.pr_url && objective.pr_number != null && (
              <a
                href={objective.pr_url}
                target="_blank"
                rel="noopener noreferrer"
                onClick={e => e.stopPropagation()}
                className="inline-flex items-center gap-1 rounded-full border px-1.5 py-px text-[color:var(--accent-hover)] [border-color:var(--accent-line)] hover:[border-color:var(--accent-hover)]"
              >
                PR #{objective.pr_number}
                <ExternalLink className="h-2.5 w-2.5 opacity-60" />
              </a>
            )}
            {objective.model && (
              <span className="rounded-full border border-line px-1.5 py-px text-fg-2">{objective.model}</span>
            )}
            {/* Durable fallback attribution: the requested model wasn't what
                actually ran — flag it so an operator doesn't mistake fallback
                output for the requested model. */}
            {objective.ran_on_fallback ? (
              <span
                className="rounded-full border border-amber-500/50 px-1.5 py-px font-semibold text-amber-500"
                title={`The main agentic loop actually ran on the fallback model, not the requested ${objective.model}.${objective.ran_model ? ` Main-loop models observed: ${objective.ran_model}.` : ''}${objective.fallback_detected_at ? ` Detected ${objective.fallback_detected_at}.` : ''}`}
              >
                Fallback ⚠
              </span>
            ) : (
              /* Positive transcript-derived attribution (obj 701053): confirm the
                 requested model's main loop actually ran on it — without this the
                 only Fable signal was the negative fallback warning, so a clean
                 Fable run was indistinguishable from "no telemetry". */
              ranOnRequestedModel(objective) && (
                <span
                  className="rounded-full border border-emerald-500/50 px-1.5 py-px font-semibold text-emerald-500"
                  title={`Transcript-verified: the main agentic loop ran on ${objective.model}. Main-loop models observed: ${objective.ran_model}. Sub-agents/helpers may use other models by design.`}
                >
                  {MODEL_SHORT_LABEL[objective.model as string] ?? objective.model} ✓
                </span>
              )
            )}
            {objective.workspace && (
              <span className="rounded-full border border-line px-1.5 py-px text-fg-2">{objective.workspace}</span>
            )}
          </div>
        )}

        {/* Sub-objective rollup. Canonical noun = "Sub-objective"; under an active
            delegator (Strategy/delegate_mode) the synonym "Workers" is shown since
            those children are being executed by worker sessions. See
            docs/terminology-glossary.md. */}
        {children && children.length > 0 && (
          <WorkerRollup
            workers={children}
            onOpenWorker={onOpenTerminal}
            label={
              objective.delegate_mode
                ? 'Workers'
                : children.every(c => /^\s*\[review\]/i.test(c.title) || c.workflow_hint === 'adversarial')
                  ? 'Review'
                  : 'Sub-objectives'
            }
          />
        )}

        {/* Footer — AI dots / blocked / orchestrating state */}
        {(showAIDots || isBlocked || orchestrating) && (
          <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1">
            {showAIDots && <AIReviewDots iteration={aiIter} verdict={objective.ai_review_verdict} />}
            {orchestrating && (
              <span
                className="inline-flex items-center gap-1.5 font-mono text-[11px] text-accent"
                title="Orchestrating workers — auto-wakes to process finished ones. Not waiting on you."
              >
                <span className="ok-dot live" style={{ ['--c' as string]: 'var(--accent)' }} aria-hidden="true" />
                orchestrating · {orchestratingLabel}
              </span>
            )}
            {isBlocked && <BlockedFlag />}
          </div>
        )}
      </div>
    </article>
  )
}

/**
 * Memoized (obj 700585): the board re-renders on every WebSocket
 * objective_updated / poll tick, but a card's props are referentially stable
 * unless THAT objective changed — its callbacks are useCallback-stable and the
 * objective reference is preserved for untouched rows. React.memo therefore
 * skips re-rendering the (common) unchanged cards, so a single live update no
 * longer re-renders the entire active board.
 */
export const ObjectiveCard = memo(ObjectiveCardImpl)
