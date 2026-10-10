import { describe, it, expect, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { ResultCostTracker } from './result-cost.js'
import { sumResultEventsFromContent } from './session-usage.js'
import { extractDeterministic } from './session-intel-parse.js'
import {
  extractionAggregateDelta,
  fallbackSummaryFromResult,
  FALLBACK_SUMMARY_MAX_CHARS,
} from './session-intel-pipeline.js'

// obj 712954 (C + D). The numbers below are the real `total_cost_usd` sequences
// from obj 712937 / obj 712923's transcripts (2026-09-27): the CLI repeats a GROWING
// per-session total on every `result`, and the current CLI restores it across a
// `--resume` follow-up. Summing every value is what put obj 712937 at $97.25.

const r = (session_id: string | undefined, total: number, uuid: string, extra: Record<string, unknown> = {}) => ({
  type: 'result', subtype: 'success', is_error: false, session_id, total_cost_usd: total, uuid,
  usage: { input_tokens: 10 }, ...extra,
})

describe('ResultCostTracker', () => {
  it('obj 712937 session 1: 6 × 14.4852 then 14.688 / 14.982 / 15.164 → 15.164 total, not $86.91+', () => {
    const t = new ResultCostTracker()
    const seq = [14.4851608, 14.4851608, 14.4851608, 14.4851608, 14.4851608, 14.4851608, 14.6883592, 14.9821066, 15.1643702]
    const total = seq.reduce((s, v, i) => s + (t.take(r('147f846d', v, `u${i}`))?.cost ?? 0), 0)
    expect(total).toBeCloseTo(15.1643702, 6)
  })

  it('obj 712923: a --resume follow-up that restored the total adds only its own delta', () => {
    const t = new ResultCostTracker()
    const shares = [6.0758676, 6.0758676, 8.539149].map((v, i) => t.take(r('2cd64a69', v, `u${i}`))!.cost)
    expect(shares[0]).toBeCloseTo(6.0758676, 6)
    expect(shares[1]).toBe(0)
    expect(shares[2]).toBeCloseTo(8.539149 - 6.0758676, 6)
  })

  it('a total that drops means a fresh process without restore → the whole value counts', () => {
    const t = new ResultCostTracker()
    const shares = [1.506, 1.545, 1.479, 0.725].map((v, i) => t.take(r('june', v, `u${i}`))!.cost)
    // 1.506, +0.039, reset 1.479, reset 0.725
    expect(shares.map(s => +s.toFixed(3))).toEqual([1.506, 0.039, 1.479, 0.725])
  })

  it('separate Claude sessions are tracked independently', () => {
    const t = new ResultCostTracker()
    expect(t.take(r('a', 5, 'x1'))!.cost).toBe(5)
    expect(t.take(r('b', 2, 'x2'))!.cost).toBe(2)
    expect(t.take(r('a', 6, 'x3'))!.cost).toBeCloseTo(1, 9)
  })

  it('a duplicated result uuid counts nothing', () => {
    const t = new ResultCostTracker()
    expect(t.take(r('a', 5, 'same'))!.cost).toBe(5)
    expect(t.take(r('a', 5, 'same'))).toBeNull()
  })

  it('a result without a session_id is taken at face value (no key to group by)', () => {
    const t = new ResultCostTracker()
    expect(t.take(r(undefined, 3, 'n1'))!.cost).toBe(3)
    expect(t.take(r(undefined, 3, 'n2'))!.cost).toBe(3)
  })

  it('modelUsage is cumulative too → per-model share', () => {
    const t = new ResultCostTracker()
    const mu = (cost: number, tok: number) => ({ modelUsage: { 'claude-sonnet-5': { costUSD: cost, inputTokens: tok } } })
    t.take(r('a', 4, 'm1', mu(4, 1000)))
    const s = t.take(r('a', 7, 'm2', mu(7, 1600)))!
    expect(s.models['claude-sonnet-5'].cost_usd).toBeCloseTo(3, 9)
    expect(s.models['claude-sonnet-5'].tokens).toBe(600)
  })
})

const tmp: string[] = []
function writeJsonl(events: object[]): string {
  const p = path.join(os.tmpdir(), `cc-cumcost-${process.pid}-${tmp.length}.jsonl`)
  fs.writeFileSync(p, events.map(e => JSON.stringify(e)).join('\n'))
  tmp.push(p)
  return p
}
afterAll(() => { for (const f of tmp) { try { fs.unlinkSync(f) } catch {} } })

describe('transcript totals use per-result shares', () => {
  const events = [
    { type: 'prompt', text: 'go', timestamp: '2026-09-27T17:00:00.000Z' },
    r('s', 14.4851608, 'a', { modelUsage: { m: { costUSD: 14.4851608, inputTokens: 100 } } }),
    r('s', 14.4851608, 'b', { modelUsage: { m: { costUSD: 14.4851608, inputTokens: 100 } } }),
    r('s', 15.1643702, 'c', { modelUsage: { m: { costUSD: 15.1643702, inputTokens: 150 } } }),
    { type: 'followup', text: 'CI failed', timestamp: '2026-09-27T18:00:00.000Z' },
    r('s', 16.0, 'd', { modelUsage: { m: { costUSD: 16.0, inputTokens: 170 } } }),
  ]

  it('extractDeterministic: totalCost, modelUsage and daily buckets reconcile to the final cumulative', async () => {
    const intel = await extractDeterministic(writeJsonl(events))
    expect(intel.totalCost).toBeCloseTo(16.0, 6)
    expect(intel.modelUsage.m.cost_usd).toBeCloseTo(16.0, 6)
    expect(intel.modelUsage.m.tokens).toBe(170)
    expect(intel.dailyUsage.reduce((s, d) => s + d.cost_usd, 0)).toBeCloseTo(16.0, 6)
  })

  it('sumResultEventsFromContent (account-router / spend path) agrees', () => {
    const { cost, tokens } = sumResultEventsFromContent(events.map(e => JSON.stringify(e)).join('\n'))
    expect(cost).toBeCloseTo(16.0, 6)
    expect(tokens).toBe(40) // per-turn `usage` is still summed: 4 results × 10
  })

  it('extractDeterministic keeps the last successful result text for the summary fallback', async () => {
    const intel = await extractDeterministic(writeJsonl([
      r('s', 1, 'x', { result: 'Interim: waiting on CI' }),
      r('s', 2, 'y', { result: 'All CI green. PR 717 open.' }),
      r('s', 2, 'z', { result: "You've hit your limit", is_error: true }),
    ]))
    expect(intel.finalResultText).toBe('All CI green. PR 717 open.')
  })
})

describe('extractionAggregateDelta (re-extraction of the same session_id)', () => {
  it('first extraction adds the full totals', () => {
    expect(extractionAggregateDelta({ totalCost: 6.29, totalTokens: 100 }, undefined)).toEqual({ cost: 6.29, tokens: 100 })
  })
  it('re-extraction after a follow-up adds only the growth', () => {
    const d = extractionAggregateDelta({ totalCost: 8.539, totalTokens: 180 }, { total_cost_usd: 6.076, total_tokens: 100 })
    expect(d.cost).toBeCloseTo(2.463, 6)
    expect(d.tokens).toBe(80)
  })
  it('never subtracts', () => {
    expect(extractionAggregateDelta({ totalCost: 1, totalTokens: 1 }, { total_cost_usd: 5, total_tokens: 9 })).toEqual({ cost: 0, tokens: 0 })
  })
})

describe('fallbackSummaryFromResult (D)', () => {
  it('trims and collapses blank-line runs', () => {
    expect(fallbackSummaryFromResult('\n\n## Summary\n\n\n\nPR open.  \n')).toBe('## Summary\n\nPR open.')
  })
  it('caps long text with an ellipsis', () => {
    const s = fallbackSummaryFromResult('x'.repeat(FALLBACK_SUMMARY_MAX_CHARS + 50))!
    expect(s.length).toBe(FALLBACK_SUMMARY_MAX_CHARS)
    expect(s.endsWith('…')).toBe(true)
  })
  it('empty / missing → null (nothing is written)', () => {
    expect(fallbackSummaryFromResult('   ')).toBeNull()
    expect(fallbackSummaryFromResult(undefined)).toBeNull()
  })
})
