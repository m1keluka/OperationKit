import { Router, type Response } from 'express'
import { getDb } from '../db/index.js'
import { requireAuth, type AuthRequest } from '../middleware/auth.js'
import {
  getMonitors,
  getUptimeRobotApiKey,
  statusLabel,
  toIso,
  UptimeRobotConfigError,
  UptimeRobotApiError,
  type UptimeRobotMonitor,
} from '../services/uptimerobot.js'

const router: Router = Router()

interface ShapedMonitor {
  id: number
  friendly_name: string
  url: string
  status: number
  status_label: string
  last_check: string | null
  response_time: number | null
  response_times: Array<{ datetime: string; value: number }>
  uptime_ratio_30d: number | null
}

function shapeMonitor(m: UptimeRobotMonitor): ShapedMonitor {
  const responseTimes = (m.response_times || [])
    .map(rt => ({
      datetime: toIso(rt.datetime) || '',
      value: typeof rt.value === 'number' ? rt.value : Number(rt.value) || 0,
    }))
    .filter(rt => rt.datetime)

  const latestRt = responseTimes.length > 0 ? responseTimes[responseTimes.length - 1].value : null
  const uptimeRatio = m.custom_uptime_ratio !== undefined
    ? parseFloat(m.custom_uptime_ratio)
    : null

  return {
    id: m.id,
    friendly_name: m.friendly_name,
    url: m.url,
    status: m.status,
    status_label: statusLabel(m.status),
    last_check: toIso(m.last_check),
    response_time: latestRt,
    response_times: responseTimes,
    uptime_ratio_30d: uptimeRatio !== null && Number.isFinite(uptimeRatio) ? uptimeRatio : null,
  }
}

// GET /api/status/monitors — current state for every UR monitor.
// When the API key is missing, returns configured:false with empty list (HTTP 200)
// so the frontend can render an empty/setup state instead of an error.
router.get('/monitors', requireAuth, async (_req: AuthRequest, res: Response) => {
  const apiKey = getUptimeRobotApiKey()
  if (!apiKey) {
    res.json({
      configured: false,
      fetched_at: new Date().toISOString(),
      monitors: [],
    })
    return
  }

  try {
    const ur = await getMonitors()
    const shaped = (ur.monitors || []).map(shapeMonitor)
    res.json({
      configured: true,
      fetched_at: new Date().toISOString(),
      monitors: shaped,
    })
  } catch (err) {
    if (err instanceof UptimeRobotConfigError) {
      res.json({
        configured: false,
        fetched_at: new Date().toISOString(),
        monitors: [],
      })
      return
    }
    if (err instanceof UptimeRobotApiError) {
      res.status(502).json({ error: err.message })
      return
    }
    res.status(500).json({ error: err instanceof Error ? err.message : 'Unknown error' })
  }
})

// GET /api/status/events?days=30&limit=100 — incident timeline rows.
// Excludes the raw payload by default (large, only useful for debugging).
router.get('/events', requireAuth, (req: AuthRequest, res: Response) => {
  const days = Math.max(1, Math.min(parseInt(req.query.days as string) || 30, 365))
  const limit = Math.max(1, Math.min(parseInt(req.query.limit as string) || 100, 500))

  const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000
  const cutoffIso = new Date(cutoffMs).toISOString()

  const db = getDb()
  const rows = db.prepare(
    `SELECT id, received_at, event_at, monitor_id, monitor_name, monitor_url,
            alert_type, alert_type_friendly_name, alert_details, alert_duration, response_time
     FROM uptime_events
     WHERE event_at >= ?
     ORDER BY event_at DESC
     LIMIT ?`
  ).all(cutoffIso, limit) as Array<Record<string, unknown>>

  res.json({ events: rows, days, limit })
})

export default router
