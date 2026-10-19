import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import express from 'express'
import type { AddressInfo } from 'net'
import type { Server } from 'http'
import fs from 'fs'
import os from 'os'
import path from 'path'

// Keep the real account router (state file under /home/operator/transcripts) out of the suite.
vi.mock('../services/account-router.js', () => ({
  pickAccount: vi.fn(() => null),
  recordRateLimit: vi.fn(),
  recordAuthFailure: vi.fn(),
  isRateLimitMessage: () => false,
  isAuthFailureMessage: () => false,
  parseResetTime: () => null,
}))

import { createLlmGatewayRouter } from './llm-gateway.js'
import type { BackendRequest, BackendResult, LlmBackend } from '../services/llm-gateway/claude-cli-backend.js'

const KEY = 'test-gateway-key-0123456789'
const SECRET_PROMPT = 'TOP-SECRET-USER-MESSAGE'
const SECRET_REPLY = 'CONFIDENTIAL-MODEL-REPLY'

type Script = (req: BackendRequest) => Promise<BackendResult>
let script: Script
const backend: LlmBackend = req => script(req)
const env: NodeJS.ProcessEnv = {}
const logs: string[] = []
const LOG_FILE = path.join(os.tmpdir(), `llm-gateway-test-${process.pid}.jsonl`)

const result = (text: string, extra: Partial<BackendResult> = {}): BackendResult => ({
  text, usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }, stopReason: 'end_turn', slot: 'b', costUsd: 0, ttftMs: 3, attempts: 1, ...extra,
})

/** Fake backend that streams `parts` through onText then resolves. */
const streaming = (parts: string[], extra: Partial<BackendResult> = {}): Script => async req => {
  for (const p of parts) req.onText?.(p)
  return result(parts.join(''), extra)
}

let server: Server
let base: string

beforeAll(async () => {
  const app = express()
  app.use(express.json())
  app.use('/api/llm/v1', createLlmGatewayRouter({ backend, env, log: l => logs.push(l), logFile: LOG_FILE }))
  await new Promise<void>(r => { server = app.listen(0, '127.0.0.1', () => r()) })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/llm/v1`
})
afterAll(() => new Promise<void>(r => server.close(() => r())).then(() => fs.rmSync(LOG_FILE, { force: true })))

const resetEnv = () => {
  for (const k of Object.keys(env)) delete env[k]
  env.TWENTY_LLM_GATEWAY_KEY = KEY
}
const auth = { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }
const post = (body: unknown, headers: Record<string, string> = auth) =>
  fetch(`${base}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body) })

function parseSse(text: string): { chunks: any[]; done: boolean } {
  const events = text.split('\n\n').map(e => e.trim()).filter(Boolean)
  const done = events[events.length - 1] === 'data: [DONE]'
  const chunks = events.filter(e => e !== 'data: [DONE]').map(e => {
    expect(e.startsWith('data: ')).toBe(true)
    return JSON.parse(e.slice(6))
  })
  return { chunks, done }
}

describe('auth + kill switch', () => {
  it('401 without a key, with a wrong key, and with a non-bearer scheme', async () => {
    resetEnv()
    expect((await fetch(`${base}/models`)).status).toBe(401)
    expect((await fetch(`${base}/models`, { headers: { Authorization: 'Bearer nope' } })).status).toBe(401)
    expect((await fetch(`${base}/models`, { headers: { Authorization: `Basic ${KEY}` } })).status).toBe(401)
    const r = await post({ messages: [{ role: 'user', content: 'hi' }] }, { 'Content-Type': 'application/json' })
    expect(r.status).toBe(401)
    expect((await r.json()).error.code).toBe('invalid_api_key')
  })

  it('LLM_GATEWAY_ENABLED=false → 503 even with a valid key', async () => {
    resetEnv()
    env.LLM_GATEWAY_ENABLED = 'false'
    const r = await fetch(`${base}/models`, { headers: auth })
    expect(r.status).toBe(503)
    expect((await r.json()).error.code).toBe('gateway_disabled')
  })

  it('503 when no key is configured (fail closed)', async () => {
    resetEnv()
    delete env.TWENTY_LLM_GATEWAY_KEY
    expect((await fetch(`${base}/models`, { headers: { Authorization: 'Bearer ' } })).status).toBe(503)
  })
})

describe('GET /models', () => {
  it('lists the 3 model ids in OpenAI list shape', async () => {
    resetEnv()
    const body = await (await fetch(`${base}/models`, { headers: auth })).json()
    expect(body.object).toBe('list')
    expect(body.data.map((m: any) => m.id)).toEqual(['claude-sonnet-5', 'claude-opus-5-5', 'claude-haiku-4-5-20251001'])
    expect(body.data.every((m: any) => m.object === 'model')).toBe(true)
  })
})

describe('POST /chat/completions (non-streaming)', () => {
  it('returns an OpenAI chat.completion with usage; default model is claude-sonnet-5', async () => {
    resetEnv()
    let seen: BackendRequest | null = null
    script = async req => { seen = req; return result('4') }
    const r = await post({ messages: [{ role: 'user', content: 'What is 2+2?' }] })
    expect(r.status).toBe(200)
    const body = await r.json()
    expect(body.object).toBe('chat.completion')
    expect(body.id).toMatch(/^chatcmpl-/)
    expect(body.model).toBe('claude-sonnet-5')
    expect(body.choices[0]).toMatchObject({ index: 0, message: { role: 'assistant', content: '4' }, finish_reason: 'stop' })
    expect(body.usage).toEqual({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 })
    expect(seen!.model).toBe('claude-sonnet-5')
    expect(seen!.prompt).toBe('What is 2+2?')
  })

  it('rejects unknown models and malformed bodies with 400', async () => {
    resetEnv()
    expect((await post({ model: 'gpt-4o', messages: [{ role: 'user', content: 'x' }] })).status).toBe(400)
    expect((await post({ messages: [] })).status).toBe(400)
  })

  it('tool_call round trip: tools in → tool_calls out → role:tool follow-up → text', async () => {
    resetEnv()
    const tools = [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } } }]
    script = async () => result('<tool_calls>[{"name":"get_weather","arguments":{"city":"Paris"}}]</tool_calls>')
    const first = await (await post({ model: 'claude-haiku-4-5-20251001', tools, messages: [{ role: 'user', content: 'Weather in Paris?' }] })).json()
    expect(first.choices[0].finish_reason).toBe('tool_calls')
    const msg = first.choices[0].message
    expect(msg.content).toBeNull()
    expect(msg.tool_calls).toHaveLength(1)
    expect(msg.tool_calls[0].type).toBe('function')
    expect(msg.tool_calls[0].function.name).toBe('get_weather')
    expect(JSON.parse(msg.tool_calls[0].function.arguments)).toEqual({ city: 'Paris' })

    let followPrompt = ''
    script = async req => { followPrompt = req.prompt; return result('It is 21°C in Paris.') }
    const second = await (await post({
      tools,
      messages: [
        { role: 'user', content: 'Weather in Paris?' },
        msg,
        { role: 'tool', tool_call_id: msg.tool_calls[0].id, content: '{"tempC":21}' },
      ],
    })).json()
    expect(second.choices[0]).toMatchObject({ finish_reason: 'stop', message: { content: 'It is 21°C in Paris.' } })
    expect(followPrompt).toContain(`tool_call_id="${msg.tool_calls[0].id}" name="get_weather"`)
    expect(followPrompt).toContain('{"tempC":21}')
  })

  it('maps an exhausted account pool to 429', async () => {
    resetEnv()
    const { BackendError } = await import('../services/llm-gateway/claude-cli-backend.js')
    script = async () => { throw new BackendError('no_account', 'none') }
    const r = await post({ messages: [{ role: 'user', content: 'x' }] })
    expect(r.status).toBe(429)
  })
})

describe('POST /chat/completions (stream: true)', () => {
  it('emits chat.completion.chunk SSE events ending in data: [DONE]', async () => {
    resetEnv()
    script = streaming(['Hel', 'lo', '!'])
    const r = await post({ stream: true, stream_options: { include_usage: true }, messages: [{ role: 'user', content: 'hi' }] })
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toContain('text/event-stream')
    const { chunks, done } = parseSse(await r.text())
    expect(done).toBe(true)
    expect(chunks.every(c => c.object === 'chat.completion.chunk' && c.id === chunks[0].id)).toBe(true)
    expect(chunks[0].choices[0].delta).toEqual({ role: 'assistant', content: '' })
    const text = chunks.flatMap(c => c.choices.map((ch: any) => ch.delta?.content ?? '')).join('')
    expect(text).toBe('Hello!')
    const finish = chunks.find(c => c.choices[0]?.finish_reason)
    expect(finish.choices[0].finish_reason).toBe('stop')
    expect(finish.usage.total_tokens).toBe(15)
    const usageOnly = chunks[chunks.length - 1]
    expect(usageOnly.choices).toEqual([])
    expect(usageOnly.usage).toEqual({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 })
  })

  it('streams tool_call deltas (id/name first, then arguments) with finish_reason tool_calls', async () => {
    resetEnv()
    script = streaming(['<tool_', 'calls>[{"name":"get_weather","argu', 'ments":{"city":"Oslo"}}]</tool_calls>'])
    const r = await post({
      stream: true,
      tools: [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object' } } }],
      messages: [{ role: 'user', content: 'Weather in Oslo?' }],
    })
    const { chunks, done } = parseSse(await r.text())
    expect(done).toBe(true)
    // No envelope text leaks into content
    expect(chunks.map(c => c.choices[0]?.delta?.content ?? '').join('')).toBe('')
    const tcDeltas = chunks.flatMap(c => c.choices[0]?.delta?.tool_calls ?? [])
    expect(tcDeltas[0]).toMatchObject({ index: 0, type: 'function', function: { name: 'get_weather', arguments: '' } })
    expect(tcDeltas[0].id).toMatch(/^call_/)
    const args = tcDeltas.map((d: any) => d.function?.arguments ?? '').join('')
    expect(JSON.parse(args)).toEqual({ city: 'Oslo' })
    expect(chunks.find(c => c.choices[0]?.finish_reason)!.choices[0].finish_reason).toBe('tool_calls')
  })

  it('returns a JSON error (not a half-open stream) when the backend fails before any token', async () => {
    resetEnv()
    const { BackendError } = await import('../services/llm-gateway/claude-cli-backend.js')
    script = async () => { throw new BackendError('cli_error', 'boom', 'b') }
    const r = await post({ stream: true, messages: [{ role: 'user', content: 'x' }] })
    expect(r.status).toBe(502)
    expect((await r.json()).error.type).toBe('server_error')
  })
})

describe('concurrency cap', () => {
  it('returns 429 once LLM_GATEWAY_MAX_CONCURRENCY requests are in flight', async () => {
    resetEnv()
    env.LLM_GATEWAY_MAX_CONCURRENCY = '2'
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    script = async () => { await gate; return result('ok') }
    const a = post({ messages: [{ role: 'user', content: '1' }] })
    const b = post({ messages: [{ role: 'user', content: '2' }] })
    await new Promise(r => setTimeout(r, 100))
    const c = await post({ messages: [{ role: 'user', content: '3' }] })
    expect(c.status).toBe(429)
    expect((await c.json()).error.code).toBe('concurrency_limit')
    release()
    expect((await a).status).toBe(200)
    expect((await b).status).toBe(200)
    // slots free again
    script = async () => result('ok')
    expect((await post({ messages: [{ role: 'user', content: '4' }] })).status).toBe(200)
  })
})

describe('logging', () => {
  it('exposes the serving slot (fingerprint + headers), never a credential', async () => {
    resetEnv()
    script = async () => result('ok', { slot: 'd' })
    const r = await post({ messages: [{ role: 'user', content: 'hi' }] })
    expect(r.headers.get('x-cc-gateway-slot')).toBe('d')
    expect(Number(r.headers.get('x-cc-gateway-latency-ms'))).toBeGreaterThanOrEqual(0)
    expect((await r.json()).system_fingerprint).toBe('cc-slot-d')
    script = streaming(['o', 'k'], { slot: 'e' })
    const { chunks } = parseSse(await (await post({ stream: true, messages: [{ role: 'user', content: 'hi' }] })).text())
    expect(chunks[chunks.length - 1].system_fingerprint).toBe('cc-slot-e')
  })

  it('logs model/slot/tokens/latency (stdout + JSONL) but never message bodies', async () => {
    resetEnv()
    logs.length = 0
    fs.rmSync(LOG_FILE, { force: true })
    script = async () => result(SECRET_REPLY)
    await post({ messages: [{ role: 'system', content: SECRET_PROMPT }, { role: 'user', content: SECRET_PROMPT }] })
    script = streaming([SECRET_REPLY])
    await (await post({ stream: true, messages: [{ role: 'user', content: SECRET_PROMPT }] })).text()
    expect(logs).toHaveLength(2)
    for (const l of logs) {
      expect(l).toMatch(/model=claude-sonnet-5 .*slot=b .*prompt_tokens=10 completion_tokens=5 .*total_ms=\d+/)
      expect(l).not.toContain(SECRET_PROMPT)
      expect(l).not.toContain(SECRET_REPLY)
    }
    const file = fs.readFileSync(LOG_FILE, 'utf8')
    const recs = file.trim().split('\n').map(l => JSON.parse(l))
    expect(recs).toHaveLength(2)
    expect(recs[0]).toMatchObject({ model: 'claude-sonnet-5', slot: 'b', status: 200, prompt_tokens: 10, completion_tokens: 5 })
    expect(typeof recs[0].total_ms).toBe('number')
    expect(file).not.toContain(SECRET_PROMPT)
    expect(file).not.toContain(SECRET_REPLY)
  })
})
