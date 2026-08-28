import type { ReactNode } from 'react'
import { cn } from './cn'

/* Alert — inline message banner. Tone maps to the semantic triad; the only red
   is `alarm`. Tinted surface + matching hairline + a leading status dot. Use
   for inline form/section feedback (not transient — see Toast for that). */
type Tone = 'info' | 'verify' | 'amber' | 'alarm' | 'accent'

const TONE: Record<Tone, { wrap: string; dot: string; title: string }> = {
  info:   { wrap: 'border-status-working/30 bg-status-working/10', dot: 'bg-status-working', title: 'text-status-working' },
  verify: { wrap: 'border-signal-verify/30 bg-signal-verify/10',   dot: 'bg-signal-verify',  title: 'text-signal-verify' },
  amber:  { wrap: 'border-signal-amber/30 bg-signal-amber/10',     dot: 'bg-signal-amber',   title: 'text-signal-amber' },
  alarm:  { wrap: 'border-signal-alarm/30 bg-signal-alarm/10',     dot: 'bg-signal-alarm',   title: 'text-signal-alarm' },
  accent: { wrap: 'border-[color:var(--accent-line)] bg-[var(--accent-tint)]', dot: 'bg-accent', title: 'text-accent-hover' },
}

export function Alert({
  tone = 'info',
  title,
  children,
  className,
}: {
  tone?: Tone
  title?: ReactNode
  children?: ReactNode
  className?: string
}) {
  const t = TONE[tone]
  return (
    <div role="status" className={cn('flex gap-2.5 rounded-md border p-3', t.wrap, className)}>
      <span className={cn('mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full', t.dot)} aria-hidden="true" />
      <div className="min-w-0 text-[13px] leading-relaxed">
        {title && <p className={cn('font-medium', t.title)}>{title}</p>}
        {children && <div className="text-fg-2">{children}</div>}
      </div>
    </div>
  )
}

/* Toast — the same language as Alert but for transient, floating feedback.
   Render inside a fixed container; surface-3 + float shadow (overlay = shadow OK). */
export function Toast({
  tone = 'info',
  title,
  children,
  onDismiss,
  className,
}: {
  tone?: Tone
  title?: ReactNode
  children?: ReactNode
  onDismiss?: () => void
  className?: string
}) {
  const t = TONE[tone]
  return (
    <div
      role="status"
      className={cn(
        'pointer-events-auto flex w-[320px] max-w-[calc(100vw-2rem)] gap-2.5 rounded-lg border border-line bg-surface-3 p-3 shadow-float',
        className,
      )}
    >
      <span className={cn('mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full', t.dot)} aria-hidden="true" />
      <div className="min-w-0 flex-1 text-[13px] leading-relaxed">
        {title && <p className={cn('font-medium', t.title)}>{title}</p>}
        {children && <div className="text-fg-2">{children}</div>}
      </div>
      {onDismiss && (
        <button
          onClick={onDismiss}
          aria-label="Dismiss"
          className="-mr-1 -mt-1 h-6 w-6 shrink-0 rounded text-fg-3 transition-colors duration-fast hover:bg-surface-4 hover:text-fg-1"
        >
          ×
        </button>
      )}
    </div>
  )
}
