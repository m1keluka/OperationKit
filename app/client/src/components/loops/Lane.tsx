/**
 * Loop kanban lane — extracted from LoopsPage.tsx (behavior frozen).
 */
import { Badge, StatusPill, EmptyState } from '../ui'
import { LoopCard } from './LoopCard'
import { STATUS_PIPELINE, type Loop, type LoopStatus } from './types'

export function Lane({
  status,
  loops,
  onOpen,
  onStatus,
  selected,
  onToggleSelect,
}: {
  status: LoopStatus
  loops: Loop[]
  onOpen: (l: Loop) => void
  onStatus: (slug: string, status: LoopStatus) => void
  selected: Set<string>
  onToggleSelect: (slug: string) => void
}) {
  return (
    <section className="flex min-h-0 flex-col">
      <header className="mb-2 flex items-center gap-2 border-b border-line-soft pb-2">
        <StatusPill status={STATUS_PIPELINE[status]} />
        <Badge tone="neutral" mono className="ml-auto">{loops.length}</Badge>
      </header>
      <div className="flex flex-col gap-2.5">
        {loops.length === 0 ? (
          <EmptyState compact title="Nothing here" />
        ) : (
          loops.map(l => (
            <LoopCard
              key={l.slug}
              loop={l}
              onOpen={() => onOpen(l)}
              onStatus={s => onStatus(l.slug, s)}
              selected={selected.has(l.slug)}
              onToggleSelect={() => onToggleSelect(l.slug)}
            />
          ))
        )}
      </div>
    </section>
  )
}
