/**
 * Shared Config page form tokens — extracted from ConfigPage.tsx (behavior frozen).
 */
import type { ReactNode } from 'react'
import { cn } from '../ui'

// Shared input styling — token-bound, matches the Mission Control surface
// language (no hardcoded hex). Used across the forms on this page.
export const inputCls =
  'w-full min-w-0 rounded-md border border-line bg-surface-1 px-3 py-2 text-[13px] text-fg-0 ' +
  'placeholder-fg-3 transition-colors focus:border-accent focus:outline-none'
export const selectCls =
  'rounded-md border border-line bg-surface-1 px-2.5 py-2 text-[13px] text-fg-0 focus:border-accent focus:outline-none'

export function SectionLabel({ icon, children, className }: { icon?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cn('mb-2 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-fg-3', className)}>
      {icon}{children}
    </div>
  )
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`
}

export function formatName(name: string): string {
  return name.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

