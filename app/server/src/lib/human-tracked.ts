import type { Objective } from '@operationkit/shared'

/**
 * "Human-tracked" = a top-level objective created by hand, NOT spawned by
 * an orchestrator (a delegator's worker child has `parent_id`) and NOT spawned
 * by a scheduled routine/job (`routine_id`).
 *
 * Default: those cards land in `review` so a person (or the authenticated Agent
 * API — Grok Bot) signs them off. The poller must never write `done` on them.
 *
 * Carve-outs (orchestration, not board cards Operator tracks):
 * - routine-spawned (`routine_id`) auto-complete so jobs don't flood Needs You
 * - delegator children (`parent_id`) auto-complete so the parent is woken
 *
 * Green lane and a passing AI review are NOT carve-outs. They skip or grade
 * work; they do not close the card.
 */
export function mustRouteToHumanReview(
  obj: Pick<Objective, 'parent_id' | 'routine_id'> & { type?: string | null },
  _opts?: { verdict?: string | null; lane?: 'green' | 'yellow' | 'red' },
): boolean {
  if (obj.parent_id != null || obj.routine_id != null) return false
  return true
}
