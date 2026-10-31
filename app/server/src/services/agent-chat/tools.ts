// ── What a chat agent can DO (obj 719987) ──
//
// Every tool runs inside this Node process with three hard limits that the
// model cannot talk its way around:
//   1. Knowledge: paths are relative to the knowledge-base root and must fall
//      inside one of the agent's knowledge_folders (checked after resolving
//      symlinks). Nothing else on disk is reachable.
//   2. Email / calendar: draft-only. Drafts are stored; nothing is delivered
//      until the person clicks Send in the chat (routes/agent-chat.ts).
//   3. Board: an agent can file cards in the person's workspace and read back
//      the cards THIS chat filed. The card then runs like any other card —
//      sandboxed (SESSION_ISOLATION=docker) on a client install.
// An agent only gets the tools its file lists under `tools:`.
import fs from 'fs'
import path from 'path'
import { getDb } from '../../db/index.js'
import { depthForParent } from '../../lib/objective-depth.js'
import { defaultAgentForWorkspace } from '../../routes/objectives-helpers.js'
import { broadcast } from '../../ws/index.js'
import { getInitialStatus, type Objective } from '@operationkit/shared'
import type { ChatAgent } from './agent-defs.js'
import { createDraft, type Connectors, type EmailDraft, type EventDraft } from './connectors.js'
import { workspaceKbRoot } from '../doc-ingest/kb-paths.js'
import { ingestEnabled } from '../doc-ingest/service.js'
import { fileAnswer } from '../kb-wiki/answers.js'

export interface ToolSpec {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}

export interface ToolContext {
  userId: number
  username: string
  workspace: string
  agent: ChatAgent
  kbRoot: string
  connectors: Connectors
  now?: () => Date
}

/** What the chat UI shows for a tool call (drafts get buttons, cards get a status chip). */
export interface ToolOutcome {
  /** Fed back to the model. */
  result: unknown
  /** One plain-language line for the person. */
  summary: string
  draft_id?: number
  objective_id?: number
}

export class ToolUseError extends Error {}

const TEXT_EXT = new Set(['.md', '.txt', '.csv', '.json', '.yaml', '.yml'])
const WRITE_EXT = new Set(['.md', '.txt', '.csv'])
const MAX_READ_CHARS = 20_000
const MAX_WRITE_BYTES = 200_000

function obj(props: Record<string, unknown>, required: string[] = []): Record<string, unknown> {
  return { type: 'object', properties: props, required, additionalProperties: false }
}
function fn(name: string, description: string, parameters: Record<string, unknown>): ToolSpec {
  return { type: 'function', function: { name, description, parameters } }
}

const SPECS: Record<string, ToolSpec[]> = {
  search: [fn('search', 'Search your knowledge folders for words. Returns matching files with a short snippet. Open one with read_file.',
    obj({ q: { type: 'string', description: 'Words to look for' } }, ['q']))],
  list_folders: [fn('list_folders', 'List the files and folders inside one of your knowledge folders. Omit path to see your top-level folders.',
    obj({ path: { type: 'string', description: 'Folder path relative to the knowledge base, e.g. "notes/clients"' } }))],
  read_file: [fn('read_file', 'Read one text file from your knowledge folders.',
    obj({ path: { type: 'string', description: 'File path relative to the knowledge base' } }, ['path']))],
  write_doc: [fn('write_doc', 'Create or replace one .md/.txt/.csv file in your knowledge folders. Send the FULL new content; read the file first when editing.',
    obj({ path: { type: 'string' }, content: { type: 'string' } }, ['path', 'content']))],
  file_answer: [fn('file_answer', 'Save a good answer into the workspace knowledge base as a wiki page, linked from the pages it used, so later questions can build on it. Only save answers the person found useful.',
    obj({ question: { type: 'string' }, answer: { type: 'string', description: 'The answer in markdown; cite pages as [[folder/page.md]]' }, sources: { type: 'array', items: { type: 'string' }, description: 'Knowledge-base paths of the pages the answer used, e.g. "people/dana-ruiz.md"' } }, ['question', 'answer']))],
  create_objective: [fn('create_objective', 'Hand a bigger job to the team board as a card. Coding tools pick it up and do the work; you can check its status later with get_objective. Use for anything that takes more than a few minutes.',
    obj({ title: { type: 'string', description: 'Short, specific title' }, description: { type: 'string', description: 'What to do, the context, and what "done" looks like' } }, ['title', 'description']))],
  get_objective: [fn('get_objective', 'Check the status and latest result of a card this chat created.',
    obj({ id: { type: 'integer' } }, ['id']))],
  list_objectives: [fn('list_objectives', 'List the cards this chat has created, newest first, with their status.', obj({}))],
  email: [
    fn('email_list_inbox', 'List recent emails in the inbox (newest first).',
      obj({ limit: { type: 'integer', minimum: 1, maximum: 50 }, unread_only: { type: 'boolean' } })),
    fn('email_read', 'Read one email in full.', obj({ id: { type: 'string' } }, ['id'])),
    fn('email_create_draft', 'Prepare an email DRAFT. It is NOT sent: the person reviews it and presses Send themselves.',
      obj({ to: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' }, in_reply_to: { type: 'string', description: 'Email id this replies to, if any' } }, ['to', 'subject', 'body'])),
  ],
  calendar: [
    fn('calendar_list_events', 'List calendar events between two dates (ISO 8601). Defaults to the next 7 days.',
      obj({ from: { type: 'string' }, to: { type: 'string' } })),
    fn('calendar_draft_event', 'Prepare a calendar event or invite as a DRAFT. It is NOT added: the person reviews it and presses "Add to calendar".',
      obj({ title: { type: 'string' }, start: { type: 'string', description: 'ISO 8601 date-time' }, end: { type: 'string', description: 'ISO 8601 date-time' }, with: { type: 'array', items: { type: 'string' } }, note: { type: 'string' } }, ['title', 'start', 'end'])),
  ],
}

/** The function specs this agent may call — only what its file lists. */
export function toolSpecsFor(agent: ChatAgent): ToolSpec[] {
  const out: ToolSpec[] = []
  for (const t of agent.tools) out.push(...(SPECS[t] ?? []))
  return out
}

/** Which agent-file tool name a function belongs to (email_read → email). */
function owningTool(fnName: string): string | null {
  for (const [tool, specs] of Object.entries(SPECS)) if (specs.some(s => s.function.name === fnName)) return tool
  return null
}

// ── knowledge-folder confinement ──

function realOrParent(p: string): string {
  // Resolve symlinks on the longest existing prefix, then re-append the rest.
  let cur = p
  const tail: string[] = []
  for (;;) {
    try {
      return path.join(fs.realpathSync(cur), ...tail.reverse())
    } catch {
      const parent = path.dirname(cur)
      if (parent === cur) return p
      tail.push(path.basename(cur))
      cur = parent
    }
  }
}

function inside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/** Resolve a model-supplied path; throws unless it is inside an allowed folder. */
export function resolveKnowledgePath(ctx: Pick<ToolContext, 'kbRoot' | 'agent'>, raw: string): { abs: string; rel: string } {
  if (ctx.agent.knowledge_folders.length === 0) throw new ToolUseError('This agent has no knowledge folders.')
  const cleaned = String(raw ?? '').trim().replace(/\\/g, '/').replace(/^\/+/, '')
  if (!cleaned) throw new ToolUseError('A path is required.')
  const root = realOrParent(path.resolve(ctx.kbRoot))
  const abs = realOrParent(path.resolve(root, cleaned))
  const allowed = ctx.agent.knowledge_folders.some(f => inside(abs, realOrParent(path.resolve(root, f))))
  if (!inside(abs, root) || !allowed) {
    throw new ToolUseError(`"${cleaned}" is outside this agent's knowledge folders (${ctx.agent.knowledge_folders.join(', ')}).`)
  }
  return { abs, rel: path.relative(root, abs).split(path.sep).join('/') }
}

function walk(dir: string, out: string[], cap: number): void {
  if (out.length >= cap) return
  let entries: fs.Dirent[] = []
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out, cap)
    else if (e.isFile() && TEXT_EXT.has(path.extname(e.name).toLowerCase())) out.push(p)
    if (out.length >= cap) return
  }
}

function knowledgeSearch(ctx: ToolContext, q: string) {
  const terms = q.toLowerCase().split(/\s+/).filter(t => t.length > 1)
  if (terms.length === 0) throw new ToolUseError('Search needs at least one word.')
  const root = path.resolve(ctx.kbRoot)
  const files: string[] = []
  for (const f of ctx.agent.knowledge_folders) walk(path.resolve(root, f), files, 2000)
  const hits: { path: string; score: number; snippet: string }[] = []
  for (const file of files) {
    let text: string
    try {
      const st = fs.statSync(file)
      if (st.size > 1_000_000) continue
      text = fs.readFileSync(file, 'utf8')
    } catch {
      continue
    }
    const lower = text.toLowerCase()
    const rel = path.relative(root, file).split(path.sep).join('/')
    let score = 0
    for (const t of terms) {
      if (rel.toLowerCase().includes(t)) score += 3
      let idx = lower.indexOf(t)
      while (idx >= 0 && score < 50) { score++; idx = lower.indexOf(t, idx + t.length) }
    }
    if (score === 0) continue
    const at = Math.max(0, Math.min(...terms.map(t => { const i = lower.indexOf(t); return i < 0 ? Infinity : i })) - 80)
    hits.push({ path: rel, score, snippet: text.slice(Number.isFinite(at) ? at : 0, (Number.isFinite(at) ? at : 0) + 240).replace(/\s+/g, ' ').trim() })
  }
  hits.sort((a, b) => b.score - a.score)
  return { results: hits.slice(0, 8) }
}

// ── board ──

function cardUrl(id: number): string {
  return `/o/${id}`
}

function createCard(ctx: ToolContext, title: string, description: string): { id: number; status: string } {
  const db = getDb()
  const agentCtx = defaultAgentForWorkspace(ctx.workspace)
  const body = [
    description.trim(),
    '',
    `— Requested in chat with "${ctx.agent.name}" by ${ctx.username}. They follow this card's status from that chat.`,
  ].join('\n')
  const info = db
    .prepare(
      `INSERT INTO objectives (title, description, agent_context, workspace, category, depth, assigned_user_id, created_by, type, status, origin)
       VALUES (?, ?, ?, ?, 'general', ?, ?, ?, 'task', ?, 'agent_chat')`,
    )
    .run(title.trim().slice(0, 200), body, agentCtx, ctx.workspace, depthForParent(db, null), ctx.userId, ctx.userId, getInitialStatus('task'))
  const id = Number(info.lastInsertRowid)
  db.prepare('INSERT INTO agent_chat_cards (objective_id, user_id, agent_slug) VALUES (?, ?, ?)').run(id, ctx.userId, ctx.agent.slug)
  const row = db.prepare('SELECT * FROM objectives WHERE id = ?').get(id) as Objective
  try {
    broadcast({ type: 'objective_updated', payload: row })
  } catch {
    /* no WS server in tests */
  }
  return { id, status: row.status }
}

export interface ChatCardStatus { id: number; title: string; status: string; summary: string | null; pr_url: string | null; updated_at: string; url: string }

export function chatCards(userId: number, agentSlug: string, ids?: number[]): ChatCardStatus[] {
  const db = getDb()
  const rows = db
    .prepare(
      `SELECT o.id, o.title, o.status, o.last_session_summary AS summary, o.pr_url, o.updated_at
         FROM agent_chat_cards c JOIN objectives o ON o.id = c.objective_id
        WHERE c.user_id = ? AND c.agent_slug = ?
        ORDER BY o.id DESC`,
    )
    .all(userId, agentSlug) as Omit<ChatCardStatus, 'url'>[]
  const wanted = ids ? new Set(ids) : null
  return rows.filter(r => !wanted || wanted.has(r.id)).map(r => ({ ...r, url: cardUrl(r.id) }))
}

// ── dispatch ──

function s(args: Record<string, unknown>, key: string, required = false): string {
  const v = args[key]
  if (typeof v === 'string' && v.trim()) return v
  if (required) throw new ToolUseError(`"${key}" is required.`)
  return ''
}

export function runTool(ctx: ToolContext, fnName: string, args: Record<string, unknown>): ToolOutcome {
  const tool = owningTool(fnName)
  if (!tool || !ctx.agent.tools.includes(tool)) throw new ToolUseError(`Tool "${fnName}" is not allowed for this agent.`)
  const now = ctx.now ?? (() => new Date())

  switch (fnName) {
    case 'search': {
      const q = s(args, 'q', true)
      const r = knowledgeSearch(ctx, q)
      return { result: r, summary: `Searched knowledge for "${q}" (${r.results.length} found)` }
    }
    case 'list_folders': {
      const p = s(args, 'path')
      if (!p) return { result: { folders: ctx.agent.knowledge_folders }, summary: 'Listed knowledge folders' }
      const { abs, rel } = resolveKnowledgePath(ctx, p)
      let entries: fs.Dirent[] = []
      try {
        entries = fs.readdirSync(abs, { withFileTypes: true })
      } catch {
        throw new ToolUseError(`Folder "${rel}" does not exist.`)
      }
      const items = entries.filter(e => !e.name.startsWith('.')).map(e => ({ name: e.name, type: e.isDirectory() ? 'folder' : 'file' }))
      return { result: { path: rel, items }, summary: `Opened folder ${rel}` }
    }
    case 'read_file': {
      const { abs, rel } = resolveKnowledgePath(ctx, s(args, 'path', true))
      if (!TEXT_EXT.has(path.extname(abs).toLowerCase())) throw new ToolUseError('Only text files (.md, .txt, .csv, .json, .yaml) can be read in chat.')
      let text: string
      try {
        text = fs.readFileSync(abs, 'utf8')
      } catch {
        throw new ToolUseError(`File "${rel}" does not exist.`)
      }
      const clipped = text.length > MAX_READ_CHARS
      return { result: { path: rel, content: clipped ? text.slice(0, MAX_READ_CHARS) : text, truncated: clipped }, summary: `Read ${rel}` }
    }
    case 'write_doc': {
      const { abs, rel } = resolveKnowledgePath(ctx, s(args, 'path', true))
      if (!WRITE_EXT.has(path.extname(abs).toLowerCase())) throw new ToolUseError('Only .md, .txt or .csv files can be written.')
      const content = typeof args.content === 'string' ? args.content : ''
      if (Buffer.byteLength(content) > MAX_WRITE_BYTES) throw new ToolUseError('That file is too large to write from chat.')
      fs.mkdirSync(path.dirname(abs), { recursive: true })
      fs.writeFileSync(abs, content)
      return { result: { saved: rel, bytes: Buffer.byteLength(content) }, summary: `Saved ${rel}` }
    }
    case 'file_answer': {
      if (!ingestEnabled()) throw new ToolUseError('The knowledge base is switched off on this install.')
      const sources = Array.isArray(args.sources) ? args.sources.filter((x): x is string => typeof x === 'string') : []
      let saved: { rel: string; title: string }
      try {
        saved = fileAnswer(workspaceKbRoot(ctx.workspace), { question: s(args, 'question', true), answer: s(args, 'answer', true), sources, filedBy: `${ctx.username} (chat: ${ctx.agent.slug})`, now: now() })
      } catch (err) {
        throw new ToolUseError((err as Error).message)
      }
      return { result: { saved: saved.rel, title: saved.title }, summary: `Saved the answer to the wiki as ${saved.rel}` }
    }
    case 'create_objective': {
      const title = s(args, 'title', true)
      const card = createCard(ctx, title, s(args, 'description'))
      return { result: { id: card.id, status: card.status, note: 'Card is on the board. Tell the person its number.' }, summary: `Created card #${card.id}: ${title}`, objective_id: card.id }
    }
    case 'get_objective': {
      const id = Number(args.id)
      const [card] = chatCards(ctx.userId, ctx.agent.slug, [id])
      if (!card) throw new ToolUseError(`Card #${args.id} was not created from this chat.`)
      return { result: card, summary: `Checked card #${id} (${card.status})`, objective_id: id }
    }
    case 'list_objectives': {
      const cards = chatCards(ctx.userId, ctx.agent.slug).slice(0, 20)
      return { result: { cards }, summary: `Listed ${cards.length} card(s) from this chat` }
    }
    case 'email_list_inbox': {
      const mail = ctx.connectors.mail
      if (!mail) throw new ToolUseError('No email account is connected to this install yet.')
      const limit = Math.min(50, Math.max(1, Number(args.limit) || 10))
      const msgs = mail.listInbox(limit, args.unread_only === true)
      return { result: { source: mail.label, messages: msgs }, summary: `Checked inbox (${msgs.length} emails)` }
    }
    case 'email_read': {
      const mail = ctx.connectors.mail
      if (!mail) throw new ToolUseError('No email account is connected to this install yet.')
      const m = mail.read(s(args, 'id', true))
      if (!m) throw new ToolUseError(`No email with id "${args.id}".`)
      return { result: m, summary: `Read email "${m.subject}"` }
    }
    case 'email_create_draft': {
      const mail = ctx.connectors.mail
      if (!mail) throw new ToolUseError('No email account is connected to this install yet.')
      const draft: EmailDraft = { to: s(args, 'to', true), subject: s(args, 'subject', true), body: s(args, 'body', true), in_reply_to: s(args, 'in_reply_to') || null }
      const row = createDraft(ctx.userId, ctx.agent.slug, 'email', mail.id, draft)
      return { result: { draft_id: row.id, status: 'draft', note: 'Saved as a draft. It is NOT sent — the person must press Send.' }, summary: `Drafted email to ${draft.to}`, draft_id: row.id }
    }
    case 'calendar_list_events': {
      const cal = ctx.connectors.calendar
      if (!cal) throw new ToolUseError('No calendar is connected to this install yet.')
      const from = s(args, 'from') || now().toISOString()
      const to = s(args, 'to') || new Date(Date.parse(from) + 7 * 86400_000).toISOString()
      if (Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to))) throw new ToolUseError('from/to must be ISO dates.')
      const events = cal.listEvents(from, to)
      return { result: { source: cal.label, events }, summary: `Checked calendar (${events.length} events)` }
    }
    case 'calendar_draft_event': {
      const cal = ctx.connectors.calendar
      if (!cal) throw new ToolUseError('No calendar is connected to this install yet.')
      const start = s(args, 'start', true)
      const end = s(args, 'end', true)
      if (Number.isNaN(Date.parse(start)) || Number.isNaN(Date.parse(end))) throw new ToolUseError('start/end must be ISO date-times.')
      const withList = Array.isArray(args.with) ? args.with.filter((x): x is string => typeof x === 'string') : []
      const draft: EventDraft = { title: s(args, 'title', true), start, end, with: withList, note: s(args, 'note') || null }
      const row = createDraft(ctx.userId, ctx.agent.slug, 'event', cal.id, draft)
      return { result: { draft_id: row.id, status: 'draft', note: 'Saved as a draft. It is NOT on the calendar until the person presses "Add to calendar".' }, summary: `Drafted event "${draft.title}"`, draft_id: row.id }
    }
  }
  throw new ToolUseError(`Unknown tool "${fnName}".`)
}
