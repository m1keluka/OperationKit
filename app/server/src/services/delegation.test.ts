import { describe, it, expect } from 'vitest'
import { reconcileDecision } from './delegation.js'

const K = (id: number, status: string) => ({ id, status })

describe('reconcileDecision (delegator wake-storm guard)', () => {
  it('no children → not actionable', () => {
    expect(reconcileDecision([], undefined).actionable).toBe(false)
  })

  it('workers actively in flight (working/ai_review) → not actionable', () => {
    const r = reconcileDecision([K(1, 'working'), K(2, 'ai_review')], undefined)
    expect(r.actionable).toBe(false)
  })

  it('a queued worker → actionable (delegator must wake to spawn it)', () => {
    // A `queue` child is NOT in flight — it is waiting to be started. The
    // delegator has to wake to spawn it, so this must be actionable. Regression
    // guard for obj 938/1017, which parked 10+h with queued workers unspawned.
    const r = reconcileDecision([K(1, 'done'), K(2, 'queue')], undefined)
    expect(r.actionable).toBe(true)
    expect(r.why).toMatch(/queued/)
  })

  it('all done with no prior signature → actionable AND changed (one synthesize nudge)', () => {
    const r = reconcileDecision([K(1, 'done'), K(2, 'done')], undefined)
    expect(r.actionable).toBe(true)
    expect(r.changed).toBe(true)
    expect(r.why).toMatch(/synthesize/)
  })

  // THE FIX: a settled all-done state is actionable but NOT a new event, so the
  // reconcile net must not re-nudge it. This is the regression guard for the
  // "stale duplicate wake" storm Mike reported on objective 311.
  it('all done with the SAME signature already recorded → actionable but NOT changed', () => {
    const kids = [K(1, 'done'), K(2, 'done')]
    const first = reconcileDecision(kids, undefined)
    const second = reconcileDecision(kids, first.sig)
    expect(second.actionable).toBe(true)
    expect(second.changed).toBe(false)
  })

  it('a worker awaiting review → actionable, reason mentions awaiting', () => {
    const r = reconcileDecision([K(1, 'done'), K(2, 'review')], undefined)
    expect(r.actionable).toBe(true)
    expect(r.why).toMatch(/awaiting/)
  })

  it('signature changes on a real review→done transition → re-nudges', () => {
    const before = reconcileDecision([K(1, 'done'), K(2, 'review')], undefined)
    const after = reconcileDecision([K(1, 'done'), K(2, 'done')], before.sig)
    expect(after.changed).toBe(true)
  })

  it('signature is order-independent (SQLite row order must not matter)', () => {
    const a = reconcileDecision([K(1, 'done'), K(2, 'review')], undefined)
    const b = reconcileDecision([K(2, 'review'), K(1, 'done')], undefined)
    expect(a.sig).toBe(b.sig)
  })

  it('a newly spawned in-flight worker flips all-done back to not-actionable', () => {
    const r = reconcileDecision([K(1, 'done'), K(2, 'done'), K(3, 'working')], 'prev-sig')
    expect(r.actionable).toBe(false)
  })

  it('a stuck worker the delegator keeps declining stays the same signature → nudged once, not repeatedly', () => {
    const kids = [K(1, 'done'), K(2, 'review')]
    const first = reconcileDecision(kids, undefined)
    const again = reconcileDecision(kids, first.sig)
    expect(first.changed).toBe(true)
    expect(again.changed).toBe(false)
  })
})

// DURABILITY ACROSS RESTART (obj-1138): the wake-storm guard's last-nudged
// signature is persisted in objectives.reconcile_sig. These tests model exactly
// how state-poller.reconcileDelegators uses reconcileDecision against a durable
// store, and prove that a server restart (in-memory state wiped) no longer
// re-nudges an already-settled all-done delegator — the ~$7/restart leak — while a
// genuine new completion still wakes it exactly once.
describe('durable reconcile signature survives restart', () => {
  // A tiny stand-in for the objectives.reconcile_sig DB column. A "restart" is
  // modeled by keeping this store but discarding any process-local (in-memory)
  // state — which is the whole point: durable state is the ONLY source of truth.
  type DurableStore = Map<number, string | null>

  // Mirror of the caller's decision logic in reconcileDelegators: read the
  // persisted sig, decide, persist the new sig only when it changed, and report
  // whether a nudge would fire.
  function reconcilePass(
    durable: DurableStore,
    delegatorId: number,
    kids: { id: number; status: string }[],
  ): { nudged: boolean } {
    const lastSig = durable.get(delegatorId) ?? undefined
    const { actionable, changed, sig } = reconcileDecision(kids, lastSig)
    if (!actionable) return { nudged: false }
    if (changed) durable.set(delegatorId, sig)
    return { nudged: changed }
  }

  it('all-done delegator with a PERSISTED matching sig is NOT nudged after a restart', () => {
    const durable: DurableStore = new Map()
    const kids = [K(1, 'done'), K(2, 'done')]

    // Pre-restart: the reconcile net records the all-done signature once and nudges.
    expect(reconcilePass(durable, 955, kids).nudged).toBe(true)
    expect(durable.get(955)).toBeTruthy()

    // --- simulate a server restart: in-memory state is gone, durable store remains ---

    // First post-restart pass over the UNCHANGED all-done delegator → no nudge.
    // (With the old in-memory map this returned a spurious nudge — the leak.)
    expect(reconcilePass(durable, 955, kids).nudged).toBe(false)
    // And it stays quiet on every subsequent restart/pass.
    expect(reconcilePass(durable, 955, kids).nudged).toBe(false)
  })

  it('a genuine new completion after a restart still wakes the delegator exactly once', () => {
    const durable: DurableStore = new Map()

    // Settled state recorded pre-restart: one worker still in review.
    reconcilePass(durable, 955, [K(1, 'done'), K(2, 'review')])
    const settledSig = durable.get(955)

    // --- restart ---

    // The worker finished during/after the restart window: review → done. The
    // signature differs from the persisted one → exactly one wake.
    const after = reconcilePass(durable, 955, [K(1, 'done'), K(2, 'done')])
    expect(after.nudged).toBe(true)
    expect(durable.get(955)).not.toBe(settledSig)

    // Re-settled: the new all-done signature is now persisted → no further wakes.
    expect(reconcilePass(durable, 955, [K(1, 'done'), K(2, 'done')]).nudged).toBe(false)
  })
})
