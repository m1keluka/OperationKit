import { Router } from 'express'
import { getDb } from '../db/index.js'
import { requireAuth, requireAdmin, type AuthRequest } from '../middleware/auth.js'
import {
  getIntelForObjective,
  getRecentIntel,
  getActiveBlockers,
  getFileConflicts,
} from '../services/session-intel-pipeline.js'
import { getFalsePassRate } from '../services/false-pass.js'
import { getCanaryCatchRate } from '../services/canary-harness.js'

const router = Router()

// System-wide intel endpoints (blockers, conflicts, recent summaries) span
// every workspace; members would see other teams' file paths + blocker text.
// Gate behind admin until we have per-workspace rollups.
router.use(requireAuth, requireAdmin)

// Get all active blockers across the system
router.get('/blockers', (_req: AuthRequest, res) => {
  res.json(getActiveBlockers())
})

// Get file conflicts (files modified by multiple sessions in last 24h)
router.get('/conflicts', (_req: AuthRequest, res) => {
  res.json(getFileConflicts())
})

// Get recent session summaries
router.get('/recent', (req: AuthRequest, res) => {
  const limit = parseInt(req.query.limit as string) || 20
  res.json(getRecentIntel(Math.min(limit, 100)))
})

// ST2 — rolling AI-review false-pass rate per workspace. A false pass = a
// pass-gated objective that was later reopened. rate = false_passes /
// pass_gated_reviews over the trailing window (default 30d, clamped 1–365).
router.get('/false-pass-rate', (req: AuthRequest, res) => {
  const windowDays = Math.min(Math.max(parseInt(req.query.days as string) || 30, 1), 365)
  res.json({ window_days: windowDays, workspaces: getFalsePassRate(windowDays) })
})

// obj-2376 — proactive canary catch-rate: the anti-signal harness feeds known-bad
// Tier-1 fixtures through the real gate. catch_rate < 1 means a known-bad input
// escaped (a critical alarm). Companion to the reactive /false-pass-rate above.
router.get('/canary-catch-rate', (req: AuthRequest, res) => {
  const windowDays = Math.min(Math.max(parseInt(req.query.days as string) || 30, 1), 365)
  res.json({ window_days: windowDays, ...getCanaryCatchRate(windowDays) })
})

export default router
