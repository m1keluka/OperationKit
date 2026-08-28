import type { ReactNode, InputHTMLAttributes } from 'react'
import { Search } from 'lucide-react'
import { cn } from './cn'

/* Toolbar — the filter/search/segmented-control row that sits under a PageHeader
   and above a table or list. Left slot = filters/tabs, right slot = actions.
   Stacks vertically on mobile so nothing overflows at 390px. */
export function Toolbar({
  left,
  right,
  className,
}: {
  left?: ReactNode
  right?: ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        'mb-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between',
        className,
      )}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2">{left}</div>
      {right && <div className="flex shrink-0 flex-wrap items-center gap-2">{right}</div>}
    </div>
  )
}

/* SearchInput — the standard search field; Geist-Mono-friendly, 44px tall on
   mobile, leading Lucide search glyph. Token-bound focus ring in the accent. */
interface SearchInputProps extends InputHTMLAttributes<HTMLInputElement> {
  wrapClassName?: string
}
export function SearchInput({ wrapClassName, className, ...rest }: SearchInputProps) {
  return (
    <div className={cn('relative flex items-center', wrapClassName)}>
      <Search className="pointer-events-none absolute left-2.5 h-4 w-4 text-fg-3" strokeWidth={1.75} />
      <input
        type="search"
        className={cn(
          'min-h-[44px] w-full rounded-md border border-line bg-surface-2 pl-8 pr-3 text-[13px] text-fg-0 placeholder:text-fg-3 sm:min-h-[36px]',
          'transition-colors duration-fast ease-out hover:border-line-strong focus:border-[color:var(--accent-line)] focus:outline-none focus:ring-2 focus:ring-accent/40',
          className,
        )}
        {...rest}
      />
    </div>
  )
}
