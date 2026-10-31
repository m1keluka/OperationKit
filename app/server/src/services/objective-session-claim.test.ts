import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import Database from 'better-sqlite3'

// One live session per card (obj 715699): claimObjectiveSession over the DB-level
// identity lease, including a cross-CONNECTION double start on one DB file.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-session-claim-'))
const DB_FILE = path.join(TMP, 'db.sqlite')
process.env.DB_PATH = DB_FILE
process.env.JWT_SECRET = 'test-secret-claim'
process.env.TRANSCRIPT_DIR = TMP

const { getDb, initDb } = await import('../db/index.js')
const { claimObjectiveSession } = await import('./objective-session-claim.js')
const { ensureSessionLeaseTable, getSessionLease, identityLeaseKey, releaseSessionLeasesForObjective } = await import('./session-lease.js')

const alive = () => true
const dead = () => false

beforeAll(() => {
  initDb()
})
afterAll(() => {
  try { getDb().close() } catch { /* ignore */ }
  fs.rmSync(TMP, { recursive: true, force: true })
})

describe('claimObjectiveSession — single connection', () => {
  it('first claim wins; a second session id attaches to the first', () => {
    const db = getDb()
    const a = claimObjectiveSession(db, 101, 'cc-101-a', alive)
    expect(a).toEqual({ outcome: 'claimed', sessionId: 'cc-101-a' })
    const b = claimObjectiveSession(db, 101, 'cc-101-b', alive)
    expect(b.outcome).toBe('attach')
    expect(b.sessionId).toBe('cc-101-a')
    expect(getSessionLease(db, identityLeaseKey(101))!.session_id).toBe('cc-101-a')
  })

  it('the same session id re-claiming is claimed (resume in place)', () => {
    const db = getDb()
    claimObjectiveSession(db, 102, 'cc-102-a', alive)
    expect(claimObjectiveSession(db, 102, 'cc-102-a', alive)).toEqual({ outcome: 'claimed', sessionId: 'cc-102-a' })
  })

  it('isAlive is consulted with the holder id; a dead holder is taken over', () => {
    const db = getDb()
    claimObjectiveSession(db, 103, 'cc-103-a', alive)
    const asked: string[] = []
    const r = claimObjectiveSession(db, 103, 'cc-103-b', id => { asked.push(id); return dead() })
    expect(asked).toEqual(['cc-103-a'])
    expect(r).toEqual({ outcome: 'claimed', sessionId: 'cc-103-b' })
    const lease = getSessionLease(db, identityLeaseKey(103))!
    expect(lease.session_id).toBe('cc-103-b')
    expect(lease.released_at).toBeNull()
    // And the new holder now blocks the old one.
    expect(claimObjectiveSession(db, 103, 'cc-103-a', alive)).toMatchObject({ outcome: 'attach', sessionId: 'cc-103-b' })
  })

  it('a released lease is claimable by a new session', () => {
    const db = getDb()
    claimObjectiveSession(db, 104, 'cc-104-a', alive)
    releaseSessionLeasesForObjective(db, 104)
    expect(claimObjectiveSession(db, 104, 'cc-104-b', alive)).toEqual({ outcome: 'claimed', sessionId: 'cc-104-b' })
    expect(getSessionLease(db, identityLeaseKey(104))!.session_id).toBe('cc-104-b')
  })

  it('a stale (heartbeat past TTL) lease is claimable without consulting isAlive', () => {
    const db = getDb()
    claimObjectiveSession(db, 105, 'cc-105-a', alive)
    db.prepare("UPDATE session_leases SET heartbeat_at = datetime('now', '-1 hour') WHERE lease_key = ?").run(identityLeaseKey(105))
    const r = claimObjectiveSession(db, 105, 'cc-105-b', () => { throw new Error('should not be asked') })
    expect(r).toEqual({ outcome: 'claimed', sessionId: 'cc-105-b' })
  })

  it('leases are per-card: different objectives do not collide', () => {
    const db = getDb()
    expect(claimObjectiveSession(db, 106, 'cc-106-a', alive).outcome).toBe('claimed')
    expect(claimObjectiveSession(db, 107, 'cc-107-a', alive).outcome).toBe('claimed')
  })
})

describe('claimObjectiveSession — two connections, one DB file', () => {
  it('a concurrent double start yields one session', () => {
    const c1 = new Database(DB_FILE)
    const c2 = new Database(DB_FILE)
    try {
      c1.pragma('busy_timeout = 2000')
      c2.pragma('busy_timeout = 2000')
      ensureSessionLeaseTable(c1 as never)
      ensureSessionLeaseTable(c2 as never)

      const r1 = claimObjectiveSession(c1 as never, 201, 'cc-201-one', alive)
      const r2 = claimObjectiveSession(c2 as never, 201, 'cc-201-two', alive)

      const outcomes = [r1.outcome, r2.outcome].sort()
      expect(outcomes).toEqual(['attach', 'claimed'])
      const winner = r1.outcome === 'claimed' ? r1.sessionId : r2.sessionId
      const loser = r1.outcome === 'attach' ? r1 : r2
      expect(loser.sessionId).toBe(winner)

      // Both connections — and the app's own connection — see one owner.
      for (const c of [c1, c2, getDb()]) {
        expect((c.prepare('SELECT session_id FROM session_leases WHERE lease_key = ?').get(identityLeaseKey(201)) as { session_id: string }).session_id).toBe(winner)
      }
      expect((c1.prepare('SELECT COUNT(*) AS n FROM session_leases WHERE lease_key = ?').get(identityLeaseKey(201)) as { n: number }).n).toBe(1)

      // Repeat in the opposite order on a fresh card: still exactly one owner.
      const s2 = claimObjectiveSession(c2 as never, 202, 'cc-202-two', alive)
      const s1 = claimObjectiveSession(c1 as never, 202, 'cc-202-one', alive)
      expect(s2).toEqual({ outcome: 'claimed', sessionId: 'cc-202-two' })
      expect(s1).toMatchObject({ outcome: 'attach', sessionId: 'cc-202-two' })
    } finally {
      c1.close()
      c2.close()
    }
  })

  it('dead-holder takeover from the other connection moves the lease exactly once', () => {
    const c1 = new Database(DB_FILE)
    const c2 = new Database(DB_FILE)
    try {
      claimObjectiveSession(c1 as never, 203, 'cc-203-old', alive)
      // Two would-be successors both see the old holder as dead.
      const a = claimObjectiveSession(c1 as never, 203, 'cc-203-x', dead)
      const b = claimObjectiveSession(c2 as never, 203, 'cc-203-y', id => id === 'cc-203-x')
      expect(a).toEqual({ outcome: 'claimed', sessionId: 'cc-203-x' })
      expect(b).toMatchObject({ outcome: 'attach', sessionId: 'cc-203-x' })
      expect(getSessionLease(getDb(), identityLeaseKey(203))!.session_id).toBe('cc-203-x')
    } finally {
      c1.close()
      c2.close()
    }
  })
})
