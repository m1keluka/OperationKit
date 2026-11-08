/**
 * obj 900321 (C6 / C17) — internal BOARD READS require an authenticated
 * principal, and a session principal is confined to its own card's workspace.
 *
 * Synthetic fixtures only: a throwaway SQLite DB under the test tmpdir with two
 * made-up workspaces (`ws-alpha`, `ws-beta`) and made-up cards. Nothing here
 * reads the real board, any real client's data, or any production surface — the
 * audit's live findings are treated as HYPOTHESES and reproduced here.
 *
 * Covered, in the order the card asks for them:
 *   1. POSITIVE — a session token for its OWN workspace reads list / detail /
 *      siblings / output / strategies and gets exactly its own rows.
 *   2. NEGATIVE — another workspace's card is 403 on every read surface, and
 *      never appears in a list or sibling response.
 *   3. FAIL CLOSED — forged, tampered, expired, deleted-card and
 *      revoked-membership tokens are refused and do NOT fall back to the
 *      localhost allowance.
 *   4. SERVER COMPAT — X-Internal-Secret stays board-wide (explicit
 *      least-privilege path for health/operational callers), and a bare on-box
 *      caller keeps working until the ratchet is turned on.
 *   5. SCOPE SPOOF — ?workspace=<other> from a scoped session is a loud 403,
 *      never a silently-rewritten 200.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-board-iso-')))
process.env.DB_PATH = path.join(TMP, 'cc.db')
process.env.JWT_SECRET = 'test-secret-board-isolation-900321'
process.env.INTERNAL_API_SECRET = 'test-internal-secret-900321'
delete process.env.CC_INTERNAL_BOARD_REQUIRE_PRINCIPAL
delete process.env.INTERNAL_TRUSTED_PEER_CIDRS

const { initDb, getDb } = await import('../db/index.js')
const { mintSessionToken } = await import('../lib/session-trust.js')
const { registerInternalHermesRoutes } = await import('./internal-hermes.js')
const { internalApiGate } = await import('../middleware/internal-api-gate.js')
const { resolveBoardPrincipal, isSandboxPeer, boardPrincipalRequired } = await import(
  '../middleware/internal-board-auth.js'
)

let server: http.Server
let baseUrl: string

let alphaCard = 0
let alphaSibling = 0
let betaCard = 0
let betaSibling = 0
let parentAlpha = 0
let parentBeta = 0
let alphaStrategy = 0
let betaStrategy = 0
let avaId = 0
let bobId = 0
let adminId = 0
let orphanUserCard = 0

let alphaToken = ''
let betaToken = ''
let adminAlphaToken = ''

async function get(p: string, headers: Record<string, string> = {}) {
  const res = await fetch(`${baseUrl}${p}`, { headers })
  let body: unknown = null
  try {
    body = await res.json()
  } catch {
    body = null
  }
  return { status: res.status, body, headers: res.headers }
}

const tok = (objectiveId: number, workspace: string, actingUserId: number | null) =>
  ({ 'X-CC-Session-Token': mintSessionToken({ objectiveId, workspace, actingUserId }) })

beforeAll(async () => {
  initDb()
  const db = getDb()

  adminId = Number(
    db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run('iso-admin', 'x', 'admin')
      .lastInsertRowid,
  )
  avaId = Number(
    db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run('iso-ava', 'x', 'member')
      .lastInsertRowid,
  )
  bobId = Number(
    db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run('iso-bob', 'x', 'member')
      .lastInsertRowid,
  )
  db.prepare("INSERT INTO user_workspaces (user_id, workspace, role) VALUES (?, 'ws-alpha', 'member')").run(avaId)
  db.prepare("INSERT INTO user_workspaces (user_id, workspace, role) VALUES (?, 'ws-beta', 'member')").run(bobId)

  const ins = db.prepare(
    `INSERT INTO objectives (title, description, workspace, agent_context, parent_id, is_strategy, strategy_id)
     VALUES (?, ?, ?, 'general', ?, ?, ?)`,
  )
  alphaStrategy = Number(ins.run('alpha strategy', 'synthetic', 'ws-alpha', null, 1, null).lastInsertRowid)
  betaStrategy = Number(ins.run('beta strategy', 'synthetic', 'ws-beta', null, 1, null).lastInsertRowid)
  parentAlpha = Number(ins.run('alpha parent', 'synthetic', 'ws-alpha', null, 0, alphaStrategy).lastInsertRowid)
  parentBeta = Number(ins.run('beta parent', 'synthetic', 'ws-beta', null, 0, betaStrategy).lastInsertRowid)
  alphaCard = Number(ins.run('alpha card', 'ALPHA-ONLY-SECRET', 'ws-alpha', parentAlpha, 0, alphaStrategy).lastInsertRowid)
  alphaSibling = Number(ins.run('alpha sibling', 'synthetic', 'ws-alpha', parentAlpha, 0, alphaStrategy).lastInsertRowid)
  betaCard = Number(ins.run('beta card', 'BETA-ONLY-SECRET', 'ws-beta', parentBeta, 0, betaStrategy).lastInsertRowid)
  betaSibling = Number(ins.run('beta sibling', 'synthetic', 'ws-beta', parentBeta, 0, betaStrategy).lastInsertRowid)
  // A beta card parented under the ALPHA parent: a cross-workspace sibling.
  // Scoped sibling reads must not surface it.
  db.prepare(
    `INSERT INTO objectives (title, description, workspace, agent_context, parent_id) VALUES (?, ?, ?, 'general', ?)`,
  ).run('beta card under alpha parent', 'BETA-ONLY-SECRET', 'ws-beta', parentAlpha)
  orphanUserCard = Number(ins.run('card of a user with no membership', 'synthetic', 'ws-alpha', null, 0, null).lastInsertRowid)

  alphaToken = mintSessionToken({ objectiveId: alphaCard, workspace: 'ws-alpha', actingUserId: avaId })
  betaToken = mintSessionToken({ objectiveId: betaCard, workspace: 'ws-beta', actingUserId: bobId })
  adminAlphaToken = mintSessionToken({ objectiveId: alphaCard, workspace: 'ws-alpha', actingUserId: adminId })

  const app = express()
  app.use(express.json())
  app.use('/api/internal', internalApiGate)
  const router = express.Router()
  registerInternalHermesRoutes(router)
  app.use('/api/internal', router)
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`
      resolve()
    })
  })
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  fs.rmSync(TMP, { recursive: true, force: true })
})

describe('1. authorized same-workspace reads (positive path)', () => {
  it('lists ONLY its own workspace rows', async () => {
    const r = await get('/api/internal/objectives', { 'X-CC-Session-Token': alphaToken })
    expect(r.status).toBe(200)
    const rows = r.body as Array<{ id: number; workspace: string }>
    expect(rows.length).toBeGreaterThan(0)
    expect([...new Set(rows.map((x) => x.workspace))]).toEqual(['ws-alpha'])
    expect(rows.map((x) => x.id)).toContain(alphaCard)
    expect(rows.map((x) => x.id)).not.toContain(betaCard)
    expect(r.headers.get('X-Board-Principal')).toBe('session')
    expect(r.headers.get('X-Board-Workspace')).toBe('ws-alpha')
  })

  it('reads its own card detail in full', async () => {
    const r = await get(`/api/internal/objectives/${alphaCard}`, { 'X-CC-Session-Token': alphaToken })
    expect(r.status).toBe(200)
    expect((r.body as { description: string }).description).toBe('ALPHA-ONLY-SECRET')
  })

  it('reads its own siblings, its own strategies, and its own output', async () => {
    const sib = await get(`/api/internal/objectives/${alphaCard}/siblings`, { 'X-CC-Session-Token': alphaToken })
    expect(sib.status).toBe(200)
    expect((sib.body as { siblings: Array<{ id: number }> }).siblings.map((s) => s.id)).toContain(alphaSibling)

    const strat = await get('/api/internal/strategies', { 'X-CC-Session-Token': alphaToken })
    expect(strat.status).toBe(200)
    expect((strat.body as Array<{ id: number }>).map((s) => s.id)).toEqual([alphaStrategy])

    const out = await get(`/api/internal/objectives/${alphaCard}/output`, { 'X-CC-Session-Token': alphaToken })
    expect(out.status).toBe(200)
  })

  it('a card whose acting user is an ADMIN is still confined to the card workspace', async () => {
    const r = await get('/api/internal/objectives', { 'X-CC-Session-Token': adminAlphaToken })
    expect(r.status).toBe(200)
    expect([...new Set((r.body as Array<{ workspace: string }>).map((x) => x.workspace))]).toEqual(['ws-alpha'])
  })
})

describe('2. another workspace is never reachable and never appears', () => {
  it('403s the other workspace card detail', async () => {
    const r = await get(`/api/internal/objectives/${betaCard}`, { 'X-CC-Session-Token': alphaToken })
    expect(r.status).toBe(403)
    expect((r.body as { code: string }).code).toBe('workspace_forbidden')
    expect(JSON.stringify(r.body)).not.toContain('BETA-ONLY-SECRET')
  })

  it('403s the other workspace output and siblings', async () => {
    expect((await get(`/api/internal/objectives/${betaCard}/output`, { 'X-CC-Session-Token': alphaToken })).status).toBe(403)
    expect((await get(`/api/internal/objectives/${betaCard}/siblings`, { 'X-CC-Session-Token': alphaToken })).status).toBe(403)
  })

  it('never returns a cross-workspace SIBLING even under a shared parent', async () => {
    const r = await get(`/api/internal/objectives/${alphaCard}/siblings`, { 'X-CC-Session-Token': alphaToken })
    expect(r.status).toBe(200)
    const body = JSON.stringify(r.body)
    expect(body).not.toContain('BETA-ONLY-SECRET')
    expect(body).not.toContain('beta card under alpha parent')
  })

  it('a strategy roll-up is filtered to the principal workspace', async () => {
    const r = await get(`/api/internal/strategies/${betaStrategy}/objectives`, { 'X-CC-Session-Token': alphaToken })
    expect(r.status).toBe(200)
    expect(r.body).toEqual([])
  })

  it('?fields=full cannot widen the row set', async () => {
    const r = await get('/api/internal/objectives?fields=full', { 'X-CC-Session-Token': alphaToken })
    expect(r.status).toBe(200)
    expect(JSON.stringify(r.body)).not.toContain('BETA-ONLY-SECRET')
  })

  it('include_terminal / since / limit cannot widen the row set', async () => {
    const r = await get('/api/internal/objectives?include_terminal=1&limit=500&offset=0', {
      'X-CC-Session-Token': alphaToken,
    })
    expect(r.status).toBe(200)
    expect([...new Set((r.body as Array<{ workspace: string }>).map((x) => x.workspace))]).toEqual(['ws-alpha'])
  })
})

describe('3. fails closed on a bad, missing or revoked principal', () => {
  it('rejects a forged token and does NOT fall back to the localhost allowance', async () => {
    // Built at runtime so the OSS publish gate's gitleaks scan has no literal to flag.
    const forged = ['ccs', ['bm90', 'YSB0b2tlbg'].join('.')].join('_')
    const r = await get('/api/internal/objectives', { 'X-CC-Session-Token': forged })
    expect(r.status).toBe(401)
    expect((r.body as { code: string }).code).toBe('bad_session_token')
  })

  it('rejects a token whose payload was tampered with', async () => {
    const [payload, mac] = mintSessionToken({ objectiveId: alphaCard, workspace: 'ws-alpha', actingUserId: avaId })
      .slice('ccs_'.length)
      .split('.')
    const swapped = Buffer.from(
      JSON.stringify({ o: betaCard, w: 'ws-beta', u: bobId, e: Date.now() + 60_000 }),
    ).toString('base64url')
    expect(swapped).not.toBe(payload)
    const r = await get('/api/internal/objectives', { 'X-CC-Session-Token': `ccs_${swapped}.${mac}` })
    expect(r.status).toBe(401)
  })

  it('rejects an expired token', async () => {
    const expired = mintSessionToken(
      { objectiveId: alphaCard, workspace: 'ws-alpha', actingUserId: avaId },
      Date.now() - 10 * 60_000,
      60_000,
    )
    expect((await get('/api/internal/objectives', { 'X-CC-Session-Token': expired })).status).toBe(401)
  })

  it('rejects a token for a card that no longer exists', async () => {
    const gone = mintSessionToken({ objectiveId: 99_999_999, workspace: 'ws-alpha', actingUserId: avaId })
    const r = await get('/api/internal/objectives', { 'X-CC-Session-Token': gone })
    expect(r.status).toBe(401)
    expect((r.body as { code: string }).code).toBe('bad_session_token')
  })

  it('rejects when the acting user LOST the workspace membership (revocation)', async () => {
    const db = getDb()
    const revoked = mintSessionToken({ objectiveId: orphanUserCard, workspace: 'ws-alpha', actingUserId: bobId })
    const r = await get('/api/internal/objectives', { 'X-CC-Session-Token': revoked })
    expect(r.status).toBe(403)
    expect((r.body as { code: string }).code).toBe('workspace_forbidden')

    // And the inverse: grant, read, revoke, read again — the SAME token flips.
    db.prepare("INSERT INTO user_workspaces (user_id, workspace, role) VALUES (?, 'ws-alpha', 'member')").run(bobId)
    expect((await get('/api/internal/objectives', { 'X-CC-Session-Token': revoked })).status).toBe(200)
    db.prepare("DELETE FROM user_workspaces WHERE user_id = ? AND workspace = 'ws-alpha'").run(bobId)
    expect((await get('/api/internal/objectives', { 'X-CC-Session-Token': revoked })).status).toBe(403)
  })

  it('rejects a token whose acting user was deleted', async () => {
    const db = getDb()
    const ghostId = Number(
      db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run('iso-ghost', 'x', 'member')
        .lastInsertRowid,
    )
    db.prepare("INSERT INTO user_workspaces (user_id, workspace, role) VALUES (?, 'ws-alpha', 'member')").run(ghostId)
    const ghostToken = mintSessionToken({ objectiveId: alphaCard, workspace: 'ws-alpha', actingUserId: ghostId })
    expect((await get('/api/internal/objectives', { 'X-CC-Session-Token': ghostToken })).status).toBe(200)
    db.prepare('DELETE FROM users WHERE id = ?').run(ghostId)
    const r = await get('/api/internal/objectives', { 'X-CC-Session-Token': ghostToken })
    expect(r.status).toBe(403)
    expect((r.body as { code: string }).code).toBe('user_revoked')
  })
})

describe('4. explicit server / operator compatibility', () => {
  it('X-Internal-Secret stays board-wide (health + operational callers)', async () => {
    const r = await get('/api/internal/objectives', { 'X-Internal-Secret': 'test-internal-secret-900321' })
    expect(r.status).toBe(200)
    const ws = new Set((r.body as Array<{ workspace: string }>).map((x) => x.workspace))
    expect(ws.has('ws-alpha')).toBe(true)
    expect(ws.has('ws-beta')).toBe(true)
    expect(r.headers.get('X-Board-Principal')).toBe('server')
  })

  it('a bare on-box caller still works by default (the ~60 first-party call sites)', async () => {
    const r = await get('/api/internal/objectives')
    expect(r.status).toBe(200)
    expect(r.headers.get('X-Board-Principal')).toBe('local-operator')
  })

  it('the ratchet withdraws the bare on-box allowance without touching the rest', async () => {
    process.env.CC_INTERNAL_BOARD_REQUIRE_PRINCIPAL = '1'
    try {
      expect(boardPrincipalRequired()).toBe(true)
      const bare = await get('/api/internal/objectives')
      expect(bare.status).toBe(403)
      expect((bare.body as { code: string }).code).toBe('principal_required')
      expect((await get('/api/internal/objectives', { 'X-Internal-Secret': 'test-internal-secret-900321' })).status).toBe(200)
      expect((await get('/api/internal/objectives', { 'X-CC-Session-Token': alphaToken })).status).toBe(200)
    } finally {
      delete process.env.CC_INTERNAL_BOARD_REQUIRE_PRINCIPAL
    }
  })
})

describe('5. a session cannot spoof its scope', () => {
  it('?workspace=<other> is a loud 403, not a silent rewrite', async () => {
    const r = await get('/api/internal/objectives?workspace=ws-beta', { 'X-CC-Session-Token': alphaToken })
    expect(r.status).toBe(403)
    expect((r.body as { code: string }).code).toBe('workspace_forbidden')
  })

  it('?workspace=all collapses to the principal workspace', async () => {
    const r = await get('/api/internal/objectives?workspace=all', { 'X-CC-Session-Token': alphaToken })
    expect(r.status).toBe(200)
    expect([...new Set((r.body as Array<{ workspace: string }>).map((x) => x.workspace))]).toEqual(['ws-alpha'])
  })

  it('a session token still cannot reach the board through the proxy (forwarding headers)', async () => {
    const r = await get(`/api/internal/objectives/${betaCard}`, {
      'X-CC-Session-Token': alphaToken,
      'X-Forwarded-For': '127.0.0.1',
    })
    expect(r.status).toBe(403)
  })
})

describe('6. principal resolution unit cases (no HTTP socket available)', () => {
  // express's `req.header()` is what the credential helpers read; the socket is
  // what the origin check reads. A literal is enough for both.
  const fakeReq = (remoteAddress: string, headers: Record<string, string> = {}) => ({
    req: {
      headers,
      socket: { remoteAddress },
      header: (name: string) => headers[name.toLowerCase()],
    } as never,
  })

  it('a SANDBOX peer with no token is denied even though isLocalhost() trusts it', () => {
    const env = { INTERNAL_TRUSTED_PEER_CIDRS: '10.77.0.0/16' } as NodeJS.ProcessEnv
    const { req } = fakeReq('10.77.3.9')
    expect(isSandboxPeer(req, env)).toBe(true)
    const r = resolveBoardPrincipal(req, getDb(), env)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.denial.code).toBe('session_token_required')
  })

  it('the SAME sandbox peer is allowed — scoped — once it presents its token', () => {
    const env = { INTERNAL_TRUSTED_PEER_CIDRS: '10.77.0.0/16' } as NodeJS.ProcessEnv
    const { req } = fakeReq('10.77.3.9', { 'x-cc-session-token': alphaToken })
    const r = resolveBoardPrincipal(req, getDb(), env)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.principal.kind).toBe('session')
      expect(r.principal.workspace).toBe('ws-alpha')
    }
  })

  it('loopback and the docker gateway are NOT sandbox peers', () => {
    const env = { INTERNAL_TRUSTED_PEER_CIDRS: '10.77.0.0/16' } as NodeJS.ProcessEnv
    expect(isSandboxPeer(fakeReq('127.0.0.1').req, env)).toBe(false)
    expect(isSandboxPeer(fakeReq('::1').req, env)).toBe(false)
    expect(isSandboxPeer(fakeReq('172.18.0.1').req, env)).toBe(false)
  })

  it('a sandbox peer WITH the internal secret is the server principal', () => {
    const env = { INTERNAL_TRUSTED_PEER_CIDRS: '10.77.0.0/16' } as NodeJS.ProcessEnv
    const { req } = fakeReq('10.77.3.9', { 'x-internal-secret': 'test-internal-secret-900321' })
    const r = resolveBoardPrincipal(req, getDb(), env)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.principal.kind).toBe('server')
  })
})
