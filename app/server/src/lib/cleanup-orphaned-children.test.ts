import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { cleanupOrphanedChildrenOnParentTerminal } from './cleanup-orphaned-children.js'

// obj 700595, FIX 1a — when a parent reaches a terminal state, its still-queued,
// never-ran children must be RETIRED to `cancelled` (not stranded, not falsely
// `done`). These lock the guardrails: only queue + session_count=0 children of
// THIS parent, never a child that produced work, idempotent, audit-logged.

function freshDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE objectives (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'queue',
      parent_id INTEGER,
      session_count INTEGER NOT NULL DEFAULT 0,
      session_id TEXT,
      workspace TEXT,
      deleted_at TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE objective_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      objective_id INTEGER, event_type TEXT, from_status TEXT, to_status TEXT,
      actor TEXT, pathway TEXT, session_id TEXT, title_snapshot TEXT, workspace TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `)
  return db
}

function insert(db: Database.Database, row: Record<string, unknown>): number {
  const cols = Object.keys(row)
  const stmt = db.prepare(
    `INSERT INTO objectives (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`,
  )
  return Number(stmt.run(...cols.map((c) => row[c])).lastInsertRowid)
}

const statusOf = (db: Database.Database, id: number) =>
  (db.prepare('SELECT status FROM objectives WHERE id = ?').get(id) as { status: string }).status

describe('cleanupOrphanedChildrenOnParentTerminal', () => {
  let db: Database.Database
  let parentId: number
  beforeEach(() => {
    db = freshDb()
    parentId = insert(db, { title: 'parent', status: 'done' })
  })

  it('retires a never-ran queued child to cancelled + audits it', () => {
    const child = insert(db, { title: 'orphan', status: 'queue', parent_id: parentId, session_count: 0 })
    const res = cleanupOrphanedChildrenOnParentTerminal(db, parentId)
    expect(res.cancelledIds).toEqual([child])
    expect(statusOf(db, child)).toBe('cancelled')
    const audit = db.prepare('SELECT * FROM objective_audit WHERE objective_id = ?').get(child) as Record<string, unknown>
    expect(audit).toMatchObject({ to_status: 'cancelled', pathway: 'orphan-child-cleanup-on-parent-terminal', from_status: 'queue' })
  })

  it('NEVER touches a child that produced work (session_count > 0)', () => {
    const ran = insert(db, { title: 'ran', status: 'queue', parent_id: parentId, session_count: 2 })
    const res = cleanupOrphanedChildrenOnParentTerminal(db, parentId)
    expect(res.cancelledIds).toEqual([])
    expect(statusOf(db, ran)).toBe('queue')
  })

  it('NEVER touches a non-queue child (working/review/done)', () => {
    const w = insert(db, { title: 'w', status: 'working', parent_id: parentId, session_count: 0 })
    const r = insert(db, { title: 'r', status: 'review', parent_id: parentId, session_count: 0 })
    const res = cleanupOrphanedChildrenOnParentTerminal(db, parentId)
    expect(res.cancelledIds).toEqual([])
    expect(statusOf(db, w)).toBe('working')
    expect(statusOf(db, r)).toBe('review')
  })

  it('NEVER touches children of a DIFFERENT parent', () => {
    const other = insert(db, { title: 'other', status: 'done' })
    const otherChild = insert(db, { title: 'oc', status: 'queue', parent_id: other, session_count: 0 })
    cleanupOrphanedChildrenOnParentTerminal(db, parentId)
    expect(statusOf(db, otherChild)).toBe('queue')
  })

  it('is idempotent — a second run retires nothing (deleted rows already skipped / status changed)', () => {
    const child = insert(db, { title: 'orphan', status: 'queue', parent_id: parentId, session_count: 0 })
    cleanupOrphanedChildrenOnParentTerminal(db, parentId)
    const res2 = cleanupOrphanedChildrenOnParentTerminal(db, parentId)
    expect(res2.cancelledIds).toEqual([])
    expect(statusOf(db, child)).toBe('cancelled')
  })

  it('does NOT retire children when the parent only landed in review', () => {
    const child = insert(db, { title: 'keep', status: 'queue', parent_id: parentId, session_count: 0 })
    const res = cleanupOrphanedChildrenOnParentTerminal(db, parentId, undefined, 'review')
    expect(res.cancelledIds).toEqual([])
    expect(statusOf(db, child)).toBe('queue')
  })

  it('broadcasts an objective_updated per retired child when a broadcaster is given', () => {
    insert(db, { title: 'orphan', status: 'queue', parent_id: parentId, session_count: 0 })
    const events: unknown[] = []
    cleanupOrphanedChildrenOnParentTerminal(db, parentId, (msg) => events.push(msg))
    expect(events).toHaveLength(1)
    expect((events[0] as { type: string }).type).toBe('objective_updated')
  })
})
