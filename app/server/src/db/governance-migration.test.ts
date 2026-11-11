import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import os from 'os'
import path from 'path'
import fs from 'fs'
import Database from 'better-sqlite3'

// Proves the obj-2509 migration (run by the REAL initDb) creates the KL-11
// `blocked_objectives` table + KL-21 objective columns, and seeds both feature
// flags OFF. DB_PATH is read at import time, so we set a unique temp path and
// dynamic-import the db module inside beforeAll (vitest isolates modules per file).
const TMP_DB = path.join(os.tmpdir(), `cc-gov-mig-${process.pid}-${Date.now()}.db`)
let getDb: () => Database.Database

beforeAll(async () => {
  process.env.DB_PATH = TMP_DB
  const mod = await import('./index.js')
  mod.initDb()
  getDb = mod.getDb
})

afterAll(() => {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(TMP_DB + suffix) } catch { /* ignore */ }
  }
})

describe('obj-2509 governance migration', () => {
  it('creates the blocked_objectives table with the documented columns', () => {
    const cols = (getDb().prepare('PRAGMA table_info(blocked_objectives)').all() as { name: string }[]).map((c) => c.name)
    for (const c of ['objective_pattern', 'reason', 'since', 'unblock_ticket', 'expires_at', 'resolved_at']) {
      expect(cols).toContain(c)
    }
  })

  it('adds KL-21 columns rejected_tree_sha + not_mergeable to objectives', () => {
    const cols = (getDb().prepare('PRAGMA table_info(objectives)').all() as { name: string }[]).map((c) => c.name)
    expect(cols).toContain('rejected_tree_sha')
    expect(cols).toContain('not_mergeable')
  })

  it('seeds both feature flags OFF by default', () => {
    const get = (k: string) => (getDb().prepare('SELECT value FROM settings WHERE key = ?').get(k) as { value?: string } | undefined)?.value
    expect(get('gate_rejection_memory_enabled')).toBe('0')
    expect(get('blocked_registry_enabled')).toBe('0')
  })

  it('round-trips a blocked rule end to end via the real schema', () => {
    const db = getDb()
    db.prepare("INSERT INTO blocked_objectives (objective_pattern, reason, unblock_ticket) VALUES ('migration-probe', 'test', 'T-0')").run()
    const row = db.prepare("SELECT * FROM blocked_objectives WHERE objective_pattern = 'migration-probe'").get() as { reason: string; resolved_at: string | null }
    expect(row.reason).toBe('test')
    expect(row.resolved_at).toBeNull()
  })
})
