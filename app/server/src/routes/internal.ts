import { Router } from 'express'
import { registerInternalDeployRoutes } from './internal-deploy.js'
import { registerInternalProgressRoutes } from './internal-progress.js'
import { registerInternalHermesRoutes } from './internal-hermes.js'
import { registerInternalCreateRoutes } from './internal-create.js'
import { registerInternalPreviewRoutes } from './internal-preview.js'
import { registerInternalGmailRoutes } from './internal-gmail.js'
import { registerInternalMentorRoutes } from './internal-mentor.js'
import { registerInternalReposRoutes } from './internal-repos.js'
import { requireInternalSecret } from '../middleware/internal-secret.js'
import { runDevFeedbackBridgeOnce } from '../services/dev-feedback-bridge.js'

const router = Router()

registerInternalDeployRoutes(router)
registerInternalCreateRoutes(router)
registerInternalPreviewRoutes(router)
registerInternalProgressRoutes(router)
registerInternalGmailRoutes(router)
registerInternalHermesRoutes(router)
registerInternalMentorRoutes(router)
registerInternalReposRoutes(router)

// Manual trigger for the dev_feedback ↔ CC-objective bridge (obj 711117 W4).
// POST /api/internal/dev-feedback-bridge/run — runs both passes immediately and
// returns the summary log line. Protected by INTERNAL_API_SECRET.
router.post('/dev-feedback-bridge/run', async (req, res) => {
  if (!requireInternalSecret(req, res)) return
  try {
    const summary = await runDevFeedbackBridgeOnce()
    res.json({ ok: true, summary })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[dev-feedback-bridge] manual trigger error:', err)
    res.status(500).json({ ok: false, error: message })
  }
})

export default router
