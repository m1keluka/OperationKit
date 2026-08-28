import { describe, it, expect } from 'vitest'
import { resolveWorkerEndStatus } from './state-poller.js'
import type { ObjectiveType } from '@command-center/shared'

// Objective 1234: the working→review type-aware routing keyed ONLY on `type`
// and ignored `create_pr`. A top-level create_pr *task* therefore routed to the
// human `review` gate, the adversarial reviewer never spawned, and the gating
// `harness/test-agent` commit status was never posted → the PR sat with no
// check forever and the harness loop could never go green end-to-end.
// resolveWorkerEndStatus is the pure decision the poller now consults.

const route = (over: {
  type?: ObjectiveType
  delegateMode?: boolean
  createPr?: boolean
  skipAi?: boolean
  hasDelegatorParent?: boolean
  lane?: 'green' | 'yellow' | 'red'
  isRoutine?: boolean
}) =>
  resolveWorkerEndStatus({
    type: 'task',
    delegateMode: false,
    createPr: false,
    skipAi: false,
    hasDelegatorParent: false,
    ...over,
  })

describe('resolveWorkerEndStatus — create_pr routing fix (obj 1234)', () => {
  it('THE BUG: a top-level create_pr task now reaches ai_review (was review)', () => {
    // No delegator parent, no opt-out: pre-fix this returned 'review' and the
    // PR never got a harness status. It must now spawn the reviewer.
    expect(route({ type: 'task', createPr: true })).toBe('ai_review')
  })

  it('create_pr project → ai_review (unchanged)', () => {
    expect(route({ type: 'project', createPr: true })).toBe('ai_review')
  })

  it('create_pr bug → ai_review (unchanged)', () => {
    expect(route({ type: 'bug', createPr: true })).toBe('ai_review')
  })

  it('create_pr objective with skip_ai_review opt-out is honored, not forced to ai_review', () => {
    // Operator explicitly opted out → byte-identical to the old opt-out branch.
    expect(route({ type: 'project', createPr: true, skipAi: true })).toBe('review')
    expect(route({ type: 'bug', createPr: true, skipAi: true })).toBe('done')
    // A create_pr task + opt-out lands in review exactly as a plain task does.
    expect(route({ type: 'task', createPr: true, skipAi: true })).toBe('review')
  })

  it('delegate_mode always routes to the human review gate, even with create_pr', () => {
    expect(route({ delegateMode: true, createPr: true })).toBe('review')
    expect(route({ delegateMode: true, type: 'project' })).toBe('review')
  })
})

describe('resolveWorkerEndStatus — non-create_pr behavior is unchanged', () => {
  it('plain task (no parent) → review', () => {
    expect(route({ type: 'task' })).toBe('review')
  })

  it('delegator-worker task (has delegator parent) → ai_review', () => {
    expect(route({ type: 'task', hasDelegatorParent: true })).toBe('ai_review')
  })

  it('delegator-worker task with skip_ai_review → review (opt-out beats the delegator branch)', () => {
    expect(route({ type: 'task', hasDelegatorParent: true, skipAi: true })).toBe('review')
  })

  it('project → ai_review; bug → ai_review', () => {
    expect(route({ type: 'project' })).toBe('ai_review')
    expect(route({ type: 'bug' })).toBe('ai_review')
  })

  it('project with skip_ai_review → review; bug with skip_ai_review → done', () => {
    expect(route({ type: 'project', skipAi: true })).toBe('review')
    expect(route({ type: 'bug', skipAi: true })).toBe('done')
  })
})

// Objective 1970: routine-spawned tasks were routing to `review` like any task.
// Because every routine has max_queue_depth, that stranded review card filled the
// routine's only slot and the queue-depth guard skipped every subsequent fire —
// all 7 routines silently stopped firing ~Jun 21. Routine tasks must auto-`done`.
describe('resolveWorkerEndStatus — routine carve-out (obj 1970)', () => {
  const routeR = (over: Parameters<typeof route>[0] & { isRoutine?: boolean }) =>
    resolveWorkerEndStatus({
      type: 'task',
      delegateMode: false,
      createPr: false,
      skipAi: false,
      hasDelegatorParent: false,
      ...over,
    })

  it('THE FIX: a routine task auto-completes to done (was review)', () => {
    expect(routeR({ type: 'task', isRoutine: true })).toBe('done')
  })

  it('a non-routine plain task still lands in review (unchanged)', () => {
    expect(routeR({ type: 'task', isRoutine: false })).toBe('review')
  })

  it('a routine that opts into create_pr still goes through ai_review (harness gate wins)', () => {
    // create_pr is checked before the task branch, so a routine PR is still gated.
    expect(routeR({ type: 'task', isRoutine: true, createPr: true })).toBe('ai_review')
  })

  it('isRoutine only affects the task branch — routine project/bug unchanged', () => {
    expect(routeR({ type: 'project', isRoutine: true })).toBe('ai_review')
    expect(routeR({ type: 'bug', isRoutine: true })).toBe('ai_review')
  })
})

// Merge lanes (2026-08-25): Green skips the tmux reviewer. When `lane` is
// omitted the table above is unchanged (create_pr still ai_review).
describe('resolveWorkerEndStatus — merge lanes', () => {
  it('green lane skips the reviewer but parks in review (human/API marks done)', () => {
    expect(route({ type: 'task', createPr: true, lane: 'green' })).toBe('review')
    expect(route({ type: 'bug', createPr: true, lane: 'green' })).toBe('review')
    expect(route({ type: 'task', lane: 'green' })).toBe('review')
  })

  it('yellow lane keeps create_pr on the reviewer path', () => {
    expect(route({ type: 'task', createPr: true, lane: 'yellow' })).toBe('ai_review')
    expect(route({ type: 'bug', createPr: true, lane: 'yellow' })).toBe('ai_review')
  })

  it('delegate_mode still beats green (delegator parents stay human)', () => {
    expect(route({ delegateMode: true, createPr: true, lane: 'green' })).toBe('review')
  })

  it('green still wins over a routine create_pr (harness posted without a reviewer)', () => {
    expect(route({ type: 'task', isRoutine: true, createPr: true, lane: 'green' })).toBe('done')
  })
})
