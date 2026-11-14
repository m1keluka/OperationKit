/**
 * High Agency supervisor — run log (obj 900795).
 *
 * The supervisor's FLAGS are not stored here. They are `review_items` (obj 900367's
 * one durable decision queue), routed with `review_items.routed_to`. This table is
 * only the run log: one row per daily review, so "did the supervisor run today,
 * what did it look at and what did it file" is answerable without reading logs.
 * It is not a review pile — nothing in it asks anybody to do anything.
 *
 * Idempotent, same contract as every other schema module: called from initDb()
 * and lazily by the owning service.
 */
import type Database from 'better-sqlite3'

export function initSupervisorSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS supervisor_runs (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      -- America/New_York calendar date the run belongs to (YYYY-MM-DD).
      run_date      TEXT NOT NULL,
      -- 'schedule' (the daily tick) | 'manual' (run-now by an operator).
      trigger       TEXT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'running',
      started_at    TEXT NOT NULL,
      finished_at   TEXT,
      bots          INTEGER NOT NULL DEFAULT 0,
      cards         INTEGER NOT NULL DEFAULT 0,
      flags         INTEGER NOT NULL DEFAULT 0,
      filed         INTEGER NOT NULL DEFAULT 0,
      withdrawn     INTEGER NOT NULL DEFAULT 0,
      -- JSON: per-kind counts, per-route counts, which checks were off and why.
      summary_json  TEXT,
      error         TEXT
    );
  `)
  // At most ONE scheduled run per day, enforced by the DB rather than by a
  // module-level "last fired" variable that a restart would forget. A manual
  // run-now is not limited (an operator asked for it).
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_supervisor_runs_daily
             ON supervisor_runs(run_date) WHERE trigger = 'schedule'`)
  db.exec('CREATE INDEX IF NOT EXISTS idx_supervisor_runs_started ON supervisor_runs(started_at)')
}
