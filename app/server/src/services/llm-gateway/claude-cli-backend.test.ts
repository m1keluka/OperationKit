import { describe, it, expect, vi, beforeEach } from 'vitest'

// The real account router persists to /home/operator/transcripts — never touch it from tests.
vi.mock('../account-router.js', () => ({
  pickAccount: vi.fn(),
  recordRateLimit: vi.fn(),
  recordAuthFailure: vi.fn(),
  isRateLimitMessage: (t: string) => /rate limit|usage limit/i.test(t),
  isAuthFailureMessage: (t: string) => /invalid authentication credentials|authentication_failed/i.test(t),
  parseResetTime: () => null,
}))

import {
  buildClaudeArgs,
  buildClaudeEnv,
  buildSpawnCommand,
  applyStreamLine,
  createClaudeCliBackend,
  gatewaySlotFilter,
  BackendError,
} from './claude-cli-backend.js'
import type { AccountSlot } from '../account-router.js'

const slot = (id: string): AccountSlot => ({
  id, label: id, priority: id === 'a' ? 10 : 0, homeDir: `/home/ccuser-${id}`, sessionsToday: 0, tokensToday: 0, costToday: 0,
  lastRateLimit: null, rateLimitResetsAt: null, activeSessions: [], usageLog: [],
})

describe('Claude Code invocation is a pure LLM call', () => {
  it('disables every built-in tool, MCP, settings/hooks, skills and session persistence', () => {
    const args = buildClaudeArgs('claude-sonnet-5', 'SYS')
    const at = (flag: string) => args[args.indexOf(flag) + 1]
    expect(args).toContain('-p')
    expect(at('--tools')).toBe('') // "" = no built-in tools at all
    expect(args).toContain('--strict-mcp-config')
    expect(args).not.toContain('--mcp-config')
    expect(at('--setting-sources')).toBe('')
    expect(args).toContain('--disable-slash-commands')
    expect(args).toContain('--no-session-persistence')
    expect(at('--system-prompt')).toBe('SYS')
    expect(at('--model')).toBe('claude-sonnet-5')
    expect(args).not.toContain('--dangerously-skip-permissions')
    expect(args).not.toContain('--allowedTools')
  })

  it('runs with a scrubbed env: account HOME, no server secrets / API keys', () => {
    const env = buildClaudeEnv('/home/ccuser-b', { PATH: '/bin', ANTHROPIC_API_KEY: 'sk-x', TWENTY_LLM_GATEWAY_KEY: 'k', JWT_SECRET: 's' })
    expect(env.HOME).toBe('/home/ccuser-b')
    expect(env.PATH).toBe('/app/data/cli/node_modules/.bin:/bin')
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(env.TWENTY_LLM_GATEWAY_KEY).toBeUndefined()
    expect(env.JWT_SECRET).toBeUndefined()
  })
})

describe('CLI binary selection', () => {
  it('prepends CC_CLI_BIN_DIR (the newer CLI board sessions use); empty disables it', () => {
    expect(buildClaudeEnv('/h', { PATH: '/usr/bin', CC_CLI_BIN_DIR: '/opt/cli' }).PATH).toBe('/opt/cli:/usr/bin')
    expect(buildClaudeEnv('/h', { PATH: '/usr/bin', CC_CLI_BIN_DIR: '' }).PATH).toBe('/usr/bin')
  })
})

describe('spawn command', () => {
  it('as root: hops to ccuser and re-sets HOME to the slot home AFTER runuser (runuser resets HOME)', () => {
    const env = buildClaudeEnv('/app/data/cc-accounts/f', { PATH: '/usr/bin' })
    const [cmd, argv] = buildSpawnCommand(env, ['-p', '--tools', ''], true)
    expect(cmd).toBe('runuser')
    expect(argv).toEqual(['-u', 'ccuser', '--', 'env', 'HOME=/app/data/cc-accounts/f', 'PATH=/app/data/cli/node_modules/.bin:/usr/bin', 'claude', '-p', '--tools', ''])
  })
  it('as a normal user: runs claude directly (env carries HOME)', () => {
    expect(buildSpawnCommand({ HOME: '/home/ccuser-b' }, ['-p'], false)).toEqual(['claude', ['-p']])
  })
})

describe('slot allowlist', () => {
  it("defaults to every slot except 'a'", () => {
    const f = gatewaySlotFilter({})
    expect(f(slot('a'))).toBe(false)
    expect(['b', 'c', 'd', 'e', 'f', 'g'].every(id => f(slot(id)))).toBe(true)
  })
  it('LLM_GATEWAY_SLOTS overrides', () => {
    const f = gatewaySlotFilter({ LLM_GATEWAY_SLOTS: 'c, f' })
    expect(['a', 'b', 'c', 'f'].map(id => f(slot(id)))).toEqual([false, false, true, true])
  })
})

describe('stream-json parsing', () => {
  const st = () => ({ text: '', sawDelta: false, fallbackText: '', usage: null, stopReason: null, costUsd: 0, resultError: null, rateLimited: null, authFailed: null, ttftMs: null }) as any

  it('collects text deltas, stop reason and usage', () => {
    const s = st()
    const deltas: string[] = []
    const lines = [
      { type: 'system', subtype: 'init', tools: [] },
      { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'po' } } },
      { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ng' } } },
      { type: 'stream_event', event: { type: 'message_delta', delta: { stop_reason: 'end_turn' } } },
      { type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } },
      { type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.001, usage: { input_tokens: 400, cache_read_input_tokens: 71, output_tokens: 4 } },
    ]
    for (const l of lines) applyStreamLine(JSON.stringify(l), s, Date.now(), d => deltas.push(d))
    expect(deltas).toEqual(['po', 'ng'])
    expect(s.text).toBe('pong')
    expect(s.stopReason).toBe('end_turn')
    expect(s.usage).toEqual({ prompt_tokens: 471, completion_tokens: 4, total_tokens: 475 })
    expect(s.rateLimited).toBeNull()
  })

  it('never streams the CLI\'s synthetic error text as content', () => {
    const s = st()
    const deltas: string[] = []
    applyStreamLine(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Not logged in · Please run /login' }] } }), s, 0, d => deltas.push(d))
    applyStreamLine(JSON.stringify({ type: 'result', is_error: true, result: 'Not logged in · Please run /login', usage: {} }), s, 0, d => deltas.push(d))
    expect(deltas).toEqual([])
    expect(s.text).toBe('')
    expect(s.resultError).toContain('Not logged in')
  })

  it('releases a delta-less assistant message only on a successful result', () => {
    const s = st()
    const deltas: string[] = []
    applyStreamLine(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hello' }] } }), s, 0, d => deltas.push(d))
    expect(deltas).toEqual([])
    applyStreamLine(JSON.stringify({ type: 'result', is_error: false, usage: { input_tokens: 1, output_tokens: 1 } }), s, 0, d => deltas.push(d))
    expect(deltas).toEqual(['hello'])
    expect(s.text).toBe('hello')
  })

  it('flags rejected rate limits and 401 auth failures', () => {
    const s = st()
    applyStreamLine(JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1791009600 } }), s, 0)
    expect(s.rateLimited?.reset?.getTime()).toBe(1791009600 * 1000)
    const s2 = st()
    applyStreamLine(JSON.stringify({ type: 'result', is_error: true, api_error_status: 401, result: 'Failed to authenticate' }), s2, 0)
    expect(s2.authFailed).toBeTruthy()
  })
})

describe('account rotation', () => {
  const okResult = { text: 'hi', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }, stopReason: 'end_turn', costUsd: 0, ttftMs: 5 }

  beforeEach(() => vi.clearAllMocks())

  it('never hands slot a to the gateway by default', async () => {
    const pool = [slot('a'), slot('b')]
    const pick = vi.fn((f: (a: AccountSlot) => boolean) => pool.find(f) ?? null)
    const run = vi.fn(async (a: AccountSlot) => ({ ...okResult, slot: a.id }))
    const backend = createClaudeCliBackend({ env: {}, pick, run: run as any })
    const r = await backend({ model: 'claude-sonnet-5', systemPrompt: '', prompt: 'x' })
    expect(r.slot).toBe('b')
  })

  it('rotates to another allowed slot on a pre-output rate limit, then succeeds', async () => {
    const pool = [slot('b'), slot('c')]
    const pick = vi.fn((f: (a: AccountSlot) => boolean) => pool.find(f) ?? null)
    const run = vi.fn(async (a: AccountSlot) => {
      if (a.id === 'b') throw new BackendError('rate_limit', 'rl', 'b')
      return { ...okResult, slot: a.id }
    })
    const backend = createClaudeCliBackend({ env: {}, pick, run: run as any })
    const r = await backend({ model: 'claude-sonnet-5', systemPrompt: '', prompt: 'x' })
    expect(r.slot).toBe('c')
    expect(r.attempts).toBe(2)
  })

  it('fails with no_account when only slot a exists', async () => {
    const pick = vi.fn((f: (a: AccountSlot) => boolean) => [slot('a')].find(f) ?? null)
    const backend = createClaudeCliBackend({ env: {}, pick, run: vi.fn() as any })
    await expect(backend({ model: 'claude-sonnet-5', systemPrompt: '', prompt: 'x' })).rejects.toMatchObject({ kind: 'no_account' })
  })
})
