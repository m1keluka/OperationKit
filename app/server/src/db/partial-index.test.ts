import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import Database from 'better-sqlite3'

// Partial-index ↔ default-query alignment guard (obj 700872, extends obj 700585).
//
// The board's DEFAULT list query is
//   WHERE status NOT IN ('done', 'cancelled') AND deleted_at IS NULL ORDER BY updated_at DESC
// (obj 700872 hides BOTH done and cancelled by default). For SQLite to serve this
// from the partial index `idx_obj_active_updated` instead of falling back to a
// full `SCAN objectives | USE TEMP B-TREE FOR ORDER BY`, the index's partial
// predicate MUST byte-match the query's WHERE. This test locks that alignment so a
// future change to either side that breaks it fails the PR (the exact regression
// class obj 700585 was created to prevent, now widened to include cancelled).

const TMP_DB = path.join(os.tmpdir(), `cc-partial-index-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB
process.env.JWT_SECRET = 'test-secret-partial-index'

const { initDb, getDb } = await import('./index.js')

// The DEFAULT board list predicate — MUST stay byte-identical to
// routes/objectives-crud.ts (statusClause default branch) and to the
// partial-index predicate in db/index.ts.
const DEFAULT_WHERE = "status NOT IN ('done', 'cancelled') AND deleted_at IS NULL"
const DEFAULT_QUERY = `SELECT id FROM objectives WHERE ${DEFAULT_WHERE} ORDER BY updated_at DESC`

beforeAll(() => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
  const db = getDb()
  // Seed enough mixed-status rows that a full scan + temp sort would be a
  // measurably different plan than an index read.
  const ins = db.prepare("INSERT INTO objectives (title, status, workspace) VALUES (?, ?, ?)")
  for (let i = 0; i < 30; i++) ins.run(`active-${i}`, ['queue', 'working', 'review'][i % 3], 'testws')
  for (let i = 0; i < 60; i++) ins.run(`done-${i}`, 'done', 'testws')
  for (let i = 0; i < 20; i++) ins.run(`cancelled-${i}`, 'cancelled', 'testws')
})

afterAll(() => {
  try { getDb().close() } catch { /* noop */ }
  for (const s of ['', '-wal', '-shm']) {
    const f = `${TMP_DB}${s}`
    if (fs.existsSync(f)) fs.unlinkSync(f)
  }
})

describe('idx_obj_active_updated ↔ default query (obj 700872)', () => {
  it('exists with the new NOT IN (done, cancelled) predicate (not the old != done)', () => {
    const row = getDb()
      .prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_obj_active_updated'")
      .get() as { sql: string } | undefined
    expect(row).toBeTruthy()
    expect(row!.sql).toContain("status NOT IN ('done', 'cancelled')")
    expect(row!.sql).toContain('deleted_at IS NULL')
    // the stale single-status predicate must be gone
    expect(row!.sql).not.toMatch(/status\s*!=\s*'done'/)
  })

  it('default board query uses the partial index with NO temp b-tree / full scan', () => {
    const plan = getDb().prepare(`EXPLAIN QUERY PLAN ${DEFAULT_QUERY}`).all() as { detail: string }[]
    const detail = plan.map(p => p.detail).join('\n')
    expect(detail).toContain('USING INDEX idx_obj_active_updated')
    expect(detail).not.toMatch(/USE TEMP B-TREE/i)
    // no bare `SCAN objectives` without the index (a full row scan)
    expect(detail).not.toMatch(/SCAN objectives(?! USING INDEX)/)
  })

  it('list route still uses the byte-matched default predicate', () => {
    const src = fs.readFileSync(new URL('../routes/objectives-crud.ts', import.meta.url), 'utf-8')
    expect(src).toContain("status NOT IN ('done', 'cancelled')")
  })
})

// The migration must upgrade a pre-existing OLD-predicate index in place and be
// re-runnable. These raw statements are byte-identical to db/index.ts — keep them
// in sync (that is the whole point of the guard).
describe('idx_obj_active_updated migration is upgrade-safe + idempotent', () => {
  it('replaces the old != done index and survives a second run', () => {
    const raw = new Database(path.join(os.tmpdir(), `cc-partial-idx-raw-${process.pid}-${Date.now()}.db`))
    try {
      raw.exec('CREATE TABLE objectives (id INTEGER PRIMARY KEY, status TEXT, deleted_at TEXT, updated_at TEXT)')
      // Old-world index (obj 700585 predicate).
      raw.exec("CREATE INDEX idx_obj_active_updated ON objectives(updated_at DESC) WHERE status != 'done' AND deleted_at IS NULL")

      const migrate = () => {
        raw.exec('DROP INDEX IF EXISTS idx_obj_active_updated')
        raw.exec("CREATE INDEX IF NOT EXISTS idx_obj_active_updated ON objectives(updated_at DESC) WHERE status NOT IN ('done', 'cancelled') AND deleted_at IS NULL")
      }
      migrate()
      migrate() // idempotent — a second pass must not throw

      const sql = (raw.prepare("SELECT sql FROM sqlite_master WHERE name='idx_obj_active_updated'").get() as { sql: string }).sql
      expect(sql).toContain("status NOT IN ('done', 'cancelled')")
      expect(sql).not.toMatch(/status\s*!=\s*'done'/)
    } finally {
      raw.close()
    }
  })
})

describe('poller / member visibility indexes (2026-08-23)', () => {
  it('creates created_by, assigned_user_id, and live-session partial indexes', () => {
    const names = getDb()
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_objectives_%'")
      .all() as { name: string }[]
    const set = new Set(names.map(n => n.name))
    expect(set.has('idx_objectives_created_by')).toBe(true)
    expect(set.has('idx_objectives_assigned_user')).toBe(true)
    expect(set.has('idx_objectives_live_session')).toBe(true)
    expect(set.has('idx_objectives_ai_review_session')).toBe(true)
  })

  it('equality lookup on session_id uses the live-session partial index', () => {
    const db = getDb()
    db.prepare("UPDATE objectives SET session_id = 'cc-1-x' WHERE id = (SELECT id FROM objectives WHERE status='working' LIMIT 1)").run()
    const plan = db.prepare(
      "EXPLAIN QUERY PLAN SELECT id FROM objectives WHERE session_id = 'cc-1-x'"
    ).all() as { detail: string }[]
    const detail = plan.map(p => p.detail).join('\n')
    expect(detail).toContain('idx_objectives_live_session')
  })
})
