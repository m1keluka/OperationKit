import { describe, it, expect } from 'vitest'
import { lintDue } from './scheduler.js'

const at = (s: string) => new Date(s)

describe('lintDue', () => {
  const nightly = { lint_schedule: 'nightly' as const, lint_hour_utc: 3 }
  const weekly = { lint_schedule: 'weekly' as const, lint_hour_utc: 3 }

  it('nightly: once per UTC day at or after the hour', () => {
    expect(lintDue(null, nightly, at('2026-10-31T02:59:00Z'))).toBe(false)
    expect(lintDue(null, nightly, at('2026-10-31T03:00:00Z'))).toBe(true)
    expect(lintDue('2026-10-30T03:05:00Z', nightly, at('2026-10-31T03:10:00Z'))).toBe(true)
    expect(lintDue('2026-10-31T03:05:00Z', nightly, at('2026-10-31T23:50:00Z'))).toBe(false)
    // Ran by hand earlier the same day, before the hour: the scheduled run still happens.
    expect(lintDue('2026-10-31T01:00:00Z', nightly, at('2026-10-31T03:10:00Z'))).toBe(true)
    // Missed yesterday (server down) — runs once today after the hour, not twice.
    expect(lintDue('2026-10-28T03:00:00Z', nightly, at('2026-10-31T04:00:00Z'))).toBe(true)
    expect(lintDue('not a date', nightly, at('2026-10-31T04:00:00Z'))).toBe(true)
  })

  it('weekly: seven days since the last run', () => {
    expect(lintDue(null, weekly, at('2026-10-31T00:00:00Z'))).toBe(true)
    expect(lintDue('2026-10-25T00:00:00Z', weekly, at('2026-10-31T23:59:00Z'))).toBe(false)
    expect(lintDue('2026-10-24T00:00:00Z', weekly, at('2026-10-31T00:00:00Z'))).toBe(true)
  })

  it('off: never', () => {
    expect(lintDue(null, { lint_schedule: 'off', lint_hour_utc: 0 }, at('2026-10-31T12:00:00Z'))).toBe(false)
  })
})
