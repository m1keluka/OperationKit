/**
 * Owned, restart-safe, idempotent job teardown (obj 900322, constraint C4 / G10).
 *
 * ## What was broken
 *
 * - `PATCH /:id/status` handles `done` and `review` with a real teardown block
 *   (stopSession → clear `session_id` → release branch + identity leases). The
 *   `cancelled` case falls into the bare `else` and does NOTHING but write the
 *   status, so the tmux session runs on — billing — until the 8h watchdog.
 * - `stopSession` wraps its whole body in `if (session)`, reading the in-memory
 *   `activeSessions` map. That map is empty after a server restart while the tmux
 *   session survives, so Stop is a silent no-op on exactly the sessions that most
 *   need stopping, and the `obj:<id>` lease is never released — a Reopen inside
 *   the lease TTL "reattaches" to a corpse.
 *
 * ## What this does, and what it deliberately does not
 *
 * `teardownObjectiveJob` kills ONLY the tmux session the card owns and releases
 * ONLY that card's leases. Ownership is resolved from durable state — the card's
 * own `session_id` and the `session_leases`/`branch_leases` rows the card holds —
 * never from a prefix scan or a pattern kill, so a concurrent unrelated session
 * cannot be caught by it. It takes no action at all on a card that owns nothing.
 *
 * It does not depend on `activeSessions`, so it behaves identically before and
 * after a restart. And it records each teardown in `objective_job_teardowns`
 * under a UNIQUE key, so "released exactly once" is a checkable fact rather than
 * an assumption.
 */
import type { Database } from 'better-sqlite3'

export interface TeardownDeps {
  /** Kill one tmux session BY EXACT NAME. Must return false if it did not exist. */
  killTmux: (tmuxName: string) => boolean
  /** Best-effort in-process stop (account bookkeeping, jail reap). May no-op. */
  stopSession?: (sessionId: string) => void | Promise<void>
  releaseBranchLeases: (db: Database, objectiveId: number) => void
  releaseSessionLeases: (db: Database, objectiveId: number) => void
}

export interface OwnedJob {
  sessionId: string | null
  /** Every tmux name this card demonstrably owns, de-duplicated. */
  tmuxNames: string[]
}

export interface TeardownResult {
  /** False when this exact teardown was already recorded (idempotent re-entry). */
  performed: boolean
  objectiveId: number
  sessionId: string | null
  killedTmux: string[]
  leasesReleased: boolean
  reason: string
}

/**
 * What does this card own RIGHT NOW, according to durable state only?
 *
 * Sources, all card-scoped:
 *  - `objectives.session_id` — the card's current session;
 *  - `session_leases.tmux_name` / `branch_leases.tmux_name` for rows whose
 *    `objective_id` is this card and which are not already released.
 *
 * A tmux name is included only if some row attributes it to THIS objective.
 * There is no `cc-<id>-*` glob here on purpose: that pattern has matched
 * another card's session before (id 90 vs 900, prefix collision), and a
 * cancellation that kills a neighbour is worse than one that leaks.
 */
export function resolveOwnedJob(db: Database, objectiveId: number): OwnedJob {
  let sessionId: string | null = null
  try {
    const row = db.prepare('SELECT session_id FROM objectives WHERE id = ?').get(objectiveId) as
      | { session_id: string | null }
      | undefined
    sessionId = row?.session_id ?? null
  } catch { /* unreadable → own nothing */ }

  const names = new Set<string>()
  for (const table of ['session_leases', 'branch_leases'] as const) {
    try {
      const rows = db
        .prepare(`SELECT tmux_name, session_id FROM ${table} WHERE objective_id = ? AND released_at IS NULL`)
        .all(objectiveId) as { tmux_name: string | null; session_id: string | null }[]
      for (const r of rows) {
        if (r.tmux_name) names.add(r.tmux_name)
        // A lease row that names the session but not the tmux still identifies
        // ownership; the session id IS the default tmux name in this runner.
        else if (r.session_id) names.add(r.session_id)
      }
    } catch { /* table absent in a minimal DB → skip */ }
  }
  if (sessionId) names.add(sessionId)

  return { sessionId, tmuxNames: [...names] }
}

/**
 * Tear down the card's own job: kill its tmux, release its leases, clear its
 * `session_id`.
 *
 * Idempotent through `objective_job_teardowns(objective_id, reason)` UNIQUE: a second call with the same reason returns `performed: false` and
 * touches nothing. The poller can therefore call it on every tick without
 * double-releasing, and a crash between the kill and the ledger write re-runs
 * the kill (which is itself idempotent — killing an absent tmux is a no-op).
 *
 * Never throws: a teardown that fails loudly in the middle still releases what
 * it can, and reports what it did.
 */
export function teardownObjectiveJob(
  db: Database,
  objectiveId: number,
  reason: string,
  deps: TeardownDeps,
): TeardownResult {
  const owned = resolveOwnedJob(db, objectiveId)

  // Claim the teardown FIRST. If another caller already claimed this
  // (objective, session, reason) we are a duplicate and must do nothing.
  let claimed = true
  try {
    const ins = db
      .prepare(
        `INSERT OR IGNORE INTO objective_job_teardowns (objective_id, session_id, reason)
         VALUES (?, ?, ?)`,
      )
      .run(objectiveId, owned.sessionId, reason)
    // UNIQUE is (objective_id, reason) — see the schema comment. It cannot
    // include session_id, because this very function nulls it.
    claimed = ins.changes === 1
  } catch { /* ledger table absent → proceed without idempotency */ }

  if (!claimed) {
    return {
      performed: false,
      objectiveId,
      sessionId: owned.sessionId,
      killedTmux: [],
      leasesReleased: false,
      reason,
    }
  }

  const killed: string[] = []
  for (const name of owned.tmuxNames) {
    try {
      if (deps.killTmux(name)) killed.push(name)
    } catch (err) {
      console.warn(`[job-teardown] tmux kill failed for ${name} (obj ${objectiveId}):`, (err as Error).message)
    }
  }

  if (owned.sessionId && deps.stopSession) {
    try {
      void deps.stopSession(owned.sessionId)
    } catch (err) {
      console.warn(`[job-teardown] stopSession failed for ${owned.sessionId}:`, (err as Error).message)
    }
  }

  let leasesReleased = false
  try {
    deps.releaseBranchLeases(db, objectiveId)
    deps.releaseSessionLeases(db, objectiveId)
    leasesReleased = true
  } catch (err) {
    console.warn(`[job-teardown] lease release failed for obj ${objectiveId}:`, (err as Error).message)
  }

  try {
    db.prepare("UPDATE objectives SET session_id = NULL, updated_at = datetime('now') WHERE id = ?").run(objectiveId)
  } catch (err) {
    console.warn(`[job-teardown] session_id clear failed for obj ${objectiveId}:`, (err as Error).message)
  }

  try {
    db.prepare(
      `UPDATE objective_job_teardowns SET killed_tmux = ?, leases_released = ?
        WHERE objective_id = ? AND reason = ?`,
    ).run(killed.length, leasesReleased ? 1 : 0, objectiveId, reason)
  } catch { /* ledger absent */ }

  console.log(
    `[job-teardown] obj ${objectiveId} (${reason}): killed ${killed.length} owned tmux session(s)` +
      `${killed.length ? ` [${killed.join(', ')}]` : ''}, leases ${leasesReleased ? 'released' : 'NOT released'}.`,
  )

  return {
    performed: true,
    objectiveId,
    sessionId: owned.sessionId,
    killedTmux: killed,
    leasesReleased,
    reason,
  }
}
