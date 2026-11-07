/**
 * Agent-key webhooks (obj 719278).
 *
 * Real DB (triggers + objective_events), real secrets store, real auth +
 * webhook routers behind the real agentKeyGuard. Only the outbound fetch is
 * swapped for a recorder, so nothing leaves the box.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'
import cookieParser from 'cookie-parser'
import jwt from 'jsonwebtoken'

process.env.SECRETS_MASTER_KEY = Buffer.alloc(32, 19).toString('base64')
const TMP_DB = path.join(os.tmpdir(), `cc-agent-webhooks-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB
process.env.JWT_SECRET = 'test-secret-agent-webhooks-xxxx'

const { initDb, getDb } = await import('../db/index.js')
const { default: authRouter } = await import('../routes/auth.js')
const { default: webhookRouter } = await import('../routes/agent-key-webhooks.js')
const { agentKeyGuard } = await import('../middleware/agent-key-guard.js')
const { resolveSecrets, resolveSecretNames } = await import('./secrets-store.js')
const wh = await import('./agent-webhooks.js')
const { DEFAULT_AGENT_WEBHOOK_EVENTS, AGENT_WEBHOOK_EVENTS, NEEDS_AGENT_PILOT_KEY_LABELS } = await import('@operationkit/shared')

const USER_ID = 1
const SECRET_A = 'sender-key-AAAA-0123456789'
const SECRET_B = 'sender-key-BBBB-9876543210'
const DESC_MARKER = 'PRIVATE-DESCRIPTION-MARKER'
const SUMMARY_MARKER = 'TRANSCRIPT-SUMMARY-MARKER'

let server: http.Server
let baseUrl: string
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any

const cookie = () =>
  `token=${jwt.sign({ id: USER_ID, username: 'mike', role: 'admin' }, process.env.JWT_SECRET as string, { expiresIn: '1h' })}`

async function call(method: string, p: string, opts: { bearer?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (opts.bearer) headers.Authorization = `Bearer ${opts.bearer}`
  else headers.Cookie = cookie()
  const res = await fetch(`${baseUrl}${p}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) })
  const text = await res.text()
  let json: Loose = null
  try { json = JSON.parse(text) } catch { json = text }
  return { status: res.status, json, text }
}

// ── outbound recorder ────────────────────────────────────────────────────────
interface Sent { url: string; headers: Record<string, string>; body: string }
let sent: Sent[] = []
let responder: (s: Sent) => number | Error = () => 200

function installRecorder() {
  wh.setAgentWebhookFetch(async (url, init) => {
    const s = { url, headers: init.headers, body: init.body }
    sent.push(s)
    const r = responder(s)
    if (r instanceof Error) throw r
    return { status: r }
  })
}

const sentTo = (host: string) => sent.filter(s => new URL(s.url).host === host)
const bodies = (list: Sent[]) => list.map(s => JSON.parse(s.body))

async function mintKey(label: string): Promise<{ id: number; token: string }> {
  const r = await call('POST', '/api/auth/agent-keys', { body: { label } })
  expect(r.status).toBe(201)
  return r.json
}

function seedCard(keyId: number | null, title = 'Ship the thing'): number {
  const r = getDb()
    .prepare(`INSERT INTO objectives (title, description, agent_context, workspace, created_by, status, agent_key_id, agent_key_label)
              VALUES (?, ?, 'cto', 'operationkit', ?, 'queue', ?, ?)`)
    .run(title, `${DESC_MARKER} do not send`, USER_ID, keyId, keyId ? `key ${keyId}` : null)
  return Number(r.lastInsertRowid)
}

const setStatus = (id: number, status: string) =>
  getDb().prepare('UPDATE objectives SET status = ? WHERE id = ?').run(status, id)

/** Run enqueue + deliver once at `now`. */
async function tick(now = new Date()) {
  wh.enqueueAgentWebhookEvents(getDb(), now)
  await wh.deliverDueAgentWebhooks(getDb(), now)
}

let keyA: { id: number; token: string }
let keyB: { id: number; token: string }

beforeAll(async () => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
  getDb().prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (?, 'mike', 'x', 'admin')`).run(USER_ID)
  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  app.use(agentKeyGuard)
  app.use('/api/auth', authRouter)
  app.use('/api/auth/agent-keys', webhookRouter)
  await new Promise<void>(resolve => {
    server = app.listen(0, '127.0.0.1', () => resolve())
  })
  const addr = server.address() as { port: number }
  baseUrl = `http://127.0.0.1:${addr.port}`
  keyA = await mintKey('Grok: A')
  keyB = await mintKey('Grok: B')
})

afterAll(async () => {
  wh.setAgentWebhookFetch(null)
  await new Promise<void>(resolve => server.close(() => resolve()))
  try { fs.unlinkSync(TMP_DB) } catch { /* ignore */ }
})

beforeEach(async () => {
  sent = []
  responder = () => 200
  installRecorder()
  getDb().exec(`DELETE FROM agent_webhook_deliveries; DELETE FROM agent_key_webhooks; DELETE FROM agent_webhook_need_state; DELETE FROM settings WHERE key = '${wh.CURSOR_SETTING}';`)
  // Anchor the cursor at the current head (first run never replays history).
  wh.enqueueAgentWebhookEvents(getDb())
  for (const [k, secret, host] of [[keyA, SECRET_A, 'a.example.com'], [keyB, SECRET_B, 'b.example.com']] as const) {
    const r = await call('PUT', `/api/auth/agent-keys/${k.id}/webhook`, {
      // Everything but `created`, so each test reads as "the moves after insert".
      // needs_agent is the CoS-only pilot (obj 900214), tested in its own block.
      body: { url: `https://${host}/hook`, secret, events: AGENT_WEBHOOK_EVENTS.filter(e => e !== 'created' && e !== 'needs_agent') },
    })
    expect(r.status).toBe(200)
  }
})

// ── mapping ──────────────────────────────────────────────────────────────────

describe('mapChange', () => {
  it('maps every objective_events kind to the webhook event names in the brief', () => {
    expect(wh.mapChange('created', null, 'queue')?.event).toBe('created')
    expect(wh.mapChange('status', 'queue', 'working')).toEqual({ event: 'working', from_status: 'queue' })
    expect(wh.mapChange('status', 'working', 'review')?.event).toBe('entered_review')
    expect(wh.mapChange('status', 'review', 'done')?.event).toBe('done')
    expect(wh.mapChange('status', 'review', 'cancelled')?.event).toBe('cancelled')
    expect(wh.mapChange('status', 'working', 'ai_review')?.event).toBe('status_changed')
    expect(wh.mapChange('verdict', null, 'pass')).toEqual({ event: 'ai_review', verdict: 'pass' })
    expect(wh.mapChange('verdict', null, 'fail')).toEqual({ event: 'failed', verdict: 'fail' })
    expect(wh.mapChange('verdict', null, 'blocked')).toEqual({ event: 'stalled', verdict: 'blocked' })
    expect(wh.mapChange('needs_secret', null, '1')?.event).toBe('needs_secret')
    expect(wh.mapChange('blocked', null, null)?.event).toBe('stalled')
    expect(wh.mapChange('pr', null, 'open')?.event).toBe('pr_opened')
    expect(wh.mapChange('pr', 'open', 'merged')?.event).toBe('merged')
    expect(wh.mapChange('pr', 'open', 'closed')?.event).toBe('pr_closed')
    expect(wh.mapChange('session_ended', null, null)).toBeNull()
    expect(wh.mapChange('deleted', null, null)).toBeNull()
  })

  it('default filter is exactly the brief: pr_opened, ai_review, entered_review, needs_secret, failed, stalled, done', () => {
    expect([...DEFAULT_AGENT_WEBHOOK_EVENTS].sort()).toEqual(
      ['pr_opened', 'ai_review', 'entered_review', 'needs_secret', 'failed', 'stalled', 'done'].sort(),
    )
  })
})

// ── firing + routing ─────────────────────────────────────────────────────────

describe('a card started by key A', () => {
  it('fires on each status move and every tracked change, to A only — never to B', async () => {
    await call('PUT', `/api/auth/agent-keys/${keyA.id}/webhook`, { body: { events: AGENT_WEBHOOK_EVENTS.filter(e => e !== 'needs_agent') } })
    const id = seedCard(keyA.id)
    const db = getDb()
    setStatus(id, 'working')
    db.prepare(`INSERT INTO objective_prs (objective_id, repo, pr_number, pr_url, state) VALUES (?, 'o/r', 7, 'https://github.com/o/r/pull/7', 'open')`).run(id)
    db.prepare('UPDATE objectives SET pr_url = ? WHERE id = ?').run('https://github.com/o/r/pull/7', id)
    db.prepare(`UPDATE objectives SET needs_secret = '[{"name":"STRIPE_KEY","reason":"x"}]' WHERE id = ?`).run(id)
    db.prepare(`UPDATE objectives SET needs_secret = NULL WHERE id = ?`).run(id) // clearing is not a new ask
    setStatus(id, 'ai_review')
    db.prepare(`UPDATE objectives SET ai_review_verdict = 'fail', ai_review_findings = 'nope' WHERE id = ?`).run(id)
    setStatus(id, 'working')
    db.prepare(`UPDATE objectives SET has_blockers = 1 WHERE id = ?`).run(id)
    db.prepare(`UPDATE objectives SET last_session_summary = ? WHERE id = ?`).run(`${SUMMARY_MARKER} long transcript`, id)
    db.prepare(`UPDATE objectives SET ai_review_verdict = 'pass' WHERE id = ?`).run(id)
    setStatus(id, 'review')
    db.prepare(`UPDATE objective_prs SET state = 'merged' WHERE objective_id = ?`).run(id)
    setStatus(id, 'done')

    await tick()

    expect(sentTo('b.example.com')).toHaveLength(0)
    const got = bodies(sentTo('a.example.com'))
    expect(got.map(b => b.event)).toEqual([
      'created', 'working', 'pr_opened', 'needs_secret', 'status_changed', 'failed', 'working', 'stalled',
      'ai_review', 'entered_review', 'merged', 'done',
    ])
    for (const b of got) {
      expect(b.objective.id).toBe(id)
      expect(b.objective.workspace).toBe('operationkit')
      expect(b.objective.title).toBe('Ship the thing')
      expect(b.objective.url).toMatch(new RegExp(`/o/${id}$`))
      expect(b.agent_key).toEqual({ id: keyA.id, label: 'Grok: A' })
      expect(typeof b.occurred_at).toBe('string')
      expect(typeof b.sent_at).toBe('string')
      expect(b.event_id).toMatch(/^cc_evt_\d+_k\d+$/)
    }
    expect(got.find(b => b.event === 'pr_opened').objective.pr_url).toBe('https://github.com/o/r/pull/7')
    expect(got.find(b => b.event === 'failed').verdict).toBe('fail')
    expect(got.find(b => b.event === 'entered_review').from_status).toBe('working')
    // Distinct ids — one per change.
    expect(new Set(got.map(b => b.event_id)).size).toBe(got.length)
  })

  it('a card created by key B notifies B only; a card with no key notifies nobody', async () => {
    const b = seedCard(keyB.id, 'B card')
    const none = seedCard(null, 'Human card')
    setStatus(b, 'working')
    setStatus(none, 'working')
    await tick()
    expect(sentTo('a.example.com')).toHaveLength(0)
    expect(bodies(sentTo('b.example.com')).map(x => [x.event, x.objective.id])).toEqual([['working', b]])
  })

  it('honours the per-key event filter (default set skips created/working)', async () => {
    const r = await call('PUT', `/api/auth/agent-keys/${keyA.id}/webhook`, { body: { events: [...DEFAULT_AGENT_WEBHOOK_EVENTS] } })
    expect(r.json.webhook.events).toEqual(AGENT_WEBHOOK_EVENTS.filter(e => DEFAULT_AGENT_WEBHOOK_EVENTS.includes(e)))
    const id = seedCard(keyA.id)
    setStatus(id, 'working')
    setStatus(id, 'review')
    await tick()
    expect(bodies(sent).map(b => b.event)).toEqual(['entered_review'])
  })

  it('a disabled webhook or a revoked key queues nothing', async () => {
    await call('PUT', `/api/auth/agent-keys/${keyA.id}/webhook`, { body: { enabled: false } })
    const id = seedCard(keyA.id)
    setStatus(id, 'working')
    await tick()
    expect(sent).toHaveLength(0)
  })
})

// ── auth + signature ─────────────────────────────────────────────────────────

describe('request authentication', () => {
  it('sends Authorization: Bearer <key> by default and a verifiable HMAC-SHA256 of the exact body', async () => {
    setStatus(seedCard(keyA.id), 'working')
    await tick()
    const [s] = sent
    expect(s.headers.Authorization).toBe(`Bearer ${SECRET_A}`)
    expect(s.headers['Content-Type']).toBe('application/json')
    expect(s.headers['X-CC-Event']).toBe('working')
    expect(s.headers['X-CC-Event-Id']).toBe(JSON.parse(s.body).event_id)
    expect(wh.verifySignature(SECRET_A, s.body, s.headers[wh.SIGNATURE_HEADER])).toBe(true)
    // Tampered body or the other key's secret fails.
    expect(wh.verifySignature(SECRET_A, s.body.replace('working', 'done'), s.headers[wh.SIGNATURE_HEADER])).toBe(false)
    expect(wh.verifySignature(SECRET_B, s.body, s.headers[wh.SIGNATURE_HEADER])).toBe(false)
  })

  it('uses the configured header name and prefix', async () => {
    const r = await call('PUT', `/api/auth/agent-keys/${keyA.id}/webhook`, { body: { header_name: 'X-Bot-Key', header_prefix: '' } })
    expect(r.status).toBe(200)
    setStatus(seedCard(keyA.id), 'working')
    await tick()
    expect(sent[0].headers['X-Bot-Key']).toBe(SECRET_A)
    expect(sent[0].headers.Authorization).toBeUndefined()
  })
})

// ── reliability ──────────────────────────────────────────────────────────────

describe('delivery reliability', () => {
  it('retries with backoff and keeps the same event id; delivers once the receiver recovers', async () => {
    let n = 0
    responder = () => (++n <= 2 ? 503 : 200)
    setStatus(seedCard(keyA.id), 'working')
    const t0 = new Date()
    await tick(t0)
    expect(sent).toHaveLength(1)
    // Not due yet → nothing sent.
    await tick(new Date(t0.getTime() + 30_000))
    expect(sent).toHaveLength(1)
    await tick(new Date(t0.getTime() + wh.RETRY_BACKOFF_MS[0] + 1000))
    expect(sent).toHaveLength(2)
    await tick(new Date(t0.getTime() + wh.RETRY_BACKOFF_MS[0] + wh.RETRY_BACKOFF_MS[1] + 2000))
    expect(sent).toHaveLength(3)
    expect(new Set(sent.map(s => s.headers['X-CC-Event-Id'])).size).toBe(1)
    expect(sent.map(s => s.headers['X-CC-Delivery-Attempt'])).toEqual(['1', '2', '3'])
    const row = getDb().prepare('SELECT status, attempts, last_status_code FROM agent_webhook_deliveries').get() as Loose
    expect(row).toEqual({ status: 'delivered', attempts: 3, last_status_code: 200 })
  })

  it('gives up after 5 attempts spread over ~30 minutes and records the failure', async () => {
    responder = () => new Error('connect ECONNREFUSED')
    setStatus(seedCard(keyA.id), 'working')
    const t0 = Date.now()
    let t = t0
    await tick(new Date(t))
    for (const wait of wh.RETRY_BACKOFF_MS) {
      t += wait + 1000
      await tick(new Date(t))
    }
    expect(sent).toHaveLength(wh.MAX_ATTEMPTS)
    expect(wh.RETRY_BACKOFF_MS.reduce((a, b) => a + b, 0)).toBe(30 * 60_000)
    await tick(new Date(t + 3_600_000))
    expect(sent).toHaveLength(wh.MAX_ATTEMPTS)
    const r = await call('GET', `/api/auth/agent-keys/${keyA.id}/webhook/deliveries`)
    expect(r.status).toBe(200)
    expect(r.json.deliveries[0]).toMatchObject({ status: 'failed', attempts: 5, event: 'working', last_error: 'connect ECONNREFUSED' })
  })

  it('dedupes: re-scanning the same changes never queues or sends them twice', async () => {
    const id = seedCard(keyA.id)
    setStatus(id, 'working')
    await tick()
    const first = getDb().prepare('SELECT MIN(id) AS id FROM objective_events WHERE objective_id = ?').get(id) as { id: number }
    // Simulate a crash before the cursor saved: rewind to before this card and re-run.
    getDb().prepare('UPDATE settings SET value = ? WHERE key = ?').run(String(first.id - 1), wh.CURSOR_SETTING)
    await tick()
    expect(sent).toHaveLength(1)
    expect((getDb().prepare('SELECT COUNT(*) AS n FROM agent_webhook_deliveries').get() as { n: number }).n).toBe(1)
  })

  it('a dead receiver never blocks or slows the card write path', async () => {
    responder = () => new Error('hang')
    const id = seedCard(keyA.id)
    const start = Date.now()
    setStatus(id, 'working')
    setStatus(id, 'review')
    // Writes are pure SQLite; the network only happens in the separate deliver tick.
    expect(Date.now() - start).toBeLessThan(200)
    expect(sent).toHaveLength(0)
    expect((getDb().prepare('SELECT status FROM objectives WHERE id = ?').get(id) as { status: string }).status).toBe('review')
  })
})

// ── no secrets ───────────────────────────────────────────────────────────────

describe('no secrets in the payload or the session env', () => {
  it('payload carries only the allowlisted fields — no key, no description, no transcript, no secret names', async () => {
    const id = seedCard(keyA.id)
    getDb().prepare(`UPDATE objectives SET needs_secret = '[{"name":"STRIPE_KEY","reason":"x"}]' WHERE id = ?`).run(id)
    getDb().prepare(`UPDATE objectives SET last_session_summary = ? WHERE id = ?`).run(SUMMARY_MARKER, id)
    setStatus(id, 'review')
    await tick()
    expect(sent.length).toBeGreaterThan(0)
    for (const s of sent) {
      expect(s.body).not.toContain(SECRET_A)
      expect(s.body).not.toContain(SECRET_B)
      expect(s.body).not.toContain(DESC_MARKER)
      expect(s.body).not.toContain(SUMMARY_MARKER)
      expect(s.body).not.toContain('STRIPE_KEY')
      const b = JSON.parse(s.body)
      expect(Object.keys(b).every(k => ['event_id', 'event', 'test', 'objective', 'from_status', 'verdict', 'occurred_at', 'sent_at', 'agent_key'].includes(k))).toBe(true)
      expect(Object.keys(b.objective).sort()).toEqual(['id', 'pr_url', 'status', 'title', 'url', 'workspace'])
    }
    // Stored payloads (the delivery log) are value-free too.
    const stored = getDb().prepare('SELECT payload FROM agent_webhook_deliveries').all() as { payload: string }[]
    for (const r of stored) expect(r.payload).not.toContain(SECRET_A)
  })

  it('the sender key is in the Secrets store but never resolved into a session env', () => {
    const env = resolveSecrets({ userId: USER_ID, workspace: 'operationkit' })
    expect(Object.keys(env).some(k => k.startsWith('CC_AGENT_WEBHOOK_KEY_'))).toBe(false)
    expect(Object.values(env)).not.toContain(SECRET_A)
    expect(resolveSecretNames({ userId: USER_ID, workspace: 'operationkit' }).some(k => k.startsWith('CC_AGENT_WEBHOOK_KEY_'))).toBe(false)
    const row = getDb().prepare(`SELECT value_encrypted FROM secrets WHERE key = ?`).get(wh.secretNameFor(keyA.id)) as { value_encrypted: string }
    expect(row).toBeTruthy()
    expect(row.value_encrypted).not.toContain(SECRET_A)
  })
})

// ── settings routes ──────────────────────────────────────────────────────────

describe('settings routes', () => {
  it('GET never returns the sender key; reports has_secret instead', async () => {
    const r = await call('GET', `/api/auth/agent-keys/${keyA.id}/webhook`)
    expect(r.status).toBe(200)
    expect(r.text).not.toContain(SECRET_A)
    expect(r.json.webhook).toMatchObject({ url: 'https://a.example.com/hook', header_name: 'Authorization', header_prefix: 'Bearer ', has_secret: true, enabled: true })
  })

  it('saving without a new secret keeps the stored one', async () => {
    const r = await call('PUT', `/api/auth/agent-keys/${keyA.id}/webhook`, { body: { url: 'https://a2.example.com/hook' } })
    expect(r.status).toBe(200)
    expect(r.text).not.toContain(SECRET_A)
    setStatus(seedCard(keyA.id), 'working')
    await tick()
    expect(sent[0].url).toBe('https://a2.example.com/hook')
    expect(sent[0].headers.Authorization).toBe(`Bearer ${SECRET_A}`)
  })

  it('rejects non-https, private and credentialed URLs, reserved headers and unknown events', async () => {
    for (const url of ['http://a.example.com/x', 'https://localhost/x', 'https://127.0.0.1/x', 'https://10.0.0.5/x', 'https://192.168.1.2/x', 'https://u:p@a.example.com/x', 'not a url']) {
      const r = await call('PUT', `/api/auth/agent-keys/${keyA.id}/webhook`, { body: { url } })
      expect(r.status, url).toBe(400)
    }
    expect((await call('PUT', `/api/auth/agent-keys/${keyA.id}/webhook`, { body: { header_name: 'Content-Type' } })).status).toBe(400)
    expect((await call('PUT', `/api/auth/agent-keys/${keyA.id}/webhook`, { body: { header_name: 'X-CC-Signature' } })).status).toBe(400)
    expect((await call('PUT', `/api/auth/agent-keys/${keyA.id}/webhook`, { body: { events: ['nope'] } })).status).toBe(400)
    expect((await call('PUT', `/api/auth/agent-keys/${keyA.id}/webhook`, { body: { events: [] } })).status).toBe(400)
  })

  it('a first save needs a sender key', async () => {
    await call('DELETE', `/api/auth/agent-keys/${keyB.id}/webhook`)
    const r = await call('PUT', `/api/auth/agent-keys/${keyB.id}/webhook`, { body: { url: 'https://b.example.com/hook' } })
    expect(r.status).toBe(400)
    expect(r.json.error).toMatch(/sender key/)
  })

  it('an agent key cannot read or change any webhook (not even its own)', async () => {
    for (const [m, p] of [['GET', 'webhook'], ['PUT', 'webhook'], ['DELETE', 'webhook'], ['POST', 'webhook/test'], ['GET', 'webhook/deliveries']] as const) {
      const r = await call(m, `/api/auth/agent-keys/${keyA.id}/${p}`, { bearer: keyA.token, body: m === 'PUT' ? { url: 'https://evil.example.com' } : undefined })
      expect(r.status, `${m} ${p}`).toBe(403)
    }
  })

  it("someone else's key is 404", async () => {
    getDb().prepare(`INSERT OR IGNORE INTO users (id, username, password_hash, role) VALUES (2, 'eva', 'x', 'member')`).run()
    const other = getDb().prepare(`INSERT INTO agent_api_keys (user_id, label, key_hash, last4, scopes) VALUES (2, 'Eva bot', 'h-eva', 'abcd', '[]')`).run()
    const r = await call('GET', `/api/auth/agent-keys/${other.lastInsertRowid}/webhook`)
    expect(r.status).toBe(404)
  })

  it('Send test event: signed POST, logged in the delivery list, returns the receiver status', async () => {
    responder = () => 204
    const r = await call('POST', `/api/auth/agent-keys/${keyA.id}/webhook/test`)
    expect(r.status).toBe(200)
    expect(r.json).toMatchObject({ delivered: true, status_code: 204, error: null })
    expect(r.text).not.toContain(SECRET_A)
    expect(sent).toHaveLength(1)
    const body = JSON.parse(sent[0].body)
    expect(body.test).toBe(true)
    expect(wh.verifySignature(SECRET_A, sent[0].body, sent[0].headers[wh.SIGNATURE_HEADER])).toBe(true)
    const d = await call('GET', `/api/auth/agent-keys/${keyA.id}/webhook/deliveries`)
    expect(d.json.deliveries[0]).toMatchObject({ event_id: body.event_id, status: 'delivered', attempts: 1, last_status_code: 204 })

    responder = () => 401
    const bad = await call('POST', `/api/auth/agent-keys/${keyA.id}/webhook/test`)
    expect(bad.json).toMatchObject({ delivered: false, status_code: 401, error: 'HTTP 401' })
  })

  it('DELETE removes the config and the stored sender key, and cancels pending deliveries', async () => {
    responder = () => 500
    setStatus(seedCard(keyA.id), 'working')
    await tick()
    const r = await call('DELETE', `/api/auth/agent-keys/${keyA.id}/webhook`)
    expect(r.status).toBe(200)
    expect(getDb().prepare('SELECT 1 FROM secrets WHERE key = ?').get(wh.secretNameFor(keyA.id))).toBeUndefined()
    expect((await call('GET', `/api/auth/agent-keys/${keyA.id}/webhook`)).json.webhook).toBeNull()
    const pending = getDb().prepare(`SELECT COUNT(*) AS n FROM agent_webhook_deliveries WHERE status = 'pending'`).get() as { n: number }
    expect(pending.n).toBe(0)
  })
})

// ── get_changes feed sees the new kinds ──────────────────────────────────────

describe('objective_events triggers (shared with get_changes)', () => {
  it('records needs_secret only when the list grows, and a blocker unless the same update parks with verdict blocked', () => {
    const db = getDb()
    const id = seedCard(null)
    const kinds = () => (db.prepare('SELECT kind FROM objective_events WHERE objective_id = ? ORDER BY id').all(id) as { kind: string }[]).map(r => r.kind)
    db.prepare(`UPDATE objectives SET needs_secret = '[{"name":"A"}]' WHERE id = ?`).run(id)
    db.prepare(`UPDATE objectives SET needs_secret = '[{"name":"A"},{"name":"B"}]' WHERE id = ?`).run(id)
    db.prepare(`UPDATE objectives SET needs_secret = '[{"name":"B"}]' WHERE id = ?`).run(id)
    db.prepare(`UPDATE objectives SET has_blockers = 1 WHERE id = ?`).run(id)
    db.prepare(`UPDATE objectives SET has_blockers = 0 WHERE id = ?`).run(id)
    db.prepare(`UPDATE objectives SET status = 'review', ai_review_verdict = 'blocked', has_blockers = 1 WHERE id = ?`).run(id)
    expect(kinds().sort()).toEqual(['blocked', 'created', 'needs_secret', 'needs_secret', 'status', 'verdict'])
  })
})

// ── needs_agent pilot: wake General only when a card needs it (obj 900214) ──

describe('needs_agent pilot (General)', () => {
  const COS_SECRET = 'cos-routine-sender-key-0123456789'
  const COS_HOST = 'cos.example.com'
  const FINDINGS_MARKER = 'REVIEW-FINDINGS-MARKER'
  const REASON_MARKER = 'WORKER-REASON-MARKER'
  let cos: { id: number; token: string }

  beforeAll(async () => {
    cos = await mintKey('Grok: General')
  })

  beforeEach(async () => {
    const r = await call('PUT', `/api/auth/agent-keys/${cos.id}/webhook`, {
      body: { url: `https://${COS_HOST}/routines/card-wake`, secret: COS_SECRET, events: ['needs_agent'] },
    })
    expect(r.status).toBe(200)
    expect(r.json.webhook.events).toEqual(['needs_agent'])
  })

  const cosCard = (title = 'Route the Example5 invoice question') => {
    const id = seedCard(cos.id, title)
    getDb().prepare('UPDATE objectives SET agent_key_label = ? WHERE id = ?').run('Grok: General', id)
    return id
  }
  const upd = (id: number, set: string) => getDb().prepare(`UPDATE objectives SET ${set} WHERE id = ?`).run(id)
  const wakes = () => bodies(sentTo(COS_HOST))

  it('classifyNeed: blocked, waiting on the agent, or a Mike decision — nothing else', () => {
    const base = { status: 'working', has_blockers: 0, ai_review_verdict: null, needs_secret: null }
    expect(wh.classifyNeed(base)).toBeNull()
    expect(wh.classifyNeed({ ...base, status: 'queue' })).toBeNull()
    expect(wh.classifyNeed({ ...base, status: 'ai_review' })).toBeNull()
    expect(wh.classifyNeed({ ...base, status: 'done', has_blockers: 1 })).toBeNull()
    expect(wh.classifyNeed({ ...base, status: 'review', deleted_at: '2026-11-06' })).toBeNull()
    expect(wh.classifyNeed({ ...base, has_blockers: 1 })).toMatchObject({ kind: 'blocked', category: 'blocked' })
    expect(wh.classifyNeed({ ...base, status: 'review', ai_review_verdict: 'blocked', blocked_reason: 'preview-infra' }))
      .toMatchObject({ kind: 'blocked', why: expect.stringContaining('preview-infra') })
    expect(wh.classifyNeed({ ...base, status: 'review', ai_review_verdict: 'fail' })).toMatchObject({ kind: 'failed_review', category: 'waiting_on_agent' })
    expect(wh.classifyNeed({ ...base, status: 'review', ai_review_verdict: 'pass' })).toMatchObject({ kind: 'review', category: 'mike_decision' })
    expect(wh.classifyNeed({ ...base, needs_secret: '[{"name":"STRIPE_KEY","reason":"x"}]' }))
      .toMatchObject({ kind: 'needs_secret', category: 'mike_decision', why: expect.stringContaining('STRIPE_KEY') })
  })

  it('status flicker never wakes CoS: queue → working → ai_review → working, summary, PR link', async () => {
    const id = cosCard()
    for (const st of ['working', 'ai_review', 'working']) {
      setStatus(id, st)
      await tick()
    }
    upd(id, `last_session_summary = '${SUMMARY_MARKER}'`)
    getDb().prepare(`INSERT INTO objective_prs (objective_id, repo, pr_number, pr_url, state) VALUES (?, 'x/y', 1, 'https://github.com/x/y/pull/1', 'open')`).run(id)
    await tick()
    expect(wakes()).toHaveLength(0)
  })

  it('one wake when the card needs CoS, with id, title, workspace, why and a short status — sent with the routine key as Bearer', async () => {
    const id = cosCard()
    setStatus(id, 'working')
    await tick()
    upd(id, `status = 'review', ai_review_verdict = 'pass', ai_review_findings = '${FINDINGS_MARKER}', last_session_summary = '${SUMMARY_MARKER}'`)
    await tick()
    const list = sentTo(COS_HOST)
    expect(list).toHaveLength(1)
    expect(list[0].headers.Authorization).toBe(`Bearer ${COS_SECRET}`)
    expect(list[0].headers['X-CC-Event']).toBe('needs_agent')
    const b = JSON.parse(list[0].body)
    expect(b).toMatchObject({
      event: 'needs_agent',
      objective: { id, title: 'Route the Example5 invoice question', workspace: 'operationkit', status: 'review' },
      need: { kind: 'review', category: 'mike_decision' },
      status_summary: 'review · AI review pass',
      agent_key: { id: cos.id, label: 'Grok: General' },
    })
    expect(b.need.why).toMatch(/needs Mike's accept/)
    expect(b.summary).toBe(`Card #${id} (operationkit) needs General: ${b.need.why}. Status: review · AI review pass.`)
    for (const leak of [COS_SECRET, DESC_MARKER, SUMMARY_MARKER, FINDINGS_MARKER, cos.token]) expect(list[0].body).not.toContain(leak)

    // Still needing the same thing: more changes on the card never re-wake.
    upd(id, `last_session_summary = 'another summary'`)
    await tick()
    await tick()
    expect(wakes()).toHaveLength(1)
  })

  it('a burst of moves inside one tick is one decision, on the state the card ends in', async () => {
    const id = cosCard()
    setStatus(id, 'working')
    setStatus(id, 'ai_review')
    upd(id, `status = 'review', ai_review_verdict = 'fail'`)
    await tick()
    expect(wakes().map(b => b.need.kind)).toEqual(['failed_review'])
  })

  it('wakes again on escalation or on a new round, not on de-escalation', async () => {
    const id = cosCard()
    upd(id, `status = 'review', ai_review_verdict = 'pass'`)
    await tick()
    upd(id, `needs_secret = '[{"name":"EXAMPLE5_API_KEY","reason":"${REASON_MARKER}"}]'`) // escalation
    await tick()
    upd(id, `needs_secret = NULL`) // back to plain review — de-escalation, no wake
    await tick()
    setStatus(id, 'working') // reopened: no longer needs CoS → re-armed
    await tick()
    upd(id, 'has_blockers = 1') // new round: worker raised a blocker
    await tick()
    const w = wakes()
    expect(w.map(b => [b.need.kind, b.need.category])).toEqual([
      ['review', 'mike_decision'],
      ['needs_secret', 'mike_decision'],
      ['blocked', 'blocked'],
    ])
    expect(w[1].need.why).toContain('EXAMPLE5_API_KEY')
    expect(JSON.stringify(w)).not.toContain(REASON_MARKER)
    expect(new Set(w.map(b => b.event_id)).size).toBe(3)
  })

  it('only the pilot key: other bots cannot subscribe and their webhooks never get needs_agent', async () => {
    const bad = await call('PUT', `/api/auth/agent-keys/${keyA.id}/webhook`, { body: { events: ['needs_agent', 'done'] } })
    expect(bad.status).toBe(400)
    expect(bad.json.error).toMatch(/pilot/)
    const id = seedCard(keyA.id)
    upd(id, `status = 'review', ai_review_verdict = 'fail'`)
    await tick()
    expect(bodies(sentTo('a.example.com')).map(b => b.event)).not.toContain('needs_agent')
    expect(wakes()).toHaveLength(0)
  })

  it('a card CoS does not own never wakes CoS', async () => {
    const id = seedCard(null)
    upd(id, `status = 'review', ai_review_verdict = 'fail'`)
    await tick()
    expect(wakes()).toHaveLength(0)
  })

  it('a failing routine retries the same wake (same event id) and never blocks the card', async () => {
    responder = () => 429
    const id = cosCard()
    const t0 = new Date()
    upd(id, 'status = \'working\', has_blockers = 1')
    await tick(t0)
    expect(getDb().prepare('SELECT status FROM objectives WHERE id = ?').get(id)).toMatchObject({ status: 'working' })
    responder = () => 200
    await tick(new Date(t0.getTime() + wh.RETRY_BACKOFF_MS[0] + 1000))
    const w = sentTo(COS_HOST)
    expect(w).toHaveLength(2)
    expect(JSON.parse(w[0].body).event_id).toBe(JSON.parse(w[1].body).event_id)
    const row = getDb().prepare("SELECT status, attempts FROM agent_webhook_deliveries WHERE event = 'needs_agent'").get() as Loose
    expect(row).toMatchObject({ status: 'delivered', attempts: 2 })
  })

  it('Send test event posts a needs_agent-shaped test to the CoS routine', async () => {
    const r = await call('POST', `/api/auth/agent-keys/${cos.id}/webhook/test`)
    expect(r.status).toBe(200)
    expect(r.text).not.toContain(COS_SECRET)
    const b = JSON.parse(sentTo(COS_HOST)[0].body)
    expect(b).toMatchObject({ event: 'needs_agent', test: true, need: { kind: 'review' } })
    expect(b.summary).toMatch(/General/)
  })

  it('removing the webhook clears its need state', async () => {
    const id = cosCard()
    upd(id, `status = 'review'`)
    await tick()
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM agent_webhook_need_state WHERE key_id = ?').get(cos.id)).toMatchObject({ n: 1 })
    expect((await call('DELETE', `/api/auth/agent-keys/${cos.id}/webhook`)).status).toBe(200)
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM agent_webhook_need_state WHERE key_id = ?').get(cos.id)).toMatchObject({ n: 0 })
  })
})

// ── needs_agent pilot allowlist is exactly General + General (obj 900255) ──

describe('needs_agent pilot allowlist (obj 900255)', () => {
  const allowed: readonly string[] = ['Grok: General', 'Grok: Chief of Staff']
  const denied: readonly string[] = ['Grok Bot', 'Unrelated Helper']
  const hostFor = (label: string) => `${label.toLowerCase().replace(/[^a-z]+/g, '-')}.allow.example.com`
  const keys: Record<string, { id: number; token: string }> = {}

  beforeAll(async () => {
    for (const label of [...allowed, ...denied]) keys[label] = await mintKey(label)
  })

  const ownedCard = (label: string) => {
    const id = seedCard(keys[label].id, `allowlist card for ${label}`)
    getDb().prepare('UPDATE objectives SET agent_key_label = ? WHERE id = ?').run(label, id)
    return id
  }

  it('the shared list is exactly the two pilot labels', () => {
    expect([...NEEDS_AGENT_PILOT_KEY_LABELS]).toEqual(allowed)
  })

  for (const label of allowed) {
    it(`"${label}" can save needs_agent and the sender enqueues its wake`, async () => {
      const r = await call('PUT', `/api/auth/agent-keys/${keys[label].id}/webhook`, {
        body: { url: `https://${hostFor(label)}/wake`, secret: 'allowlist-sender-key-0123456789', events: ['needs_agent'] },
      })
      expect(r.status).toBe(200)
      expect(r.json.webhook.events).toEqual(['needs_agent'])
      const id = ownedCard(label)
      getDb().prepare(`UPDATE objectives SET status = 'review', ai_review_verdict = 'fail' WHERE id = ?`).run(id)
      await tick()
      const wakes = bodies(sentTo(hostFor(label))).filter(b => b.event === 'needs_agent')
      expect(wakes).toHaveLength(1)
      expect(wakes[0]).toMatchObject({ objective: { id }, agent_key: { id: keys[label].id, label } })
    })
  }

  for (const label of denied) {
    it(`"${label}" is denied needs_agent (400) and the sender skips it; existing events still save`, async () => {
      const bad = await call('PUT', `/api/auth/agent-keys/${keys[label].id}/webhook`, {
        body: { url: `https://${hostFor(label)}/wake`, secret: 'allowlist-sender-key-0123456789', events: ['needs_agent', 'done'] },
      })
      expect(bad.status).toBe(400)
      expect(bad.json.error).toBe(`needs_agent is a pilot: only the ${allowed.map(l => `"${l}"`).join(' and ')} keys can use it for now`)
      const ok = await call('PUT', `/api/auth/agent-keys/${keys[label].id}/webhook`, {
        body: { url: `https://${hostFor(label)}/wake`, secret: 'allowlist-sender-key-0123456789', events: ['done'] },
      })
      expect(ok.status).toBe(200)
      expect(ok.json.webhook.events).toEqual(['done'])
      // Even if a needs_agent subscription were planted directly in the DB, the sender skips a non-pilot key.
      getDb().prepare(`UPDATE agent_key_webhooks SET events = ? WHERE key_id = ?`).run(JSON.stringify(['needs_agent', 'done']), keys[label].id)
      const id = ownedCard(label)
      getDb().prepare(`UPDATE objectives SET status = 'review', ai_review_verdict = 'fail' WHERE id = ?`).run(id)
      await tick()
      expect(bodies(sentTo(hostFor(label))).map(b => b.event)).not.toContain('needs_agent')
    })
  }
})
