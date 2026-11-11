/**
 * Loop kanban card — extracted from LoopsPage.tsx (behavior frozen).
 */
import { Card, Button, Badge, cn } from '../ui'
import {
  STATUSES, STATUS_LABEL, PROJECT_LABEL, isOverdue,
  type Loop, type LoopStatus,
} from './types'

export function LoopCard({
  loop,
  onOpen,
  onStatus,
  selected,
  onToggleSelect,
}: {
  loop: Loop
  onOpen: () => void
  onStatus: (status: LoopStatus) => void
  selected: boolean
  onToggleSelect: () => void
}) {
  const overdue = isOverdue(loop)
  const done = loop.status === 'done'
  return (
    <Card
      className={cn('p-3', selected && 'border-accent ring-1 ring-accent/40')}
    >
      <div className="flex items-start gap-2.5">
        {/* Selection checkbox — large tap target for multi-manage */}
        <button
          role="checkbox"
          aria-checked={selected}
          aria-label={selected ? 'deselect loop' : 'select loop'}
          onClick={e => {
            e.stopPropagation()
            onToggleSelect()
          }}
          className={cn(
            '-m-1 flex h-9 w-9 shrink-0 items-center justify-center rounded p-1 transition-colors duration-fast',
            selected ? 'text-accent' : 'text-fg-3 hover:text-fg-1',
          )}
        >
          <span
            className={cn(
              'flex h-5 w-5 items-center justify-center rounded border transition-colors duration-fast',
              selected ? 'border-accent bg-accent text-accent-fg' : 'border-line bg-surface-3',
            )}
          >
            {selected && <span className="text-[11px] leading-none">✓</span>}
          </span>
        </button>

        <button onClick={onOpen} className="min-w-0 flex-1 text-left">
          <div className={cn('font-display text-sm font-semibold leading-snug tracking-[-0.01em]', done ? 'text-fg-2 line-through' : 'text-fg-0')}>
            {loop.title}
          </div>
          {/* badges row */}
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {loop.project && (
              <Badge tone="neutral" mono>
                {PROJECT_LABEL[loop.project]}
              </Badge>
            )}
            {loop.party && <Badge tone="neutral" mono>{loop.party}</Badge>}
            {loop.tags.map(t => (
              <Badge key={t} tone="neutral" mono>
                {t}
              </Badge>
            ))}
          </div>
          {/* dates row */}
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono text-[10px] text-fg-3">
            <span>Created {loop.opened || '—'}</span>
            {loop.due && (
              <span className={overdue ? 'font-semibold text-signal-alarm' : ''}>
                Due {loop.due}{overdue ? ' · overdue' : ''}
              </span>
            )}
            {done && loop.closed && <span>Done {loop.closed}</span>}
          </div>
        </button>

        {/* One-tap quick-complete: done <-> queued (kept after checkbox became selection) */}
        <button
          aria-label={done ? 'reopen loop' : 'mark loop done'}
          title={done ? 'Reopen' : 'Mark done'}
          onClick={e => {
            e.stopPropagation()
            onStatus(done ? 'queued' : 'done')
          }}
          className={cn(
            '-m-1 flex h-9 w-9 shrink-0 items-center justify-center rounded p-1 text-base transition-colors duration-fast',
            done ? 'text-status-done hover:text-fg-2' : 'text-fg-3 hover:text-status-done',
          )}
        >
          ✓
        </button>
      </div>

      {/* status mover — tap to change lane (no drag) */}
      <div className="mt-2.5 grid grid-cols-3 gap-1.5">
        {STATUSES.map(s => (
          <Button
            key={s}
            size="sm"
            variant={loop.status === s ? 'primary' : 'secondary'}
            className="w-full px-0"
            onClick={e => {
              e.stopPropagation()
              onStatus(s)
            }}
          >
            {STATUS_LABEL[s]}
          </Button>
        ))}
      </div>
    </Card>
  )
}
