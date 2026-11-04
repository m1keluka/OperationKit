import { describe, it, expect } from 'vitest'
import { isWithinSchedule } from './posthog-hot-owner-scheduler.js'

// 2026-01-14 is a Wednesday, EST (UTC-5). 2026-07-14 is a Tuesday, EDT (UTC-4).
// Exercising both offsets proves the window is computed from real ET wall time,
// not a fixed UTC cron that would drift an hour across the DST change.
describe('isWithinSchedule (weekdays 08:00-19:30 America/New_York, DST-aware)', () => {
  it('fires at the 08:00 ET open, winter (EST, UTC-5)', () => {
    expect(isWithinSchedule(new Date('2026-01-14T13:00:00Z'))).toBe(true)
  })
  it('fires at the 19:30 ET close, winter (EST, UTC-5)', () => {
    expect(isWithinSchedule(new Date('2026-01-15T00:30:00Z'))).toBe(true)
  })
  it('does not fire at 20:00 ET, winter', () => {
    expect(isWithinSchedule(new Date('2026-01-15T01:00:00Z'))).toBe(false)
  })
  it('does not fire at 07:30 ET, winter', () => {
    expect(isWithinSchedule(new Date('2026-01-14T12:30:00Z'))).toBe(false)
  })
  it('fires at the 08:00 ET open, summer (EDT, UTC-4)', () => {
    expect(isWithinSchedule(new Date('2026-07-14T12:00:00Z'))).toBe(true)
  })
  it('fires at the 19:30 ET close, summer (EDT, UTC-4)', () => {
    expect(isWithinSchedule(new Date('2026-07-14T23:30:00Z'))).toBe(true)
  })
  it('does not fire at 20:00 ET, summer', () => {
    expect(isWithinSchedule(new Date('2026-07-15T00:00:00Z'))).toBe(false)
  })
  it('does not fire on a weekend', () => {
    // 2026-01-17 is a Saturday; 13:00 UTC = 08:00 EST.
    expect(isWithinSchedule(new Date('2026-01-17T13:00:00Z'))).toBe(false)
  })
  it('does not fire off the 30-min boundary', () => {
    expect(isWithinSchedule(new Date('2026-01-14T13:15:00Z'))).toBe(false)
  })
})
