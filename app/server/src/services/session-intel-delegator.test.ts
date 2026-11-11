import { describe, it, expect } from 'vitest'
import { buildSummaryPrompt, coerceSummary } from './session-intel-summary.js'
import type { DeterministicIntel } from './session-intel-parse.js'
import type { Objective } from '@operationkit/shared'

// Regression coverage for the 2026-08-09 distill finding (obj 705171): session_intel
// mislabelled healthy delegate_mode wakes. Two effects, both fixed here:
//   1. coerceSummary defaulted any non-review session's outcome to `partial`, so a
//      delegator that ended its wake without self-asserting "success" was stamped
//      partial — 72% of delegator wakes vs 3% of worker wakes in the window.
//   2. buildSummaryPrompt's anti-fabrication guard was gated on isReview only, so the
//      summarizer read a delegator's (legitimately) empty file list as "nothing built"
//      and invented blockers ("UI mockup not yet created" on obj 705040, "no files
//      created — implementation has not yet begun" on obj 705045) that a grep proved
//      appear NOWHERE in those transcripts. Both objectives had every child done +
//      review-pass, a live preview, and a merged PR.
// This is the delegate_mode twin of the isReview fix in session-intel-verdict.test.ts.

// The shape a healthy delegator wake actually has: no app files touched (it only
// edits NOTES.md and spawns workers via curl), tool calls and a sub-agent spawn.
const delegatorIntel: DeterministicIntel = {
  filesCreated: [],
  filesModified: [],
  commandsRun: 4,
  toolCalls: 9,
  errors: [],
  exitCode: 0,
  totalTokens: 0,
  totalCost: 0,
  startedAt: '2026-08-09T00:00:00Z',
  endedAt: '2026-08-09T00:05:00Z',
  durationMs: 300000,
  skillsUsed: [],
  agentsInvoked: ['cto'],
  subagentsSpawned: ['general-purpose'],
  modelUsage: {},
  dailyUsage: [],
  truncatedByUsageLimit: false,
}

// A build-flavored description is exactly what tricked the summarizer into
// narrating "the UI mockup was not created" for an orchestration-only wake.
const delegatorObjective = {
  id: 705040,
  title: 'Finances preview surface',
  description: 'Design and ship the finances preview UI with a commission tranche breakdown.',
  delegate_mode: true,
} as unknown as Objective

describe('coerceSummary — delegator wakes are not defaulted to partial', () => {
  it('a delegator summary with no self-asserted outcome defaults to success, not partial', () => {
    const parsed = coerceSummary(
      { summary: 'Spawned W1-W5 and confirmed all five workers merged.' },
      false,
      true
    )
    expect(parsed?.outcome).toBe('success')
  })

  it('a plain worker with no self-asserted outcome still defaults to partial', () => {
    const parsed = coerceSummary({ summary: 'Started the refactor.' }, false, false)
    expect(parsed?.outcome).toBe('partial')
  })

  it('an explicit outcome from the model always wins over the delegator default', () => {
    const blocked = coerceSummary(
      { summary: 'Waiting on Operator for the commission tranche rule.', outcome: 'blocked' },
      false,
      true
    )
    expect(blocked?.outcome).toBe('blocked')
  })
})

describe('buildSummaryPrompt — anti-fabrication guard for delegator sessions', () => {
  it('forbids inventing "not built" blockers from an empty file list', () => {
    const p = buildSummaryPrompt(delegatorIntel, delegatorObjective, false, null, true)
    expect(p).toContain('DELEGATOR session')
    // The literal fabrications observed on obj 705040 / 705045 must be named.
    expect(p).toContain('UI mockup not created')
    expect(p.replace(/\s+/g, ' ')).toContain('implementation not begun')
    expect(p).toContain('no files created')
    expect(p).toContain("Report a blocker ONLY if the delegator's own output explicitly states one")
  })

  it('tells the summarizer a delegator that advanced its plan is a success', () => {
    const p = buildSummaryPrompt(delegatorIntel, delegatorObjective, false, null, true)
    expect(p).toContain('"outcome":"success" whenever the delegator advanced')
    expect(p).toContain('Only use "partial"/"blocked" if the delegator ITSELF')
  })

  it('the delegator block is absent for a normal worker session — old behavior preserved', () => {
    const p = buildSummaryPrompt(delegatorIntel, delegatorObjective, false, null, false)
    expect(p).not.toContain('DELEGATOR session')
  })

  it('the delegator block does not displace the existing review guard', () => {
    const p = buildSummaryPrompt(delegatorIntel, delegatorObjective, true, 'fail', false)
    expect(p).toContain('This is an AI-REVIEW session')
    expect(p).not.toContain('DELEGATOR session')
  })
})
