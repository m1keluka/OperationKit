/* ─────────────────────────────────────────────────────────
   ActivityIndicator — back-compat shim.
   The canonical primitive is now `ThinkingIndicator` in
   `./design/primitives`. This shim adapts the old
   `variant: 'loading' | 'working' | 'idle'` API so existing
   callers don't need to be touched immediately.
   ───────────────────────────────────────────────────────── */
import { ThinkingIndicator } from './design/primitives'

interface ActivityIndicatorProps {
  variant: 'loading' | 'working' | 'idle'
  label?: string
  className?: string
}

export function ActivityIndicator({ variant, label, className = '' }: ActivityIndicatorProps) {
  if (variant === 'idle') return null

  if (variant === 'loading') {
    return (
      <div className={`flex flex-col items-center justify-center gap-3 ${className}`}>
        <ThinkingIndicator variant="dots" tone="accent" />
        {label && <div className="text-sm text-fg-2">{label}</div>}
      </div>
    )
  }

  // working variant — inline dots + optional label
  return (
    <ThinkingIndicator
      variant="dots"
      tone="status-working"
      label={label}
      className={className}
    />
  )
}

// Re-export the canonical primitive for new call sites.
export { ThinkingIndicator } from './design/primitives'
