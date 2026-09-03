import { describe, it, expect } from 'vitest'
import type { Objective } from '@operationkit/shared'
import { mergeObjectiveUpdate } from './mergeObjective'

const card = (over: Partial<Objective> = {}): Objective =>
  ({ id: 1, title: 'x', status: 'review', workspace: 'example', ...over }) as Objective

describe('mergeObjectiveUpdate', () => {
  it('keeps hydrated assignees when a raw WS row omits them', () => {
    const prev = card({ assigned_usernames: ['ava'], assigned_user_ids: [2] })
    const incoming = card({ status: 'working', session_id: 's1' })
    const merged = mergeObjectiveUpdate(prev, incoming)
    expect(merged.status).toBe('working')
    expect(merged.session_id).toBe('s1')
    expect(merged.assigned_usernames).toEqual(['ava'])
    expect(merged.assigned_user_ids).toEqual([2])
  })

  it('accepts an explicit unassign (empty arrays)', () => {
    const prev = card({ assigned_usernames: ['ava'], assigned_user_ids: [2] })
    const incoming = card({ assigned_usernames: [], assigned_user_ids: [] })
    const merged = mergeObjectiveUpdate(prev, incoming)
    expect(merged.assigned_usernames).toEqual([])
    expect(merged.assigned_user_ids).toEqual([])
  })

  it('replaces assignees when the payload includes new names', () => {
    const prev = card({ assigned_usernames: ['ava'], assigned_user_ids: [2] })
    const incoming = card({ assigned_usernames: ['mike'], assigned_user_ids: [1] })
    const merged = mergeObjectiveUpdate(prev, incoming)
    expect(merged.assigned_usernames).toEqual(['mike'])
    expect(merged.assigned_user_ids).toEqual([1])
  })

  it('returns the incoming row when there is no previous card', () => {
    const incoming = card({ assigned_usernames: ['ava'] })
    expect(mergeObjectiveUpdate(undefined, incoming)).toBe(incoming)
  })
})
