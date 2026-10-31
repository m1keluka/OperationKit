/**
 * Agent API keys (obj 714090) — named, scoped, multi-key principals so each
 * Grok Bot is its own least-privilege identity instead of a full copy of the
 * user's account. Additive only: the legacy users.api_token_hash key is left
 * exactly as it is (full-scope, one per user) and keeps working.
 */
import type Database from 'better-sqlite3'

export function initAgentKeysSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_api_keys (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      label        TEXT NOT NULL,
      key_hash     TEXT NOT NULL UNIQUE,
      last4        TEXT NOT NULL,
      scopes       TEXT NOT NULL,            -- JSON array of AgentScope
      workspaces   TEXT,                     -- JSON array of slugs; NULL = all the user's workspaces
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      last_used_at TEXT,
      revoked_at   TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_agent_api_keys_user ON agent_api_keys(user_id);
  `)

  // Attribution on the card itself: which key created it. The label is a
  // snapshot so "created by Grok: Example" survives revocation. Both NULL for
  // every non-agent origin.
  const cols = new Set(
    (db.prepare('PRAGMA table_info(objectives)').all() as { name: string }[]).map(c => c.name),
  )
  if (!cols.has('agent_key_id')) {
    db.exec('ALTER TABLE objectives ADD COLUMN agent_key_id INTEGER')
  }
  if (!cols.has('agent_key_label')) {
    db.exec('ALTER TABLE objectives ADD COLUMN agent_key_label TEXT')
  }
}
