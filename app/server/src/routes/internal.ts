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
import { runDevFeedbackBridge, DEV_FEEDBACK_INSTANCES } from '../services/dev-feedback-bridge.js'

const router = Router()

registerInternalDeployRoutes(router)
registerInternalCreateRoutes(router)
registerInternalPreviewRoutes(router)
registerInternalProgressRoutes(router)
registerInternalGmailRoutes(router)
registerInternalHermesRoutes(router)
registerInternalMentorRoutes(router)
registerInternalReposRoutes(router)

// Manual trigger for the dev_feedback ↔ CC-objective bridge (obj 711117 W4;
// multi-workspace obj 712905).
// POST /api/internal/dev-feedback-bridge/run[?workspace=example2|example-project] —
// runs both passes immediately for every instance (or just the named one) and
// returns the summary plus per-instance results (ran | skipped | error).
// 500 if any instance errored, 400 on an unknown workspace. Protected by
// INTERNAL_API_SECRET.
router.post('/dev-feedback-bridge/run', async (req, res) => {
  if (!requireInternalSecret(req, res)) return
  const workspace = typeof req.query.workspace === 'string' && req.query.workspace ? req.query.workspace : undefined
  if (workspace && !DEV_FEEDBACK_INSTANCES.some((i) => i.workspace === workspace)) {
    res.status(400).json({ ok: false, error: `unknown workspace '${workspace}'`, known: DEV_FEEDBACK_INSTANCES.map((i) => i.workspace) })
    return
  }
  try {
    const result = await runDevFeedbackBridge(process.env, { workspace })
    res.status(result.ok ? 200 : 500).json(result)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[dev-feedback-bridge] manual trigger error:', err)
    res.status(500).json({ ok: false, error: message })
  }
})

export default router
