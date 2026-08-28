import { describe, it, expect } from 'vitest'
import { decideAutoMerge, isMoneyPath, type AutoMergeInputs } from './auto-merge.js'

function inputs(p: Partial<AutoMergeInputs>): AutoMergeInputs {
  return {
    enabled: false,
    hasPr: true,
    prNumber: 99,
    harnessStatus: 'success',
    reviewVerdict: 'pass',
    objectiveType: 'task',
    ...p,
  }
}

describe('decideAutoMerge — gates', () => {
  it('skips when there is no PR', () => {
    expect(decideAutoMerge(inputs({ hasPr: false, prNumber: null })).action).toBe('skip')
  })

  it('skips project-type objectives (route to human review)', () => {
    const d = decideAutoMerge(inputs({ objectiveType: 'project', enabled: true }))
    expect(d.action).toBe('skip')
    expect(d.reason).toMatch(/human review/)
  })

  it('skips when review verdict is not pass', () => {
    expect(decideAutoMerge(inputs({ reviewVerdict: 'fail', enabled: true })).action).toBe('skip')
    expect(decideAutoMerge(inputs({ reviewVerdict: 'blocked', enabled: true })).action).toBe('skip')
    expect(decideAutoMerge(inputs({ reviewVerdict: null, enabled: true })).action).toBe('skip')
  })

  it('skips when harness status is not green', () => {
    expect(decideAutoMerge(inputs({ harnessStatus: 'failure', enabled: true })).action).toBe('skip')
    expect(decideAutoMerge(inputs({ harnessStatus: 'pending', enabled: true })).action).toBe('skip')
    expect(decideAutoMerge(inputs({ harnessStatus: 'unknown', enabled: true })).action).toBe('skip')
  })
})

describe('decideAutoMerge — switch behavior (OFF by default)', () => {
  it('all gates green but switch OFF → dry-run (would merge, but does not)', () => {
    const d = decideAutoMerge(inputs({ enabled: false }))
    expect(d.action).toBe('dry-run')
    expect(d.reason).toMatch(/WOULD auto-merge/)
    expect(d.reason).toMatch(/OFF/)
  })

  it('all gates green AND switch ON → merge', () => {
    const d = decideAutoMerge(inputs({ enabled: true }))
    expect(d.action).toBe('merge')
    expect(d.reason).toMatch(/auto-merging/)
  })

  it('switch ON but a gate red → still skip (never merges un-green)', () => {
    expect(decideAutoMerge(inputs({ enabled: true, harnessStatus: 'failure' })).action).toBe('skip')
    expect(decideAutoMerge(inputs({ enabled: true, reviewVerdict: 'fail' })).action).toBe('skip')
  })

  it('default-constructed inputs (enabled omitted) never merge', () => {
    // Safety: the absence of an explicit enable must not merge.
    const d = decideAutoMerge(inputs({}))
    expect(d.action).not.toBe('merge')
  })

  it('skips when the PR is behind/blocked/dirty', () => {
    const d = decideAutoMerge(inputs({ enabled: true, unsafe: true }))
    expect(d.action).toBe('skip')
    expect(d.reason).toMatch(/behind/)
  })

  it('skips money-path objectives even when green', () => {
    const d = decideAutoMerge(inputs({ enabled: true, moneyPath: true }))
    expect(d.action).toBe('skip')
    expect(d.reason).toMatch(/money-path/)
  })
})

describe('isMoneyPath', () => {
  it('flags stripe/payout/commission titles', () => {
    expect(isMoneyPath({ title: 'Wire Stripe live charges', description: '' })).toBe(true)
    expect(isMoneyPath({ title: 'Fix commission math', description: '' })).toBe(true)
    expect(isMoneyPath({ title: 'Add payout export', description: '' })).toBe(true)
  })
  it('does not flag ordinary payment UI copy', () => {
    expect(isMoneyPath({ title: 'Orders page layout', description: 'show payment status' })).toBe(false)
  })
})
