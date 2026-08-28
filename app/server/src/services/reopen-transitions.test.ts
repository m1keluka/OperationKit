import { describe, it, expect } from 'vitest'
import { isTransitionAllowed, allowedTransitions } from '@command-center/shared'

// Objective 359 — "Re-Open" replaced "Re-queue". A done objective now reopens
// straight into `working` (resuming its prior thread) rather than restarting
// from `queue`. These tests lock that transition contract for all three types.
describe('done → working (Re-Open) transition', () => {
  for (const type of ['project', 'bug', 'task'] as const) {
    it(`${type}: done → working is allowed`, () => {
      expect(isTransitionAllowed(type, 'done', 'working')).toBe(true)
    })

    it(`${type}: done → queue (old Re-queue) is no longer allowed`, () => {
      expect(isTransitionAllowed(type, 'done', 'queue')).toBe(false)
    })

    it(`${type}: working is the only exit from done`, () => {
      expect(allowedTransitions(type, 'done')).toEqual(['working'])
    })
  }
})
