import { describe, it, expect } from 'vitest'
import type { AcceptanceCriterion } from '@command-center/shared'
import {
  parseCriteriaResults,
  extractScreenshotPaths,
  parseAcceptanceCriteria,
  decideRespawnAction,
  failingCriterionIds,
} from './state-poller.js'

// QW4 — the AI-review gate used to persist criteria_results/screenshot_paths as
// the literal string '[]'. These lock the parsing that now writes REAL data so a
// normal review yields a NON-EMPTY criteria_results array.

const RUBRIC: AcceptanceCriterion[] = [
  { id: 'crit-1', criterion: 'Backend persists results', type: 'functional', method: 'api' },
  { id: 'crit-2', criterion: 'UI renders the table', type: 'visual', method: 'browser' },
]

// A representative reviewer <findings> body (the buildReviewerPrompt template).
const SAMPLE_FINDINGS = [
  '# AI Review Findings',
  '',
  '- [PASS] crit-1: INSERT now writes the parsed JSON, verified via the row dump',
  '- [FAIL] crit-2: table renders but screenshot /tmp/shots/review-2.png shows misaligned badge',
  '',
  '## Issues',
  '- minor spacing',
].join('\n')

describe('parseCriteriaResults', () => {
  it('parses [PASS|FAIL] <id>: <evidence> lines into structured, NON-EMPTY results', () => {
    const results = parseCriteriaResults(SAMPLE_FINDINGS, RUBRIC)
    expect(results.length).toBe(2)
    // The whole point of QW4: this is not the old hardcoded '[]'.
    expect(JSON.stringify(results)).not.toBe('[]')

    expect(results[0]).toMatchObject({ criterion_id: 'crit-1', status: 'pass' })
    expect(results[0].evidence).toContain('INSERT now writes')

    expect(results[1]).toMatchObject({ criterion_id: 'crit-2', status: 'fail' })
    // per-line screenshot path is lifted out of the evidence
    expect(results[1].screenshot_path).toBe('/tmp/shots/review-2.png')
  })

  it('tolerates bullets, casing and SKIP/SKIPPED', () => {
    const findings = [
      '* [pass] a: ok',
      '[Fail] b: nope',
      '- [SKIPPED] c: could not run',
    ].join('\n')
    const results = parseCriteriaResults(findings, [])
    expect(results.map(r => r.status)).toEqual(['pass', 'fail', 'skipped'])
    expect(results.map(r => r.criterion_id)).toEqual(['a', 'b', 'c'])
  })

  it('falls back to one skipped entry per criterion when no lines parse (never blind [])', () => {
    const results = parseCriteriaResults('no criterion lines here', RUBRIC)
    expect(results.length).toBe(2)
    expect(results.every(r => r.status === 'skipped')).toBe(true)
    expect(results.map(r => r.criterion_id)).toEqual(['crit-1', 'crit-2'])
  })

  it('returns [] only when there is neither findings nor a rubric', () => {
    expect(parseCriteriaResults(null, [])).toEqual([])
  })
})

describe('extractScreenshotPaths', () => {
  it('pulls image paths out of free text and dedupes', () => {
    const text = 'see /tmp/a.png and ./shots/b.jpeg and /tmp/a.png again, plus c.webp'
    expect(extractScreenshotPaths(text)).toEqual(['/tmp/a.png', './shots/b.jpeg', 'c.webp'])
  })

  it('returns [] for empty/undefined', () => {
    expect(extractScreenshotPaths(null)).toEqual([])
    expect(extractScreenshotPaths('no images')).toEqual([])
  })
})

describe('parseAcceptanceCriteria', () => {
  it('parses a JSON string (raw DB column)', () => {
    expect(parseAcceptanceCriteria(JSON.stringify(RUBRIC))).toEqual(RUBRIC)
  })
  it('passes through an already-parsed array', () => {
    expect(parseAcceptanceCriteria(RUBRIC)).toEqual(RUBRIC)
  })
  it('returns [] for null / garbage', () => {
    expect(parseAcceptanceCriteria(null)).toEqual([])
    expect(parseAcceptanceCriteria('{not json')).toEqual([])
  })
})

// The AI-review retry loop's no-progress cap-out used to compare the WHOLE findings
// markdown verbatim — which never matched (the reviewer rephrases evidence every
// round), so non-converging reviews bounced to the iteration cap (~$12–52/round of
// pure re-confirmation, e.g. obj 1848). These lock the set-based key: cap when no
// failed criterion flips fail→pass.
describe('decideRespawnAction — set-based no-progress', () => {
  const base = { iterationCap: 3, spend: 0, ceiling: 0, findings: null, prevFindings: null }

  it('caps as no-progress when the failing-criterion SET is unchanged across rounds (obj 1848/1537)', () => {
    // findings differ byte-for-byte (reviewer rephrased) so the verbatim guard cannot fire,
    // but the same 4 criteria re-fail with zero fail→pass flips.
    const decision = decideRespawnAction({
      ...base,
      iteration: 2,
      findings: 'round 3 evidence — rephrased',
      prevFindings: 'round 2 evidence — different wording',
      failedCriteriaIds: ['antibot-cleared', 'perf-and-license-fields', 'bounded-pilot-cost', 'runbook-and-vault'],
      prevFailedCriteriaIds: ['runbook-and-vault', 'antibot-cleared', 'bounded-pilot-cost', 'perf-and-license-fields'],
    })
    expect(decision).toEqual({ action: 'cap', reason: 'no-progress' })
  })

  it('also caps when the current set is a SUPERSET of the prior (still no fail→pass flip)', () => {
    const decision = decideRespawnAction({
      ...base,
      iteration: 2,
      failedCriteriaIds: ['a', 'b', 'c'], // grew — but every prior-failing id still fails
      prevFailedCriteriaIds: ['a', 'b'],
    })
    expect(decision).toEqual({ action: 'cap', reason: 'no-progress' })
  })

  it('bounces when a prior-failing criterion flipped fail→pass (obj 1538 — real progress, keep the retry)', () => {
    const decision = decideRespawnAction({
      ...base,
      iteration: 1,
      findings: 'round 2 evidence',
      prevFindings: 'round 1 evidence',
      failedCriteriaIds: ['outbound-additive-safe-tested'], // 'outbound-resend-send-and-status' now passes
      prevFailedCriteriaIds: ['outbound-resend-send-and-status', 'outbound-additive-safe-tested'],
    })
    expect(decision).toEqual({ action: 'bounce' })
  })

  it('falls through to the verbatim/bounce path when criteria sets are empty/unavailable (no regression)', () => {
    // No structured sets on either side ⇒ legacy behavior: differing findings ⇒ bounce.
    expect(
      decideRespawnAction({ ...base, iteration: 1, findings: 'x', prevFindings: 'y' })
    ).toEqual({ action: 'bounce' })
    // ...and identical findings still cap via the legacy verbatim guard.
    expect(
      decideRespawnAction({ ...base, iteration: 1, findings: 'same', prevFindings: 'same' })
    ).toEqual({ action: 'cap', reason: 'no-progress' })
  })

  it('does not let the set-arm override the iteration-cap or budget backstops', () => {
    expect(
      decideRespawnAction({ ...base, iteration: 3, failedCriteriaIds: ['a'], prevFailedCriteriaIds: ['b'] })
    ).toEqual({ action: 'cap', reason: 'iteration-cap' })
    expect(
      decideRespawnAction({ ...base, iteration: 1, spend: 50, ceiling: 40, failedCriteriaIds: ['a'], prevFailedCriteriaIds: ['b'] })
    ).toEqual({ action: 'cap', reason: 'budget' })
  })
})

describe('failingCriterionIds — both stored shapes', () => {
  it('reads the PR-harness `id` shape and the rubric `criterion_id` shape', () => {
    expect(failingCriterionIds(JSON.stringify([
      { id: 'a', status: 'fail' }, { id: 'b', status: 'pass' },
    ]))).toEqual(['a'])
    expect(failingCriterionIds(JSON.stringify([
      { criterion_id: 'x', status: 'fail' }, { criterion_id: 'y', status: 'skipped' },
    ]))).toEqual(['x'])
  })

  it('returns [] for null, non-array, or unparseable JSON (degrades to verbatim fallback)', () => {
    expect(failingCriterionIds(null)).toEqual([])
    expect(failingCriterionIds('[]')).toEqual([])
    expect(failingCriterionIds('{not json')).toEqual([])
    expect(failingCriterionIds(JSON.stringify({ not: 'an array' }))).toEqual([])
  })
})
