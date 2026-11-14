/**
 * High Agency supervisor — internal routes (obj 900795).
 *
 *   GET  /api/internal/supervisor                 status: on/off, hour, stall window, recent runs, live flag counts
 *   GET  /api/internal/supervisor/flags           live supervisor flags (review_items), filterable:
 *          ?bot=<slug>        flags routed to that bot (routed_to = agent:<slug>) — what a bot reads on its wake
 *          ?routed_to=human   flags routed to a human
 *          ?workspace=<ws>    one workspace
 *   GET  /api/internal/supervisor/preview         what a run WOULD flag right now (reads only, files nothing)
 *   POST /api/internal/supervisor/run             run the review now (operator; localhost + X-Internal-Secret)
 *
 * Reads use the internal board principal (middleware/internal-board-auth.ts): a
 * card session is confined to its own workspace, exactly like the other internal
 * board reads. The one write (run-now) is the same split internal-routines.ts uses:
 * mutating → localhost AND the shared secret. There is deliberately NO route that
 * lets a bot decide, withdraw or edit a supervisor flag: a bot clears a flag by
 * fixing its card, and the next review withdraws it.
 */
import { Router, type Request, type Response } from 'express'
import { getDb } from '../db/index.js'
import { isLocalhost } from '../lib/is-localhost.js'
import { requireInternalSecret } from '../middleware/internal-secret.js'
import { applyPrincipalWorkspaceFilter, requireBoardPrincipal } from '../middleware/internal-board-auth.js'
import { listReviewItems } from '../services/review-items.js'
import { stalledWindowMinutes } from '../services/accountability.js'
import { listSupervisorRuns, reviewHighAgencyWork, SUPERVISOR_DEDUPE_PREFIX } from '../services/high-agency-supervisor.js'
import { installedBots, runSupervisorNow, supervisorEnabled, supervisorHour } from '../services/high-agency-supervisor-scheduler.js'
import { LIVE_REVIEW_ITEM_STATES } from '../db/schema/accountability.js'

const router = Router()
const SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/

function scope(req: Request, res: Response): { workspace?: string } | null {
  const principal = requireBoardPrincipal(req, res, getDb())
  if (!principal) return null
  const forced = applyPrincipalWorkspaceFilter(principal, req.query.workspace)
  if (forced && 'denied' in forced) {
    res.status(forced.denied.status).json({ error: forced.denied.error, code: forced.denied.code })
    return null
  }
  if (forced) return { workspace: forced.workspace }
  const ws = typeof req.query.workspace === 'string' && req.query.workspace.trim() ? req.query.workspace.trim() : undefined
  return { workspace: ws }
}

router.get('/', (req, res) => {
  const s = scope(req, res)
  if (!s) return
  const db = getDb()
  const live = listReviewItems(db, { dedupe_prefix: SUPERVISOR_DEDUPE_PREFIX, states: [...LIVE_REVIEW_ITEM_STATES], workspace: s.workspace, limit: 500 })
  res.json({
    enabled: supervisorEnabled(db),
    run_hour_america_new_york: supervisorHour(db),
    stalled_after_minutes: stalledWindowMinutes(db),
    rights: 'reads the board; files and withdraws routed review_items only — no send, spend, merge, deploy, or card edits',
    live_flags: {
      total: live.length,
      to_bots: live.filter((i) => i.routed_to?.startsWith('agent:')).length,
      to_human: live.filter((i) => !i.routed_to?.startsWith('agent:')).length,
    },
    // Run rows are board-wide counts; a workspace-scoped session gets them too
    // (they hold no card content).
    runs: listSupervisorRuns(db, 14),
  })
})

router.get('/flags', (req, res) => {
  const s = scope(req, res)
  if (!s) return
  let routedTo: string | undefined
  if (typeof req.query.bot === 'string' && req.query.bot) {
    if (!SLUG.test(req.query.bot)) return void res.status(400).json({ error: 'bot must be a bot slug' })
    routedTo = `agent:${req.query.bot}`
  } else if (req.query.routed_to === 'human') {
    routedTo = 'human'
  } else if (req.query.routed_to !== undefined) {
    return void res.status(400).json({ error: 'routed_to supports only "human" (use ?bot=<slug> for a bot)' })
  }
  const items = listReviewItems(getDb(), { dedupe_prefix: SUPERVISOR_DEDUPE_PREFIX, routed_to: routedTo, workspace: s.workspace, limit: 200 })
  res.json({ count: items.length, flags: items })
})

router.get('/preview', (req, res) => {
  const s = scope(req, res)
  if (!s) return
  const review = reviewHighAgencyWork(getDb(), { knownBots: installedBots() })
  const flags = s.workspace ? review.flags.filter((f) => f.workspace === s.workspace) : review.flags
  res.json({ ...review, flags })
})

router.post('/run', (req, res) => {
  if (!isLocalhost(req)) return void res.status(403).json({ error: 'Internal API: localhost only' })
  if (!requireInternalSecret(req, res)) return
  const r = runSupervisorNow('manual')
  if ('error' in r) return void res.status(500).json(r)
  res.json(r)
})

export default router
