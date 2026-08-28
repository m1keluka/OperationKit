/**
 * Core tables — extracted from db/index.ts (behavior frozen).
 * Probe-INSERT CHECK rebuilds stay in initDb() immediately after this call.
 */
import type Database from 'better-sqlite3'

export function initCoreSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('admin', 'member')),
      email TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS user_workspaces (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      workspace TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('admin', 'member')),
      can_use_jarvis INTEGER NOT NULL DEFAULT 1,
      objective_visibility TEXT NOT NULL DEFAULT 'own' CHECK(objective_visibility IN ('own', 'all')),
      PRIMARY KEY (user_id, workspace)
    );

    CREATE TABLE IF NOT EXISTS objectives (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'queue' CHECK(status IN ('queue', 'working', 'review', 'done')),
      agent_context TEXT NOT NULL DEFAULT 'general' CHECK(agent_context IN ('cto', 'cmo', 'coo', 'cfo', 'general', 'designer', 'hr', 'general-counsel')),
      assigned_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      session_id TEXT,
      transcript_path TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_objectives_status ON objectives(status);
  `)

}
