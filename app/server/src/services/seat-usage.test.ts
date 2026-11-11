import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import type { RateLimitEvent } from './account-router.js'
import type { SeatRecord } from './seat-pool.js'
import {
  DAY_MS,
  HOUR_MS,
  IDLE_SESSIONS_24H,
  UNDER_PROVISIONED_LIMITED_PCT,
  computeSeatUsage,
  parseTimestamp,
  provisioningHint,
  unionLength,
  type SeatUsage,
} from './seat-usage.js'

// Fake data only. Fixed clock so window boundaries are exact.
const NOW = Date.parse('2026-11-01T12:00:00.000Z')
const iso = (ms: number) => new Date(ms).toISOString()
const sqliteTs = (ms: number) => iso(ms).slice(0, 19).replace('T', ' ')

let db: Database.Database

function seat(id: string, over: Partial<SeatRecord> = {}): SeatRecord {
  return {
    id, kind: 'claude', priority: 0, enabled: true, activeSessions: [], sessionsToday: 0, tokensToday: 0,
    rateLimitResetsAt: null, lastRateLimit: null, ...over,
  }
}

function intel(sessionId: string, accountId: string | null, endedAt: string, tokens: number) {
  db.prepare(
    `INSERT INTO session_intel (objective_id, session_id, account_id, started_at, ended_at, total_tokens) VALUES (1, ?, ?, ?, ?, ?)`,
  ).run(sessionId, accountId, endedAt, endedAt, tokens)
}
function runtime(sessionId: string, accountId: string, updatedAt: string) {
  db.prepare('INSERT INTO session_runtime (session_id, account_id, updated_at) VALUES (?, ?, ?)').run(sessionId, accountId, updatedAt)
}
function rl(accountId: string, at: number, reset: number, triggerMessage = "You've hit your limit"): RateLimitEvent {
  return {
    timestamp: iso(at), accountId, label: accountId, tokensAtLimit: 0, sessionsAtLimit: 0, costAtLimit: 0,
    activeSessions: 0, resetTime: iso(reset), triggerMessage,
  }
}

beforeEach(() => {
  db = new Database(':memory:')
  db.exec(`
    CREATE TABLE session_intel (id INTEGER PRIMARY KEY AUTOINCREMENT, objective_id INTEGER NOT NULL, session_id TEXT NOT NULL UNIQUE,
      account_id TEXT, started_at TEXT NOT NULL, ended_at TEXT NOT NULL, total_tokens INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE session_runtime (session_id TEXT PRIMARY KEY, claude_session_id TEXT, account_id TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')), engine TEXT);
  `)
})

describe('parseTimestamp / unionLength', () => {
  it('reads SQLite datetime() as UTC and ISO as-is', () => {
    expect(parseTimestamp('2026-11-01 11:00:00')).toBe(Date.parse('2026-11-01T11:00:00Z'))
    expect(parseTimestamp('2026-11-01T11:00:00.000Z')).toBe(Date.parse('2026-11-01T11:00:00Z'))
    expect(parseTimestamp(null)).toBeNaN()
  })
  it('merges overlapping intervals and clips to the window', () => {
    expect(unionLength([[0, 10], [5, 15], [20, 30], [25, 26]], 2, 28)).toBe(13 + 8)
    expect(unionLength([], 0, 10)).toBe(0)
  })
})

describe('computeSeatUsage — tokens and sessions', () => {
  it('splits 24h vs 7d at the exact boundaries and attributes per seat', () => {
    intel('s-in-24', 'a', iso(NOW - 1 * HOUR_MS), 100)
    intel('s-edge-24-in', 'a', iso(NOW - DAY_MS + 1000), 10)
    intel('s-edge-24-out', 'a', iso(NOW - DAY_MS), 1000) // exactly 24h old → 7d only
    intel('s-in-7d', 'a', iso(NOW - 3 * DAY_MS), 5000)
    intel('s-edge-7d-out', 'a', iso(NOW - 7 * DAY_MS), 99999) // exactly 7d old → out
    intel('s-old', 'a', iso(NOW - 9 * DAY_MS), 77777)
    intel('s-future', 'a', iso(NOW + HOUR_MS), 55555)
    intel('s-b', 'b', iso(NOW - 2 * HOUR_MS), 7)
    intel('s-unattributed', null, iso(NOW - 2 * HOUR_MS), 3)
    intel('s-other-seat', 'gone', iso(NOW - 2 * HOUR_MS), 3)

    const { usage } = computeSeatUsage({ db, now: NOW, seats: [seat('a'), seat('b'), seat('c')], rateLimitEvents: [] })
    expect(usage.get('a')).toMatchObject({ tokens_24h: 110, tokens_7d: 6110, sessions_24h: 2, sessions_7d: 4 })
    expect(usage.get('b')).toMatchObject({ tokens_24h: 7, tokens_7d: 7, sessions_24h: 1, sessions_7d: 1 })
    expect(usage.get('c')).toMatchObject({ tokens_24h: 0, tokens_7d: 0, sessions_24h: 0, sessions_7d: 0 })
  })

  it('counts distinct sessions across session_intel, session_runtime (SQLite timestamps) and live sessions', () => {
    intel('s1', 'a', iso(NOW - HOUR_MS), 10)
    runtime('s1', 'a', sqliteTs(NOW - 2 * HOUR_MS)) // same session — counted once
    runtime('s2', 'a', sqliteTs(NOW - 2 * DAY_MS)) // 7d only
    runtime('s3', 'a', sqliteTs(NOW - 30 * 60 * 1000)) // running, no intel row yet
    runtime('s4', 'b', sqliteTs(NOW - HOUR_MS))
    const { usage } = computeSeatUsage({
      db, now: NOW, seats: [seat('a', { activeSessions: ['s3', 's-live'] }), seat('b')], rateLimitEvents: [],
    })
    expect(usage.get('a')).toMatchObject({ sessions_24h: 3, sessions_7d: 4, tokens_24h: 10 })
    expect(usage.get('b')).toMatchObject({ sessions_24h: 1, sessions_7d: 1, tokens_24h: 0 })
  })

  it('tolerates a DB without the usage tables', () => {
    const empty = new Database(':memory:')
    const { usage } = computeSeatUsage({ db: empty, now: NOW, seats: [seat('a', { activeSessions: ['x'] })], rateLimitEvents: [] })
    expect(usage.get('a')).toMatchObject({ tokens_24h: 0, sessions_24h: 1, limit_state: 'healthy' })
  })
})

describe('computeSeatUsage — rate-limit state', () => {
  it('healthy seat: no limit, no reset', () => {
    const { usage } = computeSeatUsage({ db, now: NOW, seats: [seat('a')], rateLimitEvents: [] })
    expect(usage.get('a')).toMatchObject({ limit_state: 'healthy', limit_reset_at: null, limited_pct_24h: 0 })
  })

  it('an expired cooldown is healthy', () => {
    const s = seat('a', { lastRateLimit: iso(NOW - 3 * HOUR_MS), rateLimitResetsAt: iso(NOW - HOUR_MS) })
    const { usage } = computeSeatUsage({ db, now: NOW, seats: [s], rateLimitEvents: [] })
    expect(usage.get('a')).toMatchObject({ limit_state: 'healthy', limit_reset_at: null })
  })

  it('a short cooldown is a 5-hour limit, with its reset', () => {
    const reset = NOW + 2 * HOUR_MS
    const s = seat('a', { lastRateLimit: iso(NOW - HOUR_MS), rateLimitResetsAt: iso(reset) })
    const { usage } = computeSeatUsage({
      db, now: NOW, seats: [s], rateLimitEvents: [rl('a', NOW - HOUR_MS, reset, "You've hit your session limit · resets 2pm")],
    })
    expect(usage.get('a')).toMatchObject({ limit_state: '5h', limit_reset_at: iso(reset) })
  })

  it('a message naming the week is a weekly limit even with a short (backoff) cooldown', () => {
    const reset = NOW + HOUR_MS
    const s = seat('a', { lastRateLimit: iso(NOW - 10 * 60 * 1000), rateLimitResetsAt: iso(reset) })
    const { usage } = computeSeatUsage({
      db, now: NOW, seats: [s],
      rateLimitEvents: [
        rl('a', NOW - 5 * HOUR_MS, NOW - 4 * HOUR_MS, 'hit your session limit'),
        rl('a', NOW - 10 * 60 * 1000, reset, "You've hit your weekly limit · resets Nov 3, 9am"),
      ],
    })
    expect(usage.get('a')).toMatchObject({ limit_state: 'weekly', limit_reset_at: iso(reset) })
  })

  it('a cooldown longer than one 5-hour window is a weekly limit', () => {
    const reset = NOW + 2 * DAY_MS
    const s = seat('a', { lastRateLimit: iso(NOW - HOUR_MS), rateLimitResetsAt: iso(reset) })
    const { usage } = computeSeatUsage({ db, now: NOW, seats: [s], rateLimitEvents: [] })
    expect(usage.get('a')).toMatchObject({ limit_state: 'weekly', limit_reset_at: iso(reset) })
  })

  it('a parked (credits / auth) seat is not reported as rate-limited', () => {
    const s = seat('a', { authFailedAt: iso(NOW - HOUR_MS), authFailureReason: 'needs_reconnect' })
    const { usage } = computeSeatUsage({ db, now: NOW, seats: [s], rateLimitEvents: [] })
    expect(usage.get('a')!.limit_state).toBe('healthy')
  })
})

describe('computeSeatUsage — limited_pct_24h', () => {
  it('unions overlapping history intervals and clips to the last 24h', () => {
    const events = [
      rl('a', NOW - 30 * HOUR_MS, NOW - 22 * HOUR_MS), // 2h inside the window
      rl('a', NOW - 10 * HOUR_MS, NOW - 7 * HOUR_MS), // 3h
      rl('a', NOW - 8 * HOUR_MS, NOW - 6 * HOUR_MS), // overlaps → +1h
      rl('a', NOW - 5 * HOUR_MS, NOW - 5 * HOUR_MS, '[credits-exhausted] spend limit'), // not a rate limit
      rl('a', NOW - 4 * HOUR_MS, NOW - 2 * HOUR_MS, '[auth-failure:needs_reconnect] 401'), // not a rate limit
      rl('b', NOW - 12 * HOUR_MS, NOW), // other seat
    ]
    const { usage } = computeSeatUsage({ db, now: NOW, seats: [seat('a'), seat('b')], rateLimitEvents: events })
    expect(usage.get('a')!.limited_pct_24h).toBe(25) // 6h / 24h
    expect(usage.get('b')!.limited_pct_24h).toBe(50)
  })

  it('includes the live cooldown up to now, not its future part', () => {
    const s = seat('a', { lastRateLimit: iso(NOW - 3 * HOUR_MS), rateLimitResetsAt: iso(NOW + 2 * HOUR_MS) })
    const { usage } = computeSeatUsage({ db, now: NOW, seats: [s], rateLimitEvents: [] })
    expect(usage.get('a')!.limited_pct_24h).toBe(12.5)
  })
})

describe('provisioningHint', () => {
  const u = (over: Partial<SeatUsage> = {}): SeatUsage => ({
    tokens_24h: 0, tokens_7d: 0, sessions_24h: 3, sessions_7d: 3, limit_state: 'healthy', limit_reset_at: null, limited_pct_24h: 0, ...over,
  })

  it('flags seats limited MORE than the threshold as under-provisioned', () => {
    const hint = provisioningHint([
      { kind: 'claude', enabled: true, health: 'healthy', usage: u({ limited_pct_24h: UNDER_PROVISIONED_LIMITED_PCT + 0.1 }) },
      { kind: 'claude', enabled: true, health: 'healthy', usage: u({ limited_pct_24h: UNDER_PROVISIONED_LIMITED_PCT }) }, // at threshold: not counted
    ])
    expect(hint).toMatchObject({ verdict: 'under', limited_seats: 1, idle_seats: 0 })
    expect(hint.message).toMatch(/1 seat rate-limited >25% of the last 24h → under-provisioned \(Claude\)/)
    expect(hint.thresholds).toEqual({ limited_pct_24h: UNDER_PROVISIONED_LIMITED_PCT, idle_sessions_24h: IDLE_SESSIONS_24H })
  })

  it('flags usable seats with no sessions as over-provisioned; parked and disabled seats are not idle', () => {
    const hint = provisioningHint([
      { kind: 'codex', enabled: true, health: 'healthy', usage: u({ sessions_24h: 0 }) },
      { kind: 'codex', enabled: true, health: 'healthy', usage: u({ sessions_24h: 0 }) },
      { kind: 'codex', enabled: true, health: 'needs_reconnect', usage: u({ sessions_24h: 0 }) },
      { kind: 'claude', enabled: false, health: 'disabled', usage: u({ sessions_24h: 0 }) },
      { kind: 'claude', enabled: true, health: 'healthy', usage: u() },
    ])
    expect(hint).toMatchObject({ verdict: 'over', limited_seats: 0, idle_seats: 2 })
    expect(hint.message).toMatch(/2 seats idle \(no sessions in 24h\) → over-provisioned \(Codex\)/)
    expect(hint.by_kind.find(k => k.kind === 'claude')).toMatchObject({ seats: 1, verdict: 'ok' })
  })

  it('reports mixed when one engine is short and another has spare seats', () => {
    const hint = provisioningHint([
      { kind: 'claude', enabled: true, health: 'cooling_down', usage: u({ limited_pct_24h: 80 }) },
      { kind: 'grok', enabled: true, health: 'healthy', usage: u({ sessions_24h: 0 }) },
    ])
    expect(hint.verdict).toBe('mixed')
    expect(hint.message).toMatch(/under-provisioned \(Claude\).*over-provisioned \(Grok\)/)
  })

  it('ok and no_seats', () => {
    expect(provisioningHint([{ kind: 'claude', enabled: true, health: 'healthy', usage: u() }]).verdict).toBe('ok')
    expect(provisioningHint([]).verdict).toBe('no_seats')
  })
})
