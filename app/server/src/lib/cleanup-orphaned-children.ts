// ── Orphan-child cleanup on parent-terminal (obj 700595, FIX 1a) ─────────────
//
// Root cause (700583/w1-rootcause.md §A): when a parent objective reaches a
// terminal state (`done`/`review`/`cancelled`), its still-`queue`, never-ran
// children are stranded forever — nothing cascades to siblings, and every
// wake-net short-circuits on a terminal parent. This helper is the missing
// counterweight: it retires those orphans to the `cancelled` soft-retire state
// (obj 700595) so history is not falsified (they never completed — `done` would
// lie — but they are no longer live).
//
// Shared by BOTH terminal-transition call sites (routes/objectives.ts and
// routes/internal.ts) so the behavior can never drift between the authenticated
// human path and the unauthenticated internal PATCH path.
//
// GUARDS (non-negotiable):
//  - only children WHERE parent_id = <this parent> (never siblings/unrelated)
//  - only status = 'queue' (never touch a working/review/done child)
//  - only session_count = 0 (never touch a child that produced work)
//  - only deleted_at IS NULL (idempotent — never re-touch a retired row)
// Every retire is audit-logged (append-only) and broadcast so the board updates.

import type { Database } from 'better-sqlite3'
import type { Objective } from '@operationkit/shared'
import { logObjectiveAudit } from '../services/objective-audit.js'

export interface CleanupResult {
  cancelledIds: number[]
}

/**
 * Retire the never-ran queued children of a parent that has reached a terminal
 * state. Returns the ids that were retired. Best-effort per child: one failure
 * is logged and skipped so it can never break the parent transition that
 * triggered it.
 *
 * @param broadcast optional — when provided, an `objective_updated` event is
 *   emitted for each retired child so open boards reflect the change live.
 */
export function cleanupOrphanedChildrenOnParentTerminal(
  db: Database,
  parentId: number,
  broadcast?: (msg: { type: 'objective_updated'; payload: Objective }) => void,
  parentStatus?: string,
): CleanupResult {
  // Review is a park, not a kill. Never-ran children of a parent that just
  // landed in Needs You should still be startable — not cancelled.
  if (parentStatus === 'review') return { cancelledIds: [] }

  const cancelledIds: number[] = []

  let orphans: Objective[] = []
  try {
    orphans = db
      .prepare(
        `SELECT * FROM objectives
          WHERE parent_id = ?
            AND status = 'queue'
            AND session_count = 0
            AND deleted_at IS NULL`,
      )
      .all(parentId) as Objective[]
  } catch (err) {
    console.error(
      `[orphan-cleanup] query failed for parent ${parentId}:`,
      (err as Error).message,
    )
    return { cancelledIds }
  }

  for (const child of orphans) {
    try {
      db.prepare(
        "UPDATE objectives SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?",
      ).run(child.id)

      logObjectiveAudit(db, {
        objectiveId: child.id,
        eventType: 'status_change',
        fromStatus: child.status,
        toStatus: 'cancelled',
        actor: 'machine',
        pathway: 'orphan-child-cleanup-on-parent-terminal',
        sessionId: child.session_id ?? null,
        titleSnapshot: child.title ?? null,
        workspace: child.workspace ?? null,
      })
      cancelledIds.push(child.id)

      if (broadcast) {
        const updated = db
          .prepare('SELECT * FROM objectives WHERE id = ?')
          .get(child.id) as Objective
        broadcast({ type: 'objective_updated', payload: updated })
      }
    } catch (err) {
      console.error(
        `[orphan-cleanup] failed to retire child ${child.id} of parent ${parentId}:`,
        (err as Error).message,
      )
    }
  }

  if (cancelledIds.length > 0) {
    console.log(
      `[orphan-cleanup] parent #${parentId} terminal → retired ${cancelledIds.length} orphaned queue child(ren) to 'cancelled': ${cancelledIds.join(', ')}`,
    )
  }
  return { cancelledIds }
}
