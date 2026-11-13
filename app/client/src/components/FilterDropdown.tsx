import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Check, ChevronDown } from 'lucide-react'

/**
 * A compact "label ▾" trigger with a popover panel (obj 900666).
 *
 * The board header used to stack three full-width chip rows (org, project,
 * owner). Each is now one of these, so the whole filter set fits on one line
 * next to Search / Archive / New. The panel content is supplied by the caller;
 * this component only owns open/close: trigger click toggles, outside click
 * and Escape close, and `close()` is handed to the content for "pick and go".
 */
export interface FilterDropdownProps {
  /** Small dimmed prefix inside the trigger, e.g. "Project". */
  label: string
  /** Current value shown after the label. */
  value: ReactNode
  /** Optional leading icon in the trigger. */
  icon?: ReactNode
  /** Accessible name of the trigger. Defaults to `${label}: …`. */
  ariaLabel?: string
  /** Panel width class. */
  panelClassName?: string
  /** Panel alignment relative to the trigger. */
  align?: 'left' | 'right' | 'center'
  /** Highlight the trigger (a non-default filter is active). */
  active?: boolean
  testId?: string
  /** Extra trigger classes (e.g. a top-bar size). */
  triggerClassName?: string
  title?: string
  children: (close: () => void) => ReactNode
}

export function FilterDropdown({
  label, value, icon, ariaLabel, panelClassName = 'w-64', align = 'left', active = false,
  testId, triggerClassName = '', title, children,
}: FilterDropdownProps) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const alignCls = align === 'right' ? 'right-0' : align === 'center' ? 'left-1/2 -translate-x-1/2' : 'left-0'

  return (
    <div ref={ref} className="relative shrink-0" data-testid={testId}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={ariaLabel}
        title={title}
        data-dropdown-trigger=""
        className={`inline-flex max-w-[16rem] items-center gap-1.5 rounded-md border bg-surface-2 px-2.5 py-1.5 text-[13px] outline-none transition-colors duration-fast ease-out focus-visible:ring-2 focus-visible:ring-accent/60 ${
          active ? 'border-accent/60' : 'border-line hover:border-line-strong'
        } ${triggerClassName}`}
      >
        {icon}
        <span className="shrink-0 text-fg-3">{label}</span>
        <span className="truncate font-medium text-fg-0">{value}</span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-fg-3" aria-hidden="true" />
      </button>
      {open && (
        <div
          data-dropdown-panel=""
          className={`absolute top-full z-50 mt-1.5 rounded-md border border-line bg-surface-1 py-1 shadow-pop ${alignCls} ${panelClassName}`}
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  )
}

/** One selectable row inside a FilterDropdown panel. */
export function DropdownOption({
  selected, onClick, children, multi = false, trailing, ...rest
}: {
  selected: boolean
  onClick: () => void
  children: ReactNode
  /** Multi-select rows draw a checkbox; single-select rows a check on the right. */
  multi?: boolean
  trailing?: ReactNode
} & Record<`data-${string}`, string | number | undefined>) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      {...rest}
      className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors duration-fast ease-out ${
        selected ? 'bg-surface-selected text-fg-0' : 'text-fg-1 hover:bg-surface-3 hover:text-fg-0'
      }`}
    >
      {multi && (
        <span
          aria-hidden="true"
          className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-sm border ${
            selected ? 'border-accent bg-accent text-accent-fg' : 'border-line-strong'
          }`}
        >
          {selected && <Check className="h-3 w-3" strokeWidth={3} />}
        </span>
      )}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {trailing}
      {!multi && selected && <Check aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-accent" />}
    </button>
  )
}
