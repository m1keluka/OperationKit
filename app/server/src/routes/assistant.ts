import { Router, type Response, type NextFunction } from 'express'
import { requireAuth, type AuthRequest } from '../middleware/auth.js'
import { getUserWorkspaces } from '../middleware/workspace.js'
import {
  resolveAssistantConfig,
  upsertAssistantConfig,
} from '../services/assistant-config.js'
import type { AssistantConfigPatch } from '@operationkit/shared'

/**
 * Personal Assistant config API (obj 701700).
 *   GET  /api/assistant/config  → caller's resolved config (create-on-read)
 *   PUT  /api/assistant/config  → merge a partial patch onto caller's config
 *
 * Gated by requireAuth + requireAssistantAccess (same policy as routes/mentor.ts)
 * and strictly scoped to `req.user` — a caller can only read/write their OWN
 * config. The optional `?workspace=` selects which per-workspace config to act
 * on; it defaults to the caller's primary workspace membership (or 'example').
 */

// Mirrors routes/mentor.ts:15 — admins always pass; members need at least one
// workspace membership with can_use_assistant enabled.
function requireAssistantAccess(req: AuthRequest, res: Response, next: NextFunction): void {
  const user = req.user
  if (!user) {
    res.status(401).json({ error: 'Authentication required' })
    return
  }
  if (user.role === 'admin') {
    next()
    return
  }
  const memberships = getUserWorkspaces(user.id)
  if (memberships.some(m => m.can_use_assistant)) {
    next()
    return
  }
  res.status(403).json({ error: 'Assistant access not enabled for your account' })
}

const router: Router = Router()
router.use(requireAuth, requireAssistantAccess)

/** Resolve which workspace the caller is acting on. */
function targetWorkspace(req: AuthRequest): string {
  const q = typeof req.query.workspace === 'string' ? req.query.workspace.trim() : ''
  if (q) return q
  const memberships = req.user ? getUserWorkspaces(req.user.id) : []
  return memberships[0]?.workspace || 'example'
}

// GET /api/assistant/config — caller's resolved config (create-on-read default).
router.get('/config', (req: AuthRequest, res: Response) => {
  const user = req.user
  if (!user) {
    res.status(401).json({ error: 'Authentication required' })
    return
  }
  const workspace = targetWorkspace(req)
  const cfg = resolveAssistantConfig(user.id, workspace)
  if (!cfg) {
    res.status(500).json({ error: 'Failed to resolve assistant config' })
    return
  }
  res.json(cfg)
})

// PUT /api/assistant/config — merge a partial patch, return the full config.
router.put('/config', (req: AuthRequest, res: Response) => {
  const user = req.user
  if (!user) {
    res.status(401).json({ error: 'Authentication required' })
    return
  }
  const workspace = targetWorkspace(req)
  const body = (req.body ?? {}) as AssistantConfigPatch
  // Never trust userId/workspace/timestamps from the body — scope to req.user.
  const patch: AssistantConfigPatch = {}
  if (body.persona !== undefined) patch.persona = body.persona
  if (body.model !== undefined) patch.model = body.model
  if (body.autonomy !== undefined) patch.autonomy = body.autonomy
  if (body.enabledCapabilities !== undefined) patch.enabledCapabilities = body.enabledCapabilities
  if (body.enabledConnectors !== undefined) patch.enabledConnectors = body.enabledConnectors
  if (body.connectorBindings !== undefined) patch.connectorBindings = body.connectorBindings
  if (body.knowledgeSources !== undefined) patch.knowledgeSources = body.knowledgeSources
  if (body.enabled !== undefined) patch.enabled = body.enabled

  try {
    const updated = upsertAssistantConfig(user.id, workspace, patch)
    res.json(updated)
  } catch (err) {
    console.warn('[assistant] PUT /config failed:', (err as Error).message)
    res.status(500).json({ error: 'Failed to update assistant config' })
  }
})

export default router
