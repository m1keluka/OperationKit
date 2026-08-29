import { describe, it, expect, afterEach, beforeAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

// buildPrompt → buildContext → getDb(), so the DB must be initialized before the
// worker-variant assertions run. Same throwaway-temp-file pattern as
// prompt-builder.test.ts (pid + timestamp so a stale schema is never reused).
const TMP_DB = path.join(os.tmpdir(), `cc-reviewer-mask-test-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB

// Redirect the objective-memory root at a temp dir. The host path exists and is writable;
// a CI runner has no /home/operator, so the artifact-PUBLISHED branch could not be exercised
// there at all. Every assertion below goes through the path helpers rather than a literal,
// so the redirect is invisible to what is being tested.
//
// This assignment runs AFTER the imports below (ESM hoists them), which is precisely why
// `objectiveMemoryRoot()` resolves the env per call rather than once at module scope.
const TMP_MEM_ROOT = path.join(os.tmpdir(), `cc-objmem-${process.pid}-${Date.now()}`)
process.env.CC_OBJECTIVE_MEMORY_ROOT = TMP_MEM_ROOT

import { initDb } from '../db/index.js'
import { buildReviewerPrompt } from './session-manager.js'
import {
  buildPrompt,
  buildReviewerArtifactBlock,
  objectiveArtifactPath,
  objectiveScratchPath,
  objectiveMemoryDir,
  maskWorkerScratch,
  WORKER_SCRATCH_REDACTION,
  DEFAULT_OBJECTIVE_MEMORY_ROOT,
} from './prompt-builder.js'
import type { Objective } from '@command-center/shared'

/**
 * P1-1 (obj 707060) — the REVIEWER CAUSAL MASK.
 *
 * The reviewer reads the TOP of the worker's producer stack (final artifact +
 * locked acceptance criteria) and is masked off the worker's mid-stack scratch
 * (objective-memory/<id>/NOTES.md). The worker keeps full access to its OWN
 * scratch — the mask is one-directional, on the reviewer edge only.
 *
 * NOTE ON THE ASSERTIONS BELOW: they check for the literal substring 'NOTES.md'
 * in the reviewer prompt, not just the full path. That is deliberate and stronger
 * than the leak it guards: naming the file even inside a prohibition ("do not read
 * NOTES.md") still puts the filename in front of the model and invites a read. The
 * mask prose therefore describes the scratch by ROLE, never by name.
 */

const SCRATCH_BASENAME = ['NOTES', 'md'].join('.')

function makeObjective(overrides: Partial<Objective> = {}): Objective {
  return {
    id: 707060,
    workspace: 'personal',
    project: 'command-center-infra',
    agent_context: 'cto',
    type: 'feature',
    status: 'ai_review',
    title: 'Test objective',
    description: 'do the thing',
    completion_goal: 'the thing is done',
    approved_plan: 'Plan: implement the thing.',
    branch_name: 'cc/obj-707060-test',
    last_session_summary: 'I shipped the thing and opened PR 999.',
    ai_review_iteration: 2,
    acceptance_criteria:
      '[{"id":"mask-applied","criterion":"reviewer sees artifact not scratch","type":"functional","method":"api"}]',
    ...overrides,
  } as unknown as Objective
}

const createdArtifacts: string[] = []
function writeArtifactFor(id: number, body: string): string {
  const p = objectiveArtifactPath(id)
  fs.mkdirSync(objectiveMemoryDir(id), { recursive: true })
  fs.writeFileSync(p, body)
  createdArtifacts.push(p)
  return p
}

beforeAll(() => {
  initDb()
})

afterEach(() => {
  while (createdArtifacts.length) {
    const p = createdArtifacts.pop()!
    try { fs.rmSync(p, { force: true }) } catch { /* best effort */ }
  }
})

describe('test fixture integrity', () => {
  // The redirect above is the ONLY thing keeping this suite off a host path, and its
  // failure mode is silent: on this host /home/operator/ai-workspace IS writable, so a
  // fixture that quietly falls back to the real root passes locally and fails on CI
  // with EACCES. It did exactly that once. Assert the redirect actually took, so the
  // regression surfaces here — with an intelligible message — rather than as a
  // mkdir error 100 lines further down.
  it('guards the redirect: no path under test touches the production memory root', () => {
    expect(objectiveMemoryDir(707060)).toBe(`${TMP_MEM_ROOT}/707060`)
    for (const p of [objectiveArtifactPath(707060), objectiveScratchPath(707060)]) {
      expect(p.startsWith(TMP_MEM_ROOT), `${p} escaped the temp root`).toBe(true)
      expect(p).not.toContain(DEFAULT_OBJECTIVE_MEMORY_ROOT)
    }
  })
})

describe('reviewer prompt is MASKED off the worker scratch (P1-1)', () => {
  it('carries no objective-memory scratch path and never names the scratch file', () => {
    const prompt = buildReviewerPrompt(makeObjective(), ['app/server/src/foo.ts'], null)

    // The exact path the worker was handed must not appear.
    expect(prompt).not.toContain(objectiveScratchPath(707060))
    // Nor the bare filename anywhere in the prompt — including inside a prohibition.
    expect(prompt).not.toContain(SCRATCH_BASENAME)
  })

  // REGRESSION (found by rendering THIS objective's real DB row end-to-end, not by a
  // fixture): `title` and the acceptance-criteria TEXT are echoed prose too, and a
  // meta-objective ABOUT the mask spells the scratch name out in both. They were not
  // routed through maskWorkerScratch, so the real prompt still carried the basename —
  // and since the prompt must print the objective-memory DIRECTORY to point at the
  // artifact, a surviving basename reconstructs the full path. Both are masked now.
  it('masks the scratch name arriving via the TITLE', () => {
    const prompt = buildReviewerPrompt(makeObjective({
      title: `P1-1: reviewer mask — inject artifact, NOT the worker's ${SCRATCH_BASENAME} scratch`,
    } as unknown as Partial<Objective>), [], null)
    expect(prompt).not.toContain(SCRATCH_BASENAME)
    expect(prompt).toContain(WORKER_SCRATCH_REDACTION)
  })

  it('masks the scratch name arriving via the ACCEPTANCE CRITERIA text', () => {
    const prompt = buildReviewerPrompt(makeObjective({
      acceptance_criteria: JSON.stringify([{
        id: 'review-prompt-masked',
        criterion: `the review prompt contains NO objective-memory ${SCRATCH_BASENAME} path`,
        type: 'functional',
        method: 'api',
      }]),
    } as unknown as Partial<Objective>), [], null)
    expect(prompt).not.toContain(SCRATCH_BASENAME)
    // The criterion is still gradable — id and shape survive, only the pointer is redacted.
    expect(prompt).toContain('[review-prompt-masked]')
    expect(prompt).toContain('the review prompt contains NO objective-memory')
  })

  it('holds the mask across every prompt variant (first pass, PR/test-agent, no branch)', () => {
    const variants: Array<[string, string]> = [
      ['first pass, no locked rubric', buildReviewerPrompt(
        makeObjective({ ai_review_iteration: 1, acceptance_criteria: undefined }), [], null)],
      ['PR / test-agent mode', buildReviewerPrompt(
        makeObjective({ pr_number: 999, pr_url: 'https://github.com/x/y/pull/999' } as Partial<Objective>),
        ['app/client/src/App.tsx'], null)],
      ['no branch, no summary, no criteria', buildReviewerPrompt(
        makeObjective({ branch_name: null, last_session_summary: null, acceptance_criteria: null } as Partial<Objective>),
        [], null)],
      ['delegator worker + test creds', buildReviewerPrompt(
        makeObjective(), ['app/server/src/foo.ts'],
        { slug: 's', loginUrl: 'https://x', fieldNames: ['user'] }, true)],
    ]
    for (const [label, prompt] of variants) {
      expect(prompt, `variant: ${label}`).not.toContain(SCRATCH_BASENAME)
      expect(prompt, `variant: ${label}`).not.toContain(objectiveScratchPath(707060))
    }
  })

  it('states the mask explicitly so the reviewer does not go hunting for scratch', () => {
    const prompt = buildReviewerPrompt(makeObjective(), [], null)
    expect(prompt).toMatch(/masked off the worker's mid-run working files/i)
    expect(prompt).toMatch(/do not open\s+the worker's private scratch files/i)
  })
})

describe('the mask survives echoed free text (P1-1)', () => {
  // The reviewer prompt does not only emit strings WE author — it echoes the
  // objective's description, completion goal, approved plan, and the worker's own
  // final summary. Delegator-authored briefs routinely spell the scratch path out
  // ("persist state to <dir>/NOTES.md"), and THIS objective's own description does
  // so repeatedly. A mask built only from "we never add the pointer ourselves"
  // would therefore leak on exactly the objectives that care about it most.
  const leak = `${objectiveScratchPath(707060)} holds the running state`

  it('redacts a scratch pointer arriving via description / goal / plan / summary', () => {
    for (const field of ['description', 'completion_goal', 'approved_plan', 'last_session_summary'] as const) {
      const prompt = buildReviewerPrompt(
        makeObjective({ [field]: leak } as unknown as Partial<Objective>), [], null)
      expect(prompt, `via ${field}`).not.toContain(SCRATCH_BASENAME)
      expect(prompt, `via ${field}`).not.toContain(objectiveScratchPath(707060))
      expect(prompt, `via ${field}`).toContain(WORKER_SCRATCH_REDACTION)
    }
  })

  it('redacts only the scratch pointer, leaving the surrounding prose intact', () => {
    const prompt = buildReviewerPrompt(
      makeObjective({ description: leak } as unknown as Partial<Objective>), [], null)
    expect(prompt).toContain('holds the running state')
  })

  it('maskWorkerScratch handles bare names, foreign ids, and empty input', () => {
    expect(maskWorkerScratch(null)).toBe('')
    expect(maskWorkerScratch(undefined)).toBe('')
    expect(maskWorkerScratch('')).toBe('')
    // Any objective id, not just this one.
    expect(maskWorkerScratch(objectiveScratchPath(12345))).toBe(WORKER_SCRATCH_REDACTION)
    // A bare mention with no path is still a pointer at the scratch file.
    expect(maskWorkerScratch(`read ${SCRATCH_BASENAME} first`)).toBe(`read ${WORKER_SCRATCH_REDACTION} first`)
    // Unrelated text is untouched.
    expect(maskWorkerScratch('see ARTIFACT.md')).toBe('see ARTIFACT.md')
  })
})

describe('reviewer prompt INJECTS the artifact + acceptance criteria (P1-1)', () => {
  it('points at the published ARTIFACT.md when the worker wrote one', () => {
    const id = 707060
    writeArtifactFor(id, '# Artifact\nShipped the mask.\n')
    const prompt = buildReviewerPrompt(makeObjective({ id } as Partial<Objective>), [], null)

    expect(prompt).toContain(objectiveArtifactPath(id))
    expect(prompt).toMatch(/published its final artifact at/i)
    // Still a claim to be verified, not evidence.
    expect(prompt).toMatch(/treat it as a\s+CLAIM to be verified/i)
  })

  it('falls back to branch / PR / final summary when no artifact was published', () => {
    // Use an id with no artifact on disk.
    const obj = makeObjective({ id: 999707060 } as Partial<Objective>)
    expect(fs.existsSync(objectiveArtifactPath(999707060))).toBe(false)
    const prompt = buildReviewerPrompt(obj, [], null)

    expect(prompt).toMatch(/published no final artifact/i)
    expect(prompt).toContain('cc/obj-707060-test')
    expect(prompt).toContain('I shipped the thing and opened PR 999.')
    expect(prompt).toMatch(/a CLAIM, not evidence/i)
  })

  it('injects the locked acceptance criteria inline (not just a fetch URL)', () => {
    const prompt = buildReviewerPrompt(makeObjective(), [], null)
    expect(prompt).toContain('[mask-applied] reviewer sees artifact not scratch')
    expect(prompt).toMatch(/Acceptance criteria \(the bar — grade against EXACTLY these\)/)
    expect(prompt).toMatch(/Invent no new bar/i)
  })

  it('degrades gracefully when no rubric is locked yet', () => {
    const prompt = buildReviewerPrompt(
      makeObjective({ acceptance_criteria: null } as Partial<Objective>), [], null)
    expect(prompt).toMatch(/No rubric is locked on this objective yet/i)
  })

  it('tolerates acceptance_criteria arriving as a parsed array or as malformed JSON', () => {
    const asArray = buildReviewerPrompt(makeObjective({
      acceptance_criteria: [
        { id: 'a', criterion: 'thing is true', type: 'functional', method: 'api' },
      ],
    } as unknown as Partial<Objective>), [], null)
    expect(asArray).toContain('[a] thing is true')

    // A raw string that does not parse must not throw (obj 1180 crash-loop class).
    expect(() => buildReviewerPrompt(
      makeObjective({ acceptance_criteria: 'not json' } as unknown as Partial<Objective>), [], null),
    ).not.toThrow()
  })
})

describe('worker prompt KEEPS its own scratch — the mask is one-directional (P1-1)', () => {
  // Built lazily inside each test — buildPrompt needs the DB that beforeAll inits,
  // and a describe-body call would run at collection time, before that hook.
  const workerPrompt = () => buildPrompt(makeObjective({ status: 'working' } as Partial<Objective>))

  it('still hands the worker its objective-memory scratch path', () => {
    const p = workerPrompt()
    expect(p).toContain(objectiveScratchPath(707060))
    expect(p).toContain(SCRATCH_BASENAME)
    expect(p).toMatch(/persistent memory directory/i)
  })

  it('documents the scratch-vs-artifact split to the worker', () => {
    const p = workerPrompt()
    expect(p).toContain(objectiveArtifactPath(707060))
    expect(p).toMatch(/YOUR private scratch/)
    expect(p).toMatch(/YOUR final artifact/)
    // The worker is told the reviewer will not see the scratch, so it must publish.
    expect(p).toMatch(/reviewer is deliberately masked off this file/i)
    expect(p).toMatch(/an unstated deliverable is an ungraded deliverable/i)
  })
})

describe('buildReviewerArtifactBlock (unit)', () => {
  it('never emits the scratch filename regardless of input shape', () => {
    const cases: Objective[] = [
      makeObjective(),
      makeObjective({ branch_name: null, pr_url: null, last_session_summary: null } as Partial<Objective>),
      makeObjective({ acceptance_criteria: '[]' } as unknown as Partial<Objective>),
      makeObjective({ last_session_summary: `see ${objectiveScratchPath(1)} for detail` } as Partial<Objective>),
    ]
    for (const [i, obj] of cases.entries()) {
      const block = buildReviewerArtifactBlock(obj)
      // Case 3 is the interesting one: the worker's OWN summary names the scratch
      // file. Passing that through verbatim would hand the reviewer the pointer by
      // the back door, so `maskWorkerScratch` redacts it at the boundary and the
      // invariant holds unconditionally — no "except when" carve-out to remember.
      expect(block, `case ${i}`).not.toContain(SCRATCH_BASENAME)
    }
    expect(buildReviewerArtifactBlock(cases[3])).toContain(WORKER_SCRATCH_REDACTION)
  })

  it('reports "no branch, PR, or final summary" when the objective is bare', () => {
    const block = buildReviewerArtifactBlock(makeObjective({
      branch_name: null, pr_url: null, pr_number: null, last_session_summary: null,
    } as unknown as Partial<Objective>))
    expect(block).toMatch(/No branch, PR, or final summary was recorded/i)
  })
})
