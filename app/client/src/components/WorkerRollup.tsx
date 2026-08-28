import { useState } from 'react'
import { ChevronRight } from 'lucide-react'
import type { Objective } from '@command-center/shared'
import { StatusDot } from './design/primitives'

/* ─────────────────────────────────────────────────────────
   WorkerRollup — nested SUB-OBJECTIVE list for a delegator card.
   Canonical vocabulary (docs/terminology-glossary.md): a child of
   a delegator is a "Sub-objective"; "Worker" is the delegator-mode
   synonym used while that sub-objective is executed by a worker
   session. Sub-objectives don't float as their own column cards;
   they live here as a compact, expandable list with a done-rollup.
   Tapping a row opens that sub-objective's session viewer.
   ───────────────────────────────────────────────────────── */

interface WorkerRollupProps {
  workers: Objective[]
  onOpenWorker: (o: Objective) => void
  /** Section header. 'Workers' for delegator children (Sub-objectives under an
      active delegator); 'Review' for adversarial/PR-review children;
      'Sub-objectives' for other (manual) children. */
  label?: string
}

// One-word state for a worker row. For delegator workers, `review` means
// "session ended, awaiting the delegator's accept" — not "needs a human".
function workerStateLabel(o: Objective): string {
  if (o.status === 'done') return 'done'
  if (o.status === 'working') return o.session_id ? 'running' : 'queued'
  if (o.status === 'ai_review') return 'reviewing'
  if (o.status === 'review') return o.ai_review_verdict === 'fail' ? 'failed review' : 'ready'
  if (o.status === 'queue') return 'queued'
  return o.status
}

export function WorkerRollup({ workers, onOpenWorker, label = 'Workers' }: WorkerRollupProps) {
  const [expanded, setExpanded] = useState(true)
  const total = workers.length
  const done = workers.filter(w => w.status === 'done').length
  const running = workers.filter(w => w.status === 'working' && w.session_id).length
  const reviewing = workers.filter(w => w.status === 'ai_review').length
  const ready = workers.filter(w => w.status === 'review').length
  const blocked = workers.filter(w => !!w.has_blockers).length

  return (
    <div className="mt-2.5 ml-7 rounded-md border border-line-soft bg-surface-1/50">
      <button
        onClick={() => setExpanded(e => !e)}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-[11.5px] text-fg-2 hover:text-fg-1"
      >
        <ChevronRight className={`h-3 w-3 shrink-0 transition-transform duration-fast ${expanded ? 'rotate-90' : ''}`} />
        <span className="font-medium uppercase tracking-[0.06em]">{label}</span>
        <span className="font-mono text-fg-3">{done}/{total} done</span>
        {running > 0 && <span className="text-status-working">● {running} running</span>}
        {reviewing > 0 && <span className="text-status-ai">◇ {reviewing} reviewing</span>}
        {ready > 0 && <span className="text-status-review">◆ {ready} ready</span>}
        {blocked > 0 && <span className="text-flag-blocked">▲ {blocked} blocked</span>}
      </button>

      {expanded && (
        <ul className="border-t border-line-soft/60">
          {workers.map(w => (
            <li key={w.id} className="border-b border-line-soft/40 last:border-b-0">
              <button
                onClick={() => onOpenWorker(w)}
                className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[12px] text-fg-1 transition-colors duration-fast ease-out hover:bg-surface-3"
              >
                <StatusDot status={w.status} size={6} />
                <span className="flex-1 truncate">{w.title.replace(/^worker:\s*/i, '')}</span>
                <span className="shrink-0 font-mono text-[10.5px] text-fg-3">{workerStateLabel(w)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
