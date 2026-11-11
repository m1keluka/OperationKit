// Content-engine ownership.
//
// The Granola → content pipeline (LinkedIn drafts / hooks / ideas) started life
// single-tenant: every path was derived from one `GRANOLA_WORKSPACE` env var and
// the whole HTTP surface was admin-only, so Operator was structurally the only person
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
// different questions that only coincided while Operator was the only user.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
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

/** One owner row to seed. Matched by username; never creates a user. */
export interface ContentOwnerSeed {
  username: string
  vault: string
  founder: string
  display: string
}

const HERE = path.dirname(fileURLToPath(import.meta.url))
// src/db/schema/content.ts and dist/db/schema/content.js both sit three levels
// below the server package root (same walk as schema/agents.ts).
const SERVER_ROOT = path.resolve(HERE, '..', '..', '..')

/**
 * The operator's REAL owner list lives in a gitignored seed file, never in source
 * (obj 900493: the two real owners — full names included — were hardcoded here and
 * shipped to the public OSS mirror). Precedence mirrors seed.agents.json:
 * SEED_CONTENT_OWNERS_PATH, then app/server/seed.content-owners.json. No file =
 * no seed, which is the correct blank-slate behaviour for a fresh install: an
 * operator grants the Content surface by inserting a `content_owners` row.
 *
 * Existing deployments are unaffected — the seed was INSERT OR IGNORE, so rows it
 * created earlier stay put whether or not the file is present.
 */
export function loadContentOwnerSeeds(): ContentOwnerSeed[] {
  const candidates = [process.env.SEED_CONTENT_OWNERS_PATH, path.join(SERVER_ROOT, 'seed.content-owners.json')]
  const file = candidates.find((c): c is string => !!c && fs.existsSync(c))
  if (!file) return []
  try {
    const rows = JSON.parse(fs.readFileSync(file, 'utf-8')) as unknown
    if (!Array.isArray(rows)) throw new Error('not a JSON array')
    return rows.filter(
      (r): r is ContentOwnerSeed =>
        !!r && typeof r === 'object' &&
        ['username', 'vault', 'founder', 'display'].every((k) => typeof (r as Record<string, unknown>)[k] === 'string'),
    )
  } catch (err) {
    console.warn(`[db] content-owner seed ${file} is unreadable/invalid — skipping:`, (err as Error).message)
    return []
  }
}

/**
 * Idempotent seed of the configured owners, matched by username so a fresh DB and
 * the live DB converge on the same rows.
 *
 * Nothing here creates a user. If the username is absent (a fresh CI database),
 * that owner is simply skipped.
 */
function seedContentOwners(db: Database.Database): void {
  const seeds = loadContentOwnerSeeds()
  if (seeds.length === 0) return
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
