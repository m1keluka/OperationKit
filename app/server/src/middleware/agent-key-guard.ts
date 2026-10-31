/**
 * Agent-key guard (obj 714090) — server-side guardrails for named agent keys.
 *
 * Mounted ONCE at the app level, ahead of every /api router, so enforcement
 * lives in one place instead of being sprinkled through ~20 route files. It
 * only acts on requests that authenticate with a key from `agent_api_keys`;
 * browser cookies, JWTs and the legacy users.api_token_hash key pass straight
 * through untouched (requireAuth handles them exactly as before).
 *
 * For an agent key it:
 *   1. Maps (method, path[, body.status]) → the scope the call needs, and
 *      answers 403 { error, missing_scope } when the key lacks it. Anything not
 *      on the agent surface (docs/api/README.md) is DENIED — admin, secrets,
 *      internal, and key minting (/api/auth/*) are unreachable by construction.
 *      A new agent-surface route must be added to `requiredScope` below.
 *   2. Enforces the key's workspace allowlist on objective list / read /
 *      create / edit, plus a response filter on list-shaped GETs. (Vault
 *      access is governed by vault:read / vault:write only.)
 *   3. Records every successful mutation under /api/objectives in
 *      objective_audit with the key label as actor, so the board can tell a
 *      Grok Bot's move from Mike's.
 */
import type { Response, NextFunction } from 'express'
import type { AgentScope } from '@operationkit/shared'
import { getDb } from '../db/index.js'
import { isApiKey, userFromApiKey } from '../lib/api-keys.js'
import { resolveAgentKey, touchAgentKey, type AgentKeyPrincipal } from '../lib/agent-keys.js'
import { logObjectiveAudit, type AuditEventType } from '../services/objective-audit.js'
import { extractToken, type AuthRequest } from './auth.js'

export type ScopeRule =
  | { kind: 'public' }
  | { kind: 'identity' }
  | { kind: 'scope'; scope: AgentScope; also?: AgentScope }
  | { kind: 'off_surface' }

const OBJ_ID = /^\/api\/objectives\/(\d+)(?:\/|$)/

/**
 * The agent surface, as a scope map. Order matters: first match wins.
 * Exported so the tests (and OpenAPI docs) assert the same table.
 */
export function requiredScope(method: string, path: string, body: unknown): ScopeRule {
  const m = method.toUpperCase()
  const p = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path

  if (m === 'GET' && (p === '/api/health' || p === '/api/agent' || p === '/api/openapi.json')) {
    return { kind: 'public' }
  }
  if (m === 'GET' && p === '/api/auth/me') return { kind: 'identity' }
  // Remote MCP (obj 714092): the endpoint itself only needs a valid key. Every
  // tools/call is re-issued over loopback to the REST route it wraps WITH THE
  // SAME KEY, so it passes back through this guard and gets that route's exact
  // scope + workspace checks (obj 714100).
  if (p === '/api/mcp') return { kind: 'identity' }

  // Control-layer feeds (obj 714091). Rows are narrowed to the key's workspace
  // allowlist in SQL (lib/agent-control.ts), not just by the response scrubber.
  if (m === 'GET' && (p === '/api/agent/changes' || p === '/api/agent/attention' || p === '/api/agent/secret-requests')) {
    return { kind: 'scope', scope: 'board:read' }
  }

  if (m === 'GET' && (p === '/api/workspaces' || p === '/api/models' || p === '/api/agents' || p === '/api/briefing/briefing')) {
    return { kind: 'scope', scope: 'board:read' }
  }

  if (p === '/api/objectives' || p.startsWith('/api/objectives/')) {
    if (m === 'GET') return { kind: 'scope', scope: 'board:read' }
    // Read-only search, even though it is a POST.
    if (m === 'POST' && p === '/api/objectives/search/ai') return { kind: 'scope', scope: 'board:read' }
    if (m === 'POST' && p === '/api/objectives') {
      // start:true (obj 714091) creates AND launches a session — it needs the
      // start scope too, or a write-only key could start work through create.
      const start = (body as { start?: unknown } | undefined)?.start === true
      return start ? { kind: 'scope', scope: 'board:write', also: 'board:start' } : { kind: 'scope', scope: 'board:write' }
    }

    const id = OBJ_ID.exec(p)
    if (id) {
      const rest = p.slice(`/api/objectives/${id[1]}`.length)
      if (m === 'DELETE' && rest === '') return { kind: 'scope', scope: 'board:delete' }
      if (m === 'PATCH' && rest === '/status') {
        const status = (body as { status?: unknown } | undefined)?.status
        // done is the human signature. cancelled is its own scope (obj 718417)
        // so a bot can retire a duplicate without holding board:done.
        if (status === 'done') return { kind: 'scope', scope: 'board:done' }
        if (status === 'cancelled') return { kind: 'scope', scope: 'board:cancel' }
        if (status === 'working') return { kind: 'scope', scope: 'board:start' }
        return { kind: 'scope', scope: 'board:write' }
      }
      // obj 719065: relaying a card's secret request mints a write-only upload
      // token — its own scope, never in the default set.
      if (m === 'POST' && /^\/secret-requests\/[^/]+\/upload-token$/.test(rest)) {
        return { kind: 'scope', scope: 'board:secrets_request' }
      }
      // Starting planning / approving a plan launches a session = a start.
      if (m === 'POST' && (rest === '/planning/start' || rest === '/planning/approve')) {
        return { kind: 'scope', scope: 'board:start' }
      }
      // PUT edit, /message, /stop, /interrupt, uploads, decisions, corrections …
      return { kind: 'scope', scope: 'board:write' }
    }
    return { kind: 'off_surface' }
  }

  if (p === '/api/docs/search' || p === '/api/docs/tree' || p === '/api/docs/file') {
    if (m === 'GET') return { kind: 'scope', scope: 'vault:read' }
    if (m === 'PUT' && p === '/api/docs/file') return { kind: 'scope', scope: 'vault:write' }
  }

  // Knowledge-base wiki (obj 720117): an agent may file an answer as a wiki page
  // (MCP file_answer). Imports, cleanup and rebuild stay off-surface.
  if (m === 'POST' && p === '/api/kb-wiki/answers') return { kind: 'scope', scope: 'vault:write' }
  // Link graph (obj 720162): read-only lookups (MCP kb_related / kb_who_knows).
  if (m === 'GET' && (p === '/api/kb-wiki/graph/related' || p === '/api/kb-wiki/graph/who-knows')) return { kind: 'scope', scope: 'vault:read' }

  // Built-in chat agents' definitions (obj 719987) — so Claude / ChatGPT / Grok
  // can load the same agent through MCP. Chat history and drafts stay off-surface.
  if (m === 'GET' && (p === '/api/agent-chat/agents' || /^\/api\/agent-chat\/agents\/[a-z0-9-]+$/.test(p))) {
    return { kind: 'scope', scope: 'vault:read' }
  }

  // Non-markdown file search/stat/download (PR #533) — knowledge, read-only.
  // The secrets broker (/api/secrets-broker/*) stays off the agent surface.
  if (m === 'GET' && (p === '/api/files/search' || p === '/api/files/stat' || p === '/api/files/download')) {
    return { kind: 'scope', scope: 'vault:read' }
  }

  return { kind: 'off_surface' }
}

/** Recursively drop list elements that belong to a workspace outside `allow`. */
export function scrubForWorkspaces(value: unknown, allow: Set<string>, slugIsWorkspace: boolean, depth = 0): unknown {
  if (depth > 6 || value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) {
    return value
      .filter(el => {
        if (!el || typeof el !== 'object' || Array.isArray(el)) return true
        const o = el as Record<string, unknown>
        if (typeof o.workspace === 'string' && !allow.has(o.workspace)) return false
        if (slugIsWorkspace && typeof o.slug === 'string' && !allow.has(o.slug)) return false
        return true
      })
      .map(el => scrubForWorkspaces(el, allow, slugIsWorkspace, depth + 1))
  }
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = scrubForWorkspaces(v, allow, slugIsWorkspace, depth + 1)
  }
  return out
}

function forbidWorkspace(res: Response, key: AgentKeyPrincipal, ws: string): void {
  res.status(403).json({
    error: `Agent key '${key.label}' is not allowed in workspace '${ws}'`,
    workspace: ws,
    allowed_workspaces: key.workspaces,
  })
}

/**
 * Workspace allowlist. Returns false when it already answered the request.
 * `existing` is the objective row for /api/objectives/:id routes (if found).
 */
function enforceWorkspaces(
  req: AuthRequest,
  res: Response,
  key: AgentKeyPrincipal,
  existing: { workspace: string } | undefined,
): boolean {
  const m = req.method.toUpperCase()
  const p = req.path.length > 1 && req.path.endsWith('/') ? req.path.slice(0, -1) : req.path
  const q = req.query as Record<string, unknown>

  // Files API (obj 718417): an agent key reads workspace files only. Without
  // ?workspace= an admin's scope is every root, including the redacted system
  // roots (configs, logs, crontabs) — those stay a human/legacy-key surface.
  if (p.startsWith('/api/files/')) {
    if (q.system !== undefined || q.root !== undefined || q.content !== undefined) {
      res.status(403).json({ error: 'Agent keys cannot read system roots (system / root / content params)', missing_scope: null })
      return false
    }
    if (typeof q.workspace !== 'string' || !q.workspace || q.workspace === 'all') {
      if (key.workspaces?.length === 1) {
        q.workspace = key.workspaces[0]
      } else {
        res.status(400).json({ error: 'workspace is required on the files API for an agent key', allowed_workspaces: key.workspaces })
        return false
      }
    }
  }

  if (!key.workspaces) return true
  const allow = new Set(key.workspaces)

  if (existing && !allow.has(existing.workspace)) {
    forbidWorkspace(res, key, existing.workspace)
    return false
  }

  // Any explicitly requested workspace (query or body) must be allowed.
  const requested: string[] = []
  // ?workspace=a&workspace=b parses to an array, which the string checks below
  // would skip — refuse it outright rather than let it reach a handler.
  if (Array.isArray(q.workspace) || Array.isArray(q.workspaces)) {
    res.status(400).json({ error: 'workspace / workspaces must be given once (comma-separate several)' })
    return false
  }
  if (typeof q.workspace === 'string') requested.push(q.workspace)
  if (typeof q.workspaces === 'string') requested.push(...q.workspaces.split(','))
  const bodyWs = (req.body as { workspace?: unknown } | undefined)?.workspace
  if (m !== 'GET' && typeof bodyWs === 'string' && bodyWs) requested.push(bodyWs)
  const explicit = requested.map(s => s.trim()).filter(s => s && s !== 'all')
  const outside = explicit.find(ws => !allow.has(ws))
  if (outside) {
    forbidWorkspace(res, key, outside)
    return false
  }

  // Single-workspace key + a search with no workspace → search that one
  // (tighter than scrubbing the results afterwards).
  if (m === 'GET' && explicit.length === 0 && key.workspaces.length === 1 &&
      (p === '/api/objectives/search' || p === '/api/docs/search')) {
    q.workspace = key.workspaces[0]
  }

  // Board list with no explicit workspace → narrow it to the allowlist. The
  // list handler already intersects ?workspaces= with the user's memberships.
  if (m === 'GET' && p === '/api/objectives' && explicit.length === 0) {
    delete q.workspace
    q.workspaces = key.workspaces.join(',')
  }

  // Create with no workspace (body or ?workspace=): the handler defaults to
  // 'example'. Pin a single-workspace key to its workspace; otherwise check the
  // default. (A ?workspace= query was already checked as explicit above.)
  if (m === 'POST' && p === '/api/objectives' && !(typeof bodyWs === 'string' && bodyWs) && typeof q.workspace !== 'string') {
    if (key.workspaces.length === 1) {
      ;(req.body as Record<string, unknown>).workspace = key.workspaces[0]
    } else if (!allow.has('example')) {
      res.status(400).json({
        error: 'workspace is required for an agent key restricted to several workspaces',
        allowed_workspaces: key.workspaces,
      })
      return false
    }
  }

  // List-shaped GETs: drop rows from other workspaces on the way out.
  if (m === 'GET' || p === '/api/objectives/search/ai') {
    const slugIsWorkspace = p === '/api/workspaces'
    const json = res.json.bind(res)
    res.json = (body: unknown) => json(scrubForWorkspaces(body, allow, slugIsWorkspace))
  }
  return true
}

function auditEventFor(method: string, rest: string, isCreate: boolean): AuditEventType {
  if (isCreate) return 'create'
  if (method === 'PATCH' && rest === '/status') return 'status_change'
  if (method === 'POST' && rest === '/message') return 'message'
  if (method === 'PUT' && rest === '') return 'edit'
  if (method === 'DELETE' && rest === '') return 'delete_hard'
  return 'agent_action'
}

/** Audit every successful mutation an agent key makes on the board. */
function attachAudit(
  req: AuthRequest,
  res: Response,
  key: AgentKeyPrincipal,
  existing: { id: number; workspace: string; status: string; title: string } | undefined,
): void {
  const m = req.method.toUpperCase()
  if (m === 'GET') return
  const p = req.path.length > 1 && req.path.endsWith('/') ? req.path.slice(0, -1) : req.path
  if (p === '/api/objectives/search/ai') return
  const isCreate = m === 'POST' && p === '/api/objectives'
  if (!isCreate && !existing) return

  let responseBody: unknown
  const json = res.json.bind(res)
  res.json = (body: unknown) => {
    responseBody = body
    return json(body)
  }
  const rest = existing ? p.slice(`/api/objectives/${existing.id}`.length) : ''
  const body = req.body as { status?: unknown } | undefined
  res.on('finish', () => {
    if (res.statusCode >= 400) return
    const created = isCreate ? (responseBody as { id?: number; workspace?: string; title?: string } | undefined) : undefined
    const objectiveId = existing?.id ?? created?.id
    if (!objectiveId) return
    logObjectiveAudit(getDb(), {
      objectiveId,
      eventType: auditEventFor(m, rest, isCreate),
      fromStatus: existing && rest === '/status' ? existing.status : null,
      toStatus: rest === '/status' && typeof body?.status === 'string' ? body.status : null,
      actor: `agent_key:${key.id}:${key.label}`,
      pathway: `agent_api ${m} ${p}`,
      titleSnapshot: existing?.title ?? created?.title ?? null,
      workspace: existing?.workspace ?? created?.workspace ?? null,
    })
  })
}

export function agentKeyGuard(req: AuthRequest, res: Response, next: NextFunction): void {
  // Every path, not just /api/* — /shell (admin terminal) also uses requireAuth,
  // so an admin's agent key must be stopped here too. Requests without a
  // cc_live_ bearer (static assets, browsers) fall straight through below.
  const token = extractToken(req)
  if (!token || !isApiKey(token)) return next()
  // Legacy per-user key: full access, unchanged.
  if (userFromApiKey(token)) return next()

  const resolved = resolveAgentKey(token)
  if (resolved.status === 'unknown') return next() // requireAuth answers 401
  if (resolved.status === 'revoked') {
    res.status(401).json({ error: 'API key revoked' })
    return
  }
  const key = resolved.key
  req.user = resolved.user
  req.agentKey = key
  req.authVia = 'agent_api_key'
  touchAgentKey(key.id)

  const rule = requiredScope(req.method, req.path, req.body)
  if (rule.kind === 'public' || rule.kind === 'identity') return next()
  if (rule.kind === 'off_surface') {
    res.status(403).json({
      error: `Agent key '${key.label}' cannot call ${req.method.toUpperCase()} ${req.path} — not on the agent API surface`,
      missing_scope: null,
    })
    return
  }
  const missing = [rule.scope, rule.also].find(sc => sc && !key.scopes.includes(sc))
  if (missing) {
    res.status(403).json({
      error: `Agent key '${key.label}' is missing scope '${missing}'`,
      missing_scope: missing,
      scopes: key.scopes,
    })
    return
  }

  const id = OBJ_ID.exec(req.path)
  const existing = id
    ? (getDb()
        .prepare('SELECT id, workspace, status, title FROM objectives WHERE id = ?')
        .get(Number(id[1])) as { id: number; workspace: string; status: string; title: string } | undefined)
    : undefined

  if (!enforceWorkspaces(req, res, key, existing)) return
  attachAudit(req, res, key, existing)
  next()
}
