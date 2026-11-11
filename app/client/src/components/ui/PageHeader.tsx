import type { ReactNode } from 'react'
import { cn } from './cn'

export interface Crumb {
  label: string
  href?: string
}

/* PageHeader — page title + '›'-accented breadcrumb trail + right-aligned
   actions slot. The caret '›' is the one Mission Control ornament. Wraps
   cleanly on mobile (actions drop below the title). */
export function PageHeader({
  title,
  breadcrumbs,
  description,
  actions,
  className,
}: {
  title: ReactNode
  breadcrumbs?: Crumb[]
  description?: ReactNode
  actions?: ReactNode
  className?: string
}) {
  return (
    <header className={cn('mb-5 flex flex-col gap-3 sm:mb-6', className)}>
      {breadcrumbs && breadcrumbs.length > 0 && (
        <nav aria-label="Breadcrumb" className="flex flex-wrap items-center gap-1.5 font-mono text-[11px] text-fg-3">
          {breadcrumbs.map((c, i) => (
            <span key={i} className="inline-flex items-center gap-1.5">
              {i > 0 && <span className="text-accent-hover" aria-hidden="true">›</span>}
              {c.href ? (
                <a href={c.href} className="transition-colors duration-fast hover:text-fg-1">{c.label}</a>
              ) : (
                <span className={i === breadcrumbs.length - 1 ? 'text-fg-2' : undefined}>{c.label}</span>
              )}
            </span>
          ))}
        </nav>
      )}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h1 className="font-display text-[22px] font-semibold leading-tight tracking-[-0.02em] text-fg-0 sm:text-[26px]">
            {title}
          </h1>
          {description && <p className="mt-1 max-w-prose text-[13px] leading-relaxed text-fg-2">{description}</p>}
        </div>
        {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </header>
  )
}
