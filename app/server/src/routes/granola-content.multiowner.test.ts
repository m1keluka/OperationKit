/**
 * Multi-owner content engine (obj 710856).
 *
 * The engine was single-tenant: every path came from one env var and the surface
 * was admin-only. These tests pin the two properties that replacement has to have:
 *
 *  1. AUTHORIZATION is a `content_owners` row, not a role — a plain member with a
 *     row gets in; an admin without one does not.
 *  2. ISOLATION is structural — the owner row (never the URL) resolves every path,
 *     so owner A cannot read, patch, or even 404-probe owner B's files. The old
 *     surface could not express this at all, because there was only one tenant.
 *
 * Runs against a throwaway DB + a temp vault; never touches the real vault.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'
import cookieParser from 'cookie-parser'

const TMP = path.join(os.tmpdir(), `cc-content-${process.pid}-${Date.now()}`)
process.env.DB_PATH = path.join(TMP, 'test.db')
process.env.VAULT_PATH = path.join(TMP, 'vault')
process.env.AI_WORKSPACE = path.join(TMP, 'ai-workspace')
process.env.JWT_SECRET = 'test-secret-content-multiowner-xx'
// The secrets store encrypts with a DEDICATED master key that has no fallback. CI
// has none (a dev box picks one up from the host key file), so this suite supplies
// its own throwaway rather than depending on ambient environment.
process.env.SECRETS_MASTER_KEY = Buffer.alloc(32, 7).toString('base64')
delete process.env.GRANOLA_API_KEY
fs.mkdirSync(TMP, { recursive: true })

const { getDb, initDb } = await import('../db/index.js')
const { generateToken } = await import('../middleware/auth.js')
const { getContentOwner, ownerPaths, ensureVaultDirs, granolaConnection, setGranolaKey, clearGranolaKey } =
  await import('../services/content-owners.js')
const router = (await import('./granola-content.js')).default

interface Actor { id: number; token: string }

function makeUser(username: string, role: 'admin' | 'member'): Actor {
  const db = getDb()
  db.prepare(
    "INSERT INTO users (username, password_hash, role) VALUES (?, 'x', ?)"
  ).run(username, role)
  const id = (db.prepare('SELECT id FROM users WHERE username = ?').get(username) as { id: number }).id
  return { id, token: generateToken({ id, username, role, created_at: '' }) }
}

function makeOwner(userId: number, vault: string, founder: string): void {
  getDb()
    .prepare(
      `INSERT INTO content_owners (user_id, vault_workspace, founder_slug, display_name, routine_name, enabled)
       VALUES (?, ?, ?, ?, ?, 1)`
    )
    .run(userId, vault, founder, vault, `granola-intake-${vault}`)
}

/** Minimal draft with the frontmatter shape the engine parses. */
function writeDraft(vault: string, file: string, topic: string): void {
  const dir = path.join(process.env.VAULT_PATH!, 'workspaces', vault, 'content', 'drafts')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, file),
    `---\nstatus: draft\ntype: linkedin-draft\ntopic: ${topic}\ndate: 2026-09-14\n---\n\n${topic} body\n`,
    'utf8'
  )
}

let server: http.Server
let base: string
let alice: Actor // member WITH a content owner row
let bob: Actor // member WITH a different content owner row
let root: Actor // ADMIN with NO content owner row

async function call(
  method: string, url: string, actor: Actor | null, body?: unknown
): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}${url}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(actor ? { Authorization: `Bearer ${actor.token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  return { status: res.status, json: text ? JSON.parse(text) : null }
}

beforeAll(async () => {
  initDb()
  // The schema seed matches owners by username; these users are created after
  // initDb, so every owner row in this suite is created explicitly below.
  alice = makeUser('alice', 'member')
  bob = makeUser('bob', 'member')
  root = makeUser('root', 'admin')
  makeOwner(alice.id, 'alice-vault', 'alice')
  makeOwner(bob.id, 'bob-vault', 'bob')

  writeDraft('alice-vault', '2026-09-14-alice-1.md', 'alice topic')
  writeDraft('bob-vault', '2026-09-14-bob-1.md', 'bob topic')

  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  app.use('/api/granola-content', router)
  server = http.createServer(app)
  await new Promise<void>(r => server.listen(0, r))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/granola-content`
})

afterAll(async () => {
  await new Promise<void>(r => server.close(() => r()))
  fs.rmSync(TMP, { recursive: true, force: true })
})

describe('authorization is a content_owners row, not a role', () => {
  it('rejects an unauthenticated caller', async () => {
    expect((await call('GET', '/me', null)).status).toBe(401)
  })

  it('admits a plain MEMBER who owns a content workspace', async () => {
    const res = await call('GET', '/me', alice)
    expect(res.status).toBe(200)
    expect(res.json.workspace).toBe('alice-vault')
    expect(res.json.founder).toBe('alice')
  })

  it('refuses an ADMIN who has no content workspace', async () => {
    // The old surface was requireAdmin — this case would have been a 200 with
    // Mike's drafts. Admin is no longer a content grant.
    const res = await call('GET', '/me', root)
    expect(res.status).toBe(403)
    expect((await call('GET', '/drafts', root)).status).toBe(403)
    expect((await call('POST', '/run', root)).status).toBe(403)
  })

  it('refuses a disabled owner', async () => {
    getDb().prepare('UPDATE content_owners SET enabled = 0 WHERE user_id = ?').run(bob.id)
    expect((await call('GET', '/me', bob)).status).toBe(403)
    getDb().prepare('UPDATE content_owners SET enabled = 1 WHERE user_id = ?').run(bob.id)
    expect((await call('GET', '/me', bob)).status).toBe(200)
  })
})

describe('owner isolation', () => {
  it('each owner sees only their own drafts', async () => {
    const a = await call('GET', '/drafts?status=all', alice)
    expect(a.json.workspace).toBe('alice-vault')
    expect(a.json.drafts.map((d: { file: string }) => d.file)).toEqual(['2026-09-14-alice-1.md'])

    const b = await call('GET', '/drafts?status=all', bob)
    expect(b.json.workspace).toBe('bob-vault')
    expect(b.json.drafts.map((d: { file: string }) => d.file)).toEqual(['2026-09-14-bob-1.md'])
  })

  it('cannot patch another owner\'s draft even knowing its exact filename', async () => {
    const res = await call('PATCH', '/drafts/2026-09-14-bob-1.md/status', alice, { status: 'ready' })
    expect(res.status).toBe(404)
    // ...and Bob's file on disk is untouched.
    const bobFile = path.join(
      process.env.VAULT_PATH!, 'workspaces', 'bob-vault', 'content', 'drafts', '2026-09-14-bob-1.md'
    )
    expect(fs.readFileSync(bobFile, 'utf8')).toContain('status: draft')
  })

  it('rejects path traversal out of the owner drafts dir', async () => {
    const res = await call(
      'PATCH', `/drafts/${encodeURIComponent('../../../bob-vault/content/drafts/2026-09-14-bob-1.md')}/status`,
      alice, { status: 'posted' }
    )
    expect(res.status).toBe(404)
  })

  it('refuses a hook-video delete outside the owner object prefix', async () => {
    const res = await call('POST', '/hooks/x.md/video/delete', alice, { path: 'bob-vault/x/1-v.mp4' })
    expect(res.status).toBe(403)
  })

  it('an owner can patch their OWN draft', async () => {
    const res = await call('PATCH', '/drafts/2026-09-14-alice-1.md/status', alice, { status: 'ready' })
    expect(res.status).toBe(200)
    expect(res.json.draft.status).toBe('ready')
  })
})

describe('granola connection', () => {
  it('reports disconnected before a key is stored', async () => {
    const res = await call('GET', '/me', alice)
    expect(res.json.granola).toEqual({ connected: false, source: null, updated_at: null })
  })

  it('rejects a connect attempt with no key without calling Granola', async () => {
    const res = await call('POST', '/connection', alice, {})
    expect(res.status).toBe(400)
  })

  it('round-trips a stored key and never leaks the value', async () => {
    const owner = getContentOwner(alice.id)!
    setGranolaKey(owner, 'grn_secret_value')
    const conn = granolaConnection(owner)
    expect(conn.connected).toBe(true)
    expect(conn.source).toBe('stored')

    const res = await call('GET', '/me', alice)
    expect(res.json.granola.connected).toBe(true)
    expect(JSON.stringify(res.json)).not.toContain('grn_secret_value')

    expect(clearGranolaKey(owner)).toBe(true)
    expect(granolaConnection(owner).connected).toBe(false)
  })

  it('does NOT let a second owner inherit the legacy env key', async () => {
    process.env.GRANOLA_API_KEY = 'grn_legacy_global'
    process.env.GRANOLA_WORKSPACE = 'alice-vault'
    try {
      expect(granolaConnection(getContentOwner(alice.id)!).source).toBe('env')
      expect(granolaConnection(getContentOwner(bob.id)!).connected).toBe(false)
    } finally {
      delete process.env.GRANOLA_API_KEY
      delete process.env.GRANOLA_WORKSPACE
    }
  })
})

describe('provisioning', () => {
  it('creates the owner stream dirs idempotently', () => {
    const owner = getContentOwner(bob.id)!
    const p = ownerPaths(owner)
    const first = ensureVaultDirs(owner)
    expect(first.length).toBeGreaterThan(0)
    for (const d of [p.granolaDir, p.hooksDir, p.loopsDir]) expect(fs.existsSync(d)).toBe(true)
    expect(fs.existsSync(p.ideasFile)).toBe(true)
    // Second call creates nothing new.
    expect(ensureVaultDirs(owner)).toEqual([])
  })

  it('run now refuses while the owner routine is absent or disabled', async () => {
    const res = await call('POST', '/run', bob)
    expect(res.status).toBe(409)
    expect(res.json.reason).toContain('granola-intake-bob-vault')
  })
})
