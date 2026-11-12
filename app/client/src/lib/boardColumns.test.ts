import { describe, it, expect } from 'vitest'
import { OBJECTIVE_STATUSES, type ObjectiveStatus } from '@operationkit/shared'
import { BOARD_COL_ORDER_MOBILE, boardColumnOf, needsYouCards, orderBoardColumns } from './boardColumns'

describe('orderBoardColumns', () => {
  it('desktop keeps pipeline order', () => {
    expect(orderBoardColumns(OBJECTIVE_STATUSES, false)).toEqual(OBJECTIVE_STATUSES)
  })

  it('mobile puts Needs You, then Working, then Queue, then Done, then Retired', () => {
    const mobile = orderBoardColumns(OBJECTIVE_STATUSES, true)
    expect(mobile).toEqual(BOARD_COL_ORDER_MOBILE)
    expect(mobile.filter(s => ['review', 'working', 'queue', 'done', 'cancelled'].includes(s)))
      .toEqual(['review', 'working', 'queue', 'done', 'cancelled'])
  })

  it('preserves which columns were visible', () => {
    const visible: typeof OBJECTIVE_STATUSES = ['queue', 'working', 'review', 'done']
    expect(orderBoardColumns(visible, true)).toEqual(['review', 'working', 'queue', 'done'])
    expect(orderBoardColumns(visible, false)).toEqual(['queue', 'working', 'review', 'done'])
  })
})

describe('boardColumnOf', () => {
  const child = (status: ObjectiveStatus) => ({ status })

  it('plain cards sit in their own status', () => {
    expect(boardColumnOf({ status: 'queue' })).toBe('queue')
    expect(boardColumnOf({ status: 'working' })).toBe('working')
    expect(boardColumnOf({ status: 'review' })).toBe('review')
  })

  it('THE FIX: a review delegator with a failed-review child stays in Needs You (obj 704132)', () => {
    expect(boardColumnOf(
      { status: 'review', delegate_mode: 1 },
      [child('review')],
    )).toBe('review')
  })

  it('a review delegator stays in Needs You even if a child is still running', () => {
    expect(boardColumnOf(
      { status: 'review', delegate_mode: 1 },
      [child('working')],
    )).toBe('review')
  })

  it('a working delegator with in-flight workers sits in Working', () => {
    expect(boardColumnOf(
      { status: 'working', delegate_mode: true },
      [child('working'), child('done')],
    )).toBe('working')
  })

  it('a working delegator whose remaining children are at the human gate stays Working (status is working)', () => {
    expect(boardColumnOf(
      { status: 'working', delegate_mode: 1 },
      [child('review'), child('done')],
    )).toBe('working')
  })

  it('an ai_review delegator with in-flight workers is shown as Working', () => {
    expect(boardColumnOf(
      { status: 'ai_review', delegate_mode: 1 },
      [child('queue')],
    )).toBe('working')
  })
})

// obj 900669 — Operator: "the header says two things need me, but many more cards
// sit in the needs-you stage". Needs You must hold only cards that genuinely
// need the human, and the header count must be computed from that same set.
describe('Needs You = cards that genuinely need the human (obj 900669)', () => {
  const child = (status: ObjectiveStatus) => ({ status })
  it('a review card with an agent session still running sits in Working, not Needs You', () => {
    expect(boardColumnOf({ status: 'review', session_id: 'cc-1-123' })).toBe('working')
    expect(boardColumnOf({ status: 'review', session_id: null })).toBe('review')
    expect(boardColumnOf({ status: 'review', session_id: '' })).toBe('review')
  })

  it('a review delegator with a live session of its own is also Working', () => {
    expect(boardColumnOf({ status: 'review', delegate_mode: 1, session_id: 'cc-2-1' }, [child('review')]))
      .toBe('working')
  })

  it("header count equals the Needs You column for Operator's board (12 review rows, 5 with agents running)", () => {
    // Shape of the live board on 2026-11-12: 12 cards had status=review, but
    // five of them had a worker session running (an agent was on them).
    const rows = [
      ...[1, 2, 3, 4, 5].map(id => ({ id, status: 'review' as const, session_id: `cc-${id}-1` })),
      ...[6, 7, 8, 9, 10, 11, 12].map(id => ({ id, status: 'review' as const, session_id: null })),
      { id: 13, status: 'working' as const, session_id: 'cc-13-1' },
      { id: 14, status: 'queue' as const, session_id: null },
    ]
    const column = rows.filter(o => boardColumnOf(o) === 'review')
    const header = needsYouCards(rows)
    expect(header.map(o => o.id)).toEqual(column.map(o => o.id))
    expect(header).toHaveLength(7)
    // None of the five agent-occupied cards is counted or shown as needing Operator.
    expect(header.some(o => o.session_id)).toBe(false)
  })

  it('needsYouCards honours the delegator remap via childrenByParent', () => {
    const rows = [
      { id: 1, status: 'review' as const, delegate_mode: 1, session_id: null },
      { id: 2, status: 'working' as const, delegate_mode: 1, session_id: null },
    ]
    const kids = new Map([[1, [child('working')]], [2, [child('review')]]])
    expect(needsYouCards(rows, kids).map(o => o.id)).toEqual([1])
  })
})
