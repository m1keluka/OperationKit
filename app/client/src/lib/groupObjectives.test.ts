// @vitest-environment node
import { describe, it, expect } from 'vitest'
import type { Objective } from '@command-center/shared'
import { groupObjectives } from './groupObjectives'

// Minimal Objective factory — only the fields groupObjectives reads matter.
function obj(id: number, over: Partial<Objective> = {}): Objective {
  return {
    id,
    title: `obj ${id}`,
    parent_id: null,
    delegate_mode: false,
    workflow_hint: null,
    status: 'queue',
    ...over,
  } as Objective
}

describe('groupObjectives', () => {
  it('keeps plain top-level objectives as cards', () => {
    const { topLevel, childrenByParent } = groupObjectives([obj(1), obj(2)])
    expect(topLevel.map(o => o.id)).toEqual([1, 2])
    expect(childrenByParent.size).toBe(0)
  })

  it('nests delegator workers under their parent', () => {
    const parent = obj(1, { delegate_mode: true })
    const w1 = obj(2, { parent_id: 1 })
    const w2 = obj(3, { parent_id: 1 })
    const { topLevel, childrenByParent } = groupObjectives([parent, w1, w2])
    expect(topLevel.map(o => o.id)).toEqual([1])
    expect(childrenByParent.get(1)?.map(o => o.id)).toEqual([2, 3])
  })

  it('nests [Review]/adversarial children under a NON-delegator parent (the bug)', () => {
    const parent = obj(10, { title: 'Ship feature X' }) // normal objective, not delegate_mode
    const review = obj(11, { parent_id: 10, title: '[Review] Ship feature X', workflow_hint: 'adversarial' })
    const { topLevel, childrenByParent } = groupObjectives([parent, review])
    // The review must NOT appear as a second top-level card.
    expect(topLevel.map(o => o.id)).toEqual([10])
    expect(childrenByParent.get(10)?.map(o => o.id)).toEqual([11])
  })

  it('sorts nested children by id ascending', () => {
    const parent = obj(1, { delegate_mode: true })
    const { childrenByParent } = groupObjectives([parent, obj(5, { parent_id: 1 }), obj(3, { parent_id: 1 })])
    expect(childrenByParent.get(1)?.map(o => o.id)).toEqual([3, 5])
  })

  it('keeps an orphaned child top-level when its parent is absent', () => {
    const orphan = obj(2, { parent_id: 999 }) // parent not in the list
    const { topLevel, childrenByParent } = groupObjectives([obj(1), orphan])
    expect(topLevel.map(o => o.id)).toEqual([1, 2])
    expect(childrenByParent.size).toBe(0)
  })

  it('excludes strategies and their managed children from the main board (UI-B)', () => {
    const strategy = obj(1, { is_strategy: true, delegate_mode: true })
    const managedChild = obj(2, { parent_id: 1, strategy_id: 1 }) // owned via parent chain
    const associated = obj(3, { strategy_id: 1 })                 // associated, no parent
    const ordinary = obj(4)                                       // plain board card
    const { topLevel } = groupObjectives([strategy, managedChild, associated, ordinary])
    // Only the ordinary objective survives on the flat board.
    expect(topLevel.map(o => o.id)).toEqual([4])
  })

  it('keeps a self-referencing delegator (is_strategy=0, strategy_id == own id) top-level (obj 1684)', () => {
    // RealTrends scraper obj 1684: status=review, is_strategy=0, strategy_id=1684.
    const selfRef = obj(1684, { is_strategy: false, strategy_id: 1684, status: 'review' })
    const { topLevel } = groupObjectives([obj(1), selfRef])
    expect(topLevel.map(o => o.id)).toEqual([1, 1684])
  })

  it('keeps an orphaned strategy-member top-level when no is_strategy=1 row matches (obj 1814)', () => {
    // Omar Hamdy agreement obj 1814: done, is_strategy=0, strategy_id=1814, but no
    // is_strategy=1 row with id 1814 is present in the dataset.
    const orphanMember = obj(1814, { is_strategy: false, strategy_id: 1814, status: 'done' })
    const { topLevel } = groupObjectives([obj(1), orphanMember])
    expect(topLevel.map(o => o.id)).toEqual([1, 1814])
  })

  it('keeps a strategy-member top-level when its strategy id has no is_strategy=1 row (orphan)', () => {
    // strategy_id points elsewhere, but that row is absent / not a strategy.
    const orphanMember = obj(2, { strategy_id: 999 })
    const { topLevel } = groupObjectives([obj(1), orphanMember])
    expect(topLevel.map(o => o.id)).toEqual([1, 2])
  })

  it('keeps an objective with strategy_id=null top-level (unchanged)', () => {
    const { topLevel } = groupObjectives([obj(1, { strategy_id: null })])
    expect(topLevel.map(o => o.id)).toEqual([1])
  })

  it('removes a genuine strategy (is_strategy=1) from the board (unchanged)', () => {
    const strategy = obj(1, { is_strategy: true })
    const { topLevel } = groupObjectives([strategy, obj(2)])
    expect(topLevel.map(o => o.id)).toEqual([2])
  })

  it('removes a genuine managed child whose strategy_id -> a present is_strategy=1 row (unchanged)', () => {
    const strategy = obj(1, { is_strategy: true })
    const child = obj(2, { strategy_id: 1 }) // points at a real, present strategy
    const { topLevel } = groupObjectives([strategy, child, obj(3)])
    expect(topLevel.map(o => o.id)).toEqual([3])
  })

  it('keeps ordinary delegator workers on the board when no strategy is involved', () => {
    const parent = obj(1, { delegate_mode: true })   // delegator, NOT a strategy
    const worker = obj(2, { parent_id: 1 })           // nested inside parent's card
    const { topLevel } = groupObjectives([parent, worker])
    // The non-strategy delegator still renders; only its worker is nested away.
    expect(topLevel.map(o => o.id)).toEqual([1])
  })
})
