import { useEffect, useRef } from 'react'
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
  // On a phone the track scrolls sideways; keep the selected segment in view so a
  // deep link (e.g. /settings/email) does not open with no visible active tab
  // (QA obj 900621). Only the track scrolls, never the page.
  const listRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const list = listRef.current
    const el = list?.querySelector<HTMLElement>('[aria-selected="true"]')
    if (!list || !el || list.scrollWidth <= list.clientWidth) return
    const lr = list.getBoundingClientRect()
    const er = el.getBoundingClientRect()
    if (er.left < lr.left) list.scrollLeft -= lr.left - er.left + 12
    else if (er.right > lr.right) list.scrollLeft += er.right - lr.right + 12
  }, [value])
  return (
    <div
      ref={listRef}
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
              <span className={cn('font-mono text-[12px]', active ? 'text-accent-hover' : 'text-fg-3')}>
                {t.count}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}
