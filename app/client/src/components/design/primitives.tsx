import type { ObjectiveStatus, AgentRow } from '@operationkit/shared'

/* ─────────────────────────────────────────────────────────
   Command Center — design primitives (§04, §05, §06, §07)
   One source of truth for status/agent/motion atoms.
   ───────────────────────────────────────────────────────── */

// ── Status meta ──────────────────────────────────────────

export const STATUS_META: Record<ObjectiveStatus, { label: string; tw: string; tone: string }> = {
  planning:  { label: 'Plan',    tw: 'bg-status-planning', tone: 'text-status-planning' },
  queue:     { label: 'Queue',   tw: 'bg-status-queue',    tone: 'text-status-queue' },
  working:   { label: 'Working', tw: 'bg-status-working',  tone: 'text-status-working' },
  ai_review: { label: 'AI Rev',  tw: 'bg-status-ai',       tone: 'text-status-ai' },
  review:    { label: 'Needs You', tw: 'bg-status-human', tone: 'text-status-human' },
  done:      { label: 'Done',    tw: 'bg-status-done',     tone: 'text-status-done' },
  cancelled: { label: 'Retired', tw: 'bg-status-cancelled', tone: 'text-status-cancelled' },
}

export function StatusDot({ status, size = 8 }: { status: ObjectiveStatus; size?: number }) {
  return (
    <span
      aria-hidden="true"
      className={`inline-block shrink-0 rounded-full ${STATUS_META[status].tw}`}
      style={{ width: size, height: size }}
    />
  )
}

// ── Agent identity (§05) ─────────────────────────────────

/**
 * Avatar meta for the FIVE default personas a fresh install ships. This is a
 * bundled FALLBACK, not the roster: the real list is the DB-backed agent
 * registry served by GET /api/agents and loaded via useAgents(), which calls
 * setAgentRegistryMeta() below. Keeping a synchronous seed here is what stops a
 * slow or failed fetch from rendering blank monograms and empty pickers
 * (audit risk #5) — the registry merely overlays it once it arrives.
 */
const DEFAULT_AGENT_META: Record<string, AgentAvatarMeta> = {
  cto:     { mono: 'CT', hex: '#6F9AD8', tw: 'bg-agent-cto' },
  cmo:     { mono: 'CM', hex: '#D389B0', tw: 'bg-agent-cmo' },
  coo:     { mono: 'CO', hex: '#6FB58C', tw: 'bg-agent-coo' },
  cfo:     { mono: 'CF', hex: '#D6A24E', tw: 'bg-agent-cfo' },
  general: { mono: 'GN', hex: '#8C8A92', tw: 'bg-agent-general' },
}

export interface AgentAvatarMeta { mono: string; hex: string; tw: string }

/** Neutral grey used for any slug the registry hasn't styled. Never blank. */
const NEUTRAL_AGENT_META: AgentAvatarMeta = { mono: '··', hex: '#8C8A92', tw: 'bg-agent-general' }

let registryMeta: Record<string, AgentAvatarMeta> = {}

/** Called by useAgents() once GET /api/agents resolves. Rows without explicit
 *  styling still get a deterministic monogram derived from their slug. */
export function setAgentRegistryMeta(rows: AgentRow[]): void {
  const next: Record<string, AgentAvatarMeta> = {}
  for (const r of rows) {
    const fallback = DEFAULT_AGENT_META[r.slug] ?? NEUTRAL_AGENT_META
    next[r.slug] = {
      mono: r.mono || monogramFor(r.slug) || fallback.mono,
      hex: r.badge_hex || fallback.hex,
      tw: r.badge_tw || fallback.tw,
    }
  }
  registryMeta = next
}

/** `general-counsel` → `GC`, `rnd` → `RN`. Deterministic so a user-created
 *  persona has a sensible avatar the moment it is created. */
function monogramFor(slug: string): string {
  const parts = slug.split('-').filter(Boolean)
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase()
  return slug.slice(0, 2).toUpperCase()
}

export function getAgentMeta(agent: string | null | undefined): AgentAvatarMeta {
  const slug = agent || 'general'
  return registryMeta[slug] ?? DEFAULT_AGENT_META[slug] ?? NEUTRAL_AGENT_META
}

export function AgentMonogram({ agent, size = 'sm' }: { agent: string | null | undefined; size?: 'sm' | 'md' }) {
  const meta = getAgentMeta(agent)
  const cls = size === 'md' ? 'h-6 w-6 text-[11px]' : 'h-5 w-5 text-[10px]'
  return (
    <span
      className={`${cls} inline-flex shrink-0 items-center justify-center rounded-sm font-mono font-semibold tracking-tight text-surface-0`}
      style={{ background: meta.hex }}
      aria-label={`agent ${agent || 'general'}`}
    >
      {meta.mono}
    </span>
  )
}

// ── Thinking (§06.1) ─────────────────────────────────────
// One language, reused on running cards, session stream, Assistant composing.

interface ThinkingIndicatorProps {
  variant?: 'dots' | 'caret'
  label?: string
  tone?: 'accent' | 'status-working' | 'status-ai' | 'status-planning' | 'fg-2'
  className?: string
}

export function ThinkingIndicator({
  variant = 'dots',
  label,
  tone = 'fg-2',
  className = '',
}: ThinkingIndicatorProps) {
  const toneCls = {
    accent: 'text-accent',
    'status-working': 'text-status-working',
    'status-ai': 'text-status-ai',
    'status-planning': 'text-status-planning',
    'fg-2': 'text-fg-2',
  }[tone]

  if (variant === 'caret') {
    return (
      <span className={`inline-flex items-center gap-2 ${toneCls} ${className}`}>
        <span className="cc-think-caret" />
        {label && <span className="text-xs">{label}</span>}
      </span>
    )
  }

  return (
    <span className={`inline-flex items-center gap-2 ${toneCls} ${className}`}>
      <span className="inline-flex items-center gap-1">
        <span className="cc-think-dot" />
        <span className="cc-think-dot" />
        <span className="cc-think-dot" />
      </span>
      {label && <span className="text-xs">{label}</span>}
    </span>
  )
}

// ── Connection pulse (§06.2) — honest 3-state ────────────

export type ConnectionState = 'connected' | 'reconnecting' | 'disconnected'

export function ConnectionPulse({ state, label }: { state: ConnectionState; label?: string }) {
  if (state === 'connected') {
    return (
      <span className="inline-flex items-center gap-1.5">
        <span className="inline-block h-2 w-2 rounded-full bg-flag-live" />
        {label && <span className="text-[11px] text-fg-2">{label ?? 'Connected'}</span>}
      </span>
    )
  }
  if (state === 'reconnecting') {
    return (
      <span className="inline-flex items-center gap-1.5">
        <span className="cc-pulse-amber inline-block h-2 w-2" />
        {label && <span className="text-[11px] text-status-review">{label ?? 'Reconnecting'}</span>}
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="inline-block h-2 w-2 rounded-full bg-flag-blocked" />
      {label && <span className="text-[11px] text-flag-blocked">{label ?? 'Disconnected'}</span>}
    </span>
  )
}

// ── Live flag (§06.3) ────────────────────────────────────

export function LiveBadge({ label = 'live' }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-1 text-[11px] font-medium text-flag-live">
      <span className="cc-live-breathe inline-block h-1.5 w-1.5" />
      {label}
    </span>
  )
}

// ── Blocked flag — the only use of red ───────────────────

export function BlockedFlag({ label = 'blocked' }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-sm border border-flag-blocked/30 bg-flag-blocked/10 px-1.5 py-0.5 text-[10px] font-medium text-flag-blocked">
      {label}
    </span>
  )
}

// ── AI Review iteration dot row (§04) ────────────────────
// Three dots = three passes; latest carries the verdict; hollow = pending.

type DotState = 'pass' | 'fail' | 'blocked' | 'pending'

interface AIReviewDotsProps {
  iteration: number             // 1..3 — how many attempts so far
  verdict?: 'pass' | 'fail' | 'blocked' | null
  max?: number
}

export function AIReviewDots({ iteration, verdict, max = 3 }: AIReviewDotsProps) {
  const dots: DotState[] = []
  for (let i = 1; i <= max; i++) {
    if (i < iteration)       dots.push('fail')          // prior attempts implicitly failed
    else if (i === iteration) dots.push(verdict ?? 'pending')
    else                     dots.push('pending')
  }
  return (
    <span className="inline-flex items-center gap-1" title={`AI review — iteration ${iteration}/${max}${verdict ? `, ${verdict}` : ''}`}>
      <span className="text-[10px] font-mono text-fg-2">AI</span>
      {dots.map((d, i) => (
        <span
          key={i}
          className={
            d === 'pass'    ? 'h-1.5 w-1.5 rounded-full bg-status-done' :
            d === 'fail'    ? 'h-1.5 w-1.5 rounded-full bg-flag-blocked' :
            d === 'blocked' ? 'h-1.5 w-1.5 rounded-full bg-status-review' :
            /* pending */    'h-1.5 w-1.5 rounded-full border border-fg-3'
          }
          aria-hidden="true"
        />
      ))}
    </span>
  )
}
