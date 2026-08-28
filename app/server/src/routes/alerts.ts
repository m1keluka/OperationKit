import { Router, type Request, type Response, type NextFunction } from 'express'
import { getDb } from '../db/index.js'
import { broadcast } from '../ws/index.js'
import { notify } from '../services/notifier.js'
import { requireAuth, type AuthRequest } from '../middleware/auth.js'
import type { Alert, AlertSeverity, IngestAlertRequest } from '@command-center/shared'

const router: Router = Router()

const VALID_SEVERITIES: AlertSeverity[] = ['normal', 'high', 'emergency']

function rowToAlert(row: Record<string, unknown>): Alert {
  return {
    id: row.id as number,
    severity: row.severity as AlertSeverity,
    source: row.source as string,
    title: row.title as string,
    message: row.message as string,
    dedup_key: (row.dedup_key as string | null) ?? null,
    url: (row.url as string | null) ?? null,
    email_sent_at: (row.email_sent_at as string | null) ?? null,
    acked_at: (row.acked_at as string | null) ?? null,
    acked_by: (row.acked_by as string | null) ?? null,
    created_at: row.created_at as string,
  }
}

// Bearer-token auth for cron / external scripts. Does NOT require a user JWT.
// Token is set via ALERTS_API_TOKEN env var (Doppler-managed in prod).
function requireServiceToken(req: Request, res: Response, next: NextFunction): void {
  const expected = process.env.ALERTS_API_TOKEN
  if (!expected) {
    res.status(503).json({ error: 'ALERTS_API_TOKEN not configured on server' })
    return
  }
  const header = req.headers.authorization || ''
  const match = header.match(/^Bearer\s+(.+)$/)
  if (!match || match[1] !== expected) {
    res.status(401).json({ error: 'Invalid or missing bearer token' })
    return
  }
  next()
}

// GET /api/alerts?unacked=true&limit=50
router.get('/', requireAuth, (req: AuthRequest, res: Response) => {
  const unackedOnly = req.query.unacked === 'true'
  const rawLimit = parseInt(req.query.limit as string)
  const limit = Math.min(Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : 50, 200)

  const db = getDb()
  const sql = unackedOnly
    ? 'SELECT * FROM alerts WHERE acked_at IS NULL ORDER BY created_at DESC LIMIT ?'
    : 'SELECT * FROM alerts ORDER BY created_at DESC LIMIT ?'
  const rows = db.prepare(sql).all(limit) as Record<string, unknown>[]

  const unackedCountRow = db.prepare('SELECT COUNT(*) AS n FROM alerts WHERE acked_at IS NULL').get() as { n: number }
  res.json({
    alerts: rows.map(rowToAlert),
    unacked_count: unackedCountRow.n,
  })
})

// POST /api/alerts/:id/ack
router.post('/:id/ack', requireAuth, (req: AuthRequest, res: Response) => {
  const id = parseInt(req.params.id as string)
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: 'Invalid id' })
    return
  }
  const db = getDb()
  const result = db
    .prepare(
      "UPDATE alerts SET acked_at = datetime('now'), acked_by = ? WHERE id = ? AND acked_at IS NULL"
    )
    .run(req.user?.username ?? 'unknown', id)
  if (result.changes === 0) {
    res.status(404).json({ error: 'Alert not found or already acked' })
    return
  }
  broadcast({ type: 'alert_acked', payload: { id } })
  res.json({ ok: true })
})

// POST /api/alerts/ack-all — ack every currently-unacked alert.
router.post('/ack-all', requireAuth, (req: AuthRequest, res: Response) => {
  const db = getDb()
  const rows = db
    .prepare('SELECT id FROM alerts WHERE acked_at IS NULL')
    .all() as { id: number }[]
  if (rows.length === 0) {
    res.json({ ok: true, acked: 0 })
    return
  }
  db.prepare(
    "UPDATE alerts SET acked_at = datetime('now'), acked_by = ? WHERE acked_at IS NULL"
  ).run(req.user?.username ?? 'unknown')
  for (const { id } of rows) {
    broadcast({ type: 'alert_acked', payload: { id } })
  }
  res.json({ ok: true, acked: rows.length })
})

// POST /api/alerts — ingest from cron / external scripts. Bearer-token auth.
router.post('/', requireServiceToken, async (req: Request, res: Response) => {
  const body = req.body as Partial<IngestAlertRequest>
  if (!body || typeof body !== 'object') {
    res.status(400).json({ error: 'JSON body required' })
    return
  }
  if (!body.title || !body.message || !body.severity || !body.source) {
    res.status(400).json({ error: 'severity, source, title, and message are required' })
    return
  }
  if (!VALID_SEVERITIES.includes(body.severity)) {
    res.status(400).json({ error: `severity must be one of: ${VALID_SEVERITIES.join(', ')}` })
    return
  }

  await notify({
    severity: body.severity,
    source: body.source,
    title: body.title,
    message: body.message,
    dedup_key: body.dedup_key,
    url: body.url,
  })

  res.status(201).json({ ok: true })
})

export default router
