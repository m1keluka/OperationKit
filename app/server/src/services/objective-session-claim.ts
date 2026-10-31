/**
 * One live session per card (obj 715699).
 *
 * What already existed and is NOT redone here:
 *  - obj 994  branch lease — PR objectives dedup on `branch_name`.
 *  - obj 1075 identity lease `obj:<id>` — but ONLY for non-PR objectives, and only on
 *    startSession / reopenObjective.
 *  - obj 1114 predecessor reaper + PR #380's sweep on every poll — kill duplicate
 *    `cc-<id>-*` tmux AFTER the fact.
 *  - PR #499 — interim turn-end results no longer park working cards.
 *
 * The two gaps this closes, both through the SAME DB-level identity lease (the
 * conditional upsert in session-lease.ts, so it holds across processes, not just
 * inside one event loop):
 *  1. PR objectives never took `obj:<id>`, so "one session per card" leaned
 *     entirely on the branch name staying stable. They now take it too.
 *  2. sendFollowUp's respawn path took no lease at all. A follow-up aimed at an
 *     older session id while a newer session of the same card was live would spawn
 *     a second worker (then the reaper killed the live one, losing its work). It
 *     now ATTACHES — the follow-up is redirected to the live session.
 */
import type { Database } from 'better-sqlite3'
import { acquireSessionLease, identityLeaseKey, type SessionLeaseHolder } from './session-lease.js'

export type ClaimOutcome =
  | { outcome: 'claimed'; sessionId: string }
  | { outcome: 'attach'; sessionId: string; holder: SessionLeaseHolder }

/**
 * Claim the card's identity lease for `sessionId`.
 *
 *  - free / released / stale            → claimed (this session now owns the card)
 *  - held live by this same session id  → claimed (resume in place; heartbeat refreshed)
 *  - held live by ANOTHER session id    → attach to it, unless `isAlive` says that
 *    session's process is gone, in which case the lease is taken over.
 */
export function claimObjectiveSession(
  db: Database,
  objectiveId: number,
  sessionId: string,
  isAlive: (sessionId: string) => boolean,
): ClaimOutcome {
  const key = identityLeaseKey(objectiveId)
  const lease = acquireSessionLease(db, key, objectiveId, sessionId)
  if (lease.status === 'acquired') return { outcome: 'claimed', sessionId }

  const holderId = lease.holder.session_id
  if (!holderId || holderId === sessionId) {
    db.prepare(
      "UPDATE session_leases SET heartbeat_at = datetime('now'), session_id = ? WHERE lease_key = ? AND objective_id = ?",
    ).run(sessionId, key, objectiveId)
    return { outcome: 'claimed', sessionId }
  }

  if (isAlive(holderId)) return { outcome: 'attach', sessionId: holderId, holder: lease.holder }

  // Live lease row but the process behind it is dead (died inside the TTL window).
  // Take it over — guarded on the holder we observed, so a concurrent claimer that
  // already moved the lease wins and we attach to it instead.
  const moved = db
    .prepare(
      `UPDATE session_leases SET session_id = ?, acquired_at = datetime('now'), heartbeat_at = datetime('now'), released_at = NULL
        WHERE lease_key = ? AND objective_id = ? AND session_id = ?`,
    )
    .run(sessionId, key, objectiveId, holderId)
  if (moved.changes === 1) return { outcome: 'claimed', sessionId }
  const cur = db.prepare('SELECT * FROM session_leases WHERE lease_key = ?').get(key) as SessionLeaseHolder
  return cur.session_id === sessionId
    ? { outcome: 'claimed', sessionId }
    : { outcome: 'attach', sessionId: cur.session_id!, holder: cur }
}
