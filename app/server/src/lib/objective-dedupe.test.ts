// obj 64 Part C — unit tests for the same-title duplicate guard helpers.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const TMP_DB = path.join(os.tmpdir(), `cc-objective-dedupe-test-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB

const { initDb, getDb } = await import('../db/index.js')
const {
  normalizeTitle,
  findOpenDuplicate,
  findRunningTwinForStart,
  isDuplicateGuardEnabled,
  duplicateGuardWindowHours,
  recordDedupe,
} = await import('./objective-dedupe.js')

beforeAll(() => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
})

afterAll(() => {
  try { getDb().close() } catch { /* ignore */ }
  for (const suffix of ['', '-wal', '-shm']) {
    const f = `${TMP_DB}${suffix}`
    if (fs.existsSync(f)) fs.unlinkSync(f)
  }
})

beforeEach(() => {
  const db = getDb()
  db.exec('DELETE FROM objectives')
  db.exec("DELETE FROM settings WHERE key LIKE 'duplicate_guard_%'")
  db.exec('DELETE FROM activity_log')
})

/** Insert a card created `minutesAgo` minutes ago (SQLite UTC format). */
function card(title: string, opts: { minutesAgo?: number; workspace?: string; status?: string; deleted?: boolean; parent_id?: number | null; routine_id?: number | null } = {}): number {
  const db = getDb()
  const r = db
    .prepare(
      `INSERT INTO objectives (title, agent_context, workspace, status, parent_id, routine_id, created_at, deleted_at)
       VALUES (?, 'general', ?, ?, ?, ?, datetime('now', ?), ?)`,
    )
    .run(
      title,
      opts.workspace ?? 'example',
      opts.status ?? 'queue',
      opts.parent_id ?? null,
      opts.routine_id ?? null,
      `-${opts.minutesAgo ?? 0} minutes`,
      opts.deleted ? new Date().toISOString() : null,
    )
  return Number(r.lastInsertRowid)
}

describe('normalizeTitle', () => {
  it('lowercases, trims and collapses whitespace', () => {
    expect(normalizeTitle('  Fix   The\tLogin  Bug ')).toBe('fix the login bug')
  })
  it('strips punctuation and emoji', () => {
    expect(normalizeTitle('Fix: the login-bug!! 🚀')).toBe('fix the login bug')
    expect(normalizeTitle('🔥 Fix — the "login" bug…')).toBe('fix the login bug')
  })
  it('strips trailing (n) / copy suffixes, stacked', () => {
    for (const t of ['Fix login (2)', 'Fix login ( 3 )', 'Fix login (copy)', 'Fix login (Copy 2)', 'Fix login copy', 'Fix login - Copy 3', 'Fix login — copy', 'Fix login (copy) (2)']) {
      expect(normalizeTitle(t)).toBe('fix login')
    }
  })
  it('keeps a bare trailing number and words containing "copy"', () => {
    expect(normalizeTitle('Phase 2')).toBe('phase 2')
    expect(normalizeTitle('Phase 2')).not.toBe(normalizeTitle('Phase 3'))
    expect(normalizeTitle('Fix photocopy')).toBe('fix photocopy')
  })
  it('is deterministic and empty for punctuation-only titles', () => {
    expect(normalizeTitle('Fix login')).toBe(normalizeTitle('fix LOGIN.'))
    expect(normalizeTitle('!!! 🚀')).toBe('')
    expect(normalizeTitle(null)).toBe('')
  })
})

describe('findOpenDuplicate', () => {
  it('a 23h59m-old open twin is a duplicate; 24h01m-old is not', () => {
    const recent = card('Fix login', { minutesAgo: 23 * 60 + 59 })
    expect(findOpenDuplicate(getDb(), { title: 'fix login!', workspace: 'example' })?.id).toBe(recent)
    getDb().exec('DELETE FROM objectives')
    card('Fix login', { minutesAgo: 24 * 60 + 1 })
    expect(findOpenDuplicate(getDb(), { title: 'fix login!', workspace: 'example' })).toBeNull()
  })
  it('ignores done, cancelled and soft-deleted twins', () => {
    card('Fix login', { status: 'done' })
    card('Fix login', { status: 'cancelled' })
    card('Fix login', { deleted: true })
    expect(findOpenDuplicate(getDb(), { title: 'Fix login', workspace: 'example' })).toBeNull()
  })
  it('treats every open status as a twin (queue, working, review, ai_review, planning)', () => {
    for (const status of ['queue', 'working', 'review', 'ai_review', 'planning']) {
      getDb().exec('DELETE FROM objectives')
      const id = card('Fix login', { status })
      expect(findOpenDuplicate(getDb(), { title: 'Fix login', workspace: 'example' })?.id).toBe(id)
    }
  })
  it('a different workspace is not a twin', () => {
    card('Fix login', { workspace: 'example-project' })
    expect(findOpenDuplicate(getDb(), { title: 'Fix login', workspace: 'example' })).toBeNull()
  })
  it('honours excludeId / parent-child / routine exclusions and a status filter', () => {
    const parent = card('Fix login')
    expect(findOpenDuplicate(getDb(), { title: 'Fix login', workspace: 'example', excludeId: parent })).toBeNull()
    expect(findOpenDuplicate(getDb(), { title: 'Fix login', workspace: 'example', excludeParentId: parent })).toBeNull()
    const child = card('Fix login', { parent_id: parent })
    // The child is not a twin of its parent (excludeId = the parent → its children skipped).
    expect(findOpenDuplicate(getDb(), { title: 'Fix login', workspace: 'example', excludeId: parent })).toBeNull()
    getDb().prepare('DELETE FROM objectives WHERE id = ?').run(child)
    getDb().prepare('UPDATE objectives SET routine_id = 7 WHERE id = ?').run(parent)
    expect(findOpenDuplicate(getDb(), { title: 'Fix login', workspace: 'example', excludeRoutineId: 7 })).toBeNull()
    expect(findOpenDuplicate(getDb(), { title: 'Fix login', workspace: 'example', statuses: ['working'] })).toBeNull()
  })
  it('honours a configured window (settings over env)', () => {
    card('Fix login', { minutesAgo: 3 * 60 })
    getDb().prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('duplicate_guard_window_hours', '2')").run()
    expect(duplicateGuardWindowHours(getDb(), { CC_DUPLICATE_GUARD_WINDOW_HOURS: '48' } as NodeJS.ProcessEnv)).toBe(2)
    expect(findOpenDuplicate(getDb(), { title: 'Fix login', workspace: 'example' })).toBeNull()
    getDb().exec("DELETE FROM settings WHERE key = 'duplicate_guard_window_hours'")
    expect(duplicateGuardWindowHours(getDb(), { CC_DUPLICATE_GUARD_WINDOW_HOURS: '48' } as NodeJS.ProcessEnv)).toBe(48)
    expect(duplicateGuardWindowHours(getDb(), { CC_DUPLICATE_GUARD_WINDOW_HOURS: 'nope' } as NodeJS.ProcessEnv)).toBe(24)
  })
  it('handles ISO-8601 created_at rows', () => {
    const id = card('Fix login')
    getDb().prepare('UPDATE objectives SET created_at = ? WHERE id = ?').run(new Date(Date.now() - 60_000).toISOString(), id)
    expect(findOpenDuplicate(getDb(), { title: 'Fix login', workspace: 'example' })?.id).toBe(id)
  })
})

describe('kill switch', () => {
  it('defaults ON, settings off wins, env is the fallback', () => {
    expect(isDuplicateGuardEnabled(getDb(), {} as NodeJS.ProcessEnv)).toBe(true)
    expect(isDuplicateGuardEnabled(getDb(), { CC_DUPLICATE_GUARD_ENABLED: '0' } as NodeJS.ProcessEnv)).toBe(false)
    getDb().prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('duplicate_guard_enabled', '0')").run()
    expect(isDuplicateGuardEnabled(getDb(), {} as NodeJS.ProcessEnv)).toBe(false)
    getDb().prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('duplicate_guard_enabled', '1')").run()
    expect(isDuplicateGuardEnabled(getDb(), { CC_DUPLICATE_GUARD_ENABLED: '0' } as NodeJS.ProcessEnv)).toBe(true)
  })
})

describe('findRunningTwinForStart', () => {
  it('only a queued, non-routine card with a WORKING/ai_review twin', () => {
    const twin = card('Fix login', { status: 'working' })
    const mine = card('Fix login (2)')
    const row = getDb().prepare('SELECT * FROM objectives WHERE id = ?').get(mine) as never
    expect(findRunningTwinForStart(getDb(), row)?.id).toBe(twin)
    // Twin merely queued → not running → allowed.
    getDb().prepare("UPDATE objectives SET status = 'queue' WHERE id = ?").run(twin)
    expect(findRunningTwinForStart(getDb(), row)).toBeNull()
    getDb().prepare("UPDATE objectives SET status = 'ai_review' WHERE id = ?").run(twin)
    expect(findRunningTwinForStart(getDb(), row)?.id).toBe(twin)
    // Routine card / non-queue card → exempt.
    expect(findRunningTwinForStart(getDb(), { ...(row as object), routine_id: 3 } as never)).toBeNull()
    expect(findRunningTwinForStart(getDb(), { ...(row as object), status: 'review' } as never)).toBeNull()
  })
})

describe('recordDedupe', () => {
  it('writes an activity_log decision row with metadata.kind', () => {
    const existing = card('Fix login')
    recordDedupe({ event: 'duplicate_refused', source: 'test', title: 'Fix login', workspace: 'example', existingId: existing })
    const row = getDb().prepare('SELECT event_type, metadata FROM activity_log ORDER BY id DESC LIMIT 1').get() as { event_type: string; metadata: string }
    expect(row.event_type).toBe('decision')
    expect(JSON.parse(row.metadata)).toMatchObject({ kind: 'duplicate_refused', source: 'test', existing_id: existing, normalized_title: 'fix login' })
  })
})
