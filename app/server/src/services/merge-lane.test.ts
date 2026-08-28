import { describe, it, expect } from 'vitest'
import { classifyMergeLane, isMoneyPath, isRedLaneText } from './merge-lane.js'

const base = {
  type: 'task' as const,
  createPr: false,
  delegateMode: false,
  redPath: false,
  filesKnown: false,
  uiTouched: false,
}

describe('classifyMergeLane', () => {
  it('projects and delegator parents are red', () => {
    expect(classifyMergeLane({ ...base, type: 'project' })).toBe('red')
    expect(classifyMergeLane({ ...base, delegateMode: true })).toBe('red')
  })

  it('money/auth/migration text is red', () => {
    expect(classifyMergeLane({ ...base, redPath: true })).toBe('red')
  })

  it('plain tasks and bugs are green (CI is the gate, no LLM reviewer)', () => {
    expect(classifyMergeLane(base)).toBe('green')
    expect(classifyMergeLane({ ...base, type: 'bug' })).toBe('green')
  })

  it('backend-only PRs are green', () => {
    expect(classifyMergeLane({
      ...base,
      createPr: true,
      filesKnown: true,
      uiTouched: false,
    })).toBe('green')
  })

  it('UI PRs are yellow (keep Playwright reviewer)', () => {
    expect(classifyMergeLane({
      ...base,
      createPr: true,
      filesKnown: true,
      uiTouched: true,
    })).toBe('yellow')
  })

  it('create_pr with unknown files fails closed to yellow', () => {
    expect(classifyMergeLane({ ...base, createPr: true, filesKnown: false })).toBe('yellow')
  })
})

describe('isMoneyPath / isRedLaneText', () => {
  it('flags stripe/payout/commission', () => {
    expect(isMoneyPath({ title: 'Wire Stripe live charges' })).toBe(true)
    expect(isRedLaneText({ title: 'Wire Stripe live charges' })).toBe(true)
  })
  it('flags oauth/jwt/rls/migrations as red but not ordinary payment UI copy', () => {
    expect(isRedLaneText({ title: 'Tighten JWT cookie flags' })).toBe(true)
    expect(isRedLaneText({ title: 'Add RLS policy for leads' })).toBe(true)
    expect(isRedLaneText({ title: 'Orders page layout', description: 'show payment status' })).toBe(false)
    expect(isMoneyPath({ title: 'Orders page layout', description: 'show payment status' })).toBe(false)
  })
})
