import { describe, it, expect } from 'vitest'
import {
  describeCron,
  nextRunAt,
  cronMatches,
  mostRecentRunAt,
  computeRoutineHealth,
  type RoutineRow,
} from './routine-scheduler.js'

const mkRoutine = (over: Partial<RoutineRow> = {}): RoutineRow => ({
  id: 1,
  name: 'daily-job',
  cron_expr: '0 6 * * *',
  objective_template: '{"title":"x"}',
  enabled: 1,
  max_queue_depth: 1,
  last_run_at: null,
  created_at: '2026-06-01T00:00:00Z',
  ...over,
})

describe('describeCron', () => {
  it('daily at a fixed time', () => {
    expect(describeCron('40 7 * * *')).toBe('Daily at 07:40 UTC')
    expect(describeCron('3 6 * * *')).toBe('Daily at 06:03 UTC')
  })
  it('hourly at a fixed minute', () => {
    expect(describeCron('7 * * * *')).toBe('Hourly at :07')
  })
  it('every N minutes', () => {
    expect(describeCron('*/15 * * * *')).toBe('Every 15 min')
  })
  it('weekdays', () => {
    expect(describeCron('0 9 * * 1-5')).toBe('Weekdays at 09:00 UTC')
  })
  it('specific weekday', () => {
    expect(describeCron('30 14 * * 1')).toBe('Mon at 14:30 UTC')
  })
  it('falls back to the raw expression for shapes it does not recognise', () => {
    expect(describeCron('5 0 1 * *')).toBe('5 0 1 * *')        // monthly — not modelled
    expect(describeCron('not a cron')).toBe('not a cron')       // malformed
  })
})

describe('nextRunAt', () => {
  it('returns null for a malformed expression', () => {
    expect(nextRunAt('garbage')).toBeNull()
  })
  it('finds the next 15-minute boundary strictly after `from`', () => {
    const from = new Date('2026-06-21T07:41:30Z')
    const next = nextRunAt('*/15 * * * *', from)!
    expect(next).not.toBeNull()
    expect(next.getTime()).toBeGreaterThan(from.getTime())
    expect(next.getMinutes() % 15).toBe(0)
    expect(cronMatches('*/15 * * * *', next)).toBe(true)
  })
  it('rolls to the next day when today’s daily slot has passed', () => {
    const from = new Date('2026-06-21T07:41:00Z')
    const next = nextRunAt('40 7 * * *', from)!
    expect(next.getTime()).toBeGreaterThan(from.getTime())
    expect(next.getMinutes()).toBe(40)
    expect(next.getHours()).toBe(7)
    // ~next day, not the same minute it already passed
    expect(next.getTime() - from.getTime()).toBeGreaterThan(20 * 60 * 60 * 1000)
  })
})

describe('mostRecentRunAt', () => {
  it('returns null for a malformed expression', () => {
    expect(mostRecentRunAt('garbage')).toBeNull()
  })
  it('finds the most recent daily fire at or before `from`', () => {
    const now = new Date('2026-06-26T08:00:00Z')
    const prev = mostRecentRunAt('0 6 * * *', now)!
    expect(prev).not.toBeNull()
    expect(prev.getHours()).toBe(6)
    expect(prev.getMinutes()).toBe(0)
    expect(prev.getDate()).toBe(26) // today's 06:00, not yesterday's
  })
  it('rolls back to yesterday when today’s slot has not arrived yet', () => {
    const now = new Date('2026-06-26T05:30:00Z') // before 06:00
    const prev = mostRecentRunAt('0 6 * * *', now)!
    expect(prev.getDate()).toBe(25)
    expect(prev.getHours()).toBe(6)
  })
})

// Objective 1970: a routine that misses a scheduled fire must be detectable so
// the system can alert instead of failing silently.
describe('computeRoutineHealth — overdue detection (obj 1970)', () => {
  const now = new Date('2026-06-26T08:00:00Z') // 2h after the 06:00 daily fire

  it('healthy: last_run_at at the most recent fire → not overdue', () => {
    const h = computeRoutineHealth(mkRoutine({ last_run_at: '2026-06-26T06:00:00Z' }), now)
    expect(h.overdue).toBe(false)
    expect(h.minutes_overdue).toBe(0)
    expect(h.next_run_at).not.toBeNull()
  })

  it('STALLED: missed today’s fire by >1h grace → overdue with minutes', () => {
    const h = computeRoutineHealth(mkRoutine({ last_run_at: '2026-06-25T06:00:00Z' }), now)
    expect(h.overdue).toBe(true)
    expect(h.minutes_overdue).toBe(120) // 08:00 − 06:00
    expect(h.expected_last_fire).toBe('2026-06-26T06:00:00.000Z')
  })

  it('never run + past first scheduled fire → overdue', () => {
    const h = computeRoutineHealth(mkRoutine({ last_run_at: null }), now)
    expect(h.overdue).toBe(true)
  })

  it('within the grace window after a miss → not yet overdue (no flapping)', () => {
    const justAfter = new Date('2026-06-26T06:30:00Z') // 30m after fire, < 60m grace
    const h = computeRoutineHealth(mkRoutine({ last_run_at: '2026-06-25T06:00:00Z' }), justAfter)
    expect(h.overdue).toBe(false)
  })

  it('disabled routine is never overdue', () => {
    const h = computeRoutineHealth(mkRoutine({ enabled: 0, last_run_at: '2026-06-01T06:00:00Z' }), now)
    expect(h.overdue).toBe(false)
    expect(h.expected_last_fire).toBeNull()
    expect(h.next_run_at).toBeNull()
  })
})
