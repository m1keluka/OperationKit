import { describe, it, expect } from 'vitest'
import { isTransitionAllowed, OBJECTIVE_STATUSES, type ObjectiveStatus, type ObjectiveType } from '@operationkit/shared'
import { workingStartAction, marksPriorSessionFailed } from './working-start.js'

// obj 900652 — every `→ working` move the workflow allows must map to a session
// action. A status the routes' start list missed fell through to a bare
// `status = 'working'` write with no session (planning → working on project cards).
describe('workingStartAction', () => {
  const TYPES: ObjectiveType[] = ['project', 'bug', 'task']

  it('covers every → working transition the workflow table allows, for every type', () => {
    const gaps: string[] = []
    for (const type of TYPES) {
      for (const from of OBJECTIVE_STATUSES as readonly ObjectiveStatus[]) {
        if (!isTransitionAllowed(type, from, 'working')) continue
        if (workingStartAction(from) === 'unhandled') gaps.push(`${type}: ${from} → working`)
      }
    }
    expect(gaps).toEqual([])
  })

  it('planning (project cards) is a fresh start — the #900639 / #900640 case', () => {
    expect(isTransitionAllowed('project', 'planning', 'working')).toBe(true)
    expect(workingStartAction('planning')).toBe('fresh_start')
  })

  it('maps each status to the intended action', () => {
    expect(workingStartAction('queue')).toBe('fresh_start')
    expect(workingStartAction('review')).toBe('fresh_start')
    expect(workingStartAction('ai_review')).toBe('fresh_start')
    expect(workingStartAction('done')).toBe('reopen')
    expect(workingStartAction('cancelled')).toBe('reopen')
    expect(workingStartAction('working')).toBe('noop')
    expect(workingStartAction('bogus')).toBe('unhandled')
    expect(workingStartAction(null)).toBe('unhandled')
  })

  it('only a review-like start marks the prior worker session failed', () => {
    expect(marksPriorSessionFailed('review')).toBe(true)
    expect(marksPriorSessionFailed('ai_review')).toBe(true)
    expect(marksPriorSessionFailed('queue')).toBe(false)
    expect(marksPriorSessionFailed('planning')).toBe(false)
  })
})
