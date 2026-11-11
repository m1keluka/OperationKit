import type { ReactNode } from 'react'
import { cn } from './cn'

/* PageContainer (a.k.a. PageShell) — the responsive wrapper EVERY route sits in.
   Guarantees: a sane max-width, consistent 4pt-grid gutters that tighten on
   mobile, vertical scroll within the Layout's <main>, and — critically — ZERO
   horizontal overflow at 390px (overflow-x-clip + min-w-0). Compose a page as
   <PageContainer><PageHeader/>…</PageContainer>. */
export function PageContainer({
  children,
  width = 'default',
  className,
}: {
  children: ReactNode
  /** default = 1200px reading width · wide = 1600px for dense tables · full = fluid */
  width?: 'default' | 'wide' | 'full'
  className?: string
}) {
  const max =
    width === 'full' ? 'max-w-none' : width === 'wide' ? 'max-w-[1600px]' : 'max-w-[1200px]'
  return (
    <div className="h-full overflow-y-auto overflow-x-clip">
      <div className={cn('mx-auto w-full min-w-0 px-4 py-5 sm:px-6 sm:py-7', max, className)}>
        {children}
      </div>
    </div>
  )
}
