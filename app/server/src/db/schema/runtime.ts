/**
 * session_runtime — extracted from db/index.ts (behavior frozen).
 */
import type Database from 'better-sqlite3'

export function initRuntimeSchema(db: Database.Database): void {
  // ── Native --resume support (2026-06-12) ──────────────────────────────
  // Maps a CC session id to the Claude CLI's own session_id (from the
  // stream-json init event) plus the account that owns its transcript, so
  // dead-process follow-ups can respawn with `claude --resume` instead of
  // flattening objective history into a lossy text prompt.
  // Deliberately NOT a column on session_intel: the extractor rebuilds those
  // rows with INSERT OR REPLACE, which would null any column it doesn't list.
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_runtime (
      session_id TEXT PRIMARY KEY,
      claude_session_id TEXT,
      account_id TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `)

}
