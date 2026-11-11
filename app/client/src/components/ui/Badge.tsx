import type { ReactNode } from 'react'
import { cn } from './cn'

/* Badge — small chip for tags, counts, model/workspace/PR labels.
   `mono` renders machine data (PR #, ids) in Geist Mono. Tinted variants
   read straight from the status/accent tokens — never a hardcoded hex. */
type Tone = 'neutral' | 'accent' | 'verify' | 'amber' | 'alarm' | 'info'

const TONE: Record<Tone, string> = {
  neutral: 'border-line bg-surface-3 text-fg-2',
  accent: 'border-[color:var(--accent-line)] bg-[var(--accent-tint)] text-accent-hover',
  verify: 'border-signal-verify/30 bg-signal-verify/10 text-signal-verify',
  amber: 'border-signal-amber/30 bg-signal-amber/10 text-signal-amber',
  alarm: 'border-signal-alarm/30 bg-signal-alarm/10 text-signal-alarm',
  info: 'border-status-working/30 bg-status-working/10 text-status-working',
}

export function Badge({
  tone = 'neutral',
  mono,
  className,
  children,
}: {
  tone?: Tone
  mono?: boolean
  className?: string
  children: ReactNode
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 text-[11px] font-medium leading-none',
        mono && 'font-mono tracking-[0.01em]',
        TONE[tone],
        className,
      )}
    >
      {children}
    </span>
  )
}

/* StatusPill — the 7-status pipeline chip. Consumes --st-* tokens via the
   status-* Tailwind colors. A leading dot carries the color; `human` (needs-you)
   reads in the accent. This is the canonical status surface for tables/lists. */
export type PipelineStatus =
  | 'planning' | 'queue' | 'working' | 'ai' | 'review' | 'human' | 'done' | 'blocked'

const STATUS: Record<PipelineStatus, { label: string; dot: string; text: string; ring: string }> = {
  planning: { label: 'Planning', dot: 'bg-status-planning', text: 'text-status-planning', ring: 'border-status-planning/30' },
  queue:    { label: 'Queued',   dot: 'bg-status-queue',    text: 'text-status-queue',    ring: 'border-status-queue/30' },
  working:  { label: 'Working',  dot: 'bg-status-working',  text: 'text-status-working',  ring: 'border-status-working/30' },
  ai:       { label: 'AI Review',dot: 'bg-status-ai',       text: 'text-status-ai',       ring: 'border-status-ai/30' },
  review:   { label: 'In Review',dot: 'bg-status-review',   text: 'text-status-review',   ring: 'border-status-review/30' },
  human:    { label: 'Needs You',dot: 'bg-accent',          text: 'text-accent-hover',    ring: 'border-[color:var(--accent-line)]' },
  done:     { label: 'Done',     dot: 'bg-status-done',     text: 'text-status-done',     ring: 'border-status-done/30' },
  blocked:  { label: 'Blocked',  dot: 'bg-signal-alarm',    text: 'text-signal-alarm',    ring: 'border-signal-alarm/30' },
}

export function StatusPill({ status, className }: { status: PipelineStatus; className?: string }) {
  const s = STATUS[status]
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border bg-surface-2 px-2 py-0.5 text-[11px] font-medium leading-none',
        s.ring,
        s.text,
        className,
      )}
    >
      <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', s.dot)} aria-hidden="true" />
      {s.label}
    </span>
  )
}
