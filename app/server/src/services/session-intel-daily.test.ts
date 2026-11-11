import { describe, it, expect, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { extractDeterministic } from './session-intel-parse.js'

// Synthetic transcripts to verify per-day cost attribution: a session's per-day
// buckets must reconcile exactly to its total, and each turn lands on the
// Eastern day of the most recent timestamped event (result events have none).
const tmpFiles: string[] = []
function writeJsonl(events: object[]): string {
  const p = path.join(os.tmpdir(), `cc-daily-${process.pid}-${tmpFiles.length}.jsonl`)
  fs.writeFileSync(p, events.map(e => JSON.stringify(e)).join('\n'))
  tmpFiles.push(p)
  return p
}

afterAll(() => { for (const f of tmpFiles) { try { fs.unlinkSync(f) } catch {} } })

describe('session-intel per-day attribution', () => {
  it('splits a multi-day session across days and reconciles to the total', async () => {
    // June 2026 = EDT (UTC-4): 12:00Z → 08:00 ET same date.
    const p = writeJsonl([
      { type: 'prompt', text: 'go', timestamp: '2026-06-10T12:00:00.000Z' },
      { type: 'result', subtype: 'success', total_cost_usd: 10, usage: { input_tokens: 100 },
        modelUsage: { 'claude-opus-4-8': { costUSD: 10, inputTokens: 100 } } },
      { type: 'followup', text: 'more', timestamp: '2026-06-11T12:00:00.000Z' },
      { type: 'result', subtype: 'success', total_cost_usd: 5, usage: { input_tokens: 50 },
        modelUsage: { 'claude-opus-4-8': { costUSD: 5, inputTokens: 50 } } },
    ])
    const intel = await extractDeterministic(p)
    const total = intel.dailyUsage.reduce((s, d) => s + d.cost_usd, 0)
    expect(total).toBeCloseTo(intel.totalCost, 6)
    expect(intel.totalCost).toBeCloseTo(15, 6)
    const byDay = Object.fromEntries(intel.dailyUsage.map(d => [d.day, d.cost_usd]))
    expect(byDay['2026-06-10']).toBeCloseTo(10, 6)
    expect(byDay['2026-06-11']).toBeCloseTo(5, 6)
  })

  it('buckets turns with no modelUsage under "unknown" so totals still reconcile', async () => {
    const p = writeJsonl([
      { type: 'prompt', text: 'go', timestamp: '2026-06-11T13:00:00.000Z' },
      { type: 'result', subtype: 'success', total_cost_usd: 2, usage: { input_tokens: 20 } },
    ])
    const intel = await extractDeterministic(p)
    expect(intel.dailyUsage).toHaveLength(1)
    expect(intel.dailyUsage[0].day).toBe('2026-06-11')
    expect(intel.dailyUsage[0].model).toBe('unknown')
    expect(intel.dailyUsage[0].cost_usd).toBeCloseTo(2, 6)
    expect(intel.dailyUsage.reduce((s, d) => s + d.cost_usd, 0)).toBeCloseTo(intel.totalCost, 6)
  })

  it('attributes a turn to the day of the most recent timestamp, not file order', async () => {
    // A turn whose followup is just before midnight ET stays on that ET day.
    // 2026-06-11T03:30:00Z = 2026-06-10 23:30 EDT → Eastern day 2026-06-10.
    const p = writeJsonl([
      { type: 'prompt', text: 'go', timestamp: '2026-06-11T03:30:00.000Z' },
      { type: 'result', subtype: 'success', total_cost_usd: 7, usage: { input_tokens: 70 },
        modelUsage: { 'gpt-5.5': { costUSD: 0, inputTokens: 70 } } },
    ])
    const intel = await extractDeterministic(p)
    expect(intel.dailyUsage[0].day).toBe('2026-06-10')
  })
})
