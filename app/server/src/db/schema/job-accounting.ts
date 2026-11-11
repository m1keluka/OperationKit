/**
 * Durable per-objective job accounting (obj 900322 — execution readiness B, C4/C9).
 *
 * Every retry budget and every suppressor in the runner is a module-level `Map`
 * (`noopRespawnCounts` in poller-loop.ts, `autoResumeCounts` /
 * `overloadRetryCounts` / `turnsContinueCounts` in session-death.ts). A deploy —
 * and self-deploy is a supported IN-SESSION action — resets all of them, which
 * silently re-arms every retry budget mid-run. The architecture report calls this
 * out as the compounding half of C4.
 *
 * This table is the durable home for:
 *  - attempt counters, keyed by objective + attempt kind, so a restart cannot
 *    hand a looping card a fresh budget;
 *  - the CONFIGURED finite cost/time ceiling for the card, and the spend measured
 *    against it.
 *
 * Deliberately NO numeric defaults. `cost_ceiling_usd` / `wallclock_ceiling_ms`
 * are NULL until something explicitly configures them. A guessed production
 * default would be indistinguishable from a real budget decision, and the whole
 * point of the ceiling is that somebody chose the number.
 */
import type Database from 'better-sqlite3'

export function initJobAccountingSchema(db: Database.Database): void {
  // One row per objective. Created lazily on first write (see job-accounting.ts).
  db.exec(`
    CREATE TABLE IF NOT EXISTS objective_job_accounting (
      objective_id         INTEGER PRIMARY KEY,
      cost_ceiling_usd     REAL,
      wallclock_ceiling_ms INTEGER,
      ceiling_source       TEXT,
      ceiling_set_at       TEXT,
      spent_usd            REAL    NOT NULL DEFAULT 0,
      elapsed_ms           INTEGER NOT NULL DEFAULT 0,
      ceiling_hit_at       TEXT,
      ceiling_hit_reason   TEXT,
      created_at           TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `)

  // Attempt counters. Separate table so a new attempt kind never needs a column
  // migration, and so the counter survives independently of the budget row.
  db.exec(`
    CREATE TABLE IF NOT EXISTS objective_job_attempts (
      objective_id INTEGER NOT NULL,
      kind         TEXT    NOT NULL,
      attempts     INTEGER NOT NULL DEFAULT 0,
      first_at     TEXT    NOT NULL DEFAULT (datetime('now')),
      last_at      TEXT    NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (objective_id, kind)
    );
  `)
  db.exec('CREATE INDEX IF NOT EXISTS idx_job_attempts_objective ON objective_job_attempts(objective_id)')

  // Per-SESSION observed wall-clock, so cumulative elapsed time is restart-safe
  // AND retry-safe WITHOUT double counting (obj 900322 corrections round).
  //
  // The runner observes "this spawn has been alive N ms" on every poll tick. A
  // naive additive counter would add the same milliseconds once per tick, and a
  // per-objective "last observed" counter would be wiped by a restart. Keying
  // the observation by (objective, session) and keeping the MAX makes the write
  // IDEMPOTENT: re-observing the same session overwrites rather than
  // accumulates, while a RESUME or a RESPAWN (a new session id) adds a new row.
  // Cumulative elapsed for a card is therefore SUM(elapsed_ms) across its
  // sessions - correct across retries, resumes and restarts alike, and a retry
  // cannot reset it because the earlier sessions' rows remain.
  db.exec(`
    CREATE TABLE IF NOT EXISTS objective_job_session_time (
      objective_id INTEGER NOT NULL,
      session_id   TEXT    NOT NULL,
      elapsed_ms   INTEGER NOT NULL DEFAULT 0,
      first_at     TEXT    NOT NULL DEFAULT (datetime('now')),
      last_at      TEXT    NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (objective_id, session_id)
    );
  `)
  db.exec('CREATE INDEX IF NOT EXISTS idx_job_session_time_objective ON objective_job_session_time(objective_id)')

  // Teardown ledger — one row per completed teardown of a card's owned job.
  // Teardown must be idempotent AND provably idempotent: the reviewer's
  // acceptance is "cancel releases owned resources EXACTLY once", which is a
  // claim about the ledger, not about the absence of a crash.
  db.exec(`
    CREATE TABLE IF NOT EXISTS objective_job_teardowns (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      objective_id INTEGER NOT NULL,
      session_id   TEXT,
      reason       TEXT    NOT NULL,
      killed_tmux  INTEGER NOT NULL DEFAULT 0,
      leases_released INTEGER NOT NULL DEFAULT 0,
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      -- The idempotency key is (objective_id, reason) and deliberately NOT
      -- session_id: teardown CLEARS objectives.session_id, so a second call
      -- resolves a null session and a (objective_id, session_id, reason) key
      -- would not collide — SQLite treats NULLs as distinct, so the "exactly
      -- once" guarantee would silently become "once per call". A caller that
      -- needs per-session granularity embeds the session id in the reason string.
      UNIQUE (objective_id, reason)
    );
  `)
  db.exec('CREATE INDEX IF NOT EXISTS idx_job_teardowns_objective ON objective_job_teardowns(objective_id)')
}
