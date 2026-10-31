/**
 * Remote MCP server for Command Center — knowledge + board, one endpoint
 * (obj 716490 knowledge tools, obj 714092/714100 board tools, unified obj 718417).
 *
 * `POST /api/mcp` speaks MCP Streamable HTTP in STATELESS, JSON-response mode:
 * every POST carries one JSON-RPC message (or a batch) and gets one
 * `application/json` reply. No session id, no server→client SSE stream (`GET`
 * is 405, which the spec allows). That is all a remote control layer (a Grok
 * Bot custom MCP connector, the Anthropic MCP connector, Claude Code, Cursor)
 * needs to list and call tools.
 *
 * No new npm dependency: `@modelcontextprotocol/sdk` is not installed in the
 * image, and adding one is a host-side image rebuild (which kills every tmux
 * session). The stateless JSON-RPC surface — initialize / ping / tools/list /
 * tools/call — is small enough to implement here and is covered end to end by
 * `agent-mcp.test.ts`.
 *
 * ── Same business logic, by construction ──────────────────────────────────
 * A tool NEVER touches the DB or a service directly. Each one is a thin adapter
 * over an EXISTING REST route: it re-issues the request over loopback to this
 * same server with the caller's own Bearer token (`restCall`). So the forwarded
 * call passes back through `agentKeyGuard` (per-key scopes + workspace
 * allowlist + audit) and the route's own gates (workspace membership,
 * VALID_TRANSITIONS, session cap, completion gate). update_status(done) without
 * board:done fails exactly like the REST PATCH, carrying the same
 * `missing_scope`. Only public `/api/*` routes are ever targeted — never
 * `/api/internal/*` (whose localhost check a loopback request would satisfy),
 * `/api/admin/*`, `/api/secrets*` or `/shell`; `MCP_TOOLS` below is the
 * complete list, and there is no merge / deploy / spend / delete tool.
 *
 * ── The one MCP-only rule ─────────────────────────────────────────────────
 * Write tools need a NAMED agent key (or a browser-issued JWT). The legacy
 * per-user key is full-access on REST — including `done` — and is the key the
 * knowledge connector was first set up with, so letting it write here would
 * hand every bot on that connector Mike's signature the moment this ships.
 * Over MCP the legacy key stays read-only; minting a named key unlocks writes
 * under that key's scopes (`docs/api/bots/SETUP.md`).
 *
 * Auth is Bearer only (cc_live_ API key or JWT), resolved by the shared
 * `requireAuth`. Cookies are ignored so a browser cannot drive the endpoint
 * cross-site, and the forwarded call carries exactly the token that was
 * validated — never a secret value, only the caller's own key.
 */
import { Router, type NextFunction, type Response } from 'express'
import type { AgentScope } from '@operationkit/shared'
import { requireAuth, type AuthRequest } from '../middleware/auth.js'

export const MCP_PATH = '/api/mcp'
/** Header stamped on forwarded REST calls so attribution can tell MCP traffic apart. */
export const MCP_CLIENT_HEADER = 'X-CC-Client'
// The name is the contract the Grok Bot connector was registered under
// (obj 716490) — keep it even though the server now does more than knowledge.
export const MCP_SERVER_INFO = { name: 'command-center-knowledge', title: 'Command Center', version: '2.0.0' } as const
/** Newest first. An unknown client version is answered with the newest. */
export const MCP_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const

const FORWARD_TIMEOUT_MS = 30_000
/** Inline-content caps so a single tool call stays within a sane token budget. */
const MAX_TEXT_CHARS = 20_000
const MAX_BINARY_INLINE_BYTES = 300_000

const SERVER_INSTRUCTIONS = [
  'Command Center: a kanban board of objectives (cards) — each card runs one coding-agent session — plus the second-brain vault, docs and files. Live data, nothing cached.',
  'Status flow: planning → queue → working → ai_review → review → done (or cancelled). review = Needs You (the human).',
  'READ BEFORE YOU WRITE. Each turn: get_attention (what needs a decision) → get_changes(since=<next_cursor you stored>) (what moved) → act on one card with get_objective / get_progress. Do not re-read the board with list_objectives every turn.',
  'Before creating: search_objectives — never duplicate a card, never create one just to ask for status. Follow-ups on existing work go through send_message.',
  'create_objective: workspace is REQUIRED (slug from list_workspaces / whoami); always pass a fresh idempotency_key and reuse it verbatim on retry. start=true creates and launches in one call.',
  'done is a HUMAN SIGNATURE (Mike\'s). Never set done unless Mike explicitly told you to sign off; bot keys lack board:done and get missing_scope. Cancel duplicates with update_status(cancelled).',
  'An error with missing_scope means this key may not do that — tell Mike what you wanted; do not retry or route around it. An error with workspace means the card belongs to another bot\'s workspace.',
  'Every write returns a one-line confirmation plus id and card url — quote the url back to Mike.',
  'Knowledge: search (vault/docs full-text) → read_file; search_files for pptx/pdf/images; list_folders to browse. Vault entry point: workspaces/<slug>/active.md.',
].join('\n')

// ── helpers ─────────────────────────────────────────────────────────────────

export class ToolError extends Error {
  constructor(public status: number, message: string, public missingScope?: string | null, public body?: any) { super(message) }
}

type Args = Record<string, unknown>
type Method = 'GET' | 'POST' | 'PATCH' | 'PUT'
export type RestCall = (
  method: Method,
  path: string,
  body?: unknown,
  extraHeaders?: Record<string, string>,
  opts?: { raw?: boolean },
) => Promise<any>

function clip(s: unknown, max: number): unknown {
  if (typeof s !== 'string' || s.length <= max) return s
  return `${s.slice(0, max)}… [+${s.length - max} chars]`
}

function pick<T extends Record<string, unknown>>(row: T, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const k of keys) if (row[k] !== undefined) out[k] = row[k]
  return out
}

/** Drop null/empty fields and clip long prose — full card at a token budget. */
function compact(row: Record<string, unknown>, max = 4000): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(row)) {
    if (v === null || v === undefined || v === '') continue
    out[k] = typeof v === 'string' ? clip(v, max) : v
  }
  return out
}

function idArg(args: Args): number {
  const id = Number(args.id)
  if (!Number.isInteger(id) || id <= 0) throw new ToolError(400, 'id must be a positive integer')
  return id
}

function strArg(args: Args, key: string, required = false): string | undefined {
  const v = args[key]
  if (v === undefined || v === null || v === '') {
    if (required) throw new ToolError(400, `${key} is required`)
    return undefined
  }
  if (typeof v !== 'string') throw new ToolError(400, `${key} must be a string`)
  return v
}

function limitArg(args: Args, def: number, max: number, key = 'limit'): number {
  const n = Number(args[key])
  return Number.isInteger(n) && n > 0 ? Math.min(n, max) : def
}

function qs(params: Record<string, string | number | undefined>): string {
  const sp = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== undefined) sp.set(k, String(v))
  const s = sp.toString()
  return s ? `?${s}` : ''
}

/** Public board URL for a card. APP_BASE_URL follows the host if the app moves. */
export function cardUrl(id: number): string {
  const base = (process.env.APP_BASE_URL || 'https://cc.example.com').replace(/\/+$/, '')
  return `${base}/o/${id}`
}

/** The short, quotable receipt every write tool returns. */
function receipt(confirmation: string, card: Record<string, unknown>, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const id = Number(card.id)
  return compact({
    confirmation,
    id,
    url: cardUrl(id),
    ...pick(card, ['title', 'status', 'workspace']),
    ...extra,
  }, 600)
}

const CARD_ROW = ['id', 'title', 'status', 'type', 'workspace', 'project', 'agent_context', 'parent_id', 'has_blockers', 'ai_review_verdict', 'pr_url', 'updated_at'] as const
const slimCard = (r: Record<string, unknown>) => compact(pick(r, CARD_ROW), 300)

const STATUSES = ['planning', 'queue', 'working', 'ai_review', 'review', 'done', 'cancelled'] as const
const ID_SCHEMA = { type: 'integer', description: 'Objective (card) id' }
const WS_FILTER = { type: 'string', description: 'Workspace slug to narrow to (see list_workspaces)' }

function isTextMime(mime: string | undefined): boolean {
  if (!mime) return false
  if (mime.startsWith('text/')) return true
  return ['application/json', 'application/xml', 'application/yaml', 'application/x-yaml'].includes(mime)
}

const getCard = async (a: Args, rest: RestCall) => {
  const row = await rest('GET', `/api/objectives/${idArg(a)}`)
  return { ...compact(row), url: cardUrl(Number(row.id)) }
}

const searchCards = async (a: Args, rest: RestCall) => {
  const r = await rest('GET', `/api/objectives/search${qs({ q: strArg(a, 'q', true), workspace: strArg(a, 'workspace'), limit: limitArg(a, 10, 100) })}`)
  return { results: (r.results ?? []).map((x: Record<string, unknown>) => compact(x, 400)) }
}

const SEARCH_CARDS_SCHEMA = {
  type: 'object',
  required: ['q'],
  properties: {
    q: { type: 'string' },
    workspace: { type: 'string' },
    limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Default 10' },
  },
}

/** PATCH status, with ONE retry on a 5xx (the transient spawn failure bots used to hand-retry). */
export async function patchStatus(rest: RestCall, id: number, status: string): Promise<{ row: Record<string, unknown>; retried: boolean }> {
  try {
    return { row: await rest('PATCH', `/api/objectives/${id}/status`, { status }), retried: false }
  } catch (err) {
    if (!(err instanceof ToolError) || err.status < 500) throw err
    // The first attempt may have landed before it errored — never double-start.
    const now = await rest('GET', `/api/objectives/${id}`)
    if (now?.status === status) return { row: now, retried: false }
    return { row: await rest('PATCH', `/api/objectives/${id}/status`, { status }), retried: true }
  }
}

// ── tools ───────────────────────────────────────────────────────────────────

export interface McpTool {
  name: string
  access: 'read' | 'write'
  /**
   * The scope the tool's PRIMARY route needs. Used only to hide tools a named
   * key could never use from tools/list — the guard on the forwarded REST call
   * stays the authority (update_status → done still needs board:done there).
   * null = identity only (always listed).
   */
  scope: AgentScope | null
  /** Alias of another (canonical) tool, kept so older connectors keep working. */
  aliasOf?: string
  description: string
  inputSchema: Record<string, unknown>
  run: (args: Args, rest: RestCall) => Promise<unknown>
}

export const MCP_TOOLS: McpTool[] = [
  // ── knowledge (obj 716490 — names and behaviour are a stable contract) ──
  {
    name: 'search',
    access: 'read',
    scope: 'vault:read',
    description: 'Full-text search over the second-brain vault / markdown docs (decisions, active.md, architecture notes, PRDs). Returns paths + snippets; open a hit with read_file.',
    inputSchema: {
      type: 'object',
      required: ['q'],
      properties: {
        q: { type: 'string' },
        workspace: { type: 'string', description: 'Restrict to one workspace slug' },
        limit: { type: 'integer', minimum: 1, maximum: 20, description: 'Default 8' },
      },
    },
    run: async (a, rest) => {
      const r = await rest('GET', `/api/docs/search${qs({ q: strArg(a, 'q', true), workspace: strArg(a, 'workspace'), limit: limitArg(a, 8, 20) })}`)
      return { results: (r.results ?? []).map((h: Record<string, unknown>) => compact(h, 500)) }
    },
  },
  {
    name: 'search_files',
    access: 'read',
    scope: 'vault:read',
    description: 'Find a non-markdown VPS file (pptx, pdf, key, images, spreadsheets, archives) by name/glob, extension, type group, folder, or modified date. Returns metadata only (path, size, mime, mtime); open one with read_file. Named agent keys must pass workspace unless pinned to one.',
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string', description: 'Filename substring' },
        glob: { type: 'string' },
        ext: { type: 'string', description: 'Comma list, e.g. "pptx,pdf"' },
        type: { type: 'string', description: 'Comma list of type groups, e.g. "presentation,document,image"' },
        path_prefix: { type: 'string', description: 'Absolute directory to search under' },
        modified_after: { type: 'string', description: 'ISO-8601' },
        modified_before: { type: 'string', description: 'ISO-8601' },
        workspace: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Default 50' },
      },
    },
    run: async (a, rest) => {
      const r = await rest('GET', `/api/files/search${qs({
        q: strArg(a, 'q'),
        glob: strArg(a, 'glob'),
        ext: strArg(a, 'ext'),
        type: strArg(a, 'type'),
        path_prefix: strArg(a, 'path_prefix'),
        modified_after: strArg(a, 'modified_after'),
        modified_before: strArg(a, 'modified_before'),
        workspace: strArg(a, 'workspace'),
        limit: limitArg(a, 50, 200),
      })}`)
      return { results: (r.results ?? []).map((h: Record<string, unknown>) => compact(h, 300)), total: r.total, truncated: r.truncated }
    },
  },
  {
    name: 'list_folders',
    access: 'read',
    scope: 'vault:read',
    description: 'Browse the markdown vault/docs tree (directories + .md files) under a root. Omit root for your default doc root; call again with a child dir\'s path to go deeper.',
    inputSchema: { type: 'object', properties: { root: { type: 'string', description: 'Absolute directory path' } } },
    run: async (a, rest) => {
      const r = await rest('GET', `/api/docs/tree${qs({ root: strArg(a, 'root') })}`)
      return { root: r.root, roots: r.roots, tree: r.tree }
    },
  },
  {
    name: 'read_file',
    access: 'read',
    scope: 'vault:read',
    description: `Read (download) one file by absolute path. Markdown (.md) is read as plain text (clipped at ${MAX_TEXT_CHARS} chars). Anything else goes through the files reader: text-ish content is inlined as UTF-8 (clipped), other content is inlined base64 up to ${MAX_BINARY_INLINE_BYTES} bytes; larger files return metadata only (path/size/mime) with no content.`,
    inputSchema: {
      type: 'object',
      required: ['path'],
      properties: { path: { type: 'string' }, workspace: { type: 'string' } },
    },
    run: async (a, rest) => {
      const filePath = strArg(a, 'path', true)!
      const workspace = strArg(a, 'workspace')
      if (filePath.toLowerCase().endsWith('.md')) {
        const f = await rest('GET', `/api/docs/file${qs({ path: filePath })}`)
        return { path: f.path, mime: 'text/markdown', size: f.size, modifiedAt: f.modifiedAt, encoding: 'utf8', content: clip(f.content, MAX_TEXT_CHARS) }
      }
      const stat = await rest('GET', `/api/files/stat${qs({ path: filePath, workspace })}`)
      const meta = { path: stat.path ?? filePath, name: stat.name, mime: stat.mime, size: stat.size, mtime: stat.mtime, workspace: stat.workspace }
      if (typeof stat.size !== 'number' || (!isTextMime(stat.mime) && stat.size > MAX_BINARY_INLINE_BYTES)) {
        return { ...meta, encoding: null, content: null, truncated: true, note: `${stat.size ?? '?'} bytes; over the ${MAX_BINARY_INLINE_BYTES}-byte inline cap for non-text content. Use search_files for metadata only.` }
      }
      if (isTextMime(stat.mime) && stat.size > MAX_BINARY_INLINE_BYTES * 4) {
        return { ...meta, encoding: null, content: null, truncated: true, note: `${stat.size} bytes of text; too large to inline.` }
      }
      const dl = await rest('GET', `/api/files/download${qs({ path: filePath, workspace })}`, undefined, undefined, { raw: true })
      if (isTextMime(stat.mime)) {
        return { ...meta, encoding: 'utf8', content: clip(dl.buffer.toString('utf8'), MAX_TEXT_CHARS) }
      }
      return { ...meta, encoding: 'base64', content: dl.buffer.toString('base64') }
    },
  },
  {
    name: 'get_card',
    access: 'read',
    scope: 'board:read',
    aliasOf: 'get_objective',
    description: 'Alias of get_objective (kept for connectors set up before the board tools). Fetch one board card by id: description, status, plan, last session summary, AI review findings, PR.',
    inputSchema: { type: 'object', required: ['id'], properties: { id: ID_SCHEMA } },
    run: getCard,
  },
  {
    name: 'search_cards',
    access: 'read',
    scope: 'board:read',
    aliasOf: 'search_objectives',
    description: 'Alias of search_objectives (kept for connectors set up before the board tools). Keyword search over every card, including done/cancelled.',
    inputSchema: SEARCH_CARDS_SCHEMA,
    run: searchCards,
  },

  // ── knowledge additions (obj 718417) ──
  {
    name: 'file_info',
    access: 'read',
    scope: 'vault:read',
    description: 'Details for one non-markdown file without downloading it: size, mime, modified/created time, optional sha256.',
    inputSchema: {
      type: 'object',
      required: ['path'],
      properties: {
        path: { type: 'string', description: 'Absolute path as returned by search_files' },
        workspace: { type: 'string' },
        sha256: { type: 'boolean', description: 'Also compute the SHA-256 of the content' },
      },
    },
    run: async (a, rest) => compact(await rest('GET', `/api/files/stat${qs({ path: strArg(a, 'path', true), workspace: strArg(a, 'workspace'), sha256: a.sha256 === true ? '1' : undefined })}`), 500),
  },
  {
    name: 'write_doc',
    access: 'write',
    scope: 'vault:write',
    description: 'Create or overwrite one markdown file in the vault (e.g. append a decision to workspaces/<slug>/active.md — read it first and send the full new content). Path must be absolute, end in .md and sit under a writable doc root.',
    inputSchema: {
      type: 'object',
      required: ['path', 'content'],
      properties: { path: { type: 'string' }, content: { type: 'string', description: 'Full file content (replaces the file)' } },
    },
    run: async (a, rest) => {
      const r = await rest('PUT', '/api/docs/file', { path: strArg(a, 'path', true), content: typeof a.content === 'string' ? a.content : strArg(a, 'content', true) })
      return { confirmation: `Saved ${r.path} (${r.size} bytes).`, path: r.path, size: r.size, modifiedAt: r.modifiedAt }
    },
  },
  {
    name: 'file_answer',
    access: 'write',
    scope: 'vault:write',
    description: 'Save a good answer into a workspace knowledge base as a wiki page (answers/<date>-<question>.md), linked from the pages it used, so later questions can build on it. sources = knowledge-base-relative page paths the answer used (e.g. "people/dana-ruiz.md").',
    inputSchema: {
      type: 'object',
      required: ['workspace', 'question', 'answer'],
      properties: {
        workspace: { type: 'string' },
        question: { type: 'string' },
        answer: { type: 'string', description: 'The answer in markdown; cite pages as [[folder/page.md]]' },
        sources: { type: 'array', items: { type: 'string' }, description: 'Knowledge-base-relative paths of the pages used' },
      },
    },
    run: async (a, rest) => {
      const sources = Array.isArray(a.sources) ? a.sources.filter((s): s is string => typeof s === 'string') : []
      const r = await rest('POST', '/api/kb-wiki/answers', { workspace: strArg(a, 'workspace', true), question: strArg(a, 'question', true), answer: strArg(a, 'answer', true), sources })
      return { confirmation: `Saved the answer as ${r.rel}.`, path: r.rel, title: r.title }
    },
  },

  // ── knowledge-base link graph (obj 720162) ──
  {
    name: 'kb_related',
    access: 'read',
    scope: 'vault:read',
    description: 'Pages in a workspace knowledge base connected to one page, with how they connect: kind = related (from the page\'s Related list, label like "works for" / "supplier of"), mentions ([[wikilink]]), cited_by (a source that cites the page) or answer_used (a saved answer that used it). depth 2 also returns pages one step further out. page = a knowledge-base-relative path ("people/dana-ruiz.md") or a page name.',
    inputSchema: {
      type: 'object',
      required: ['workspace', 'page'],
      properties: {
        workspace: { type: 'string' },
        page: { type: 'string', description: 'Path like "organizations/acme.md", or a page title / alias' },
        depth: { type: 'integer', minimum: 1, maximum: 2, description: 'Default 1' },
        limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Default 50' },
      },
    },
    run: async (a, rest) => rest('GET', `/api/kb-wiki/graph/related${qs({
      workspace: strArg(a, 'workspace', true), page: strArg(a, 'page', true), depth: limitArg(a, 1, 2, 'depth'), limit: limitArg(a, 50, 200),
    })}`),
  },
  {
    name: 'kb_who_knows',
    access: 'read',
    scope: 'vault:read',
    description: 'Who knows about a topic: person pages in a workspace knowledge base linked to it, ranked by how many sources (documents, chats, calls, saved answers) connect them to it, then by how recent the newest one is. topic = a page name ("Greenway Growers") or words ("supplier"); matched lists the pages it was read as.',
    inputSchema: {
      type: 'object',
      required: ['workspace', 'topic'],
      properties: {
        workspace: { type: 'string' },
        topic: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Default 10' },
      },
    },
    run: async (a, rest) => rest('GET', `/api/kb-wiki/graph/who-knows${qs({ workspace: strArg(a, 'workspace', true), topic: strArg(a, 'topic', true), limit: limitArg(a, 10, 50) })}`),
  },

  // ── board: read ──
  {
    name: 'whoami',
    access: 'read',
    scope: null,
    description: 'Who this connector is: the key label, its scopes, and the workspaces it may touch. Call once per conversation before writing.',
    inputSchema: { type: 'object', properties: {} },
    run: async (_a, rest) => {
      const me = await rest('GET', '/api/auth/me')
      const memberOf = (Array.isArray(me.workspaces) ? me.workspaces : []).map((w: Record<string, unknown>) => w.workspace ?? w.slug).filter(Boolean)
      const key = me.api_key ?? null
      return compact({
        user: me.username,
        role: me.role,
        key_kind: key?.kind ?? 'session',
        key_label: key?.label,
        scopes: key?.scopes,
        workspaces: key?.workspaces ?? memberOf,
        can_write_via_mcp: key?.kind !== 'legacy',
      })
    },
  },
  {
    name: 'get_attention',
    access: 'read',
    scope: 'board:read',
    description: 'START HERE each turn. Compact brief of cards that need a human decision: secrets a worker is blocked on (kind needs_secret, with secret_requests[].request_id — ask Mike in your own masked secret card, then fulfill_secret_request; or he fills it in the card UI), failed AI reviews, blockers, cards awaiting review, workers that look stuck. Each item has id, kind, a one-line why and age_min.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace: WS_FILTER,
        stale_min: { type: 'integer', minimum: 1, maximum: 10080, description: 'Minutes idle before a working card counts as stuck. Default 30' },
        limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Default 15' },
      },
    },
    run: async (a, rest) => rest('GET', `/api/agent/attention${qs({
      workspace: strArg(a, 'workspace'),
      stale_min: Number.isInteger(Number(a.stale_min)) && Number(a.stale_min) > 0 ? Number(a.stale_min) : undefined,
      limit: a.limit === undefined ? undefined : limitArg(a, 15, 50),
    })}`),
  },
  {
    name: 'get_seat_pool',
    access: 'read',
    scope: 'board:read',
    description: 'Subscription seat pool state (read-only, no secrets): per engine (claude, codex, grok) how many seats exist, how many can take work now, how many are cooling down or parked, and next_reset_at — when the earliest cooling seat frees up. Plus each seat\'s label, health and cooldown_until. Use it to explain why a card is queued.',
    inputSchema: { type: 'object', properties: {} },
    run: async (_a, rest) => rest('GET', '/api/agent/seats'),
  },
  {
    name: 'get_changes',
    access: 'read',
    scope: 'board:read',
    description: 'What changed since your last poll: created, status moves, entered_review, AI verdicts, session ends, PR opened/merged/closed, deletes. Pass since = the next_cursor from your previous call (store it); omit it only on the very first poll (last 24h). Loop while has_more is true.',
    inputSchema: {
      type: 'object',
      properties: {
        since: { type: 'string', description: 'next_cursor from the previous get_changes call' },
        workspace: WS_FILTER,
        limit: { type: 'integer', minimum: 1, maximum: 500, description: 'Default 100' },
      },
    },
    run: async (a, rest) => {
      const since = a.since === undefined || a.since === null || a.since === '' ? undefined : String(a.since)
      return rest('GET', `/api/agent/changes${qs({ since, workspace: strArg(a, 'workspace'), limit: a.limit === undefined ? undefined : limitArg(a, 100, 500) })}`)
    },
  },
  {
    name: 'board_briefing',
    access: 'read',
    scope: 'board:read',
    description: 'Wider snapshot of the board you can see (prefer get_attention + get_changes for routine polling): cards working, blocked, and in review (needs the human), plus open vault loops.',
    inputSchema: { type: 'object', properties: {} },
    run: async (_a, rest) => {
      const b = await rest('GET', '/api/briefing/briefing')
      const rows = (xs: Record<string, unknown>[] = []) => xs.map(r => compact(pick(r, ['id', 'title', 'workspace', 'updated_at']), 200))
      return {
        asOf: b.asOf,
        working: rows(b.board?.inProgress),
        blocked: rows(b.board?.blocked),
        needs_review: rows(b.board?.needsReview),
        open_loops: clip(b.openLoops, 3000),
      }
    },
  },
  {
    name: 'list_objectives',
    access: 'read',
    scope: 'board:read',
    description: 'List cards (slim rows, newest first). Default is the live pipeline only (excludes done and cancelled); pass status to read one column. Use get_objective for the full card.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace: WS_FILTER,
        status: { type: 'string', enum: STATUSES },
        limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Default 25' },
        offset: { type: 'integer', minimum: 0 },
      },
    },
    run: async (a, rest) => {
      const offset = Number.isInteger(Number(a.offset)) && Number(a.offset) > 0 ? Number(a.offset) : undefined
      const rows = await rest('GET', `/api/objectives${qs({ workspace: strArg(a, 'workspace'), status: strArg(a, 'status'), limit: limitArg(a, 25, 200), offset })}`)
      const list = Array.isArray(rows) ? rows : []
      return { count: list.length, objectives: list.map(slimCard) }
    },
  },
  {
    name: 'search_objectives',
    access: 'read',
    scope: 'board:read',
    description: 'Keyword search over every card INCLUDING done/cancelled. Use it before create_objective to avoid duplicating existing or finished work.',
    inputSchema: SEARCH_CARDS_SCHEMA,
    run: searchCards,
  },
  {
    name: 'get_objective',
    access: 'read',
    scope: 'board:read',
    description: 'Full card: description, completion goal, plan, last session summary, AI review findings, PR link (pr_url), card url. Long prose is clipped. Read this before update_status or send_message.',
    inputSchema: { type: 'object', required: ['id'], properties: { id: ID_SCHEMA } },
    run: getCard,
  },
  {
    name: 'get_progress',
    access: 'read',
    scope: 'board:read',
    description: '"How is it going?" for a running card, cheaper than get_output: the worker\'s latest step/label/note, a transcript-derived fallback (last tool, last message, elapsed), a children roll-up for fan-outs, and who/what last (re)started it.',
    inputSchema: {
      type: 'object',
      required: ['id'],
      properties: { id: ID_SCHEMA, limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Progress events to include. Default 5' } },
    },
    run: async (a, rest) => {
      const id = idArg(a)
      const p = await rest('GET', `/api/objectives/${id}/progress${qs({ limit: limitArg(a, 5, 100) })}`)
      return compact({
        id,
        url: cardUrl(id),
        status: p.status,
        progress_source: p.progress_source,
        latest: p.latest ? compact(p.latest, 800) : null,
        events: (p.events ?? []).map((e: Record<string, unknown>) => compact(pick(e, ['step', 'total_steps', 'label', 'note', 'created_at']), 300)),
        transcript: p.transcript ? compact(p.transcript, 800) : null,
        children: p.children,
        session_starts: (p.session_starts ?? []).slice(0, 3),
        // obj 719065: what the card is blocked on — relay with fulfill_secret_request.
        secret_requests: p.secret_requests ?? [],
      }, 1500)
    },
  },
  {
    name: 'get_output',
    access: 'read',
    scope: 'board:read',
    description: 'Read a card thread. view=recent (default) returns the last `limit` messages with tool payloads stripped; view=timeline returns the collapsed summary/question/divider segments — the cheapest way to see what a worker concluded.',
    inputSchema: {
      type: 'object',
      required: ['id'],
      properties: {
        id: ID_SCHEMA,
        view: { type: 'string', enum: ['recent', 'timeline'] },
        limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Default 20' },
      },
    },
    run: async (a, rest) => {
      const id = idArg(a)
      const limit = limitArg(a, 20, 100)
      if (a.view === 'timeline') {
        const t = await rest('GET', `/api/objectives/${id}/output?view=timeline`)
        const segs: Record<string, unknown>[] = (t.segments ?? []).filter((s: Record<string, unknown>) => s.type !== 'actions')
        return { status: t.status, total: t.total, segments: segs.slice(-limit).map(s => compact(s, 1500)) }
      }
      const o = await rest('GET', `/api/objectives/${id}/output?limit=${limit}`)
      const messages = (o.messages ?? []).map((m: Record<string, unknown>) =>
        compact({ type: m.type, tool: m.toolName, text: m.text, timestamp: m.timestamp }, 1500))
      return { status: o.status, total: o.total, truncated: !!o.truncated, messages }
    },
  },
  {
    name: 'get_artifacts',
    access: 'read',
    scope: 'board:read',
    description: 'A card\'s deliverables written so far (ARTIFACT.md, live/ partial outputs). Omit path to list them; pass path (relative, from the list) to read one. Text is secret-redacted; tail_bytes reads the end of a growing log.',
    inputSchema: {
      type: 'object',
      required: ['id'],
      properties: {
        id: ID_SCHEMA,
        path: { type: 'string', description: 'Relative path from the listing, e.g. ARTIFACT.md' },
        tail_bytes: { type: 'integer', minimum: 1 },
      },
    },
    run: async (a, rest) => {
      const id = idArg(a)
      const rel = strArg(a, 'path')
      if (!rel) {
        const l = await rest('GET', `/api/objectives/${id}/artifacts`)
        return { id, status: l.status, entries: l.entries, truncated: l.truncated }
      }
      const tail = Number.isInteger(Number(a.tail_bytes)) && Number(a.tail_bytes) > 0 ? Number(a.tail_bytes) : undefined
      const f = await rest('GET', `/api/objectives/${id}/artifacts/file${qs({ path: rel, tail_bytes: tail })}`)
      return { ...compact(f, MAX_TEXT_CHARS) }
    },
  },
  {
    name: 'list_workspaces',
    access: 'read',
    scope: 'board:read',
    description: 'Org workspaces you can see (slug + name). Use the slug for workspace arguments.',
    inputSchema: { type: 'object', properties: {} },
    run: async (_a, rest) => {
      const ws = await rest('GET', '/api/workspaces')
      return { workspaces: (Array.isArray(ws) ? ws : []).map((w: Record<string, unknown>) => pick(w, ['slug', 'name'])) }
    },
  },
  {
    name: 'list_agents',
    access: 'read',
    scope: 'board:read',
    description: 'Agent roster (slug, label, kind, assignable). Use an assignable slug as agent_context in create_objective.',
    inputSchema: { type: 'object', properties: {} },
    run: async (_a, rest) => {
      const ags = await rest('GET', '/api/agents')
      return { agents: (Array.isArray(ags) ? ags : []).map((g: Record<string, unknown>) => pick(g, ['slug', 'label', 'kind', 'assignable'])) }
    },
  },

  // ── built-in chat agents (obj 719987): the same agents the in-app chat uses ──
  {
    name: 'list_chat_agents',
    access: 'read',
    scope: 'vault:read',
    description: 'The chat agents on this install (personal assistant, librarian, …): slug, name, description, knowledge folders and tools. Load one with get_chat_agent to act as it here.',
    inputSchema: { type: 'object', properties: {} },
    run: async (_a, rest) => {
      const r = await rest('GET', '/api/agent-chat/agents')
      return {
        agents: (Array.isArray(r.agents) ? r.agents : []).map((g: Record<string, unknown>) =>
          pick(g, ['slug', 'name', 'description', 'knowledge_folders', 'tools', 'version', 'author'])),
      }
    },
  },
  {
    name: 'get_chat_agent',
    access: 'read',
    scope: 'vault:read',
    description: 'One chat agent\'s full definition, including its instructions. To work as this agent: follow its instructions, keep to its knowledge folders (search / read_file / write_doc under them), and hand bigger jobs to the board with create_objective. Email and calendar stay draft-only.',
    inputSchema: { type: 'object', required: ['slug'], properties: { slug: { type: 'string' } } },
    run: async (a, rest) => {
      const r = await rest('GET', `/api/agent-chat/agents/${encodeURIComponent(strArg(a, 'slug', true)!)}`)
      return r.agent
    },
  },

  // ── board: write ──
  {
    name: 'create_objective',
    access: 'write',
    scope: 'board:write',
    description: 'Create a card in an explicit workspace. type=project lands in planning; bug/task land in queue. start=true also launches the session for a queued task/bug in the same call (needs board:start; the result says started or why not — a session_cap means the card EXISTS in queue: start it later, never re-create). ALWAYS pass idempotency_key (a fresh UUID per intended card, reused verbatim on retry) so a retry returns the original card. Read first: search_objectives so you do not duplicate work.',
    inputSchema: {
      type: 'object',
      required: ['title', 'workspace'],
      properties: {
        title: { type: 'string' },
        workspace: { type: 'string', description: 'REQUIRED workspace slug (see list_workspaces). There is no default.' },
        description: { type: 'string', description: 'The brief the coding agent will work from' },
        project: { type: 'string', description: 'Git repo folder name under /home/operator/projects' },
        type: { type: 'string', enum: ['project', 'bug', 'task'] },
        agent_context: { type: 'string', description: 'Agent slug (see list_agents)' },
        parent_id: { type: 'integer' },
        completion_goal: { type: 'string', description: 'What "done" means, checkable' },
        create_pr: { type: 'boolean' },
        model: { type: 'string' },
        effort: { type: 'string', enum: ['normal', 'high', 'ultracode'] },
        start: { type: 'boolean', description: 'Create AND start the session (queued task/bug only)' },
        idempotency_key: { type: 'string', description: 'Sent as the Idempotency-Key header: same key + same arguments within 24h returns the original card instead of a new one' },
      },
    },
    run: async (a, rest) => {
      strArg(a, 'title', true)
      const workspace = strArg(a, 'workspace', true)!
      // Validate against what this caller can see, so a typo is a clear error
      // instead of a card filed under a workspace nobody watches.
      // A key without board:read cannot list them — then the REST create's own
      // membership + allowlist check is the only gate, which is still correct.
      const visible = await rest('GET', '/api/workspaces').catch(() => null)
      const slugs = (Array.isArray(visible) ? visible : []).map((w: Record<string, unknown>) => String(w.slug))
      if (visible && !slugs.includes(workspace)) {
        throw new ToolError(400, `Unknown or inaccessible workspace '${workspace}'. Use one of: ${slugs.join(', ') || '(none)'}`)
      }
      const idem = strArg(a, 'idempotency_key')
      const body = pick(a, ['title', 'description', 'workspace', 'project', 'type', 'agent_context', 'parent_id', 'completion_goal', 'create_pr', 'model', 'effort', 'start'])
      let row: Record<string, unknown>
      try {
        row = await rest('POST', '/api/objectives', body, idem ? { 'Idempotency-Key': idem } : undefined)
      } catch (err) {
        // 409 on create+start = the card WAS created, the session could not start.
        if (err instanceof ToolError && err.status === 409 && err.body?.objective?.id) {
          const card = err.body.objective
          return receipt(`Created #${card.id} "${card.title}" in ${card.workspace} but did NOT start it (${err.body.start?.reason ?? 'conflict'}): it is waiting in ${card.status}. Start it later with start_objective — do not create it again.`, card, { start: err.body.start })
        }
        throw err
      }
      const start = row.start as { started?: boolean; reason?: string } | undefined
      const how = start ? (start.started ? 'and started it' : `but did not start it (${start.reason})`) : `in ${row.status}`
      return receipt(`Created #${row.id} "${row.title}" in ${row.workspace} ${how}.`, row, {
        ...pick(row, ['type', 'project', 'agent_context', 'parent_id', 'origin', 'agent_key_label']),
        ...(start ? { start } : {}),
      })
    },
  },
  {
    name: 'update_objective',
    access: 'write',
    scope: 'board:write',
    description: 'Edit a card\'s fields (title, description, completion goal, agent, project, model, effort). Only the fields you pass change. Does not start, stop or move it — use update_status / start_objective for that.',
    inputSchema: {
      type: 'object',
      required: ['id'],
      properties: {
        id: ID_SCHEMA,
        title: { type: 'string' },
        description: { type: 'string' },
        completion_goal: { type: 'string' },
        agent_context: { type: 'string' },
        project: { type: 'string' },
        model: { type: 'string' },
        effort: { type: 'string', enum: ['normal', 'high', 'ultracode'] },
      },
    },
    run: async (a, rest) => {
      const id = idArg(a)
      const fields = pick(a, ['title', 'description', 'completion_goal', 'agent_context', 'project', 'model', 'effort'])
      if (Object.keys(fields).length === 0) throw new ToolError(400, 'pass at least one field to change')
      const row = await rest('PUT', `/api/objectives/${id}`, fields)
      return receipt(`Updated #${id} (${Object.keys(fields).join(', ')}).`, row)
    },
  },
  {
    name: 'update_status',
    access: 'write',
    scope: 'board:write',
    description: 'Move a card. queue / planning park it; cancelled retires it (use for duplicates); working starts it (prefer start_objective); a done/cancelled card reopens by moving to queue. done is a HUMAN SIGNATURE (Mike\'s): only set done when Mike explicitly told you to sign off — never because the agent says it finished (a key without board:done gets missing_scope). Illegal transitions return an error; a 409 is the session cap, a branch lease, or the completion gate.',
    inputSchema: {
      type: 'object',
      required: ['id', 'status'],
      properties: { id: ID_SCHEMA, status: { type: 'string', enum: STATUSES } },
    },
    run: async (a, rest) => {
      const id = idArg(a)
      const status = strArg(a, 'status', true)!
      const { row, retried } = await patchStatus(rest, id, status)
      return receipt(`Moved #${id} to ${row.status}.`, row, retried ? { retried: true } : {})
    },
  },
  {
    name: 'start_objective',
    access: 'write',
    scope: 'board:start',
    description: 'Start (or restart) the coding session on a card in queue, planning, ai_review or review — the same as update_status(working), but retried once automatically on a transient server error and never double-started. A done/cancelled card must be reopened first (update_status queue) and only if Mike asked. 409 = session cap full, try later.',
    inputSchema: { type: 'object', required: ['id'], properties: { id: ID_SCHEMA } },
    run: async (a, rest) => {
      const id = idArg(a)
      const { row, retried } = await patchStatus(rest, id, 'working')
      return receipt(`Started #${id}; it is ${row.status}.`, row, retried ? { retried: true } : {})
    },
  },
  {
    name: 'send_message',
    access: 'write',
    scope: 'board:write',
    description: 'Send a follow-up into a card thread; starts or resumes its worker. Use this instead of creating a new card for the same work. Pass idempotency_key so a retry never sends twice. Fails on done/cancelled cards — reopen (update_status queue) only if the human asked.',
    inputSchema: {
      type: 'object',
      required: ['id', 'message'],
      properties: {
        id: ID_SCHEMA,
        message: { type: 'string' },
        idempotency_key: { type: 'string', description: 'Sent as the Idempotency-Key header (24h replay)' },
      },
    },
    run: async (a, rest) => {
      const id = idArg(a)
      const idem = strArg(a, 'idempotency_key')
      const row = await rest('POST', `/api/objectives/${id}/message`, { message: strArg(a, 'message', true) }, idem ? { 'Idempotency-Key': idem } : undefined)
      return receipt(`Sent to #${id}; it is ${row.status ?? 'updated'}.`, row && typeof row === 'object' && row.id ? row : { ...row, id })
    },
  },
  // ── secret requests (obj 719065) — write-only relay; no tool ever returns a value ──
  {
    name: 'list_secret_requests',
    access: 'read',
    scope: 'board:read',
    description: 'Open secret requests on cards you can see: request_id, card id, NAME, reason, suggested scope. A card waiting here is blocked until the secret arrives. Names only — values are never readable through this connector.',
    inputSchema: { type: 'object', properties: { workspace: WS_FILTER } },
    run: async (a, rest) => rest('GET', `/api/agent/secret-requests${qs({ workspace: strArg(a, 'workspace') })}`),
  },
  {
    name: 'fulfill_secret_request',
    access: 'write',
    scope: 'board:secrets_request',
    description: 'Relay one secret request. Returns a ONE-TIME, write-only upload (≈15 min, single use, only for that NAME). Ask Mike for the value in your own masked secret-request card, keep it in a host env var named NAME, then have your HOST run the returned `curl` (it reads $NAME, so the value never enters any model context or log). NEVER put the value in a tool argument or a chat message. The card resumes on its own once it lands. Alternative: send Mike owner_link — the card shows the same popup.',
    inputSchema: {
      type: 'object',
      required: ['request_id'],
      properties: {
        request_id: { type: 'string', description: 'From list_secret_requests / get_attention, e.g. sr-123-APIFY_API_TOKEN' },
        scope: { type: 'string', enum: ['workspace', 'global', 'workspace_user'], description: 'Where to store it. Default: the scope the card suggested. workspace = the card\'s organization; global = all of Command Center; workspace_user = this organization, your key owner only' },
      },
    },
    run: async (a, rest) => {
      const requestId = strArg(a, 'request_id', true)!
      const m = /^sr-(\d+)-[A-Z][A-Z0-9_]{1,63}$/.exec(requestId)
      if (!m) throw new ToolError(400, 'request_id must look like sr-<card id>-<NAME> (see list_secret_requests)')
      const scope = strArg(a, 'scope')
      return rest('POST', `/api/objectives/${m[1]}/secret-requests/${encodeURIComponent(requestId)}/upload-token`, scope ? { scope } : {})
    },
  },
  {
    name: 'stop_objective',
    access: 'write',
    scope: 'board:write',
    description: 'Kill the live session on a card and park it in review. Use only when the human asks or the worker is clearly stuck/looping.',
    inputSchema: { type: 'object', required: ['id'], properties: { id: ID_SCHEMA } },
    run: async (a, rest) => {
      const id = idArg(a)
      await rest('POST', `/api/objectives/${id}/stop`)
      return receipt(`Stopped #${id}; parked in review.`, { id, status: 'review' })
    },
  },
]

const TOOLS_BY_NAME = new Map(MCP_TOOLS.map(t => [t.name, t]))

/**
 * Pre-forward check. Return an error string to refuse the call. Scope and
 * workspace enforcement deliberately do NOT live here — they happen on the
 * forwarded REST call (agentKeyGuard), so the two surfaces cannot drift. The
 * only MCP-specific rule: write tools need a named agent key (see header).
 */
export function authorizeTool(req: AuthRequest, tool: McpTool): string | null {
  if (tool.access === 'write' && req.authVia === 'legacy_api_key') {
    return 'This connector uses the legacy full-access key, which is read-only over MCP. Ask Mike to mint a named agent key (Settings → You → Agent keys) and paste it into this connector to enable writes.'
  }
  return null
}

/** Tools worth showing this caller: a named key never sees a tool whose primary scope it lacks. */
function visibleTools(req: AuthRequest): McpTool[] {
  const scopes = req.agentKey?.scopes
  if (!scopes) return MCP_TOOLS
  return MCP_TOOLS.filter(t => t.scope === null || scopes.includes(t.scope))
}

// ── transport ───────────────────────────────────────────────────────────────

function restCaller(req: AuthRequest, token: string): RestCall {
  const base = process.env.CC_MCP_LOOPBACK_BASE || `http://127.0.0.1:${req.socket.localPort}`
  const fail = (status: number, json: any): never => {
    const missing = json && typeof json === 'object' && 'missing_scope' in json ? json.missing_scope : undefined
    throw new ToolError(status, typeof json?.error === 'string' ? json.error : `HTTP ${status}`, missing, json)
  }
  return async (method, path, body, extraHeaders, opts) => {
    const r = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...extraHeaders,
        Authorization: `Bearer ${token}`,
        [MCP_CLIENT_HEADER]: 'mcp',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(FORWARD_TIMEOUT_MS),
    })
    if (opts?.raw) {
      const buffer = Buffer.from(await r.arrayBuffer())
      if (!r.ok) {
        let json: any
        try { json = JSON.parse(buffer.toString('utf8')) } catch { json = { error: buffer.toString('utf8').slice(0, 300) } }
        fail(r.status, json)
      }
      return { buffer, contentType: r.headers.get('content-type') || 'application/octet-stream' }
    }
    const text = await r.text()
    let json: any
    try { json = text ? JSON.parse(text) : {} } catch { json = { error: text.slice(0, 300) } }
    if (!r.ok) fail(r.status, json)
    return json
  }
}

type JsonRpcId = string | number | null
interface JsonRpcMessage { jsonrpc?: string; id?: JsonRpcId; method?: string; params?: any }

const rpcResult = (id: JsonRpcId, result: unknown) => ({ jsonrpc: '2.0', id, result })
const rpcError = (id: JsonRpcId, code: number, message: string) => ({ jsonrpc: '2.0', id, error: { code, message } })

async function handleMessage(msg: JsonRpcMessage, req: AuthRequest, rest: RestCall): Promise<object | null> {
  if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0') return rpcError(null, -32600, 'Invalid Request')
  // Client responses and notifications (e.g. notifications/initialized) get no reply.
  if (typeof msg.method !== 'string') return null
  if (msg.id === undefined) return null
  const id = msg.id

  switch (msg.method) {
    case 'initialize': {
      const asked = msg.params?.protocolVersion
      const protocolVersion = (MCP_PROTOCOL_VERSIONS as readonly string[]).includes(asked) ? asked : MCP_PROTOCOL_VERSIONS[0]
      const legacy = req.authVia === 'legacy_api_key'
        ? '\nTHIS CONNECTOR USES THE LEGACY KEY: read tools work, write tools are refused. Ask Mike for a named agent key to enable writes.'
        : ''
      return rpcResult(id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: MCP_SERVER_INFO,
        instructions: SERVER_INSTRUCTIONS + legacy,
      })
    }
    case 'ping':
      return rpcResult(id, {})
    case 'tools/list':
      return rpcResult(id, {
        tools: visibleTools(req).map(t => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
          annotations: {
            readOnlyHint: t.access === 'read',
            // stop_objective kills a live session; nothing here deletes data.
            destructiveHint: t.name === 'stop_objective',
            idempotentHint: t.access === 'read',
            openWorldHint: false,
          },
        })),
      })
    case 'tools/call': {
      const name = msg.params?.name
      const tool = typeof name === 'string' ? TOOLS_BY_NAME.get(name) : undefined
      if (!tool) return rpcError(id, -32602, `Unknown tool: ${String(name)}`)
      const args: Args = msg.params?.arguments && typeof msg.params.arguments === 'object' ? msg.params.arguments : {}
      const denied = authorizeTool(req, tool)
      if (denied) {
        return rpcResult(id, {
          content: [{ type: 'text', text: `Error 403: ${denied}` }],
          structuredContent: { error: denied, status: 403, missing_scope: null },
          isError: true,
        })
      }
      try {
        const out = await tool.run(args, rest)
        return rpcResult(id, { content: [{ type: 'text', text: JSON.stringify(out) }] })
      } catch (err) {
        const status = err instanceof ToolError ? err.status : 500
        const message = err instanceof Error ? err.message : String(err)
        const missingScope = err instanceof ToolError ? err.missingScope : undefined
        const workspace = err instanceof ToolError && typeof err.body?.workspace === 'string' ? err.body.workspace : undefined
        // missing_scope rides in the text (every client shows it to the model)
        // and in structuredContent (clients that parse it).
        const text = missingScope !== undefined
          ? `Error ${status}: ${message} (missing_scope: ${missingScope ?? 'null — not on the agent surface'})`
          : `Error ${status}: ${message}`
        const structured = missingScope !== undefined || workspace !== undefined
          ? { structuredContent: { error: message, status, ...(missingScope !== undefined ? { missing_scope: missingScope } : {}), ...(workspace ? { workspace } : {}) } }
          : {}
        return rpcResult(id, { content: [{ type: 'text', text }], ...structured, isError: true })
      }
    }
    default:
      return rpcError(id, -32601, `Method not found: ${msg.method}`)
  }
}

function allowedOrigins(): string[] {
  return process.env.CORS_ORIGINS
    ? process.env.CORS_ORIGINS.split(',')
    : ['https://cc.example.com', 'http://localhost:5173', 'http://localhost:3002']
}

/** Bearer-only auth through the shared requireAuth (cookies deliberately ignored). */
function mcpAuth(req: AuthRequest, res: Response, next: NextFunction): void {
  // DNS-rebinding guard from the MCP transport spec: a browser Origin must be ours.
  const origin = req.headers.origin
  if (origin && !allowedOrigins().includes(origin)) {
    res.status(403).json(rpcError(null, -32000, 'Origin not allowed'))
    return
  }
  const header = req.headers.authorization?.trim()
  // Some clients put the bare token in Authorization; normalise to Bearer.
  if (header && !/^bearer\s/i.test(header) && !header.includes(' ')) req.headers.authorization = `Bearer ${header}`
  else if (header && /^bearer\s/i.test(header)) req.headers.authorization = `Bearer ${header.slice(6).trim()}`
  if (!req.headers.authorization?.startsWith('Bearer ') || req.headers.authorization.length <= 7) {
    res.set('WWW-Authenticate', 'Bearer realm="command-center"')
    res.status(401).json(rpcError(null, -32001, 'Authentication required: Authorization: Bearer cc_live_…'))
    return
  }
  if (req.cookies) delete req.cookies.token
  // Set before requireAuth (which may answer 401 itself); cleared on success.
  res.set('WWW-Authenticate', 'Bearer realm="command-center", error="invalid_token"')
  requireAuth(req, res, () => {
    res.removeHeader('WWW-Authenticate')
    next()
  })
}

const router = Router()

router.all('/mcp', mcpAuth, async (req: AuthRequest, res) => {
  if (req.method !== 'POST') {
    res.set('Allow', 'POST').status(405).json(rpcError(null, -32000, 'Stateless server: use POST (no SSE stream)'))
    return
  }
  const body = req.body
  const batch = Array.isArray(body)
  const messages: JsonRpcMessage[] = batch ? body : [body]
  if (messages.length === 0 || (body === undefined || (typeof body === 'object' && !batch && Object.keys(body).length === 0))) {
    res.status(400).json(rpcError(null, -32700, 'Parse error: expected a JSON-RPC body'))
    return
  }
  const token = req.headers.authorization!.slice(7)
  const rest = restCaller(req, token)
  const replies = (await Promise.all(messages.map(m => handleMessage(m, req, rest)))).filter((r): r is object => r !== null)
  if (replies.length === 0) {
    res.status(202).end()
    return
  }
  res.json(batch ? replies : replies[0])
})

export default router
