/**
 * obj 708817 — the create form no longer collects a completion goal, so
 * `completion_goal` is NULL for every human-created objective. Every prompt
 * that used to lean on it must degrade to the title + description instead of
 * emitting an empty or half-written section.
 *
 * This file locks that in for all three prompt surfaces:
 *   - the worker session prompt   (prompt-builder.ts)
 *   - the AI-review prompt        (session-reviewer-prompt.ts)
 *   - the planner prompt          (session-planner-prompt.ts)
 */
import { describe, it, expect, beforeAll } from 'vitest'
import os from 'os'
import path from 'path'

const TMP_DB = path.join(os.tmpdir(), `cc-completion-goal-null-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB

import { initDb } from '../db/index.js'
import { buildPrompt } from './prompt-builder.js'
import { buildReviewerPrompt } from './session-reviewer-prompt.js'
import { buildPlannerPrompt } from './session-planner-prompt.js'
import type { Objective } from '@command-center/shared'

beforeAll(() => {
  initDb()
})

function makeObjective(overrides: Partial<Objective> = {}): Objective {
  return {
    id: 999123,
    title: 'Ship the simplified create form',
    description: 'Strip the objective create modal down to title + description.',
    status: 'working',
    agent_context: 'cto',
    workspace: 'personal',
    project: null,
    category: 'general',
    parent_id: null,
    depth: 0,
    assigned_user_id: null,
    routine_id: null,
    created_by: null,
    session_id: null,
    transcript_path: null,
    last_session_summary: null,
    session_count: 0,
    total_cost_usd: 0,
    total_tokens: 0,
    has_blockers: false,
    delegate_mode: false,
    create_pr: false,
    branch_name: null,
    pr_url: null,
    pr_number: null,
    completion_goal: null,
    workflow_hint: null,
    effort: 'normal',
    model: 'default',
    type: 'task',
    approved_plan: null,
    plan_approved_at: null,
    planning_session_id: null,
    ai_review_verdict: null,
    ai_review_findings: null,
    ai_review_session_id: null,
    skip_ai_review: false,
    acceptance_criteria: null,
    ai_review_iteration: 0,
    test_cred_slug: null,
    created_at: '2026-08-27T00:00:00Z',
    updated_at: '2026-08-27T00:00:00Z',
    ...overrides,
  } as Objective
}

/**
 * Every emitted heading must be followed by real prose, not a blank tail and not
 * another heading at the SAME or shallower depth (a deeper `###` sub-heading is
 * legitimate nesting, e.g. `## Session Context` → `### Knowledge Gaps`).
 */
function assertNoEmptySections(text: string) {
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const m = /^(#+) /.exec(lines[i])
    if (!m) continue
    const depth = m[1].length
    const next = lines.slice(i + 1).find(l => l.trim() !== '')
    expect(next, `empty section: ${lines[i]}`).toBeDefined()
    const nextHeading = /^(#+) /.exec(next!)
    if (nextHeading) {
      expect(
        nextHeading[1].length > depth,
        `section with no body: ${lines[i]} (followed by ${next})`,
      ).toBe(true)
    }
  }
}

describe('session prompt — completion_goal is null (obj 708817)', () => {
  it('emits a completion-goal section that falls back to the title + description', () => {
    const prompt = buildPrompt(makeObjective())
    expect(prompt).toContain('## Completion Goal (HARD REQUIREMENT)')
    expect(prompt).toContain('No separate completion goal was supplied')
    expect(prompt).toContain('Ship the simplified create form')
    expect(prompt).toContain('the description above')
  })

  it('never emits an empty or dangling section', () => {
    assertNoEmptySections(buildPrompt(makeObjective()))
  })

  it('still emits the hard-requirement block verbatim when a goal IS set', () => {
    const prompt = buildPrompt(makeObjective({ completion_goal: 'The PR is merged and green.' }))
    expect(prompt).toContain('Do NOT declare this objective done until the following criterion is met:')
    expect(prompt).toContain('The PR is merged and green.')
    expect(prompt).not.toContain('No separate completion goal was supplied')
  })
})

describe('AI-review prompt — completion_goal is null (obj 708817)', () => {
  function review(obj: Objective) {
    return buildReviewerPrompt(obj, [], null)
  }

  it('names the title + description as the acceptance bar instead of a blank goal', () => {
    const prompt = review(makeObjective())
    expect(prompt).toContain('## Completion Goal')
    expect(prompt).toContain('(none set for this objective')
    expect(prompt).toContain('Title and Description above')
    // The old code emitted '' here, which left "## Description" immediately
    // followed by "## Approved Plan" with nothing between the two headings.
    expect(prompt).not.toMatch(/## Completion Goal\n\n?## /)
  })

  it('never emits an empty or dangling section', () => {
    assertNoEmptySections(review(makeObjective()))
  })

  it('passes the real goal through when one is set', () => {
    const prompt = review(makeObjective({ completion_goal: 'Board renders with no category tabs.' }))
    expect(prompt).toContain('Board renders with no category tabs.')
    expect(prompt).not.toContain('(none set for this objective')
  })
})

describe('planner prompt — completion_goal is null (obj 708817)', () => {
  it('falls back to the objective title + context', () => {
    const prompt = buildPlannerPrompt(makeObjective())
    expect(prompt).toContain('Completion goal: (none set')
    expect(prompt).toContain('Ship the simplified create form')
  })

  it('passes the real goal through when one is set', () => {
    const prompt = buildPlannerPrompt(makeObjective({ completion_goal: 'Plan approved by Operator.' }))
    expect(prompt).toContain('Completion goal: Plan approved by Operator.')
  })
})
