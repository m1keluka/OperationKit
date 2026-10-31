/**
 * Seat pool v2 — the pure policy layer (no fs, no DB, no clock reads).
 *
 * A "seat" is one subscription login an operator connected for one engine
 * (Claude, Codex or Grok). The account router keeps the seat records; this
 * module decides, from those records alone:
 *   - each seat's health (healthy / cooling_down / needs_reconnect / needs_admin /
 *     credits_exhausted / disabled),
 *   - how a failure changes a seat (classifySeatFailure + applySeatFailure),
 *   - that a good turn clears a false cooldown (applyGoodTurn),
 *   - which seat a new session gets (pickSeat),
 *   - whether a card may fail over to another engine (resolveEngineFailover).
 *
 * The failure classes and the cooldown-with-backoff idea are adapted from
 * OmniRoute (https://github.com/cheaper-inference/OmniRoute, MIT,
 * Copyright (c) 2026 diegosouzapw). The ideas only — no OmniRoute code is
 * copied or ported; credited in docs/wiki/Accounts-Subscriptions-and-Seats.md.
 * Sessions always run the official, unmodified CLIs.
 */

export type SeatKind = 'claude' | 'codex' | 'grok'
export const SEAT_KINDS: readonly SeatKind[] = ['claude', 'codex', 'grok']

export type SeatHealth =
  | 'healthy'
  | 'cooling_down'
  | 'needs_reconnect'
  | 'needs_admin'
  | 'credits_exhausted'
  | 'disabled'

/** setup_token = a long-lived token pasted once (no refresh). cli_login = the CLI's own login files (refresh token rotates). */
export type SeatCredentialKind = 'setup_token' | 'cli_login'

export type SeatFailureClass =
  | 'rate_limit'         // 429 / usage cap — cools down
  | 'auth'               // 401 / dead OAuth — needs_reconnect
  | 'org_disabled'       // 403 org/plan disabled — needs_admin
  | 'credits_exhausted'  // credits or spend cap — parked, no rotation churn
  | 'transient'          // 5xx / timeout / overloaded — no seat penalty, retry once
  | 'none'

/** The subset of a seat record the policy reads/writes. AccountSlot satisfies it. */
export interface SeatRecord {
  id: string
  kind?: SeatKind
  priority: number
  enabled?: boolean
  activeSessions: string[]
  sessionsToday: number
  tokensToday: number
  credentialKind?: SeatCredentialKind | null
  credentialExpiresAt?: string | null
  rateLimitResetsAt: string | null   // = cooldown_until (field name kept for state-file compatibility)
  lastRateLimit: string | null
  authFailedAt?: string | null
  authFailureReason?: 'needs_admin' | 'needs_reconnect' | null
  creditsExhaustedAt?: string | null
  consecutiveFailures?: number
}

export function seatKind(seat: Pick<SeatRecord, 'kind'>): SeatKind {
  return seat.kind === 'codex' || seat.kind === 'grok' ? seat.kind : 'claude'
}

/** Health, most-severe first. A cooldown in the past is healthy. */
export function seatHealth(seat: SeatRecord, now: number): SeatHealth {
  if (seat.enabled === false) return 'disabled'
  if (seat.authFailedAt) return seat.authFailureReason === 'needs_admin' ? 'needs_admin' : 'needs_reconnect'
  if (seat.creditsExhaustedAt) return 'credits_exhausted'
  if (seat.rateLimitResetsAt && Date.parse(seat.rateLimitResetsAt) > now) return 'cooling_down'
  return 'healthy'
}

// ── Failure classification ──────────────────────────────────────────────────

const RATE_LIMIT_RE = /you[''’]ve hit your limit|hit your (?:[\w''’]+ )*limit|usage limit|rate.?limit|too many requests|quota exceeded/i
const CREDITS_RE = /monthly spend limit|spend limit|admin-settings\/usage|credit balance is too low|insufficient[_ ]credits|out of credits|credits? (?:are |have been )?exhausted|billing hard limit|insufficient_quota/i
const ORG_DISABLED_RE = /disabled Claude subscription access|organization has disabled (?:Claude )?subscription|ask your admin to enable(?: Claude subscription)? access|plan (?:has been |is )?disabled|organization (?:has been |is )?(?:disabled|deactivated)/i
const AUTH_RE = /invalid authentication credentials|authentication_failed|oauth session expired|could not be refreshed|invalid api key|token (?:has )?expired|not logged in|please (?:run )?(?:\/)?login/i
const TRANSIENT_RE = /\b(?:500|502|503|504|529)\b|overloaded|internal server error|bad gateway|service unavailable|gateway timeout|timed? ?out|ECONNRESET|ETIMEDOUT|socket hang up/i

/**
 * Classify a failure from its HTTP status (when known) and message text.
 * Order matters: credits/spend caps also read like rate limits, and must win
 * so a capped seat is parked instead of cooled-down-and-retried forever.
 */
export function classifySeatFailure(input: { status?: number | null; text?: string | null }): SeatFailureClass {
  const status = typeof input.status === 'number' ? input.status : null
  const text = input.text || ''
  if (CREDITS_RE.test(text) || status === 402) return 'credits_exhausted'
  if (ORG_DISABLED_RE.test(text)) return 'org_disabled'
  if (status === 401 || AUTH_RE.test(text)) return 'auth'
  // A bare 403 can be an ordinary permission error on some other resource; only
  // the org/plan-disabled body (matched above) parks a seat.
  if (status === 429 || RATE_LIMIT_RE.test(text)) return 'rate_limit'
  if ((status !== null && status >= 500 && status <= 599) || TRANSIENT_RE.test(text)) return 'transient'
  return 'none'
}

// ── Cooldown ────────────────────────────────────────────────────────────────

/** First backoff step when a rate limit carries no reset time. */
export const COOLDOWN_BASE_MS = 15 * 60 * 1000
/** Backoff ceiling: never bench a seat longer than one 5-hour usage window without a stated reset. */
export const COOLDOWN_CEILING_MS = 5 * 60 * 60 * 1000

/** Exponential backoff: base × 2^(failures-1), capped. `failures` counts this one (≥1). */
export function backoffMs(failures: number): number {
  const n = Math.max(1, Math.floor(failures))
  return Math.min(COOLDOWN_BASE_MS * 2 ** (n - 1), COOLDOWN_CEILING_MS)
}

export interface FailureEffect {
  cls: SeatFailureClass
  /** Caller should retry the same turn once (transient only). */
  retry: boolean
  /** Seat is now out of rotation for this failure. */
  parked: boolean
}

/**
 * Apply a classified failure to a seat (mutates). `resetAt` is the provider's
 * stated reset time when the message carried one.
 */
export function applySeatFailure(
  seat: SeatRecord,
  cls: SeatFailureClass,
  opts: { now: number; resetAt?: Date | null },
): FailureEffect {
  const nowIso = new Date(opts.now).toISOString()
  switch (cls) {
    case 'rate_limit': {
      const failures = (seat.consecutiveFailures || 0) + 1
      seat.consecutiveFailures = failures
      const stated = opts.resetAt && opts.resetAt.getTime() > opts.now ? opts.resetAt.getTime() : null
      let until = stated ?? opts.now + backoffMs(failures)
      // Never push recovery later than an already-known sooner reset.
      const existing = seat.rateLimitResetsAt ? Date.parse(seat.rateLimitResetsAt) : NaN
      if (Number.isFinite(existing) && existing > opts.now && existing < until) until = existing
      seat.lastRateLimit = nowIso
      seat.rateLimitResetsAt = new Date(until).toISOString()
      return { cls, retry: false, parked: true }
    }
    case 'auth':
    case 'org_disabled':
      seat.authFailedAt = nowIso
      seat.authFailureReason = cls === 'org_disabled' ? 'needs_admin' : 'needs_reconnect'
      seat.rateLimitResetsAt = null
      seat.lastRateLimit = null
      seat.consecutiveFailures = (seat.consecutiveFailures || 0) + 1
      return { cls, retry: false, parked: true }
    case 'credits_exhausted':
      seat.creditsExhaustedAt = nowIso
      seat.consecutiveFailures = (seat.consecutiveFailures || 0) + 1
      return { cls, retry: false, parked: true }
    case 'transient':
      return { cls, retry: true, parked: false }
    default:
      return { cls, retry: false, parked: false }
  }
}

/**
 * A completed turn with real usage is proof the seat is live: clear any
 * cooldown and the failure streak. Credential parks (auth / admin) are NOT
 * cleared here — those clear only on a passing health probe or reconnect.
 * Returns true when something changed.
 */
export function applyGoodTurn(seat: SeatRecord): boolean {
  const changed = !!(seat.rateLimitResetsAt || seat.creditsExhaustedAt || seat.consecutiveFailures)
  seat.rateLimitResetsAt = null
  seat.lastRateLimit = null
  seat.creditsExhaustedAt = null
  seat.consecutiveFailures = 0
  return changed
}

// ── Pick ────────────────────────────────────────────────────────────────────

export interface PickOptions<T extends SeatRecord = SeatRecord> {
  kind: SeatKind
  now: number
  /** Extra availability check (credential present on disk / in the store). */
  usable?: (seat: T) => boolean
  /**
   * Sandboxed sessions: prefer an idle seat over a busy one before priority, so
   * concurrent sessions land on different seats while any is free.
   */
  spread?: boolean
  /**
   * Seats that must not be shared by two live sessions (a CLI login whose
   * refresh would invalidate the other session's copy). Busy ones are skipped.
   */
  exclusive?: (seat: T) => boolean
}

export function availableSeats<T extends SeatRecord>(seats: T[], opts: PickOptions<T>): T[] {
  return seats.filter(s =>
    seatKind(s) === opts.kind &&
    seatHealth(s, opts.now) === 'healthy' &&
    (!opts.usable || opts.usable(s)) &&
    !(opts.exclusive && opts.exclusive(s) && s.activeSessions.length > 0),
  )
}

/** Priority asc, then fewest live sessions, then fewest today, then fewest tokens. */
export function pickSeat<T extends SeatRecord>(seats: T[], opts: PickOptions<T>): T | null {
  const pool = availableSeats(seats, opts)
  if (!pool.length) return null
  pool.sort((a, b) => {
    if (opts.spread) {
      const ia = a.activeSessions.length > 0 ? 1 : 0
      const ib = b.activeSessions.length > 0 ? 1 : 0
      if (ia !== ib) return ia - ib
    }
    const pa = a.priority ?? 0
    const pb = b.priority ?? 0
    if (pa !== pb) return pa - pb
    if (a.activeSessions.length !== b.activeSessions.length) return a.activeSessions.length - b.activeSessions.length
    if (a.sessionsToday !== b.sessionsToday) return a.sessionsToday - b.sessionsToday
    return a.tokensToday - b.tokensToday
  })
  return pool[0]
}

/** Earliest future cooldown end among a kind's seats (null = none cooling). */
export function nextResetFor(seats: SeatRecord[], kind: SeatKind, now: number): string | null {
  let best: number | null = null
  for (const s of seats) {
    if (seatKind(s) !== kind || seatHealth(s, now) !== 'cooling_down') continue
    const t = Date.parse(s.rateLimitResetsAt!)
    if (best === null || t < best) best = t
  }
  return best === null ? null : new Date(best).toISOString()
}

// ── Cross-engine failover (opt-in) ─────────────────────────────────────────

export const DEFAULT_FAILOVER_ORDER: readonly SeatKind[] = ['claude', 'codex', 'grok']

export interface FailoverPolicy {
  enabled: boolean
  order: SeatKind[]
}

/** Per-card override stored on the objective: null = inherit workspace, 'pinned' = never fail over, or an ordered list. */
export type CardFailoverOverride = 'pinned' | SeatKind[] | null

/** Parse the objective column. Unknown/garbage → null (inherit). */
export function parseCardFailover(raw: unknown): CardFailoverOverride {
  if (raw === null || raw === undefined || raw === '') return null
  if (raw === 'pinned') return 'pinned'
  let v: unknown = raw
  if (typeof raw === 'string') {
    try { v = JSON.parse(raw) } catch { return null }
  }
  if (!Array.isArray(v)) return null
  return normalizeOrder(v)
}

export function normalizeOrder(v: unknown[]): SeatKind[] {
  const out: SeatKind[] = []
  for (const k of v) {
    if ((k === 'claude' || k === 'codex' || k === 'grok') && !out.includes(k)) out.push(k)
  }
  return out
}

/** Merge the workspace policy with a card override. A pinned card never fails over. */
export function effectiveFailover(workspace: FailoverPolicy, card: CardFailoverOverride): FailoverPolicy {
  if (card === 'pinned') return { enabled: false, order: [] }
  if (Array.isArray(card)) return { enabled: card.length > 1, order: card }
  return workspace
}

export interface FailoverDecision {
  engine: SeatKind
  /** Set when the card moved off its own engine. */
  fellBackFrom: SeatKind | null
  /** No seat on any allowed engine — caller queues. */
  queued: boolean
}

/**
 * Decide which engine a fresh session runs on. The card stays on its own engine
 * whenever ANY of that engine's seats is available. Only when every one is
 * unavailable, and the policy is on, walk the ordered list (skipping the card's
 * own engine) for the first engine with an available seat.
 */
export function resolveEngineFailover(
  cardEngine: SeatKind,
  policy: FailoverPolicy,
  hasAvailableSeat: (kind: SeatKind) => boolean,
): FailoverDecision {
  if (hasAvailableSeat(cardEngine)) return { engine: cardEngine, fellBackFrom: null, queued: false }
  if (policy.enabled) {
    for (const k of policy.order) {
      if (k === cardEngine) continue
      if (hasAvailableSeat(k)) return { engine: k, fellBackFrom: cardEngine, queued: false }
    }
  }
  return { engine: cardEngine, fellBackFrom: null, queued: true }
}

// ── Expiry ──────────────────────────────────────────────────────────────────

export const EXPIRY_WARNING_DAYS = 14

/** 'expired' | 'expiring' (within 14 days) | null. */
export function expiryStatus(expiresAt: string | null | undefined, now: number): 'expired' | 'expiring' | null {
  if (!expiresAt) return null
  const t = Date.parse(expiresAt)
  if (!Number.isFinite(t)) return null
  if (t <= now) return 'expired'
  if (t - now <= EXPIRY_WARNING_DAYS * 24 * 60 * 60 * 1000) return 'expiring'
  return null
}

// ── Masking ─────────────────────────────────────────────────────────────────

/** Last 4 characters at most, and none for short values (a short value's tail is most of it). */
export function credentialHint(value: string): string | null {
  const v = (value || '').trim()
  return v.length >= 20 ? v.slice(-4) : null
}
