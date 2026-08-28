import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import {
  selectOrphanedQueueChildren,
  selectAutoAcceptCandidates,
  buildHygieneDigest,
} from './state-poller.js'

// obj 700595 — the board-hygiene sweep SELECTION guardrails, tested against an
// in-memory DB WITHOUT spawning any session. These lock:
//  1b  never selects working rows; never selects manual (parent_id NULL /
//      origin='manual') queue cards; only past the TTL; only a LIVE delegator parent.
//  2a  advances review+verdict=pass past TTL; DELIBERATELY excludes verdict IS NULL.
//  2b/2c digest surfaces stale review (verdict=null) + stale manual queue; does NOT
//      auto-close by default; hard-expiry only mutates when the flag arg is true.

function freshDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE objectives (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'queue',
      parent_id INTEGER,
      origin TEXT NOT NULL DEFAULT 'manual',
      session_count INTEGER NOT NULL DEFAULT 0,
      session_id TEXT,
      delegate_mode INTEGER NOT NULL DEFAULT 0,
      ai_review_verdict TEXT,
      workspace TEXT,
      project TEXT,
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

// insert with an explicit age in days (updated_at = now - ageDays)
function insert(db: Database.Database, row: Record<string, unknown>, ageDays = 0): number {
  const cols = Object.keys(row)
  const placeholders = cols.map((c) => (c === 'updated_at' ? c : '?'))
  const stmt = db.prepare(
    `INSERT INTO objectives (${cols.join(',')}, updated_at)
       VALUES (${cols.map(() => '?').join(',')}, datetime('now', ?))`,
  )
  return Number(stmt.run(...cols.map((c) => row[c]), `-${ageDays} days`).lastInsertRowid)
}

describe('selectOrphanedQueueChildren (1b guardrails)', () => {
  let db: Database.Database
  let liveDelegator: number
  beforeEach(() => {
    db = freshDb()
    liveDelegator = insert(db, { title: 'delegator', status: 'working', delegate_mode: 1, origin: 'strategy' })
  })

  it('selects a stale queue child of a live delegator', () => {
    const child = insert(db, { title: 'child', status: 'queue', parent_id: liveDelegator, session_count: 0, origin: 'strategy' }, 5)
    const rows = selectOrphanedQueueChildren(db, 3)
    expect(rows.map((r) => r.id)).toEqual([child])
  })

  it('NEVER selects a working row', () => {
    insert(db, { title: 'working-child', status: 'working', parent_id: liveDelegator, session_count: 0, origin: 'strategy' }, 5)
    expect(selectOrphanedQueueChildren(db, 3)).toHaveLength(0)
  })

  it('NEVER selects a manual top-level (parent_id NULL) queue card', () => {
    insert(db, { title: 'manual-card', status: 'queue', parent_id: null, session_count: 0, origin: 'manual' }, 30)
    expect(selectOrphanedQueueChildren(db, 3)).toHaveLength(0)
  })

  it("NEVER selects an origin='manual' child even if parented", () => {
    insert(db, { title: 'manual-child', status: 'queue', parent_id: liveDelegator, session_count: 0, origin: 'manual' }, 30)
    expect(selectOrphanedQueueChildren(db, 3)).toHaveLength(0)
  })

  it('NEVER selects a child younger than the TTL', () => {
    insert(db, { title: 'fresh', status: 'queue', parent_id: liveDelegator, session_count: 0, origin: 'strategy' }, 1)
    expect(selectOrphanedQueueChildren(db, 3)).toHaveLength(0)
  })

  it('NEVER selects a child whose parent is NOT a live working delegator', () => {
    const doneParent = insert(db, { title: 'done-parent', status: 'done', delegate_mode: 1 })
    insert(db, { title: 'stranded', status: 'queue', parent_id: doneParent, session_count: 0, origin: 'strategy' }, 10)
    expect(selectOrphanedQueueChildren(db, 3)).toHaveLength(0)
  })

  it('NEVER selects a child that produced work (session_count>0)', () => {
    insert(db, { title: 'ran', status: 'queue', parent_id: liveDelegator, session_count: 1, origin: 'strategy' }, 10)
    expect(selectOrphanedQueueChildren(db, 3)).toHaveLength(0)
  })
})

describe('selectAutoAcceptCandidates (2a — excludes verdict NULL)', () => {
  let db: Database.Database
  beforeEach(() => { db = freshDb() })

  it('selects review + verdict=pass past the TTL', () => {
    const id = insert(db, { title: 'passed', status: 'review', ai_review_verdict: 'pass' }, 3)
    expect(selectAutoAcceptCandidates(db, 1).map((r) => r.id)).toEqual([id])
  })

  it('DELIBERATELY excludes verdict IS NULL', () => {
    insert(db, { title: 'null-verdict', status: 'review', ai_review_verdict: null }, 30)
    expect(selectAutoAcceptCandidates(db, 1)).toHaveLength(0)
  })

  it('excludes verdict=blocked/fail', () => {
    insert(db, { title: 'blocked', status: 'review', ai_review_verdict: 'blocked' }, 30)
    insert(db, { title: 'fail', status: 'review', ai_review_verdict: 'fail' }, 30)
    expect(selectAutoAcceptCandidates(db, 1)).toHaveLength(0)
  })

  it('excludes a pass row younger than the TTL', () => {
    insert(db, { title: 'fresh-pass', status: 'review', ai_review_verdict: 'pass' }, 0)
    expect(selectAutoAcceptCandidates(db, 1)).toHaveLength(0)
  })

  it('excludes a non-review status even with verdict=pass', () => {
    insert(db, { title: 'done-pass', status: 'done', ai_review_verdict: 'pass' }, 30)
    expect(selectAutoAcceptCandidates(db, 1)).toHaveLength(0)
  })
})

describe('buildHygieneDigest (2b/2c — no silent auto-close)', () => {
  let db: Database.Database
  beforeEach(() => { db = freshDb() })

  const opts = (applyHardExpiry: boolean) => ({
    reviewStaleDays: 7,
    queueStaleDays: 3,
    hardExpiryDays: 30,
    applyHardExpiry,
    nowIso: '2026-07-02T00:00:00.000Z',
  })

  it('surfaces stale verdict=null review + stale manual queue WITHOUT closing them (flag OFF)', () => {
    const staleReview = insert(db, { title: 'old-review', status: 'review', ai_review_verdict: null }, 40)
    const staleQueue = insert(db, { title: 'old-manual', status: 'queue', parent_id: null }, 10)
    const d = buildHygieneDigest(db, opts(false))
    expect(d.staleReviewCount).toBe(1)
    expect(d.staleQueueCount).toBe(1)
    expect(d.hardExpiredIds).toEqual([])
    // NOT closed — still review/queue
    expect((db.prepare('SELECT status FROM objectives WHERE id=?').get(staleReview) as { status: string }).status).toBe('review')
    expect((db.prepare('SELECT status FROM objectives WHERE id=?').get(staleQueue) as { status: string }).status).toBe('queue')
    expect(d.markdown).toContain('DISABLED (digest-only)')
  })

  it('does NOT surface a manual queue card that has a parent (that is a delegator child, not manual holding)', () => {
    insert(db, { title: 'child-queue', status: 'queue', parent_id: 999 }, 10)
    expect(buildHygieneDigest(db, opts(false)).staleQueueCount).toBe(0)
  })

  it('hard-expiry (flag ON) soft-closes verdict=null review >30d to done AND lists them', () => {
    const expired = insert(db, { title: 'ancient', status: 'review', ai_review_verdict: null }, 40)
    const recent = insert(db, { title: 'recent-null', status: 'review', ai_review_verdict: null }, 10)
    const d = buildHygieneDigest(db, opts(true))
    expect(d.hardExpiredIds).toEqual([expired])
    expect((db.prepare('SELECT status FROM objectives WHERE id=?').get(expired) as { status: string }).status).toBe('done')
    // the 10-day-old one is past the 7d digest threshold but NOT past 30d hard-expiry → still review
    expect((db.prepare('SELECT status FROM objectives WHERE id=?').get(recent) as { status: string }).status).toBe('review')
    expect(d.markdown).toContain(`#${expired} → done (review-hard-expiry)`)
    // audited
    const audit = db.prepare("SELECT * FROM objective_audit WHERE objective_id=? AND pathway='review-hard-expiry'").get(expired)
    expect(audit).toBeTruthy()
  })

  it('hard-expiry NEVER touches a verdict=pass review row (only verdict=null)', () => {
    const passRow = insert(db, { title: 'pass-ancient', status: 'review', ai_review_verdict: 'pass' }, 40)
    const d = buildHygieneDigest(db, opts(true))
    expect(d.hardExpiredIds).toEqual([])
    expect((db.prepare('SELECT status FROM objectives WHERE id=?').get(passRow) as { status: string }).status).toBe('review')
  })
})
