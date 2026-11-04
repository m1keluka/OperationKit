import { Router } from 'express'
import type { Request, Response, NextFunction } from 'express'
import { getDb } from '../db/index.js'
import { isLocalhost } from '../lib/is-localhost.js'
import { requireInternalSecret } from '../middleware/internal-secret.js'
import {
  runOnce,
  hotOwnerSyncEnabled,
  setHotOwnerSyncEnabled,
  isWithinSchedule,
} from '../services/posthog-hot-owner-scheduler.js'
import { HOT_OWNER_KEY_ENV_VAR } from '../lib/posthog-hot-owner-sync.js'

// PostHog hot_owner sync: status + manual run + the enabled flag (obj 900091).
// Localhost-only AND shared-secret gated on the mutating routes, same split as
// internal-routines.ts.
const router = Router()

router.use((req: Request, res: Response, next: NextFunction) => {
  if (!isLocalhost(req)) {
    res.status(403).json({ error: 'Internal API: localhost only' })
    return
  }
  next()
})

// GET /api/internal/posthog-hot-owner-sync — status: enabled flag, key configured,
// schedule window, and the last few runs. Read-only, no secret required.
router.get('/', (_req, res) => {
  const recent = getDb()
    .prepare('SELECT * FROM posthog_hot_owner_sync_runs ORDER BY started_at DESC LIMIT 10')
    .all()
  res.json({
    enabled: hotOwnerSyncEnabled(),
    key_configured: !!process.env[HOT_OWNER_KEY_ENV_VAR],
    key_env_var: HOT_OWNER_KEY_ENV_VAR,
    within_schedule_now: isWithinSchedule(),
    schedule: 'Weekdays 08:00-19:30 America/New_York, every 30 min',
    recent_runs: recent,
  })
})

// PATCH /api/internal/posthog-hot-owner-sync/settings — enable/disable this schedule only.
router.patch('/settings', (req, res) => {
  if (!requireInternalSecret(req, res)) return
  const { enabled } = req.body as { enabled?: boolean }
  if (typeof enabled !== 'boolean') {
    res.status(400).json({ error: 'enabled (boolean) required' })
    return
  }
  setHotOwnerSyncEnabled(enabled)
  res.json({ enabled })
})

// POST /api/internal/posthog-hot-owner-sync/run-now — fire immediately, bypassing the
// schedule window (not the enabled flag's secret gate — an explicit operator action).
router.post('/run-now', async (req, res) => {
  if (!requireInternalSecret(req, res)) return
  const dryRun = (req.body as { dry_run?: boolean })?.dry_run === true
  const result = await runOnce('run-now', dryRun)
  res.status(result.ok ? 200 : 500).json(result)
})

export default router
