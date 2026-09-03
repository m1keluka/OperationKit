import { describe, it, expect } from 'vitest'
import { buildReviewerPrompt } from './session-manager.js'
import type { Objective } from '@operationkit/shared'

// Minimal objective fixture — buildReviewerPrompt only reads a handful of
// fields, so we cast a partial through unknown rather than build the full row.
function makeObjective(overrides: Partial<Objective> = {}): Objective {
  return {
    id: 42,
    workspace: 'operator',
    type: 'feature',
    title: 'Test objective',
    description: 'do the thing',
    completion_goal: 'the thing is done',
    approved_plan: 'Plan: implement the thing.',
    ai_review_iteration: 2,
    acceptance_criteria: '[{"id":"x","criterion":"x","type":"functional","method":"api"}]',
    ...overrides,
  } as unknown as Objective
}

describe('buildReviewerPrompt — adversarial framing (QW3)', () => {
  const prompt = buildReviewerPrompt(makeObjective(), ['app/server/src/foo.ts'], null)

  it('(a) instructs the reviewer to assume the work is broken until proven otherwise', () => {
    expect(prompt).toMatch(/assume the work is broken/i)
    expect(prompt).toMatch(/burden of proof is on the deliverable/i)
    // It is explicitly NOT a "second optimist" / friendly second reviewer.
    expect(prompt).toMatch(/adversarial/i)
    expect(prompt).toMatch(/NOT a second pair of friendly eyes/i)
  })

  it('(b) defaults to a fail verdict under any uncertainty or missing evidence', () => {
    expect(prompt).toMatch(/default to a `fail` verdict|DEFAULT to a `fail`/i)
    expect(prompt).toMatch(/under any uncertainty/i)
    expect(prompt).toMatch(/absence of evidence is a fail/i)
    // Verdict semantics section reinforces fail-as-default.
    expect(prompt).toMatch(/default is fail — pass must be earned/i)
  })

  it('(c) requires a concrete artifact per acceptance criterion (prose alone = fail)', () => {
    expect(prompt).toMatch(/concrete artifact/i)
    expect(prompt).toMatch(/quoted command output/i)
    expect(prompt).toMatch(/file:line/i)
    expect(prompt).toMatch(/screenshot path/i)
    expect(prompt).toMatch(/api response/i)
    // A prose claim with no artifact must fail.
    expect(prompt).toMatch(/prose claim with no artifact behind it = fail/i)
  })

  it('(d) keeps the reviewer read-only-barred (must not run/modify code)', () => {
    expect(prompt).toMatch(/MAY NOT call Edit, Write, NotebookEdit/)
    expect(prompt).toMatch(/Read-only operations only/i)
    expect(prompt).toMatch(/Do NOT modify code/i)
  })

  it('asks for one verification pass (no repo tour / extra sub-agents)', () => {
    expect(prompt).toMatch(/one verification pass/i)
    expect(prompt).toMatch(/do not spawn sub-agents/i)
  })

  it('does not put backend-only PRs into test-agent / Playwright mode', () => {
    const p = buildReviewerPrompt(
      makeObjective({
        pr_number: 404,
        pr_url: 'https://github.com/your-org/command-center-infra/pull/404',
      } as Partial<Objective>),
      ['app/server/src/lib/host-disk.ts'],
      null,
    )
    expect(p).toMatch(/backend-only change/i)
    expect(p).not.toMatch(/TEST-AGENT MODE/)
  })

  it('keeps test-agent mode for UI PRs', () => {
    const p = buildReviewerPrompt(
      makeObjective({
        pr_number: 404,
        pr_url: 'https://github.com/your-org/command-center-infra/pull/404',
      } as Partial<Objective>),
      ['app/client/src/components/KanbanBoard.tsx'],
      null,
    )
    expect(p).toMatch(/TEST-AGENT MODE/)
  })

  it('first-pass (iteration 1, no locked rubric) is still adversarial', () => {
    const firstPass = buildReviewerPrompt(
      makeObjective({ ai_review_iteration: 1, acceptance_criteria: undefined }),
      [],
      null
    )
    expect(firstPass).toMatch(/assume the work is broken/i)
    expect(firstPass).toMatch(/DEFAULT to a `fail`/i)
    expect(firstPass).toMatch(/concrete artifact/i)
  })
})
