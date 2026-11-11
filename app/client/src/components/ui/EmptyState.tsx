import type { ReactNode } from 'react'
import { cn } from './cn'

/* EmptyState — the calm "nothing here yet" surface for empty tables/lists/pages.
   Centered icon glyph + title + one line of guidance + optional CTA. Reads
   entirely from tokens; the icon tile sits on surface-3 with a hairline. */
export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
  compact,
}: {
  icon?: ReactNode
  title: string
  description?: string
  action?: ReactNode
  className?: string
  compact?: boolean
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center text-center',
        compact ? 'gap-2 py-8' : 'gap-3 py-14',
        className,
      )}
    >
      {icon && (
        <div className="grid h-11 w-11 place-items-center rounded-lg border border-line bg-surface-3 text-fg-2">
          {icon}
        </div>
      )}
      <div className="space-y-1">
        <p className="font-display text-[15px] font-semibold tracking-[-0.01em] text-fg-1">{title}</p>
        {description && <p className="mx-auto max-w-[44ch] text-[13px] leading-relaxed text-fg-3">{description}</p>}
      </div>
      {action && <div className="mt-1">{action}</div>}
    </div>
  )
}
