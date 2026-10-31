import { Router, type Response } from 'express'
import { requireAuth, type AuthRequest } from '../middleware/auth.js'
import {
  ChatBusyError,
  clearChat,
  findAgent,
  installDefaultProvider,
  isDemoOn,
  listAgents,
  listMessages,
  runTurn,
  seedDemoKnowledge,
  setSetting,
  type ChatMessageRow,
} from '../services/agent-chat/engine.js'
import { CHAT_PROVIDERS, type ChatAgent } from '../services/agent-chat/agent-defs.js'
import { availableProviders, chooseProviderId, DEFAULT_MODELS } from '../services/agent-chat/providers.js'
import { chatCards } from '../services/agent-chat/tools.js'
import {
  getDraft,
  listDrafts,
  resolveConnectors,
  setDraftStatus,
  type DraftRow,
  type EmailDraft,
  type EventDraft,
} from '../services/agent-chat/connectors.js'
import { getDb } from '../db/index.js'

/**
 * Built-in agent chat (obj 719987) — /api/agent-chat
 *
 *   GET    /agents                     agents on this install (+ load problems for admins)
 *   GET    /agents/:slug               one agent's definition (also read by the MCP connector)
 *   GET    /agents/:slug/messages      the caller's ongoing chat with that agent
 *   POST   /agents/:slug/messages      send a message, run the turn, return the new rows
 *   DELETE /agents/:slug/messages      clear the caller's chat with that agent
 *   PUT    /drafts/:id                 edit a draft before sending
 *   POST   /drafts/:id/send            the person's Send / Add to calendar click
 *   POST   /drafts/:id/discard
 *   PUT    /settings                   admin: demo on/off, install default provider
 *
 * Every chat is strictly per person: a caller only ever reads or writes their
 * own messages and drafts. Sending a draft needs a signed-in browser session —
 * an API key (a bot, another agent) can never press Send.
 */
const router: Router = Router()
router.use(requireAuth)

function publicAgent(a: ChatAgent, withPrompt = false) {
  return {
    slug: a.slug,
    name: a.name,
    description: a.description,
    avatar: a.avatar,
    colour: a.colour,
    knowledge_folders: a.knowledge_folders,
    tools: a.tools,
    model: a.model,
    provider: a.provider,
    version: a.version,
    author: a.author,
    source: a.source,
    ...(withPrompt ? { system_prompt: a.system_prompt, schedules: a.schedules } : {}),
  }
}

function providerFor(a: ChatAgent) {
  const id = chooseProviderId(a, installDefaultProvider())
  return { id, model: a.model || DEFAULT_MODELS[id] || null }
}

/** Drafts + card statuses referenced by these messages, so the UI can render them. */
function attachments(userId: number, slug: string, messages: ChatMessageRow[]) {
  const draftIds = new Set(messages.map(m => m.meta?.draft_id).filter((x): x is number => typeof x === 'number'))
  const cardIds = [...new Set(messages.map(m => m.meta?.objective_id).filter((x): x is number => typeof x === 'number'))]
  const drafts = listDrafts(userId, slug).filter(d => draftIds.has(d.id))
  const cards = cardIds.length ? chatCards(userId, slug, cardIds) : []
  return { drafts, cards }
}

function agentOr404(req: AuthRequest, res: Response): ChatAgent | null {
  const a = findAgent(String(req.params.slug))
  if (!a) res.status(404).json({ error: `No agent "${req.params.slug}" on this install` })
  return a
}

router.get('/agents', (req: AuthRequest, res) => {
  const { agents, problems } = listAgents()
  res.json({
    agents: agents.map(a => ({ ...publicAgent(a), answered_by: providerFor(a) })),
    demo: isDemoOn(),
    providers: availableProviders(),
    default_provider: installDefaultProvider(),
    ...(req.user?.role === 'admin' ? { problems } : {}),
  })
})

router.get('/agents/:slug', (req: AuthRequest, res) => {
  const a = agentOr404(req, res)
  if (!a) return
  res.json({ agent: { ...publicAgent(a, true), answered_by: providerFor(a) } })
})

router.get('/agents/:slug/messages', (req: AuthRequest, res) => {
  if (req.authVia === 'agent_api_key') {
    res.status(403).json({ error: 'Chat history is private to the person' })
    return
  }
  const a = agentOr404(req, res)
  if (!a) return
  const after = Number(req.query.after) || 0
  const messages = listMessages(req.user!.id, a.slug, { afterId: after })
  res.json({ messages, ...attachments(req.user!.id, a.slug, messages) })
})

router.post('/agents/:slug/messages', async (req: AuthRequest, res) => {
  if (req.authVia === 'agent_api_key') {
    res.status(403).json({ error: 'Use the MCP tools to work with agents from another AI client' })
    return
  }
  const a = agentOr404(req, res)
  if (!a) return
  const text = typeof req.body?.text === 'string' ? req.body.text.trim() : ''
  if (!text) {
    res.status(400).json({ error: 'text is required' })
    return
  }
  if (text.length > 8000) {
    res.status(400).json({ error: 'Message is too long (8,000 characters max)' })
    return
  }
  const ac = new AbortController()
  res.on('close', () => { if (!res.writableEnded) ac.abort() })
  try {
    const { messages } = await runTurn({ userId: req.user!.id, username: req.user!.username, agent: a, text, signal: ac.signal })
    res.json({ messages, ...attachments(req.user!.id, a.slug, messages) })
  } catch (err) {
    if (err instanceof ChatBusyError) {
      res.status(409).json({ error: err.message })
      return
    }
    console.error('[agent-chat] turn failed:', err instanceof Error ? err.message : err)
    res.status(500).json({ error: 'The chat failed. Try again.' })
  }
})

router.delete('/agents/:slug/messages', (req: AuthRequest, res) => {
  if (req.authVia === 'agent_api_key') {
    res.status(403).json({ error: 'Chat history is private to the person' })
    return
  }
  const removed = clearChat(req.user!.id, String(req.params.slug))
  res.json({ ok: true, removed })
})

// ── drafts: only the owning person, only from a signed-in browser ──

function ownDraft(req: AuthRequest, res: Response): DraftRow | null {
  const d = getDraft(Number(req.params.id))
  if (!d || d.user_id !== req.user!.id) {
    res.status(404).json({ error: 'Draft not found' })
    return null
  }
  return d
}

function signedInBrowser(req: AuthRequest): boolean {
  return !!req.cookies?.token && req.authVia !== 'agent_api_key' && req.authVia !== 'legacy_api_key'
}

router.put('/drafts/:id', (req: AuthRequest, res) => {
  const d = ownDraft(req, res)
  if (!d) return
  if (d.status !== 'draft') {
    res.status(409).json({ error: `This draft is already ${d.status}` })
    return
  }
  const b = (req.body ?? {}) as Record<string, unknown>
  const pick = (k: string, cur: string) => (typeof b[k] === 'string' ? (b[k] as string) : cur)
  let payload: EmailDraft | EventDraft
  if (d.kind === 'email') {
    const p = d.payload as EmailDraft
    payload = { ...p, to: pick('to', p.to), subject: pick('subject', p.subject), body: pick('body', p.body) }
  } else {
    const p = d.payload as EventDraft
    payload = { ...p, title: pick('title', p.title), start: pick('start', p.start), end: pick('end', p.end) }
    if (Number.isNaN(Date.parse(payload.start)) || Number.isNaN(Date.parse(payload.end))) {
      res.status(400).json({ error: 'start/end must be valid dates' })
      return
    }
  }
  getDb().prepare("UPDATE agent_chat_drafts SET payload = ?, updated_at = datetime('now') WHERE id = ?").run(JSON.stringify(payload), d.id)
  res.json({ draft: getDraft(d.id) })
})

router.post('/drafts/:id/send', (req: AuthRequest, res) => {
  if (!signedInBrowser(req)) {
    res.status(403).json({ error: 'Only the person, signed in to the app, can send a draft' })
    return
  }
  const d = ownDraft(req, res)
  if (!d) return
  if (d.status !== 'draft') {
    res.status(409).json({ error: `This draft is already ${d.status}` })
    return
  }
  const conns = resolveConnectors({ demo: isDemoOn() || d.connector === 'demo' })
  if (d.kind === 'email') {
    if (!conns.mail || conns.mail.id !== d.connector) {
      res.status(409).json({ error: 'The email account this draft was made for is not connected any more' })
      return
    }
    conns.mail.deliver(d.payload as EmailDraft)
    setDraftStatus(d.id, 'sent')
  } else {
    if (!conns.calendar || conns.calendar.id !== d.connector) {
      res.status(409).json({ error: 'The calendar this draft was made for is not connected any more' })
      return
    }
    conns.calendar.add(d.payload as EventDraft)
    setDraftStatus(d.id, 'added')
  }
  res.json({ draft: getDraft(d.id) })
})

router.post('/drafts/:id/discard', (req: AuthRequest, res) => {
  const d = ownDraft(req, res)
  if (!d) return
  if (d.status !== 'draft') {
    res.status(409).json({ error: `This draft is already ${d.status}` })
    return
  }
  setDraftStatus(d.id, 'discarded')
  res.json({ draft: getDraft(d.id) })
})

// ── install settings (admin) ──

router.put('/settings', (req: AuthRequest, res) => {
  if (req.user?.role !== 'admin') {
    res.status(403).json({ error: 'Admins only' })
    return
  }
  const b = (req.body ?? {}) as { demo?: unknown; default_provider?: unknown }
  if (b.demo !== undefined) {
    const on = b.demo === true
    setSetting('agent_chat_demo', on ? '1' : '0')
    if (on) {
      try {
        seedDemoKnowledge()
      } catch (err) {
        res.status(500).json({ error: `Could not copy the demo notes into the knowledge base: ${err instanceof Error ? err.message : err}` })
        return
      }
    }
  }
  if (b.default_provider !== undefined) {
    const p = typeof b.default_provider === 'string' ? b.default_provider : ''
    if (p && !(CHAT_PROVIDERS as readonly string[]).includes(p)) {
      res.status(400).json({ error: `default_provider must be one of ${CHAT_PROVIDERS.join(', ')} (or empty for automatic)` })
      return
    }
    setSetting('agent_chat_default_provider', p)
  }
  res.json({ demo: isDemoOn(), default_provider: installDefaultProvider() })
})

export default router
