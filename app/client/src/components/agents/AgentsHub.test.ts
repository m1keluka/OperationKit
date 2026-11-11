import { describe, it, expect } from 'vitest'
import { resolveAgentsTab } from './AgentsHub'

describe('one Agents page — tab resolution (obj 900495)', () => {
  it('defaults to the registry', () => {
    expect(resolveAgentsTab(new URLSearchParams(''))).toBe('registry')
  })
  it('honours ?tab=', () => {
    expect(resolveAgentsTab(new URLSearchParams('tab=templates'))).toBe('templates')
    expect(resolveAgentsTab(new URLSearchParams('tab=board'))).toBe('board')
  })
  it('old /agents?project=… links keep landing on the board-layer view', () => {
    expect(resolveAgentsTab(new URLSearchParams('project=12'))).toBe('board')
  })
  it('ignores an unknown tab', () => {
    expect(resolveAgentsTab(new URLSearchParams('tab=nope'))).toBe('registry')
  })
})
