/**
 * Branch and session leases — extracted from db/index.ts (behavior frozen).
 */
import type Database from 'better-sqlite3'

export function initLeasesSchema(db: Database.Database): void {
  // branch_leases (obj 994) — fail-safe branch-ownership lease that prevents two
  // sessions from building the same branch concurrently. Keyed on branch_name so
  // it arbitrates across objectives and across all spawn wake-sources. See
  // services/branch-lease.ts for the acquire/heartbeat/release semantics.
  db.exec(`
    CREATE TABLE IF NOT EXISTS branch_leases (
      branch_name  TEXT PRIMARY KEY,
      objective_id INTEGER NOT NULL,
      session_id   TEXT,
      tmux_name    TEXT,
      acquired_at  TEXT NOT NULL DEFAULT (datetime('now')),
      heartbeat_at TEXT NOT NULL DEFAULT (datetime('now')),
      released_at  TEXT
    );
  `)
  db.exec('CREATE INDEX IF NOT EXISTS idx_branch_leases_objective ON branch_leases(objective_id)')

  // session_leases (obj 1075) — fail-safe identity lease that prevents two
  // sessions from owning the same NON-PR objective concurrently. branch_leases
  // can't cover these: non-PR objectives take no branch, so they never acquired a
  // branch lease. Keyed on a generic lease_key (`obj:<id>` for same-objective
  // dedup, `parent:<parentId>:<slug>` for duplicate-card dedup). See
  // services/session-lease.ts for the acquire/heartbeat/release semantics.
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_leases (
      lease_key    TEXT PRIMARY KEY,
      objective_id INTEGER NOT NULL,
      session_id   TEXT,
      tmux_name    TEXT,
      acquired_at  TEXT NOT NULL DEFAULT (datetime('now')),
      heartbeat_at TEXT NOT NULL DEFAULT (datetime('now')),
      released_at  TEXT
    );
  `)
  db.exec('CREATE INDEX IF NOT EXISTS idx_session_leases_objective ON session_leases(objective_id)')

}
