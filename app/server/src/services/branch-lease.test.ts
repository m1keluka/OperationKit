import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import {
  ensureBranchLeaseTable,
  acquireBranchLease,
  heartbeatBranchLease,
  releaseBranchLease,
  releaseBranchLeasesForObjective,
  getBranchLease,
  LEASE_TTL_SECONDS,
} from './branch-lease.js'

let db: Database.Database

beforeEach(() => {
  db = new Database(':memory:')
  ensureBranchLeaseTable(db)
})

/** Backdate a lease's heartbeat to simulate a crashed/stale owner. */
function staleHeartbeat(branch: string, seconds: number) {
  db.prepare(`UPDATE branch_leases SET heartbeat_at = datetime('now', '-${seconds} seconds') WHERE branch_name = ?`).run(branch)
}

describe('branch-lease', () => {
  it('acquires a free branch', () => {
    const r = acquireBranchLease(db, 'cc/obj-1-foo', 1, 'cc-1-aaa', 'tmux-1')
    expect(r.status).toBe('acquired')
    expect(r.holder.objective_id).toBe(1)
    expect(r.holder.session_id).toBe('cc-1-aaa')
  })

  it('REFUSES a different objective while the holder is live (prevents double-build)', () => {
    acquireBranchLease(db, 'cc/obj-1-foo', 1, 'cc-1-aaa', 'tmux-1')
    const r = acquireBranchLease(db, 'cc/obj-1-foo', 2, 'cc-2-bbb', 'tmux-2')
    expect(r.status).toBe('conflict')
    expect(r.holder.objective_id).toBe(1) // original owner untouched — never stranded/killed
    // The original lease is still owned by objective 1.
    expect(getBranchLease(db, 'cc/obj-1-foo')!.objective_id).toBe(1)
  })

  it('REATTACHES when the SAME objective re-acquires its own live lease (auto-resume)', () => {
    acquireBranchLease(db, 'cc/obj-1-foo', 1, 'cc-1-aaa', 'tmux-1')
    const r = acquireBranchLease(db, 'cc/obj-1-foo', 1, 'cc-1-ccc', 'tmux-1b')
    expect(r.status).toBe('reattached')
    expect(r.holder.objective_id).toBe(1)
  })

  it('reclaims a STALE lease (heartbeat older than TTL) — no permanent strand', () => {
    acquireBranchLease(db, 'cc/obj-1-foo', 1, 'cc-1-aaa', 'tmux-1')
    staleHeartbeat('cc/obj-1-foo', LEASE_TTL_SECONDS + 30)
    const r = acquireBranchLease(db, 'cc/obj-1-foo', 2, 'cc-2-bbb', 'tmux-2')
    expect(r.status).toBe('acquired')
    expect(getBranchLease(db, 'cc/obj-1-foo')!.objective_id).toBe(2)
  })

  it('reclaims a RELEASED lease', () => {
    acquireBranchLease(db, 'cc/obj-1-foo', 1, 'cc-1-aaa', 'tmux-1')
    releaseBranchLease(db, 'cc/obj-1-foo')
    const r = acquireBranchLease(db, 'cc/obj-1-foo', 2, 'cc-2-bbb', 'tmux-2')
    expect(r.status).toBe('acquired')
    expect(getBranchLease(db, 'cc/obj-1-foo')!.objective_id).toBe(2)
  })

  it('heartbeat keeps a lease alive so a foreign racer still loses', () => {
    acquireBranchLease(db, 'cc/obj-1-foo', 1, 'cc-1-aaa', 'tmux-1')
    // Almost-stale, then heartbeat refreshes it.
    staleHeartbeat('cc/obj-1-foo', LEASE_TTL_SECONDS - 5)
    heartbeatBranchLease(db, 'cc/obj-1-foo', 1)
    const r = acquireBranchLease(db, 'cc/obj-1-foo', 2, 'cc-2-bbb', 'tmux-2')
    expect(r.status).toBe('conflict')
  })

  it('re-acquire by same objective after release is a fresh acquire, not reattach', () => {
    acquireBranchLease(db, 'cc/obj-1-foo', 1, 'cc-1-aaa', 'tmux-1')
    releaseBranchLease(db, 'cc/obj-1-foo')
    const r = acquireBranchLease(db, 'cc/obj-1-foo', 1, 'cc-1-ddd', 'tmux-1c')
    expect(r.status).toBe('acquired')
  })

  it('releaseBranchLeasesForObjective releases all of an objective’s branches', () => {
    acquireBranchLease(db, 'cc/obj-1-foo', 1, 'cc-1-aaa', 'tmux-1')
    acquireBranchLease(db, 'cc/obj-1-bar', 1, 'cc-1-aaa', 'tmux-1')
    releaseBranchLeasesForObjective(db, 1)
    expect(getBranchLease(db, 'cc/obj-1-foo')!.released_at).not.toBeNull()
    expect(getBranchLease(db, 'cc/obj-1-bar')!.released_at).not.toBeNull()
  })
})
