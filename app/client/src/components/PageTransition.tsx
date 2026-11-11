import * as React from 'react'

/**
 * PageTransition — replays the app's existing `cc-land` motion (4px rise + fade,
 * --dur-base ease-out) on each route change via a keyed remount. The cc-land
 * keyframe is defined in index.css behind `@media (prefers-reduced-motion:
 * no-preference)`, so reduced-motion users automatically get an instant,
 * animation-free swap — no extra guard needed here.
 *
 * Small distance is deliberate (the Vercel tell): pages settle, they don't fly.
 * Reuses the shipped motion vocabulary rather than inventing a new keyframe.
 */
export function PageTransition({
  routeKey,
  children,
  className = '',
}: {
  routeKey: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <div key={routeKey} className={`h-full cc-land ${className}`}>
      {children}
    </div>
  )
}
