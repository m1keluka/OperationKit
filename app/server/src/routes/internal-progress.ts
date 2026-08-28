/**
 * Internal mid-session progress reporting — extracted from internal.ts
 * (behavior frozen). Localhost gate unchanged.
 */
import { Router } from 'express'
import { logActivity } from './feed.js'
import { isLocalhost } from '../lib/is-localhost.js'

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

}
