import { cn } from './cn'

/* Skeleton — quiet loading placeholder. surface-3 block with a slow shimmer
   (reduced-motion safe — static fill when the user opts out). Compose into
   rows/cards; DataTable uses it for its built-in loading state. */
export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      className={cn('ok-skeleton rounded-sm bg-surface-3', className)}
      aria-hidden="true"
    />
  )
}

/* SkeletonText — N stacked lines, last line short, for body placeholders. */
export function SkeletonText({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <div className={cn('flex flex-col gap-2', className)} aria-hidden="true">
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton key={i} className={cn('h-3', i === lines - 1 ? 'w-2/5' : 'w-full')} />
      ))}
    </div>
  )
}
