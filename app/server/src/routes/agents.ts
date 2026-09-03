import { Router } from 'express'
import { requireAuth, type AuthRequest } from '../middleware/auth.js'
import { listAgents } from '../services/agent-registry.js'

const router = Router()
router.use(requireAuth)

// GET /api/agents — the active agent registry. Drives every agent picker,
// monogram and label in the UI; replaces the old AGENT_CONTEXTS / AGENT_META
// module constants.
router.get('/', (_req: AuthRequest, res) => {
  res.json(listAgents())
})

export default router
