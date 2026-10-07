import { describe, it, expect } from 'vitest'
import {
  translateRequest,
  parseAssistantOutput,
  parseToolCallsJson,
  ToolEnvelopeStreamer,
  validateChatRequest,
  InvalidRequestError,
  type OAIChatRequest,
} from './translate.js'

const weatherTool = {
  type: 'function' as const,
  function: {
    name: 'get_weather',
    description: 'Current weather for a city',
    parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
  },
}

describe('translateRequest', () => {
  it('passes a lone user message through verbatim and puts system messages in the system prompt', () => {
    const t = translateRequest({
      messages: [
        { role: 'system', content: 'Be terse.' },
        { role: 'user', content: 'What is 2+2?' },
      ],
    })
    expect(t.prompt).toBe('What is 2+2?')
    expect(t.systemPrompt).toContain('Be terse.')
    expect(t.systemPrompt).not.toContain('<functions>')
    expect(t.toolNames).toEqual([])
  })

  it('flattens content-part arrays', () => {
    const t = translateRequest({ messages: [{ role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }] })
    expect(t.prompt).toBe('a\nb')
  })

  it('renders tools + the envelope protocol into the system prompt', () => {
    const t = translateRequest({ messages: [{ role: 'user', content: 'weather in Paris?' }], tools: [weatherTool] })
    expect(t.toolNames).toEqual(['get_weather'])
    expect(t.systemPrompt).toContain('<functions>')
    expect(t.systemPrompt).toContain('"get_weather"')
    expect(t.systemPrompt).toContain('<tool_calls>')
  })

  it('tool_choice none disables tools; required / named force a call', () => {
    expect(translateRequest({ messages: [{ role: 'user', content: 'x' }], tools: [weatherTool], tool_choice: 'none' }).toolNames).toEqual([])
    expect(translateRequest({ messages: [{ role: 'user', content: 'x' }], tools: [weatherTool], tool_choice: 'required' }).systemPrompt).toContain('MUST call at least one')
    expect(
      translateRequest({ messages: [{ role: 'user', content: 'x' }], tools: [weatherTool], tool_choice: { type: 'function', function: { name: 'get_weather' } } }).systemPrompt,
    ).toContain('MUST call the function "get_weather"')
  })

  it('replays assistant tool_calls and role:tool results as a transcript (round trip)', () => {
    const req: OAIChatRequest = {
      tools: [weatherTool],
      messages: [
        { role: 'user', content: 'weather in Paris?' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } }] },
        { role: 'tool', tool_call_id: 'call_1', content: '{"tempC":21}' },
      ],
    }
    const t = translateRequest(req)
    expect(t.prompt).toContain('<message role="user">\nweather in Paris?')
    expect(t.prompt).toContain('<tool_calls>[{"id":"call_1","name":"get_weather","arguments":{"city":"Paris"}}]</tool_calls>')
    // tool name recovered from the matching assistant tool_call id
    expect(t.prompt).toContain('<tool_result tool_call_id="call_1" name="get_weather">\n{"tempC":21}\n</tool_result>')
    expect(t.prompt.trim().endsWith("Write the assistant's next reply.")).toBe(true)
  })

  it('response_format json_schema adds a JSON-only instruction with the schema', () => {
    const t = translateRequest({
      messages: [{ role: 'user', content: 'x' }],
      response_format: { type: 'json_schema', json_schema: { name: 's', schema: { type: 'object', properties: { a: { type: 'number' } } } } },
    })
    expect(t.systemPrompt).toContain('single valid JSON value')
    expect(t.systemPrompt).toContain('"a":{"type":"number"}')
  })
})

describe('validateChatRequest', () => {
  it('rejects empty / malformed requests', () => {
    expect(() => validateChatRequest({})).toThrow(InvalidRequestError)
    expect(() => validateChatRequest({ messages: [] })).toThrow(InvalidRequestError)
    expect(() => validateChatRequest({ messages: [{ role: 'robot', content: 'x' }] })).toThrow(InvalidRequestError)
    expect(() => validateChatRequest({ messages: [{ role: 'user', content: 'x' }], tools: [{ type: 'function' }] })).toThrow(InvalidRequestError)
  })
})

describe('parseAssistantOutput', () => {
  it('returns plain text when no envelope', () => {
    expect(parseAssistantOutput('Hello there', ['get_weather'])).toEqual({ content: 'Hello there', toolCalls: [] })
  })

  it('parses an envelope into OpenAI tool_calls with JSON-string arguments', () => {
    const out = parseAssistantOutput('<tool_calls>[{"name":"get_weather","arguments":{"city":"Paris"}}]</tool_calls>', ['get_weather'])
    expect(out.content).toBeNull()
    expect(out.toolCalls).toHaveLength(1)
    const c = out.toolCalls[0]
    expect(c.type).toBe('function')
    expect(c.id).toMatch(/^call_[0-9a-f]{24}$/)
    expect(c.function.name).toBe('get_weather')
    expect(JSON.parse(c.function.arguments)).toEqual({ city: 'Paris' })
  })

  it('tolerates code fences, a missing close tag, string arguments and multiple calls', () => {
    const out = parseAssistantOutput('<tool_calls>\n```json\n[{"name":"get_weather","arguments":"{\\"city\\":\\"A\\"}"},{"name":"get_weather","arguments":{"city":"B"}}]\n```', ['get_weather'])
    expect(out.toolCalls.map(c => JSON.parse(c.function.arguments).city)).toEqual(['A', 'B'])
  })

  it('drops unknown functions and falls back to text on invalid JSON', () => {
    expect(parseToolCallsJson('[{"name":"rm_rf","arguments":{}}]', ['get_weather'])).toBeNull()
    const bad = parseAssistantOutput('<tool_calls>not json</tool_calls>', ['get_weather'])
    expect(bad.toolCalls).toEqual([])
    expect(bad.content).toBe('<tool_calls>not json</tool_calls>')
  })

  it('ignores envelopes when no tools were offered', () => {
    const out = parseAssistantOutput('<tool_calls>[{"name":"x","arguments":{}}]</tool_calls>', [])
    expect(out.toolCalls).toEqual([])
  })
})

describe('ToolEnvelopeStreamer', () => {
  const feed = (s: ToolEnvelopeStreamer, parts: string[]) => parts.map(p => s.push(p)).join('')

  it('streams plain text through (holding back only a possible tag prefix)', () => {
    const s = new ToolEnvelopeStreamer(['get_weather'])
    const emitted = feed(s, ['Hel', 'lo <', 'b>world'])
    const tail = s.finish()
    expect(emitted + tail.text).toBe('Hello <b>world')
    expect(tail.toolCalls).toEqual([])
  })

  it('detects an envelope split across deltas and parses it at finish', () => {
    const s = new ToolEnvelopeStreamer(['get_weather'])
    const emitted = feed(s, ['<tool', '_ca', 'lls>[{"name":"get_weather",', '"arguments":{"city":"Rome"}}]', '</tool_calls>'])
    expect(emitted).toBe('')
    const tail = s.finish()
    expect(tail.text).toBe('')
    expect(tail.toolCalls).toHaveLength(1)
    expect(JSON.parse(tail.toolCalls[0].function.arguments)).toEqual({ city: 'Rome' })
  })

  it('passes everything through untouched when tools are off', () => {
    const s = new ToolEnvelopeStreamer([])
    expect(s.push('<tool_calls>')).toBe('<tool_calls>')
  })
})
