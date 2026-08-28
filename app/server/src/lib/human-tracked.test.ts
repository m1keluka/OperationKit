import { describe, it, expect } from 'vitest'
import { mustRouteToHumanReview } from './human-tracked.js'

/**
 * Policy under test (obj 1074): a "human-tracked" objective — top-level
 * (parent_id IS NULL) AND not routine-spawned (routine_id IS NULL) — must never
 * be auto-completed by any automated path. It is routed to `review` instead of
 * `done`. Both auto-done surfaces (state-poller.ts and internal.ts PATCH status)
 * call this exact guard, so testing it here covers the shared decision core.
 *
 * The four required cases (T1–T4) are proven below by applying the guard the
 * same way both call sites do:
 *     finalStatus = (mustRouteToHumanReview(obj) && base === 'done') ? 'review' : base
 */

type Row = { parent_id: number | null; routine_id: number | null; type?: string | null }

/** Mirror of the one-liner used verbatim at every state-poller site and in the
 *  internal.ts PATCH-status `done` branch. */
function applyGuard(
  obj: Row,
  base: 'done' | 'review' | 'ai_review',
  opts?: { verdict?: string | null; lane?: 'green' | 'yellow' | 'red' },
): string {
  return mustRouteToHumanReview(obj, opts) && base === 'done' ? 'review' : base
}

describe('mustRouteToHumanReview', () => {
  it('top-level, non-routine objective IS human-tracked', () => {
    expect(mustRouteToHumanReview({ parent_id: null, routine_id: null })).toBe(true)
  })
  it('delegator worker child (parent_id set) is NOT human-tracked', () => {
    expect(mustRouteToHumanReview({ parent_id: 42, routine_id: null })).toBe(false)
  })
  it('routine-spawned objective (routine_id set) is NOT human-tracked', () => {
    expect(mustRouteToHumanReview({ parent_id: null, routine_id: 7 })).toBe(false)
  })
  it('both parent and routine set is NOT human-tracked', () => {
    expect(mustRouteToHumanReview({ parent_id: 42, routine_id: 7 })).toBe(false)
  })
})

describe('routing outcomes (the four required cases)', () => {
  it('T1: top-level task/bug never auto-completes — even on reviewer PASS', () => {
    const task: Row = { parent_id: null, routine_id: null, type: 'task' }
    expect(applyGuard(task, 'done', { verdict: 'pass' })).toBe('review')
    const bug: Row = { parent_id: null, routine_id: null, type: 'bug' }
    expect(applyGuard(bug, 'done', { verdict: 'pass' })).toBe('review')
  })

  it('T1b: top-level project with verdict PASS still lands in review', () => {
    const project: Row = { parent_id: null, routine_id: null, type: 'project' }
    expect(applyGuard(project, 'done', { verdict: 'pass' })).toBe('review')
  })

  it('T1c: top-level task without a pass verdict still lands in review', () => {
    const task: Row = { parent_id: null, routine_id: null, type: 'task' }
    expect(applyGuard(task, 'done')).toBe('review')
    expect(applyGuard(task, 'done', { verdict: 'fail' })).toBe('review')
  })

  it('T1d: green-lane top-level task/bug still needs a human/API to mark done', () => {
    const task: Row = { parent_id: null, routine_id: null, type: 'task' }
    expect(applyGuard(task, 'done', { lane: 'green' })).toBe('review')
    const bug: Row = { parent_id: null, routine_id: null, type: 'bug' }
    expect(applyGuard(bug, 'done', { lane: 'green' })).toBe('review')
  })

  it('T1e: yellow/red top-level task without pass still lands in review', () => {
    const task: Row = { parent_id: null, routine_id: null, type: 'task' }
    expect(applyGuard(task, 'done', { lane: 'yellow' })).toBe('review')
    expect(applyGuard(task, 'done', { lane: 'red' })).toBe('review')
  })

  it('T1f: green lane does not auto-complete a project (human still required)', () => {
    const project: Row = { parent_id: null, routine_id: null, type: 'project' }
    expect(applyGuard(project, 'done', { lane: 'green' })).toBe('review')
  })

  // T2: delegator worker child still completes to done (orchestration preserved).
  it('T2: delegator worker child still lands in done on verdict PASS', () => {
    const child: Row = { parent_id: 100, routine_id: null }
    expect(applyGuard(child, 'done')).toBe('done')
  })

  // T3: routine-spawned objective still auto-completes (carve-out D1).
  it('T3: routine-spawned objective still auto-completes to done', () => {
    const job: Row = { parent_id: null, routine_id: 9 }
    expect(applyGuard(job, 'done')).toBe('done')
  })

  // T4: internal.ts PATCH {done} — same guard. Human-tracked → review (redirected);
  // worker child → done (delegators can still accept children via this endpoint).
  it('T4: internal PATCH done on human-tracked yields review; on worker child yields done', () => {
    expect(applyGuard({ parent_id: null, routine_id: null }, 'done')).toBe('review')
    expect(applyGuard({ parent_id: 5, routine_id: null }, 'done')).toBe('done')
  })

  it('non-done outcomes are never altered by the guard (review/ai_review pass through)', () => {
    const human: Row = { parent_id: null, routine_id: null }
    expect(applyGuard(human, 'review')).toBe('review')
    expect(applyGuard(human, 'ai_review')).toBe('ai_review')
  })
})
