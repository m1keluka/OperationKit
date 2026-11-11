import type { ReactNode, HTMLAttributes } from 'react'
import { cn } from './cn'

/* Card — Mission Control surface. surface-2 fill, 1px hairline, NO shadow
   (shadows are overlay-only in this system). The workhorse container every
   panel/list/section sits in. Use `interactive` for hover-liftable cards. */
interface CardProps extends HTMLAttributes<HTMLDivElement> {
  interactive?: boolean
  inset?: boolean
}
export function Card({ interactive, inset, className, children, ...rest }: CardProps) {
  return (
    <div
      className={cn(
        'rounded-lg border border-line bg-surface-2',
        inset ? 'p-0' : 'p-4',
        interactive &&
          'cursor-pointer transition-colors duration-fast ease-out hover:border-line-strong hover:bg-surface-3',
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  )
}

/* CardHeader — title + optional eyebrow kicker + right-aligned actions slot. */
export function CardHeader({
  title,
  eyebrow,
  actions,
  className,
}: {
  title: ReactNode
  eyebrow?: ReactNode
  actions?: ReactNode
  className?: string
}) {
  return (
    <div className={cn('flex items-start justify-between gap-3 border-b border-line-soft px-4 py-3', className)}>
      <div className="min-w-0">
        {eyebrow && (
          <div className="mb-0.5 font-mono text-[11px] uppercase tracking-[0.12em] text-fg-3">{eyebrow}</div>
        )}
        <h3 className="truncate font-display text-[15px] font-semibold tracking-[-0.01em] text-fg-0">{title}</h3>
      </div>
      {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
    </div>
  )
}

/* CardBody — padded content region; pair with inset Card. */
export function CardBody({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn('p-4', className)}>{children}</div>
}
