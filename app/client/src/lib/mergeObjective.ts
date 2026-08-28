import type { Objective } from '@command-center/shared'

/**
 * Merge a live `objective_updated` payload onto the row already on the board.
 *
 * Poller broadcasts often send a raw SQLite row (no assigned_usernames /
 * assigned_user_ids). Replacing the board card wholesale made Ava-owned work
 * look Unassigned and leak through the owner filter. Keep the hydrated
 * assignee fields unless the incoming payload actually includes them
 * (including an explicit empty array = unassigned).
 */
export function mergeObjectiveUpdate(prev: Objective | undefined, incoming: Objective): Objective {
  if (!prev) return incoming
  const next: Objective = { ...prev, ...incoming }
  if (!Array.isArray(incoming.assigned_usernames) && Array.isArray(prev.assigned_usernames)) {
    next.assigned_usernames = prev.assigned_usernames
  }
  if (!Array.isArray(incoming.assigned_user_ids) && Array.isArray(prev.assigned_user_ids)) {
    next.assigned_user_ids = prev.assigned_user_ids
  }
  return next
}
