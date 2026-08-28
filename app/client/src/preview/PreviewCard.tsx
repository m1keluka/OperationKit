import { GitPullRequest, Pencil } from 'lucide-react'
import type { Objective, ObjectiveStatus } from '@command-center/shared'
import { AgentMonogram, LiveBadge, STATUS_META } from '../components/design/primitives'
import { PreviewWorkers } from './PreviewWorkers'
import { relativeTime } from '../lib/time'

const ACTIONS: Record<ObjectiveStatus, { label: string; target: ObjectiveStatus }[]> = {
  planning: [{ label: 'Skip planning', target: 'queue' }],
  queue: [{ label: 'Start', target: 'working' }],
  working: [{ label: 'Done', target: 'done' }],
  ai_review: [],
  review: [
    { label: 'Approve', target: 'done' },
    { label: 'Rework', target: 'working' },
  ],
  done: [{ label: 'Re-open', target: 'working' }],
  cancelled: [{ label: 'Re-open', target: 'queue' }],
}

export function PreviewCard({
  objective,
  children,
  onOpen,
  onEdit,
  onChangeStatus,
}: {
  objective: Objective
  children?: Objective[]
  onOpen: (o: Objective) => void
  onEdit?: (o: Objective) => void
  onChangeStatus: (id: number, status: ObjectiveStatus) => void
}) {
  const isLive = objective.status === 'working' && objective.session_id != null
  const hasThread =
    objective.session_id != null ||
    objective.planning_session_id != null ||
    objective.ai_review_session_id != null ||
    Number(objective.session_count) > 0
  const meta = STATUS_META[objective.status]
  const actions = ACTIONS[objective.status] || []

  return (
    <article className="cc-ws-card">
      <div className="px-3 py-2.5">
        <div className="flex items-start gap-2">
          <AgentMonogram agent={objective.agent_context} size="sm" />
          <button
            type="button"
            onClick={() => onOpen(objective)}
            className="min-w-0 flex-1 text-left text-[14px] font-medium leading-snug text-fg-0 hover:text-accent"
          >
            {objective.title}
          </button>
          {onEdit && (
            <button
              type="button"
              onClick={() => onEdit(objective)}
              aria-label="Edit objective"
              title="Edit objective"
              className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-fg-3 hover:bg-surface-3 hover:text-fg-0"
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        {(objective.last_session_summary || objective.description) && (
          <p className="mt-1.5 line-clamp-2 pl-7 text-[12px] leading-relaxed text-fg-2">
            {objective.last_session_summary || objective.description}
          </p>
        )}
        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 pl-7 text-[11.5px] text-fg-2">
          <span className={meta.tone}>{meta.label}</span>
          {isLive && <LiveBadge />}
          {objective.project && <span>{objective.project}</span>}
          {objective.assigned_usernames && objective.assigned_usernames.length > 0 ? (
            <span>{objective.assigned_usernames.join(', ')}</span>
          ) : (
            <span className="text-fg-3">Unassigned</span>
          )}
          {objective.pr_url && (
            <a
              href={objective.pr_url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-status-done hover:underline"
              onClick={e => e.stopPropagation()}
            >
              <GitPullRequest className="h-3 w-3" />
              #{objective.pr_number ?? ''}
            </a>
          )}
          <span className="ml-auto font-mono text-fg-3">{relativeTime(objective.updated_at)}</span>
        </div>
        {children && children.length > 0 && (
          <PreviewWorkers workers={children} onOpen={onOpen} onEdit={onEdit} />
        )}
        <div className="mt-2 flex items-center justify-end gap-1.5 pl-7">
          {hasThread && (
            <button
              type="button"
              onClick={() => onOpen(objective)}
              className="rounded-md bg-surface-3 px-2.5 py-1 text-xs font-medium text-fg-1 hover:bg-surface-4 hover:text-fg-0"
            >
              View
            </button>
          )}
          {actions.map(a => (
            <button
              key={a.target}
              type="button"
              onClick={() => onChangeStatus(objective.id, a.target)}
              className="rounded-md bg-accent px-2.5 py-1 text-xs font-medium text-accent-fg hover:bg-accent-hover"
            >
              {a.label}
            </button>
          ))}
        </div>
      </div>
    </article>
  )
}
