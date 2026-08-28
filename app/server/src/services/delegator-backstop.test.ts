import { describe, it, expect } from 'vitest'
import { delegatorBackstopDecision } from './state-poller.js'

// The delegator liveness backstop closes the gap left by the watchdog (guarded
// `&& !delegate_mode`), the orphan sweep (`delegate_mode = 0`), and reconcile
// (durable spent-signature gate): a delegator wedged in `working` with no live
// session whose recovery signal never lands has no absolute time-based net.
// These lock the PURE decision that decides nudge vs route-review vs none.

const THRESHOLD = 30 * 60 * 1000 // DELEGATOR_BACKSTOP_MS default
const OVER = THRESHOLD + 60_000 // comfortably past threshold
const UNDER = 5 * 60 * 1000 // young / just parked

describe('delegatorBackstopDecision', () => {
  it('(a) spent-signature wedged delegator (all children in review, no live session, age>threshold) → nudge', () => {
    // This is the exact wedge the durable reconcile_sig gate cannot recover: the
    // signature for "both kids in review" was already recorded, so reconcile is
    // inert. The TIME-based backstop must still revive it.
    const d = delegatorBackstopDecision({
      hasLiveSession: false,
      ageMs: OVER,
      kids: [
        { id: 1, status: 'review' },
        { id: 2, status: 'review' },
      ],
      thresholdMs: THRESHOLD,
    })
    expect(d.recover).toBe(true)
    expect(d.action).toBe('nudge')
  })

  it('all children done, no live session, age>threshold → nudge (synthesize)', () => {
    const d = delegatorBackstopDecision({
      hasLiveSession: false,
      ageMs: OVER,
      kids: [
        { id: 1, status: 'done' },
        { id: 2, status: 'done' },
      ],
      thresholdMs: THRESHOLD,
    })
    expect(d.recover).toBe(true)
    expect(d.action).toBe('nudge')
  })

  it('queued child, no live session, age>threshold → nudge (spawn)', () => {
    const d = delegatorBackstopDecision({
      hasLiveSession: false,
      ageMs: OVER,
      kids: [{ id: 1, status: 'queue' }],
      thresholdMs: THRESHOLD,
    })
    expect(d.recover).toBe(true)
    expect(d.action).toBe('nudge')
  })

  it('(b) healthy young/parked delegator (age<threshold) → none, regardless of children', () => {
    const d = delegatorBackstopDecision({
      hasLiveSession: false,
      ageMs: UNDER,
      kids: [{ id: 1, status: 'review' }],
      thresholdMs: THRESHOLD,
    })
    expect(d.recover).toBe(false)
    expect(d.action).toBe('none')
  })

  it('(c) zero-child working delegator, no live session, age>threshold → route-review', () => {
    const d = delegatorBackstopDecision({
      hasLiveSession: false,
      ageMs: OVER,
      kids: [],
      thresholdMs: THRESHOLD,
    })
    expect(d.recover).toBe(true)
    expect(d.action).toBe('route-review')
  })

  it('children exist but none actionable and not all-done, no live session, age>threshold → route-review', () => {
    // e.g. a child left in 'blocked'/'working' with no live parent session and
    // no queue/review/done work to act on — nothing to nudge for, surface to human.
    const d = delegatorBackstopDecision({
      hasLiveSession: false,
      ageMs: OVER,
      kids: [
        { id: 1, status: 'blocked' },
        { id: 2, status: 'working' },
      ],
      thresholdMs: THRESHOLD,
    })
    expect(d.recover).toBe(true)
    expect(d.action).toBe('route-review')
  })

  it('(d) live working session → none regardless of age or children', () => {
    const old = delegatorBackstopDecision({
      hasLiveSession: true,
      ageMs: OVER * 100,
      kids: [{ id: 1, status: 'review' }],
      thresholdMs: THRESHOLD,
    })
    expect(old.recover).toBe(false)
    expect(old.action).toBe('none')

    const empty = delegatorBackstopDecision({
      hasLiveSession: true,
      ageMs: OVER,
      kids: [],
      thresholdMs: THRESHOLD,
    })
    expect(empty.recover).toBe(false)
    expect(empty.action).toBe('none')
  })

  it('exactly at threshold recovers (boundary is inclusive: ageMs >= thresholdMs)', () => {
    const d = delegatorBackstopDecision({
      hasLiveSession: false,
      ageMs: THRESHOLD,
      kids: [],
      thresholdMs: THRESHOLD,
    })
    expect(d.recover).toBe(true)
    expect(d.action).toBe('route-review')
  })
})
