import { OBJECTIVE_STATUSES, isInFlightStatus, type ObjectiveStatus } from '@command-center/shared'

/**
 * Mobile board is a vertical stack — Needs You first so Operator does not scroll
 * past Queue/Working. Desktop keeps pipeline order (OBJECTIVE_STATUSES).
 * Transient columns (ai_review, planning) slot next to their pipeline neighbors.
 */
export const BOARD_COL_ORDER_MOBILE: ObjectiveStatus[] = [
  'review',
  'working',
  'ai_review',
  'queue',
  'planning',
  'done',
  'cancelled',
]

export function orderBoardColumns(
  cols: ObjectiveStatus[],
  mobile: boolean,
): ObjectiveStatus[] {
  const rank = mobile ? BOARD_COL_ORDER_MOBILE : OBJECTIVE_STATUSES
  return [...cols].sort((a, b) => rank.indexOf(a) - rank.indexOf(b))
}

type ColumnObj = { status: ObjectiveStatus; delegate_mode?: boolean | number | null }
type ColumnChild = { status: ObjectiveStatus }

/**
 * Where a card sits on the board.
 *
 * A delegator with in-flight workers is shown in Working between wakes.
 * That remap must NOT apply when the card itself is in `review`: fireWake
 * treats review as human-owned and will not auto-wake, so hiding it in
 * Working strands Needs You work (obj 704132 — parent Needs You, child
 * failed review, card stuck in Working).
 */
export function boardColumnOf(
  obj: ColumnObj,
  children?: readonly ColumnChild[] | undefined,
): ObjectiveStatus {
  if (obj.status === 'review') return 'review'
  const inFlight = children?.some(w => isInFlightStatus(w.status)) ?? false
  return obj.delegate_mode && inFlight ? 'working' : obj.status
}
