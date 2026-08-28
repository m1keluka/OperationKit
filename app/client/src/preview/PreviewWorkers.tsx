import { useState } from 'react'
import { ChevronRight, Pencil } from 'lucide-react'
import type { Objective } from '@command-center/shared'
import { StatusDot } from '../components/design/primitives'

function stateLabel(o: Objective): string {
  if (o.status === 'done') return 'done'
  if (o.status === 'working') return o.session_id ? 'running' : 'queued'
  if (o.status === 'ai_review') return 'reviewing'
  if (o.status === 'review') return o.ai_review_verdict === 'fail' ? 'failed review' : 'ready'
  if (o.status === 'queue') return 'queued'
  return o.status
}

export function PreviewWorkers({
  workers,
  onOpen,
  onEdit,
}: {
  workers: Objective[]
  onOpen: (o: Objective) => void
  onEdit?: (o: Objective) => void
}) {
  const [open, setOpen] = useState(true)
  const total = workers.length
  const done = workers.filter(w => w.status === 'done').length
  const ready = workers.filter(w => w.status === 'review').length
  const blocked = workers.filter(w => !!w.has_blockers).length

  return (
    <div className="cc-ws-workers">
      <button type="button" className="cc-ws-workers-head" onClick={() => setOpen(v => !v)}>
        <ChevronRight className={`h-3.5 w-3.5 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`} />
        <span>Sub-objectives</span>
        <span className="cc-ws-workers-count">{done}/{total}</span>
        {ready > 0 && <span className="cc-ws-workers-flag ready">{ready} ready</span>}
        {blocked > 0 && <span className="cc-ws-workers-flag blocked">{blocked} blocked</span>}
      </button>
      {open && (
        <ul className="cc-ws-workers-list">
          {workers.map(w => (
            <li key={w.id} className="flex items-center gap-0.5">
              <button type="button" className="cc-ws-workers-row" onClick={() => onOpen(w)}>
                <StatusDot status={w.status} size={6} />
                <span className="cc-ws-workers-title">{w.title.replace(/^worker:\s*/i, '')}</span>
                <span className="cc-ws-workers-state">{stateLabel(w)}</span>
              </button>
              {onEdit && (
                <button
                  type="button"
                  onClick={() => onEdit(w)}
                  aria-label="Edit sub-objective"
                  title="Edit sub-objective"
                  className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-fg-3 hover:bg-surface-3 hover:text-fg-0"
                >
                  <Pencil className="h-3 w-3" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
