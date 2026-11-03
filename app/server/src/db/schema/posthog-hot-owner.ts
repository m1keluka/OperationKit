// PostHog hot_owner sync: run log + undo log (obj 900091).
//
// Backs the Command Center schedule that mirrors the "Hot owners (14d)" cohort (655347,
// project 584614) onto the PostHog person property `hot_owner`. See
// ../../lib/posthog-hot-owner-sync.ts for the diff/write logic and
// ../../services/posthog-hot-owner-scheduler.ts for the weekday-8-to-19:30-ET ticker.
//
// posthog_hot_owner_sync_runs  one row per run; the scheduler reads the last few to
//                              count consecutive failures and alerts Mike at 3.
// posthog_hot_owner_undo_log   one row per person change, written BEFORE the $set is
//                              sent. To undo a run: re-send previous_value for its rows.
import type Database from 'better-sqlite3'

export function initPostHogHotOwnerSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS posthog_hot_owner_sync_runs (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at      TEXT NOT NULL DEFAULT (datetime('now')),
      finished_at     TEXT,
      source          TEXT NOT NULL DEFAULT 'schedule',
      dry_run         INTEGER NOT NULL DEFAULT 0,
      status          TEXT NOT NULL DEFAULT 'running',
      cohort_members  INTEGER,
      flagged_before  INTEGER,
      set_true        INTEGER,
      set_false       INTEGER,
      error           TEXT,
      alerted         INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_posthog_hot_owner_runs_started ON posthog_hot_owner_sync_runs(started_at DESC);

    CREATE TABLE IF NOT EXISTS posthog_hot_owner_undo_log (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id          INTEGER NOT NULL REFERENCES posthog_hot_owner_sync_runs(id),
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      person_uuid     TEXT NOT NULL,
      distinct_id     TEXT NOT NULL,
      property        TEXT NOT NULL DEFAULT 'hot_owner',
      previous_value  TEXT,
      new_value       INTEGER NOT NULL,
      reason          TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_posthog_hot_owner_undo_run ON posthog_hot_owner_undo_log(run_id);
  `)
}
