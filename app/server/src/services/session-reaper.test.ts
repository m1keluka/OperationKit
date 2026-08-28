import { describe, it, expect } from 'vitest'
import { selectPredecessorsToReap, selectOrphanWorkerSessions } from './session-manager.js'

/**
 * Tests for the obj-1114 predecessor reaper selector — the lease-independent
 * sweep that stops a cross-account auto-resume from leaving TWO live worker
 * sessions writing one objective's worktree (the double-spawn that hit obj-1059
 * live). The selector is the matching logic; the tmux IO wrapper is thin glue.
 */
describe('selectPredecessorsToReap (obj 1114)', () => {
  it('auto-resume: reaps a predecessor worker with a DIFFERENT session id, keeps the new one', () => {
    // Same objectiveId, new sessionId — the continuation about to spawn keeps,
    // the still-alive predecessor is killed → exactly one live session remains.
    const keep = 'cc-1059-1782063810935'
    const predecessor = 'cc-1059-1782063418943'
    const kill = selectPredecessorsToReap(1059, keep, [predecessor, keep])
    expect(kill).toEqual([predecessor])
  })

  it('orphan: reaps a live cc-<objId>-* worker even though the selector never consults a lease row', () => {
    // The incident orphan held NO branch lease, yet its tmux kept running. The
    // sweep matches purely by name shape, so it catches the lease-invisible orphan.
    const kill = selectPredecessorsToReap(1059, 'cc-1059-newer', ['cc-1059-1782063418943'])
    expect(kill).toEqual(['cc-1059-1782063418943'])
  })

  it('reaps MULTIPLE predecessors at once (defense in depth)', () => {
    const keep = 'cc-7-300'
    const names = ['cc-7-100', 'cc-7-200', keep, 'cc-7-250']
    expect(selectPredecessorsToReap(7, keep, names).sort()).toEqual(['cc-7-100', 'cc-7-200', 'cc-7-250'])
  })

  it('never reaps the session about to run (keepSessionId is excluded)', () => {
    const keep = 'cc-42-999'
    expect(selectPredecessorsToReap(42, keep, [keep])).toEqual([])
  })

  it('regression: does NOT reap a concurrent planner (cc-plan-<id>-*) for the same objective', () => {
    const kill = selectPredecessorsToReap(42, 'cc-42-999', ['cc-plan-42-111', 'cc-42-999'])
    expect(kill).toEqual([])
  })

  it('regression: does NOT reap a concurrent reviewer (cc-review-<id>-*) for the same objective', () => {
    const kill = selectPredecessorsToReap(42, 'cc-42-999', ['cc-review-42-111', 'cc-42-999'])
    expect(kill).toEqual([])
  })

  it('regression: does NOT reap arena cohort variants (cc-<objId>-<ts>-arena-<key>)', () => {
    // Arena is the ONE legitimate multi-session-per-objective case. Variants carry
    // a trailing `-arena-<key>`, so they fail `[0-9]+$` and are preserved.
    const names = [
      'cc-42-100-arena-mvp',
      'cc-42-100-arena-risk',
      'cc-42-100-arena-user',
    ]
    expect(selectPredecessorsToReap(42, 'cc-42-999', names)).toEqual([])
  })

  it('regression: does NOT reap a sibling objective whose id shares a digit prefix', () => {
    // `cc-10591-*` and `cc-105-*` must not match `^cc-1059-[0-9]+$`.
    const names = ['cc-10591-100', 'cc-105-100', 'cc-1059-100']
    expect(selectPredecessorsToReap(1059, 'cc-1059-999', names)).toEqual(['cc-1059-100'])
  })

  it('empty / no-tmux: returns nothing to kill', () => {
    expect(selectPredecessorsToReap(1, 'cc-1-1', [])).toEqual([])
  })

  it('ignores unrelated session names entirely', () => {
    const names = ['litellm', 'random', 'cc-99-100', 'cc-1-1']
    expect(selectPredecessorsToReap(1, 'cc-1-1', names)).toEqual([])
  })
})

describe('selectOrphanWorkerSessions (periodic orphan sweep)', () => {
  it('kills a worker tmux whose session_id is no longer live', () => {
    const names = ['cc-7-100', 'cc-7-200', 'litellm']
    expect(selectOrphanWorkerSessions(names, ['cc-7-200'])).toEqual(['cc-7-100'])
  })

  it('keeps every currently live working session', () => {
    const names = ['cc-1-10', 'cc-2-20']
    expect(selectOrphanWorkerSessions(names, names)).toEqual([])
  })

  it('does not reap reviewer, planner, or arena names', () => {
    const names = ['cc-review-7-1', 'cc-plan-7-1', 'cc-7-100-arena-mvp', 'cc-7-999']
    expect(selectOrphanWorkerSessions(names, [])).toEqual(['cc-7-999'])
  })
})
