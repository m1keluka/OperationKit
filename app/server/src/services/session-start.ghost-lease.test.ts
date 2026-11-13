import { describe, it, expect } from 'vitest'
import { leaseHolderIsLive } from './session-start.js'

// obj 900412 — startSession must only "attach" to a lease holder that is a
// DIFFERENT, RUNNING session. Before this, a ghost lease (a start that threw
// after claiming it) swallowed the next start: the card pointed at a session
// that never existed and later blocked with wrapper_never_started.
describe('leaseHolderIsLive', () => {
  const NEW = 'cc-900412-1794591996003'
  const GHOST = 'cc-900412-1794591995913'

  it('a holder whose process is not running is not live → take over and spawn', () => {
    expect(leaseHolderIsLive(GHOST, NEW, () => false)).toBe(false)
  })

  it('a running holder is live → attach (no duplicate worker)', () => {
    expect(leaseHolderIsLive(GHOST, NEW, () => true)).toBe(true)
  })

  it('the id we just generated is never "live" (branch lease clobbers session_id on reattach)', () => {
    expect(leaseHolderIsLive(NEW, NEW, () => true)).toBe(false)
  })

  it('no holder → not live', () => {
    expect(leaseHolderIsLive(null, NEW, () => true)).toBe(false)
  })

  it('a liveness probe that throws keeps the old fail-safe (attach)', () => {
    expect(leaseHolderIsLive(GHOST, NEW, () => { throw new Error('docker ps failed') })).toBe(true)
  })
})
