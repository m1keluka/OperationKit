/**
 * Internal deploy/restart — extracted from internal.ts (behavior frozen).
 * Localhost + INTERNAL_API_SECRET gate unchanged.
 */
import { Router } from 'express'
import { execSync } from 'child_process'
import { getDb } from '../db/index.js'
import { scheduleRestart } from '../services/restart-guard.js'
import { runDriftCheck } from '../services/drift-guard.js'
import { requireInternalSecret } from '../middleware/internal-secret.js'
import { isLocalhost } from '../lib/is-localhost.js'

export function registerInternalDeployRoutes(router: Router): void {
// Internal restart — localhost only, no auth, so sessions can self-deploy
router.post('/restart', (req, res) => {
  if (!isLocalhost(req)) {
    res.status(403).json({ error: 'Internal API: localhost only' })
    return
  }
  if (!requireInternalSecret(req, res)) return
  const force = req.query.force === 'true'

  // Block restart when other sessions are active — prevents sessions from killing each other
  const db = getDb()
  const activeCount = (db.prepare("SELECT COUNT(*) as n FROM objectives WHERE status = 'working' AND session_id IS NOT NULL").get() as { n: number }).n

  if (activeCount > 1 && !force) {
    // Note: a restart does NOT kill tmux Claude sessions (they survive the node
    // process exit) — but it DOES drop every active session's WebSocket and pause
    // the poller for ~5s, so we still block to avoid disrupting concurrent work.
    console.log(`[internal] Restart BLOCKED — ${activeCount} active sessions would be disrupted (WebSocket drop). Use ?force=true to override.`)
    res.status(409).json({ error: `${activeCount} active sessions would be disrupted (WebSocket drop; tmux sessions survive). Use ?force=true to override.`, active_count: activeCount })
    return
  }

  console.log('[internal] Restart requested' + (force ? ' (forced)' : ''))
  // Coalesce restart storms: multiple sessions restarting within seconds of each
  // other only churn WebSockets (2026-06-22 incident). `force` bypasses the cooldown.
  const result = scheduleRestart('restart', { force })
  if (!result.scheduled) {
    res.json({ ok: true, coalesced: true, reason: result.reason, message: 'A restart just happened or is already in progress — skipped to avoid disruption. The latest code is already live.' })
    return
  }
  res.json({ ok: true, message: 'Restarting in 1 second...' })
})

// Internal deploy — localhost only, no auth; sessions and Assistant call this for full deploys.
// Frontend build runs server-side (has correct /app/client cwd + node_modules).
//
// SESSION IMPACT (corrected obj-1150 — the old "kills ALL active Claude sessions"
// warning was FALSE): mode=backend and mode=both call process.exit(0), which
// restarts the Node SERVER PROCESS. tmux Claude sessions on the host SURVIVE the
// restart and keep running — only a container REBUILD (docker compose build) kills
// them. WebSocket clients drop briefly and reconnect; the state-poller is paused for
// the ~5s restart window. mode=frontend builds in place: no restart, zero impact.
//
// DEPLOY-FROM-MAIN DISCIPLINE (obj-1150): the build/runtime serves the live
// bind-mounted checkout, so deploying a DIRTY (served-path) or DIVERGENT
// (HEAD != origin/main) tree would ship uncommitted code that a later reset can
// silently delete (incident obj-1124). A deploy therefore REFUSES (409) on drift
// unless { force: true } is passed.
router.post('/deploy', (req, res) => {
  if (!isLocalhost(req)) {
    res.status(403).json({ error: 'Internal API: localhost only' })
    return
  }
  if (!requireInternalSecret(req, res)) return
  const { mode, force } = (req.body || {}) as { mode?: string; force?: boolean }
  if (!['frontend', 'backend', 'both'].includes(mode || '')) {
    res.status(400).json({ error: 'mode must be frontend, backend, or both' })
    return
  }

  // Deploy-from-main guard: never ship an unbacked/divergent tree by accident.
  const drift = runDriftCheck()
  if (drift.drifted && !force) {
    console.warn(`[internal] Deploy REFUSED (mode=${mode}) — live checkout drift: ${drift.reasons.join(' ')}`)
    res.status(409).json({
      error:
        'Deploy refused: live checkout is dirty in served paths or divergent from origin/main. '
        + 'Commit -> PR -> merge -> deploy from main. Pass {"force":true} to override.',
      drift,
    })
    return
  }
  if (drift.drifted && force) {
    console.warn(`[internal] Deploy FORCED past drift (mode=${mode}): ${drift.reasons.join(' ')}`)
  }

  console.log(`[internal] Deploy requested: mode=${mode}`)

  try {
    let buildOutput = ''
    if (mode === 'frontend' || mode === 'both') {
      console.log('[internal] Building frontend...')
      buildOutput = execSync('npx vite build --outDir dist', {
        cwd: '/app/client',
        timeout: 90_000,
        encoding: 'utf-8',
      })
      console.log('[internal] Frontend build complete')
    }

    if (mode === 'backend' || mode === 'both') {
      // Coalesce restart storms (2026-06-22 incident). A restart that just
      // happened already loaded the latest mounted source, so skipping a
      // back-to-back one is safe — the new code is live either way.
      const result = scheduleRestart(`deploy mode=${mode}`)
      if (!result.scheduled) {
        res.json({ ok: true, mode, build_output: buildOutput, coalesced: true, reason: result.reason, message: 'Backend restart coalesced — a restart just happened, so the latest code is already live.' })
        return
      }
      res.json({ ok: true, mode, build_output: buildOutput, message: 'Backend restarting in 1 second...' })
      return
    }

    res.json({ ok: true, mode, build_output: buildOutput })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Deploy failed'
    console.error('[internal] Deploy failed:', message)
    res.status(500).json({ error: message })
  }
})

}
