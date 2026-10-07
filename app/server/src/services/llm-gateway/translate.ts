import crypto from 'crypto'

// ── OpenAI Chat Completions ⇄ Claude Code prompt translation ──
//
// The gateway drives the Claude Code CLI as a pure LLM (all built-in tools
// disabled), so the CLI cannot carry OpenAI `tools` natively. Function calling
// is prompt-based instead: the caller's tools are rendered into the system
// prompt, and the model answers a tool turn with a strict envelope
//
//   <tool_calls>[{"name": "...", "arguments": {...}}]</tool_calls>
//
// which we parse back into OpenAI `tool_calls`. Prior turns (including
// assistant tool_calls and role:tool results) are replayed as a transcript.

export const SUPPORTED_MODELS = ['claude-sonnet-5', 'claude-opus-5-5', 'claude-haiku-4-5-20251001'] as const
export const DEFAULT_MODEL = 'claude-sonnet-5'

export type OAIRole = 'system' | 'developer' | 'user' | 'assistant' | 'tool'

export interface OAIContentPart {
  type: string
  text?: string
}

export interface OAIToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export interface OAIMessage {
  role: OAIRole
  content?: string | OAIContentPart[] | null
  name?: string
  tool_calls?: OAIToolCall[]
  tool_call_id?: string
}

export interface OAITool {
  type: 'function'
  function: { name: string; description?: string; parameters?: unknown; strict?: boolean }
}

export type OAIToolChoice = 'auto' | 'none' | 'required' | { type: 'function'; function: { name: string } }

export interface OAIResponseFormat {
  type: 'text' | 'json_object' | 'json_schema'
  json_schema?: { name?: string; schema?: unknown }
}

export interface OAIChatRequest {
  model?: string
  messages: OAIMessage[]
  tools?: OAITool[]
  tool_choice?: OAIToolChoice
  response_format?: OAIResponseFormat
  stream?: boolean
  stream_options?: { include_usage?: boolean }
}

export interface TranslatedPrompt {
  systemPrompt: string
  prompt: string
  /** Tool names the model may call this turn (empty = tools off). */
  toolNames: string[]
}

export const TOOL_CALLS_OPEN = '<tool_calls>'
export const TOOL_CALLS_CLOSE = '</tool_calls>'

const BASE_SYSTEM = [
  'You are the language model behind an OpenAI-compatible chat completions API.',
  'You have no tools, files, or environment of your own: answer only from the conversation and any functions offered below.',
  'Reply directly with the assistant message itself, with no preamble about this setup.',
].join(' ')

/** Validation error surfaced to the caller as a 400. */
export class InvalidRequestError extends Error {
  constructor(message: string, readonly param?: string) {
    super(message)
  }
}

export function contentToText(content: OAIMessage['content']): string {
  if (content == null) return ''
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return String(content)
  return content
    .map(part => {
      if (part && typeof part === 'object') {
        if (typeof part.text === 'string') return part.text
        if (part.type === 'image_url' || part.type === 'input_image') return '[image omitted: images are not supported by this gateway]'
      }
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

function safeParseJson(s: string): unknown {
  try {
    return JSON.parse(s)
  } catch {
    return s
  }
}

export function validateChatRequest(body: unknown): OAIChatRequest {
  if (!body || typeof body !== 'object') throw new InvalidRequestError('Request body must be a JSON object')
  const req = body as OAIChatRequest
  if (!Array.isArray(req.messages) || req.messages.length === 0) {
    throw new InvalidRequestError('messages must be a non-empty array', 'messages')
  }
  for (const [i, m] of req.messages.entries()) {
    if (!m || typeof m !== 'object' || !['system', 'developer', 'user', 'assistant', 'tool'].includes(m.role)) {
      throw new InvalidRequestError(`messages[${i}].role is invalid`, `messages[${i}].role`)
    }
  }
  if (req.tools !== undefined) {
    if (!Array.isArray(req.tools)) throw new InvalidRequestError('tools must be an array', 'tools')
    for (const [i, t] of req.tools.entries()) {
      if (!t || t.type !== 'function' || !t.function || typeof t.function.name !== 'string' || !t.function.name) {
        throw new InvalidRequestError(`tools[${i}] must be {type:"function", function:{name,...}}`, `tools[${i}]`)
      }
    }
  }
  return req
}

function activeTools(req: OAIChatRequest): OAITool[] {
  const tools = req.tools ?? []
  if (tools.length === 0 || req.tool_choice === 'none') return []
  return tools
}

function toolsBlock(tools: OAITool[], choice: OAIToolChoice | undefined): string {
  const defs = tools.map(t => ({
    name: t.function.name,
    ...(t.function.description ? { description: t.function.description } : {}),
    parameters: t.function.parameters ?? { type: 'object', properties: {} },
  }))
  const lines = [
    '# Function calling',
    'You can call these functions (parameters are JSON Schema):',
    '<functions>',
    JSON.stringify(defs, null, 2),
    '</functions>',
    '',
    'To call one or more functions, your ENTIRE reply must be exactly this envelope and nothing else:',
    `${TOOL_CALLS_OPEN}[{"name": "<function name>", "arguments": {<arguments object matching its schema>}}]${TOOL_CALLS_CLOSE}`,
    'Rules: no text before or after the envelope; arguments must be a valid JSON object; only call functions listed above; you may list several calls in the array.',
    'Function results come back to you as <tool_result> messages; use them to write your answer.',
    'When no function is needed, reply normally in plain text and never mention this protocol.',
  ]
  if (choice === 'required') lines.push('For this reply you MUST call at least one function.')
  else if (choice && typeof choice === 'object' && choice.function?.name) {
    lines.push(`For this reply you MUST call the function "${choice.function.name}".`)
  }
  return lines.join('\n')
}

function responseFormatBlock(fmt: OAIResponseFormat | undefined): string {
  if (!fmt || fmt.type === 'text') return ''
  const lines = ['# Output format', 'Reply with a single valid JSON value only: no prose, no markdown code fences.']
  if (fmt.type === 'json_schema' && fmt.json_schema?.schema) {
    lines.push('It must conform to this JSON Schema:', JSON.stringify(fmt.json_schema.schema))
  }
  return lines.join('\n')
}

function renderToolCalls(calls: OAIToolCall[]): string {
  const arr = calls.map(c => ({ id: c.id, name: c.function?.name, arguments: safeParseJson(c.function?.arguments ?? '{}') }))
  return `${TOOL_CALLS_OPEN}${JSON.stringify(arr)}${TOOL_CALLS_CLOSE}`
}

function escapeAttr(s: string): string {
  return s.replace(/[&"<>]/g, c => ({ '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;' })[c] as string)
}

/**
 * Translate an OpenAI chat request into (system prompt, user prompt) for one
 * headless Claude Code turn.
 */
export function translateRequest(req: OAIChatRequest): TranslatedPrompt {
  const tools = activeTools(req)
  const callerSystem = req.messages
    .filter(m => m.role === 'system' || m.role === 'developer')
    .map(m => contentToText(m.content).trim())
    .filter(Boolean)

  const systemParts = [BASE_SYSTEM]
  if (callerSystem.length) systemParts.push(callerSystem.join('\n\n'))
  if (tools.length) systemParts.push(toolsBlock(tools, req.tool_choice))
  const fmt = responseFormatBlock(req.response_format)
  if (fmt) systemParts.push(fmt)

  const turns = req.messages.filter(m => m.role !== 'system' && m.role !== 'developer')

  // A lone user message goes through verbatim — the cheapest, most natural prompt.
  if (turns.length === 1 && turns[0].role === 'user') {
    return { systemPrompt: systemParts.join('\n\n'), prompt: contentToText(turns[0].content), toolNames: tools.map(t => t.function.name) }
  }

  const callNames = new Map<string, string>()
  const rendered: string[] = []
  for (const m of turns) {
    if (m.role === 'user') {
      rendered.push(`<message role="user">\n${contentToText(m.content)}\n</message>`)
    } else if (m.role === 'assistant') {
      const parts: string[] = []
      const text = contentToText(m.content)
      if (text) parts.push(text)
      if (m.tool_calls?.length) {
        for (const c of m.tool_calls) if (c?.id && c.function?.name) callNames.set(c.id, c.function.name)
        parts.push(renderToolCalls(m.tool_calls))
      }
      rendered.push(`<message role="assistant">\n${parts.join('\n')}\n</message>`)
    } else if (m.role === 'tool') {
      const id = m.tool_call_id ?? ''
      const name = m.name ?? callNames.get(id) ?? ''
      rendered.push(
        `<message role="tool">\n<tool_result tool_call_id="${escapeAttr(id)}" name="${escapeAttr(name)}">\n${contentToText(m.content)}\n</tool_result>\n</message>`,
      )
    }
  }

  const prompt = [
    'Here is the conversation so far:',
    '<conversation>',
    rendered.join('\n'),
    '</conversation>',
    '',
    'Write the assistant\'s next reply.',
  ].join('\n')
  return { systemPrompt: systemParts.join('\n\n'), prompt, toolNames: tools.map(t => t.function.name) }
}

// ── Output parsing ──

export function newToolCallId(): string {
  return `call_${crypto.randomBytes(12).toString('hex')}`
}

function stripFences(s: string): string {
  const t = s.trim()
  const m = t.match(/^```[a-zA-Z]*\s*([\s\S]*?)\s*```$/)
  return m ? m[1] : t
}

/**
 * Parse the body of a <tool_calls> envelope into OpenAI tool calls. Returns
 * null when the envelope is not valid JSON / names no allowed function, so the
 * caller can fall back to treating the output as plain text.
 */
export function parseToolCallsJson(body: string, allowed: string[]): OAIToolCall[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(stripFences(body))
  } catch {
    return null
  }
  let list: unknown[]
  if (Array.isArray(parsed)) list = parsed
  else if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { tool_calls?: unknown[] }).tool_calls)) {
    list = (parsed as { tool_calls: unknown[] }).tool_calls
  } else if (parsed && typeof parsed === 'object') list = [parsed]
  else return null

  const allow = new Set(allowed)
  const calls: OAIToolCall[] = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const rec = item as { name?: unknown; arguments?: unknown; function?: { name?: unknown; arguments?: unknown } }
    const name = typeof rec.name === 'string' ? rec.name : typeof rec.function?.name === 'string' ? rec.function.name : ''
    if (!name || !allow.has(name)) continue
    let args = rec.arguments ?? rec.function?.arguments ?? {}
    if (typeof args === 'string') {
      const p = safeParseJson(args)
      args = typeof p === 'object' && p !== null ? p : {}
    }
    calls.push({ id: newToolCallId(), type: 'function', function: { name, arguments: JSON.stringify(args) } })
  }
  return calls.length ? calls : null
}

export interface ParsedOutput {
  content: string | null
  toolCalls: OAIToolCall[]
}

/** Parse a complete model reply into OpenAI message content + tool_calls. */
export function parseAssistantOutput(text: string, toolNames: string[]): ParsedOutput {
  if (toolNames.length === 0) return { content: text, toolCalls: [] }
  const open = text.indexOf(TOOL_CALLS_OPEN)
  if (open < 0) return { content: text, toolCalls: [] }
  const afterOpen = text.slice(open + TOOL_CALLS_OPEN.length)
  const close = afterOpen.indexOf(TOOL_CALLS_CLOSE)
  const body = close >= 0 ? afterOpen.slice(0, close) : afterOpen
  const calls = parseToolCallsJson(body, toolNames)
  if (!calls) return { content: text, toolCalls: [] }
  const before = text.slice(0, open).trim()
  return { content: before || null, toolCalls: calls }
}

/**
 * Incremental version of parseAssistantOutput for streaming. Text is passed
 * through as it arrives, except that any trailing fragment which could be the
 * start of `<tool_calls>` is held back; once the full tag appears, everything
 * after it is buffered and parsed as tool calls at finish().
 */
export class ToolEnvelopeStreamer {
  private pending = ''
  private toolBuf: string | null = null

  constructor(private readonly toolNames: string[]) {}

  /** Feed a text delta; returns the text that is safe to emit now. */
  push(delta: string): string {
    if (this.toolBuf !== null) {
      this.toolBuf += delta
      return ''
    }
    if (this.toolNames.length === 0) return delta
    this.pending += delta
    const idx = this.pending.indexOf(TOOL_CALLS_OPEN)
    if (idx >= 0) {
      const out = this.pending.slice(0, idx)
      this.toolBuf = this.pending.slice(idx + TOOL_CALLS_OPEN.length)
      this.pending = ''
      return out
    }
    let keep = 0
    for (let k = Math.min(TOOL_CALLS_OPEN.length - 1, this.pending.length); k > 0; k--) {
      if (TOOL_CALLS_OPEN.startsWith(this.pending.slice(-k))) {
        keep = k
        break
      }
    }
    const out = this.pending.slice(0, this.pending.length - keep)
    this.pending = this.pending.slice(this.pending.length - keep)
    return out
  }

  /** Flush at end of stream: remaining text + parsed tool calls. */
  finish(): { text: string; toolCalls: OAIToolCall[] } {
    if (this.toolBuf === null) {
      const text = this.pending
      this.pending = ''
      return { text, toolCalls: [] }
    }
    const close = this.toolBuf.indexOf(TOOL_CALLS_CLOSE)
    const body = close >= 0 ? this.toolBuf.slice(0, close) : this.toolBuf
    const calls = parseToolCallsJson(body, this.toolNames)
    if (!calls) return { text: TOOL_CALLS_OPEN + this.toolBuf, toolCalls: [] }
    return { text: '', toolCalls: calls }
  }
}
