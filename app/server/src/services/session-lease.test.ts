import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import {
  ensureSessionLeaseTable,
  acquireSessionLease,
  heartbeatSessionLease,
  heartbeatSessionLeasesForObjective,
  releaseSessionLease,
  releaseSessionLeasesForObjective,
  getSessionLease,
  identityLeaseKey,
  parentTitleLeaseKey,
  acquireSessionLeasesForSpawn,
  SESSION_LEASE_TTL_SECONDS,
} from './session-lease.js'

let db: Database.Database

beforeEach(() => {
  db = new Database(':memory:')
  ensureSessionLeaseTable(db)
})

/** Backdate a lease's heartbeat to simulate a crashed/stale owner. */
function staleHeartbeat(key: string, seconds: number) {
  db.prepare(`UPDATE session_leases SET heartbeat_at = datetime('now', '-${seconds} seconds') WHERE lease_key = ?`).run(key)
}

describe('session-lease key builders', () => {
  it('identity key encodes the objective id', () => {
    expect(identityLeaseKey(42)).toBe('obj:42')
  })
  it('parent-title key normalizes the title', () => {
    expect(parentTitleLeaseKey(7, 'Update the Jobs Tab!')).toBe('parent:7:update-the-jobs-tab')
  })
  it('parent-title key is null without a parent', () => {
    expect(parentTitleLeaseKey(null, 'x')).toBeNull()
    expect(parentTitleLeaseKey(undefined, 'x')).toBeNull()
    expect(parentTitleLeaseKey(0, 'x')).toBeNull()
  })
})

describe('session-lease (identity dedup for non-PR objectives)', () => {
  // ── Acceptance #1: two spawns for the SAME non-PR objective ──
  it('REATTACHES when the SAME objective re-acquires its own live identity lease', () => {
    const key = identityLeaseKey(1)
    const first = acquireSessionLease(db, key, 1, 'cc-1-aaa', 'tmux-1')
    expect(first.status).toBe('acquired')
    // Auto-resume / drain races the original spawn → second acquire reattaches.
    const second = acquireSessionLease(db, key, 1, 'cc-1-bbb', 'tmux-1b')
    expect(second.status).toBe('reattached')
    // Holder still points at the ORIGINAL live session (1st untouched).
    expect(second.holder.session_id).toBe('cc-1-aaa')
    expect(getSessionLease(db, key)!.session_id).toBe('cc-1-aaa')
  })

  // ── Acceptance #2: child-complete double/triple re-fire ──
  it('exactly one live session survives a double/triple re-fire of one non-PR worker', () => {
    const key = identityLeaseKey(5)
    const r1 = acquireSessionLease(db, key, 5, 'cc-5-aaa')
    const r2 = acquireSessionLease(db, key, 5, 'cc-5-bbb')
    const r3 = acquireSessionLease(db, key, 5, 'cc-5-ccc')
    expect(r1.status).toBe('acquired')
    expect(r2.status).toBe('reattached')
    expect(r3.status).toBe('reattached')
    // All re-fires rebind to the single original session.
    expect(getSessionLease(db, key)!.session_id).toBe('cc-5-aaa')
  })

  // ── Acceptance #3: stale/crashed holder is reclaimable ──
  it('reclaims a STALE identity lease (heartbeat older than TTL) so a legit retry of a dead session succeeds', () => {
    const key = identityLeaseKey(9)
    acquireSessionLease(db, key, 9, 'cc-9-dead')
    staleHeartbeat(key, SESSION_LEASE_TTL_SECONDS + 30)
    // Same objective retrying after its previous session crashed → fresh acquire.
    const retry = acquireSessionLease(db, key, 9, 'cc-9-alive')
    expect(retry.status).toBe('acquired')
    expect(getSessionLease(db, key)!.session_id).toBe('cc-9-alive')
  })

  it('reclaims a RELEASED identity lease', () => {
    const key = identityLeaseKey(3)
    acquireSessionLease(db, key, 3, 'cc-3-aaa')
    releaseSessionLease(db, key)
    const r = acquireSessionLease(db, key, 3, 'cc-3-bbb')
    expect(r.status).toBe('acquired')
  })

  // ── Acceptance #4: cross-card conflict (duplicate card) ──
  it('REFUSES a DIFFERENT objective holding the same parent+title key (duplicate card), original untouched', () => {
    const key = parentTitleLeaseKey(100, 'Refresh second brain')!
    const original = acquireSessionLease(db, key, 200, 'cc-200-aaa')
    expect(original.status).toBe('acquired')
    // A re-fired duplicate card (new objective id) for the same parent+title.
    const dup = acquireSessionLease(db, key, 201, 'cc-201-bbb')
    expect(dup.status).toBe('conflict')
    // The original holder is never killed or stranded.
    expect(dup.holder.objective_id).toBe(200)
    expect(getSessionLease(db, key)!.objective_id).toBe(200)
    expect(getSessionLease(db, key)!.session_id).toBe('cc-200-aaa')
  })

  it('reclaims a stale cross-card lease — a legit retry of a dead duplicate-holder still proceeds', () => {
    const key = parentTitleLeaseKey(100, 'Refresh second brain')!
    acquireSessionLease(db, key, 200, 'cc-200-dead')
    staleHeartbeat(key, SESSION_LEASE_TTL_SECONDS + 30)
    const r = acquireSessionLease(db, key, 201, 'cc-201-alive')
    expect(r.status).toBe('acquired')
    expect(getSessionLease(db, key)!.objective_id).toBe(201)
  })

  it('heartbeat keeps an identity lease alive so a foreign re-fire still reattaches (never double-spawns)', () => {
    const key = identityLeaseKey(11)
    acquireSessionLease(db, key, 11, 'cc-11-aaa')
    staleHeartbeat(key, SESSION_LEASE_TTL_SECONDS - 5)
    heartbeatSessionLease(db, key, 11)
    const r = acquireSessionLease(db, key, 11, 'cc-11-bbb')
    expect(r.status).toBe('reattached')
  })

  it('heartbeatSessionLeasesForObjective refreshes ALL of an objective’s keys', () => {
    const idKey = identityLeaseKey(1)
    const ptKey = parentTitleLeaseKey(50, 'do a thing')!
    acquireSessionLease(db, idKey, 1, 'cc-1-aaa')
    acquireSessionLease(db, ptKey, 1, 'cc-1-aaa')
    staleHeartbeat(idKey, SESSION_LEASE_TTL_SECONDS - 5)
    staleHeartbeat(ptKey, SESSION_LEASE_TTL_SECONDS - 5)
    heartbeatSessionLeasesForObjective(db, 1)
    // Both refreshed → a foreign racer on the parent key still loses (conflict).
    expect(acquireSessionLease(db, ptKey, 2, 'cc-2-bbb').status).toBe('conflict')
  })

  it('releaseSessionLeasesForObjective releases every key the objective holds', () => {
    const idKey = identityLeaseKey(1)
    const ptKey = parentTitleLeaseKey(50, 'do a thing')!
    acquireSessionLease(db, idKey, 1, 'cc-1-aaa')
    acquireSessionLease(db, ptKey, 1, 'cc-1-aaa')
    releaseSessionLeasesForObjective(db, 1)
    expect(getSessionLease(db, idKey)!.released_at).not.toBeNull()
    expect(getSessionLease(db, ptKey)!.released_at).not.toBeNull()
    // After release a fresh acquire (even by another objective) succeeds.
    expect(acquireSessionLease(db, ptKey, 2, 'cc-2-bbb').status).toBe('acquired')
  })

  it('re-acquire by same objective after release is a fresh acquire, not reattach', () => {
    const key = identityLeaseKey(1)
    acquireSessionLease(db, key, 1, 'cc-1-aaa')
    releaseSessionLease(db, key)
    expect(acquireSessionLease(db, key, 1, 'cc-1-ccc').status).toBe('acquired')
  })
})

describe('acquireSessionLeasesForSpawn (the spawn chokepoint)', () => {
  const obj = (id: number, parent_id: number | null, title: string) => ({ id, parent_id, title })

  it('ACQUIRES a fresh top-level non-PR objective (identity key only)', () => {
    const r = acquireSessionLeasesForSpawn(db, obj(1, null, 'Refresh second brain'), 'cc-1-aaa')
    expect(r.status).toBe('acquired')
    expect(r.leaseKey).toBe('obj:1')
  })

  // ── Acceptance #1 & #2: same objective re-fired (drain / child-complete / auto-resume) ──
  it('REATTACHES a duplicate wake of the SAME objective without touching the cross-card key', () => {
    const o = obj(5, 50, 'Update the Jobs tab')
    const first = acquireSessionLeasesForSpawn(db, o, 'cc-5-aaa')
    expect(first.status).toBe('acquired')
    const second = acquireSessionLeasesForSpawn(db, o, 'cc-5-bbb')
    const third = acquireSessionLeasesForSpawn(db, o, 'cc-5-ccc')
    expect(second.status).toBe('reattached')
    expect(third.status).toBe('reattached')
    // All re-fires rebind to the single original session.
    expect(second.holder.session_id).toBe('cc-5-aaa')
    expect(getSessionLease(db, identityLeaseKey(5))!.session_id).toBe('cc-5-aaa')
  })

  // ── Acceptance #4: duplicate CARD (different id, same parent+title) → conflict ──
  it('REFUSES a duplicate card (different objective_id, same parent+title); original untouched', () => {
    const original = acquireSessionLeasesForSpawn(db, obj(200, 100, 'Tweak loading animation'), 'cc-200-aaa')
    expect(original.status).toBe('acquired')
    const dup = acquireSessionLeasesForSpawn(db, obj(201, 100, 'Tweak loading animation'), 'cc-201-bbb')
    expect(dup.status).toBe('conflict')
    expect(dup.holder.objective_id).toBe(200)
    // Original cross-card holder untouched.
    expect(getSessionLease(db, parentTitleLeaseKey(100, 'Tweak loading animation')!)!.session_id).toBe('cc-200-aaa')
  })

  it('rolls back the refused objective’s identity lease on conflict (no phantom lease left behind)', () => {
    acquireSessionLeasesForSpawn(db, obj(200, 100, 'do a thing'), 'cc-200-aaa')
    const dup = acquireSessionLeasesForSpawn(db, obj(201, 100, 'do a thing'), 'cc-201-bbb')
    expect(dup.status).toBe('conflict')
    // obj:201 identity lease must be released, so a later legit (non-dup) spawn of 201 is clean.
    expect(getSessionLease(db, identityLeaseKey(201))!.released_at).not.toBeNull()
  })

  it('lets a top-level objective (no parent) spawn freely even with an identical title', () => {
    expect(acquireSessionLeasesForSpawn(db, obj(1, null, 'same title'), 'cc-1').status).toBe('acquired')
    // No parent → no cross-card key → a different top-level objective is not a duplicate.
    expect(acquireSessionLeasesForSpawn(db, obj(2, null, 'same title'), 'cc-2').status).toBe('acquired')
  })

  it('reclaims a stale duplicate-card holder so a legit retry proceeds (TTL fail-safe)', () => {
    acquireSessionLeasesForSpawn(db, obj(200, 100, 'do a thing'), 'cc-200-dead')
    // Crash the original holder: backdate BOTH its keys past the TTL.
    db.prepare(`UPDATE session_leases SET heartbeat_at = datetime('now', '-${SESSION_LEASE_TTL_SECONDS + 30} seconds')`).run()
    const retry = acquireSessionLeasesForSpawn(db, obj(201, 100, 'do a thing'), 'cc-201-alive')
    expect(retry.status).toBe('acquired')
  })
})
