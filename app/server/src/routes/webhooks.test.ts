import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'
import cookieParser from 'cookie-parser'

// Real SQLite via initDb() — exercises the actual uptime_events schema and
// indexes, not a fake. Each test resets the table.
const TMP_DB = path.join(os.tmpdir(), `cc-webhooks-test-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB
process.env.JWT_SECRET = 'test-secret-webhooks'

const { initDb, getDb } = await import('../db/index.js')
const { default: webhooksRouter } = await import('./webhooks.js')

let server: http.Server
let baseUrl: string

function makeApp(): express.Express {
  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  app.use('/api/webhooks', webhooksRouter)
  return app
}

beforeAll(async () => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
  const app = makeApp()
  await new Promise<void>(resolve => {
    server = app.listen(0, () => resolve())
  })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('server has no address')
  baseUrl = `http://127.0.0.1:${addr.port}`
})

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
  try { getDb().close() } catch {}
  for (const suffix of ['', '-wal', '-shm']) {
    const f = `${TMP_DB}${suffix}`
    if (fs.existsSync(f)) fs.unlinkSync(f)
  }
})

beforeEach(() => {
  getDb().exec('DELETE FROM uptime_events')
  delete process.env.UPTIMEROBOT_API_KEY
  delete process.env.UPTIMEROBOT_WEBHOOK_TOKEN
})

describe('POST /api/webhooks/uptimerobot', () => {
  it('accepts UR form-encoded payload, persists to uptime_events, returns 200, requires no auth', async () => {
    const body = new URLSearchParams({
      monitorID: '799120000',
      monitorURL: 'https://app.example.com',
      monitorFriendlyName: 'Example App',
      alertType: '1',
      alertTypeFriendlyName: 'Down',
      alertDetails: 'HTTP 502',
      alertDuration: '0',
      alertDateTime: '1745683200',
      monitorAlertContacts: '12345_0_0',
      responseTime: '1234',
    }).toString()

    const res = await fetch(`${baseUrl}/api/webhooks/uptimerobot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    })

    expect(res.status).toBe(200)
    const json = await res.json() as { ok: boolean; stored: boolean; id: number }
    expect(json.ok).toBe(true)
    expect(json.stored).toBe(true)

    const rows = getDb().prepare('SELECT * FROM uptime_events').all() as Array<Record<string, unknown>>
    expect(rows).toHaveLength(1)
    const row = rows[0]
    expect(row.monitor_id).toBe('799120000')
    expect(row.monitor_url).toBe('https://app.example.com')
    expect(row.monitor_name).toBe('Example App')
    expect(row.alert_type).toBe(1)
    expect(row.alert_type_friendly_name).toBe('Down')
    expect(row.alert_details).toBe('HTTP 502')
    expect(row.alert_duration).toBe(0)
    expect(row.response_time).toBe(1234)
    expect(row.event_at).toBe(new Date(1745683200 * 1000).toISOString())
    expect(typeof row.received_at).toBe('string')
    expect(typeof row.payload_raw).toBe('string')
    const parsed = JSON.parse(row.payload_raw as string)
    expect(parsed.monitorAlertContacts).toBe('12345_0_0')
  })

  it('accepts JSON body equivalently', async () => {
    const res = await fetch(`${baseUrl}/api/webhooks/uptimerobot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        monitorID: '12345',
        monitorURL: 'https://example.com',
        alertType: 2,
        alertDateTime: 1745683300,
      }),
    })
    expect(res.status).toBe(200)
    const rows = getDb().prepare('SELECT * FROM uptime_events').all() as Array<Record<string, unknown>>
    expect(rows).toHaveLength(1)
    expect(rows[0].monitor_id).toBe('12345')
    expect(rows[0].alert_type).toBe(2)
  })

  it('persists with NULLs for missing optional fields and returns 200', async () => {
    const body = new URLSearchParams({
      monitorID: '999',
      // everything else missing
    }).toString()

    const res = await fetch(`${baseUrl}/api/webhooks/uptimerobot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    })

    expect(res.status).toBe(200)
    const rows = getDb().prepare('SELECT * FROM uptime_events').all() as Array<Record<string, unknown>>
    expect(rows).toHaveLength(1)
    const row = rows[0]
    expect(row.monitor_id).toBe('999')
    expect(row.monitor_name).toBeNull()
    expect(row.monitor_url).toBeNull()
    expect(row.alert_type).toBeNull()
    expect(row.alert_type_friendly_name).toBeNull()
    expect(row.alert_details).toBeNull()
    expect(row.alert_duration).toBeNull()
    expect(row.response_time).toBeNull()
    // event_at falls back to "now" when alertDateTime missing
    expect(typeof row.event_at).toBe('string')
    expect((row.event_at as string).length).toBeGreaterThan(0)
  })

  it('does not require auth (returns 200 with no cookie)', async () => {
    const res = await fetch(`${baseUrl}/api/webhooks/uptimerobot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'monitorID=42',
    })
    expect(res.status).toBe(200)
  })

  it('returns 200 (does not 4xx) when monitorID is missing — UR retries are limited', async () => {
    const res = await fetch(`${baseUrl}/api/webhooks/uptimerobot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'alertType=1',
    })
    expect(res.status).toBe(200)
    const json = await res.json() as { ok: boolean; stored: boolean }
    expect(json.stored).toBe(false)
    const rows = getDb().prepare('SELECT * FROM uptime_events').all() as Array<unknown>
    expect(rows).toHaveLength(0)
  })

  it('when UPTIMEROBOT_WEBHOOK_TOKEN is set, rejects missing/wrong tokens with 401', async () => {
    process.env.UPTIMEROBOT_WEBHOOK_TOKEN = 'ur-hook-secret'
    const missing = await fetch(`${baseUrl}/api/webhooks/uptimerobot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'monitorID=1',
    })
    expect(missing.status).toBe(401)
    const wrong = await fetch(`${baseUrl}/api/webhooks/uptimerobot?token=nope`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'monitorID=1',
    })
    expect(wrong.status).toBe(401)
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM uptime_events').get()).toEqual({ n: 0 })
  })

  it('when UPTIMEROBOT_WEBHOOK_TOKEN is set, accepts the matching query token', async () => {
    process.env.UPTIMEROBOT_WEBHOOK_TOKEN = 'ur-hook-secret'
    const res = await fetch(`${baseUrl}/api/webhooks/uptimerobot?token=ur-hook-secret`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'monitorID=77',
    })
    expect(res.status).toBe(200)
    const json = await res.json() as { stored: boolean }
    expect(json.stored).toBe(true)
  })
})
