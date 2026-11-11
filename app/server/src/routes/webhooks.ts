import { Router, type Request, type Response } from 'express'
import express from 'express'
import crypto from 'crypto'
import { getDb } from '../db/index.js'

const router: Router = Router()

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  if (ab.length !== bb.length) return false
  return crypto.timingSafeEqual(ab, bb)
}

/**
 * Optional shared-secret gate. UptimeRobot cannot HMAC; the practical control
 * is a query token on the webhook URL (`?token=`). When
 * UPTIMEROBOT_WEBHOOK_TOKEN is unset the route stays open (legacy) so a
 * deploy does not drop monitors. When set, missing/wrong token → 401.
 */
function webhookTokenOk(req: Request): boolean {
  const expected = process.env.UPTIMEROBOT_WEBHOOK_TOKEN
  if (!expected) return true
  const q = req.query.token
  const fromQuery = typeof q === 'string' ? q : ''
  const fromHeader = typeof req.headers['x-webhook-token'] === 'string'
    ? req.headers['x-webhook-token']
    : ''
  const provided = fromQuery || fromHeader
  if (!provided) return false
  return safeEqual(provided, expected)
}

// Mounted without cookie auth. Cap the body size — real UR payloads are < 1KB.
// Accept form-urlencoded (UR's default) and JSON. Optional shared-secret gate
// above (UPTIMEROBOT_WEBHOOK_TOKEN).
const SIZE_LIMIT = '64kb'
const jsonParser = express.json({ limit: SIZE_LIMIT })
const formParser = express.urlencoded({ extended: false, limit: SIZE_LIMIT })

// UR's documented webhook params (form-encoded by default):
//   monitorID, monitorURL, monitorFriendlyName, alertType (1=down 2=up 3=paused),
//   alertTypeFriendlyName, alertDetails, alertDuration, alertDateTime (unix),
//   monitorAlertContacts, responseTime
// We persist everything we recognize, plus the entire raw body as JSON in
// payload_raw so we can recover unknown fields later.
const KNOWN_FIELDS = new Set([
  'monitorID', 'monitorURL', 'monitorFriendlyName',
  'alertType', 'alertTypeFriendlyName', 'alertDetails', 'alertDuration',
  'alertDateTime', 'monitorAlertContacts', 'responseTime',
])

function pickStr(payload: Record<string, unknown>, key: string): string | null {
  const v = payload[key]
  if (v === undefined || v === null || v === '') return null
  return String(v)
}

function pickInt(payload: Record<string, unknown>, key: string): number | null {
  const v = payload[key]
  if (v === undefined || v === null || v === '') return null
  const n = typeof v === 'number' ? v : parseInt(String(v), 10)
  return Number.isFinite(n) ? n : null
}

function eventAtFromPayload(payload: Record<string, unknown>): string {
  const unix = pickInt(payload, 'alertDateTime')
  if (unix !== null && unix > 0) return new Date(unix * 1000).toISOString()
  return new Date().toISOString()
}

// POST /api/webhooks/uptimerobot — accepts UR's POST and persists to uptime_events.
// Always responds 200 quickly; UR retries are limited and we'd rather log a bad
// payload than reject a transient event.
router.post('/uptimerobot', formParser, jsonParser, (req: Request, res: Response) => {
  if (!webhookTokenOk(req)) {
    res.status(401).json({ ok: false, error: 'unauthorized' })
    return
  }

  const payload = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>

  // Log unknown fields so we notice if UR's payload format ever changes.
  const unknown = Object.keys(payload).filter(k => !KNOWN_FIELDS.has(k))
  if (unknown.length > 0) {
    console.warn(`[webhooks/uptimerobot] Unknown fields in payload: ${unknown.join(', ')}`)
  }

  const monitorId = pickStr(payload, 'monitorID') || ''
  if (!monitorId) {
    // Without a monitor ID we can't usefully attribute the event. UR shouldn't
    // ever send one without it — treat as a malformed test ping but still 200
    // so they don't retry storms.
    console.warn('[webhooks/uptimerobot] Payload missing monitorID; dropping')
    res.status(200).json({ ok: true, stored: false, reason: 'missing monitorID' })
    return
  }

  const row = {
    received_at: new Date().toISOString(),
    event_at: eventAtFromPayload(payload),
    monitor_id: monitorId,
    monitor_name: pickStr(payload, 'monitorFriendlyName'),
    monitor_url: pickStr(payload, 'monitorURL'),
    alert_type: pickInt(payload, 'alertType'),
    alert_type_friendly_name: pickStr(payload, 'alertTypeFriendlyName'),
    alert_details: pickStr(payload, 'alertDetails'),
    alert_duration: pickInt(payload, 'alertDuration'),
    response_time: pickInt(payload, 'responseTime'),
    payload_raw: JSON.stringify(payload),
  }

  try {
    const db = getDb()
    const result = db.prepare(
      `INSERT INTO uptime_events
       (received_at, event_at, monitor_id, monitor_name, monitor_url,
        alert_type, alert_type_friendly_name, alert_details, alert_duration,
        response_time, payload_raw)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      row.received_at, row.event_at, row.monitor_id, row.monitor_name, row.monitor_url,
      row.alert_type, row.alert_type_friendly_name, row.alert_details, row.alert_duration,
      row.response_time, row.payload_raw
    )
    res.status(200).json({ ok: true, stored: true, id: result.lastInsertRowid })
  } catch (err) {
    // Swallow DB errors — don't 500 to UR. Log and acknowledge.
    console.error('[webhooks/uptimerobot] Insert failed:', err)
    res.status(200).json({ ok: true, stored: false, reason: 'persist failed' })
  }
})

export default router
