/**
 * Per-seat usage for Settings → Seats: rolling 24h / 7d tokens and sessions,
 * the current rate-limit state (5-hour vs weekly) and reset, the share of the
 * last 24h the seat spent rate-limited, and a pool-level over/under-provisioned
 * hint.
 *
 * Pure aggregation: everything comes in as arguments (db handle, `now`, the
 * seat records, the rate-limit history events), so it is unit-testable with a
 * throwaway DB and a fixed clock. The route layer (routes/admin-seats.ts) feeds
 * it the live router state and the rate-limit history log.
 *
 * Data sources, per metric:
 *   - tokens_24h / tokens_7d — `session_intel` rows attributed to the seat
 *     (`account_id`), bucketed by `ended_at` (one row per completed session,
 *     `total_tokens`). A session is counted in the window it ENDED in, so a
 *     session still running contributes its tokens once it ends. This is the
 *     same source the account dashboard uses (session-account-status.ts).
 *     `session_usage_daily` is per Eastern calendar day and cannot express a
 *     rolling 24h window, so it is not used here.
 *   - sessions_24h / sessions_7d — distinct session ids touching the seat in
 *     the window: `session_intel` (ended in the window), `session_runtime`
 *     (seat assigned in the window — recordSessionSeat in seat-assign.ts) and
 *     the seat's live `activeSessions`.
 *   - limit_state / limit_reset_at — the seat's cooldown (`rateLimitResetsAt`,
 *     i.e. cooldown_until). The router does not record WHICH limit was hit, so
 *     it is classified heuristically: `weekly` when the latest rate-limit
 *     history message for the seat mentions a week ("weekly limit"), or the
 *     cooldown runs longer than one 5-hour window; otherwise `5h`. The reset is
 *     when the router will put the seat back in rotation (a stated reset when
 *     the CLI message carried a parsable time, else the backoff).
 *   - limited_pct_24h — union of the seat's rate-limit intervals
 *     `[event.timestamp, event.resetTime]` from the rate-limit history log
 *     (CC_RATE_LIMIT_LOG), plus the live cooldown, clipped to the last 24h.
 *     Credits-exhausted and auth-failure rows in that log are not rate limits
 *     and are ignored. An early clear (good turn) is not logged, so this is an
 *     upper bound.
 */
import type Database from 'better-sqlite3'
import type { RateLimitEvent } from './account-router.js'
import { seatHealth, seatKind, type SeatHealth, type SeatKind, type SeatRecord } from './seat-pool.js'

export const HOUR_MS = 60 * 60 * 1000
export const DAY_MS = 24 * HOUR_MS
export const WEEK_MS = 7 * DAY_MS
/** One Claude session window. A cooldown longer than this (plus slack) cannot be a 5-hour limit. */
export const FIVE_HOUR_WINDOW_MS = 5 * HOUR_MS
export const WEEKLY_COOLDOWN_THRESHOLD_MS = FIVE_HOUR_WINDOW_MS + 10 * 60 * 1000
/** A limit message naming a week ("weekly limit", "7-day limit") is a weekly limit. */
export const WEEKLY_LIMIT_RE = /\bweekly\b|\bweek\b|7[- ]day/i
/** A seat rate-limited for MORE than this share of the last 24h counts toward "under-provisioned". */
export const UNDER_PROVISIONED_LIMITED_PCT = 25
/** A usable seat with AT MOST this many sessions in the last 24h is idle → "over-provisioned". */
export const IDLE_SESSIONS_24H = 0
/** How many of the most recent rate-limit history lines to scan (24h of a busy pool fits easily). */
export const RATE_LIMIT_HISTORY_SCAN = 5000

export type SeatLimitState = 'healthy' | '5h' | 'weekly'

export interface SeatUsage {
  tokens_24h: number
  tokens_7d: number
  sessions_24h: number
  sessions_7d: number
  /** Rate-limit state only (see `health` on the summary for parks / disabled). */
  limit_state: SeatLimitState
  /** ISO; when the cooldown ends. null when not rate-limited. */
  limit_reset_at: string | null
  /** 0–100, one decimal. */
  limited_pct_24h: number
}

export type ProvisioningVerdict = 'under' | 'over' | 'mixed' | 'ok' | 'no_seats'

export interface ProvisioningHint {
  verdict: ProvisioningVerdict
  /** Enabled seats rate-limited more than `thresholds.limited_pct_24h` of the last 24h. */
  limited_seats: number
  /** Usable (enabled, not parked) seats with at most `thresholds.idle_sessions_24h` sessions in 24h. */
  idle_seats: number
  thresholds: { limited_pct_24h: number; idle_sessions_24h: number }
  by_kind: Array<{ kind: SeatKind; seats: number; limited_seats: number; idle_seats: number; verdict: Exclude<ProvisioningVerdict, 'no_seats'> }>
  message: string
}

/** A seat record (AccountSlot satisfies it). */
export type SeatUsageInput = SeatRecord

export interface SeatUsageView {
  usage: Map<string, SeatUsage>
  provisioning: ProvisioningHint
}

/** SQLite `datetime('now')` ("YYYY-MM-DD HH:MM:SS", UTC) or ISO → epoch ms. */
export function parseTimestamp(v: string | null | undefined): number {
  if (!v) return NaN
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(v)) return Date.parse(`${v.replace(' ', 'T')}Z`)
  return Date.parse(v)
}

/** Credits-exhausted / auth-failure rows share the rate-limit log but are not rate limits. */
export function isRateLimitEvent(e: Pick<RateLimitEvent, 'triggerMessage'>): boolean {
  const msg = e.triggerMessage || ''
  return !msg.startsWith('[credits-exhausted]') && !msg.startsWith('[auth-failure')
}

/** Total length of the union of [start, end) intervals, clipped to [lo, hi]. */
export function unionLength(intervals: Array<[number, number]>, lo: number, hi: number): number {
  const clipped = intervals
    .map(([a, b]) => [Math.max(a, lo), Math.min(b, hi)] as [number, number])
    .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && b > a)
    .sort((x, y) => x[0] - y[0])
  let total = 0
  let curA = NaN
  let curB = NaN
  for (const [a, b] of clipped) {
    if (Number.isNaN(curA) || a > curB) {
      if (!Number.isNaN(curA)) total += curB - curA
      curA = a
      curB = b
    } else if (b > curB) {
      curB = b
    }
  }
  if (!Number.isNaN(curA)) total += curB - curA
  return total
}

/** 5-hour vs weekly classification of a live cooldown (heuristic — see file header). */
export function classifyLimit(
  seat: SeatUsageInput,
  latestEvent: RateLimitEvent | null,
  now: number,
): { state: SeatLimitState; resetAt: string | null } {
  const reset = parseTimestamp(seat.rateLimitResetsAt)
  if (!Number.isFinite(reset) || reset <= now) return { state: 'healthy', resetAt: null }
  const resetAt = new Date(reset).toISOString()
  if (latestEvent?.triggerMessage && WEEKLY_LIMIT_RE.test(latestEvent.triggerMessage)) return { state: 'weekly', resetAt }
  const since = parseTimestamp(seat.lastRateLimit ?? latestEvent?.timestamp ?? null)
  if (Number.isFinite(since) && reset - since > WEEKLY_COOLDOWN_THRESHOLD_MS) return { state: 'weekly', resetAt }
  return { state: '5h', resetAt }
}

interface IntelRow { session_id: string; account_id: string; ended_at: string; total_tokens: number }
interface RuntimeRow { session_id: string; account_id: string; updated_at: string }

function safeAll<T>(fn: () => T[]): T[] {
  try { return fn() } catch { return [] }
}

export function computeSeatUsage(args: {
  db: Database.Database
  now: number
  seats: SeatUsageInput[]
  rateLimitEvents: RateLimitEvent[]
}): SeatUsageView {
  const { db, now, seats, rateLimitEvents } = args
  const cut24 = now - DAY_MS
  const cut7d = now - WEEK_MS
  // Coarse SQL prefilter by day (stored timestamps mix ISO and SQLite formats,
  // which do not compare correctly as strings); the exact cut is done below.
  const prefilterDay = new Date(cut7d - DAY_MS).toISOString().slice(0, 10)

  const intel = safeAll(() => db.prepare(
    `SELECT session_id, account_id, ended_at, total_tokens FROM session_intel
     WHERE account_id IS NOT NULL AND ended_at >= ?`,
  ).all(prefilterDay) as IntelRow[])
  const runtime = safeAll(() => db.prepare(
    `SELECT session_id, account_id, updated_at FROM session_runtime
     WHERE account_id IS NOT NULL AND updated_at >= ?`,
  ).all(prefilterDay) as RuntimeRow[])

  type Acc = { tok24: number; tok7: number; s24: Set<string>; s7: Set<string> }
  const acc = new Map<string, Acc>()
  for (const s of seats) acc.set(s.id, { tok24: 0, tok7: 0, s24: new Set(), s7: new Set() })

  for (const r of intel) {
    const a = acc.get(r.account_id)
    const t = parseTimestamp(r.ended_at)
    if (!a || !Number.isFinite(t) || t > now || t <= cut7d) continue
    a.tok7 += r.total_tokens || 0
    a.s7.add(r.session_id)
    if (t > cut24) {
      a.tok24 += r.total_tokens || 0
      a.s24.add(r.session_id)
    }
  }
  for (const r of runtime) {
    const a = acc.get(r.account_id)
    const t = parseTimestamp(r.updated_at)
    if (!a || !Number.isFinite(t) || t > now || t <= cut7d) continue
    a.s7.add(r.session_id)
    if (t > cut24) a.s24.add(r.session_id)
  }
  for (const s of seats) {
    const a = acc.get(s.id)!
    for (const sid of s.activeSessions || []) {
      a.s7.add(sid)
      a.s24.add(sid)
    }
  }

  // Rate-limit intervals + latest event per seat.
  const intervals = new Map<string, Array<[number, number]>>()
  const latest = new Map<string, RateLimitEvent>()
  for (const e of rateLimitEvents) {
    if (!e || !acc.has(e.accountId) || !isRateLimitEvent(e)) continue
    const start = parseTimestamp(e.timestamp)
    if (!Number.isFinite(start) || start > now) continue
    const end = parseTimestamp(e.resetTime)
    if (Number.isFinite(end)) {
      const list = intervals.get(e.accountId) || []
      list.push([start, end])
      intervals.set(e.accountId, list)
    }
    const prev = latest.get(e.accountId)
    if (!prev || parseTimestamp(prev.timestamp) <= start) latest.set(e.accountId, e)
  }

  const usage = new Map<string, SeatUsage>()
  const health = new Map<string, SeatHealth>()
  for (const s of seats) {
    const a = acc.get(s.id)!
    const h = seatHealth(s, now)
    health.set(s.id, h)
    const limit = h === 'cooling_down' ? classifyLimit(s, latest.get(s.id) ?? null, now) : { state: 'healthy' as const, resetAt: null }
    const list = [...(intervals.get(s.id) || [])]
    if (limit.resetAt) {
      const since = parseTimestamp(s.lastRateLimit)
      list.push([Number.isFinite(since) ? since : now, Date.parse(limit.resetAt)])
    }
    const limitedMs = unionLength(list, cut24, now)
    usage.set(s.id, {
      tokens_24h: a.tok24,
      tokens_7d: a.tok7,
      sessions_24h: a.s24.size,
      sessions_7d: a.s7.size,
      limit_state: limit.state,
      limit_reset_at: limit.resetAt,
      limited_pct_24h: Math.round((limitedMs / DAY_MS) * 1000) / 10,
    })
  }

  return { usage, provisioning: provisioningHint(seats.map(s => ({ kind: seatKind(s), enabled: s.enabled !== false, health: health.get(s.id)!, usage: usage.get(s.id)! }))) }
}

const KIND_NAME: Record<SeatKind, string> = { claude: 'Claude', codex: 'Codex', grok: 'Grok' }
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

function verdictOf(limited: number, idle: number): Exclude<ProvisioningVerdict, 'no_seats'> {
  if (limited > 0 && idle > 0) return 'mixed'
  if (limited > 0) return 'under'
  if (idle > 0) return 'over'
  return 'ok'
}

/**
 * Pool-level hint, per engine (seats only substitute for seats of the same
 * kind). Disabled seats are ignored; parked seats (auth / credits) can be
 * limited but are never "idle" — they are broken, not spare.
 */
export function provisioningHint(
  seats: Array<{ kind: SeatKind; enabled: boolean; health: SeatHealth; usage: SeatUsage }>,
): ProvisioningHint {
  const thresholds = { limited_pct_24h: UNDER_PROVISIONED_LIMITED_PCT, idle_sessions_24h: IDLE_SESSIONS_24H }
  const byKind = new Map<SeatKind, { seats: number; limited: number; idle: number }>()
  for (const s of seats) {
    if (!s.enabled) continue
    const k = byKind.get(s.kind) || { seats: 0, limited: 0, idle: 0 }
    k.seats++
    if (s.usage.limited_pct_24h > UNDER_PROVISIONED_LIMITED_PCT) k.limited++
    else if ((s.health === 'healthy' || s.health === 'cooling_down') && s.usage.sessions_24h <= IDLE_SESSIONS_24H) k.idle++
    byKind.set(s.kind, k)
  }
  const by_kind = [...byKind.entries()].map(([kind, k]) => ({
    kind, seats: k.seats, limited_seats: k.limited, idle_seats: k.idle, verdict: verdictOf(k.limited, k.idle),
  }))
  const limited_seats = by_kind.reduce((n, k) => n + k.limited_seats, 0)
  const idle_seats = by_kind.reduce((n, k) => n + k.idle_seats, 0)
  if (by_kind.length === 0) {
    return { verdict: 'no_seats', limited_seats, idle_seats, thresholds, by_kind, message: 'No enabled seats.' }
  }
  const under = by_kind.filter(k => k.limited_seats > 0)
  const over = by_kind.filter(k => k.idle_seats > 0)
  const parts: string[] = []
  if (under.length) {
    parts.push(`${plural(limited_seats, 'seat')} rate-limited >${UNDER_PROVISIONED_LIMITED_PCT}% of the last 24h → under-provisioned (${under.map(k => KIND_NAME[k.kind]).join(', ')})`)
  }
  if (over.length) {
    parts.push(`${plural(idle_seats, 'seat')} idle (${IDLE_SESSIONS_24H === 0 ? 'no sessions' : `≤${IDLE_SESSIONS_24H} sessions`} in 24h) → over-provisioned (${over.map(k => KIND_NAME[k.kind]).join(', ')})`)
  }
  const verdict: ProvisioningVerdict = under.length && over.length ? 'mixed' : under.length ? 'under' : over.length ? 'over' : 'ok'
  return {
    verdict,
    limited_seats,
    idle_seats,
    thresholds,
    by_kind,
    message: parts.length ? parts.join('; ') : 'Seat count looks right for the last 24h.',
  }
}
