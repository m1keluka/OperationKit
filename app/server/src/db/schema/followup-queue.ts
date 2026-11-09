/**
 * followup_queue (obj 900412) — messages sent while a card's worker was mid-turn.
 * Delivered to the same session when that turn ends. See services/followup-queue.ts.
 */
import type Database from 'better-sqlite3'

export function initFollowUpQueueSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS followup_queue (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      objective_id INTEGER NOT NULL,
      session_id   TEXT NOT NULL,
      message      TEXT NOT NULL,
      sender_json  TEXT,
      created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      delivered_at TEXT,
      dropped_at   TEXT,
      drop_reason  TEXT
    );
  `)
  db.exec('CREATE INDEX IF NOT EXISTS idx_followup_queue_pending ON followup_queue(objective_id) WHERE delivered_at IS NULL AND dropped_at IS NULL')
}
