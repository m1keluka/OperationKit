import type Database from 'better-sqlite3'

/**
 * obj 718944 — `objectives.needs_secret`: JSON array of
 * `{name, reason, requested_at}` the worker is blocked on. Names + reasons
 * only; a value never touches this column. NULL / '[]' = not waiting. Additive.
 */
export function initNeedsSecretSchema(db: Database.Database): void {
  const cols = new Set(
    (db.prepare('PRAGMA table_info(objectives)').all() as { name: string }[]).map(c => c.name),
  )
  if (!cols.has('needs_secret')) {
    db.exec('ALTER TABLE objectives ADD COLUMN needs_secret TEXT')
  }
}

/**
 * obj 718944 — secrets the verified owner pasted into a card chat. The value is
 * moved into the store at capture time; this row only remembers that it was
 * exposed in a chat once, so it shows on a "rotate later" list. Never a
 * blocker. Names only — no value column by construction.
 */
export function initSecretRotationFlagsSchema(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS secret_rotation_flags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace TEXT NOT NULL,
    key TEXT NOT NULL,
    objective_id INTEGER,
    source TEXT NOT NULL DEFAULT 'pasted_in_chat',
    flagged_by TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    resolved_at TEXT
  )`)
  db.exec('CREATE INDEX IF NOT EXISTS idx_secret_rotation_open ON secret_rotation_flags (resolved_at, created_at)')
}

/**
 * obj 719065 — one-time, write-only upload tokens an outside managing agent
 * (e.g. Grok Bot over MCP) mints to relay ONE requested secret. Only the
 * sha256 of the token is stored. Scoped to one card + one NAME + one scope;
 * single use (used_at) and short-lived (expires_at). No value column.
 *
 * Also adds `secret_versions.via` so a secret's History shows which agent
 * relayed a value (NULL = typed in Settings / owner UI).
 */
export function initSecretUploadTokensSchema(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS secret_upload_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token_hash TEXT NOT NULL UNIQUE,
    objective_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    scope_type TEXT NOT NULL,
    workspace TEXT,
    user_id INTEGER,
    agent_key_id INTEGER,
    agent_label TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL,
    used_at TEXT
  )`)
  const cols = new Set(
    (db.prepare('PRAGMA table_info(secret_versions)').all() as { name: string }[]).map(c => c.name),
  )
  if (cols.size && !cols.has('via')) db.exec('ALTER TABLE secret_versions ADD COLUMN via TEXT')
}
