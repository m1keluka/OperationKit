/**
 * Live card visibility (obj 715699) — worker progress events, per-session start
 * reasons, and fan-out groups. Idempotent; called from initDb() and lazily by the
 * owning services so a test DB that skipped initDb still works.
 */
import type Database from 'better-sqlite3'

export function initLiveProgressSchema(db: Database.Database): void {
  // objective_progress — structured "step N of M" snapshots a worker writes as it
  // goes. The newest row IS the latest snapshot; GET /:id/progress pages the rest.
  db.exec(`
    CREATE TABLE IF NOT EXISTS objective_progress (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      objective_id INTEGER NOT NULL,
      session_id   TEXT,
      step         INTEGER,
      total_steps  INTEGER,
      label        TEXT,
      note         TEXT,
      result       TEXT,
      artifacts    TEXT,
      source       TEXT NOT NULL DEFAULT 'worker',
      created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
  `)
  db.exec('CREATE INDEX IF NOT EXISTS idx_objective_progress_obj ON objective_progress(objective_id, id)')

  // session_starts — one row per spawn/resume/attach/refusal, carrying WHO or WHAT
  // flipped the card to working (board click, agent, merge lane, CI follow-up,
  // resume after limit, …). `kind` distinguishes a real spawn from an attach to the
  // already-live session and from a refused duplicate.
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_starts (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      objective_id INTEGER NOT NULL,
      session_id   TEXT,
      kind         TEXT NOT NULL,
      reason       TEXT NOT NULL,
      actor        TEXT,
      detail       TEXT,
      created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
  `)
  db.exec('CREATE INDEX IF NOT EXISTS idx_session_starts_obj ON session_starts(objective_id, id)')

  // fanout_groups — a parent card that fanned out N children with a concurrency
  // ceiling. The fan-out tick starts queued children up to the ceiling as earlier
  // siblings finish.
  db.exec(`
    CREATE TABLE IF NOT EXISTS fanout_groups (
      parent_id       INTEGER PRIMARY KEY,
      max_concurrency INTEGER NOT NULL,
      child_ids       TEXT NOT NULL,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at    TEXT
    );
  `)
}
