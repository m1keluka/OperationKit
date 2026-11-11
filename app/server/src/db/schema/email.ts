/**
 * Transactional email (obj 900497) — one-time sign-in links.
 *
 * Only the SHA-256 of a link token is stored, so a DB read never yields a
 * usable link. A row is single-use (`used_at`) and short-lived (`expires_at`).
 * Additive CREATE TABLE only; email settings themselves live in `settings`
 * (non-secret) and the secrets store (credential).
 */
import type Database from 'better-sqlite3'

export function initEmailSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS email_login_tokens (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash  TEXT NOT NULL UNIQUE,
      expires_at  TEXT NOT NULL,
      used_at     TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_email_login_tokens_user ON email_login_tokens(user_id);
  `)
  // Expired links are useless; keep the table small.
  db.prepare("DELETE FROM email_login_tokens WHERE expires_at < datetime('now', '-1 day')").run()
}
