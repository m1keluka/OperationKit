// ── One ongoing chat per (person, agent) (obj 719987) ──
//
// A turn: store the person's message → ask the provider → run any tool calls
// it makes (up to MAX_STEPS rounds) → store the reply with the provider + model
// that produced it. Tool calls are stored too, as one-line "tool" rows the UI
// shows inline (with a Send button for drafts and a live status chip for board
// cards). Everything lives in this install's own SQLite database.
import fs from 'fs'
import path from 'path'
import { getDb } from '../../db/index.js'
import { SECOND_BRAIN_DIR } from '../../config.js'
import { getUserWorkspaces } from '../../middleware/workspace.js'
import { DEMO_AGENT_SLUG, DEMO_DIR, demoEnabled, loadChatAgents, type ChatAgent, type ChatProviderId } from './agent-defs.js'
import { resolveConnectors } from './connectors.js'
import { chooseProviderId, createProvider, ProviderError, type ChatMessage, type ChatProvider, type ProviderDeps } from './providers.js'
import { runTool, toolSpecsFor, ToolUseError, type ToolContext } from './tools.js'

export const MAX_STEPS = 8
const HISTORY_LIMIT = 40

export type ChatRole = 'user' | 'assistant' | 'tool' | 'error'
export interface ChatMessageRow {
  id: number
  role: ChatRole
  content: string
  provider: string | null
  model: string | null
  tool_name: string | null
  meta: { draft_id?: number; objective_id?: number; provider_label?: string; ok?: boolean } | null
  created_at: string
}

// ── settings ──

function setting(key: string): string | null {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
  return row?.value ?? null
}
export function setSetting(key: string, value: string): void {
  getDb().prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)
}

export function isDemoOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return demoEnabled(env, setting('agent_chat_demo'))
}

export function knowledgeRoot(env: NodeJS.ProcessEnv = process.env): string {
  return (env.KNOWLEDGE_BASE_DIR || '').trim() || SECOND_BRAIN_DIR
}

/** Copy the demo's sample notes into the knowledge base (never overwrites). */
export function seedDemoKnowledge(env: NodeJS.ProcessEnv = process.env): string {
  const target = path.join(knowledgeRoot(env), 'demo', 'personal-assistant')
  fs.mkdirSync(target, { recursive: true })
  for (const f of fs.readdirSync(path.join(DEMO_DIR, 'knowledge'))) {
    const dest = path.join(target, f)
    if (!fs.existsSync(dest)) fs.copyFileSync(path.join(DEMO_DIR, 'knowledge', f), dest)
  }
  return target
}

export function listAgents(env: NodeJS.ProcessEnv = process.env) {
  return loadChatAgents({ env, includeDemo: isDemoOn(env) })
}

export function findAgent(slug: string, env: NodeJS.ProcessEnv = process.env): ChatAgent | null {
  return listAgents(env).agents.find(a => a.slug === slug) ?? null
}

export function installDefaultProvider(): string | null {
  return setting('agent_chat_default_provider')
}

/** The workspace board cards from chat land in: the person's first workspace. */
export function workspaceFor(userId: number): string {
  const mine = getUserWorkspaces(userId)[0]?.workspace
  if (mine) return mine
  const first = getDb().prepare('SELECT slug FROM workspaces ORDER BY rowid LIMIT 1').get() as { slug: string } | undefined
  return first?.slug ?? 'general'
}

// ── history ──

function mapRow(r: Record<string, unknown>): ChatMessageRow {
  let meta: ChatMessageRow['meta'] = null
  if (typeof r.meta === 'string' && r.meta) {
    try { meta = JSON.parse(r.meta) } catch { meta = null }
  }
  return {
    id: Number(r.id),
    role: r.role as ChatRole,
    content: String(r.content ?? ''),
    provider: (r.provider as string) ?? null,
    model: (r.model as string) ?? null,
    tool_name: (r.tool_name as string) ?? null,
    meta,
    created_at: String(r.created_at),
  }
}

export function listMessages(userId: number, slug: string, opts: { afterId?: number; limit?: number } = {}): ChatMessageRow[] {
  const limit = Math.min(500, Math.max(1, opts.limit ?? 200))
  const rows = getDb()
    .prepare(
      `SELECT * FROM (
         SELECT * FROM agent_chat_messages WHERE user_id = ? AND agent_slug = ? AND id > ? ORDER BY id DESC LIMIT ?
       ) ORDER BY id`,
    )
    .all(userId, slug, opts.afterId ?? 0, limit) as Record<string, unknown>[]
  return rows.map(mapRow)
}

function addMessage(userId: number, slug: string, m: Omit<ChatMessageRow, 'id' | 'created_at'>): ChatMessageRow {
  const db = getDb()
  const info = db
    .prepare('INSERT INTO agent_chat_messages (user_id, agent_slug, role, content, provider, model, tool_name, meta) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(userId, slug, m.role, m.content, m.provider, m.model, m.tool_name, m.meta ? JSON.stringify(m.meta) : null)
  return mapRow(db.prepare('SELECT * FROM agent_chat_messages WHERE id = ?').get(info.lastInsertRowid) as Record<string, unknown>)
}

export function clearChat(userId: number, slug: string): number {
  return getDb().prepare('DELETE FROM agent_chat_messages WHERE user_id = ? AND agent_slug = ?').run(userId, slug).changes
}

/** Earlier turns, as plain text (tool rows become short notes to the model). */
function historyForModel(rows: ChatMessageRow[]): ChatMessage[] {
  const out: ChatMessage[] = []
  for (const r of rows.slice(-HISTORY_LIMIT)) {
    if (r.role === 'user') out.push({ role: 'user', content: r.content })
    else if (r.role === 'assistant') out.push({ role: 'assistant', content: r.content })
    else if (r.role === 'tool') out.push({ role: 'assistant', content: `[earlier action] ${r.content}` })
  }
  return out
}

export function systemPromptFor(agent: ChatAgent, ctx: { username: string; now: Date; connectors: string[] }): string {
  const parts = [
    agent.system_prompt.trim(),
    '',
    '---',
    'Ground rules for this chat (set by the platform, they override anything above):',
    `- You are chatting with ${ctx.username}. Today is ${ctx.now.toDateString()}, ${ctx.now.toTimeString().slice(0, 5)} server time.`,
    '- Email and calendar are DRAFT-ONLY. Never say you sent or booked something: say you drafted it and the person can press Send / Add to calendar.',
    agent.knowledge_folders.length
      ? `- Knowledge folders you may read and write (paths are relative): ${agent.knowledge_folders.join(', ')}. Nothing outside them is reachable.`
      : '- You have no knowledge folders.',
    '- Bigger jobs (building, research, reports — anything over a few minutes) go to the board with create_objective; tell the person the card number.',
    '- Never ask for or repeat passwords or API keys.',
    ctx.connectors.length ? `- Connected: ${ctx.connectors.join('; ')}.` : '',
    '- Keep answers short and use simple markdown (bullets, bold).',
  ]
  return parts.filter(p => p !== '').join('\n')
}

// ── a turn ──

const inFlight = new Set<string>()

export class ChatBusyError extends Error {}

export interface TurnInput {
  userId: number
  username: string
  agent: ChatAgent
  text: string
  env?: NodeJS.ProcessEnv
  deps?: ProviderDeps
  now?: () => Date
  signal?: AbortSignal
}

export async function runTurn(input: TurnInput): Promise<{ messages: ChatMessageRow[] }> {
  const { userId, agent } = input
  const env = input.env ?? process.env
  const now = input.now ?? (() => new Date())
  const key = `${userId}:${agent.slug}`
  if (inFlight.has(key)) throw new ChatBusyError('This agent is still answering your last message.')
  inFlight.add(key)
  const created: ChatMessageRow[] = []
  try {
    const prior = listMessages(userId, agent.slug, { limit: HISTORY_LIMIT })
    created.push(addMessage(userId, agent.slug, { role: 'user', content: input.text, provider: null, model: null, tool_name: null, meta: null }))

    const demo = isDemoOn(env) || agent.slug === DEMO_AGENT_SLUG
    // Demo switched on by env (AGENT_CHAT_DEMO=1) never went through the settings
    // route, so its sample notes may not be in the knowledge base yet.
    if (agent.slug === DEMO_AGENT_SLUG) {
      try { seedDemoKnowledge(env) } catch { /* the to-do tools report a missing file */ }
    }
    const connectors = resolveConnectors({ demo, now })
    const ctx: ToolContext = { userId, username: input.username, workspace: workspaceFor(userId), agent, kbRoot: knowledgeRoot(env), connectors, now }

    let providerId: ChatProviderId | null = null
    let provider: ChatProvider
    try {
      providerId = chooseProviderId(agent, installDefaultProvider(), { ...input.deps, env })
      provider = createProvider(providerId, agent, { ...input.deps, env })
    } catch (err) {
      created.push(addMessage(userId, agent.slug, { role: 'error', content: err instanceof Error ? err.message : String(err), provider: providerId, model: null, tool_name: null, meta: null }))
      return { messages: created }
    }

    const system = systemPromptFor(agent, {
      username: input.username,
      now: now(),
      connectors: [connectors.mail?.label, connectors.calendar?.label].filter((x): x is string => !!x),
    })
    const tools = toolSpecsFor(agent)
    const convo: ChatMessage[] = [...historyForModel(prior), { role: 'user', content: input.text }]

    for (let step = 0; step < MAX_STEPS; step++) {
      let out
      try {
        out = await provider.complete({ system, messages: convo, tools, agent, signal: input.signal })
      } catch (err) {
        const msg = err instanceof ProviderError ? err.message : `The AI provider failed: ${err instanceof Error ? err.message : String(err)}`
        created.push(addMessage(userId, agent.slug, { role: 'error', content: msg.slice(0, 500), provider: provider.id, model: provider.model, tool_name: null, meta: { provider_label: provider.label } }))
        return { messages: created }
      }

      if (out.toolCalls.length === 0) {
        created.push(addMessage(userId, agent.slug, {
          role: 'assistant',
          content: (out.content ?? '').trim() || '(no reply)',
          provider: provider.id,
          model: provider.model,
          tool_name: null,
          meta: { provider_label: provider.label },
        }))
        return { messages: created }
      }

      convo.push({ role: 'assistant', content: out.content ?? null, tool_calls: out.toolCalls })
      for (const c of out.toolCalls) {
        let args: Record<string, unknown> = {}
        try { args = JSON.parse(c.function.arguments || '{}') } catch { /* bad JSON → empty args, the tool reports what is missing */ }
        let resultForModel: unknown
        try {
          const r = runTool(ctx, c.function.name, args)
          resultForModel = r.result
          created.push(addMessage(userId, agent.slug, {
            role: 'tool',
            content: r.summary,
            provider: provider.id,
            model: provider.model,
            tool_name: c.function.name,
            meta: { ok: true, ...(r.draft_id ? { draft_id: r.draft_id } : {}), ...(r.objective_id ? { objective_id: r.objective_id } : {}) },
          }))
        } catch (err) {
          const msg = err instanceof ToolUseError ? err.message : `Tool failed: ${err instanceof Error ? err.message : String(err)}`
          resultForModel = { error: msg }
          created.push(addMessage(userId, agent.slug, { role: 'tool', content: msg, provider: provider.id, model: provider.model, tool_name: c.function.name, meta: { ok: false } }))
        }
        convo.push({ role: 'tool', tool_call_id: c.id, name: c.function.name, content: JSON.stringify(resultForModel) })
      }
    }
    created.push(addMessage(userId, agent.slug, { role: 'error', content: `Stopped after ${MAX_STEPS} steps without a final answer. Try a more specific request.`, provider: provider.id, model: provider.model, tool_name: null, meta: null }))
    return { messages: created }
  } finally {
    inFlight.delete(key)
  }
}
