import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'

// Server-side writers for the accountability record (obj 900367, Stage 1).
// Private in-memory DB with a minimal `objectives` table — the schema module
// adds its own columns, which is exactly the migration path under test.
const {
  AccountabilityError,
  classifyObjective,
  getAccountability,
  isStepAdvance,
  MEANINGFUL_EVENT_CLASSES,
  recordMeaningfulProgress,
  setAccountability,
  stalledWindowMinutes,
} = await import('./accountability.js')
const { initAccountabilitySchema } = await import('../db/schema/accountability.js')

const NOW = new Date('2026-11-09T12:00:00.000Z')
let db: Database.Database

beforeEach(() => {
  db = new Database(':memory:')
  db.exec(`
    CREATE TABLE objectives (
      id INTEGER PRIMARY KEY, title TEXT, status TEXT NOT NULL DEFAULT 'working',
      workspace TEXT, session_id TEXT, has_blockers INTEGER NOT NULL DEFAULT 0,
      blocked_reason TEXT, ai_review_verdict TEXT, needs_secret TEXT,
      updated_at TEXT
    );
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
  `)
  db.prepare("INSERT INTO objectives (id, title, status) VALUES (1, 'card', 'working')").run()
  initAccountabilitySchema(db)
})

describe('migration', () => {
  it('adds the four accountability columns plus the terminal reason', () => {
    const cols = new Set((db.prepare('PRAGMA table_info(objectives)').all() as { name: string }[]).map((c) => c.name))
    for (const c of ['next_action', 'next_check_at', 'waiting_on', 'last_meaningful_progress_at', 'terminal_reason']) {
      expect(cols.has(c)).toBe(true)
    }
  })

  it('is idempotent — a second run is a no-op', () => {
    expect(() => initAccountabilitySchema(db)).not.toThrow()
    expect(() => initAccountabilitySchema(db)).not.toThrow()
  })

  it('is a no-op on a DB with no objectives table, and still creates the queue tables', () => {
    const bare = new Database(':memory:')
    expect(() => initAccountabilitySchema(bare)).not.toThrow()
    expect(bare.prepare("SELECT name FROM sqlite_master WHERE name = 'review_items'").get()).toBeTruthy()
  })

  it('leaves every pre-existing row NULL rather than back-dating it', () => {
    // We do not know when those cards last really progressed; inventing a value
    // would manufacture a fact the classifier would then act on.
    expect(getAccountability(db, 1)).toEqual({
      next_action: null, next_check_at: null, waiting_on: null,
      last_meaningful_progress_at: null, terminal_reason: null,
    })
  })
})

describe('setAccountability — the DECLARED fields', () => {
  it('writes only the keys present, leaving the others alone', () => {
    setAccountability(db, 1, { next_action: 'Open the PR', waiting_on: 'human:operator' })
    setAccountability(db, 1, { next_action: 'Push the branch' })
    const rec = getAccountability(db, 1)!
    expect(rec.next_action).toBe('Push the branch')
    expect(rec.waiting_on).toBe('human:operator')
  })

  it('clears a field on an explicit null', () => {
    setAccountability(db, 1, { waiting_on: 'ci:601' })
    setAccountability(db, 1, { waiting_on: null })
    expect(getAccountability(db, 1)!.waiting_on).toBeNull()
  })

  it('normalizes waiting_on through the typed parser', () => {
    setAccountability(db, 1, { waiting_on: '  HUMAN:operator  ' })
    expect(getAccountability(db, 1)!.waiting_on).toBe('human:operator')
    setAccountability(db, 1, { waiting_on: { party: 'secret', name: 'APIFY_API_TOKEN' } })
    expect(getAccountability(db, 1)!.waiting_on).toBe('secret:APIFY_API_TOKEN')
  })

  it('normalizes next_check_at to ISO and rejects garbage', () => {
    setAccountability(db, 1, { next_check_at: '2026-11-10T09:00:00Z' })
    expect(getAccountability(db, 1)!.next_check_at).toBe('2026-11-10T09:00:00.000Z')
    expect(() => setAccountability(db, 1, { next_check_at: 'tomorrow-ish' })).toThrow(AccountabilityError)
  })

  it('refuses an untyped terminal reason', () => {
    // A typo'd reason reads as "somebody said why" while meaning nothing.
    expect(() => setAccountability(db, 1, { terminal_reason: 'all done' })).toThrow(AccountabilityError)
    setAccountability(db, 1, { terminal_reason: 'delivered_merged' })
    expect(getAccountability(db, 1)!.terminal_reason).toBe('delivered_merged')
  })

  it('cannot set last_meaningful_progress_at — only the server writes it', () => {
    setAccountability(db, 1, { last_meaningful_progress_at: '2030-01-01T00:00:00Z' } as never)
    expect(getAccountability(db, 1)!.last_meaningful_progress_at).toBeNull()
  })
})

describe('recordMeaningfulProgress — the SERVER field', () => {
  it('stamps only for an allowlisted event class', () => {
    expect(recordMeaningfulProgress(db, 1, 'status_flicker', NOW, NOW)).toBeNull()
    expect(getAccountability(db, 1)!.last_meaningful_progress_at).toBeNull()
    for (const cls of MEANINGFUL_EVENT_CLASSES) {
      expect(recordMeaningfulProgress(db, 1, cls, NOW, NOW)).toBe(NOW.toISOString())
    }
  })

  it('never moves the stamp backwards on an out-of-order event', () => {
    recordMeaningfulProgress(db, 1, 'commit', NOW, NOW)
    const earlier = new Date(NOW.getTime() - 60 * 60_000)
    expect(recordMeaningfulProgress(db, 1, 'commit', earlier, NOW)).toBe(NOW.toISOString())
  })

  it('clamps a future stamp to now — a card cannot make itself permanently fresh', () => {
    const future = new Date(NOW.getTime() + 10 * 24 * 3600_000)
    expect(recordMeaningfulProgress(db, 1, 'commit', future, NOW)).toBe(NOW.toISOString())
  })
})

describe('isStepAdvance', () => {
  it('counts only an advancing step', () => {
    expect(isStepAdvance(null, 1)).toBe(true)   // first snapshot
    expect(isStepAdvance(2, 3)).toBe(true)
    expect(isStepAdvance(3, 3)).toBe(false)     // narrating, not progressing
    expect(isStepAdvance(3, 2)).toBe(false)
    expect(isStepAdvance(2, null)).toBe(false)  // no step at all
  })
})

describe('stalledWindowMinutes', () => {
  it('is OFF until a human sets it (design §10 M3)', () => {
    expect(stalledWindowMinutes(db)).toBeNull()
    db.prepare("INSERT INTO settings (key, value) VALUES ('accountability_stalled_after_minutes', '0')").run()
    expect(stalledWindowMinutes(db)).toBeNull()
    db.prepare("UPDATE settings SET value = '90' WHERE key = 'accountability_stalled_after_minutes'").run()
    expect(stalledWindowMinutes(db)).toBe(90)
  })

  it('survives a DB with no settings table', () => {
    const bare = new Database(':memory:')
    expect(stalledWindowMinutes(bare)).toBeNull()
  })
})

describe('classifyObjective — read side', () => {
  it('reports the record and the server verdict together', () => {
    setAccountability(db, 1, { next_action: 'Await CI', waiting_on: 'ci:601', next_check_at: '2026-11-09T13:00:00Z' })
    const view = classifyObjective(db, 1, NOW)!
    expect(view.objective_id).toBe(1)
    expect(view.next_action).toBe('Await CI')
    expect(view.verdict.state).toBe('waiting')
    expect(view.verdict.needs_human).toBe(false)
  })

  it('will not call a card stalled until the window is configured', () => {
    db.prepare("UPDATE objectives SET updated_at = '2020-01-01T00:00:00Z' WHERE id = 1").run()
    expect(classifyObjective(db, 1, NOW)!.verdict.state).toBe('on_track')
    db.prepare("INSERT INTO settings (key, value) VALUES ('accountability_stalled_after_minutes', '60')").run()
    expect(classifyObjective(db, 1, NOW)!.verdict.state).toBe('stalled')
  })

  it('returns null for a card that does not exist', () => {
    expect(classifyObjective(db, 404, NOW)).toBeNull()
  })
})
