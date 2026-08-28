import type { Objective } from '@command-center/shared'
import { StatusDot } from '../components/design/primitives'

export function SubObjectiveRail({
  items,
  activeId,
  onOpen,
}: {
  items: Objective[]
  activeId?: number
  onOpen: (o: Objective) => void
}) {
  return (
    <aside className="hidden h-full w-[240px] shrink-0 flex-col border-r border-line bg-surface-1 md:flex">
      <div className="border-b border-line px-3 py-2.5">
        <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-fg-2">Sub-objectives</div>
        <div className="mt-0.5 font-mono text-[11px] text-fg-3">{items.length}</div>
      </div>
      <ul className="min-h-0 flex-1 overflow-y-auto p-2">
        {items.length === 0 && (
          <li className="px-2 py-6 text-center text-[12px] text-fg-3">No nested workers on this card.</li>
        )}
        {items.map(o => (
          <li key={o.id}>
            <button
              type="button"
              onClick={() => onOpen(o)}
              className="mb-0.5 flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left hover:bg-surface-3"
              style={activeId === o.id ? { background: 'var(--accent-tint)' } : undefined}
            >
              <StatusDot status={o.status} size={7} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12.5px] text-fg-0">{o.title.replace(/^worker:\s*/i, '')}</span>
                <span className="mt-0.5 block font-mono text-[10.5px] text-fg-3">#{o.id} · {o.status}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </aside>
  )
}
