import { Skeleton, SkeletonText } from './ui'

/**
 * RouteFallback — Suspense fallback shown while a lazily-loaded route chunk is
 * fetched (obj 700585 code-splitting). A designed skeleton (not a bare spinner)
 * that roughly mirrors a page header + content block so the transition into a
 * secondary route doesn't flash empty. Reduced-motion safe via the shared
 * Skeleton primitive's shimmer.
 */
export function RouteFallback() {
  return (
    <div className="flex h-full flex-col gap-6 p-6" aria-busy="true" aria-label="Loading">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-3.5 w-72" />
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="flex flex-col gap-3 rounded-md border border-line bg-surface-1 p-4">
            <Skeleton className="h-4 w-2/3" />
            <SkeletonText lines={3} />
          </div>
        ))}
      </div>
    </div>
  )
}
