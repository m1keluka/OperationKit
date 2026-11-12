/**
 * Which session action a `→ working` status PATCH must perform (obj 900652).
 *
 * Both status routes — the authenticated `PATCH /api/objectives/:id/status`
 * (board, `start_objective`, `update_status`) and the localhost
 * `PATCH /api/internal/objectives/:id/status` — branch on the card's CURRENT
 * status to decide whether to spawn a worker. Each used to carry its own inline
 * list (`queue || review || ai_review`), and any `→ working` move the workflow
 * allows but the list missed fell through to the routes' bare `else`, which only
 * writes `status = 'working'`. No `startSession`, no `session_id`.
 *
 * That is exactly how a `type=project` card started from `planning` died:
 * `planning → working` is legal for projects (shared/workflow.ts), the card was
 * reported `working`, nothing was spawned, and five minutes later the orphan
 * sweep (`sweepOrphanedWorkingSessions`) parked the session-less card in
 * `review` where the zero-token sweep stamped it `blocked` — session_count 0,
 * 0 tokens, $0, no summary (#900639 / #900640, 2026-11-12). `cancelled →
 * working` (legal for every type) had the same hole.
 *
 * One function, used by both routes, and `working-start.test.ts` asserts that
 * every `→ working` transition the workflow table allows maps to an action — so
 * a status added to the table later cannot silently land in the bare `else`.
 */
import type { ObjectiveStatus } from '@operationkit/shared'

/**
 * - `fresh_start` — spawn a new worker (`startSession`).
 * - `reopen`      — resume the most recent thread in place (`reopenObjective`,
 *                   which itself falls back to a fresh start when the card never ran).
 * - `noop`        — already working; the routes answer 200 without touching it.
 * - `unhandled`   — no session action is defined. Callers must never flip a card
 *                   to `working` on this result.
 */
export type WorkingStartAction = 'fresh_start' | 'reopen' | 'noop' | 'unhandled'

/** Statuses a `→ working` move launches a FRESH worker from. */
export const FRESH_START_FROM: readonly ObjectiveStatus[] = ['planning', 'queue', 'review', 'ai_review']

/** Terminal statuses a `→ working` move REOPENS (resumes the last thread). */
export const REOPEN_FROM: readonly ObjectiveStatus[] = ['done', 'cancelled']

export function workingStartAction(from: string | null | undefined): WorkingStartAction {
  if (from === 'working') return 'noop'
  if ((FRESH_START_FROM as readonly string[]).includes(from ?? '')) return 'fresh_start'
  if ((REOPEN_FROM as readonly string[]).includes(from ?? '')) return 'reopen'
  return 'unhandled'
}

/**
 * The previous session on a card leaving review/ai_review is recorded as failed
 * (it is being restarted). A card leaving `queue` or `planning` has no worker
 * session of its own — `planning` holds only the planner sub-session, tracked in
 * `planning_session_id`, never `session_id`.
 */
export function marksPriorSessionFailed(from: string | null | undefined): boolean {
  return from === 'review' || from === 'ai_review'
}
