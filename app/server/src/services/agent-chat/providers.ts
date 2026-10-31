// ── Which AI answers a chat (obj 719987) ──
//
// One small interface, several providers. The conversation is kept in the
// OpenAI chat shape internally (it is the common denominator); each provider
// converts at its edge. Every reply records which provider + model answered,
// and the chat UI shows it under the message.
//
//   claude             Claude subscription. Client install: the one token the
//                      installer stores (SESSION_JAIL_CLAUDE_OAUTH_TOKEN). Operator
//                      host: the account pool the LLM gateway already uses.
//   anthropic          Anthropic API key (ANTHROPIC_API_KEY or SESSION_JAIL_ANTHROPIC_API_KEY)
//   openai             OPENAI_API_KEY
//   xai                Grok — XAI_API_KEY
//   openai-compatible  any OpenAI-style endpoint: AGENT_CHAT_OPENAI_COMPAT_BASE_URL
//                      + AGENT_CHAT_OPENAI_COMPAT_API_KEY (e.g. a LiteLLM proxy)
//   demo               scripted, offline — no AI account at all. Drives the
//                      demo assistant's tools so the demo works anywhere.
//
// Keys are read from the server env (hydrated from Settings → Secrets) by NAME.
// They are only ever sent to their own provider's API, never logged, never
// stored with a message.
import os from 'os'
import path from 'path'
import fs from 'fs'
import {
  translateRequest,
  parseAssistantOutput,
  type OAIMessage,
  type OAIToolCall,
  type OAITool,
} from '../llm-gateway/translate.js'
import { createClaudeCliBackend, runClaudeTurn, gatewaySlotFilter, type LlmBackend } from '../llm-gateway/claude-cli-backend.js'
import { pickAccount, type AccountSlot } from '../account-router.js'
import { CHAT_PROVIDERS, type ChatAgent, type ChatProviderId } from './agent-defs.js'
import type { ToolSpec } from './tools.js'
import { demoReply } from './demo-provider.js'

export type ChatMessage = OAIMessage

export interface CompletionRequest {
  system: string
  messages: ChatMessage[]
  tools: ToolSpec[]
  agent: ChatAgent
  signal?: AbortSignal
}

export interface CompletionResult {
  content: string | null
  toolCalls: OAIToolCall[]
}

export interface ChatProvider {
  id: ChatProviderId
  /** Shown to the person under each reply, e.g. "Claude · claude-sonnet-5". */
  label: string
  model: string
  complete(req: CompletionRequest): Promise<CompletionResult>
}

export class ProviderError extends Error {}

type FetchFn = typeof fetch

export const DEFAULT_MODELS: Record<ChatProviderId, string> = {
  claude: 'claude-sonnet-5',
  anthropic: 'claude-sonnet-5',
  openai: 'gpt-5',
  xai: 'grok-4',
  'openai-compatible': '',
  demo: 'scripted',
}

const LABELS: Record<ChatProviderId, string> = {
  claude: 'Claude',
  anthropic: 'Anthropic API',
  openai: 'OpenAI',
  xai: 'Grok (xAI)',
  'openai-compatible': 'Custom endpoint',
  demo: 'Demo (no AI account)',
}

function env1(env: NodeJS.ProcessEnv, ...names: string[]): string {
  for (const n of names) {
    const v = (env[n] || '').trim()
    if (v) return v
  }
  return ''
}

function anthropicKey(env: NodeJS.ProcessEnv): string {
  return env1(env, 'SESSION_JAIL_ANTHROPIC_API_KEY', 'ANTHROPIC_API_KEY')
}
function claudeToken(env: NodeJS.ProcessEnv): string {
  return env1(env, 'SESSION_JAIL_CLAUDE_OAUTH_TOKEN', 'AGENT_CHAT_CLAUDE_OAUTH_TOKEN')
}
/** Pool slots chat may use: the gateway's allowlist, minus the env-token 'sandbox' slot. */
function poolFilter(env: NodeJS.ProcessEnv): (a: AccountSlot) => boolean {
  const g = gatewaySlotFilter(env)
  return a => a.id !== 'sandbox' && g(a)
}

export interface ProviderDeps {
  env?: NodeJS.ProcessEnv
  fetch?: FetchFn
  /** Claude-subscription backend (tests inject a fake). */
  claudeBackend?: LlmBackend
  /** Is a pool account available? (tests inject). */
  hasPoolAccount?: () => boolean
}

/** Which providers are usable right now, without exposing any key. */
export function availableProviders(deps: ProviderDeps = {}): Record<ChatProviderId, boolean> {
  const env = deps.env ?? process.env
  const hasPool = deps.hasPoolAccount ?? (() => {
    try {
      return pickAccount(poolFilter(env)) !== null
    } catch {
      return false
    }
  })
  return {
    claude: !!claudeToken(env) || !!deps.claudeBackend || hasPool(),
    anthropic: !!anthropicKey(env),
    openai: !!env1(env, 'OPENAI_API_KEY'),
    xai: !!env1(env, 'XAI_API_KEY'),
    'openai-compatible': !!env1(env, 'AGENT_CHAT_OPENAI_COMPAT_BASE_URL'),
    demo: true,
  }
}

/**
 * Pick the provider for one agent: the agent file's `provider`, else the
 * install default (setting agent_chat_default_provider / env AGENT_CHAT_PROVIDER),
 * else the first one that is set up, in this order: claude, anthropic, openai,
 * xai, openai-compatible, demo.
 */
export function chooseProviderId(agent: ChatAgent, installDefault: string | null, deps: ProviderDeps = {}): ChatProviderId {
  const env = deps.env ?? process.env
  const isId = (s: string | null | undefined): s is ChatProviderId => !!s && (CHAT_PROVIDERS as readonly string[]).includes(s)
  if (agent.provider) return agent.provider
  if (isId(installDefault)) return installDefault
  const fromEnv = (env.AGENT_CHAT_PROVIDER || '').trim()
  if (isId(fromEnv)) return fromEnv
  const avail = availableProviders(deps)
  for (const id of ['claude', 'anthropic', 'openai', 'xai', 'openai-compatible'] as const) if (avail[id]) return id
  return 'demo'
}

export function createProvider(id: ChatProviderId, agent: ChatAgent, deps: ProviderDeps = {}): ChatProvider {
  const env = deps.env ?? process.env
  const f = deps.fetch ?? fetch
  const model = agent.model || env1(env, `AGENT_CHAT_${id.toUpperCase().replace(/-/g, '_')}_MODEL`) || DEFAULT_MODELS[id]
  const label = LABELS[id]
  switch (id) {
    case 'demo':
      return { id, label, model, complete: async req => demoReply(req) }
    case 'anthropic': {
      const key = anthropicKey(env)
      if (!key) throw new ProviderError('The Anthropic API key (ANTHROPIC_API_KEY) is not set on this install.')
      return { id, label, model, complete: req => anthropicComplete(f, key, model, req) }
    }
    case 'openai':
    case 'xai':
    case 'openai-compatible': {
      const base =
        id === 'openai' ? 'https://api.openai.com/v1'
        : id === 'xai' ? 'https://api.x.ai/v1'
        : env1(env, 'AGENT_CHAT_OPENAI_COMPAT_BASE_URL').replace(/\/+$/, '')
      const key =
        id === 'openai' ? env1(env, 'OPENAI_API_KEY')
        : id === 'xai' ? env1(env, 'XAI_API_KEY')
        : env1(env, 'AGENT_CHAT_OPENAI_COMPAT_API_KEY')
      if (!base) throw new ProviderError('AGENT_CHAT_OPENAI_COMPAT_BASE_URL is not set on this install.')
      if (!key && id !== 'openai-compatible') throw new ProviderError(`${id === 'xai' ? 'XAI_API_KEY' : 'OPENAI_API_KEY'} is not set on this install.`)
      if (!model) throw new ProviderError('Set a model for the custom endpoint (agent file `model:` or AGENT_CHAT_OPENAI_COMPATIBLE_MODEL).')
      return { id, label, model, complete: req => openAiComplete(f, base, key, model, req) }
    }
    case 'claude': {
      const backend = deps.claudeBackend ?? claudeBackendFor(env)
      return { id, label, model, complete: req => claudeComplete(backend, model, req) }
    }
  }
}

// ── claude (subscription, via the Claude Code CLI the gateway already drives) ──

function claudeBackendFor(env: NodeJS.ProcessEnv): LlmBackend {
  const token = claudeToken(env)
  if (!token) return createClaudeCliBackend({ env: { ...env, LLM_GATEWAY_SLOTS: env.AGENT_CHAT_SLOTS ?? env.LLM_GATEWAY_SLOTS }, pick: f => pickAccount(a => f(a) && a.id !== 'sandbox') })
  // Client install: one long-lived token handed to the CLI as env, in a scratch HOME.
  const home = path.join(os.tmpdir(), 'cc-agent-chat-home')
  fs.mkdirSync(home, { recursive: true, mode: 0o777 })
  try { fs.chmodSync(home, 0o777) } catch { /* best effort */ }
  const slot = { id: 'sandbox', homeDir: home } as AccountSlot
  const timeout = Number(env.AGENT_CHAT_TIMEOUT_MS) > 0 ? Number(env.AGENT_CHAT_TIMEOUT_MS) : 180_000
  return async req => ({ ...(await runClaudeTurn(slot, req, timeout, { CLAUDE_CODE_OAUTH_TOKEN: token })), attempts: 1 })
}

async function claudeComplete(backend: LlmBackend, model: string, req: CompletionRequest): Promise<CompletionResult> {
  const t = translateRequest({
    model,
    messages: [{ role: 'system', content: req.system }, ...req.messages],
    tools: req.tools as OAITool[],
  })
  const r = await backend({ model, systemPrompt: t.systemPrompt, prompt: t.prompt, signal: req.signal })
  const parsed = parseAssistantOutput(r.text, t.toolNames)
  return { content: parsed.content, toolCalls: parsed.toolCalls }
}

// ── OpenAI-style (OpenAI, xAI Grok, LiteLLM, …) ──

async function readError(res: Response): Promise<string> {
  const text = await res.text().catch(() => '')
  try {
    const j = JSON.parse(text)
    return String(j?.error?.message ?? j?.error ?? text).slice(0, 300)
  } catch {
    return text.slice(0, 300)
  }
}

async function openAiComplete(f: FetchFn, base: string, key: string, model: string, req: CompletionRequest): Promise<CompletionResult> {
  const res = await f(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify({
      model,
      messages: [{ role: 'system', content: req.system }, ...req.messages],
      ...(req.tools.length ? { tools: req.tools, tool_choice: 'auto' } : {}),
    }),
    signal: req.signal,
  })
  if (!res.ok) throw new ProviderError(`The AI provider answered ${res.status}: ${await readError(res)}`)
  const j = (await res.json()) as { choices?: { message?: { content?: string | null; tool_calls?: OAIToolCall[] } }[] }
  const msg = j.choices?.[0]?.message
  return { content: msg?.content ?? null, toolCalls: (msg?.tool_calls ?? []).filter(c => c?.type === 'function' || c?.function) }
}

// ── Anthropic Messages API ──

type AnthBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string }

/** OpenAI-shape history → Anthropic messages (tool results become user turns). */
export function toAnthropicMessages(messages: ChatMessage[]): { role: 'user' | 'assistant'; content: AnthBlock[] }[] {
  const out: { role: 'user' | 'assistant'; content: AnthBlock[] }[] = []
  const push = (role: 'user' | 'assistant', block: AnthBlock) => {
    const last = out[out.length - 1]
    if (last && last.role === role) last.content.push(block)
    else out.push({ role, content: [block] })
  }
  for (const m of messages) {
    const text = typeof m.content === 'string' ? m.content : m.content == null ? '' : JSON.stringify(m.content)
    if (m.role === 'user') {
      if (text) push('user', { type: 'text', text })
    } else if (m.role === 'assistant') {
      if (text) push('assistant', { type: 'text', text })
      for (const c of m.tool_calls ?? []) {
        let input: unknown = {}
        try { input = JSON.parse(c.function.arguments || '{}') } catch { /* keep {} */ }
        push('assistant', { type: 'tool_use', id: c.id, name: c.function.name, input })
      }
    } else if (m.role === 'tool') {
      push('user', { type: 'tool_result', tool_use_id: m.tool_call_id ?? '', content: text })
    }
  }
  return out
}

async function anthropicComplete(f: FetchFn, key: string, model: string, req: CompletionRequest): Promise<CompletionResult> {
  const res = await f('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      system: req.system,
      messages: toAnthropicMessages(req.messages),
      ...(req.tools.length
        ? { tools: req.tools.map(t => ({ name: t.function.name, description: t.function.description, input_schema: t.function.parameters })) }
        : {}),
    }),
    signal: req.signal,
  })
  if (!res.ok) throw new ProviderError(`The AI provider answered ${res.status}: ${await readError(res)}`)
  const j = (await res.json()) as { content?: AnthBlock[] }
  const blocks = j.content ?? []
  const text = blocks.filter((b): b is { type: 'text'; text: string } => b.type === 'text').map(b => b.text).join('\n').trim()
  const toolCalls: OAIToolCall[] = blocks
    .filter((b): b is { type: 'tool_use'; id: string; name: string; input: unknown } => b.type === 'tool_use')
    .map(b => ({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }))
  return { content: text || null, toolCalls }
}
