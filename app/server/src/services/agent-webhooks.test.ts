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
const egress = await import('./webhook-egress.js')
const { initAgentWebhooksSchema, CARD_NEED_MIGRATED_SETTING } = await import('../db/schema/agent-webhooks.js')
const { DEFAULT_AGENT_WEBHOOK_EVENTS, AGENT_WEBHOOK_EVENTS } = await import('@operationkit/shared')

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
  `token=${jwt.sign({ id: USER_ID, username: 'operator', role: 'admin' }, process.env.JWT_SECRET as string, { expiresIn: '1h' })}`

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
interface Sent { url: string; headers: Record<string, string>; body: string; address: string }
let sent: Sent[] = []
let responder: (s: Sent) => number | Error = () => 200

function installRecorder() {
  wh.setAgentWebhookFetch(async (url, init) => {
    const s = { url, headers: init.headers, body: init.body, address: init.address }
    sent.push(s)
    const r = responder(s)
    if (r instanceof Error) throw r
    return { status: r }
  })
}

/**
 * Fake DNS (obj 900270): every *.example.com fixture host resolves to one public
 * address; anything else is NXDOMAIN. Tests that exercise the SSRF guard swap
 * entries in `dnsTable`.
 */
const PUBLIC_IP = '93.184.216.34'
let dnsTable: Record<string, string[]> = {}
let dnsCalls: string[] = []
function installDns() {
  egress.setWebhookDnsLookup(async host => {
    dnsCalls.push(host)
    const fixed = dnsTable[host]
    const list = fixed ?? (host.endsWith('.example.com') ? [PUBLIC_IP] : null)
    if (!list) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' })
    return list.map(address => ({ address, family: address.includes(':') ? 6 : 4 }))
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
  getDb().prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (?, 'operator', 'x', 'admin')`).run(USER_ID)
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
  egress.setWebhookDnsLookup(null)
  await new Promise<void>(resolve => server.close(() => resolve()))
  try { fs.unlinkSync(TMP_DB) } catch { /* ignore */ }
})

beforeEach(async () => {
  sent = []
  responder = () => 200
  installRecorder()
  dnsTable = {}
  dnsCalls = []
  installDns()
  getDb().exec(`DELETE FROM agent_webhook_deliveries; DELETE FROM agent_key_webhooks; DELETE FROM agent_webhook_need_state; DELETE FROM agent_webhook_card_need_state; DELETE FROM settings WHERE key = '${wh.CURSOR_SETTING}';`)
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
      expect(Object.keys(b).every(k => ['event_id', 'event', 'test', 'objective', 'from_status', 'verdict', 'occurred_at', 'sent_at', 'agent_key', 'owner_bot'].includes(k))).toBe(true)
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
    for (const url of [
      'http://a.example.com/x', 'https://localhost/x', 'https://127.0.0.1/x', 'https://10.0.0.5/x', 'https://192.168.1.2/x', 'https://u:p@a.example.com/x', 'not a url',
      // obj 900270: literals the send-time policy refuses are refused at save too.
      'https://169.254.169.254/latest', 'https://100.64.0.1/x', 'https://[::ffff:127.0.0.1]/x', 'https://[::1]/x', 'https://[fd00::1]/x',
      'https://198.18.0.1/x', 'https://metadata.google.internal/x',
    ]) {
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

describe('needs_agent on the General key', () => {
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

  it('classifyNeed: blocked, waiting on the agent, or a Operator decision — nothing else', () => {
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
    expect(b.need.why).toMatch(/needs Operator's accept/)
    // obj 900309: the card is UNOWNED (owner_bot null), so the summary must say so
    // rather than naming the agent key. The key is a shared connection — its label is
    // who SENT the card, not who owns it, and spelling it as the owner made a filed-by-X
    // card indistinguishable from an owned-by-X card to a routing bot. owner_bot (null
    // here) stays the machine-readable truth; the prose now agrees with it.
    expect(b.summary).toBe(`Card #${id} (operationkit) needs an agent (unowned — routed to the General): ${b.need.why}. Status: review · AI review pass.`)
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

  it('any key may opt in now (obj 900270), but each key is woken only for its own cards', async () => {
    const ok = await call('PUT', `/api/auth/agent-keys/${keyA.id}/webhook`, { body: { events: ['needs_agent', 'done'] } })
    expect(ok.status).toBe(200)
    expect(ok.json.webhook.events).toEqual(['done', 'needs_agent'])
    const id = seedCard(keyA.id)
    upd(id, `status = 'review', ai_review_verdict = 'fail'`)
    await tick()
    expect(bodies(sentTo('a.example.com')).filter(b => b.event === 'needs_agent').map(b => b.objective.id)).toEqual([id])
    expect(wakes()).toHaveLength(0) // CoS did not file it → CoS is not told
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
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM agent_webhook_card_need_state WHERE key_id = ?').get(cos.id)).toMatchObject({ n: 1 })
    expect((await call('DELETE', `/api/auth/agent-keys/${cos.id}/webhook`)).status).toBe(200)
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM agent_webhook_card_need_state WHERE key_id = ?').get(cos.id)).toMatchObject({ n: 0 })
  })
})

// ── obj 900270: one shared needs_agent webhook ───────────────────────────────

describe('shared needs_agent webhook (obj 900270)', () => {
  const SHARED_SECRET = 'shared-connection-sender-key-0123456789'
  const SHARED_HOST = 'shared.example.com'
  let shared: { id: number; token: string }
  let cosKey: { id: number; token: string }

  beforeAll(async () => {
    shared = await mintKey('OpKit')
    cosKey = await mintKey('Grok: General')
  })

  beforeEach(async () => {
    const r = await call('PUT', `/api/auth/agent-keys/${shared.id}/webhook`, {
      body: { url: `https://${SHARED_HOST}/card-wake`, secret: SHARED_SECRET, events: ['needs_agent'] },
    })
    expect(r.status).toBe(200)
  })

  const sharedCard = (title: string, ownerBot: string | null) => {
    const id = seedCard(shared.id, title)
    getDb().prepare('UPDATE objectives SET agent_key_label = ?, owner_bot = ? WHERE id = ?').run('OpKit', ownerBot, id)
    return id
  }
  const upd = (id: number, set: string) => getDb().prepare(`UPDATE objectives SET ${set} WHERE id = ?`).run(id)
  const allNeedWakes = () => bodies(sent).filter(b => b.event === 'needs_agent')

  it('the label gate is gone: the shared key (label "OpKit") saves needs_agent', async () => {
    const r = await call('GET', `/api/auth/agent-keys/${shared.id}/webhook`)
    expect(r.json.webhook.events).toEqual(['needs_agent'])
    for (const label of ['Grok Bot', 'Unrelated Helper', 'Grok: General']) {
      const k = await mintKey(label)
      const save = await call('PUT', `/api/auth/agent-keys/${k.id}/webhook`, {
        body: { url: 'https://other.example.com/wake', secret: 'any-sender-key-0123456789', events: ['needs_agent', 'done'] },
      })
      expect(save.status, label).toBe(200)
    }
  })

  it('payload carries owner_bot; the summary names the owner bot', async () => {
    const id = sharedCard('Research the Example5 churn', 'Grok: Research')
    upd(id, `status = 'review', ai_review_verdict = 'fail'`)
    await tick()
    const list = sentTo(SHARED_HOST)
    expect(list).toHaveLength(1)
    expect(list[0].headers.Authorization).toBe(`Bearer ${SHARED_SECRET}`)
    expect(wh.verifySignature(SHARED_SECRET, list[0].body, list[0].headers[wh.SIGNATURE_HEADER])).toBe(true)
    const b = JSON.parse(list[0].body)
    expect(b).toMatchObject({
      event: 'needs_agent',
      owner_bot: 'Grok: Research',
      objective: { id, workspace: 'operationkit', status: 'review' },
      need: { kind: 'failed_review' },
      agent_key: { id: shared.id, label: 'OpKit' },
    })
    expect(b.summary).toBe(`Card #${id} (operationkit) needs Research: ${b.need.why}. Status: review · AI review fail.`)
    for (const leak of [SHARED_SECRET, shared.token, DESC_MARKER]) expect(list[0].body).not.toContain(leak)
  })

  it('unowned card: owner_bot is present and null', async () => {
    const id = sharedCard('Nobody owns this', null)
    upd(id, `status = 'working', has_blockers = 1`)
    await tick()
    const [b] = bodies(sentTo(SHARED_HOST))
    expect(b).toHaveProperty('owner_bot', null)
    // obj 900309: the card is UNOWNED (owner_bot null), so the summary must say so
    // rather than naming the agent key. The key is a shared connection — its label is
    // who SENT the card, not who owns it, and spelling it as the owner made a filed-by-X
    // card indistinguishable from an owned-by-X card to a routing bot. owner_bot (null
    // here) stays the machine-readable truth; the prose now agrees with it.
    expect(b.summary).toMatch(new RegExp(`^Card #${id} \\(operationkit\\) needs an agent \\(unowned`))
    expect(b.summary).not.toContain('OpKit')
  })

  it('exactly one delivery per need — bursts, re-scans and other subscribed keys never add a second', async () => {
    // Every other key is subscribed to needs_agent too.
    for (const k of [keyA, keyB]) {
      expect((await call('PUT', `/api/auth/agent-keys/${k.id}/webhook`, { body: { events: [...AGENT_WEBHOOK_EVENTS] } })).status).toBe(200)
    }
    const id = sharedCard('One need, one wake', 'grok-ops')
    setStatus(id, 'working')
    setStatus(id, 'ai_review')
    upd(id, `status = 'review', ai_review_verdict = 'fail'`)
    upd(id, `last_session_summary = 'first'`)
    await tick()
    upd(id, `last_session_summary = 'second'`)
    await tick()
    await tick()
    // Re-scan the same events (crash between enqueue and cursor save).
    getDb().prepare(`DELETE FROM settings WHERE key = ?`).run(wh.CURSOR_SETTING)
    getDb().prepare(`INSERT INTO settings (key, value) VALUES (?, '0')`).run(wh.CURSOR_SETTING)
    await tick()
    // (The cursor rewind also replays older fixtures' events to A/B — only this card matters here.)
    expect(allNeedWakes().filter(b => b.objective.id === id)).toHaveLength(1)
    expect(sentTo(SHARED_HOST)).toHaveLength(1)
    const rows = getDb().prepare(`SELECT COUNT(*) AS n FROM agent_webhook_deliveries WHERE event = 'needs_agent' AND objective_id = ?`).get(id)
    expect(rows).toMatchObject({ n: 1 })
  })

  it('the need state is per card: moving the card to another key does not re-fire the same need', async () => {
    expect((await call('PUT', `/api/auth/agent-keys/${cosKey.id}/webhook`, {
      body: { url: 'https://cos-legacy.example.com/wake', secret: 'cos-legacy-sender-key-0123', events: ['needs_agent'] },
    })).status).toBe(200)
    const id = seedCard(cosKey.id, 'Filed by the old CoS key')
    upd(id, `status = 'review', ai_review_verdict = 'pass'`)
    await tick()
    expect(bodies(sentTo('cos-legacy.example.com')).map(b => b.need.kind)).toEqual(['review'])
    // Re-attributed to the shared key, same need → no second wake anywhere.
    upd(id, `agent_key_id = ${shared.id}, last_session_summary = 'moved'`)
    await tick()
    expect(allNeedWakes()).toHaveLength(1)
    // A NEW need (escalation) wakes once, on the key that now owns the card.
    upd(id, `needs_secret = '[{"name":"EXAMPLE5_API_KEY","reason":"x"}]'`)
    await tick()
    expect(allNeedWakes()).toHaveLength(2)
    expect(bodies(sentTo(SHARED_HOST)).map(b => b.need.kind)).toEqual(['needs_secret'])
  })

  it('never discloses a card outside the key\'s workspace scope', async () => {
    // (a) the key's own allowlist: restricted to operationkit, card moved to example.
    getDb().prepare(`UPDATE agent_api_keys SET workspaces = ? WHERE id = ?`).run(JSON.stringify(['operationkit']), shared.id)
    try {
      const inScope = sharedCard('In scope', 'grok-ops')
      const moved = sharedCard('Moved out of scope', 'grok-ops')
      upd(moved, `workspace = 'example'`)
      upd(inScope, `status = 'review', ai_review_verdict = 'fail'`)
      upd(moved, `status = 'review', ai_review_verdict = 'fail'`)
      await tick()
      expect(bodies(sentTo(SHARED_HOST)).map(b => b.objective.id)).toEqual([inScope])
      expect(JSON.stringify(bodies(sent))).not.toContain('Moved out of scope')
    } finally {
      getDb().prepare(`UPDATE agent_api_keys SET workspaces = NULL WHERE id = ?`).run(shared.id)
    }
  })

  it('never discloses a card in a workspace the key OWNER cannot see (member-owned key)', async () => {
    const db = getDb()
    db.prepare(`INSERT OR IGNORE INTO users (id, username, password_hash, role) VALUES (7, 'member7', 'x', 'member')`).run()
    db.prepare(`INSERT OR IGNORE INTO user_workspaces (user_id, workspace, role) VALUES (7, 'operationkit', 'member')`).run()
    const k = db.prepare(`INSERT INTO agent_api_keys (user_id, label, key_hash, last4, scopes) VALUES (7, 'Member bot', 'h-member7', 'mmmm', '[]')`).run()
    const memberKeyId = Number(k.lastInsertRowid)
    db.prepare(`INSERT INTO agent_key_webhooks (key_id, user_id, url, header_name, header_prefix, events, enabled) VALUES (?, 7, 'https://member.example.com/wake', 'Authorization', 'Bearer ', ?, 1)`)
      .run(memberKeyId, JSON.stringify(['needs_agent', 'entered_review']))
    const { setSecret } = await import('./secrets-store.js')
    setSecret({ scope: { scopeType: 'user', userId: 7 }, key: wh.secretNameFor(memberKeyId), value: 'member-sender-key-0123456789', actorUserId: 7, via: 'test' })

    const visible = seedCard(memberKeyId, 'Member can see this')
    const hidden = seedCard(memberKeyId, 'Member cannot see this')
    upd(hidden, `workspace = 'example'`) // owner 7 is not a member of example
    for (const id of [visible, hidden]) upd(id, `status = 'review', ai_review_verdict = 'fail'`)
    await tick()
    const got = bodies(sentTo('member.example.com'))
    expect(new Set(got.map(b => b.objective.id))).toEqual(new Set([visible]))
    expect(JSON.stringify(got)).not.toContain('Member cannot see this')
  })

  it('a revoked shared key or a disabled shared webhook sends nothing', async () => {
    getDb().prepare('UPDATE agent_key_webhooks SET enabled = 0 WHERE key_id = ?').run(shared.id)
    const id = sharedCard('disabled', 'grok-ops')
    upd(id, `status = 'review', ai_review_verdict = 'fail'`)
    await tick()
    expect(sentTo(SHARED_HOST)).toHaveLength(0)
    getDb().prepare('UPDATE agent_key_webhooks SET enabled = 1 WHERE key_id = ?').run(shared.id)
  })
})

describe('existing events are unaffected (obj 900270)', () => {
  it('a status-event webhook still gets its moves, now with owner_bot alongside', async () => {
    const id = seedCard(keyA.id)
    getDb().prepare('UPDATE objectives SET owner_bot = ? WHERE id = ?').run('grok-a', id)
    setStatus(id, 'working')
    setStatus(id, 'review')
    await tick()
    const got = bodies(sentTo('a.example.com'))
    expect(got.map(b => b.event)).toEqual(['working', 'entered_review'])
    expect(got.every(b => b.owner_bot === 'grok-a')).toBe(true)
    expect(got.map(b => b.event_id)).toEqual(got.map(b => expect.stringMatching(new RegExp(`^cc_evt_\\d+_k${keyA.id}$`))))
  })
})

describe('key 4 compatibility: the live CoS needs_agent webhook keeps working (obj 900270)', () => {
  const LEGACY_HOST = 'cos-key4.example.com'
  const LEGACY_SECRET = 'cos-key4-sender-key-0123456789'
  let k4: { id: number; token: string }

  beforeAll(async () => {
    k4 = await mintKey('Grok: General')
  })

  beforeEach(() => {
    // Exactly the row shape the previous build (60b589561995) stored for key 4.
    getDb().prepare(
      `INSERT INTO agent_key_webhooks (key_id, user_id, url, header_name, header_prefix, events, enabled)
       VALUES (?, ?, ?, 'Authorization', 'Bearer ', '["needs_agent"]', 1)`,
    ).run(k4.id, USER_ID, `https://${LEGACY_HOST}/routines/card-wake`)
  })

  it('config reads back unchanged and survives a re-save that omits events/secret', async () => {
    // The sender key was stored on the old build; store one the same way.
    const { setSecret } = await import('./secrets-store.js')
    setSecret({ scope: { scopeType: 'user', userId: USER_ID }, key: wh.secretNameFor(k4.id), value: LEGACY_SECRET, actorUserId: USER_ID, via: 'test' })
    const g = await call('GET', `/api/auth/agent-keys/${k4.id}/webhook`)
    expect(g.json.webhook).toMatchObject({ events: ['needs_agent'], header_name: 'Authorization', header_prefix: 'Bearer ', enabled: true, has_secret: true })
    const re = await call('PUT', `/api/auth/agent-keys/${k4.id}/webhook`, { body: { enabled: true } })
    expect(re.status).toBe(200)
    expect(re.json.webhook.events).toEqual(['needs_agent'])
  })

  it('wakes exactly as before: same event id format, auth header, headers and summary; owner_bot added as null', async () => {
    const { setSecret } = await import('./secrets-store.js')
    setSecret({ scope: { scopeType: 'user', userId: USER_ID }, key: wh.secretNameFor(k4.id), value: LEGACY_SECRET, actorUserId: USER_ID, via: 'test' })
    const id = seedCard(k4.id, 'Old CoS card')
    getDb().prepare('UPDATE objectives SET agent_key_label = ? WHERE id = ?').run('Grok: General', id)
    getDb().prepare(`UPDATE objectives SET status = 'review', ai_review_verdict = 'pass' WHERE id = ?`).run(id)
    await tick()
    const list = sentTo(LEGACY_HOST)
    expect(list).toHaveLength(1)
    expect(list[0].headers).toMatchObject({ Authorization: `Bearer ${LEGACY_SECRET}`, 'X-CC-Event': 'needs_agent', 'User-Agent': 'CommandCenter-Webhooks/1' })
    const b = JSON.parse(list[0].body)
    expect(b.event_id).toMatch(new RegExp(`^cc_need_\\d+_k${k4.id}$`))
    expect(list[0].headers['X-CC-Event-Id']).toBe(b.event_id)
    // obj 900309: the card is UNOWNED (owner_bot null), so the summary must say so
    // rather than naming the agent key. The key is a shared connection — its label is
    // who SENT the card, not who owns it, and spelling it as the owner made a filed-by-X
    // card indistinguishable from an owned-by-X card to a routing bot. owner_bot (null
    // here) stays the machine-readable truth; the prose now agrees with it.
    expect(b.summary).toBe(`Card #${id} (operationkit) needs an agent (unowned — routed to the General): ${b.need.why}. Status: review · AI review pass.`)
    expect(b.owner_bot).toBeNull()
    expect(Object.keys(b).sort()).toEqual(
      ['agent_key', 'event', 'event_id', 'need', 'objective', 'occurred_at', 'owner_bot', 'sent_at', 'status_summary', 'summary'],
    )
  })

  it('a need key 4 was already woken for (old per-key state) is carried over once, not re-fired after deploy', () => {
    const db = getDb()
    const id = seedCard(k4.id, 'Woken before the deploy')
    db.prepare(`UPDATE objectives SET status = 'review' WHERE id = ?`).run(id)
    db.prepare(`DELETE FROM settings WHERE key = ?`).run(CARD_NEED_MIGRATED_SETTING)
    db.prepare(`INSERT INTO agent_webhook_need_state (key_id, objective_id, kind) VALUES (?, ?, 'review')`).run(k4.id, id)
    initAgentWebhooksSchema(db)
    expect(db.prepare('SELECT kind, key_id FROM agent_webhook_card_need_state WHERE objective_id = ?').get(id)).toEqual({ kind: 'review', key_id: k4.id })
    // Once only: a stale per-key row never re-arms a cleared card state later.
    db.prepare('DELETE FROM agent_webhook_card_need_state WHERE objective_id = ?').run(id)
    initAgentWebhooksSchema(db)
    expect(db.prepare('SELECT 1 FROM agent_webhook_card_need_state WHERE objective_id = ?').get(id)).toBeUndefined()
  })
})

// ── obj 900270 / #900244: DNS-based SSRF guard at send time ──────────────────

describe('send-time SSRF guard (#900244)', () => {
  it('legit public host: resolved once per send and the transport is pinned to the checked address', async () => {
    const id = seedCard(keyA.id)
    setStatus(id, 'working')
    await tick()
    expect(sentTo('a.example.com')).toHaveLength(1)
    expect(sent[0].address).toBe(PUBLIC_IP)
    expect(dnsCalls).toEqual(['a.example.com'])
  })

  for (const [label, answers] of [
    ['loopback', ['127.0.0.1']],
    ['private', ['10.0.0.7']],
    ['link-local / metadata', ['169.254.169.254']],
    ['CGNAT', ['100.64.1.1']],
    ['IPv6 loopback', ['::1']],
    ['IPv4-mapped IPv6', ['::ffff:127.0.0.1']],
    ['mixed public + private answers', [PUBLIC_IP, '192.168.0.10']],
  ] as const) {
    it(`refuses a saved host that now resolves to ${label}: no request, no key sent, retried later`, async () => {
      dnsTable['a.example.com'] = [...answers]
      const id = seedCard(keyA.id)
      setStatus(id, 'working')
      await tick()
      expect(sentTo('a.example.com')).toHaveLength(0)
      const row = getDb().prepare(`SELECT status, attempts, last_error FROM agent_webhook_deliveries WHERE objective_id = ?`).get(id) as Loose
      expect(row).toMatchObject({ status: 'pending', attempts: 1 })
      expect(row.last_error).toMatch(/^destination refused: /)
      expect(row.last_error).not.toContain(SECRET_A)
    })
  }

  it('DNS rebinding: public at save time, private at send time → refused; public again → delivered', async () => {
    const t0 = new Date()
    dnsTable['a.example.com'] = ['127.0.0.1']
    const id = seedCard(keyA.id)
    setStatus(id, 'working')
    await tick(t0)
    expect(sent).toHaveLength(0)
    dnsTable['a.example.com'] = [PUBLIC_IP]
    await tick(new Date(t0.getTime() + wh.RETRY_BACKOFF_MS[0] + 1000))
    expect(sentTo('a.example.com')).toHaveLength(1)
    expect(sent[0].address).toBe(PUBLIC_IP)
  })

  it('redirects are refused: a 3xx is a failed attempt and the Location is never followed', async () => {
    responder = () => 302
    const id = seedCard(keyA.id)
    setStatus(id, 'working')
    await tick()
    expect(sent).toHaveLength(1)
    const row = getDb().prepare(`SELECT status, last_status_code, last_error FROM agent_webhook_deliveries WHERE objective_id = ?`).get(id)
    expect(row).toMatchObject({ status: 'pending', last_status_code: 302, last_error: 'HTTP 302' })
    expect(wh.validateWebhookUrl('https://a.example.com/x')).toMatchObject({ ok: true }) // save-time rules unchanged
  })

  it('Send test event goes through the same guard', async () => {
    dnsTable['a.example.com'] = ['169.254.169.254']
    const r = await call('POST', `/api/auth/agent-keys/${keyA.id}/webhook/test`)
    expect(r.status).toBe(200)
    expect(r.json).toMatchObject({ delivered: false, status_code: null })
    expect(r.json.error).toMatch(/^destination refused: /)
    expect(sent).toHaveLength(0)
  })
})
