import { describe, it, expect } from 'vitest'
import { buildReviewerPrompt } from './session-manager.js'
import type { Objective } from '@operationkit/shared'

// Regression guard for the clock-gated `blocked` carve-out (distill 2026-08-15 P1, obj 706319).
//
// The `blocked`-verdict definition used to name exactly ONE non-worker-error carve-out —
// "awaits a human reply/approval". When an objective pins its deliverable to a FUTURE
// wall-clock event (a nightly cron, a shift-end time, a routine fire) and the adversarial
// reviewer is auto-spawned hours early, the reviewer had to improvise. Verified against
// `objective_reviews`:
//   - 706263 (reviewed 17:44Z, gated on the 2026-08-15 00:10Z nightly)
//   - 706247 (reviewed 17:38Z, live-apply gated to after 22:00 UTC by the objective's TIMING RULE)
//   - 706268 (reviewed 18:17Z, routine-816 fire at 21:00 UTC) — this one stamped EVERY criterion
//     [FAIL] for a state that provably could not exist, then improvised "re-run after 21:00 UTC".
// The prompt is the lever: the clock-gate must be a named carve-out, and per-criterion
// [FAIL] stamps for un-fired preconditions must be explicitly forbidden.
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

const locked = buildReviewerPrompt(makeObjective(), ['app/server/src/foo.ts'], null)
const firstPass = buildReviewerPrompt(
  makeObjective({ ai_review_iteration: 1, acceptance_criteria: undefined }),
  ['app/server/src/foo.ts'],
  null
)

describe('buildReviewerPrompt — blocked carve-out covers clock/schedule gates', () => {
  for (const [name, prompt] of [
    ['locked rubric (iteration 2+)', locked],
    ['first pass (iteration 1)', firstPass],
  ] as const) {
    describe(name, () => {
      it('names a SCHEDULED/CLOCK-GATED event as a blocked carve-out, not only a human reply', () => {
        expect(prompt).toMatch(/SCHEDULED\/CLOCK-GATED event/)
        // The pre-existing human-reply carve-out must survive alongside it.
        expect(prompt).toMatch(/HUMAN reply\/approval/)
        expect(prompt).toMatch(/present → await human → finalize/)
      })

      it('gives concrete gate shapes so the reviewer can recognize one', () => {
        expect(prompt).toMatch(/nightly cron/)
        expect(prompt).toMatch(/after 22:00 UTC/)
        expect(prompt).toMatch(/routine fire/)
      })

      it('forbids recording fail for BOTH carve-outs (fail respawns against an impossible state)', () => {
        expect(prompt).toMatch(/In BOTH cases this is NOT a worker error/)
        expect(prompt).toMatch(/do NOT record fail/)
        expect(prompt).toMatch(/cannot exist until the event happens/)
      })

      it('forbids stamping individual criteria [FAIL] when the precondition has not fired (the 706268 defect)', () => {
        expect(prompt).toMatch(/do NOT stamp individual criteria \[FAIL\] for artifacts whose precondition has not fired/)
        expect(prompt).toMatch(/mark those criteria \[BLOCKED\]/)
        expect(prompt).toMatch(/not-before timestamp/)
        // The findings template must actually offer [BLOCKED] as a per-criterion status.
        expect(prompt).toMatch(/\[PASS\|FAIL\|BLOCKED\]/)
      })

      it('still bars blocked as a softer alternative to fail', () => {
        expect(prompt).toMatch(/not as a softer alternative to fail/)
      })
    })
  }
})
