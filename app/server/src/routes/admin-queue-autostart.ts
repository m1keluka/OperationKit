/**
 * Settings → Platform → Queue auto-start (obj 900625). Mounted under /api/admin,
 * so the admin.ts facade already applies requireAuth + requireAdmin (admin role
 * only; agent keys are rejected). No new scope or permission is introduced.
 *
 *   GET /api/admin/queue-autostart             → per-workspace state + caps
 *   PUT /api/admin/queue-autostart/:workspace  { enabled: boolean }
 *
 * Turning a workspace ON stamps its `enabled_at` to now — only cards that enter
 * the queue after that (or that were explicitly start-requested) are started.
 * A workspace listed in CC_QUEUE_AUTOSTART_WORKSPACES is on regardless of the
 * toggle; the response says so (`source`).
 */
import { Router } from 'express'
import type { AuthRequest } from '../middleware/auth.js'
import { getDb } from '../db/index.js'
import { workspaceExists } from '../services/workspaces.js'
import { resolveAutoStartPolicy, resolveConfiguredCeiling } from '../services/job-accounting.js'
import {
  countAutostartedInFlight,
  queueAutostartGraceMinutes,
  queueAutostartMaxConcurrent,
  resolveEnabledWorkspaces,
  setQueueAutostartWorkspace,
} from '../lib/queue-autostart.js'

const router = Router()

function view() {
  const db = getDb()
  const max = queueAutostartMaxConcurrent(db)
  return {
    workspaces: resolveEnabledWorkspaces(db).map(w => {
      const policy = resolveAutoStartPolicy(db, 'queue_autostart', w.workspace)
      const ceiling = resolveConfiguredCeiling(db, 0, w.workspace)
      return {
        workspace: w.workspace,
        enabled: true,
        source: w.source,
        enabled_at: w.enabledAt,
        ceiling_policy: policy.policy,
        ceiling_policy_source: policy.source,
        // Workspace/global ceiling only (a per-card ceiling can still be set on the card).
        ceiling_configured: ceiling.costUsd !== null || ceiling.wallclockMs !== null,
        ceiling_source: ceiling.source,
      }
    }),
    max_concurrent: max.value,
    max_concurrent_source: max.source,
    in_flight: countAutostartedInFlight(db),
    grace_minutes: queueAutostartGraceMinutes(),
  }
}

router.get('/queue-autostart', (_req: AuthRequest, res) => {
  res.json(view())
})

router.put('/queue-autostart/:workspace', (req: AuthRequest, res) => {
  const workspace = String(req.params.workspace || '')
  const enabled = (req.body as { enabled?: unknown } | undefined)?.enabled
  if (typeof enabled !== 'boolean') {
    res.status(400).json({ error: 'body must be { "enabled": true | false }' })
    return
  }
  if (!workspaceExists(workspace)) {
    res.status(404).json({ error: `Unknown workspace '${workspace}'` })
    return
  }
  const db = getDb()
  setQueueAutostartWorkspace(db, workspace, enabled)
  try {
    db.prepare(
      `INSERT INTO activity_log (project, workspace, event_type, title, detail, metadata)
       VALUES ('command-center', ?, 'decision', 'queue_autostart_toggled', ?, ?)`,
    ).run(
      workspace,
      `Queue auto-start ${enabled ? 'enabled' : 'disabled'} for ${workspace} by ${req.user?.username ?? req.user?.id ?? 'unknown'}`,
      JSON.stringify({ kind: 'queue_autostart_toggled', enabled, actor_user_id: req.user?.id ?? null }),
    )
  } catch { /* the toggle itself already landed */ }
  console.log(`[queue-autostart] ${workspace} ${enabled ? 'ENABLED' : 'disabled'} by user ${req.user?.id ?? '?'}`)
  res.json(view())
})

export default router
