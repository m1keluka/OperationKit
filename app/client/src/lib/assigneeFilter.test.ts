import { describe, it, expect } from 'vitest'
import {
  UNASSIGNED_TOKEN,
  matchesAssigneeFilter,
  assigneeRoster,
  defaultAssigneeSelection,
} from './assigneeFilter'

const obj = (assigned_usernames?: string[]) => ({ assigned_usernames }) as any

describe('defaultAssigneeSelection', () => {
  it('is Unassigned + the current user', () => {
    expect(defaultAssigneeSelection('operator')).toEqual([UNASSIGNED_TOKEN, 'operator'])
  })
  it('falls back to just Unassigned when there is no current user', () => {
    expect(defaultAssigneeSelection(null)).toEqual([UNASSIGNED_TOKEN])
    expect(defaultAssigneeSelection(undefined)).toEqual([UNASSIGNED_TOKEN])
  })
})

describe('matchesAssigneeFilter', () => {
  it('default selection (Unassigned+Operator) shows unassigned and Operator, hides Casey-only', () => {
    const selected = new Set(defaultAssigneeSelection('operator'))
    expect(matchesAssigneeFilter(obj([]), selected)).toBe(true)          // unassigned
    expect(matchesAssigneeFilter(obj(undefined), selected)).toBe(true)   // unassigned (no field)
    expect(matchesAssigneeFilter(obj(['operator']), selected)).toBe(true)    // Operator
    expect(matchesAssigneeFilter(obj(['casey']), selected)).toBe(false)    // Casey-only hidden
    expect(matchesAssigneeFilter(obj(['casey', 'operator']), selected)).toBe(true) // ANY-match: Operator present
  })

  it('multi-select matches on ANY selected assignee', () => {
    const selected = new Set(['operator', 'casey'])
    expect(matchesAssigneeFilter(obj(['casey']), selected)).toBe(true)
    expect(matchesAssigneeFilter(obj(['operator']), selected)).toBe(true)
    expect(matchesAssigneeFilter(obj(['bob']), selected)).toBe(false)
    expect(matchesAssigneeFilter(obj([]), selected)).toBe(false) // Unassigned not selected
  })

  it('Unassigned bucket only matches objectives with no assignees', () => {
    const selected = new Set([UNASSIGNED_TOKEN])
    expect(matchesAssigneeFilter(obj([]), selected)).toBe(true)
    expect(matchesAssigneeFilter(obj(['operator']), selected)).toBe(false)
  })

  it('empty selection matches nothing', () => {
    const selected = new Set<string>()
    expect(matchesAssigneeFilter(obj([]), selected)).toBe(false)
    expect(matchesAssigneeFilter(obj(['operator']), selected)).toBe(false)
  })
})

describe('assigneeRoster', () => {
  it('returns distinct usernames alpha-sorted, ignoring unassigned', () => {
    const roster = assigneeRoster([
      obj(['operator']),
      obj(['casey', 'operator']),
      obj([]),
      obj(undefined),
      obj(['casey']),
    ])
    expect(roster).toEqual(['casey', 'operator'])
  })
  it('supports arbitrary future users, nothing hardcoded', () => {
    expect(assigneeRoster([obj(['zoe']), obj(['newhire'])])).toEqual(['newhire', 'zoe'])
  })
})
