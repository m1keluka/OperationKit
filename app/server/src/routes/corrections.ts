/**
 * Human mistake-labeling surface (ST5).
 *
 * `correctionsRouter` — workspace-scoped auth, mounted under `/api/objectives`.
 *   - POST /api/objectives/:id/corrections  { label }  — submit a correction.
 *   - GET  /api/objectives/:id/corrections             — list this objective's
 *     corrections (newest first) for the SessionViewer affordance.
 *
 * A submitted correction is snapshotted with the objective's workspace/agent/
 * session and becomes a HIGH-PRIORITY gotcha in the next spawn's injected
 * context (see services/context-builder.ts).
 */
import { Router } from 'express'
import { getDb } from '../db/index.js'
import { requireAuth, type AuthRequest } from '../middleware/auth.js'
import { userHasWorkspace } from '../middleware/workspace.js'
import { recordCorrection, listCorrections } from '../services/corrections.js'
import type { CreateCorrectionRequest } from '@operationkit/shared'

export const correctionsRouter = Router()
correctionsRouter.use(requireAuth)

// Resolve the objective + enforce workspace access. Admins always pass.
function authorizeObjective(req: AuthRequest, res: import('express').Response): { id: number } | null {
  const db = getDb()
  const obj = db
    .prepare('SELECT id, workspace FROM objectives WHERE id = ?')
    .get(req.params.id) as { id: number; workspace: string } | undefined
  if (!obj) {
    res.status(404).json({ error: 'Objective not found' })
    return null
  }
  const user = req.user!
  if (user.role !== 'admin' && !userHasWorkspace(user.id, obj.workspace)) {
    res.status(403).json({ error: `No access to workspace '${obj.workspace}'` })
    return null
  }
  return obj
}

// GET /api/objectives/:id/corrections — list corrections for an objective.
correctionsRouter.get('/:id/corrections', (req: AuthRequest, res) => {
  const obj = authorizeObjective(req, res)
  if (!obj) return
  res.json(listCorrections(obj.id))
})

// POST /api/objectives/:id/corrections — submit a human correction.
correctionsRouter.post('/:id/corrections', (req: AuthRequest, res) => {
  const obj = authorizeObjective(req, res)
  if (!obj) return

  const body = req.body as CreateCorrectionRequest
  const label = typeof body?.label === 'string' ? body.label.trim() : ''
  if (!label) {
    res.status(400).json({ error: 'label is required' })
    return
  }
  if (label.length > 2000) {
    res.status(400).json({ error: 'label must be 2000 characters or fewer' })
    return
  }

  const correction = recordCorrection({
    objectiveId: obj.id,
    label,
    createdBy: req.user!.id,
  })
  res.status(201).json(correction)
})
