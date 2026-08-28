import { cn } from './cn'

export interface TabItem {
  key: string
  label: string
  count?: number
}

/* Tabs — Mission Control segmented control. A surface-1 track holding pill
   segments; the active segment lifts to surface-3 with fg-0 text and an accent
   underline tick. Keyboard-accessible (role=tablist, arrow nav by the browser
   on the buttons). Horizontally scrollable on mobile, never overflows the page. */
export function Tabs({
  items,
  value,
  onChange,
  className,
}: {
  items: TabItem[]
  value: string
  onChange: (key: string) => void
  className?: string
}) {
  return (
    <div
      role="tablist"
      className={cn(
        'inline-flex max-w-full gap-0.5 overflow-x-auto rounded-lg border border-line bg-surface-1 p-0.5',
        className,
      )}
    >
      {items.map((t) => {
        const active = t.key === value
        return (
          <button
            key={t.key}
            role="tab"
            aria-selected={active}
            onClick={() => onChange(t.key)}
            className={cn(
              'inline-flex shrink-0 items-center gap-1.5 rounded-md px-3 py-1.5 text-[12.5px] font-medium tracking-[-0.01em] transition-colors duration-fast ease-out',
              active ? 'bg-surface-3 text-fg-0' : 'text-fg-2 hover:text-fg-1',
            )}
          >
            {t.label}
            {typeof t.count === 'number' && (
              <span className={cn('font-mono text-[11px]', active ? 'text-accent-hover' : 'text-fg-3')}>
                {t.count}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}
