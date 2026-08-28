/**
 * Branch-ownership lease — the fail-safe dedup that prevents two sessions from
 * building the same branch concurrently (obj 994).
 *
 * Why a lease and not the existing atomic status-claim: the status claim is keyed
 * on `(objective.id, status-transition)` and is blind to the *branch* being built.
 * The PR #63 incident was two DIFFERENT sessions (one an auto-resume) committing to
 * the SAME branch. A lease keyed on `branch_name` arbitrates that case, and the
 * other wake sources (drain, reconcileDelegators, child-complete re-fires) all
 * funnel through `acquireBranchLease` at the single spawn chokepoint.
 *
 * Fail-safe invariants:
 *  - A live lease held by a DIFFERENT objective ⇒ the new spawn is REFUSED. The
 *    existing (legitimate) work is never killed or stranded.
 *  - A lease whose heartbeat is older than the TTL, or that was released, is
 *    reclaimable ⇒ a crashed owner never permanently strands a branch.
 *  - Re-acquire by the SAME objective while its lease is still live ⇒ 'reattached',
 *    so an auto-resume / drain re-wake rebinds to the running session instead of
 *    spawning a duplicate.
 */
import type { Database } from 'better-sqlite3'

/** Seconds after the last heartbeat before a lease is considered stale/reclaimable. */
export const LEASE_TTL_SECONDS = 90

export type LeaseStatus = 'acquired' | 'reattached' | 'conflict'

export interface LeaseHolder {
  branch_name: string
  objective_id: number
  session_id: string | null
  tmux_name: string | null
  acquired_at: string
  heartbeat_at: string
  released_at: string | null
}

export interface LeaseResult {
  status: LeaseStatus
  holder: LeaseHolder
}

/** Idempotent table creation — mirrored in initDb(); exported for tests. */
export function ensureBranchLeaseTable(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS branch_leases (
      branch_name  TEXT PRIMARY KEY,
      objective_id INTEGER NOT NULL,
      session_id   TEXT,
      tmux_name    TEXT,
      acquired_at  TEXT NOT NULL DEFAULT (datetime('now')),
      heartbeat_at TEXT NOT NULL DEFAULT (datetime('now')),
      released_at  TEXT
    );
  `)
  db.exec('CREATE INDEX IF NOT EXISTS idx_branch_leases_objective ON branch_leases(objective_id)')
}

function readLease(db: Database, branchName: string): LeaseHolder | undefined {
  return db.prepare('SELECT * FROM branch_leases WHERE branch_name = ?').get(branchName) as LeaseHolder | undefined
}

/**
 * Claim `branchName` for `objectiveId`. See module docs for the three outcomes.
 * Mutual exclusion comes from the conditional upsert's WHERE clause plus the
 * post-write ownership re-read: a foreign live holder fails the WHERE (0 rows
 * changed) and the re-read still shows the other owner, so the loser returns
 * 'conflict'. The pre-read only distinguishes 'acquired' from 'reattached' (it
 * does not gate correctness). better-sqlite3 runs each call synchronously on a
 * single connection, so the read-modify-read sequence is not interleaved.
 */
export function acquireBranchLease(
  db: Database,
  branchName: string,
  objectiveId: number,
  sessionId: string,
  tmuxName: string | null = null,
): LeaseResult {
  // Pre-read: is there a LIVE holder, and is it us?
  const prior = db
    .prepare(
      `SELECT objective_id AS oid,
              (released_at IS NULL AND heartbeat_at >= datetime('now', '-${LEASE_TTL_SECONDS} seconds')) AS live
         FROM branch_leases WHERE branch_name = ?`,
    )
    .get(branchName) as { oid: number; live: number } | undefined

  // A live lease held by another objective → refuse, do not touch the row.
  if (prior && prior.live && prior.oid !== objectiveId) {
    return { status: 'conflict', holder: readLease(db, branchName)! }
  }

  // Conditional upsert: take the lease iff it is free / released / stale, or
  // already ours. The WHERE clause is what makes a concurrent foreign racer lose.
  db.prepare(
    `INSERT INTO branch_leases (branch_name, objective_id, session_id, tmux_name, acquired_at, heartbeat_at, released_at)
       VALUES (@b, @o, @s, @t, datetime('now'), datetime('now'), NULL)
     ON CONFLICT(branch_name) DO UPDATE SET
       objective_id = excluded.objective_id,
       session_id   = excluded.session_id,
       tmux_name    = excluded.tmux_name,
       heartbeat_at = datetime('now'),
       released_at  = NULL
     WHERE branch_leases.released_at IS NOT NULL
        OR branch_leases.heartbeat_at < datetime('now', '-${LEASE_TTL_SECONDS} seconds')
        OR branch_leases.objective_id = excluded.objective_id`,
  ).run({ b: branchName, o: objectiveId, s: sessionId, t: tmuxName })

  const cur = readLease(db, branchName)!
  // Lost a concurrent race to another objective (foreign live holder appeared).
  if (cur.objective_id !== objectiveId) {
    return { status: 'conflict', holder: cur }
  }
  const reattached = !!(prior && prior.live && prior.oid === objectiveId)
  return { status: reattached ? 'reattached' : 'acquired', holder: cur }
}

/** Refresh the heartbeat for a live lease (called each poll tick by state-poller). */
export function heartbeatBranchLease(db: Database, branchName: string, objectiveId: number): void {
  db.prepare(
    `UPDATE branch_leases SET heartbeat_at = datetime('now')
       WHERE branch_name = ? AND objective_id = ? AND released_at IS NULL`,
  ).run(branchName, objectiveId)
}

/** Mark a branch's lease released (terminal status / session death). Idempotent. */
export function releaseBranchLease(db: Database, branchName: string): void {
  db.prepare(
    `UPDATE branch_leases SET released_at = datetime('now') WHERE branch_name = ? AND released_at IS NULL`,
  ).run(branchName)
}

/** Release every lease held by an objective (done / deleted). */
export function releaseBranchLeasesForObjective(db: Database, objectiveId: number): void {
  db.prepare(
    `UPDATE branch_leases SET released_at = datetime('now') WHERE objective_id = ? AND released_at IS NULL`,
  ).run(objectiveId)
}

/** Read the current (possibly released/stale) lease row, or undefined. */
export function getBranchLease(db: Database, branchName: string): LeaseHolder | undefined {
  return readLease(db, branchName)
}
