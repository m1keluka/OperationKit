// ── DSR pure-detector unit tests (spec §D.4, tests 1-5) ──────────────────────
//
// No DB, no fs, no network — daily-retro.detect.ts is pure by construction, so
// the whole taxonomy is provable here. The highest-value test in this file is
// the A.6-a regression: a `type:"user"` sub-agent prompt must yield ZERO
// human_correction signals. Porting the cattle scanner's role:"user" detector
// unchanged would have made that the dominant (and near-100% false) signal.

import { describe, it, expect } from 'vitest'
import {
  classifyFollowup,
  isCorrective,
  isHarnessNoise,
  normalizeAnchor,
  fingerprint,
  scoreSignal,
  scoreFollowupCorrection,
  mentionsPath,
  isSelfCorrection,
  claimsCompletion,
  ANCHOR_MAX_LEN,
  DEFAULT_MIN_CONFIDENCE,
} from './daily-retro.detect.js'

// Verbatim fixtures from the 2026-08-07 audit (spec §A.6).
const REAL_HUMAN_FOLLOWUPS = [
  "1. one draft has first and last name Harish Sundar. Please make sure you use the first name from the CSV",
  'use this name instead of Z ZEYNEP ZOEY',
  'No its user@example.com. can you create a download link for the filtered csv',
  'B works, for the videos can you generate a transcript and evaluate based on that',
]

const AUTO_FOLLOWUPS = [
  '[child-complete] worker 3 finished',
  '## AI Review Findings\n- criterion X failed',
  'AUTO-RESUME: continuing after max turns',
  '[oracle] regression oracle result: RED',
  'deterministic floor gate blocked the transition',
  'Claude reached maximum number of turns for this session',
  '[watchdog] pr-health sweep noticed a stale PR',
]

describe('classifyFollowup — AUTO patterns (spec §C.2)', () => {
  for (const t of AUTO_FOLLOWUPS) {
    it(`classifies as auto: ${t.slice(0, 40)}`, () => {
      expect(classifyFollowup(t)).toBe('auto')
    })
  }

  it('classifies the four real 2026-08-07 samples as human', () => {
    for (const t of REAL_HUMAN_FOLLOWUPS) expect(classifyFollowup(t)).toBe('human')
  })

  it('treats empty/whitespace as empty, not human', () => {
    expect(classifyFollowup('')).toBe('empty')
    expect(classifyFollowup('   \n ')).toBe('empty')
    expect(classifyFollowup(null)).toBe('empty')
    expect(classifyFollowup(undefined)).toBe('empty')
  })
})

describe('A.6-a REGRESSION — sub-agent prompts are not human corrections', () => {
  // Verbatim from cc-704580-1785970648031: a `type:"user"` text block that is
  // the parent session's own Agent-tool prompt, not a human.
  const SUBAGENT_PROMPT =
    'READ-ONLY code audit. Repo worktree at /tmp/w10-wt. Do not modify any file. ' +
    'Report the call sites you find and stop.'

  it('yields zero human_correction signals for a sub-agent prompt', () => {
    // The detector only ever consults followups; even if this text were routed
    // through the D1 scorer it must not produce a signal (no corrective phrasing).
    expect(scoreFollowupCorrection(SUBAGENT_PROMPT)).toBeNull()
    expect(isCorrective(SUBAGENT_PROMPT)).toBe(false)
  })

  it('a plain (non-corrective) human followup is also not a D1 signal', () => {
    expect(scoreFollowupCorrection('also add a chart to the dashboard when you get a chance')).toBeNull()
  })

  it('a corrective human followup IS a D1 signal', () => {
    const r = scoreFollowupCorrection("that's wrong — the endpoint should have been /api/v2")
    expect(r).not.toBeNull()
    expect(r!.signal).toBe('human_correction')
    expect(r!.confidence).toBeGreaterThanOrEqual(0.70)
  })

  it('an AUTO followup carrying corrective words is still not D1', () => {
    // "## AI Review Findings" bodies routinely contain "should have" — the AUTO
    // prefix must win, or every review-findings nudge becomes a false human.
    expect(scoreFollowupCorrection('## AI Review Findings\nYou should have added a test')).toBeNull()
  })
})

describe('isCorrective / claimsCompletion / mentionsPath / isSelfCorrection', () => {
  it('matches the §C.2 corrective phrasings', () => {
    for (const t of [
      "that's not right",
      'you forgot the migration',
      'make sure you use the first name',
      'actually, use the other key',
      "no, it's the staging bucket",
      'instead of hardcoding it',
      'correction: the column is nullable',
      'revert that change',
      'undo the last edit',
    ]) {
      expect(isCorrective(t)).toBe(true)
    }
  })

  it('detects completion claims for the D1 booster', () => {
    expect(claimsCompletion('All set — the PR is open and green.')).toBe(true)
    expect(claimsCompletion('Working on it now.')).toBe(false)
  })

  it('detects file/path mentions for the D1 booster', () => {
    expect(mentionsPath('see /home/operator/projects/x/index.ts')).toBe(true)
    expect(mentionsPath('the poller is wrong')).toBe(false)
  })

  it('detects agent self-correction phrasing (D2)', () => {
    expect(isSelfCorrection('My mistake — I misread the schema.')).toBe(true)
    expect(isSelfCorrection('I forgot to update the index.')).toBe(true)
    expect(isSelfCorrection('The build passed.')).toBe(false)
  })
})

describe('isHarnessNoise (spec §C.2 D3 penalty)', () => {
  it('classifies permission prompts as noise', () => {
    expect(isHarnessNoise('Claude requested permissions to use Bash, but you have not granted it yet')).toBe(true)
    expect(isHarnessNoise('The user rejected the tool use')).toBe(true)
  })

  it('classifies Exit code 127 on an exploratory probe as noise', () => {
    expect(isHarnessNoise('Exit code 127\n===\nsqlite3: command not found')).toBe(true)
  })

  it('does NOT classify a repeated ENOENT on a source file as noise', () => {
    expect(isHarnessNoise("ENOENT: no such file or directory, open '/app/server/src/services/missing.ts'")).toBe(false)
  })

  it('does NOT classify a genuine runtime error as noise', () => {
    expect(isHarnessNoise('TypeError: Cannot read properties of undefined (reading \'map\')')).toBe(false)
  })

  it('treats an empty payload as noise (nothing to act on)', () => {
    expect(isHarnessNoise('')).toBe(true)
  })
})

describe('normalizeAnchor + fingerprint (spec §C.2 dedup)', () => {
  it('collapses session ids, objective ids, uuids and numbers', () => {
    const a = normalizeAnchor('session cc-705052-1786205002714 for objective 705052 failed after 42 retries')
    expect(a).toContain('<sid>')
    expect(a).toContain('<oid>')
    expect(a).toContain('<num>')
    expect(a).not.toMatch(/1786205002714/)
  })

  it('truncates the anchor at 160 chars', () => {
    expect(normalizeAnchor('x'.repeat(500))).toHaveLength(ANCHOR_MAX_LEN)
  })

  it('is STABLE across differing objective/session ids and numbers', () => {
    const f1 = fingerprint('cc', 'tool_error', 'objective 705052 session cc-705052-1786205002714 failed 3 times')
    const f2 = fingerprint('cc', 'tool_error', 'objective 705099 session cc-705099-1786299999999 failed 9 times')
    expect(f1).toBe(f2)
  })

  it('DIFFERS on differing file paths (paths are the discriminating token)', () => {
    const f1 = fingerprint('cc', 'tool_error', "ENOENT: open '/app/server/src/a.ts'")
    const f2 = fingerprint('cc', 'tool_error', "ENOENT: open '/app/server/src/b.ts'")
    expect(f1).not.toBe(f2)
  })

  it('DIFFERS on differing signal type and project', () => {
    expect(fingerprint('cc', 'tool_error', 'same')).not.toBe(fingerprint('cc', 'human_correction', 'same'))
    expect(fingerprint('cc', 'tool_error', 'same')).not.toBe(fingerprint('other', 'tool_error', 'same'))
  })

  it('is a 40-char sha1 hex digest', () => {
    expect(fingerprint('cc', 'tool_error', 'x')).toMatch(/^[0-9a-f]{40}$/)
  })
})

describe('scoreSignal — boosters and penalties (spec §C.2)', () => {
  it('D1 base 0.70, +0.10 completion claim, +0.05 path, −0.30 chat objective', () => {
    expect(scoreSignal('human_correction')).toBeCloseTo(0.70, 5)
    expect(scoreSignal('human_correction', { afterCompletionClaim: true })).toBeCloseTo(0.80, 5)
    expect(scoreSignal('human_correction', { afterCompletionClaim: true, namesPath: true })).toBeCloseTo(0.85, 5)
    // The obj-1432 trap: Operator's long-lived chat session alone produced 240
    // followups on 2026-08-07. Penalised below the floor, not hard-excluded.
    expect(scoreSignal('human_correction', { chatObjective: true })).toBeCloseTo(0.40, 5)
    expect(scoreSignal('human_correction', { chatObjective: true })).toBeLessThan(DEFAULT_MIN_CONFIDENCE)
  })

  it('D2 base 0.55, +0.10 only when a real Edit followed', () => {
    expect(scoreSignal('agent_self_correction')).toBeCloseTo(0.55, 5)
    expect(scoreSignal('agent_self_correction', { followedByEdit: true })).toBeCloseTo(0.65, 5)
  })

  it('D3 base 0.35; noise alone stays far below the floor', () => {
    expect(scoreSignal('tool_error')).toBeCloseTo(0.35, 5)
    expect(scoreSignal('tool_error', { harnessNoise: true })).toBeCloseTo(0.10, 5)
    // A stuck loop that is also the last call before death does clear the floor.
    expect(scoreSignal('tool_error', { repeatedInSession: true, lastBeforeEnd: true })).toBeCloseTo(0.70, 5)
    expect(scoreSignal('tool_error', { repeatedInSession: true, lastBeforeEnd: true })).toBeGreaterThanOrEqual(DEFAULT_MIN_CONFIDENCE)
    // …but noise never does, even when repeating.
    expect(scoreSignal('tool_error', { repeatedInSession: true, harnessNoise: true })).toBeLessThan(DEFAULT_MIN_CONFIDENCE)
  })

  it('D4 base 0.75, +0.10 browser mode, +0.05 per extra failed iteration', () => {
    expect(scoreSignal('review_failure')).toBeCloseTo(0.75, 5)
    expect(scoreSignal('review_failure', { browserReview: true })).toBeCloseTo(0.85, 5)
    expect(scoreSignal('review_failure', { extraFailedIterations: 2 })).toBeCloseTo(0.85, 5)
  })

  it('D5 base 0.60, +0.15 at iteration >= 3', () => {
    expect(scoreSignal('iterate_loop')).toBeCloseTo(0.60, 5)
    expect(scoreSignal('iterate_loop', { deepIteration: true })).toBeCloseTo(0.75, 5)
  })

  it('D6 base 0.50, +0.20 when the blocker recurs across >= 3 objectives', () => {
    expect(scoreSignal('escalation')).toBeCloseTo(0.50, 5)
    expect(scoreSignal('escalation', { recurrenceAcrossObjectives: 2 })).toBeCloseTo(0.50, 5)
    expect(scoreSignal('escalation', { recurrenceAcrossObjectives: 3 })).toBeCloseTo(0.70, 5)
  })

  it('D7 can NEVER reach the floor — informational only', () => {
    expect(scoreSignal('max_turns_truncation')).toBeLessThan(DEFAULT_MIN_CONFIDENCE)
    // No booster combination may lift it.
    expect(
      scoreSignal('max_turns_truncation', {
        afterCompletionClaim: true,
        namesPath: true,
        repeatedInSession: true,
        lastBeforeEnd: true,
        browserReview: true,
        deepIteration: true,
        extraFailedIterations: 10,
        recurrenceAcrossObjectives: 10,
      }),
    ).toBeLessThan(DEFAULT_MIN_CONFIDENCE)
  })

  it('clamps to [0,1]', () => {
    expect(scoreSignal('review_failure', { browserReview: true, extraFailedIterations: 99 })).toBeLessThanOrEqual(1)
    expect(scoreSignal('tool_error', { harnessNoise: true })).toBeGreaterThanOrEqual(0)
  })
})
