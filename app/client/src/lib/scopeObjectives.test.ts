import { describe, it, expect } from 'vitest'
import type { Objective } from '@operationkit/shared'
import { scopeObjectives } from './scopeObjectives'

// obj 700082 — the board's authoritative render-time scope gate. Proves an
// off-workspace objective is never rendered, however it lands in state.
function obj(id: number, workspace: string): Objective {
  return { id, title: `o${id}`, workspace, status: 'backlog' } as unknown as Objective
}

describe('scopeObjectives (obj 700082 render-time scope gate)', () => {
  const list = [obj(1, 'example2'), obj(2, 'example'), obj(3, 'example2'), obj(4, 'example-project')]

  it('drops every objective outside the active workspace', () => {
    const scoped = scopeObjectives(list, 'example2' as never)
    expect(scoped.map(o => o.id)).toEqual([1, 3])
    expect(scoped.every(o => o.workspace === 'example2')).toBe(true)
  })

  it('passes everything through in the all view', () => {
    expect(scopeObjectives(list, 'all' as never).map(o => o.id)).toEqual([1, 2, 3, 4])
  })

  it('returns empty when nothing matches the scope (no bleed, no crash)', () => {
    expect(scopeObjectives(list, 'nonexistent' as never)).toEqual([])
  })

  it('is race-free: re-scoping stale previous-workspace state hides it immediately', () => {
    // Simulate the mobile switch-lag: state still holds the OLD workspace's
    // objectives when the scope has already flipped to the new one.
    const staleFromExample = [obj(10, 'example'), obj(11, 'example')]
    expect(scopeObjectives(staleFromExample, 'example2' as never)).toEqual([])
  })

  it('multi-select keeps only the selected workspaces', () => {
    expect(scopeObjectives(list, ['example2', 'example'] as never).map(o => o.id)).toEqual([1, 2, 3])
  })

  it('empty array (All) passes everything through', () => {
    expect(scopeObjectives(list, [] as never).map(o => o.id)).toEqual([1, 2, 3, 4])
  })
})
