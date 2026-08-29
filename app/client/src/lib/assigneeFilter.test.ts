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
    expect(defaultAssigneeSelection('admin')).toEqual([UNASSIGNED_TOKEN, 'admin'])
  })
  it('falls back to just Unassigned when there is no current user', () => {
    expect(defaultAssigneeSelection(null)).toEqual([UNASSIGNED_TOKEN])
    expect(defaultAssigneeSelection(undefined)).toEqual([UNASSIGNED_TOKEN])
  })
})

describe('matchesAssigneeFilter', () => {
  it('default selection (Unassigned+admin) shows unassigned and admin, hides Ava-only', () => {
    const selected = new Set(defaultAssigneeSelection('admin'))
    expect(matchesAssigneeFilter(obj([]), selected)).toBe(true)          // unassigned
    expect(matchesAssigneeFilter(obj(undefined), selected)).toBe(true)   // unassigned (no field)
    expect(matchesAssigneeFilter(obj(['admin']), selected)).toBe(true)    // Operator
    expect(matchesAssigneeFilter(obj(['ava']), selected)).toBe(false)    // Ava-only hidden
    expect(matchesAssigneeFilter(obj(['ava', 'admin']), selected)).toBe(true) // ANY-match: Operator present
  })

  it('multi-select matches on ANY selected assignee', () => {
    const selected = new Set(['admin', 'ava'])
    expect(matchesAssigneeFilter(obj(['ava']), selected)).toBe(true)
    expect(matchesAssigneeFilter(obj(['admin']), selected)).toBe(true)
    expect(matchesAssigneeFilter(obj(['bob']), selected)).toBe(false)
    expect(matchesAssigneeFilter(obj([]), selected)).toBe(false) // Unassigned not selected
  })

  it('Unassigned bucket only matches objectives with no assignees', () => {
    const selected = new Set([UNASSIGNED_TOKEN])
    expect(matchesAssigneeFilter(obj([]), selected)).toBe(true)
    expect(matchesAssigneeFilter(obj(['admin']), selected)).toBe(false)
  })

  it('empty selection matches nothing', () => {
    const selected = new Set<string>()
    expect(matchesAssigneeFilter(obj([]), selected)).toBe(false)
    expect(matchesAssigneeFilter(obj(['admin']), selected)).toBe(false)
  })
})

describe('assigneeRoster', () => {
  it('returns distinct usernames alpha-sorted, ignoring unassigned', () => {
    const roster = assigneeRoster([
      obj(['admin']),
      obj(['ava', 'admin']),
      obj([]),
      obj(undefined),
      obj(['ava']),
    ])
    expect(roster).toEqual(['admin', 'ava'])
  })
  it('supports arbitrary future users, nothing hardcoded', () => {
    expect(assigneeRoster([obj(['zoe']), obj(['newhire'])])).toEqual(['newhire', 'zoe'])
  })
})
