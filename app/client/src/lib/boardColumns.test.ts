import { describe, it, expect } from 'vitest'
import { OBJECTIVE_STATUSES, type ObjectiveStatus } from '@operationkit/shared'
import { BOARD_COL_ORDER_MOBILE, boardColumnOf, orderBoardColumns } from './boardColumns'

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
