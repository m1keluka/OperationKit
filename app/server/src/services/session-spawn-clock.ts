/**
 * Restart-durable current-spawn clock.
 *
 * The wall-clock watchdog (state-poller) must measure the CURRENT spawn of a
 * session, not the objective's whole lifetime. `getSessionStartedAt` reads the
 * in-memory `activeSessions` map, which is reset on every (re)spawn — correct,
 * but the map is WIPED by a server restart while the tmux session survives.
 * After a restart the watchdog fell back to the transcript file's birthtime,
 * which is the FIRST-ever spawn (the JSONL is appended across every resume), so
 * a freshly-resumed session reported a fake multi-day runtime and was force-
 * routed to review the instant it started (obj 702774: 30348 min reported vs
 * 0.6 min of actual work; 705254: 1725 vs 3.3; 705357: 602 vs 11.9).
 *
 * This module persists the spawn timestamp to SQLite at (re)spawn so the
 * in-memory value can be rehydrated after a restart, and the birthtime fallback
 * only applies to sessions this server has genuinely never seen.
 */
import type { Database } from 'better-sqlite3'

// The watchdog calls into this module on every poll tick (every 3 s, per working
// objective), so the CREATE TABLE is memoised per connection rather than re-run
// each time. A WeakSet keyed on the Database keeps test connections independent.
const ensured = new WeakSet<Database>()

/** Idempotent table creation — called lazily on first access; exported for tests. */
export function ensureSessionSpawnTable(db: Database): void {
  if (ensured.has(db)) return
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_spawns (
      session_id  TEXT PRIMARY KEY,
      started_at  INTEGER NOT NULL
    );
  `)
  ensured.add(db)
}

/**
 * Record (or overwrite) the start of the CURRENT spawn for `sessionId`.
 * Upsert, not insert: a follow-up resume re-spawns the same session id and MUST
 * reset the clock, otherwise the resumed turn inherits the original budget.
 */
export function recordSessionSpawn(db: Database, sessionId: string, startedAt: number): void {
  ensureSessionSpawnTable(db)
  db.prepare(
    `INSERT INTO session_spawns (session_id, started_at) VALUES (?, ?)
     ON CONFLICT(session_id) DO UPDATE SET started_at = excluded.started_at`,
  ).run(sessionId, Math.trunc(startedAt))
}

/** Persisted current-spawn start for `sessionId`, or null when unknown. */
export function getPersistedSpawnStart(db: Database, sessionId: string): number | null {
  ensureSessionSpawnTable(db)
  const row = db.prepare('SELECT started_at FROM session_spawns WHERE session_id = ?').get(sessionId) as
    | { started_at: number }
    | undefined
  return row && Number.isFinite(row.started_at) ? row.started_at : null
}

/** Drop the row once a session is stopped/dead so the table doesn't grow unbounded. */
export function clearSessionSpawn(db: Database, sessionId: string): void {
  ensureSessionSpawnTable(db)
  db.prepare('DELETE FROM session_spawns WHERE session_id = ?').run(sessionId)
}

/**
 * Pure precedence rule for the watchdog's wall-clock origin:
 *   in-memory spawn start  >  persisted spawn start  >  transcript birthtime.
 *
 * The birthtime is the last resort ONLY — it spans every resume and is what
 * produced the fake runtimes above. Returns null when nothing is known, which
 * the caller must treat as "do not force-route".
 */
export function resolveSpawnStartMs(input: {
  inMemoryMs?: number | null
  persistedMs?: number | null
  birthtimeMs?: number | null
}): number | null {
  const { inMemoryMs, persistedMs, birthtimeMs } = input
  if (inMemoryMs && Number.isFinite(inMemoryMs)) return inMemoryMs
  if (persistedMs && Number.isFinite(persistedMs)) return persistedMs
  if (birthtimeMs && Number.isFinite(birthtimeMs)) return birthtimeMs
  return null
}
