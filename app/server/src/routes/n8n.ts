import { Router, type Response } from 'express'
import { requireAuth, requireAdmin, type AuthRequest } from '../middleware/auth.js'
import { getN8nHealth, refreshN8nHealth, manualRestart } from '../services/n8n-watchdog.js'

const router: Router = Router()

// GET /api/n8n/health — latest watchdog snapshot (container + db state, public
// healthz, host disk/load, last auto-restart). Returns 200 with health=null only
// in the brief window before the first poll completes.
router.get('/health', requireAuth, (_req: AuthRequest, res: Response) => {
  res.json({ health: getN8nHealth() })
})

// POST /api/n8n/refresh — force an immediate re-check (admin).
router.post('/refresh', requireAuth, requireAdmin, async (_req: AuthRequest, res: Response) => {
  const health = await refreshN8nHealth()
  res.json({ health })
})

// POST /api/n8n/restart — manual remediation: `docker start n8n-db && n8n`
// (bypasses the watchdog cooldown). Admin-only.
router.post('/restart', requireAuth, requireAdmin, async (_req: AuthRequest, res: Response) => {
  const result = manualRestart()
  const health = await refreshN8nHealth()
  res.json({ ...result, health })
})

export default router
