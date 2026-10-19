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
    expect(defaultAssigneeSelection('mike')).toEqual([UNASSIGNED_TOKEN, 'mike'])
  })
  it('falls back to just Unassigned when there is no current user', () => {
    expect(defaultAssigneeSelection(null)).toEqual([UNASSIGNED_TOKEN])
    expect(defaultAssigneeSelection(undefined)).toEqual([UNASSIGNED_TOKEN])
  })
})

describe('matchesAssigneeFilter', () => {
  it('default selection (Unassigned+Mike) shows unassigned and Mike, hides Ava-only', () => {
    const selected = new Set(defaultAssigneeSelection('mike'))
    expect(matchesAssigneeFilter(obj([]), selected)).toBe(true)          // unassigned
    expect(matchesAssigneeFilter(obj(undefined), selected)).toBe(true)   // unassigned (no field)
    expect(matchesAssigneeFilter(obj(['mike']), selected)).toBe(true)    // Mike
    expect(matchesAssigneeFilter(obj(['ava']), selected)).toBe(false)    // Ava-only hidden
    expect(matchesAssigneeFilter(obj(['ava', 'mike']), selected)).toBe(true) // ANY-match: Mike present
  })

  it('multi-select matches on ANY selected assignee', () => {
    const selected = new Set(['mike', 'ava'])
    expect(matchesAssigneeFilter(obj(['ava']), selected)).toBe(true)
    expect(matchesAssigneeFilter(obj(['mike']), selected)).toBe(true)
    expect(matchesAssigneeFilter(obj(['bob']), selected)).toBe(false)
    expect(matchesAssigneeFilter(obj([]), selected)).toBe(false) // Unassigned not selected
  })

  it('Unassigned bucket only matches objectives with no assignees', () => {
    const selected = new Set([UNASSIGNED_TOKEN])
    expect(matchesAssigneeFilter(obj([]), selected)).toBe(true)
    expect(matchesAssigneeFilter(obj(['mike']), selected)).toBe(false)
  })

  it('empty selection matches nothing', () => {
    const selected = new Set<string>()
    expect(matchesAssigneeFilter(obj([]), selected)).toBe(false)
    expect(matchesAssigneeFilter(obj(['mike']), selected)).toBe(false)
  })
})

describe('assigneeRoster', () => {
  it('returns distinct usernames alpha-sorted, ignoring unassigned', () => {
    const roster = assigneeRoster([
      obj(['mike']),
      obj(['ava', 'mike']),
      obj([]),
      obj(undefined),
      obj(['ava']),
    ])
    expect(roster).toEqual(['ava', 'mike'])
  })
  it('supports arbitrary future users, nothing hardcoded', () => {
    expect(assigneeRoster([obj(['zoe']), obj(['newhire'])])).toEqual(['newhire', 'zoe'])
  })
})
