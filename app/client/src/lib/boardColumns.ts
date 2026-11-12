import { OBJECTIVE_STATUSES, isInFlightStatus, type ObjectiveStatus } from '@operationkit/shared'

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

type ColumnObj = {
  status: ObjectiveStatus
  delegate_mode?: boolean | number | null
  session_id?: string | null
}
type ColumnChild = { status: ObjectiveStatus }

/**
 * A `review` card that still has an agent session on it is not waiting on the
 * human — an agent is running a turn (a follow-up, or the worker finishing the
 * turn in which it routed itself to review). The poller's review sweep nulls
 * `session_id` the moment that process exits, so `session_id` on a review
 * card means "an agent is on it" (obj 900669).
 */
export function hasLiveSession(obj: { session_id?: string | null }): boolean {
  return obj.session_id != null && obj.session_id !== ''
}

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
  // obj 900669 — Needs You is only cards that genuinely need the human. A
  // review card with an agent still running on it sits in Working until that
  // session ends; then it drops back into Needs You.
  if (obj.status === 'review') return hasLiveSession(obj) ? 'working' : 'review'
  const inFlight = children?.some(w => isInFlightStatus(w.status)) ?? false
  return obj.delegate_mode && inFlight ? 'working' : obj.status
}

/**
 * The cards that genuinely need the human: the top-level cards whose board
 * column is Needs You. This is the ONE definition — the header's "need you"
 * count and the Needs You column both render from it, so they cannot disagree
 * (obj 900669: the header said 2 while the column held many more).
 */
export function needsYouCards<T extends ColumnObj & { id: number }>(
  topLevel: readonly T[],
  childrenByParent?: ReadonlyMap<number, readonly ColumnChild[]>,
): T[] {
  return topLevel.filter(o => boardColumnOf(o, childrenByParent?.get(o.id)) === 'review')
}
