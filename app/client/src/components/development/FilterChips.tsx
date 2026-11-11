import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Check, ChevronDown, X } from 'lucide-react'
import { cn } from '../ui'

/* ─────────────────────────────────────────────────────────────────────────
   Filter chips for /development (PRD §5.4).

   Deliberately NOT a new design system: these are Toolbar-sized buttons built
   from the same surface/line/accent tokens every other CC control uses, and
   they render inside the shared <Toolbar left={…}>. They exist because the
   board needs 12 filters in one row and a native <select> per filter is both
   ugly and (per obj 700070) fragile under live re-render.
   ───────────────────────────────────────────────────────────────────────── */

const CHIP =
  'inline-flex min-h-[36px] items-center gap-1.5 rounded-md border px-2.5 text-[12.5px] font-medium ' +
  'transition-colors duration-fast ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50'

function usePopover() {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false) } }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [open])
  return { open, setOpen, ref }
}

function ChipShell({
  label, summary, active, disabled, title, children,
}: {
  label: string
  summary: ReactNode
  active: boolean
  disabled?: boolean
  title?: string
  children: (close: () => void) => ReactNode
}) {
  const { open, setOpen, ref } = usePopover()
  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        disabled={disabled}
        title={title}
        onClick={() => setOpen(o => !o)}
        className={cn(
          CHIP,
          active
            ? 'border-[color:var(--accent-line)] bg-accent/10 text-fg-0'
            : 'border-line bg-surface-2 text-fg-1 hover:border-line-strong hover:text-fg-0',
          disabled && 'cursor-not-allowed opacity-40',
        )}
      >
        <span className="text-fg-3">{label}</span>
        <span className="max-w-[13ch] truncate">{summary}</span>
        <ChevronDown className="h-3.5 w-3.5 text-fg-3" strokeWidth={2} />
      </button>
      {open && !disabled && (
        <div className="absolute left-0 z-30 mt-1 max-h-[320px] w-[240px] overflow-y-auto rounded-lg border border-line bg-surface-2 p-1 shadow-float">
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  )
}

const OPTION =
  'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] text-fg-1 ' +
  'transition-colors duration-fast hover:bg-surface-3 hover:text-fg-0'

export interface Option { value: string; label: string; count?: number; color?: string | null }

export function MultiSelectChip({
  label, options, value, onChange, disabled, disabledHint, allLabel = 'All',
}: {
  label: string
  options: Option[]
  value: string[]
  onChange: (next: string[]) => void
  disabled?: boolean
  disabledHint?: string
  allLabel?: string
}) {
  const summary = value.length === 0
    ? allLabel
    : value.length === 1
      ? options.find(o => o.value === value[0])?.label ?? value[0]
      : `${value.length} selected`
  return (
    <ChipShell label={label} summary={summary} active={value.length > 0} disabled={disabled} title={disabled ? disabledHint : undefined}>
      {() => (
        <>
          <button type="button" className={cn(OPTION, value.length === 0 && 'text-fg-0')} onClick={() => onChange([])}>
            <span className="w-3.5">{value.length === 0 && <Check className="h-3.5 w-3.5 text-accent-hover" strokeWidth={2.2} />}</span>
            {allLabel}
          </button>
          <div className="my-1 h-px bg-line-soft" />
          {options.map(o => {
            const on = value.includes(o.value)
            return (
              <button
                key={o.value}
                type="button"
                className={cn(OPTION, on && 'text-fg-0')}
                onClick={() => onChange(on ? value.filter(v => v !== o.value) : [...value, o.value])}
              >
                <span className="w-3.5">{on && <Check className="h-3.5 w-3.5 text-accent-hover" strokeWidth={2.2} />}</span>
                {o.color && <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: o.color }} />}
                <span className="min-w-0 flex-1 truncate">{o.label}</span>
                {typeof o.count === 'number' && <span className="font-mono text-[11px] text-fg-3">{o.count}</span>}
              </button>
            )
          })}
          {options.length === 0 && <div className="px-2 py-3 text-[12px] text-fg-3">No options</div>}
        </>
      )}
    </ChipShell>
  )
}

export function SelectChip({
  label, options, value, onChange, allLabel = 'All', disabled, disabledHint,
}: {
  label: string
  options: Option[]
  value: string | null
  onChange: (next: string | null) => void
  allLabel?: string
  disabled?: boolean
  disabledHint?: string
}) {
  const summary = value === null ? allLabel : options.find(o => o.value === value)?.label ?? value
  return (
    <ChipShell label={label} summary={summary} active={value !== null} disabled={disabled} title={disabled ? disabledHint : undefined}>
      {close => (
        <>
          <button type="button" className={cn(OPTION, value === null && 'text-fg-0')} onClick={() => { onChange(null); close() }}>
            <span className="w-3.5">{value === null && <Check className="h-3.5 w-3.5 text-accent-hover" strokeWidth={2.2} />}</span>
            {allLabel}
          </button>
          <div className="my-1 h-px bg-line-soft" />
          {options.map(o => (
            <button key={o.value} type="button" className={cn(OPTION, value === o.value && 'text-fg-0')} onClick={() => { onChange(o.value); close() }}>
              <span className="w-3.5">{value === o.value && <Check className="h-3.5 w-3.5 text-accent-hover" strokeWidth={2.2} />}</span>
              <span className="min-w-0 flex-1 truncate">{o.label}</span>
              {typeof o.count === 'number' && <span className="font-mono text-[11px] text-fg-3">{o.count}</span>}
            </button>
          ))}
          {options.length === 0 && <div className="px-2 py-3 text-[12px] text-fg-3">Nothing to choose from</div>}
        </>
      )}
    </ChipShell>
  )
}

/** Tri-state any/yes/no chip — one click cycles, so it costs no popover. */
export function TriStateChip({
  label, value, onChange,
}: {
  label: string
  value: 'yes' | 'no' | undefined
  onChange: (next: 'yes' | 'no' | undefined) => void
}) {
  const next = value === undefined ? 'yes' : value === 'yes' ? 'no' : undefined
  return (
    <button
      type="button"
      onClick={() => onChange(next)}
      aria-pressed={value !== undefined}
      className={cn(
        CHIP,
        value !== undefined
          ? 'border-[color:var(--accent-line)] bg-accent/10 text-fg-0'
          : 'border-line bg-surface-2 text-fg-1 hover:border-line-strong hover:text-fg-0',
      )}
    >
      <span className="text-fg-3">{label}</span>
      <span className="font-mono text-[11px]">{value === undefined ? 'any' : value}</span>
    </button>
  )
}

export function ToggleChip({
  label, value, onChange,
}: {
  label: string
  value: boolean
  onChange: (next: boolean) => void
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!value)}
      aria-pressed={value}
      className={cn(
        CHIP,
        value
          ? 'border-[color:var(--accent-line)] bg-accent/10 text-fg-0'
          : 'border-line bg-surface-2 text-fg-1 hover:border-line-strong hover:text-fg-0',
      )}
    >
      {value && <Check className="h-3.5 w-3.5 text-accent-hover" strokeWidth={2.2} />}
      {label}
    </button>
  )
}

export function ClearFiltersButton({ count, onClear }: { count: number; onClear: () => void }) {
  if (count === 0) return null
  return (
    <button
      type="button"
      onClick={onClear}
      className={cn(CHIP, 'border-transparent bg-transparent text-fg-2 hover:bg-surface-2 hover:text-fg-0')}
    >
      <X className="h-3.5 w-3.5" strokeWidth={2} />
      Clear {count} filter{count === 1 ? '' : 's'}
    </button>
  )
}
