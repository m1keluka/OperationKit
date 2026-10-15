import { describe, it, expect } from 'vitest'
import { selectReviewSessionIdsToClear } from './poller-decisions.js'

// obj 712954 — the per-tick review session_id clear hands a card's tmux to the
// orphan sweep. A live worker parked between turns with pending work (a
// ScheduleWakeup / async Agent / Monitor inside the horizon) must keep it.
describe('selectReviewSessionIdsToClear', () => {
  const rows = [
    { id: 1, session_id: 'cc-1-100' },
    { id: 2, session_id: 'cc-2-200' },
    { id: 3, session_id: null },
  ]

  it('clears every review row when nothing is pending (unchanged behaviour)', () => {
    expect(selectReviewSessionIdsToClear(rows, () => false)).toEqual([1, 2])
  })

  it('keeps the session_id of a row whose live session has pending work', () => {
    expect(selectReviewSessionIdsToClear(rows, (sid) => sid === 'cc-2-200')).toEqual([1])
  })

  it('fails safe: a predicate error clears the row as before', () => {
    expect(selectReviewSessionIdsToClear(rows, () => { throw new Error('boom') })).toEqual([1, 2])
  })
})
