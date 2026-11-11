/**
 * Internal mid-session progress reporting — extracted from internal.ts
 * (behavior frozen). Localhost gate unchanged.
 */
import { Router, type Request, type Response } from 'express'
import type { Objective } from '@operationkit/shared'
import { logActivity } from './feed.js'
import { isLocalhost } from '../lib/is-localhost.js'
import { getDb } from '../db/index.js'
import { ProgressValidationError, recordProgress } from '../services/objective-progress.js'
import { listArtifacts, readArtifact } from '../services/live-artifacts.js'
import { FanoutError, registerFanout } from '../services/fanout.js'
import { runFanoutTick } from '../services/fanout-runtime.js'
import { buildProgressView, parseArtifactReadQuery, parseProgressQuery, sendArtifactError } from './objectives-progress.js'

function localOnly(req: Request, res: Response): boolean {
  if (isLocalhost(req)) return true
  res.status(403).json({ error: 'Internal API: localhost only' })
  return false
}

function loadObjective(req: Request, res: Response): Objective | null {
  const objective = getDb().prepare('SELECT * FROM objectives WHERE id = ?').get(req.params.id) as Objective | undefined
  if (!objective) {
    res.status(404).json({ error: 'Objective not found' })
    return null
  }
  return objective
}

export function registerInternalProgressRoutes(router: Router): void {
// Mid-session progress reporting — agents call this to log activity in real-time
router.post('/progress', (req, res) => {
  if (!isLocalhost(req)) {
    res.status(403).json({ error: 'Internal API: localhost only' })
    return
  }

  const { project, objective_id, session_id, event_type, title, detail, metadata, workspace } = req.body as {
    project: string
    objective_id?: number
    session_id?: string
    event_type?: string
    title: string
    detail?: string
    metadata?: Record<string, unknown>
    workspace?: string
  }

  if (!project || !title) {
    res.status(400).json({ error: 'project and title are required' })
    return
  }

  const event = logActivity({
    project,
    workspace: workspace || 'example',
    objective_id: objective_id || null,
    session_id: session_id || null,
    event_type: event_type || 'progress',
    title,
    detail: detail || null,
    metadata: metadata || null,
  })

  res.status(201).json(event)
})


// ── Live card visibility (obj 715699) — worker side ─────────────────────────
// Workers run on-box and reach these over loopback (scripts/cc-live.mjs wraps
// them). Same localhost gate as the rest of /api/internal.

// Structured progress snapshot: step N of M, label, note, partial result, artifact refs.
router.post('/objectives/:id/progress', (req, res) => {
  if (!localOnly(req, res)) return
  const objective = loadObjective(req, res)
  if (!objective) return
  try {
    const body = { ...(req.body ?? {}) }
    if (!body.session_id && objective.session_id) body.session_id = objective.session_id
    res.status(201).json(recordProgress(getDb(), objective.id, body, 'worker'))
  } catch (err) {
    if (err instanceof ProgressValidationError) {
      res.status(400).json({ error: err.message })
      return
    }
    throw err
  }
})

// Same view bots get — lets a parent read its children's progress mid-run.
router.get('/objectives/:id/progress', (req, res) => {
  if (!localOnly(req, res)) return
  const objective = loadObjective(req, res)
  if (!objective) return
  const q = parseProgressQuery(req.query as Record<string, unknown>)
  if ('error' in q) {
    res.status(400).json({ error: q.error })
    return
  }
  res.json(buildProgressView(getDb(), objective, q))
})

router.get('/objectives/:id/artifacts', (req, res) => {
  if (!localOnly(req, res)) return
  const objective = loadObjective(req, res)
  if (!objective) return
  res.json({ objective_id: objective.id, ...listArtifacts(objective.id) })
})

router.get('/objectives/:id/artifacts/file', (req, res) => {
  if (!localOnly(req, res)) return
  const objective = loadObjective(req, res)
  if (!objective) return
  const q = parseArtifactReadQuery(req.query as Record<string, unknown>)
  if ('error' in q) {
    res.status(400).json({ error: q.error })
    return
  }
  try {
    res.json(readArtifact(objective.id, req.query.path, q))
  } catch (err) {
    sendArtifactError(res, err)
  }
})

// Fan out: register already-created children (POST /api/internal/objectives with
// parent_id) as a parallel group with a concurrency ceiling, and start the first
// wave now. Later waves start from the poller as siblings finish.
router.post('/objectives/:id/fanout', async (req, res) => {
  if (!localOnly(req, res)) return
  const objective = loadObjective(req, res)
  if (!objective) return
  const { child_ids, max_concurrency, start } = (req.body ?? {}) as { child_ids?: unknown; max_concurrency?: unknown; start?: boolean }
  try {
    const group = registerFanout(getDb(), objective.id, child_ids, max_concurrency)
    const tick = start === false ? [] : await runFanoutTick(objective.id)
    res.status(201).json({ group, tick: tick[0] ?? null })
  } catch (err) {
    if (err instanceof FanoutError) {
      res.status(err.status).json({ error: err.message })
      return
    }
    throw err
  }
})

}
