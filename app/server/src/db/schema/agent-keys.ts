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

  // Per-key connector allow-list. A key may use a connector only if it is named
  // here AND the connection belongs to the key's owner.
  //
  // Migration: this column did not exist, and no per-key gate existed either, so
  // every EXISTING key could already reach every connector its owner had. Rows
  // present when the column is added are therefore set to the legacy wildcard
  // ['*'] — their behaviour is unchanged, and Settings labels them "All
  // (legacy)" so each one can be narrowed deliberately rather than by a silent
  // break. Keys created afterwards default to NULL, which means NO connectors.
  const keyCols = new Set(
    (db.prepare('PRAGMA table_info(agent_api_keys)').all() as { name: string }[]).map(c => c.name),
  )
  if (!keyCols.has('connectors')) {
    db.exec('ALTER TABLE agent_api_keys ADD COLUMN connectors TEXT')
    db.prepare("UPDATE agent_api_keys SET connectors = '[\"*\"]' WHERE connectors IS NULL").run()
  }

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
  // obj 900270: optional owning Grok bot (name or id). Set explicitly by the
  // filer on create/update, never inferred from the key. NULL = unowned. Additive.
  if (!cols.has('owner_bot')) {
    db.exec('ALTER TABLE objectives ADD COLUMN owner_bot TEXT')
  }
}
