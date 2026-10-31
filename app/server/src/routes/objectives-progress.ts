/**
 * Live card visibility routes (obj 715699) on the authenticated /api/objectives
 * router — the normal bot key (`Authorization: Bearer cc_live_…`) or the browser
 * cookie. Workspace-scoped through canReadObjective, the same gate as GET /:id.
 *
 *   GET  /:id/progress            latest snapshot + paged events + transcript fallback
 *                                 + children roll-up + recent session starts
 *   POST /:id/progress            write a snapshot (owner/admin — a bot driving a card)
 *   GET  /:id/artifacts           list objective-memory files (NOTES.md masked)
 *   GET  /:id/artifacts/file      read one (redacted, byte-capped)
 */
import { Router, type Response } from 'express'
import type { Database } from 'better-sqlite3'
import type { Objective } from '@operationkit/shared'
import { getDb } from '../db/index.js'
import { type AuthRequest } from '../middleware/auth.js'
import { canReadObjective, requireOwnership } from './objectives-helpers.js'
import {
  DEFAULT_EVENT_LIMIT,
  MAX_EVENT_LIMIT,
  ProgressValidationError,
  deriveTranscriptProgress,
  listProgress,
  recordProgress,
  summarizeChildren,
  type ChildrenRollup,
  type DerivedProgress,
  type ProgressEvent,
} from '../services/objective-progress.js'
import { listSessionStarts, type SessionStartRow } from '../services/session-start-reasons.js'
import { getFanoutGroup, type FanoutGroup } from '../services/fanout.js'
import { ArtifactError, listArtifacts, readArtifact } from '../services/live-artifacts.js'
import { getPersistedSpawnStart } from '../services/session-spawn-clock.js'
import { toSecretRequestViews } from '../services/secret-requests.js'

export interface ProgressView {
  objective_id: number
  status: string
  session_id: string | null
  latest: ProgressEvent | null
  events: ProgressEvent[]
  total_events: number
  next_before: number | null
  /** Coarse progress from the live transcript — always present while a transcript exists. */
  transcript: DerivedProgress | null
  /** Which source answers "how's it going": the worker's own snapshot, or the transcript. */
  progress_source: 'worker' | 'transcript' | 'none'
  children: ChildrenRollup | null
  fanout: FanoutGroup | null
  session_starts: SessionStartRow[]
}

const PROGRESS_PARAMS = new Set(['limit', 'before'])

export function parseProgressQuery(query: Record<string, unknown>): { limit: number; before: number | null } | { error: string } {
  const unknown = Object.keys(query).filter(k => !PROGRESS_PARAMS.has(k))
  if (unknown.length) return { error: `unsupported query param(s): ${unknown.join(', ')} (supported: limit, before)` }
  let limit = DEFAULT_EVENT_LIMIT
  if (query.limit !== undefined) {
    limit = Number(query.limit)
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_EVENT_LIMIT) return { error: `limit must be an integer 1..${MAX_EVENT_LIMIT}` }
  }
  let before: number | null = null
  if (query.before !== undefined) {
    before = Number(query.before)
    if (!Number.isInteger(before) || before < 1) return { error: 'before must be a positive event id' }
  }
  return { limit, before }
}

export function buildProgressView(
  db: Database,
  objective: Objective,
  opts: { limit: number; before: number | null; canSeeChild?: (child: Objective) => boolean },
): ProgressView {
  const page = listProgress(db, objective.id, { limit: opts.limit, before: opts.before })
  // The newest event is the latest snapshot regardless of which page was asked for.
  const latest = opts.before ? listProgress(db, objective.id, { limit: 1 }).events[0] ?? null : page.events[0] ?? null

  let sessionId = objective.session_id
  if (!sessionId) {
    const prior = db
      .prepare("SELECT session_id FROM session_intel WHERE objective_id = ? AND session_id LIKE 'cc-%' AND session_id NOT LIKE 'cc-review-%' AND session_id NOT LIKE 'cc-plan-%' ORDER BY started_at DESC LIMIT 1")
      .get(objective.id) as { session_id: string } | undefined
    sessionId = prior?.session_id ?? null
  }
  let startedAtMs: number | null = null
  if (sessionId) {
    try { startedAtMs = getPersistedSpawnStart(db, sessionId) } catch { /* no spawn clock */ }
  }
  const transcript = deriveTranscriptProgress(sessionId, { startedAtMs })

  const children = summarizeChildren(db, objective.id, c => (opts.canSeeChild ? opts.canSeeChild(c as unknown as Objective) : true))
  return {
    objective_id: objective.id,
    status: objective.status,
    session_id: objective.session_id ?? null,
    latest,
    events: page.events,
    total_events: page.total,
    next_before: page.next_before,
    transcript,
    progress_source: latest ? 'worker' : transcript ? 'transcript' : 'none',
    children: children.total > 0 ? children : null,
    fanout: getFanoutGroup(db, objective.id),
    session_starts: listSessionStarts(db, objective.id, 10),
  }
}

function loadReadable(req: AuthRequest, res: Response): Objective | null {
  const objective = getDb().prepare('SELECT * FROM objectives WHERE id = ?').get(req.params.id) as Objective | undefined
  // 404 (not 403) for an unreadable card — never confirm a foreign card exists.
  if (!objective || !canReadObjective(req, objective)) {
    res.status(404).json({ error: 'Objective not found' })
    return null
  }
  return objective
}

export function sendArtifactError(res: Response, err: unknown): void {
  if (err instanceof ArtifactError) {
    res.status(err.status).json({ error: err.message })
    return
  }
  res.status(500).json({ error: 'artifact read failed' })
}

export function parseArtifactReadQuery(query: Record<string, unknown>): { offset?: number; maxBytes?: number; tailBytes?: number } | { error: string } {
  const allowed = new Set(['path', 'offset', 'max_bytes', 'tail_bytes'])
  const unknown = Object.keys(query).filter(k => !allowed.has(k))
  if (unknown.length) return { error: `unsupported query param(s): ${unknown.join(', ')} (supported: path, offset, max_bytes, tail_bytes)` }
  const out: { offset?: number; maxBytes?: number; tailBytes?: number } = {}
  for (const [key, field] of [['offset', 'offset'], ['max_bytes', 'maxBytes'], ['tail_bytes', 'tailBytes']] as const) {
    if (query[key] === undefined) continue
    const n = Number(query[key])
    if (!Number.isInteger(n) || n < 0) return { error: `${key} must be a non-negative integer` }
    out[field] = n
  }
  return out
}

export function registerObjectiveProgressRoutes(router: Router): void {
  router.get('/:id/progress', (req: AuthRequest, res) => {
    const objective = loadReadable(req, res)
    if (!objective) return
    const q = parseProgressQuery(req.query as Record<string, unknown>)
    if ('error' in q) {
      res.status(400).json({ error: q.error, supported_params: [...PROGRESS_PARAMS] })
      return
    }
    res.json({
      ...buildProgressView(getDb(), objective, { ...q, canSeeChild: c => canReadObjective(req, c) }),
      // obj 719065: open secret requests (names only) so a managing agent sees what the card waits on.
      secret_requests: toSecretRequestViews(objective),
    })
  })

  router.post('/:id/progress', (req: AuthRequest, res) => {
    const objective = loadReadable(req, res)
    if (!objective) return
    const ownershipError = requireOwnership(req, objective)
    if (ownershipError) {
      res.status(403).json({ error: ownershipError })
      return
    }
    try {
      res.status(201).json(recordProgress(getDb(), objective.id, req.body ?? {}, 'api'))
    } catch (err) {
      if (err instanceof ProgressValidationError) {
        res.status(400).json({ error: err.message })
        return
      }
      throw err
    }
  })

  router.get('/:id/artifacts', (req: AuthRequest, res) => {
    const objective = loadReadable(req, res)
    if (!objective) return
    const { entries, truncated } = listArtifacts(objective.id)
    res.json({ objective_id: objective.id, status: objective.status, entries, truncated })
  })

  router.get('/:id/artifacts/file', (req: AuthRequest, res) => {
    const objective = loadReadable(req, res)
    if (!objective) return
    const q = parseArtifactReadQuery(req.query as Record<string, unknown>)
    if ('error' in q) {
      res.status(400).json({ error: q.error })
      return
    }
    try {
      const out = readArtifact(objective.id, req.query.path, q)
      res.setHeader('X-Redacted', '1')
      res.setHeader('X-Redaction-Count', String(out.redaction_count))
      res.json(out)
    } catch (err) {
      sendArtifactError(res, err)
    }
  })
}
