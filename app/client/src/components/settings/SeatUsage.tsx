/**
 * Settings → Seats: per-seat rolling usage (24h / 7d tokens + sessions), the
 * rate-limit state (5-hour vs weekly) with its reset in the VIEWER's local time
 * and timezone, and the pool's over/under-provisioned hint banner.
 *
 * Types mirror server/src/services/seat-usage.ts (SeatUsage / ProvisioningHint).
 */
import { Alert, Badge } from '../../components/ui'

export type SeatLimitState = 'healthy' | '5h' | 'weekly'

export interface SeatUsage {
  tokens_24h: number
  tokens_7d: number
  sessions_24h: number
  sessions_7d: number
  limit_state: SeatLimitState
  limit_reset_at: string | null
  limited_pct_24h: number
}

export type ProvisioningVerdict = 'under' | 'over' | 'mixed' | 'ok' | 'no_seats'

export interface ProvisioningHint {
  verdict: ProvisioningVerdict
  limited_seats: number
  idle_seats: number
  thresholds: { limited_pct_24h: number; idle_sessions_24h: number }
  by_kind: Array<{ kind: 'claude' | 'codex' | 'grok'; seats: number; limited_seats: number; idle_seats: number; verdict: Exclude<ProvisioningVerdict, 'no_seats'> }>
  message: string
}

const fmtCompact = (n: number) => new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(n)
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/**
 * A reset instant in the viewer's local time with a timezone label, e.g.
 * "Nov 3, 9:00 AM EST". `timeZone` is for tests only; the screen always uses
 * the browser's zone.
 */
export function fmtLocalReset(iso: string, timeZone?: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
    ...(timeZone ? { timeZone } : {}),
  }).format(d)
}

export function limitBadge(usage: Pick<SeatUsage, 'limit_state'>): { tone: 'verify' | 'amber' | 'alarm'; text: string } {
  switch (usage.limit_state) {
    case '5h': return { tone: 'amber', text: '5-hour limit' }
    case 'weekly': return { tone: 'alarm', text: 'Weekly limit' }
    default: return { tone: 'verify', text: 'No limit hit' }
  }
}

/** The usage rows inside a seat card's stats grid. */
export function SeatUsageStats({ usage }: { usage: SeatUsage }) {
  const badge = limitBadge(usage)
  const limited = usage.limit_state !== 'healthy'
  return (
    <>
      <div>
        <dt className="text-fg-3">Last 24h</dt>
        <dd className="font-mono text-fg-1" data-testid="seat-usage-24h">
          {fmtCompact(usage.tokens_24h)} tokens · {plural(usage.sessions_24h, 'session')}
        </dd>
      </div>
      <div>
        <dt className="text-fg-3">Last 7 days</dt>
        <dd className="font-mono text-fg-1" data-testid="seat-usage-7d">
          {fmtCompact(usage.tokens_7d)} tokens · {plural(usage.sessions_7d, 'session')}
        </dd>
      </div>
      <div className="col-span-2">
        <dt className="text-fg-3">Rate limit</dt>
        <dd className="flex flex-wrap items-center gap-x-2 gap-y-1 text-fg-1" data-testid="seat-limit">
          <Badge tone={badge.tone}>{badge.text}</Badge>
          {limited && usage.limit_reset_at && (
            <span className="text-fg-2">resets {fmtLocalReset(usage.limit_reset_at)}</span>
          )}
          {usage.limited_pct_24h > 0 && (
            <span className="text-fg-3">limited {usage.limited_pct_24h}% of last 24h</span>
          )}
        </dd>
      </div>
    </>
  )
}

/** At-a-glance pool sizing hint from the last 24h. Hidden when there is nothing to say. */
export function ProvisioningBanner({ hint }: { hint: ProvisioningHint | null | undefined }) {
  if (!hint || hint.verdict === 'no_seats') return null
  const title =
    hint.verdict === 'under' ? 'Under-provisioned'
      : hint.verdict === 'over' ? 'Over-provisioned'
        : hint.verdict === 'mixed' ? 'Seats are unevenly loaded'
          : 'Seat count looks right'
  const tone = hint.verdict === 'ok' ? 'verify' : hint.verdict === 'over' ? 'info' : 'amber'
  return (
    <div data-testid="seat-provisioning">
      <Alert tone={tone} title={title}>
        <p className="break-words">{hint.message}</p>
        {hint.verdict !== 'ok' && (
          <p className="mt-1 text-[12px] text-fg-3">
            Under = rate-limited more than {hint.thresholds.limited_pct_24h}% of the last 24h. Over = {hint.thresholds.idle_sessions_24h === 0 ? 'no sessions' : `at most ${plural(hint.thresholds.idle_sessions_24h, 'session')}`} in the last 24h.
          </p>
        )}
      </Alert>
    </div>
  )
}
