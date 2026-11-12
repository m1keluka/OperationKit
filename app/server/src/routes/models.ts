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
import {
  refreshProviderModels,
  getLastRefreshReport,
  autoRefreshIntervalHours,
} from '../services/model-refresh.js'

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

// Provider refresh (obj 900679). GET = the last report (per-provider status,
// what was added, what failed and why) + the automatic-refresh interval. POST
// pulls every connected provider's live model list now and returns the new
// report with the updated registry. A provider that cannot be reached is an
// entry with status 'error' in the report, not an HTTP failure, so one dead
// provider never hides the others' results.
router.get('/refresh', requireAuth, requireAdmin, (_req: AuthRequest, res) => {
  res.json({ report: getLastRefreshReport(), auto_refresh_hours: autoRefreshIntervalHours() })
})

router.post('/refresh', requireAuth, requireAdmin, async (_req: AuthRequest, res) => {
  try {
    const report = await refreshProviderModels('manual')
    res.json({ report, models: listModels(), auto_refresh_hours: autoRefreshIntervalHours() })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Refresh failed' })
  }
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
