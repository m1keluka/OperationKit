import { describe, it, expect } from 'vitest'
import {
  applyGoodTurn,
  applySeatFailure,
  backoffMs,
  classifySeatFailure,
  COOLDOWN_BASE_MS,
  COOLDOWN_CEILING_MS,
  credentialHint,
  effectiveFailover,
  expiryStatus,
  nextResetFor,
  parseCardFailover,
  pickSeat,
  resolveEngineFailover,
  seatHealth,
  type SeatKind,
  type SeatRecord,
} from './seat-pool.js'

const NOW = Date.parse('2026-01-15T12:00:00.000Z')

function seat(id: string, over: Partial<SeatRecord> = {}): SeatRecord {
  return {
    id,
    kind: 'claude',
    priority: 0,
    activeSessions: [],
    sessionsToday: 0,
    tokensToday: 0,
    rateLimitResetsAt: null,
    lastRateLimit: null,
    ...over,
  }
}

describe('pickSeat — pick order', () => {
  it('prefers the lowest priority number', () => {
    const seats = [seat('s1', { priority: 5 }), seat('s2', { priority: 1 }), seat('s3', { priority: 3 })]
    expect(pickSeat(seats, { kind: 'claude', now: NOW })?.id).toBe('s2')
  })

  it('breaks priority ties by fewest live sessions, then fewest today, then fewest tokens', () => {
    const seats = [
      seat('s1', { activeSessions: ['x'] }),
      seat('s2', { sessionsToday: 4 }),
      seat('s3', { sessionsToday: 2, tokensToday: 900 }),
      seat('s4', { sessionsToday: 2, tokensToday: 100 }),
    ]
    expect(pickSeat(seats, { kind: 'claude', now: NOW })?.id).toBe('s4')
  })

  it('only picks seats of the requested engine', () => {
    const seats = [seat('c1'), seat('x1', { kind: 'codex' }), seat('g1', { kind: 'grok' })]
    expect(pickSeat(seats, { kind: 'codex', now: NOW })?.id).toBe('x1')
    expect(pickSeat(seats, { kind: 'grok', now: NOW })?.id).toBe('g1')
  })

  it('skips disabled, parked, credit-exhausted and cooling seats; returns null when none left', () => {
    const seats = [
      seat('off', { enabled: false }),
      seat('auth', { authFailedAt: '2026-01-15T10:00:00Z' }),
      seat('cred', { creditsExhaustedAt: '2026-01-15T10:00:00Z' }),
      seat('cool', { rateLimitResetsAt: '2026-01-15T13:00:00Z' }),
    ]
    expect(pickSeat(seats, { kind: 'claude', now: NOW })).toBeNull()
    seats.push(seat('ok', { priority: 9 }))
    expect(pickSeat(seats, { kind: 'claude', now: NOW })?.id).toBe('ok')
  })

  it('treats a cooldown that already ended as healthy', () => {
    const s = seat('past', { rateLimitResetsAt: '2026-01-15T11:00:00Z' })
    expect(seatHealth(s, NOW)).toBe('healthy')
    expect(pickSeat([s], { kind: 'claude', now: NOW })?.id).toBe('past')
  })

  it('honours the usable() credential check', () => {
    const seats = [seat('nocred'), seat('cred', { priority: 2 })]
    expect(pickSeat(seats, { kind: 'claude', now: NOW, usable: s => s.id === 'cred' })?.id).toBe('cred')
  })

  it('two sandboxed sessions get two different seats (spread prefers idle seats over priority)', () => {
    const seats = [seat('s1', { priority: 0 }), seat('s2', { priority: 1 })]
    const first = pickSeat(seats, { kind: 'claude', now: NOW, spread: true })!
    first.activeSessions.push('session-1')
    const second = pickSeat(seats, { kind: 'claude', now: NOW, spread: true })!
    second.activeSessions.push('session-2')
    expect(first.id).toBe('s1')
    expect(second.id).toBe('s2')
    expect(first.id).not.toBe(second.id)
  })

  it('an exclusive (CLI-login) seat is never handed to a second live session', () => {
    const seats = [seat('login', { credentialKind: 'cli_login', activeSessions: ['a'] })]
    const exclusive = (s: SeatRecord) => s.credentialKind === 'cli_login'
    expect(pickSeat(seats, { kind: 'claude', now: NOW, exclusive })).toBeNull()
    expect(pickSeat(seats, { kind: 'claude', now: NOW })?.id).toBe('login')
  })
})

describe('classifySeatFailure — every failure class', () => {
  it('429 / usage cap → rate_limit', () => {
    expect(classifySeatFailure({ status: 429 })).toBe('rate_limit')
    expect(classifySeatFailure({ text: "You've hit your session limit · resets 6:40pm (UTC)" })).toBe('rate_limit')
    expect(classifySeatFailure({ text: 'Too Many Requests' })).toBe('rate_limit')
  })
  it('401 / dead OAuth → auth', () => {
    expect(classifySeatFailure({ status: 401 })).toBe('auth')
    expect(classifySeatFailure({ text: 'OAuth session expired and could not be refreshed' })).toBe('auth')
    expect(classifySeatFailure({ text: 'API Error: 401 Invalid authentication credentials' })).toBe('auth')
  })
  it('403 org/plan disabled → org_disabled; a bare 403 is not a seat failure', () => {
    expect(classifySeatFailure({ status: 403, text: 'Your organization has disabled Claude subscription access for Claude Code' })).toBe('org_disabled')
    expect(classifySeatFailure({ status: 403, text: 'Forbidden: repository access denied' })).toBe('none')
  })
  it('credits / spend cap → credits_exhausted (wins over the rate-limit reading)', () => {
    expect(classifySeatFailure({ text: "You've hit your monthly spend limit - raise it at claude.ai/admin-settings/usage" })).toBe('credits_exhausted')
    expect(classifySeatFailure({ status: 429, text: 'insufficient_quota: out of credits' })).toBe('credits_exhausted')
    expect(classifySeatFailure({ status: 402 })).toBe('credits_exhausted')
  })
  it('5xx / timeout → transient', () => {
    expect(classifySeatFailure({ status: 503 })).toBe('transient')
    expect(classifySeatFailure({ status: 529, text: 'Overloaded' })).toBe('transient')
    expect(classifySeatFailure({ text: 'request timed out (ETIMEDOUT)' })).toBe('transient')
  })
  it('ordinary text → none', () => {
    expect(classifySeatFailure({ text: 'all tests passed' })).toBe('none')
  })
})

describe('applySeatFailure — cooldown and parking', () => {
  it('rate limit with a stated reset cools down exactly to that reset', () => {
    const s = seat('s')
    const resetAt = new Date(NOW + 40 * 60 * 1000)
    const eff = applySeatFailure(s, 'rate_limit', { now: NOW, resetAt })
    expect(eff).toEqual({ cls: 'rate_limit', retry: false, parked: true })
    expect(s.rateLimitResetsAt).toBe(resetAt.toISOString())
    expect(seatHealth(s, NOW)).toBe('cooling_down')
  })

  it('rate limit without a reset backs off exponentially up to the ceiling', () => {
    expect(backoffMs(1)).toBe(COOLDOWN_BASE_MS)
    expect(backoffMs(2)).toBe(COOLDOWN_BASE_MS * 2)
    expect(backoffMs(3)).toBe(COOLDOWN_BASE_MS * 4)
    expect(backoffMs(50)).toBe(COOLDOWN_CEILING_MS)
    const s = seat('s')
    applySeatFailure(s, 'rate_limit', { now: NOW })
    expect(Date.parse(s.rateLimitResetsAt!)).toBe(NOW + COOLDOWN_BASE_MS)
    // second strike after the first window ended doubles
    const later = NOW + COOLDOWN_BASE_MS + 1
    applySeatFailure(s, 'rate_limit', { now: later })
    expect(Date.parse(s.rateLimitResetsAt!)).toBe(later + COOLDOWN_BASE_MS * 2)
    expect(s.consecutiveFailures).toBe(2)
  })

  it('a weaker signal never pushes a known sooner reset later', () => {
    const s = seat('s', { rateLimitResetsAt: new Date(NOW + 5 * 60 * 1000).toISOString() })
    applySeatFailure(s, 'rate_limit', { now: NOW })
    expect(Date.parse(s.rateLimitResetsAt!)).toBe(NOW + 5 * 60 * 1000)
  })

  it('401 parks needs_reconnect; 403 org-disabled parks needs_admin', () => {
    const a = seat('a', { rateLimitResetsAt: new Date(NOW + 1000).toISOString() })
    applySeatFailure(a, 'auth', { now: NOW })
    expect(seatHealth(a, NOW)).toBe('needs_reconnect')
    expect(a.rateLimitResetsAt).toBeNull()
    const b = seat('b')
    applySeatFailure(b, 'org_disabled', { now: NOW })
    expect(seatHealth(b, NOW)).toBe('needs_admin')
  })

  it('credits exhausted parks the seat without a timer (no rotation churn)', () => {
    const s = seat('s')
    const eff = applySeatFailure(s, 'credits_exhausted', { now: NOW })
    expect(eff.parked).toBe(true)
    expect(s.rateLimitResetsAt).toBeNull()
    expect(seatHealth(s, NOW + 24 * 60 * 60 * 1000)).toBe('credits_exhausted')
  })

  it('transient failures carry no seat penalty and ask for one retry', () => {
    const s = seat('s')
    const eff = applySeatFailure(s, 'transient', { now: NOW })
    expect(eff).toEqual({ cls: 'transient', retry: true, parked: false })
    expect(seatHealth(s, NOW)).toBe('healthy')
    expect(s.consecutiveFailures).toBeUndefined()
  })
})

describe('applyGoodTurn — clears a false cooldown', () => {
  it('a good turn clears cooldown, credits park and the failure streak', () => {
    const s = seat('s')
    applySeatFailure(s, 'rate_limit', { now: NOW })
    expect(seatHealth(s, NOW)).toBe('cooling_down')
    expect(applyGoodTurn(s)).toBe(true)
    expect(seatHealth(s, NOW)).toBe('healthy')
    expect(s.consecutiveFailures).toBe(0)
  })
  it('does not clear a credential park (needs a probe or reconnect)', () => {
    const s = seat('s')
    applySeatFailure(s, 'auth', { now: NOW })
    applyGoodTurn(s)
    expect(seatHealth(s, NOW)).toBe('needs_reconnect')
  })
})

describe('resolveEngineFailover — opt-in cross-engine fallback', () => {
  const on = { enabled: true, order: ['claude', 'codex', 'grok'] as SeatKind[] }
  const off = { enabled: false, order: ['claude', 'codex', 'grok'] as SeatKind[] }

  it('stays on its own engine while any seat of it is available', () => {
    expect(resolveEngineFailover('claude', on, () => true)).toEqual({ engine: 'claude', fellBackFrom: null, queued: false })
  })
  it('falls back only when every seat of the current engine is down, in order', () => {
    const avail = (k: SeatKind) => k === 'grok' || k === 'codex'
    expect(resolveEngineFailover('claude', on, avail)).toEqual({ engine: 'codex', fellBackFrom: 'claude', queued: false })
  })
  it('default (off) queues on its own engine instead of falling back', () => {
    expect(resolveEngineFailover('claude', off, k => k !== 'claude')).toEqual({ engine: 'claude', fellBackFrom: null, queued: true })
  })
  it('never falls back for a card pinned to one engine', () => {
    const policy = effectiveFailover(on, parseCardFailover('pinned'))
    expect(resolveEngineFailover('claude', policy, k => k !== 'claude')).toEqual({ engine: 'claude', fellBackFrom: null, queued: true })
  })
  it('a card override list replaces the workspace order', () => {
    const policy = effectiveFailover(off, parseCardFailover('["codex","grok"]'))
    expect(resolveEngineFailover('codex', policy, k => k === 'grok').engine).toBe('grok')
  })
  it('queues when no allowed engine has a seat', () => {
    expect(resolveEngineFailover('claude', on, () => false).queued).toBe(true)
  })
  it('parseCardFailover ignores garbage and unknown engines', () => {
    expect(parseCardFailover('not json')).toBeNull()
    expect(parseCardFailover(null)).toBeNull()
    expect(parseCardFailover('["claude","nope","claude","grok"]')).toEqual(['claude', 'grok'])
  })
})

describe('expiry warning', () => {
  it('warns within 14 days, flags expired, ignores far-off or unknown', () => {
    const day = 24 * 60 * 60 * 1000
    expect(expiryStatus(new Date(NOW + 13 * day).toISOString(), NOW)).toBe('expiring')
    expect(expiryStatus(new Date(NOW + 14 * day).toISOString(), NOW)).toBe('expiring')
    expect(expiryStatus(new Date(NOW + 15 * day).toISOString(), NOW)).toBeNull()
    expect(expiryStatus(new Date(NOW - 1).toISOString(), NOW)).toBe('expired')
    expect(expiryStatus(null, NOW)).toBeNull()
  })
})

describe('nextResetFor / credentialHint', () => {
  it('reports the earliest future reset for a kind', () => {
    const seats = [
      seat('a', { rateLimitResetsAt: new Date(NOW + 9000).toISOString() }),
      seat('b', { rateLimitResetsAt: new Date(NOW + 3000).toISOString() }),
      seat('c', { kind: 'grok', rateLimitResetsAt: new Date(NOW + 1000).toISOString() }),
    ]
    expect(nextResetFor(seats, 'claude', NOW)).toBe(new Date(NOW + 3000).toISOString())
    expect(nextResetFor(seats, 'codex', NOW)).toBeNull()
  })
  it('shows at most the last 4 characters, and nothing for short values', () => {
    expect(credentialHint('fake-token-0000000000000000wxyz')).toBe('wxyz')
    expect(credentialHint('short')).toBeNull()
  })
})
