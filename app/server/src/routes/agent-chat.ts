import { Router, type Response } from 'express'
import { requireAuth, type AuthRequest } from '../middleware/auth.js'
import {
  ChatBusyError,
  ChatUnavailableError,
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
import { availableProviders, chooseProviderId, DEFAULT_MODELS, resolveModel } from '../services/agent-chat/providers.js'
import { effectiveTools, visibleCardStatuses } from '../services/agent-chat/tools.js'
import { TOOL_CATALOG } from '../services/agent-chat/tool-names.js'
import { webSearchStatus } from '../services/agent-chat/web-tools.js'
import { BotConfigError, clearBotConfig, hasAllTools, setBotConfig } from '../services/agent-chat/bot-config.js'
import { listEnabledModels } from '../services/model-registry.js'
import { aboutForAgents, ensureAboutFresh, getStoredAbout, queueAboutRefresh, resolveAbout, type BotAbout } from '../services/agent-chat/bot-about.js'
import { redactForStorage } from '../services/secret-redaction.js'
import {
  allHighAgency,
  HIGH_AGENCY_CADENCES,
  HighAgencyError,
  highAgencyView,
  MAX_CARDS_PER_WAKE,
  setHighAgency,
  wakeNow,
  workspaceOptions,
} from '../services/agent-chat/high-agency.js'
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
import { getAttachment, ImageRejected, parseIncomingImages, type IncomingImage } from '../services/agent-chat/attachments.js'
import {
  createThread,
  deleteThread,
  listThreads,
  maxThreadsPerBot,
  resolveLane,
  ThreadRejected,
  updateThread,
  type ChatLane,
} from '../services/agent-chat/threads.js'

/**
 * Built-in agent chat (obj 719987) — /api/agent-chat
 *
 *   GET    /agents                     agents on this install (+ load problems for admins)
 *   GET    /agents/:slug               one agent's definition (also read by the MCP connector)
 *   GET    /agents/:slug/messages      the caller's ongoing chat with that agent
 *   POST   /agents/:slug/messages      send a message, run the turn, return the new rows
 *   DELETE /agents/:slug/messages      clear the caller's chat with that agent
 *   GET    /agents/:slug/threads       the caller's side threads with that agent
 *   POST   /agents/:slug/threads       open a new side thread (a concurrent task lane)
 *   PATCH  /agents/:slug/threads/:id   rename / pin / archive (= close) a side thread
 *   DELETE /agents/:slug/threads/:id   delete a side thread and its messages
 *   GET    /attachments/:id            one image the caller attached (owner only)
 *   PUT    /drafts/:id                 edit a draft before sending
 *   POST   /drafts/:id/send            the person's Send / Add to calendar click
 *   POST   /drafts/:id/discard
 *   PUT    /settings                   admin: demo on/off, install default provider
 *   PUT    /agents/:slug/config        admin: this bot's default model / provider / tools / all tools (obj 900671)
 *   DELETE /agents/:slug/config        admin: reset the bot to exactly what its agent file says
 *   GET    /agents/:slug/high-agency   this bot's High Agency setting, wake times and last wake (obj 900748)
 *   PUT    /agents/:slug/high-agency   admin: High Agency on/off, times a day, first wake hour, workspace, permissions
 *   POST   /agents/:slug/high-agency/wake  admin: one wake now (works while off, to try it)
 *
 * ABOUT (obj 900747). Every agent carries `about`: the description, how-to and
 * example prompts the "i" panel shows, with the file's own text winning and
 * generated text filling the rest (services/agent-chat/bot-about.ts). A list
 * read queues a background refresh for any bot whose cached About no longer
 * matches it, and a settings change queues one straight away. GET /agents/:slug
 * also carries `instructions`: the system prompt the panel shows READ-ONLY,
 * with high-confidence secret shapes masked. Nothing here edits a prompt.
 *
 * Every chat is strictly per person: a caller only ever reads or writes their
 * own messages and drafts. Sending a draft needs a signed-in browser session —
 * an API key (a bot, another agent) can never press Send.
 *
 * SIDE THREADS (obj 900370). The three /messages routes take an optional
 * `thread_id` — query string on GET/DELETE, body field on POST. Omitting it
 * means the MAIN conversation, which is why every existing caller is unaffected.
 * `resolveLane` is the single gate: a `thread_id` that is not the caller's own,
 * or belongs to a different bot, 404s rather than quietly falling back to the
 * main conversation (a silent fallback would write a side-thread message into
 * the main history, which is exactly the leak this feature must not have).
 */
const router: Router = Router()
router.use(requireAuth)

function publicAgent(a: ChatAgent, withPrompt = false, about?: BotAbout) {
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
    how_to_use: a.how_to_use,
    example_prompts: a.example_prompts,
    source: a.source,
    // obj 900671: what the bot can actually call, and where each setting comes from.
    all_tools: hasAllTools(a),
    effective_tools: effectiveTools(a),
    file_defaults: a.file_defaults ?? { provider: a.provider, model: a.model, tools: a.tools },
    config: a.config
      ? { provider: a.config.provider, model: a.config.model, tools: a.config.tools, all_tools: a.config.all_tools, updated_by: a.config.updated_by, updated_at: a.config.updated_at }
      : null,
    // obj 900747: the resolved About (file text first, generated text for the rest).
    about: about ?? resolveAbout(a, getStoredAbout(a.slug)),
    ...(withPrompt
      ? { system_prompt: a.system_prompt, schedules: a.schedules, instructions: redactForStorage(a.system_prompt).text }
      : {}),
  }
}

/** One agent for a response, after queueing an About refresh if its definition changed. */
function agentResponse(a: ChatAgent, opts: { force?: boolean; reason?: string } = {}) {
  try {
    queueAboutRefresh(a, opts)
  } catch (err) {
    console.warn('[agent-chat] About refresh not queued:', err instanceof Error ? err.message : err)
  }
  return { ...publicAgent(a, true), answered_by: providerFor(a) }
}

function providerFor(a: ChatAgent) {
  const id = chooseProviderId(a, installDefaultProvider())
  return { id, model: resolveModel(id, a) || null }
}

/**
 * Model ids the bot page offers per provider (obj 900671). Suggestions only:
 * the field is free text, because a provider ships models faster than this
 * list. Claude ids come from the install's own model registry (Settings →
 * Models), so a model switched off there is not suggested here.
 */
function modelSuggestions(): Record<string, string[]> {
  let registry: { id: string; engine: string }[] = []
  try { registry = listEnabledModels() } catch { /* no registry table → defaults only */ }
  const uniq = (xs: string[]) => [...new Set(xs.filter(Boolean))]
  const claude = uniq([...registry.filter(m => m.engine === 'claude').map(m => m.id), DEFAULT_MODELS.claude])
  return {
    claude,
    anthropic: claude,
    openai: uniq([DEFAULT_MODELS.openai]),
    xai: uniq([...registry.filter(m => m.engine === 'grok').map(m => m.id), DEFAULT_MODELS.xai]),
    'openai-compatible': [],
    demo: [DEFAULT_MODELS.demo],
  }
}

/** Only a signed-in admin may change what a bot runs on — never an API key (a bot must not grant itself tools). */
function adminSessionOr403(req: AuthRequest, res: Response): boolean {
  if (req.user?.role !== 'admin' || req.authVia !== 'session') {
    res.status(403).json({ error: 'Only an admin signed in to Command Center can change a bot\'s model or tools.' })
    return false
  }
  return true
}

/** Drafts + card statuses referenced by these messages, so the UI can render them. */
function attachments(userId: number, slug: string, messages: ChatMessageRow[]) {
  const draftIds = new Set(messages.map(m => m.meta?.draft_id).filter((x): x is number => typeof x === 'number'))
  const cardIds = [...new Set(messages.map(m => m.meta?.objective_id).filter((x): x is number => typeof x === 'number'))]
  const drafts = listDrafts(userId, slug).filter(d => draftIds.has(d.id))
  const cards = visibleCardStatuses(userId, cardIds)
  return { drafts, cards }
}

function agentOr404(req: AuthRequest, res: Response): ChatAgent | null {
  const a = findAgent(String(req.params.slug))
  if (!a) res.status(404).json({ error: `No agent "${req.params.slug}" on this install` })
  return a
}

/** A ThreadRejected carries its own status; anything else is a real 500. */
function threadError(res: Response, err: unknown): void {
  if (err instanceof ThreadRejected) {
    res.status(err.status).json({ error: err.message })
    return
  }
  console.error('[agent-chat] side thread failed:', err instanceof Error ? err.message : err)
  res.status(500).json({ error: 'That did not work. Try again.' })
}

/**
 * Which conversation this request means. Returns null AFTER answering, so a
 * caller can `if (!lane) return` the same way it does for agentOr404.
 */
function laneOr404(req: AuthRequest, res: Response, slug: string, raw: unknown): ChatLane | null {
  try {
    return resolveLane(req.user!.id, slug, raw)
  } catch (err) {
    threadError(res, err)
    return null
  }
}

router.get('/agents', (req: AuthRequest, res) => {
  const { agents, problems } = listAgents()
  // obj 900747: a bot edited outside the app (its file by hand, a built-in by a
  // release) gets its About refreshed the first time the list notices.
  ensureAboutFresh(agents)
  const about = aboutForAgents(agents)
  // obj 900748: whether each bot has High Agency on, for a badge in the list.
  let ha: ReturnType<typeof allHighAgency> = new Map()
  try { ha = allHighAgency() } catch { /* no table yet → every bot is off */ }
  res.json({
    agents: agents.map(a => {
      const h = ha.get(a.slug)
      return { ...publicAgent(a, false, about.get(a.slug)), answered_by: providerFor(a), high_agency: { enabled: !!h?.enabled, times_per_day: h?.times_per_day ?? 1 } }
    }),
    demo: isDemoOn(),
    providers: availableProviders(),
    default_provider: installDefaultProvider(),
    // obj 900671: the bot page's tool picker, model field and web-search status.
    tool_catalog: TOOL_CATALOG,
    model_suggestions: modelSuggestions(),
    default_models: DEFAULT_MODELS,
    web: webSearchStatus(),
    ...(req.user?.role === 'admin' ? { problems } : {}),
  })
})

router.put('/agents/:slug/config', (req: AuthRequest, res) => {
  if (!adminSessionOr403(req, res)) return
  const a = agentOr404(req, res)
  if (!a) return
  try {
    setBotConfig(a.slug, (req.body ?? {}) as Record<string, unknown>, req.user!.username)
  } catch (err) {
    if (err instanceof BotConfigError) {
      res.status(err.status).json({ error: err.message })
      return
    }
    throw err
  }
  const updated = findAgent(a.slug)!
  res.json({ agent: agentResponse(updated, { force: true, reason: 'bot settings changed' }) })
})

router.delete('/agents/:slug/config', (req: AuthRequest, res) => {
  if (!adminSessionOr403(req, res)) return
  const a = agentOr404(req, res)
  if (!a) return
  clearBotConfig(a.slug)
  const updated = findAgent(a.slug)!
  res.json({ agent: agentResponse(updated, { force: true, reason: 'bot settings reset' }) })
})

// ── High Agency (obj 900748): per-bot scheduled "what's next?" wakes ──

function highAgencyPayload(req: AuthRequest, slug: string) {
  const isAdmin = req.user?.role === 'admin'
  return {
    high_agency: highAgencyView(slug),
    cadences: HIGH_AGENCY_CADENCES,
    max_cards_per_wake: MAX_CARDS_PER_WAKE,
    ...(isAdmin ? { workspace_options: workspaceOptions(req.user!.id) } : {}),
  }
}

function highAgencyError(res: Response, err: unknown): boolean {
  if (err instanceof HighAgencyError) {
    res.status(err.status).json({ error: err.message })
    return true
  }
  return false
}

router.get('/agents/:slug/high-agency', (req: AuthRequest, res) => {
  const a = agentOr404(req, res)
  if (!a) return
  res.json(highAgencyPayload(req, a.slug))
})

router.put('/agents/:slug/high-agency', (req: AuthRequest, res) => {
  if (!adminSessionOr403(req, res)) return
  const a = agentOr404(req, res)
  if (!a) return
  try {
    setHighAgency(a, (req.body ?? {}) as Record<string, unknown>, { id: req.user!.id, username: req.user!.username })
  } catch (err) {
    if (highAgencyError(res, err)) return
    throw err
  }
  res.json(highAgencyPayload(req, a.slug))
})

router.post('/agents/:slug/high-agency/wake', async (req: AuthRequest, res) => {
  if (!adminSessionOr403(req, res)) return
  const a = agentOr404(req, res)
  if (!a) return
  try {
    const result = await wakeNow(a, { id: req.user!.id, username: req.user!.username })
    res.status(result.ok ? 200 : 409).json({ result, ...highAgencyPayload(req, a.slug) })
  } catch (err) {
    if (highAgencyError(res, err)) return
    console.error('[agent-chat] high agency wake failed:', err instanceof Error ? err.message : err)
    res.status(500).json({ error: 'The wake failed. Try again.' })
  }
})


router.get('/agents/:slug', (req: AuthRequest, res) => {
  const a = agentOr404(req, res)
  if (!a) return
  res.json({ agent: agentResponse(a) })
})

router.get('/agents/:slug/messages', (req: AuthRequest, res) => {
  if (req.authVia === 'agent_api_key') {
    res.status(403).json({ error: 'Chat history is private to the person' })
    return
  }
  const a = agentOr404(req, res)
  if (!a) return
  const lane = laneOr404(req, res, a.slug, req.query.thread_id)
  if (!lane) return
  const after = Number(req.query.after) || 0
  const messages = listMessages(req.user!.id, a.slug, { afterId: after, lane })
  res.json({ messages, ...attachments(req.user!.id, a.slug, messages) })
})

// ── side threads / concurrent task lanes (obj 900370) ──

router.get('/agents/:slug/threads', (req: AuthRequest, res) => {
  if (req.authVia === 'agent_api_key') {
    res.status(403).json({ error: 'Chat history is private to the person' })
    return
  }
  const a = agentOr404(req, res)
  if (!a) return
  const threads = listThreads(req.user!.id, a.slug, { includeArchived: req.query.archived === '1' })
  res.json({ threads, max_open: maxThreadsPerBot() })
})

router.post('/agents/:slug/threads', (req: AuthRequest, res) => {
  if (req.authVia === 'agent_api_key') {
    res.status(403).json({ error: 'Chat history is private to the person' })
    return
  }
  const a = agentOr404(req, res)
  if (!a) return
  try {
    res.status(201).json({ thread: createThread(req.user!.id, a.slug, (req.body ?? {}).title) })
  } catch (err) {
    threadError(res, err)
  }
})

router.patch('/agents/:slug/threads/:id', (req: AuthRequest, res) => {
  if (req.authVia === 'agent_api_key') {
    res.status(403).json({ error: 'Chat history is private to the person' })
    return
  }
  const a = agentOr404(req, res)
  if (!a) return
  const b = (req.body ?? {}) as Record<string, unknown>
  try {
    res.json({ thread: updateThread(req.user!.id, a.slug, Number(req.params.id), { title: b.title, pinned: b.pinned, archived: b.archived }) })
  } catch (err) {
    threadError(res, err)
  }
})

/**
 * Delete a side thread outright. The lane's messages and images go with it; the
 * main conversation is not read or written by this path at all.
 */
router.delete('/agents/:slug/threads/:id', (req: AuthRequest, res) => {
  if (req.authVia === 'agent_api_key') {
    res.status(403).json({ error: 'Chat history is private to the person' })
    return
  }
  const a = agentOr404(req, res)
  if (!a) return
  const lane = laneOr404(req, res, a.slug, req.params.id)
  if (!lane) return
  const removed = clearChat(req.user!.id, a.slug, lane)
  deleteThread(req.user!.id, a.slug, Number(req.params.id))
  res.json({ ok: true, removed })
})

router.post('/agents/:slug/messages', async (req: AuthRequest, res) => {
  if (req.authVia === 'agent_api_key') {
    res.status(403).json({ error: 'Use the MCP tools to work with agents from another AI client' })
    return
  }
  const a = agentOr404(req, res)
  if (!a) return
  const lane = laneOr404(req, res, a.slug, req.body?.thread_id)
  if (!lane) return
  const text = typeof req.body?.text === 'string' ? req.body.text.trim() : ''
  let images: IncomingImage[]
  try {
    images = parseIncomingImages(req.body?.images)
  } catch (err) {
    res.status(400).json({ error: err instanceof ImageRejected ? err.message : 'That attachment could not be read.' })
    return
  }
  // A pasted screenshot on its own is a perfectly good message, so text is only
  // required when nothing is attached.
  if (!text && images.length === 0) {
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
    const { messages } = await runTurn({ userId: req.user!.id, username: req.user!.username, agent: a, text, images, lane, signal: ac.signal })
    res.json({ messages, ...attachments(req.user!.id, a.slug, messages) })
  } catch (err) {
    if (err instanceof ChatBusyError) {
      res.status(409).json({ error: err.message })
      return
    }
    if (err instanceof ChatUnavailableError) {
      // No seat could answer (obj 900624): a real error status the UI shows as
      // "message not sent", not a 200 with an error row in the transcript.
      res.setHeader('Retry-After', '30')
      res.status(err.status).json({ error: err.message, code: 'ai_unavailable', reason: err.reason, messages: err.messages })
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
  const slug = String(req.params.slug)
  const lane = laneOr404(req, res, slug, req.query.thread_id)
  if (!lane) return
  const removed = clearChat(req.user!.id, slug, lane)
  res.json({ ok: true, removed })
})

/**
 * One attached image (obj 900157). Strictly the person who attached it: the
 * same per-person rule the messages follow. Served with nosniff + a locked-down
 * CSP and never as an attachment download, so a stored byte string can't be
 * talked into executing in the app's origin.
 */
router.get('/attachments/:id', (req: AuthRequest, res) => {
  const id = Number(req.params.id)
  const a = Number.isInteger(id) ? getAttachment(id) : null
  if (!a || a.user_id !== req.user!.id) {
    res.status(404).json({ error: 'Attachment not found' })
    return
  }
  res.set({
    'Content-Type': a.media_type,
    'Content-Length': String(a.bytes.length),
    'Content-Disposition': `inline; filename="${a.name.replace(/"/g, '')}"`,
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'Cache-Control': 'private, max-age=3600',
  })
  res.end(a.bytes)
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
