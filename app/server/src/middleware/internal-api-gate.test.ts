// Regression suite for the X-Forwarded-For spoof on /api/internal (obj 900027).
//
// The bug: index.ts set `trust proxy: true`, and lib/is-localhost.ts read
// `req.ip` — which Express derives from the X-Forwarded-For chain under that
// setting. Any remote client could therefore send `X-Forwarded-For: 127.0.0.1`
// and satisfy the "localhost only" gate on /api/internal/pr-health,
// /api/internal/objectives and /api/internal/reviews/:id/criteria with no
// credentials whatsoever (confirmed live against the host: 200 on all three).
//
// What is asserted here:
//   1. A spoofed XFF from a NON-local socket is rejected (the reported attack).
//   2. A spoofed XFF from a LOOPBACK socket is rejected too — Caddy/cloudflared
//      terminate on the host and dial localhost:3002, so externally-proxied
//      traffic also arrives on a loopback peer. Header presence is what
//      distinguishes it from a genuine on-box caller.
//   3. Real local callers (cron, the poller, in-container curl) still get 200.
//   4. X-Internal-Secret still admits an off-box caller.
//   5. The INTERNAL_API_REQUIRE_SECRET=1 ratchet.

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import express from 'express'
import http from 'http'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import type { Request } from 'express'
import { internalApiGate } from './internal-api-gate.js'
import { getInternalApiSecret } from './internal-secret.js'
import {
  isLocalhost,
  hasForwardingHeaders,
  isTrustedPeerAddress,
  socketRemoteAddress,
} from '../lib/is-localhost.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))

// ── Unit level: isLocalhost must ignore forwarded headers entirely ──────────

/** Minimal Request stand-in: the two fields isLocalhost is allowed to read. */
function fakeReq(peer: string, headers: Record<string, string> = {}, ip?: string): Request {
  return {
    socket: { remoteAddress: peer },
    headers,
    // `ip` is deliberately populated in some cases: the whole point is that
    // isLocalhost must NOT consult it.
    ip: ip ?? peer,
    header(name: string) { return headers[name.toLowerCase()] },
  } as unknown as Request
}

describe('isLocalhost (socket-based)', () => {
  it('accepts a genuine loopback caller with no forwarded headers', () => {
    expect(isLocalhost(fakeReq('127.0.0.1'))).toBe(true)
    expect(isLocalhost(fakeReq('::1'))).toBe(true)
    expect(isLocalhost(fakeReq('::ffff:127.0.0.1'))).toBe(true)
  })

  it('accepts the Docker bridge gateway (in-container sessions reach us there)', () => {
    expect(isLocalhost(fakeReq('172.17.0.1'))).toBe(true)
    expect(isLocalhost(fakeReq('172.18.0.1'))).toBe(true)
  })

  it('REJECTS a remote socket spoofing X-Forwarded-For: 127.0.0.1', () => {
    const req = fakeReq('203.0.113.9', { 'x-forwarded-for': '127.0.0.1' }, '127.0.0.1')
    expect(req.ip).toBe('127.0.0.1')          // what the old code trusted
    expect(isLocalhost(req)).toBe(false)      // what we do now
  })

  it('REJECTS a loopback socket that carries X-Forwarded-For (proxied traffic)', () => {
    // Caddy/cloudflared dial localhost:3002, so the peer is loopback. The
    // stamped header is the only thing separating this from an on-box caller.
    expect(isLocalhost(fakeReq('127.0.0.1', { 'x-forwarded-for': '203.0.113.9' }))).toBe(false)
    expect(isLocalhost(fakeReq('127.0.0.1', { 'x-forwarded-for': '127.0.0.1' }))).toBe(false)
  })

  it('REJECTS every other forwarding header on a loopback socket', () => {
    for (const h of ['x-forwarded-proto', 'x-forwarded-host', 'x-real-ip', 'forwarded', 'cf-connecting-ip', 'cf-ray', 'true-client-ip']) {
      expect(isLocalhost(fakeReq('127.0.0.1', { [h]: 'x' })), h).toBe(false)
    }
  })

  it('ignores req.ip entirely — a loopback req.ip cannot rescue a remote socket', () => {
    expect(isLocalhost(fakeReq('203.0.113.9', {}, '127.0.0.1'))).toBe(false)
  })

  it('rejects near-miss addresses that are not loopback or the bridge gateway', () => {
    for (const a of ['172.17.0.2', '1127.0.0.1', '10.0.0.1', '192.168.1.5', '0.0.0.0', '']) {
      expect(isTrustedPeerAddress(a), a).toBe(false)
    }
    expect(isTrustedPeerAddress('127.0.0.1')).toBe(true)
  })

  it('helpers behave', () => {
    expect(socketRemoteAddress(fakeReq('::ffff:10.1.2.3'))).toBe('10.1.2.3')
    expect(hasForwardingHeaders(fakeReq('127.0.0.1', {}))).toBe(false)
    expect(hasForwardingHeaders(fakeReq('127.0.0.1', { 'x-forwarded-for': '' }))).toBe(false)
    expect(hasForwardingHeaders(fakeReq('127.0.0.1', { 'x-forwarded-for': '1.2.3.4' }))).toBe(true)
  })
})

// ── Integration: a real HTTP server behind the gate ─────────────────────────
//
// The test client can only connect over loopback, so the TCP peer is simulated
// with an `x-test-peer` header consumed by a shim mounted BEFORE the gate. The
// shim overwrites req.socket.remoteAddress — i.e. it rewrites the one input the
// gate is allowed to trust. Everything downstream is the production code path.

let server: http.Server
let baseUrl: string

beforeAll(async () => {
  const app = express()
  // Production setting after this change (index.ts): an allowlist, not `true`.
  app.set('trust proxy', 'loopback, uniquelocal')
  app.use((req, _res, next) => {
    const peer = req.header('x-test-peer')
    if (peer) Object.defineProperty(req.socket, 'remoteAddress', { value: peer, configurable: true })
    next()
  })
  app.use('/api/internal', internalApiGate)
  app.get('/api/internal/pr-health', (_req, res) => { res.json({ ok: true }) })
  app.get('/api/internal/objectives', (_req, res) => { res.json([]) })
  app.get('/api/internal/reviews/1/criteria', (_req, res) => { res.json({ criteria: [] }) })

  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => resolve()) })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no address')
  baseUrl = `http://127.0.0.1:${addr.port}`
})

afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())) })

afterEach(() => { delete process.env.INTERNAL_API_REQUIRE_SECRET })

/** The three routes the live exploit reached unauthenticated. */
const EXPLOITED = ['/api/internal/pr-health', '/api/internal/objectives', '/api/internal/reviews/1/criteria']

const get = (p: string, headers: Record<string, string> = {}) => fetch(baseUrl + p, { headers })

describe('internalApiGate', () => {
  it('rejects a remote caller spoofing X-Forwarded-For: 127.0.0.1 on every exploited route', async () => {
    for (const route of EXPLOITED) {
      const res = await get(route, { 'x-test-peer': '203.0.113.9', 'x-forwarded-for': '127.0.0.1' })
      expect(res.status, route).toBe(403)
    }
  })

  it('rejects every spoof variant a client controls', async () => {
    const variants: Record<string, string>[] = [
      { 'x-forwarded-for': '127.0.0.1' },
      { 'x-forwarded-for': '127.0.0.1, 203.0.113.9' },
      { 'x-forwarded-for': '203.0.113.9, 127.0.0.1' },
      { 'x-forwarded-for': '::1' },
      { 'x-forwarded-for': '172.17.0.1' },
      { 'x-real-ip': '127.0.0.1' },
      { forwarded: 'for=127.0.0.1' },
      { 'cf-connecting-ip': '127.0.0.1' },
    ]
    for (const v of variants) {
      const res = await get('/api/internal/objectives', { 'x-test-peer': '203.0.113.9', ...v })
      expect(res.status, JSON.stringify(v)).toBe(403)
    }
  })

  it('rejects a proxied request even though its TCP peer is loopback', async () => {
    // This is the Caddy/cloudflared shape: peer 127.0.0.1, XFF stamped by the proxy.
    const res = await get('/api/internal/objectives', { 'x-forwarded-for': '203.0.113.9' })
    expect(res.status).toBe(403)
  })

  it('rejects a remote caller with no headers at all', async () => {
    const res = await get('/api/internal/objectives', { 'x-test-peer': '203.0.113.9' })
    expect(res.status).toBe(403)
  })

  it('still admits genuine local callers (cron, poller, in-container curl)', async () => {
    for (const route of EXPLOITED) {
      const res = await get(route, { 'x-test-peer': '127.0.0.1' })
      expect(res.status, route).toBe(200)
    }
  })

  it('still admits the Docker bridge gateway', async () => {
    const res = await get('/api/internal/objectives', { 'x-test-peer': '172.17.0.1' })
    expect(res.status).toBe(200)
  })

  it('admits an off-box caller presenting a valid X-Internal-Secret', async () => {
    const res = await get('/api/internal/objectives', {
      'x-test-peer': '203.0.113.9',
      'x-internal-secret': getInternalApiSecret(),
    })
    expect(res.status).toBe(200)
  })

  it('rejects a wrong or empty X-Internal-Secret from off-box', async () => {
    for (const secret of ['wrong', '', getInternalApiSecret() + 'x']) {
      const res = await get('/api/internal/objectives', { 'x-test-peer': '203.0.113.9', 'x-internal-secret': secret })
      expect(res.status, secret).toBe(403)
    }
  })

  it('INTERNAL_API_REQUIRE_SECRET=1 makes the secret mandatory for local callers too', async () => {
    process.env.INTERNAL_API_REQUIRE_SECRET = '1'
    const bare = await get('/api/internal/objectives', { 'x-test-peer': '127.0.0.1' })
    expect(bare.status).toBe(403)
    const withSecret = await get('/api/internal/objectives', {
      'x-test-peer': '127.0.0.1',
      'x-internal-secret': getInternalApiSecret(),
    })
    expect(withSecret.status).toBe(200)
  })
})

// ── Structural guards on index.ts ───────────────────────────────────────────

describe('index.ts wiring', () => {
  const source = fs.readFileSync(path.join(HERE, '..', 'index.ts'), 'utf8')

  it('does not set `trust proxy` to true (that makes req.ip client-controlled)', () => {
    expect(source).not.toMatch(/app\.set\(\s*['"]trust proxy['"]\s*,\s*true\s*\)/)
    expect(source).toMatch(/app\.set\(\s*['"]trust proxy['"]/)
  })

  it('mounts internalApiGate ahead of EVERY /api/internal router', () => {
    const lines = source.split('\n')
    const gateIdx = lines.findIndex(l => l.includes("app.use('/api/internal', internalApiGate)"))
    expect(gateIdx, 'internalApiGate must be mounted in index.ts').toBeGreaterThan(-1)
    const mounts = lines
      .map((l, i) => ({ l, i }))
      .filter(({ l, i }) => i !== gateIdx && /app\.use\(\s*['"]\/api\/internal/.test(l))
    expect(mounts.length).toBeGreaterThan(5)   // sanity: we actually found the mounts
    for (const { l, i } of mounts) expect(i, l.trim()).toBeGreaterThan(gateIdx)
  })

  it('has no remaining in-file copy of the old req.ip-based localhost check', () => {
    expect(source).not.toMatch(/req\.ip\s*\|\|\s*req\.socket\.remoteAddress/)
  })
})
