import { describe, it, expect } from 'vitest'
import { isTransitionAllowed, VALID_TRANSITIONS, OBJECTIVE_STATUSES } from '@command-center/shared'

// obj 700595 — the `cancelled` soft-retire terminal state. It must be a real
// member of the status enum, distinct from `done`, reachable from every
// non-terminal state (so the hygiene sweeps + orphan cleanup can retire items),
// and reopenable (so a human can un-cancel). These lock that contract. Placed in
// the server workspace so it is collected by CI (the shared package has no test
// runner); it exercises the shared workflow module via the @command-center/shared
// alias.

describe('cancelled status enum membership', () => {
  it('cancelled is a member of OBJECTIVE_STATUSES', () => {
    expect(OBJECTIVE_STATUSES).toContain('cancelled')
  })
  it('cancelled is distinct from done (both are terminal sinks with only a reopen edge)', () => {
    expect('cancelled').not.toBe('done')
    expect(VALID_TRANSITIONS.cancelled).toEqual(['queue'])
    expect(VALID_TRANSITIONS.done).toEqual(['queue'])
  })
})

describe('isTransitionAllowed → cancelled (per type)', () => {
  for (const type of ['project', 'bug', 'task'] as const) {
    it(`${type}: queue → cancelled is allowed`, () => {
      expect(isTransitionAllowed(type, 'queue', 'cancelled')).toBe(true)
    })
    it(`${type}: working → cancelled is allowed`, () => {
      expect(isTransitionAllowed(type, 'working', 'cancelled')).toBe(true)
    })
    it(`${type}: review → cancelled is allowed`, () => {
      expect(isTransitionAllowed(type, 'review', 'cancelled')).toBe(true)
    })
    it(`${type}: cancelled → working (reopen) is allowed`, () => {
      expect(isTransitionAllowed(type, 'cancelled', 'working')).toBe(true)
    })
  }

  it('project: planning → cancelled is allowed', () => {
    expect(isTransitionAllowed('project', 'planning', 'cancelled')).toBe(true)
    expect(isTransitionAllowed('project', 'planning', 'working')).toBe(true)
  })

  it('done → cancelled is NOT allowed (already terminal-complete)', () => {
    expect(isTransitionAllowed('task', 'done', 'cancelled')).toBe(false)
  })
})
