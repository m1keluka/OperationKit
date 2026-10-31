/**
 * Starter-pack switch-on routes (obj 719936; shared with packs 719937 and the
 * installer 719935). Logic lives in services/starter-packs.ts.
 *
 *   GET  /api/starter-packs                     admin: every pack + on/off
 *   POST /api/starter-packs/:id/enable|disable  admin  {workspace, with_samples?, dry_run?}
 *
 *   GET  /api/internal/starter-packs            localhost + X-Internal-Secret
 *   POST /api/internal/starter-packs/:id/enable|disable   (scripts/starter-pack.sh)
 */
import { Router, type Request, type Response } from 'express'
import { requireAdmin, requireAuth } from '../middleware/auth.js'
import { isLocalhost } from '../lib/is-localhost.js'
import { requireInternalSecret } from '../middleware/internal-secret.js'
import { disablePack, enablePack, listPacks, packStatus, PackError } from '../services/starter-packs.js'

function mount(router: Router): Router {
  router.get('/', (_req, res) => {
    res.json({ packs: listPacks().map(packStatus) })
  })

  for (const action of ['enable', 'disable'] as const) {
    router.post(`/:id/${action}`, async (req: Request, res: Response) => {
      const body = (req.body ?? {}) as { workspace?: unknown; with_samples?: unknown; dry_run?: unknown }
      const workspace = typeof body.workspace === 'string' ? body.workspace.trim() : ''
      if (!workspace) { res.status(400).json({ error: 'workspace is required' }); return }
      const opts = { workspace, withSamples: body.with_samples !== false, dryRun: body.dry_run === true }
      try {
        const result = action === 'enable' ? await enablePack(String(req.params.id), opts) : await disablePack(String(req.params.id), opts)
        console.log(`[starter-packs] ${action} ${req.params.id} (${workspace})${opts.dryRun ? ' [dry run]' : ''}`)
        res.json(result)
      } catch (err) {
        const status = err instanceof PackError ? err.status : 500
        res.status(status).json({ error: (err as Error).message })
      }
    })
  }
  return router
}

const adminRouter = Router()
adminRouter.use(requireAuth, requireAdmin)
export default mount(adminRouter)

const internalRouter = Router()
internalRouter.use((req, res, next) => {
  if (!isLocalhost(req)) { res.status(403).json({ error: 'Internal API: localhost only' }); return }
  if (!requireInternalSecret(req, res)) return
  next()
})
export const internalStarterPacksRouter = mount(internalRouter)
