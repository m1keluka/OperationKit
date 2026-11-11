import { describe, it, expect, vi, afterEach } from 'vitest'
import fs from 'fs'
import { extractUsageFromResultEvent, sumResultEventsFromContent, listTranscriptJsonl, __resetTranscriptListCache, TRANSCRIPT_LIST_TTL_MS } from './session-usage.js'

describe('extractUsageFromResultEvent', () => {
  it('sums all token fields from event.usage', () => {
    const event = {
      type: 'result',
      total_cost_usd: 0.286,
      usage: {
        input_tokens: 6,
        output_tokens: 1147,
        cache_read_input_tokens: 34283,
        cache_creation_input_tokens: 1072,
      },
    }
    const { tokens, cost } = extractUsageFromResultEvent(event)
    // 6 + 1147 + 34283 + 1072
    expect(tokens).toBe(36508)
    expect(cost).toBe(0.286)
  })

  it('returns zeros when usage is missing (resilient to malformed events)', () => {
    const event = { type: 'result' }
    expect(extractUsageFromResultEvent(event)).toEqual({ tokens: 0, cost: 0 })
  })

  it('handles partial usage objects', () => {
    const event = { type: 'result', usage: { input_tokens: 100, output_tokens: 50 }, total_cost_usd: 0.01 }
    expect(extractUsageFromResultEvent(event)).toEqual({ tokens: 150, cost: 0.01 })
  })

  it('does NOT use the deprecated total_input_tokens path', () => {
    // Regression guard: prior code returned event.total_input_tokens, which is
    // never set by stream-json — this caused tokensToday to always read 0.
    const event = { type: 'result', total_input_tokens: 9999, usage: { input_tokens: 5 } }
    expect(extractUsageFromResultEvent(event).tokens).toBe(5)
  })
})

describe('sumResultEventsFromContent', () => {
  it('sums usage and cost across every result event (per-turn, not cumulative)', () => {
    // Regression guard: prior code returned only the LAST result event,
    // undercounting a 32-turn session by 32× and producing the $5.38-instead-of-$112
    // dashboard symptom.
    const content = [
      JSON.stringify({ type: 'assistant', message: { content: [] } }),
      JSON.stringify({ type: 'result', total_cost_usd: 0.82, usage: { input_tokens: 19, output_tokens: 8142, cache_read_input_tokens: 540111, cache_creation_input_tokens: 55517 } }),
      JSON.stringify({ type: 'assistant', message: { content: [] } }),
      JSON.stringify({ type: 'result', total_cost_usd: 2.83, usage: { input_tokens: 32, output_tokens: 23350, cache_read_input_tokens: 1755551, cache_creation_input_tokens: 87902 } }),
      JSON.stringify({ type: 'result', total_cost_usd: 1.01, usage: { input_tokens: 6, output_tokens: 3588, cache_read_input_tokens: 64283, cache_creation_input_tokens: 1676 } }),
    ].join('\n')
    const { tokens, cost } = sumResultEventsFromContent(content)
    expect(cost).toBeCloseTo(0.82 + 2.83 + 1.01, 5)
    expect(tokens).toBe(
      (19 + 8142 + 540111 + 55517) +
      (32 + 23350 + 1755551 + 87902) +
      (6 + 3588 + 64283 + 1676)
    )
  })

  it('returns zeros for empty content', () => {
    expect(sumResultEventsFromContent('')).toEqual({ tokens: 0, cost: 0 })
  })

  it('skips non-result and malformed lines', () => {
    const content = [
      '',
      'not-json',
      JSON.stringify({ type: 'assistant' }),
      JSON.stringify({ type: 'result', total_cost_usd: 0.5, usage: { input_tokens: 100 } }),
    ].join('\n')
    const { tokens, cost } = sumResultEventsFromContent(content)
    expect(tokens).toBe(100)
    expect(cost).toBe(0.5)
  })
})

describe('listTranscriptJsonl (poll-tick readdir cache)', () => {
  afterEach(() => {
    __resetTranscriptListCache()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('reads the transcript dir once across many calls within the TTL, then refreshes', () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const spy = vi
      .spyOn(fs, 'readdirSync')
      .mockReturnValue(['cc-1-a.jsonl', 'notes.txt', 'cc-2-b.jsonl'] as unknown as ReturnType<typeof fs.readdirSync>)

    // Simulates one poll tick calling computeObjectiveSpend for many objectives:
    // all share a single readdir, and non-.jsonl entries are filtered out.
    const first = listTranscriptJsonl()
    expect(first).toEqual(['cc-1-a.jsonl', 'cc-2-b.jsonl'])
    for (let i = 0; i < 50; i++) listTranscriptJsonl()
    expect(spy).toHaveBeenCalledTimes(1)

    // A just-created transcript is picked up after the TTL elapses (next tick).
    vi.setSystemTime(TRANSCRIPT_LIST_TTL_MS + 1)
    listTranscriptJsonl()
    expect(spy).toHaveBeenCalledTimes(2)
  })

  it('returns an empty list (never throws) when the transcript dir is unreadable', () => {
    __resetTranscriptListCache()
    vi.spyOn(fs, 'readdirSync').mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })
    expect(listTranscriptJsonl()).toEqual([])
  })
})
