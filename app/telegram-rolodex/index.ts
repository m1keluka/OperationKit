// Phase 5 Personal CRM — Telegram Rolodex bot (sibling process).
//
// Architecture (see ai-workspace/agents/rolodex.md for the agent persona):
//   Telegram → Caddy (/telegram/rolodex) → unix socket → this process →
//     Anthropic Messages API (tool-use loop) → vault tools via
//     http://127.0.0.1:3002/api/internal/vault/* → reply via sendMessage
//
// Single-owner: every incoming update whose user.id ≠ TELEGRAM_ROLODEX_OWNER_ID
// is rejected with a polite refusal — even reading the bot's tools is restricted.
//
// State: stateless process. Per-chat history lives in rolodex_threads (loaded
// and saved through the CC internal API), so this process can crash/restart
// without losing context. We trim history to ~20 turns to keep prompts bounded.
//
// Dependencies: NONE outside node:* + fetch(). The sibling is intentionally
// dependency-free so it doesn't need its own node_modules — tsx handles TS,
// and the bind mount makes the source visible inside the container.

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'

// Listen on a unix socket by default — avoids the docker-compose port-binding
// change (which would require recreate-on-update) and lets Caddy reach the bot
// via the /home/operator/projects bind mount. If your Caddy user can't read the
// socket, set ROLODEX_LISTEN_PORT to fall back to TCP on 127.0.0.1.
const SOCKET_PATH = process.env.ROLODEX_SOCKET_PATH || '/home/operator/projects/.cc-rolodex.sock'
const LISTEN_PORT = process.env.ROLODEX_LISTEN_PORT ? parseInt(process.env.ROLODEX_LISTEN_PORT, 10) : 0
const CC_API_BASE = process.env.CC_API_BASE || 'http://127.0.0.1:3002'
const AGENT_FILE = process.env.ROLODEX_AGENT_FILE || '/home/operator/ai-workspace/agents/rolodex.md'
const MODEL = process.env.ROLODEX_MODEL || 'claude-sonnet-4-6'
const MAX_TOOL_ITERATIONS = 8       // hard cap on tool-use loop per turn
const HISTORY_MAX_MESSAGES = 40     // ~20 turns (user + assistant), bounded by tokens via truncation
const TELEGRAM_MAX_CHARS = 4096

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || ''
const OWNER_ID = process.env.TELEGRAM_ROLODEX_OWNER_ID || ''
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || ''

if (!TELEGRAM_BOT_TOKEN || !OWNER_ID || !ANTHROPIC_API_KEY) {
  console.error('[rolodex] Missing required env: TELEGRAM_BOT_TOKEN, TELEGRAM_ROLODEX_OWNER_ID, ANTHROPIC_API_KEY')
  process.exit(2)
}

// ── Telegram types ─────────────────────────────────────────────────────────

interface TelegramUser { id: number; username?: string; first_name?: string }
interface TelegramChat { id: number }
interface TelegramMessage {
  message_id: number
  from?: TelegramUser
  chat: TelegramChat
  text?: string
  date: number
}
interface TelegramUpdate {
  update_id: number
  message?: TelegramMessage
  edited_message?: TelegramMessage
}

// ── Anthropic types (subset) ───────────────────────────────────────────────

interface AnthropicTextBlock { type: 'text'; text: string }
interface AnthropicToolUseBlock { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
interface AnthropicToolResultBlock { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }
type AnthropicContentBlock = AnthropicTextBlock | AnthropicToolUseBlock | AnthropicToolResultBlock

interface AnthropicMessage {
  role: 'user' | 'assistant'
  content: string | AnthropicContentBlock[]
}

interface AnthropicResponse {
  id: string
  role: 'assistant'
  content: AnthropicContentBlock[]
  stop_reason: string
  usage?: { input_tokens: number; output_tokens: number }
}

interface AnthropicToolDef {
  name: string
  description: string
  input_schema: Record<string, unknown>
}

// ── Tool catalog ───────────────────────────────────────────────────────────
// Every tool maps to a CC internal API endpoint. The bot doesn't reimplement
// any vault logic — it just shapes inputs and forwards them.

const TOOLS: AnthropicToolDef[] = [
  {
    name: 'vault_search',
    description: 'Search the contacts index by name, email, company, or role. Use BEFORE writing to find the right contact path. Returns up to 20 matches by default.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Free-text query. Matches name/email/company/role with case-insensitive LIKE.' },
        limit: { type: 'integer', description: 'Max results (default 20, cap 100).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'vault_read',
    description: 'Read a vault markdown file by its vault-relative path (e.g. "personal/contacts/alice-smith.md"). Returns the full content.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
  },
  {
    name: 'vault_append_note',
    description: 'Append a timestamped bullet under a heading in a contact note. Use for free-form context you want to preserve without changing structured fields.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Vault-relative .md path of the contact file.' },
        heading: { type: 'string', description: 'Heading to nest under (default "Notes").' },
        text: { type: 'string', description: 'The note content. Will be appended as a bullet with current timestamp.' },
      },
      required: ['path', 'text'],
    },
  },
  {
    name: 'vault_append_touchpoint',
    description: 'Record an interaction with a contact. Updates frontmatter last_interaction (if newer), recomputes next_touchpoint, and appends a line under ## Touchpoints. Use this when the owner tells you they met/called/emailed someone.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Vault-relative .md path of the contact.' },
        date: { type: 'string', description: 'YYYY-MM-DD. Defaults to today (UTC).' },
        summary: { type: 'string', description: 'One-line summary of the interaction.' },
        channel: { type: 'string', description: 'Optional: "call", "email", "meeting", "DM", etc.' },
      },
      required: ['path', 'summary'],
    },
  },
  {
    name: 'vault_update_field',
    description: 'Update a single frontmatter field on a contact file. Allowed fields: name, email, phone, company, role, tags, follow_up_days, last_interaction, confidence, workspace, next_touchpoint.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        field: { type: 'string' },
        value: { description: 'New value. Pass null to delete the field. Numbers and strings supported.' },
      },
      required: ['path', 'field', 'value'],
    },
  },
  {
    name: 'vault_create_contact',
    description: 'Create a new contact file. Fails if a file with the same slug already exists. Slug is derived from name.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        email: { type: 'string' },
        phone: { type: 'string' },
        company: { type: 'string' },
        role: { type: 'string' },
        workspace: { type: 'string', description: 'personal | example | example-project | personal. Defaults to "personal".' },
        tags: { type: 'array', items: { type: 'string' } },
        follow_up_days: { type: 'integer' },
        notes: { type: 'string', description: 'Optional initial Notes section body.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'recent_interactions',
    description: 'Fetch recent Granola meetings (by attendee match) and Gmail snippets (by sender match) for a contact. Use to refresh context before drafting follow-ups.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Vault-relative .md path of the contact.' },
        limit: { type: 'integer', description: 'Per-source cap (default 10).' },
      },
      required: ['path'],
    },
  },
]

// Map tool name → CC internal API path. POST with the same input.
const TOOL_ROUTE: Record<string, string> = {
  vault_search: '/api/internal/vault/search',
  vault_read: '/api/internal/vault/read',
  vault_append_note: '/api/internal/vault/append-note',
  vault_append_touchpoint: '/api/internal/vault/append-touchpoint',
  vault_update_field: '/api/internal/vault/update-field',
  vault_create_contact: '/api/internal/vault/create-contact',
  recent_interactions: '/api/internal/vault/recent-interactions',
}

async function dispatchTool(name: string, input: Record<string, unknown>): Promise<string> {
  const route = TOOL_ROUTE[name]
  if (!route) return JSON.stringify({ error: `Unknown tool: ${name}` })
  try {
    const res = await fetch(`${CC_API_BASE}${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    })
    const text = await res.text()
    if (!res.ok) {
      return JSON.stringify({ error: `${res.status} ${res.statusText}`, body: text.slice(0, 500) })
    }
    // Cap tool result size — Anthropic charges for input tokens on each iteration.
    return text.length > 8000 ? text.slice(0, 8000) + '\n…[truncated]' : text
  } catch (err) {
    return JSON.stringify({ error: err instanceof Error ? err.message : String(err) })
  }
}

// ── CC internal API helpers (history persistence) ──────────────────────────

async function loadHistory(chatId: string): Promise<AnthropicMessage[]> {
  try {
    const res = await fetch(`${CC_API_BASE}/api/internal/rolodex/history/${encodeURIComponent(chatId)}`)
    if (!res.ok) return []
    const data = await res.json() as { history?: AnthropicMessage[] }
    return Array.isArray(data.history) ? data.history : []
  } catch (err) {
    console.error('[rolodex] loadHistory failed:', err)
    return []
  }
}

async function saveHistory(chatId: string, userId: string, history: AnthropicMessage[]): Promise<void> {
  try {
    await fetch(`${CC_API_BASE}/api/internal/rolodex/history`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, user_id: userId, history }),
    })
  } catch (err) {
    console.error('[rolodex] saveHistory failed:', err)
  }
}

// Drop oldest user/assistant pairs until we're under HISTORY_MAX_MESSAGES.
// We never split a pair — that breaks Anthropic's tool_use/tool_result coupling.
function trimHistory(messages: AnthropicMessage[]): AnthropicMessage[] {
  if (messages.length <= HISTORY_MAX_MESSAGES) return messages
  // Keep last N; round down to even count so we don't strand an assistant turn.
  const keep = HISTORY_MAX_MESSAGES - (HISTORY_MAX_MESSAGES % 2)
  return messages.slice(-keep)
}

// ── Anthropic conversation turn ────────────────────────────────────────────

let cachedSystemPrompt: { mtimeMs: number; text: string } | null = null
function loadSystemPrompt(): string {
  try {
    const stat = fs.statSync(AGENT_FILE)
    if (cachedSystemPrompt && cachedSystemPrompt.mtimeMs === stat.mtimeMs) return cachedSystemPrompt.text
    const text = fs.readFileSync(AGENT_FILE, 'utf-8')
    cachedSystemPrompt = { mtimeMs: stat.mtimeMs, text }
    return text
  } catch (err) {
    console.error('[rolodex] failed to read agent file', AGENT_FILE, err)
    return 'You are the owner\'s personal CRM assistant. Use the vault_* tools to manage contacts.'
  }
}

async function callAnthropic(messages: AnthropicMessage[]): Promise<AnthropicResponse> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 4096,
      system: loadSystemPrompt(),
      tools: TOOLS,
      messages,
    }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Anthropic ${res.status} ${res.statusText}: ${body.slice(0, 400)}`)
  }
  return res.json() as Promise<AnthropicResponse>
}

/**
 * Run one user turn: append user message, loop tool calls, return final
 * assistant text + the messages added to history (which is the entire
 * round-trip including tool_use / tool_result so Anthropic can see them).
 */
async function runTurn(history: AnthropicMessage[], userText: string): Promise<{ text: string; added: AnthropicMessage[] }> {
  const added: AnthropicMessage[] = [{ role: 'user', content: userText }]
  let working = [...history, ...added]

  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    const response = await callAnthropic(working)
    const assistantMsg: AnthropicMessage = { role: 'assistant', content: response.content }
    added.push(assistantMsg)
    working = [...working, assistantMsg]

    const toolUses = response.content.filter((b): b is AnthropicToolUseBlock => b.type === 'tool_use')
    if (toolUses.length === 0) {
      const texts = response.content
        .filter((b): b is AnthropicTextBlock => b.type === 'text')
        .map(b => b.text)
        .join('\n')
        .trim()
      return { text: texts || '(no reply)', added }
    }

    // Dispatch all tool_use blocks in this assistant message in parallel.
    const results = await Promise.all(toolUses.map(async tu => ({
      type: 'tool_result' as const,
      tool_use_id: tu.id,
      content: await dispatchTool(tu.name, tu.input),
    })))
    const userToolMsg: AnthropicMessage = { role: 'user', content: results }
    added.push(userToolMsg)
    working = [...working, userToolMsg]
  }

  // Iteration cap hit — last-ditch text response.
  return { text: 'I made too many tool calls without finishing. Could you narrow what you need?', added }
}

// ── Telegram client ────────────────────────────────────────────────────────

const TG_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`

async function sendMessage(chatId: number, text: string): Promise<void> {
  // Telegram caps at 4096; chunk long replies and send in order.
  let remaining = text
  while (remaining.length > 0) {
    const chunk = remaining.slice(0, TELEGRAM_MAX_CHARS)
    remaining = remaining.slice(TELEGRAM_MAX_CHARS)
    const res = await fetch(`${TG_API}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: chunk }),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      console.error(`[rolodex] sendMessage failed ${res.status}: ${body}`)
      return
    }
  }
}

async function sendTyping(chatId: number): Promise<void> {
  try {
    await fetch(`${TG_API}/sendChatAction`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, action: 'typing' }),
    })
  } catch {/* best-effort */}
}

// ── Webhook handler ────────────────────────────────────────────────────────

async function handleUpdate(update: TelegramUpdate): Promise<void> {
  const message = update.message || update.edited_message
  if (!message) return
  const fromId = message.from?.id ? String(message.from.id) : ''
  const chatId = message.chat.id
  const text = (message.text || '').trim()
  if (!text) return

  // HARD allowlist — single owner, by Telegram user id.
  if (fromId !== OWNER_ID) {
    console.warn(`[rolodex] rejected message from user_id=${fromId} chat=${chatId}`)
    await sendMessage(chatId, "Sorry — this bot is private. If you think you should have access, contact its owner.")
    return
  }

  // Built-in commands.
  if (text === '/reset' || text === '/clear') {
    await saveHistory(String(chatId), fromId, [])
    await sendMessage(chatId, 'History cleared. New thread.')
    return
  }
  if (text === '/start' || text === '/help') {
    await sendMessage(chatId,
      'Rolodex bot online. Send me what you remember about a contact or who you just met with — I\'ll look them up, log the interaction, and keep your vault tidy.\n\n' +
      'Commands: /reset to clear history.')
    return
  }

  await sendTyping(chatId)

  try {
    const prior = await loadHistory(String(chatId))
    const { text: reply, added } = await runTurn(prior, text)
    const next = trimHistory([...prior, ...added])
    await saveHistory(String(chatId), fromId, next)
    await sendMessage(chatId, reply)
  } catch (err) {
    console.error('[rolodex] turn failed:', err)
    await sendMessage(chatId, `Something went wrong: ${err instanceof Error ? err.message : 'unknown error'}`)
  }
}

// ── HTTP server (unix socket) ──────────────────────────────────────────────

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', chunk => { data += chunk })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, model: MODEL }))
    return
  }
  if (req.method !== 'POST') {
    res.writeHead(405); res.end(); return
  }
  // Caddy strips the upstream path? Actually `handle_path /telegram/rolodex*`
  // strips the prefix; `handle /telegram/rolodex*` passes it through. Accept both.
  if (req.url !== '/' && req.url !== '/telegram/rolodex' && req.url !== '/webhook') {
    res.writeHead(404); res.end(); return
  }
  let body = ''
  try { body = await readBody(req) } catch { res.writeHead(400); res.end(); return }
  let update: TelegramUpdate
  try { update = JSON.parse(body) as TelegramUpdate } catch {
    res.writeHead(400); res.end(); return
  }
  // ACK Telegram immediately; process the update async. Telegram retries
  // on non-2xx within 60s, which would dupe replies — always 200 fast.
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end('{"ok":true}')
  handleUpdate(update).catch(err => console.error('[rolodex] handleUpdate threw:', err))
})

if (LISTEN_PORT > 0) {
  server.listen(LISTEN_PORT, '127.0.0.1', () => {
    console.log(`[rolodex] listening on 127.0.0.1:${LISTEN_PORT} (model=${MODEL})`)
  })
} else {
  // Remove any stale socket file from a previous run — listen() refuses if it exists.
  try { fs.unlinkSync(SOCKET_PATH) } catch { /* ok if absent */ }
  fs.mkdirSync(path.dirname(SOCKET_PATH), { recursive: true })
  server.listen(SOCKET_PATH, () => {
    // 0666: this VPS is single-tenant and the bot still validates Telegram user_id
    // against TELEGRAM_ROLODEX_OWNER_ID, so even a spoofed POST gets rejected.
    // Tightening to 0660 would require knowing the host Caddy user (typically `caddy`
    // or root); if you need that, chown the socket after start or switch to LISTEN_PORT.
    try { fs.chmodSync(SOCKET_PATH, 0o666) } catch {/* ignore */}
    console.log(`[rolodex] listening on ${SOCKET_PATH} (model=${MODEL})`)
  })
}

function shutdown(): void {
  console.log('[rolodex] shutting down')
  server.close(() => {
    if (LISTEN_PORT === 0) { try { fs.unlinkSync(SOCKET_PATH) } catch { /* ok */ } }
    process.exit(0)
  })
  setTimeout(() => process.exit(0), 3000).unref()
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
