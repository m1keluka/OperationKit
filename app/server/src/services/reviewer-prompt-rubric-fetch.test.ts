import { describe, it, expect } from 'vitest'
import { buildReviewerPrompt } from './session-manager.js'
import type { Objective } from '@command-center/shared'

// Regression guard for the shared-/tmp rubric clobber (distill 2026-08-14, obj 706156).
//
// Reviewer sessions all run as the same OS user and share /tmp. Three reviews
// (706102/706096/706100) fetched their locked rubric with `curl -s -o /tmp/crit.json`,
// the fetch failed mid server-restart (HTTP 000), `curl -o` did NOT truncate the file,
// and each read a SIBLING objective's (706093) 2038-byte rubric — then correctly emitted
// a FALSE `blocked`. The prompt is the only lever: it must (a) never model a fixed shared
// scratch path, (b) require a fail-fast fetch, and (c) classify a stale/failed fetch as a
// RE-FETCH condition rather than a block.
function makeObjective(overrides: Partial<Objective> = {}): Objective {
  return {
    id: 42,
    workspace: 'personal',
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

describe('buildReviewerPrompt — rubric fetch is clobber-safe', () => {
  for (const [name, prompt] of [
    ['locked rubric (iteration 2+)', locked],
    ['first pass (iteration 1)', firstPass],
  ] as const) {
    describe(name, () => {
      it('never instructs a WRITE to a fixed, non-id-scoped shared scratch path', () => {
        // `/tmp/crit.json` may appear — but only as the named anti-pattern in prose,
        // never as the target of a write operator (`-o`, `>`, `tee`).
        const writes = prompt.match(/(?:-o|>|\btee\b)\s+(\/tmp\/[\w.-]+)/g) ?? []
        for (const w of writes) {
          expect(w).toContain('42')
        }
      })

      it('warns that /tmp is shared and a failed `curl -o` does not truncate', () => {
        expect(prompt).toMatch(/SHARE `\/tmp`/)
        expect(prompt).toMatch(/does NOT truncate/i)
      })

      it('uses a fail-fast curl so a failed fetch is detectable', () => {
        expect(prompt).toMatch(/curl -fsS/)
      })
    })
  }

  it('treats a stale/mismatched rubric as a RE-FETCH condition, not a block', () => {
    expect(locked).toMatch(/RE-FETCH condition, NOT a block/i)
    expect(locked).toMatch(/stale\/foreign rubric/i)
    // A block is only licensed once the endpoint is actually reachable.
    expect(locked).toMatch(/Only\s*\n?emit `<verdict>blocked<\/verdict>` when the endpoint is reachable/)
  })
})
