/**
 * Session-identity lease — the fail-safe dedup for NON-PR (taskworker) sessions
 * (obj 1075, follow-up to the branch-ownership lease in obj 994).
 *
 * Why this exists separately from branch-lease: branch-lease keys on `branch_name`,
 * which is NULL for non-PR objectives (they edit the shared main checkout directly
 * and never create a branch). So the most common session type — 'tweak the Jobs
 * tab', 'refresh second-brain' — never acquired a lease and the double-spawn guard
 * never engaged for it. This lease keys on an identity that EVERY objective has, so
 * it covers the non-PR path the branch-lease can't reach.
 *
 * The machinery (TTL, conditional-upsert mutual exclusion, three outcomes) mirrors
 * branch-lease deliberately so the semantics are identical and battle-tested. The
 * only generalization is the key: an arbitrary `lease_key` string instead of a
 * branch name. Callers build two keys per objective:
 *   - `obj:<id>`                 — same-objective dedup (drain re-spawn, child-complete
 *                                  re-fire, auto-resume racing the original). The id
 *                                  is encoded in the key, so a foreign holder is
 *                                  impossible → this key only ever reattaches/acquires.
 *   - `parent:<parentId>:<slug>` — cross-card dedup (two DIFFERENT objective_ids that
 *                                  are duplicate cards, e.g. a re-fired CEaaS
 *                                  double-assign). A live foreign holder here yields
 *                                  `conflict` → the NEW spawn is refused.
 *
 * Fail-safe invariants (identical to branch-lease — never regress these):
 *  - A live lease held by a DIFFERENT objective ⇒ the new spawn is REFUSED. The
 *    existing (legitimate) work is never killed or stranded.
 *  - A lease whose heartbeat is older than the TTL, or that was released, is
 *    reclaimable ⇒ a crashed owner never permanently strands an objective, and a
 *    legitimate retry of a genuinely-dead session still succeeds.
 *  - Re-acquire by the SAME objective while its lease is still live ⇒ 'reattached',
 *    so a duplicate wake rebinds to the running session instead of double-spawning.
 */
import type { Database } from 'better-sqlite3'
import type { Objective } from '@command-center/shared'
import { slugifyTitle } from './branch-scope.js'

/** Seconds after the last heartbeat before a lease is considered stale/reclaimable. */
export const SESSION_LEASE_TTL_SECONDS = 90

export type SessionLeaseStatus = 'acquired' | 'reattached' | 'conflict'

export interface SessionLeaseHolder {
  lease_key: string
  objective_id: number
  session_id: string | null
  tmux_name: string | null
  acquired_at: string
  heartbeat_at: string
  released_at: string | null
}

export interface SessionLeaseResult {
  status: SessionLeaseStatus
  holder: SessionLeaseHolder
}

/** Canonical same-objective identity key — present on every objective. */
export function identityLeaseKey(objectiveId: number): string {
  return `obj:${objectiveId}`
}

/**
 * Secondary cross-card key: a duplicated/re-created card has a NEW objective_id but
 * the same parent and (normalized) title as the original. Returns null when the
 * objective has no parent (top-level cards rely on the identity key alone).
 */
export function parentTitleLeaseKey(parentId: number | null | undefined, title: string): string | null {
  if (!parentId) return null
  return `parent:${parentId}:${slugifyTitle(title)}`
}

/** Idempotent table creation — mirrored in initDb(); exported for tests. */
export function ensureSessionLeaseTable(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_leases (
      lease_key    TEXT PRIMARY KEY,
      objective_id INTEGER NOT NULL,
      session_id   TEXT,
      tmux_name    TEXT,
      acquired_at  TEXT NOT NULL DEFAULT (datetime('now')),
      heartbeat_at TEXT NOT NULL DEFAULT (datetime('now')),
      released_at  TEXT
    );
  `)
  db.exec('CREATE INDEX IF NOT EXISTS idx_session_leases_objective ON session_leases(objective_id)')
}

function readLease(db: Database, leaseKey: string): SessionLeaseHolder | undefined {
  return db.prepare('SELECT * FROM session_leases WHERE lease_key = ?').get(leaseKey) as
    | SessionLeaseHolder
    | undefined
}

/**
 * Claim `leaseKey` for `objectiveId`. See module docs for the three outcomes.
 * Mutual exclusion comes from the conditional upsert's WHERE clause plus the
 * post-write ownership re-read: a foreign live holder fails the WHERE (0 rows
 * changed) and the re-read still shows the other owner, so the loser returns
 * 'conflict'. better-sqlite3 runs each call synchronously on a single connection,
 * so the read-modify-read sequence is never interleaved.
 */
export function acquireSessionLease(
  db: Database,
  leaseKey: string,
  objectiveId: number,
  sessionId: string,
  tmuxName: string | null = null,
): SessionLeaseResult {
  // Pre-read: is there a LIVE holder, and is it us?
  const prior = db
    .prepare(
      `SELECT objective_id AS oid,
              (released_at IS NULL AND heartbeat_at >= datetime('now', '-${SESSION_LEASE_TTL_SECONDS} seconds')) AS live
         FROM session_leases WHERE lease_key = ?`,
    )
    .get(leaseKey) as { oid: number; live: number } | undefined

  // A live lease held by another objective → refuse, do not touch the row.
  if (prior && prior.live && prior.oid !== objectiveId) {
    return { status: 'conflict', holder: readLease(db, leaseKey)! }
  }

  // This SAME objective already holds a LIVE lease (duplicate wake: drain re-spawn,
  // child-complete double/triple re-fire, auto-resume racing the original). Rebind
  // to the EXISTING session — deliberately do NOT overwrite session_id/tmux_name,
  // so the caller gets the id of the session that is actually running and the live
  // worker is left wholly untouched (acceptance #1/#2: "1st untouched"). The new
  // sessionId is discarded; nothing was spawned under it. (This is the one place we
  // diverge from branch-lease, which clobbers session_id on reattach — harmful with
  // a non-deterministic generateSessionId. See the obj 1075 decision doc.)
  if (prior && prior.live && prior.oid === objectiveId) {
    return { status: 'reattached', holder: readLease(db, leaseKey)! }
  }

  // Otherwise the lease is free / released / stale (a genuinely dead prior owner).
  // Conditional upsert adopts THIS session as the new owner. The WHERE clause is
  // what makes a concurrent foreign racer lose (it can only win if released/stale).
  db.prepare(
    `INSERT INTO session_leases (lease_key, objective_id, session_id, tmux_name, acquired_at, heartbeat_at, released_at)
       VALUES (@k, @o, @s, @t, datetime('now'), datetime('now'), NULL)
     ON CONFLICT(lease_key) DO UPDATE SET
       objective_id = excluded.objective_id,
       session_id   = excluded.session_id,
       tmux_name    = excluded.tmux_name,
       acquired_at  = datetime('now'),
       heartbeat_at = datetime('now'),
       released_at  = NULL
     WHERE session_leases.released_at IS NOT NULL
        OR session_leases.heartbeat_at < datetime('now', '-${SESSION_LEASE_TTL_SECONDS} seconds')
        OR session_leases.objective_id = excluded.objective_id`,
  ).run({ k: leaseKey, o: objectiveId, s: sessionId, t: tmuxName })

  const cur = readLease(db, leaseKey)!
  // Lost a concurrent race to another objective (foreign live holder appeared).
  if (cur.objective_id !== objectiveId) {
    return { status: 'conflict', holder: cur }
  }
  return { status: 'acquired', holder: cur }
}

/** Refresh the heartbeat for a single live lease. */
export function heartbeatSessionLease(db: Database, leaseKey: string, objectiveId: number): void {
  db.prepare(
    `UPDATE session_leases SET heartbeat_at = datetime('now')
       WHERE lease_key = ? AND objective_id = ? AND released_at IS NULL`,
  ).run(leaseKey, objectiveId)
}

/**
 * Refresh the heartbeat for EVERY live lease an objective holds (both its identity
 * and parent-title keys). The state-poller calls this each tick for working non-PR
 * objectives — keyless so callers don't have to reconstruct the keys.
 */
export function heartbeatSessionLeasesForObjective(db: Database, objectiveId: number): void {
  db.prepare(
    `UPDATE session_leases SET heartbeat_at = datetime('now')
       WHERE objective_id = ? AND released_at IS NULL`,
  ).run(objectiveId)
}

/** Mark a single lease released. Idempotent. */
export function releaseSessionLease(db: Database, leaseKey: string): void {
  db.prepare(
    `UPDATE session_leases SET released_at = datetime('now') WHERE lease_key = ? AND released_at IS NULL`,
  ).run(leaseKey)
}

/** Release every lease held by an objective (done / deleted / unexpected death). */
export function releaseSessionLeasesForObjective(db: Database, objectiveId: number): void {
  db.prepare(
    `UPDATE session_leases SET released_at = datetime('now') WHERE objective_id = ? AND released_at IS NULL`,
  ).run(objectiveId)
}

/** Read the current (possibly released/stale) lease row, or undefined. */
export function getSessionLease(db: Database, leaseKey: string): SessionLeaseHolder | undefined {
  return readLease(db, leaseKey)
}

export interface SpawnLeaseResult {
  status: SessionLeaseStatus
  /** The key that drove the outcome (identity key for acquire/reattach, the cross-card key on conflict). */
  leaseKey: string
  holder: SessionLeaseHolder
}

/**
 * The spawn-chokepoint claim for a NON-PR objective: takes BOTH identity keys in
 * the order that gives the correct fail-safe outcome, and returns a single verdict
 * the caller (startSession / reopenObjective) acts on exactly like a branch lease.
 *
 *  1. identity key `obj:<id>` first. It encodes the id, so it can only ever
 *     'acquire' or 'reattach' — never conflict. A 'reattached' result means this
 *     same objective already holds a live lease (drain re-spawn, child-complete
 *     double/triple re-fire, auto-resume racing the original) → the caller rebinds
 *     to the running session instead of double-spawning. We return immediately
 *     WITHOUT touching the cross-card key (the original spawn already holds it).
 *  2. cross-card key `parent:<parentId>:<slug>` second, only when the identity key
 *     was freshly acquired. A live FOREIGN holder here (a duplicate card with a
 *     different objective_id — the CEaaS double-assign shape) yields 'conflict' →
 *     the caller refuses the NEW spawn. We roll back the identity lease we just
 *     took so the refused objective leaves no phantom lease behind (TTL reclaim is
 *     only the backstop, not the happy path).
 *
 * Returns 'acquired' when the spawn should proceed (the caller must then heartbeat
 * both keys via heartbeatSessionLeasesForObjective while the objective works).
 */
export function acquireSessionLeasesForSpawn(
  db: Database,
  objective: Pick<Objective, 'id' | 'parent_id' | 'title'>,
  sessionId: string,
  tmuxName: string | null = null,
): SpawnLeaseResult {
  const idKey = identityLeaseKey(objective.id)
  const idLease = acquireSessionLease(db, idKey, objective.id, sessionId, tmuxName)
  // Same objective already live → rebind. Its cross-card lease (if any) is still
  // held from the original spawn, so don't re-touch it.
  if (idLease.status === 'reattached') {
    return { status: 'reattached', leaseKey: idKey, holder: idLease.holder }
  }

  const ptKey = parentTitleLeaseKey(objective.parent_id, objective.title)
  if (ptKey) {
    const ptLease = acquireSessionLease(db, ptKey, objective.id, sessionId, tmuxName)
    if (ptLease.status === 'conflict') {
      // A different (duplicate) card owns this parent+title and is live. Refuse the
      // new spawn and release the identity lease we just took, so this refused
      // objective holds nothing and the legitimate owner is wholly untouched.
      releaseSessionLease(db, idKey)
      return { status: 'conflict', leaseKey: ptKey, holder: ptLease.holder }
    }
  }
  return { status: 'acquired', leaseKey: idKey, holder: idLease.holder }
}
