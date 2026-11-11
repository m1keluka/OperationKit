// ── D-5b regression: an UNGROUNDED L2 duplicate veto is not a veto ───────────
//
// Follows the D-5 fix (obj 705069, merged): withholding `source: objective <ID>`
// from L2 stopped it self-matching. But a real-lens dry run over 2026-08-07 on
// the D-5-only fix still produced `killed=31/32, WOULD CREATE 0` — L2 kept
// killing the surviving candidates with `duplicate:true`, `duplicate_of` UNSET,
// and prose contradicting its own boolean. Objective 704893's evidence read
// "…no such objective exists in the provided board context… this appears to be a
// novel issue" while returning duplicate:true: the old prompt's "default to
// duplicate:true" was overriding the lens's own reasoning.
//
// With D-5b the same day promotes 1 candidate (see
// objective-memory/705045/dsr-dry-run-postfix.md).

import { describe, it, expect } from 'vitest'

const dsr = await import('./daily-retro.js')
type RetroCandidate = import('./daily-retro.js').RetroCandidate
type L2Verdict = import('./daily-retro.js').L2Verdict
type LensRunner = import('./daily-retro.js').LensRunner

function candidate(overrides: Partial<RetroCandidate> = {}): RetroCandidate {
  return {
    fingerprint: 'fp-d5b',
    signal_type: 'review_failure',
    confidence: 0.9,
    recurrence: 2,
    source_objective_id: 704893,
    source_session_id: 'sess-d5b',
    transcript_path: '/tmp/sess-d5b.jsonl',
    excerpt: 'the branch was never pushed and no PR was created',
    window: 'line a\nline b',
    ...overrides,
  }
}

/** Gate driven by a scripted L2 verdict; L1 and L3 always pass. */
function gateWith(l2: Partial<L2Verdict>, boardContext?: string, c = candidate()) {
  const lens: LensRunner = async lensName => {
    if (lensName === 'L1' || lensName === "L1'") {
      return { verdict: { refuted: false, is_real_defect: true, one_line_statement: 's', evidence_quote: 'q', confidence: 0.9 }, cost_usd: 0 }
    }
    if (lensName === 'L2') {
      return { verdict: { duplicate: false, already_fixed: false, duplicate_of: null, evidence: 'e', ...l2 }, cost_usd: 0 }
    }
    return { verdict: { remedy: 'fix_objective', scope_ok: true, priority: 'P1', rationale: 'r' }, cost_usd: 0 }
  }
  return dsr.runReviewGate(c, { lensRunner: lens, boardContext })
}

const BOARD = 'Recent objectives (id | status | title):\n1234 | working | unrelated work\n5678 | done | something else'

describe('D-5b: ungrounded L2 duplicate vetoes are discarded', () => {
  it('discards duplicate:true that cites nothing — the obj 704893 shape', async () => {
    const gate = await gateWith(
      {
        duplicate: true,
        duplicate_of: null,
        evidence: 'no such objective exists in the provided board context... this appears to be a novel issue',
      },
      BOARD,
    )
    expect(gate.l2?.duplicate).toBe(false)
    expect(gate.l2?.evidence).toContain('no duplicate_of')
    expect(gate.outcome).toBe('promoted')
  })

  it('discards duplicate:true naming an objective absent from the corpus L2 was shown', async () => {
    const gate = await gateWith({ duplicate: true, duplicate_of: 999999, evidence: 'hallucinated prior art' }, BOARD)
    expect(gate.l2?.duplicate).toBe(false)
    expect(gate.l2?.duplicate_of).toBeNull()
    expect(gate.l2?.evidence).toContain('not in the board context')
    expect(gate.outcome).toBe('promoted')
  })

  it('discards a self-match that leaked through the transcript window', async () => {
    const gate = await gateWith(
      { duplicate: true, duplicate_of: 704893, evidence: 'same objective' },
      BOARD,
      candidate({ window: 'worker for objective 704893 failed review' }),
    )
    expect(gate.l2?.duplicate).toBe(false)
    expect(gate.l2?.evidence).toContain('self-match on objective 704893')
    expect(gate.outcome).toBe('promoted')
  })

  // NEGATIVE CONTROL — catching real cross-objective duplicates is the point of
  // L2 and must survive the fix.
  it('KEEPS a grounded veto naming an objective that is on the board', async () => {
    const gate = await gateWith({ duplicate: true, duplicate_of: 5678, evidence: 'obj 5678 covers this' }, BOARD)
    expect(gate.l2?.duplicate).toBe(true)
    expect(gate.l2?.duplicate_of).toBe(5678)
    expect(gate.outcome).toBe('killed')
    expect(gate.reason).toContain('L2 duplicate')
  })

  it('does not second-guess a citation when no board corpus was supplied', async () => {
    // Empty corpus ⇒ nothing to check against; take the citation at face value
    // rather than silently suppressing every veto.
    const gate = await gateWith({ duplicate: true, duplicate_of: 4242, evidence: 'cited' })
    expect(gate.l2?.duplicate).toBe(true)
    expect(gate.outcome).toBe('killed')
  })

  it('already_fixed remains a full veto — it needs no citation', async () => {
    const gate = await gateWith({ duplicate: true, already_fixed: true, duplicate_of: null, evidence: 'shipped last week' }, BOARD)
    expect(gate.l2?.duplicate).toBe(false) // ungrounded duplicate dropped…
    expect(gate.l2?.already_fixed).toBe(true) // …but the independent judgement stands
    expect(gate.outcome).toBe('killed')
  })

  it('A/B: the verdict does not depend on the source objective being on the board', async () => {
    // The mechanical form of the W3 experiment. A lens that vetoes whenever it
    // can see the source id must now produce the same answer either way.
    const leaky: LensRunner = async (lensName, _c, context) => {
      if (lensName === 'L1' || lensName === "L1'") {
        return { verdict: { refuted: false, is_real_defect: true, one_line_statement: 's', evidence_quote: 'q', confidence: 0.9 }, cost_usd: 0 }
      }
      if (lensName === 'L2') {
        const sees = /objective 704893|^704893\s*\|/m.test(context)
        return {
          verdict: sees
            ? { duplicate: true, already_fixed: false, duplicate_of: 704893, evidence: 'already tracked' }
            : { duplicate: false, already_fixed: false, duplicate_of: null, evidence: 'novel' },
          cost_usd: 0,
        }
      }
      return { verdict: { remedy: 'fix_objective', scope_ok: true, priority: 'P1', rationale: 'r' }, cost_usd: 0 }
    }
    const withSource = await dsr.runReviewGate(candidate(), {
      lensRunner: leaky,
      boardContext: `${BOARD}\n704893 | done | obj 704893`,
    })
    const withoutSource = await dsr.runReviewGate(candidate(), { lensRunner: leaky, boardContext: BOARD })
    expect(withSource.l2?.duplicate).toBe(withoutSource.l2?.duplicate)
    expect(withSource.outcome).toBe(withoutSource.outcome)
    expect(withSource.outcome).toBe('promoted')
  })
})

describe('D-5b: the lens contract that prevents it at the source', () => {
  it('L2 tool schema REQUIRES duplicate_of, so a claim must cite prior art', () => {
    const schema = dsr.LENS_TOOLS.L2.input_schema as { required: string[] }
    expect(schema.required).toContain('duplicate_of')
  })

  it('L2 prompt no longer instructs a duplicate:true default', () => {
    expect(dsr.LENS_PROMPTS.L2).not.toMatch(/default to duplicate:true/i)
    expect(dsr.LENS_PROMPTS.L2).toMatch(/if and only if/i)
  })
})

describe('boardContextIds', () => {
  it('parses leading ids from `id | status | title` lines only', () => {
    const ids = dsr.boardContextIds(BOARD + '\nKnown learnings:\n- 9999 is prose, not a row')
    expect([...ids].sort((a, b) => a - b)).toEqual([1234, 5678])
    expect(dsr.boardContextIds('').size).toBe(0)
  })
})
