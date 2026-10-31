/**
 * /api/secrets-broker — secrets usable by bots, never shown (obj 715532).
 *
 *   GET  /list   names, descriptions, scope, allowed hosts. Never values.
 *   POST /http   proxy one HTTPS call with {{secret:NAME}} placeholders injected
 *                server-side; the response comes back redacted.
 *
 * Deliberately NOT under /api/secrets (the admin CRUD store), /api/internal or
 * /api/admin. Same Bearer key / cookie auth as the rest of the Agent API.
 * Workspace keys see and use only secrets tagged for their workspaces; an admin
 * key sees every name. No response, error or log line from this router carries
 * a secret value — see services/secrets-broker.ts.
 */
import { Router, type Response } from 'express'
import { requireAuth, type AuthRequest } from '../middleware/auth.js'
import { getUserWorkspaces, userHasWorkspace } from '../middleware/workspace.js'
import { getDb } from '../db/index.js'
import { isApiKey } from '../lib/api-keys.js'
import { rateLimit } from '../services/file-access.js'
import { executeHttp, listForCaller, type Caller } from '../services/secrets-broker.js'
import { logAccess } from '../services/secrets-store.js'
import {
  SESSION_SECRET_ACCESS_FLAG,
  readSettingFlag,
  sessionTokenFromHeaders,
  verifySessionToken,
} from '../lib/session-trust.js'

const router = Router()

/** obj 718944: set when the caller is a worker using its CC_SESSION_TOKEN. */
interface BrokerRequest extends AuthRequest {
  sessionScope?: { objectiveId: number; workspace: string; actingUserId: number | null }
}

// A worker session has no agent key. With settings.session_secret_access on it
// presents its spawn-minted, objective-scoped CC_SESSION_TOKEN instead, and is
// treated as a NON-admin caller limited to its card's workspace — exactly the
// names the prompt listed for it, never another workspace's.
router.use((req: BrokerRequest, res, next) => {
  const token = sessionTokenFromHeaders(req.headers)
  if (!token) return requireAuth(req, res, next)
  const claims = readSettingFlag(SESSION_SECRET_ACCESS_FLAG) ? verifySessionToken(token) : null
  if (!claims) {
    res.status(401).json({ error: 'Invalid or expired session token' })
    return
  }
  const user = claims.actingUserId != null
    ? (getDb().prepare('SELECT id, username, role, created_at FROM users WHERE id = ?').get(claims.actingUserId) as AuthRequest['user'])
    : undefined
  req.user = user ?? { id: claims.actingUserId ?? 0, username: `session:${claims.objectiveId}`, role: 'member', created_at: '' }
  req.sessionScope = claims
  next()
})

const USE_RATE = () => Number(process.env.CC_SECRETS_BROKER_RATE_PER_MIN) || 30
const LIST_RATE = () => Number(process.env.CC_SECRETS_BROKER_LIST_RATE_PER_MIN) || 60

function limited(req: AuthRequest, res: Response, bucket: string, limit: number): boolean {
  const retry = rateLimit(`${bucket}:${req.user!.id}`, limit)
  if (retry === null) return false
  res.setHeader('Retry-After', String(retry))
  res.status(429).json({ error: 'Rate limit exceeded', retry_after: retry })
  return true
}

function callerOf(req: BrokerRequest): Caller {
  if (req.sessionScope) {
    return { userId: req.user!.id, isAdmin: false, workspaces: [req.sessionScope.workspace] }
  }
  const isAdmin = req.user!.role === 'admin'
  return {
    userId: req.user!.id,
    isAdmin,
    workspaces: isAdmin ? [] : getUserWorkspaces(req.user!.id).map(w => w.workspace),
  }
}

function keyIdentity(req: BrokerRequest): { auth: 'api_key' | 'session'; key_last4: string | null } {
  if (req.sessionScope) return { auth: 'session', key_last4: `obj:${req.sessionScope.objectiveId}` }
  const header = req.headers.authorization
  const bearer = header?.startsWith('Bearer ') ? header.slice(7).trim() : ''
  return isApiKey(bearer) ? { auth: 'api_key', key_last4: bearer.slice(-4) } : { auth: 'session', key_last4: null }
}

// GET /api/secrets-broker/list?workspace=
router.get('/list', (req: BrokerRequest, res) => {
  if (limited(req, res, 'broker-list', LIST_RATE())) return
  const caller = callerOf(req)
  const ws = typeof req.query.workspace === 'string' && req.query.workspace.trim() ? req.query.workspace.trim() : undefined
  if (ws && req.sessionScope && ws !== req.sessionScope.workspace) {
    res.status(403).json({ error: `Session token is scoped to workspace '${req.sessionScope.workspace}'` })
    return
  }
  if (ws && !caller.isAdmin && !req.sessionScope && !userHasWorkspace(caller.userId, ws)) {
    res.status(403).json({ error: `No access to workspace '${ws}'` })
    return
  }
  res.setHeader('Cache-Control', 'private, no-store')
  res.json({ secrets: listForCaller(caller, { workspace: ws }) })
})

// POST /api/secrets-broker/http  { method, url, headers?, body?, workspace? }
router.post('/http', async (req: BrokerRequest, res) => {
  if (limited(req, res, 'broker-use', USE_RATE())) return
  const caller = callerOf(req)
  let outcome
  try {
    outcome = await executeHttp(req.body ?? {}, caller)
  } catch (err) {
    // Never echo err.message: an unexpected throw could carry request material.
    console.error('[secrets-broker] internal error', err instanceof Error ? err.name : 'unknown')
    res.status(500).json({ error: 'broker internal error' })
    return
  }
  const id = keyIdentity(req)
  const meta = {
    secrets: outcome.audit.secrets,
    scopes: outcome.audit.scopes,
    host: outcome.audit.host,
    method: outcome.audit.method,
    status: outcome.audit.status,
    workspace: outcome.audit.workspace,
    user_id: caller.userId,
    username: req.user!.username,
    ...id,
  }
  try {
    getDb().prepare(
      `INSERT INTO activity_log (project, workspace, event_type, title, detail, metadata)
       VALUES ('operationkit', ?, 'milestone', 'secrets_broker_use', ?, ?)`,
    ).run(
      outcome.audit.workspace ?? 'shared',
      `${req.user!.username} used ${outcome.audit.secrets.join(', ') || '(none)'} → ${outcome.audit.method} ${outcome.audit.host ?? '-'} (${outcome.audit.status})`,
      JSON.stringify(meta),
    )
  } catch (err) {
    console.error('[secrets-broker] audit insert failed', err instanceof Error ? err.message : err)
  }
  // Store-level audit too, so the secret's own access history shows each use.
  if (!outcome.audit.status.startsWith('rejected')) {
    for (const s of outcome.audit.scopes) {
      const [name, scope] = s.split('@')
      logAccess(caller.userId, 'use', `broker:${scope}→${outcome.audit.host}`, name)
    }
  }
  console.log(`[secrets-broker] use user=${caller.userId} auth=${id.auth} key=${id.key_last4 ?? '-'} secrets=${outcome.audit.secrets.join(',') || '-'} host=${outcome.audit.host ?? '-'} status=${outcome.audit.status}`)
  res.setHeader('Cache-Control', 'private, no-store')
  res.status(outcome.httpStatus).json(outcome.body)
})

export default router
