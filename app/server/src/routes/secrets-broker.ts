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
 *
 * Named agent keys (cc_live_, the key an MCP-connected bot holds) reach this
 * router only with the `secrets:use` scope (obj 900749, agent-key-guard), and
 * are never admin callers here — see callerForAgentKey.
 */
import { Router, type Response } from 'express'
import { requireAuth, type AuthRequest } from '../middleware/auth.js'
import { getUserWorkspaces } from '../middleware/workspace.js'
import { getDb } from '../db/index.js'
import { isApiKey } from '../lib/api-keys.js'
import { rateLimit } from '../services/file-access.js'
import { callerForAgentKey, executeHttp, listForCaller, recordBrokerUse, type BrokerUseIdentity, type Caller } from '../services/secrets-broker.js'
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
  if (req.agentKey) {
    return callerForAgentKey(req.user!, req.agentKey.workspaces, getUserWorkspaces(req.user!.id).map(w => w.workspace))
  }
  const isAdmin = req.user!.role === 'admin'
  return {
    userId: req.user!.id,
    isAdmin,
    workspaces: isAdmin ? [] : getUserWorkspaces(req.user!.id).map(w => w.workspace),
  }
}

function keyIdentity(req: BrokerRequest): BrokerUseIdentity {
  const username = req.user!.username
  if (req.sessionScope) return { auth: 'session', key_last4: `obj:${req.sessionScope.objectiveId}`, username }
  const header = req.headers.authorization
  const bearer = header?.startsWith('Bearer ') ? header.slice(7).trim() : ''
  // An MCP tool re-issues here with the bot's own key; the label names the bot.
  if (req.agentKey) return { auth: req.headers['x-cc-client'] === 'mcp' ? 'mcp' : 'agent_key', key_last4: `${req.agentKey.label}…${bearer.slice(-4)}`, username }
  return isApiKey(bearer) ? { auth: 'api_key', key_last4: bearer.slice(-4), username } : { auth: 'session', key_last4: null, username }
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
  // caller.workspaces is the membership list (or, for an agent key, its narrowed allowlist).
  if (ws && !caller.isAdmin && !req.sessionScope && !caller.workspaces.includes(ws)) {
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
  recordBrokerUse(outcome, caller, keyIdentity(req))
  res.setHeader('Cache-Control', 'private, no-store')
  res.status(outcome.httpStatus).json(outcome.body)
})

export default router
