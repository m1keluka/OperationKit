import { describe, it, expect } from 'vitest'
import {
  isMaxTurnsResultEvent,
  detectTurnsExhausted,
  decideTurnsContinue,
} from './session-manager.js'

// obj 1487 — Auto-continue a worker that hit the per-spawn `--max-turns` cap
// while still productive, instead of stranding it for a manual Resume. These
// lock the two pure pieces:
//   (1) DETECTION — recognising a max_turns terminal exit distinctly from a
//       rate-limit / 401 / 529 (which must NOT be treated as turns-exhaustion),
//   (2) the BOUNDED-continue DECISION — continue while under a positive bound,
//       disable gracefully on a zero/unknown bound (fail-safe-open).

describe('isMaxTurnsResultEvent (detection — distinct from rate-limit/401/529)', () => {
  it('matches the structured result subtype error_max_turns', () => {
    expect(
      isMaxTurnsResultEvent({
        type: 'result',
        subtype: 'error_max_turns',
        is_error: true,
        result: 'Reached maximum number of turns (150)',
      })
    ).toBe(true)
  })

  it('matches a terminal_reason of max_turns (defensive alt shape)', () => {
    expect(isMaxTurnsResultEvent({ type: 'result', terminal_reason: 'max_turns' })).toBe(true)
  })

  it('matches result text /maximum number of turns/i on a terminal event', () => {
    expect(
      isMaxTurnsResultEvent({ type: 'result', is_error: true, result: 'Reached MAXIMUM Number of Turns (150)' })
    ).toBe(true)
    expect(
      isMaxTurnsResultEvent({ type: 'error', error: 'fatal: maximum number of turns exceeded' })
    ).toBe(true)
  })

  it('does NOT match a rate-limit result (429 / "hit your limit")', () => {
    expect(
      isMaxTurnsResultEvent({
        type: 'result',
        subtype: 'success',
        is_error: true,
        api_error_status: 429,
        result: "You've hit your limit · resets 6:50pm (UTC)",
      })
    ).toBe(false)
  })

  it('does NOT match a 401 auth-failure or a 529 overloaded result', () => {
    expect(
      isMaxTurnsResultEvent({ type: 'result', is_error: true, api_error_status: 401, result: 'authentication_failed' })
    ).toBe(false)
    expect(
      isMaxTurnsResultEvent({ type: 'result', is_error: true, api_error_status: 529, result: 'Overloaded' })
    ).toBe(false)
  })

  it('does NOT match assistant prose that merely discusses turn limits', () => {
    // Loose text match is gated to terminal result/error events, so normal
    // assistant output describing "maximum number of turns" is never a false hit.
    expect(
      isMaxTurnsResultEvent({
        type: 'assistant',
        message: { role: 'assistant', content: 'The CLI stops at the maximum number of turns.' },
      })
    ).toBe(false)
  })

  it('is fail-safe on junk input', () => {
    expect(isMaxTurnsResultEvent(null)).toBe(false)
    expect(isMaxTurnsResultEvent(undefined)).toBe(false)
    expect(isMaxTurnsResultEvent('not an object')).toBe(false)
    expect(isMaxTurnsResultEvent(42)).toBe(false)
  })
})

describe('detectTurnsExhausted (scan a spawn-segment tail)', () => {
  it('finds a max_turns result amongst other lines', () => {
    const lines = [
      JSON.stringify({ type: 'assistant', message: { content: 'working...' } }),
      JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true, result: 'Reached maximum number of turns (150)' }),
    ]
    expect(detectTurnsExhausted(lines)).toBe(true)
  })

  it('returns false when the segment has no max_turns exit', () => {
    const lines = [
      JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done' }),
    ]
    expect(detectTurnsExhausted(lines)).toBe(false)
  })

  it('skips malformed JSON lines (fail-safe-open)', () => {
    const lines = ['{ not json', '', 'also broken }']
    expect(detectTurnsExhausted(lines)).toBe(false)
  })

  it('returns false on a non-array input', () => {
    // @ts-expect-error — exercising the runtime fail-safe guard
    expect(detectTurnsExhausted(null)).toBe(false)
  })
})

describe('decideTurnsContinue (bounded auto-continue decision)', () => {
  it('continues while strictly under a positive bound', () => {
    expect(decideTurnsContinue({ count: 0, max: 3 })).toEqual({ continue: true })
    expect(decideTurnsContinue({ count: 2, max: 3 })).toEqual({ continue: true })
  })

  it('stops at the bound so a genuine runaway eventually routes to review', () => {
    expect(decideTurnsContinue({ count: 3, max: 3 })).toEqual({ continue: false })
    expect(decideTurnsContinue({ count: 4, max: 3 })).toEqual({ continue: false })
  })

  it('a bound of 0 disables auto-continue entirely (fail-safe)', () => {
    expect(decideTurnsContinue({ count: 0, max: 0 })).toEqual({ continue: false })
  })

  it('a negative / NaN bound disables auto-continue gracefully', () => {
    expect(decideTurnsContinue({ count: 0, max: -1 })).toEqual({ continue: false })
    expect(decideTurnsContinue({ count: 0, max: Number.NaN })).toEqual({ continue: false })
  })

  it('a negative / NaN count never continues (fail-safe)', () => {
    expect(decideTurnsContinue({ count: -1, max: 3 })).toEqual({ continue: false })
    expect(decideTurnsContinue({ count: Number.NaN, max: 3 })).toEqual({ continue: false })
  })
})
