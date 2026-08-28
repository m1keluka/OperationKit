import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { isLockedStatus, skipMachineStatusWrite, runMachineStatusUpdate } from './status-lock.js'

describe('isLockedStatus', () => {
  it('locks done and cancelled only', () => {
    expect(isLockedStatus('done')).toBe(true)
    expect(isLockedStatus('cancelled')).toBe(true)
    expect(isLockedStatus('working')).toBe(false)
    expect(isLockedStatus('review')).toBe(false)
    expect(isLockedStatus(null)).toBe(false)
  })
})

describe('skipMachineStatusWrite', () => {
  let db: Database.Database
  beforeEach(() => {
    db = new Database(':memory:')
    db.exec(`CREATE TABLE objectives (id INTEGER PRIMARY KEY, status TEXT NOT NULL)`)
  })
  it('skips missing rows, done, and cancelled', () => {
    expect(skipMachineStatusWrite(db, 1)).toBe(true)
    db.prepare("INSERT INTO objectives (id, status) VALUES (1, 'done')").run()
    expect(skipMachineStatusWrite(db, 1)).toBe(true)
    db.prepare("UPDATE objectives SET status = 'cancelled' WHERE id = 1").run()
    expect(skipMachineStatusWrite(db, 1)).toBe(true)
  })
  it('allows working/review', () => {
    db.prepare("INSERT INTO objectives (id, status) VALUES (2, 'working')").run()
    expect(skipMachineStatusWrite(db, 2)).toBe(false)
    db.prepare("UPDATE objectives SET status = 'review' WHERE id = 2").run()
    expect(skipMachineStatusWrite(db, 2)).toBe(false)
  })
})

describe('runMachineStatusUpdate', () => {
  let db: Database.Database
  beforeEach(() => {
    db = new Database(':memory:')
    db.exec(`CREATE TABLE objectives (id INTEGER PRIMARY KEY, status TEXT NOT NULL, session_id TEXT, updated_at TEXT)`)
  })

  it('writes working → review', () => {
    db.prepare("INSERT INTO objectives (id, status) VALUES (1, 'working')").run()
    const result = runMachineStatusUpdate(
      db,
      "UPDATE objectives SET status = 'review', updated_at = datetime('now') WHERE id = ?",
      1,
    )
    expect(result.changes).toBe(1)
    expect((db.prepare('SELECT status FROM objectives WHERE id = 1').get() as { status: string }).status).toBe('review')
  })

  it('refuses to clobber done (the board-bounce bug)', () => {
    db.prepare("INSERT INTO objectives (id, status) VALUES (1, 'done')").run()
    const result = runMachineStatusUpdate(
      db,
      "UPDATE objectives SET status = 'review', updated_at = datetime('now') WHERE id = ?",
      1,
    )
    expect(result.changes).toBe(0)
    expect((db.prepare('SELECT status FROM objectives WHERE id = 1').get() as { status: string }).status).toBe('done')
  })

  it('refuses to clobber cancelled', () => {
    db.prepare("INSERT INTO objectives (id, status) VALUES (1, 'cancelled')").run()
    const result = runMachineStatusUpdate(
      db,
      "UPDATE objectives SET status = 'working', session_id = ? WHERE id = ?",
      'cc-1',
      1,
    )
    expect(result.changes).toBe(0)
    const row = db.prepare('SELECT status, session_id FROM objectives WHERE id = 1').get() as {
      status: string
      session_id: string | null
    }
    expect(row.status).toBe('cancelled')
    expect(row.session_id).toBeNull()
  })

  it('throws when SQL has no WHERE id = ?', () => {
    db.prepare("INSERT INTO objectives (id, status) VALUES (1, 'working')").run()
    expect(() =>
      runMachineStatusUpdate(db, "UPDATE objectives SET status = 'review'", 1),
    ).toThrow(/WHERE id/)
  })
})
