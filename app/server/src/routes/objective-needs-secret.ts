/**
 * Needs-secret: a worker blocked on a missing credential says so on the card,
 * by NAME, instead of burying "paste the token" in prose (obj 718944). obj
 * 719065 turns that into an in-chat secret request with a scope, an owner
 * "+ Add secret", and an agent relay path:
 *
 *   POST   /api/objectives/:id/request-secret        {name, reason, scope?}   (worker: the request_secret event)
 *   POST   /api/objectives/:id/needs-secret          {secrets:[{name, reason, scope?}]}
 *   DELETE /api/objectives/:id/needs-secret/:name
 *   POST   /api/objectives/:id/needs-secret/fill     {name, value, scope?}    (owner popup)
 *   POST   /api/objectives/:id/secrets               {name, value, scope?}    (owner "+ Add secret", no request)
 *   GET    /api/objectives/:id/secret-requests                                 (board:read)
 *   POST   /api/objectives/:id/secret-requests/:request_id/upload-token {scope?} (agent key + board:secrets_request)
 *
 * Raise / clear: the worker's own CC_SESSION_TOKEN (scoped to THIS card) or any
 * caller requireOwnership accepts. Fill / add: ONLY a cookie-authenticated
 * human — an admin, or the card's owner for a scope they may write in Settings
 * — never an agent key, a Bearer JWT, or a session token. Agents relay a value
 * only through a one-time upload token (routes/secret-upload.ts). Every write
 * goes through services/secret-requests.ts → the existing native store. No
 * response, log line or activity row carries the value.
 *
 * Gated by settings.session_secret_access ('1'); off → 404, as if absent.
 */
import { Router, type NextFunction, type Response } from 'express'
import type { NeedsSecretItem, Objective, SecretRequestScope } from '@operationkit/shared'
import { getDb } from '../db/index.js'
import { requireAuth, type AuthRequest } from '../middleware/auth.js'
import { parseNeedsSecret, requireOwnership } from './objectives-helpers.js'
import { logActivity } from './feed.js'
import { canAccessScope } from './secrets.js'
import { authenticatedViaCookie } from '../lib/message-provenance.js'
import {
  SESSION_SECRET_ACCESS_FLAG,
  readSettingFlag,
  sessionTokenFromHeaders,
  verifySessionToken,
} from '../lib/session-trust.js'
import {
  SECRET_NAME_RE,
  fulfilSecret,
  listOpenSecretRequests,
  mintUploadToken,
  parseRequestId,
  parseRequestScope,
  requestIdFor,
  saveNeedsSecret,
  storeScopeFor,
  UPLOAD_TOKEN_TTL_MS,
} from '../services/secret-requests.js'

export { SECRET_NAME_RE }

const router = Router()

const REASON_MAX = 200
const MAX_ITEMS = 10

interface NeedsSecretRequest extends AuthRequest {
  /** Set when the caller is the card's own worker (CC_SESSION_TOKEN). */
  sessionObjectiveId?: number
}

function flagOn(_req: AuthRequest, res: Response, next: NextFunction): void {
  if (!readSettingFlag(SESSION_SECRET_ACCESS_FLAG)) {
    res.status(404).json({ error: 'Not found' })
    return
  }
  next()
}

/** Session token for THIS card, else normal auth + ownership. */
function workerOrOwner(req: NeedsSecretRequest, res: Response, next: NextFunction): void {
  const token = sessionTokenFromHeaders(req.headers)
  if (token) {
    const claims = verifySessionToken(token)
    if (!claims || claims.objectiveId !== Number(req.params.id)) {
      res.status(403).json({ error: 'Session token is not valid for this objective' })
      return
    }
    req.sessionObjectiveId = claims.objectiveId
    next()
    return
  }
  requireAuth(req, res, () => {
    const objective = loadObjective(String(req.params.id))
    if (!objective) {
      res.status(404).json({ error: 'Objective not found' })
      return
    }
    const err = requireOwnership(req, objective)
    if (err) {
      res.status(403).json({ error: err })
      return
    }
    next()
  })
}

function loadObjective(id: string): Objective | undefined {
  return getDb().prepare('SELECT * FROM objectives WHERE id = ?').get(id) as Objective | undefined
}

function pending(objective: Objective): NeedsSecretItem[] {
  return parseNeedsSecret((objective as unknown as { needs_secret?: unknown }).needs_secret)
}

/** Pure merge: validate, dedupe by name (latest reason wins), cap. */
export function mergeNeedsSecret(
  current: NeedsSecretItem[],
  incoming: unknown,
  now = new Date().toISOString(),
): { items: NeedsSecretItem[]; added: string[] } | { error: string } {
  if (!Array.isArray(incoming) || incoming.length === 0) return { error: 'secrets must be a non-empty array of {name, reason}' }
  const byName = new Map(current.map(i => [i.name, i]))
  const added: string[] = []
  for (const raw of incoming) {
    const name = typeof raw?.name === 'string' ? raw.name.trim() : ''
    const reason = typeof raw?.reason === 'string' ? raw.reason.trim().slice(0, REASON_MAX) : ''
    if (!SECRET_NAME_RE.test(name)) return { error: `Invalid secret name '${name.slice(0, 64)}' — use UPPER_SNAKE_CASE (e.g. APIFY_API_TOKEN)` }
    if (!reason) return { error: `reason is required for ${name} (what it is for)` }
    let scope: SecretRequestScope | undefined
    if (raw?.scope !== undefined && raw?.scope !== null) {
      const parsed = parseRequestScope(raw.scope)
      if (!parsed) return { error: `scope for ${name} must be one of: workspace, global, workspace_user` }
      scope = parsed
    }
    byName.set(name, { name, reason, requested_at: now, ...(scope ? { scope } : {}) })
    added.push(name)
  }
  const items = [...byName.values()]
  if (items.length > MAX_ITEMS) return { error: `At most ${MAX_ITEMS} pending secrets per card` }
  return { items, added }
}

function raise(req: NeedsSecretRequest, res: Response, incoming: unknown): void {
  const objective = loadObjective(String(req.params.id))
  if (!objective) {
    res.status(404).json({ error: 'Objective not found' })
    return
  }
  const merged = mergeNeedsSecret(pending(objective), incoming)
  if ('error' in merged) {
    res.status(400).json({ error: merged.error })
    return
  }
  const updated = saveNeedsSecret(objective.id, merged.items)
  logActivity({
    project: objective.project || 'operationkit',
    workspace: objective.workspace,
    objective_id: objective.id,
    event_type: 'blocker',
    title: `Needs secret: ${merged.added.join(', ')}`,
    detail: merged.items.filter(i => merged.added.includes(i.name)).map(i => `${i.name} — ${i.reason}`).join('; '),
    metadata: { needs_secret: merged.added, raised_by: req.sessionObjectiveId ? 'worker' : req.user?.username ?? null },
  })
  res.json({
    needs_secret: updated.needs_secret,
    request_ids: merged.added.map(n => requestIdFor(objective.id, n)),
  })
}

// POST /api/objectives/:id/needs-secret  {secrets:[{name, reason, scope?}]}
router.post('/:id/needs-secret', flagOn, workerOrOwner, (req: NeedsSecretRequest, res) => {
  raise(req, res, req.body?.secrets)
})

// POST /api/objectives/:id/request-secret  {name, reason, scope?} — the worker's
// structured request_secret event (obj 719065): one secret, one call.
router.post('/:id/request-secret', flagOn, workerOrOwner, (req: NeedsSecretRequest, res) => {
  const b = req.body ?? {}
  raise(req, res, [{ name: b.name, reason: b.reason, scope: b.scope }])
})

// DELETE /api/objectives/:id/needs-secret/:name
router.delete('/:id/needs-secret/:name', flagOn, workerOrOwner, (req: NeedsSecretRequest, res) => {
  const objective = loadObjective(String(req.params.id))
  if (!objective) {
    res.status(404).json({ error: 'Objective not found' })
    return
  }
  const next = pending(objective).filter(i => i.name !== req.params.name)
  const updated = saveNeedsSecret(objective.id, next)
  res.json({ needs_secret: updated.needs_secret })
})

/**
 * Who may type a value in: a human signed in to the web UI (httpOnly cookie) —
 * an admin, or the card's owner for a scope Settings → Secrets would already
 * let them write. Agent keys, Bearer JWTs and session tokens never qualify.
 */
export function ownerWriteError(req: AuthRequest, objective: Objective, scope: SecretRequestScope): string | null {
  const denied = 'Only the owner or an admin, signed in to the web UI, can add a secret'
  if (req.agentKey || !authenticatedViaCookie(req) || !req.user) return denied
  if (req.user.role === 'admin') return null
  if (requireOwnership(req, objective)) return denied
  const storeScope = storeScopeFor(scope, objective.workspace || 'example', req.user.id)
  return canAccessScope(req.user, storeScope) ? null : `You cannot write ${scope} secrets`
}

function ownerWrite(req: AuthRequest, res: Response, mode: 'fill' | 'add'): void {
  const objective = loadObjective(String(req.params.id))
  if (!objective) {
    res.status(404).json({ error: 'Objective not found' })
    return
  }
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : ''
  const value = typeof req.body?.value === 'string' ? req.body.value : ''
  const items = pending(objective)
  const requestedScope = items.find(i => i.name === name)?.scope
  const scope = req.body?.scope === undefined ? (requestedScope ?? 'workspace') : parseRequestScope(req.body.scope)
  if (!scope) {
    res.status(400).json({ error: 'scope must be one of: workspace, global, workspace_user' })
    return
  }
  const denied = ownerWriteError(req, objective, scope)
  if (denied) {
    res.status(403).json({ error: denied })
    return
  }
  if (mode === 'fill' && !items.some(i => i.name === name)) {
    res.status(400).json({ error: `${name || 'name'} is not requested on this card` })
    return
  }
  const out = fulfilSecret({
    objective,
    name,
    value,
    scope,
    actorUserId: req.user!.id,
    actorLabel: req.user!.username,
    via: null,
    notifyUnrequested: mode === 'add' && req.body?.notify !== false,
  })
  if (!out.ok) {
    res.status(out.status).json({ error: out.error })
    return
  }
  res.json(out)
}

// POST /api/objectives/:id/needs-secret/fill  { name, value, scope? } — the popup.
router.post('/:id/needs-secret/fill', flagOn, requireAuth, (req: AuthRequest, res) => {
  ownerWrite(req, res, 'fill')
})

// POST /api/objectives/:id/secrets  { name, value, scope?, notify? } — "+ Add secret"
// from any card chat, with or without a pending request.
router.post('/:id/secrets', flagOn, requireAuth, (req: AuthRequest, res) => {
  ownerWrite(req, res, 'add')
})

function controlUser(req: AuthRequest) {
  return { id: req.user!.id, role: req.user!.role, allowWorkspaces: req.agentKey?.workspaces ?? null }
}

// GET /api/objectives/:id/secret-requests — open requests on one card (names only).
router.get('/:id/secret-requests', flagOn, requireAuth, (req: AuthRequest, res) => {
  const id = Number(req.params.id)
  const objective = Number.isInteger(id) ? loadObjective(String(id)) : undefined
  if (!objective) {
    res.status(404).json({ error: 'Objective not found' })
    return
  }
  res.json({ objective_id: id, requests: listOpenSecretRequests(getDb(), controlUser(req), { objectiveId: id }) })
})

// POST /api/objectives/:id/secret-requests/:request_id/upload-token  { scope? }
// An outside managing agent relays ONE request: it gets a one-time, write-only
// upload token for exactly this card + NAME. Only agent keys holding
// board:secrets_request (the guard checks the scope; this re-checks the principal).
router.post('/:id/secret-requests/:requestId/upload-token', flagOn, requireAuth, (req: AuthRequest, res) => {
  const key = req.agentKey
  if (!key || !key.scopes.includes('board:secrets_request')) {
    res.status(403).json({ error: 'Only an agent key with board:secrets_request can relay a secret request', missing_scope: 'board:secrets_request' })
    return
  }
  const parsed = parseRequestId(req.params.requestId)
  if (!parsed || parsed.objectiveId !== Number(req.params.id)) {
    res.status(400).json({ error: 'request_id does not belong to this card' })
    return
  }
  const objective = loadObjective(String(parsed.objectiveId))
  if (!objective) {
    res.status(404).json({ error: 'Objective not found' })
    return
  }
  const visible = listOpenSecretRequests(getDb(), controlUser(req), { objectiveId: objective.id })
  const request = visible.find(r => r.name === parsed.name)
  if (!request) {
    res.status(409).json({ error: `${parsed.name} is not an open secret request on card #${objective.id}` })
    return
  }
  const scope = req.body?.scope === undefined ? request.scope : parseRequestScope(req.body.scope)
  if (!scope) {
    res.status(400).json({ error: 'scope must be one of: workspace, global, workspace_user' })
    return
  }
  const minted = mintUploadToken({
    objective,
    name: parsed.name,
    scope,
    agentKeyId: key.id,
    agentLabel: key.label,
    userId: req.user!.id,
  })
  if ('error' in minted) {
    res.status(minted.status).json({ error: minted.error })
    return
  }
  const base = (process.env.APP_BASE_URL || 'https://cc.example.com').replace(/\/+$/, '')
  const uploadUrl = `${base}/api/secret-upload?name=${encodeURIComponent(parsed.name)}`
  res.json({
    request_id: request.request_id,
    name: parsed.name,
    scope,
    upload_url: uploadUrl,
    upload_token: minted.token,
    expires_at: minted.expires_at,
    ttl_seconds: UPLOAD_TOKEN_TTL_MS / 1000,
    single_use: true,
    // Alternative for a host that cannot run curl: send Mike the card; its popup takes the value.
    owner_link: `${base}/o/${objective.id}`,
    // Read the value from YOUR host's env var so it never enters a model context or a log.
    curl: `printf %s "$${parsed.name}" | curl -sS -X POST '${uploadUrl}' -H 'X-CC-Upload-Token: ${minted.token}' -H 'Content-Type: text/plain' --data-binary @-`,
  })
})

export default router
