import { describe, it, expect, vi, afterEach } from 'vitest'
import { relativeFuture } from './time'

const NOW = new Date('2026-06-21T12:00:00Z').getTime()

afterEach(() => vi.useRealTimers())

function at(future: string) {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  return relativeFuture(future)
}

describe('relativeFuture', () => {
  it('returns empty for null/invalid', () => {
    expect(relativeFuture(null)).toBe('')
    expect(relativeFuture('not-a-date')).toBe('')
  })
  it('says "now" for a past/elapsed time', () => {
    expect(at('2026-06-21T11:59:00Z')).toBe('now')
  })
  it('minutes / hours / days ahead', () => {
    expect(at('2026-06-21T12:20:00Z')).toBe('in 20m')
    expect(at('2026-06-21T16:00:00Z')).toBe('in 4h')
    expect(at('2026-06-24T12:00:00Z')).toBe('in 3d')
  })
})
