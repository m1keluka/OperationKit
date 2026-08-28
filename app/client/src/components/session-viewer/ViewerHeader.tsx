/**
 * SessionViewer header — extracted from SessionViewer.tsx (behavior frozen).
 */
import { X, GitPullRequest, Maximize2, Minimize2, Pencil } from 'lucide-react'
import type { Objective, ObjectiveStatus } from '@command-center/shared'
import { ConnStatusPill, type ConnState } from '../ConnStatusPill'
import { STATUS_META, AgentMonogram, LiveBadge } from '../design/primitives'
import { Badge, Button, IconButton } from '../ui'
import { VIEWER_STATUS_ACTIONS } from './types'

export function ViewerHeader({
  objective,
  isActive,
  connState,
  time,
  hasActivity,
  skillsInvoked,
  subagentPersonas,
  subagentWorkers,
  agentLabel,
  showBrief,
  setShowBrief,
  showDesign,
  setShowDesign,
  showCorrection,
  setShowCorrection,
  setCorrectionError,
  correctionSaved,
  onChangeStatus,
  isFull,
  toggleSize,
  onClose,
  onOpenInNewTab,
  hideSizeToggle,
  onEdit,
}: {
  objective: Objective
  isActive: boolean
  connState: ConnState
  time: string
  hasActivity: boolean
  skillsInvoked: string[]
  subagentPersonas: string[]
  subagentWorkers: string[]
  agentLabel: (slug: string) => string
  showBrief: boolean
  setShowBrief: (v: boolean) => void
  showDesign?: boolean
  setShowDesign?: (v: boolean) => void
  showCorrection: boolean
  setShowCorrection: (v: boolean) => void
  setCorrectionError: (v: string | null) => void
  correctionSaved: boolean
  onChangeStatus?: (id: number, status: ObjectiveStatus) => void
  isFull: boolean
  toggleSize: () => void
  onClose: () => void
  onOpenInNewTab?: () => void
  hideSizeToggle?: boolean
  onEdit?: (objective: Objective) => void
}) {
  const statusMeta = STATUS_META[objective.status]

  // Header action buttons (Brief / Flag mistake / status actions / PR link).
  // Rendered in two places: the desktop top-right cluster, and — on mobile —
  // a dedicated full-width row below the title so they don't crush the title
  // into a sliver and wrap into a tall, cramped block (obj 700281).
  const actionButtons = (
    <>
      {onEdit && (
        <Button
          size="sm"
          variant="ghost"
          onClick={() => onEdit(objective)}
          title="Edit objective"
          aria-label="Edit objective"
        >
          <Pencil className="h-3.5 w-3.5" />
        </Button>
      )}
      {setShowDesign && (
        <Button
          size="sm"
          variant={showDesign ? 'secondary' : 'ghost'}
          onClick={() => setShowDesign(!showDesign)}
        >
          Design
        </Button>
      )}
      <Button
        size="sm"
        variant={showBrief ? 'secondary' : 'ghost'}
        onClick={() => setShowBrief(!showBrief)}
      >
        Brief
      </Button>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => { setShowCorrection(!showCorrection); setCorrectionError(null) }}
        title="Flag a mistake — becomes a high-priority gotcha in the next spawn"
        className={showCorrection ? 'bg-status-review/20 text-status-review hover:bg-status-review/25' : ''}
      >
        {correctionSaved ? 'Flagged ✓' : 'Flag mistake'}
      </Button>
      {onChangeStatus && (VIEWER_STATUS_ACTIONS[objective.status] || []).map(action => (
        <Button
          key={action.target}
          size="sm"
          variant={action.variant === 'primary' ? 'primary' : 'secondary'}
          onClick={() => onChangeStatus(objective.id, action.target)}
        >
          {action.label}
        </Button>
      ))}
      {objective.pr_url && (
        <a
          href={objective.pr_url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex h-8 items-center gap-1 rounded-md px-2 text-xs font-medium text-status-done transition-colors duration-fast ease-out hover:bg-status-done/10"
        >
          <GitPullRequest className="h-3.5 w-3.5" />
          <span className="font-mono">#{objective.pr_number ?? ''}</span>
        </a>
      )}
    </>
  )

  return (
    <div className="border-b border-line px-4 py-3 sm:px-5">
      <div className="flex items-start justify-between gap-3">
      <div className="flex-1 min-w-0">
        <div className="flex items-start gap-2.5">
          <AgentMonogram agent={objective.agent_context} size="md" />
          <div className="min-w-0 flex-1">
            <h3 className="truncate text-[15px] font-medium leading-tight text-fg-0">
              {objective.title}
            </h3>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[12px] text-fg-2">
              <span className={statusMeta.tone}>{statusMeta.label}</span>
              {isActive && <LiveBadge />}
              {isActive && <ConnStatusPill state={connState} />}
              {objective.project && <span>{objective.project}</span>}
              {Number(objective.session_count) > 0 && (
                <span>{objective.session_count} session{objective.session_count !== 1 ? 's' : ''}</span>
              )}
              {Number(objective.total_cost_usd) > 0 && (
                <span>${Number(objective.total_cost_usd).toFixed(2)} spent</span>
              )}
              {time && <span className="font-mono text-fg-3">{time}</span>}
            </div>
            {objective.session_id && (
              <div className="mt-0.5 truncate font-mono text-[10.5px] text-fg-3">{objective.session_id}</div>
            )}
            {/* Session activity (obj-2387): skills + sub-agent personas this
                objective's sessions actually invoked, beside the agent badge. */}
            {hasActivity && (
              <div className="mt-1.5 flex flex-col gap-1">
                {skillsInvoked.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1">
                    <span className="text-[10px] font-medium uppercase tracking-wide text-fg-3">Skills</span>
                    {skillsInvoked.map(s => (
                      <Badge key={`sk-${s}`} tone="accent" mono>{s}</Badge>
                    ))}
                  </div>
                )}
                {subagentPersonas.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1">
                    <span className="text-[10px] font-medium uppercase tracking-wide text-fg-3">Agents</span>
                    {subagentPersonas.map(a => (
                      <span key={`ag-${a}`} className="inline-flex items-center gap-1">
                        <AgentMonogram agent={a} size="sm" />
                        <Badge tone="info">{agentLabel(a)}</Badge>
                      </span>
                    ))}
                  </div>
                )}
                {subagentWorkers.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1">
                    <span className="text-[10px] font-medium uppercase tracking-wide text-fg-3">Sub-agents</span>
                    {subagentWorkers.map(w => (
                      <Badge key={`sa-${w}`} tone="neutral" mono>{w}</Badge>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {/* Action buttons stay inline on desktop; on mobile they drop to
              the full-width row below so they don't crowd the title. */}
          <div className="hidden flex-wrap items-center justify-end gap-1.5 sm:flex">
            {actionButtons}
          </div>
          {/* Fullscreen ↔ half-screen toggle. Desktop: half-width drawer ↔ full-width.
              Mobile: capped-height bottom sheet ↔ edge-to-edge sheet. 44px tap target.
              Preview dialogs pass onOpenInNewTab so expand opens a real new tab. */}
          {!hideSizeToggle && (
            <IconButton
              label={onOpenInNewTab ? 'Open in new tab' : isFull ? 'Exit fullscreen (f)' : 'Fullscreen (f)'}
              onClick={onOpenInNewTab ?? toggleSize}
            >
              {onOpenInNewTab || !isFull
                ? <Maximize2 className="h-4 w-4" />
                : <Minimize2 className="h-4 w-4" />}
            </IconButton>
          )}
          <IconButton label="Close session" onClick={onClose}>
            <X className="h-4 w-4" />
          </IconButton>
        </div>
      </div>
      {/* Mobile-only action row — full width, wraps cleanly under the title. */}
      <div className="mt-3 flex flex-wrap items-center gap-1.5 sm:hidden">
        {actionButtons}
      </div>
    </div>
  )
}
