/**
 * Control-layer endpoints for an orchestrating agent (obj 714091). Mounted at
 * /api/agent AFTER the unauthenticated discovery router, and auth is per-route
 * so GET /api/agent itself stays public.
 *
 *   GET /api/agent/changes?since=<cursor>&workspace=&limit=  — cursor-paged event feed
 *   GET /api/agent/attention?workspace=&stale_min=&limit=    — compact "needs you" brief
 *   GET /api/agent/seats                                       — seat pool availability + next reset (read-only)
 *
 * Unknown query params are a 400 (same discipline as GET /api/internal/objectives):
 * a typo'd filter must not silently answer with the whole board.
 */
import { Router, type Response } from 'express'
import { getDb } from '../db/index.js'
import { requireAuth, type AuthRequest } from '../middleware/auth.js'
import {
  readChanges,
  parseCursor,
  buildAttention,
  CHANGES_MAX_LIMIT,
  ATTENTION_MAX_LIMIT,
} from '../lib/agent-control.js'
import { listOpenSecretRequests } from '../services/secret-requests.js'
import { getRouterStatus } from '../services/account-router.js'
import { seatPoolView } from '../services/seat-credentials.js'

const router = Router()

function rejectUnknownParams(req: AuthRequest, res: Response, supported: string[]): boolean {
  const unknown = Object.keys(req.query).filter(k => !supported.includes(k))
  if (unknown.length === 0) return false
  res.status(400).json({ error: 'Unsupported query parameter', unknown_params: unknown, supported_params: supported })
  return true
}

function intParam(raw: unknown, min: number, max: number): number | undefined | null {
  if (raw === undefined) return undefined
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) return null
  const n = Number(raw)
  return n < min || n > max ? null : n
}

/** The caller as the read side sees it: an agent key adds its workspace allowlist. */
function controlUser(req: AuthRequest) {
  return { id: req.user!.id, role: req.user!.role, allowWorkspaces: req.agentKey?.workspaces ?? null }
}

function workspaceParam(raw: unknown): string | undefined {
  return typeof raw === 'string' && raw.trim() && raw !== 'all' ? raw.trim() : undefined
}

router.get('/changes', requireAuth, (req: AuthRequest, res) => {
  if (rejectUnknownParams(req, res, ['since', 'workspace', 'limit'])) return
  let since: number | undefined
  if (req.query.since !== undefined) {
    const parsed = parseCursor(req.query.since)
    if (parsed === null) {
      res.status(400).json({ error: 'since must be a cursor returned as next_cursor (a non-negative integer string)' })
      return
    }
    since = parsed
  }
  const limit = intParam(req.query.limit, 1, CHANGES_MAX_LIMIT)
  if (limit === null) {
    res.status(400).json({ error: `limit must be an integer 1-${CHANGES_MAX_LIMIT}` })
    return
  }
  res.json(readChanges(getDb(), controlUser(req), { since, limit, workspace: workspaceParam(req.query.workspace) }))
})

// Seat pool v2: which subscription seats can take work and when the next one
// resets. Read-only; no credential, key name or path is ever in the payload.
router.get('/seats', requireAuth, (req: AuthRequest, res) => {
  if (rejectUnknownParams(req, res, [])) return
  res.json(seatPoolView(getRouterStatus().accounts))
})

router.get('/attention', requireAuth, (req: AuthRequest, res) => {
  if (rejectUnknownParams(req, res, ['workspace', 'stale_min', 'limit'])) return
  const staleMin = intParam(req.query.stale_min, 1, 7 * 24 * 60)
  const limit = intParam(req.query.limit, 1, ATTENTION_MAX_LIMIT)
  if (staleMin === null || limit === null) {
    res.status(400).json({ error: `stale_min must be an integer 1-10080; limit 1-${ATTENTION_MAX_LIMIT}` })
    return
  }
  res.json(buildAttention(getDb(), controlUser(req), { workspace: workspaceParam(req.query.workspace), staleMin, limit }))
})

// obj 719065: every open secret request on cards this caller may read — names,
// reasons and suggested scopes only. A relaying agent pairs this with
// POST /api/objectives/:id/secret-requests/:request_id/upload-token.
router.get('/secret-requests', requireAuth, (req: AuthRequest, res) => {
  if (rejectUnknownParams(req, res, ['workspace'])) return
  const requests = listOpenSecretRequests(getDb(), controlUser(req), { workspace: workspaceParam(req.query.workspace) })
  res.json({ count: requests.length, requests })
})

export default router
