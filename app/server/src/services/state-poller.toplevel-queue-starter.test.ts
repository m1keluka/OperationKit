import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { selectTopLevelQueueStarterCandidates } from './state-poller.js'
import {
  isTopLevelQueueStarterEnabled,
  topLevelQueueStarterCategories,
  topLevelQueueStarterTickCap,
  topLevelQueueStarterGraceMinutes,
} from '../lib/hygiene-config.js'

// obj 701663 — the top-level queue starter SELECTION guardrails, tested against an
// in-memory DB WITHOUT spawning any session. These lock the fix for the 14-day
// distill apply-loop stall while proving the allowlist can NEVER auto-start an
// arbitrary user card (acceptance #3):
//  - selects a stranded top-level bulk-route platform card past the grace window
//  - NEVER a manual card, a routine run, a general-category (PRD backlog) card,
//    a delegator CHILD (parent_id set), a card that already ran, a deleted row,
//    or a working/review/done row, or one inside the grace window.

function freshDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE objectives (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'queue',
      parent_id INTEGER,
      origin TEXT NOT NULL DEFAULT 'manual',
      category TEXT NOT NULL DEFAULT 'general',
      session_count INTEGER NOT NULL DEFAULT 0,
      session_id TEXT,
      deleted_at TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `)
  return db
}

// insert with an explicit age in minutes (updated_at = now - ageMin)
function insert(db: Database.Database, row: Record<string, unknown>, ageMin = 60): number {
  const cols = Object.keys(row)
  const stmt = db.prepare(
    `INSERT INTO objectives (${cols.join(',')}, updated_at)
       VALUES (${cols.map(() => '?').join(',')}, datetime('now', ?))`,
  )
  return Number(stmt.run(...cols.map((c) => row[c]), `-${ageMin} minutes`).lastInsertRowid)
}

const CATS = ['platform']
const GRACE = 2

describe('selectTopLevelQueueStarterCandidates (obj 701663 guardrails)', () => {
  let db: Database.Database
  beforeEach(() => {
    db = freshDb()
  })

  it('selects a stranded top-level bulk-route platform card (job_reply)', () => {
    const id = insert(db, { title: 'distill review', status: 'queue', parent_id: null, origin: 'job_reply', category: 'platform', session_count: 0 })
    expect(selectTopLevelQueueStarterCandidates(db, CATS, GRACE).map((r) => r.id)).toEqual([id])
  })

  it('selects a strategy-origin platform card too', () => {
    const id = insert(db, { title: 'strategy card', status: 'queue', parent_id: null, origin: 'strategy', category: 'platform', session_count: 0 })
    expect(selectTopLevelQueueStarterCandidates(db, CATS, GRACE).map((r) => r.id)).toEqual([id])
  })

  it("NEVER selects a manual card (origin='manual')", () => {
    insert(db, { title: 'manual', status: 'queue', parent_id: null, origin: 'manual', category: 'platform', session_count: 0 })
    expect(selectTopLevelQueueStarterCandidates(db, CATS, GRACE)).toHaveLength(0)
  })

  it("NEVER selects a routine run (origin='routine')", () => {
    insert(db, { title: 'routine', status: 'queue', parent_id: null, origin: 'routine', category: 'platform', session_count: 0 })
    expect(selectTopLevelQueueStarterCandidates(db, CATS, GRACE)).toHaveLength(0)
  })

  it('NEVER selects a general-category card (PRD backlog is excluded)', () => {
    insert(db, { title: 'prd backlog', status: 'queue', parent_id: null, origin: 'strategy', category: 'general', session_count: 0 })
    expect(selectTopLevelQueueStarterCandidates(db, CATS, GRACE)).toHaveLength(0)
  })

  it('NEVER selects a delegator CHILD (parent_id set)', () => {
    insert(db, { title: 'child', status: 'queue', parent_id: 999, origin: 'strategy', category: 'platform', session_count: 0 })
    expect(selectTopLevelQueueStarterCandidates(db, CATS, GRACE)).toHaveLength(0)
  })

  it('NEVER selects a card that already produced work (session_count>0)', () => {
    insert(db, { title: 'ran', status: 'queue', parent_id: null, origin: 'job_reply', category: 'platform', session_count: 1 })
    expect(selectTopLevelQueueStarterCandidates(db, CATS, GRACE)).toHaveLength(0)
  })

  it('NEVER selects a working/review/done row', () => {
    for (const status of ['working', 'review', 'done']) {
      insert(db, { title: status, status, parent_id: null, origin: 'job_reply', category: 'platform', session_count: 0 })
    }
    expect(selectTopLevelQueueStarterCandidates(db, CATS, GRACE)).toHaveLength(0)
  })

  it('NEVER selects a soft-deleted row', () => {
    insert(db, { title: 'deleted', status: 'queue', parent_id: null, origin: 'job_reply', category: 'platform', session_count: 0, deleted_at: '2026-07-01' })
    expect(selectTopLevelQueueStarterCandidates(db, CATS, GRACE)).toHaveLength(0)
  })

  it('NEVER selects a card still inside the grace window', () => {
    insert(db, { title: 'fresh', status: 'queue', parent_id: null, origin: 'job_reply', category: 'platform', session_count: 0 }, 1) // 1 min old, grace 2
    expect(selectTopLevelQueueStarterCandidates(db, CATS, GRACE)).toHaveLength(0)
  })

  it('honors a broadened category allowlist', () => {
    const id = insert(db, { title: 'ops', status: 'queue', parent_id: null, origin: 'strategy', category: 'ops', session_count: 0 })
    expect(selectTopLevelQueueStarterCandidates(db, ['platform'], GRACE)).toHaveLength(0)
    expect(selectTopLevelQueueStarterCandidates(db, ['platform', 'ops'], GRACE).map((r) => r.id)).toEqual([id])
  })

  it('orders oldest-first', () => {
    const newer = insert(db, { title: 'newer', status: 'queue', parent_id: null, origin: 'job_reply', category: 'platform', session_count: 0 }, 10)
    const older = insert(db, { title: 'older', status: 'queue', parent_id: null, origin: 'strategy', category: 'platform', session_count: 0 }, 100)
    expect(selectTopLevelQueueStarterCandidates(db, CATS, GRACE).map((r) => r.id)).toEqual([older, newer])
  })
})

describe('top-level queue starter config helpers (obj 701663)', () => {
  it('is ON by default', () => {
    const db = freshDb()
    // no settings table needed — helper swallows the missing-table error and stays ON
    expect(isTopLevelQueueStarterEnabled(db, {})).toBe(true)
  })

  it('env CC_TOPLEVEL_QUEUE_STARTER=0 kills it', () => {
    const db = freshDb()
    expect(isTopLevelQueueStarterEnabled(db, { CC_TOPLEVEL_QUEUE_STARTER: '0' })).toBe(false)
    expect(isTopLevelQueueStarterEnabled(db, { CC_TOPLEVEL_QUEUE_STARTER: 'off' })).toBe(false)
  })

  it('settings toplevel_queue_starter_enabled=0 kills it', () => {
    const db = new Database(':memory:')
    db.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)")
    db.prepare("INSERT INTO settings (key,value) VALUES ('toplevel_queue_starter_enabled','0')").run()
    expect(isTopLevelQueueStarterEnabled(db, {})).toBe(false)
    db.prepare("UPDATE settings SET value='1' WHERE key='toplevel_queue_starter_enabled'").run()
    expect(isTopLevelQueueStarterEnabled(db, {})).toBe(true)
  })

  it('default category allowlist is [platform]; env override parses CSV', () => {
    expect(topLevelQueueStarterCategories({})).toEqual(['platform'])
    expect(topLevelQueueStarterCategories({ CC_TOPLEVEL_QUEUE_STARTER_CATEGORIES: 'platform, ops , infra' }))
      .toEqual(['platform', 'ops', 'infra'])
  })

  it('tick cap and grace have sane defaults', () => {
    expect(topLevelQueueStarterTickCap({})).toBe(5)
    expect(topLevelQueueStarterGraceMinutes({})).toBe(2)
    expect(topLevelQueueStarterTickCap({ CC_TOPLEVEL_QUEUE_STARTER_TICK_CAP: '3' })).toBe(3)
  })
})
