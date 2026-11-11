import { describe, it, expect } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { unresultedUsageFromContent, estimateCostUsd } from './unresulted-usage.js'
import { sumResultEventsFromContent, extractFinalUsage } from './session-usage.js'
import { extractDeterministic as parseTranscript } from './session-intel-parse.js'

// obj 900547 — #900543's two sessions (44 and 86 tool calls) were killed
// mid-turn, wrote no `result` event, and were recorded as 0 tokens / $0; the
// seat's "Tokens today" did not move across both deaths. These fixtures mirror
// the CLI's stream-json shape (--include-partial-messages): one API message shows
// up as a stream_event message_start, several `assistant` events (one per content
// block, same message.id) and a message_delta with the final output count.

const MODEL = 'claude-opus-5-5'
const usage = (o: Partial<Record<string, number>> = {}) => ({
  input_tokens: 2,
  cache_creation_input_tokens: 1000,
  cache_read_input_tokens: 10_000,
  cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1000 },
  output_tokens: 8,
  ...o,
})

function message(id: string, finalOutput: number): string[] {
  return [
    { type: 'stream_event', event: { type: 'message_start', message: { id, model: MODEL, usage: usage({ output_tokens: 1 }) } } },
    { type: 'assistant', message: { id, model: MODEL, usage: usage(), content: [{ type: 'thinking', thinking: '' }] } },
    { type: 'assistant', message: { id, model: MODEL, usage: usage(), content: [{ type: 'tool_use', id: `t-${id}`, name: 'Bash', input: { command: 'ls' } }] } },
    { type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: finalOutput } } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `t-${id}`, content: 'ok' }] } },
  ].map(e => JSON.stringify(e))
}

/** Per message: 2 input + 1000 cache write + 10000 cache read + output. */
const perMessage = (out: number) => 2 + 1000 + 10_000 + out

const killedSession = [
  JSON.stringify({ type: 'prompt', text: 'do the work' }),
  JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1' }),
  ...message('msg_a', 300),
  ...message('msg_b', 500),
  // ← tmux killed here: no `result` event.
].join('\n')

describe('unresultedUsageFromContent', () => {
  it('recovers the usage of a process killed mid-turn, once per message id', () => {
    const u = unresultedUsageFromContent(killedSession)
    expect(u.messages).toBe(2)
    expect(u.tokens).toBe(perMessage(300) + perMessage(500))
    expect(u.cost).toBeGreaterThan(0)
    expect(u.models[MODEL].tokens).toBe(u.tokens)
  })

  it('adds nothing for a clean session — the result already covers it', () => {
    const clean = killedSession + '\n' + JSON.stringify({ type: 'result', subtype: 'success', session_id: 's1', usage: { input_tokens: 4, output_tokens: 800 }, total_cost_usd: 0.5, result: 'done' })
    expect(unresultedUsageFromContent(clean).tokens).toBe(0)
  })

  it('counts only the killed process of a multi-process transcript', () => {
    const lines = [
      JSON.stringify({ type: 'prompt', text: 'p1' }),
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1' }),
      ...message('msg_1', 100),
      JSON.stringify({ type: 'result', subtype: 'success', session_id: 's1', usage: { input_tokens: 10, output_tokens: 100 }, total_cost_usd: 0.1, result: 'ok' }),
      JSON.stringify({ type: 'followup', text: 'again' }),
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1' }),
      ...message('msg_2', 200),
      // killed — then a THIRD process starts (history-flattening respawn)
      JSON.stringify({ type: 'followup', text: 'restart' }),
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 's2' }),
      ...message('msg_3', 50),
      JSON.stringify({ type: 'result', subtype: 'success', session_id: 's2', usage: { input_tokens: 5, output_tokens: 50 }, total_cost_usd: 0.05, result: 'ok' }),
    ].join('\n')
    const u = unresultedUsageFromContent(lines)
    expect(u.messages).toBe(1)
    expect(u.tokens).toBe(perMessage(200))
  })

  it('estimates cost from list prices', () => {
    // 1M output tokens on Opus 5.5 = $20; 1M 1h cache writes = 2 x $4.
    expect(estimateCostUsd({ input: 0, output: 1_000_000, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }, MODEL)).toBeCloseTo(20)
    expect(estimateCostUsd({ input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 1_000_000 }, MODEL)).toBeCloseTo(8)
    expect(estimateCostUsd({ input: 1_000_000, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }, 'claude-sonnet-5-5')).toBeCloseTo(2)
  })
})

describe('seat ledger (sumResultEventsFromContent / extractFinalUsage)', () => {
  it('a killed session is no longer credited as 0 tokens', () => {
    const r = sumResultEventsFromContent(killedSession)
    expect(r.tokens).toBe(perMessage(300) + perMessage(500))
    expect(r.cost).toBeGreaterThan(0)

    const f = path.join(os.tmpdir(), `cc-killed-${process.pid}.jsonl`)
    fs.writeFileSync(f, killedSession)
    try {
      expect(extractFinalUsage(f).tokens).toBe(r.tokens)
    } finally {
      fs.unlinkSync(f)
    }
  })

  it('a clean session is accounted exactly as before (result only)', () => {
    const clean = killedSession + '\n' + JSON.stringify({ type: 'result', subtype: 'success', session_id: 's1', usage: { input_tokens: 4, output_tokens: 800 }, total_cost_usd: 0.5, result: 'done' })
    expect(sumResultEventsFromContent(clean)).toEqual({ tokens: 804, cost: 0.5 })
  })
})

describe('session_intel (parseTranscript)', () => {
  it('records real tokens + estimated cost for a killed session', async () => {
    const f = path.join(os.tmpdir(), `cc-killed-intel-${process.pid}.jsonl`)
    fs.writeFileSync(f, killedSession)
    try {
      const intel = await parseTranscript(f)
      expect(intel.totalTokens).toBe(perMessage(300) + perMessage(500))
      expect(intel.totalCost).toBeGreaterThan(0)
      expect(intel.unreportedUsage?.messages).toBe(2)
      expect(intel.modelUsage[MODEL].tokens).toBe(intel.totalTokens)
      const dailySum = intel.dailyUsage.reduce((s, d) => s + d.tokens, 0)
      expect(dailySum).toBe(intel.totalTokens)
    } finally {
      fs.unlinkSync(f)
    }
  })
})
