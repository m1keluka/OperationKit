// Content-engine ownership.
//
// The Granola → content pipeline (LinkedIn drafts / hooks / ideas) started life
// single-tenant: every path was derived from one `GRANOLA_WORKSPACE` env var and
// the whole HTTP surface was admin-only, so Mike was structurally the only person
// who could ever use it. `content_owners` is the seam that makes it multi-owner —
// one row per person who has the Content surface, carrying everything that used
// to be a global constant:
//
//   vault_workspace — which second-brain workspace their streams live under
//   founder_slug    — which li-post-writer founder pack writes in their voice
//   routine_name    — their own nightly granola-intake routine row
//
// A user with no row has no Content surface (403 + nav item hidden). This is the
// authorization predicate for the entire engine; it deliberately does NOT key off
// `users.role`, because "can use the content engine" and "is a global admin" are
// different questions that only coincided while Mike was the only user.
import type Database from 'better-sqlite3'

export const CONTENT_ROUTINE_PREFIX = 'granola-intake-'

export function initContentSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS content_owners (
      user_id         INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      vault_workspace TEXT NOT NULL UNIQUE,
      founder_slug    TEXT NOT NULL,
      display_name    TEXT NOT NULL DEFAULT '',
      routine_name    TEXT NOT NULL,
      enabled         INTEGER NOT NULL DEFAULT 1,
      created_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_content_owners_enabled ON content_owners(enabled);
  `)

  seedContentOwners(db)
}

/**
 * Idempotent seed of the two known owners, matched by username so a fresh DB and
 * the live DB converge on the same rows. Mike's row reproduces the exact values
 * the old hardcoded constants used (`operator` + `granola-intake-operator`), so
 * migrating him onto the table is a no-op at the filesystem and routine level.
 *
 * Nothing here creates a user. If the username is absent (a fresh CI database),
 * that owner is simply skipped.
 */
function seedContentOwners(db: Database.Database): void {
  const seeds = [
    { username: 'mike', vault: 'operator', founder: 'mike', display: 'Operatorsevicz' },
    { username: 'ava', vault: 'ava-kelly', founder: 'ava', display: 'Ava Kelly' },
  ]
  const findUser = db.prepare('SELECT id FROM users WHERE username = ?')
  const insert = db.prepare(
    `INSERT OR IGNORE INTO content_owners
       (user_id, vault_workspace, founder_slug, display_name, routine_name, enabled)
     VALUES (?, ?, ?, ?, ?, 1)`
  )
  for (const s of seeds) {
    const u = findUser.get(s.username) as { id: number } | undefined
    if (!u) continue
    insert.run(u.id, s.vault, s.founder, s.display, `${CONTENT_ROUTINE_PREFIX}${s.vault}`)
  }
}
