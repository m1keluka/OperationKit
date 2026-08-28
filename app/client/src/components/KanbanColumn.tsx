import type { Objective, ObjectiveStatus } from '@command-center/shared'
import { ObjectiveCard } from './ObjectiveCard'
import { STATUS_META } from './design/primitives'
import { Skeleton } from './ui'

/* ─────────────────────────────────────────────────────────
   KanbanColumn — Mission Control (Direction A).
   A quiet, dense column: sticky mono header (uppercase label +
   count badge), cards stacked on a surface-0 fill. The 1px
   hairline separators between columns are produced by the parent
   grid gap (see .ok-board / board.css), not a per-column border.
   ───────────────────────────────────────────────────────── */

interface KanbanColumnProps {
  status: ObjectiveStatus
  objectives: Objective[]
  onOpenTerminal: (objective: Objective) => void
  onCardEdit: (objective: Objective) => void
  onChangeStatus: (id: number, status: ObjectiveStatus) => void
  /** Objective id whose status PATCH is currently in flight (OK-7). */
  pendingId?: number | null
  /** parent objective id → its delegator worker objectives. */
  childrenByParent?: Map<number, Objective[]>
  /** ── Lazy load (obj 700512, Done column only) ──
      When these are provided the column fetches its cards on demand rather than
      mounting the whole (~2k-row) backlog on load. */
  lazyLoaded?: boolean
  lazyLoading?: boolean
  lazyHasMore?: boolean
  onLoadMore?: () => void
}

export function KanbanColumn({ status, objectives, onOpenTerminal, onCardEdit, onChangeStatus, pendingId, childrenByParent, lazyLoaded, lazyLoading, lazyHasMore, onLoadMore }: KanbanColumnProps) {
  const meta = STATUS_META[status]
  const isLazy = onLoadMore != null

  return (
    <section className="ok-col" data-status={status} aria-labelledby={`col-${status}`}>
      <div className="ok-colhead">
        <span
          id={`col-${status}`}
          className="font-mono text-[11px] uppercase tracking-[0.12em] text-fg-2"
        >
          {meta.label}
        </span>
        <span className="ml-auto font-mono text-[11px] text-fg-3">
          {objectives.length}{isLazy && lazyHasMore ? '+' : ''}
        </span>
      </div>

      <div className="ok-cards">
        {objectives.map(objective => (
          <ObjectiveCard
            key={objective.id}
            objective={objective}
            onOpenTerminal={onOpenTerminal}
            onEdit={onCardEdit}
            onChangeStatus={onChangeStatus}
            pending={objective.id === pendingId}
            children={childrenByParent?.get(objective.id)}
          />
        ))}

        {/* Lazy Done column: fetch-on-demand. Before first load, a single tap
            pulls the newest page instead of rendering ~2k historical cards. */}
        {isLazy ? (
          <>
            {lazyLoading && (
              <div className="space-y-2" aria-busy="true">
                {Array.from({ length: 3 }).map((_, i) => (
                  <div key={i} className="flex gap-2.5 rounded-md border border-line bg-surface-2 p-[11px]">
                    <Skeleton className="h-[26px] w-[26px] flex-shrink-0 rounded-sm" />
                    <div className="min-w-0 flex-1">
                      <Skeleton className="h-[13px] w-3/4" />
                      <Skeleton className="mt-[9px] h-3 w-full" />
                    </div>
                  </div>
                ))}
              </div>
            )}
            {!lazyLoading && (lazyHasMore || !lazyLoaded) && (
              <button
                onClick={onLoadMore}
                className="min-h-[44px] w-full rounded-md border border-dashed border-line bg-surface-1 px-3 py-2.5 text-center font-mono text-[11px] text-fg-2 transition-colors duration-fast ease-out hover:border-line-strong hover:bg-surface-2 hover:text-fg-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
              >
                {lazyLoaded ? 'Load more done' : 'Load done objectives'}
              </button>
            )}
            {!lazyLoading && lazyLoaded && !lazyHasMore && objectives.length === 0 && (
              <div className="rounded-md border border-dashed border-line/60 px-3 py-3 text-center font-mono text-[11px] text-fg-3">
                empty
              </div>
            )}
          </>
        ) : (
          objectives.length === 0 && (
            <div className="rounded-md border border-dashed border-line/60 px-3 py-3 text-center font-mono text-[11px] text-fg-3">
              empty
            </div>
          )
        )}
      </div>
    </section>
  )
}
