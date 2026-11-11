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
import { AccountabilityError, classifyObjective, isStepAdvance, recordMeaningfulProgress, setAccountability } from '../services/accountability.js'
import { latestProgress } from '../services/objective-progress.js'

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
    const db = getDb()

    // obj 900367 §3.2 — the accountability record rides along with the snapshot
    // a worker is already posting. Doing it here rather than on a second
    // endpoint is the point: "what is the next concrete thing that must happen"
    // is answerable precisely when a worker stops to report progress, and a
    // separate call is one a worker would forget. All three fields are OPTIONAL
    // and only the ones present are written, so every existing caller — and
    // scripts/cc-live.mjs as it stands — is byte-for-byte unaffected.
    //
    // These are DECLARED values: the worker is stating them, not the server
    // guessing them from prose. last_meaningful_progress_at is deliberately NOT
    // accepted from the body — only the server writes it (below).
    const prev = latestProgress(db, objective.id)
    const record: Record<string, unknown> = {}
    if ('next_action' in body) record.next_action = body.next_action
    if ('next_check_at' in body) record.next_check_at = body.next_check_at
    if ('waiting_on' in body) record.waiting_on = body.waiting_on
    const declaredAccountability = Object.keys(record).length > 0
    let accountabilityError: string | null = null
    try {
      if (declaredAccountability) setAccountability(db, objective.id, record)
    } catch (err) {
      if (!(err instanceof AccountabilityError)) throw err
      accountabilityError = err.message
    }
    if (accountabilityError) {
      res.status(400).json({ error: accountabilityError })
      return
    }
    // These three are not progress payload fields; strip them before the
    // snapshot validator sees them.
    delete body.next_action
    delete body.next_check_at
    delete body.waiting_on

    // A lead handing a card off has something to DECLARE but no step to report.
    // Requiring it to invent a progress snapshot to record "waiting on
    // human:operator" would put a fake step in the card's history, so an
    // accountability-only post is answered with the record and no progress row.
    //
    // `declaredAccountability` is load-bearing in that condition, not
    // decoration: without it an EMPTY or malformed body took this branch and
    // returned 200, silently turning the endpoint's "invalid body -> 400"
    // contract into a success. A post that declares nothing and reports nothing
    // is still invalid and must fall through to the snapshot validator.
    const hasSnapshot = ['step', 'total_steps', 'label', 'note', 'result', 'artifacts']
      .some((k) => body[k] !== undefined && body[k] !== null)
    if (declaredAccountability && !hasSnapshot) {
      res.status(200).json({ accountability: classifyObjective(db, objective.id) })
      return
    }

    const event = recordProgress(db, objective.id, body, 'worker')

    // Only a snapshot whose STEP ADVANCED counts as meaningful progress (§3.2).
    // A worker re-posting the same step with a new note is narrating, not
    // progressing, and a card that can refresh its own freshness by narrating
    // can never be found stalled.
    if (isStepAdvance(prev?.step ?? null, event.step)) {
      recordMeaningfulProgress(db, objective.id, 'progress_step')
    }

    res.status(201).json(event)
  } catch (err) {
    if (err instanceof ProgressValidationError) {
      res.status(400).json({ error: err.message })
      return
    }
    throw err
  }
})

// The accountability record + the server's classification of it (obj 900367).
// Read-only; the write side is the POST above (worker/lead) and the server's own
// meaningful-progress stamp. Returns 404 for an unknown card, like its siblings.
router.get('/objectives/:id/accountability', (req, res) => {
  if (!localOnly(req, res)) return
  const objective = loadObjective(req, res)
  if (!objective) return
  res.json(classifyObjective(getDb(), objective.id))
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
