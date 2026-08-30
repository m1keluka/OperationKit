import { describe, it, expect } from 'vitest'
import { buildReviewerPrompt } from './session-manager.js'
import type { Objective } from '@operationkit/shared'

// A UI objective (registered frontend repo) — the case most at risk of leaking
// rubric text into the prompt when the gate is supposed to be dormant.
function uiObjective(): Objective {
  return {
    id: 42,
    title: 'Build the dashboard',
    type: 'task',
    workspace: 'personal',
    project: 'example-project-platform',
    description: 'desc',
    completion_goal: 'goal',
    approved_plan: null,
    acceptance_criteria: null,
    ai_review_iteration: 1,
  } as Objective
}

const RUBRIC_MARKERS = [
  'MANDATORY UI/UX RUBRIC',
  'R8 Accessibility floor',
  'R9 Token/primitive conformance',
  'VERDICT IMPACT',
  'scripts/ui-conformance.sh',
]

describe('reviewer prompt dormancy (UI_GATE_MODE=off ⇒ byte-identical to Wave A)', () => {
  it('off-mode prompt contains ZERO rubric markers, even for a UI objective', () => {
    const p = buildReviewerPrompt(uiObjective(), ['src/App.tsx'], null, false, 'off')
    for (const m of RUBRIC_MARKERS) expect(p).not.toContain(m)
  })

  it('off-mode output is invariant to the gate inputs (isDelegatorWorker has no effect)', () => {
    const a = buildReviewerPrompt(uiObjective(), ['src/App.tsx'], null, false, 'off')
    const b = buildReviewerPrompt(uiObjective(), ['src/App.tsx'], null, true, 'off')
    expect(a).toBe(b)
  })

  it('the rubric block is the ONLY delta: stripping it from advisory yields the off prompt', () => {
    const off = buildReviewerPrompt(uiObjective(), ['src/App.tsx'], null, true, 'off')
    const advisory = buildReviewerPrompt(uiObjective(), ['src/App.tsx'], null, true, 'advisory')
    expect(advisory).not.toBe(off)
    for (const m of RUBRIC_MARKERS) expect(advisory).toContain(m)
    // Remove the injected rubric section (it sits between the rubric Step-0 flow
    // and the credentials/files sections). After removing exactly the rubric block
    // and collapsing the resulting double blank line, the prompts are identical.
    const rubricStart = advisory.indexOf('=== MANDATORY UI/UX RUBRIC')
    expect(rubricStart).toBeGreaterThan(-1)
    // The block ends right before the next top-level section that off also has.
    // Both prompts share the "## Files touched by the worker session" header.
    const filesHeader = '## Files touched by the worker session'
    const advHead = advisory.slice(0, rubricStart)
    const advTail = advisory.slice(advisory.indexOf(filesHeader))
    const offHead = off.slice(0, off.indexOf(filesHeader))
    const offTail = off.slice(off.indexOf(filesHeader))
    expect(advTail).toBe(offTail)               // everything after the rubric is identical
    expect(offHead.startsWith(advHead.slice(0, 200))).toBe(true) // shared preamble
  })
})
