import { describe, it, expect } from 'vitest'
import { chooseProviderId, createProvider, toAnthropicMessages, ProviderError } from './providers.js'
import type { ChatAgent } from './agent-defs.js'
import type { ToolSpec } from './tools.js'

const agent: ChatAgent = {
  slug: 'pa', name: 'PA', description: '', avatar: 'P', colour: 'green', system_prompt: 'Be helpful.',
  knowledge_folders: [], tools: ['search'], model: null, provider: null, schedules: [], version: null, author: null, source: 'file', file: 'x',
}
const tools: ToolSpec[] = [{ type: 'function', function: { name: 'search', description: 'Search', parameters: { type: 'object', properties: { q: { type: 'string' } } } } }]
const none = { hasPoolAccount: () => false }

function fakeFetch(reply: unknown, seen: { url?: string; init?: RequestInit }[]) {
  return (async (url: string, init: RequestInit) => {
    seen.push({ url, init })
    return new Response(JSON.stringify(reply), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }) as unknown as typeof fetch
}

describe('provider choice', () => {
  it('agent file wins, then install default, then env, then the first one set up, else demo', () => {
    expect(chooseProviderId({ ...agent, provider: 'xai' }, 'openai', { env: {}, ...none })).toBe('xai')
    expect(chooseProviderId(agent, 'openai', { env: {}, ...none })).toBe('openai')
    expect(chooseProviderId(agent, null, { env: { AGENT_CHAT_PROVIDER: 'anthropic' }, ...none })).toBe('anthropic')
    expect(chooseProviderId(agent, null, { env: { OPENAI_API_KEY: 'k' }, ...none })).toBe('openai')
    expect(chooseProviderId(agent, null, { env: { OPENAI_API_KEY: 'k', SESSION_JAIL_CLAUDE_OAUTH_TOKEN: 't' }, ...none })).toBe('claude')
    expect(chooseProviderId(agent, null, { env: { ANTHROPIC_API_KEY: 'k' }, ...none })).toBe('anthropic')
    expect(chooseProviderId(agent, null, { env: {}, hasPoolAccount: () => true })).toBe('claude')
    expect(chooseProviderId(agent, null, { env: {}, ...none })).toBe('demo')
  })

  it('a missing key is a plain-language error naming the secret, never a value', () => {
    expect(() => createProvider('xai', agent, { env: {} })).toThrow(ProviderError)
    expect(() => createProvider('xai', agent, { env: {} })).toThrow(/XAI_API_KEY/)
    expect(() => createProvider('anthropic', agent, { env: {} })).toThrow(/ANTHROPIC_API_KEY/)
  })
})

describe('OpenAI-style providers (OpenAI, Grok, custom)', () => {
  it('sends system + tools and returns tool calls', async () => {
    const seen: { url?: string; init?: RequestInit }[] = []
    const call = { id: 'c1', type: 'function', function: { name: 'search', arguments: '{"q":"x"}' } }
    const p = createProvider('xai', agent, { env: { XAI_API_KEY: 'secret-xai' }, fetch: fakeFetch({ choices: [{ message: { content: null, tool_calls: [call] } }] }, seen) })
    expect(p.label).toBe('Grok (xAI)')
    expect(p.model).toBe('grok-4')
    const out = await p.complete({ system: 'SYS', messages: [{ role: 'user', content: 'hi' }], tools, agent })
    expect(out.toolCalls).toEqual([call])
    expect(seen[0].url).toBe('https://api.x.ai/v1/chat/completions')
    const body = JSON.parse(String(seen[0].init?.body))
    expect(body.messages[0]).toEqual({ role: 'system', content: 'SYS' })
    expect(body.tools[0].function.name).toBe('search')
    expect((seen[0].init?.headers as Record<string, string>).Authorization).toBe('Bearer secret-xai')
  })

  it('custom endpoint uses its base URL and the model from the agent file', async () => {
    const seen: { url?: string; init?: RequestInit }[] = []
    const p = createProvider('openai-compatible', { ...agent, model: 'local-model' }, {
      env: { AGENT_CHAT_OPENAI_COMPAT_BASE_URL: 'http://litellm:4000/v1/' },
      fetch: fakeFetch({ choices: [{ message: { content: 'hello' } }] }, seen),
    })
    const out = await p.complete({ system: 's', messages: [{ role: 'user', content: 'hi' }], tools: [], agent })
    expect(out).toEqual({ content: 'hello', toolCalls: [] })
    expect(seen[0].url).toBe('http://litellm:4000/v1/chat/completions')
    expect(JSON.parse(String(seen[0].init?.body)).model).toBe('local-model')
  })
})

describe('Anthropic provider', () => {
  it('converts tool history and maps tool_use back', async () => {
    const seen: { url?: string; init?: RequestInit }[] = []
    const p = createProvider('anthropic', agent, {
      env: { ANTHROPIC_API_KEY: 'k' },
      fetch: fakeFetch({ content: [{ type: 'text', text: 'Looking.' }, { type: 'tool_use', id: 'tu1', name: 'search', input: { q: 'inbox' } }] }, seen),
    })
    const out = await p.complete({
      system: 'SYS',
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'a', type: 'function', function: { name: 'search', arguments: '{"q":"a"}' } }] },
        { role: 'tool', tool_call_id: 'a', content: '{"results":[]}' },
      ],
      tools,
      agent,
    })
    expect(out.content).toBe('Looking.')
    expect(out.toolCalls).toEqual([{ id: 'tu1', type: 'function', function: { name: 'search', arguments: '{"q":"inbox"}' } }])
    const body = JSON.parse(String(seen[0].init?.body))
    expect(body.system).toBe('SYS')
    expect(body.tools[0]).toMatchObject({ name: 'search', input_schema: { type: 'object' } })
    expect(body.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'search', input: { q: 'a' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: '{"results":[]}' }] },
    ])
  })

  it('merges consecutive tool results into one user turn', () => {
    const m = toAnthropicMessages([
      { role: 'tool', tool_call_id: 'a', content: '1' },
      { role: 'tool', tool_call_id: 'b', content: '2' },
    ])
    expect(m).toHaveLength(1)
    expect(m[0].content).toHaveLength(2)
  })
})

describe('Claude subscription provider', () => {
  it('drives the CLI backend with the tool envelope and parses tool calls out of the reply', async () => {
    const prompts: { systemPrompt: string; prompt: string }[] = []
    const p = createProvider('claude', agent, {
      env: {},
      claudeBackend: async req => {
        prompts.push(req)
        return { text: '<tool_calls>[{"name":"search","arguments":{"q":"todo"}}]</tool_calls>', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }, stopReason: null, slot: 'b', costUsd: 0, ttftMs: null, attempts: 1 }
      },
    })
    const out = await p.complete({ system: 'You are PA.', messages: [{ role: 'user', content: 'todo?' }], tools, agent })
    expect(out.toolCalls[0].function).toEqual({ name: 'search', arguments: '{"q":"todo"}' })
    expect(prompts[0].systemPrompt).toContain('You are PA.')
    expect(prompts[0].systemPrompt).toContain('search')
  })
})
