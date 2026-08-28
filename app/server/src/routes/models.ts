import { Router } from 'express'
import { requireAuth, requireAdmin, type AuthRequest } from '../middleware/auth.js'
import {
  listModels,
  listEnabledModels,
  getDefaultModelId,
  setModelEnabled,
  setDefaultModel,
  setPlannerModel,
} from '../services/model-registry.js'

const router = Router()

// Enabled models + the configured default — drives the objective create/edit
// dropdown. Any authenticated user can read it (members create objectives too).
router.get('/', requireAuth, (_req: AuthRequest, res) => {
  res.json({ models: listEnabledModels(), default: getDefaultModelId() })
})

// Full registry incl. disabled rows — backs the admin Models settings page.
router.get('/all', requireAuth, requireAdmin, (_req: AuthRequest, res) => {
  res.json({ models: listModels() })
})

// Toggle enabled / set default / set planner. Admin only. One field per call in
// practice; processed enabled → default → planner. Service throws (→ 400) on
// invalid transitions (e.g. disabling the active default, unknown id).
router.patch('/:id', requireAuth, requireAdmin, (req: AuthRequest, res) => {
  const id = String(req.params.id)
  const body = req.body as { enabled?: boolean; is_default?: boolean; is_planner?: boolean }
  try {
    if (typeof body.enabled === 'boolean') setModelEnabled(id, body.enabled)
    if (body.is_default === true) setDefaultModel(id)
    if (body.is_planner === true) setPlannerModel(id)
    res.json({ models: listModels() })
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Update failed' })
  }
})

export default router
