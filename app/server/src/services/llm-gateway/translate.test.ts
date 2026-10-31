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

// Verbatim glitch payloads from obj 713960's evidence captures (threads 74e9d30e,
// 4a2e3290) — see /home/operator/ai-workspace/objective-memory/713960/evidence/
// glitch-toolcall-as-text-*.txt. The evidence files are full page-text scrapes
// (nav chrome, timestamps) of the bd.hq chat UI; these constants are the exact
// substrings of the model's own output within them (the UI chrome around them
// is not model-generated text and is excluded).
const GLITCH_BARE_JSON = '{"name": "load_skills", "arguments": {"skillNames": ["lead-qualification"]}}'
const GLITCH_MANGLED_TAG =
  'Found 1 person records\nSam\n_calls>[{"name":"execute_tool","arguments":{"toolName":"find_one_company","arguments":{"id":"612a6906-515c-4500-8979-3b6a7bea0c3c","select":["name","domainName","segment","firmType","aumBand","clientCampaignId"]}}}]'

describe('parseAssistantOutput: malformed envelope recovery (obj 713966)', () => {
  it('recovers a bare JSON tool call with no envelope at all (thread 74e9d30e)', () => {
    const out = parseAssistantOutput(GLITCH_BARE_JSON, ['load_skills'])
    expect(out.toolCalls).toHaveLength(1)
    expect(out.toolCalls[0].function.name).toBe('load_skills')
    expect(JSON.parse(out.toolCalls[0].function.arguments)).toEqual({ skillNames: ['lead-qualification'] })
  })

  it('recovers a mangled/partial opening tag with no closing tag (thread 4a2e3290)', () => {
    const out = parseAssistantOutput(GLITCH_MANGLED_TAG, ['execute_tool'])
    expect(out.toolCalls).toHaveLength(1)
    expect(out.toolCalls[0].function.name).toBe('execute_tool')
    expect(JSON.parse(out.toolCalls[0].function.arguments)).toEqual({
      toolName: 'find_one_company',
      arguments: {
        id: '612a6906-515c-4500-8979-3b6a7bea0c3c',
        select: ['name', 'domainName', 'segment', 'firmType', 'aumBand', 'clientCampaignId'],
      },
    })
    expect(out.content).toBe('Found 1 person records\nSam')
  })

  it('does not treat ordinary prose as a tool call', () => {
    const out = parseAssistantOutput('The weather in Paris is sunny and 21C today.', ['get_weather'])
    expect(out.toolCalls).toEqual([])
    expect(out.content).toBe('The weather in Paris is sunny and 21C today.')
  })

  it('does not treat bare JSON naming an undeclared function as a tool call', () => {
    const text = '{"name": "delete_everything", "arguments": {}}'
    const out = parseAssistantOutput(text, ['get_weather'])
    expect(out.toolCalls).toEqual([])
    expect(out.content).toBe(text)
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

  it('recovers a bare JSON tool call streamed in chunks without leaking JSON as content (thread 74e9d30e)', () => {
    const s = new ToolEnvelopeStreamer(['load_skills'])
    const chunks = ['{"name": "load_', 'skills", "argum', 'ents": {"skillNames": ["lead-qualification"]}}']
    const emitted = feed(s, chunks)
    const tail = s.finish()
    expect(emitted).toBe('')
    expect(tail.toolCalls).toHaveLength(1)
    expect(tail.toolCalls[0].function.name).toBe('load_skills')
    expect(JSON.parse(tail.toolCalls[0].function.arguments)).toEqual({ skillNames: ['lead-qualification'] })
  })

  it('recovers a mangled opening tag streamed in chunks without leaking the envelope JSON as content (thread 4a2e3290)', () => {
    const s = new ToolEnvelopeStreamer(['execute_tool'])
    const chunks = [
      'Found 1 person records\nSam\n',
      '_ca',
      'lls>[{"name":"execute_tool","arguments":{"toolName":"find_one_company",',
      '"arguments":{"id":"612a6906-515c-4500-8979-3b6a7bea0c3c","select":["name","domainName","segment","firmType","aumBand","clientCampaignId"]}}}]',
    ]
    const emitted = feed(s, chunks)
    const tail = s.finish()
    // No fragment of the mangled tag or the JSON envelope ever reached a content delta.
    expect(emitted).not.toContain('calls>')
    expect(emitted).not.toContain('execute_tool')
    expect(emitted + tail.text).toBe('Found 1 person records\nSam\n')
    expect(tail.toolCalls).toHaveLength(1)
    expect(tail.toolCalls[0].function.name).toBe('execute_tool')
    expect(JSON.parse(tail.toolCalls[0].function.arguments)).toEqual({
      toolName: 'find_one_company',
      arguments: {
        id: '612a6906-515c-4500-8979-3b6a7bea0c3c',
        select: ['name', 'domainName', 'segment', 'firmType', 'aumBand', 'clientCampaignId'],
      },
    })
  })
})
