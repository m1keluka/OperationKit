import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { Server } from 'http'

// GET /api/admin/seats end-to-end with per-seat usage (fake data only): the
// `usage` block on each seat, the response-level `provisioning` hint, and — the
// security contract — no credential value, key name or machine path anywhere in
// the response.

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-seat-usage-'))
process.env.CC_ACCOUNT_ROUTER_STATE_FILE = path.join(TMP, 'state.json')
process.env.CC_RATE_LIMIT_LOG = path.join(TMP, 'rate-limit.jsonl')
process.env.CC_SEAT_HOME_ROOT = path.join(TMP, 'seats')
process.env.SECRETS_MASTER_KEY = Buffer.alloc(32, 9).toString('base64')
process.env.DB_PATH = path.join(TMP, 'test.db')
process.env.CC_LEGACY_CODEX_HOME = path.join(TMP, 'no-legacy-codex')
process.env.GROK_HOME_DIR = path.join(TMP, 'no-legacy-grok')
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-seat-usage-xxxx'

const TOKEN_1 = 'fake-setup-token-for-usage-tests-000000000000-aaa1'
const TOKEN_2 = 'fake-setup-token-for-usage-tests-111111111111-bbb2'

vi.mock('../ws/index.js', () => ({ broadcast: vi.fn() }))

const { initDb, getDb } = await import('../db/index.js')
const router = await import('./account-router.js')
const express = (await import('express')).default
const cookieParser = (await import('cookie-parser')).default
const jwt = (await import('jsonwebtoken')).default
const { requireAuth, requireAdmin } = await import('../middleware/auth.js')
const seatsRouter = (await import('../routes/admin-seats.js')).default

let server: Server
let baseUrl = ''
const adminJwt = () => jwt.sign({ id: 1, username: 'admin', role: 'admin' }, process.env.JWT_SECRET as string, { expiresIn: '1h' })

async function call(method: string, url: string, body?: unknown): Promise<{ status: number; text: string; json: any }> {
  const res = await fetch(`${baseUrl}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminJwt()}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  return { status: res.status, text, json: text ? JSON.parse(text) : null }
}

function allKeys(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) v.forEach(x => allKeys(x, out))
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.push(k); allKeys(x, out) }
  return out
}

beforeAll(async () => {
  initDb()
  getDb().prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (1, 'admin', 'x', 'admin')`).run()
  getDb().prepare(
    `INSERT INTO objectives (id, title, description, agent_context, workspace, status, create_pr) VALUES (4242, 'usage', '', 'cto', 'main', 'done', 0)`,
  ).run()
  for (const s of [...router.listSeatRecords()]) router.removeSeat(s.id)
  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  app.use('/api/admin', requireAuth, requireAdmin, seatsRouter)
  await new Promise<void>(r => { server = app.listen(0, '127.0.0.1', () => r()) })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no address')
  baseUrl = `http://127.0.0.1:${addr.port}`
})

afterAll(async () => {
  await new Promise<void>(r => server.close(() => r()))
  fs.rmSync(TMP, { recursive: true, force: true })
})

describe('GET /api/admin/seats — per-seat usage', () => {
  it('returns a usage block per seat and a provisioning hint, with no credential leak', async () => {
    const busy = (await call('POST', '/api/admin/seats', { kind: 'claude', label: 'Busy', credential: TOKEN_1 })).json.seat.id as string
    const idle = (await call('POST', '/api/admin/seats', { kind: 'claude', label: 'Idle', credential: TOKEN_2 })).json.seat.id as string

    const now = Date.now()
    const ins = getDb().prepare(
      `INSERT INTO session_intel (objective_id, session_id, account_id, started_at, ended_at, total_tokens) VALUES (4242, ?, ?, ?, ?, ?)`,
    )
    const at = (ms: number) => new Date(now - ms).toISOString()
    ins.run('cc-4242-a', busy, at(3 * 3600e3), at(2 * 3600e3), 1200)
    ins.run('cc-4242-b', busy, at(4 * 86400e3), at(3 * 86400e3), 800)
    getDb().prepare(`INSERT INTO session_runtime (session_id, account_id, updated_at) VALUES ('cc-4242-c', ?, datetime('now', '-1 hour'))`).run(busy)

    // Weekly limit hit 10h ago and still cooling: limited 10h of the last 24h (> 25%).
    vi.useFakeTimers({ now: now - 10 * 3600e3, toFake: ['Date'] })
    router.recordRateLimit(busy, new Date(now + 2 * 3600e3), "You've hit your weekly limit · resets Nov 3, 9am")
    vi.useRealTimers()

    const res = await call('GET', '/api/admin/seats')
    expect(res.status).toBe(200)
    const byId = Object.fromEntries(res.json.seats.map((s: { id: string }) => [s.id, s]))

    expect(Object.keys(byId[busy].usage).sort()).toEqual(
      ['limit_reset_at', 'limit_state', 'limited_pct_24h', 'sessions_24h', 'sessions_7d', 'tokens_24h', 'tokens_7d'],
    )
    expect(byId[busy].usage).toMatchObject({
      tokens_24h: 1200, tokens_7d: 2000, sessions_24h: 2, sessions_7d: 3, limit_state: 'weekly',
    })
    expect(Date.parse(byId[busy].usage.limit_reset_at)).toBe(now + 2 * 3600e3)
    expect(byId[busy].usage.limited_pct_24h).toBeGreaterThan(41)
    expect(byId[busy].usage.limited_pct_24h).toBeLessThan(42.5)
    expect(byId[idle].usage).toMatchObject({
      tokens_24h: 0, tokens_7d: 0, sessions_24h: 0, sessions_7d: 0, limit_state: 'healthy', limit_reset_at: null, limited_pct_24h: 0,
    })

    expect(res.json.provisioning).toMatchObject({ verdict: 'mixed', limited_seats: 1, idle_seats: 1 })
    expect(res.json.provisioning.message).toMatch(/under-provisioned/)

    // Mutation responses carry the same block (the screen upserts them).
    const patched = await call('PATCH', `/api/admin/seats/${busy}`, { priority: 3 })
    expect(patched.json.seat.usage).toMatchObject({ tokens_24h: 1200, limit_state: 'weekly' })

    // No secret-shaped field or value anywhere in the response.
    const keys = allKeys(res.json)
    const secretShaped = keys.filter(k => /secret|password|passw|credentialRef|homeDir|home_dir|path|oauth|api_?key|access_?token|refresh|^token$|^value$/i.test(k))
    expect(secretShaped).toEqual([])
    for (const haystack of [res.text, patched.text]) {
      expect(haystack).not.toContain(TOKEN_1)
      expect(haystack).not.toContain(TOKEN_2)
      expect(haystack).not.toContain(TMP)
      expect(haystack).not.toMatch(/CC_SEAT_|sk-ant-|\/cc-accounts|\.claude|triggerMessage/)
    }
  })
})
