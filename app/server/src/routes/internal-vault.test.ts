// Security tests for Phase 5 Personal CRM internal-vault router.
// Covers the two attack surfaces that matter:
//   1. Localhost guard — non-127.0.0.1 callers must get 403.
//   2. Path validation — every endpoint that takes `path` must reject
//      absolute paths, parent-traversal, non-.md, and paths that resolve
//      outside the vault root (symlink escape).
//
// The vault root is a temp dir so writes don't touch /home/operator/second-brain.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'

// Set up the env BEFORE importing the router (which reads VAULT_PATH and DB_PATH at load time).
const VAULT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-vault-test-'))
const TMP_DB = path.join(os.tmpdir(), `cc-vault-test-${process.pid}-${Date.now()}.db`)
process.env.VAULT_PATH = VAULT_ROOT
process.env.DB_PATH = TMP_DB

const { initDb, getDb } = await import('../db/index.js')
const { default: internalVaultRouter, resolveVaultPath } = await import('./internal-vault.js')

let server: http.Server
let baseUrl: string

beforeAll(async () => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()

  // Build a tiny vault structure for path-resolution tests.
  fs.mkdirSync(path.join(VAULT_ROOT, 'personal', 'contacts'), { recursive: true })
  fs.writeFileSync(
    path.join(VAULT_ROOT, 'personal', 'contacts', 'alice.md'),
    '---\ntype: contact\nname: Alice\nemail: alice@example.com\n---\n# Alice\n',
  )

  const app = express()
  app.set('trust proxy', true)  // honor X-Forwarded-For so we can simulate non-loopback
  app.use(express.json())
  app.use('/api/internal', internalVaultRouter)
  await new Promise<void>(resolve => {
    server = app.listen(0, '127.0.0.1', () => resolve())
  })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('server has no address')
  baseUrl = `http://127.0.0.1:${addr.port}`
})

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
  try { getDb().close() } catch {/* ignore */}
  for (const suffix of ['', '-wal', '-shm']) {
    const f = `${TMP_DB}${suffix}`
    if (fs.existsSync(f)) fs.unlinkSync(f)
  }
  fs.rmSync(VAULT_ROOT, { recursive: true, force: true })
})

beforeEach(() => {
  getDb().prepare('DELETE FROM contacts_index').run()
  getDb().prepare(
    `INSERT INTO contacts_index (vault_path, name, email, workspace) VALUES (?, ?, ?, ?)`
  ).run('personal/contacts/alice.md', 'Alice', 'alice@example.com', 'personal')
})

// ── resolveVaultPath unit tests ──────────────────────────────────────────

describe('resolveVaultPath', () => {
  it('rejects absolute paths', () => {
    expect(resolveVaultPath('/etc/passwd').ok).toBe(false)
    expect(resolveVaultPath('/home/operator/secrets.md').ok).toBe(false)
  })

  it('rejects parent-traversal sequences', () => {
    expect(resolveVaultPath('../outside.md').ok).toBe(false)
    expect(resolveVaultPath('personal/../../etc/passwd.md').ok).toBe(false)
    expect(resolveVaultPath('personal/./contacts/alice.md').ok).toBe(false)
  })

  it('rejects non-.md files', () => {
    expect(resolveVaultPath('personal/contacts/alice.json').ok).toBe(false)
    expect(resolveVaultPath('personal/contacts/alice').ok).toBe(false)
  })

  it('rejects empty/null input', () => {
    expect(resolveVaultPath('').ok).toBe(false)
    expect(resolveVaultPath(null as unknown as string).ok).toBe(false)
  })

  it('accepts a valid vault-relative .md path', () => {
    const r = resolveVaultPath('personal/contacts/alice.md', { mustExist: true })
    expect(r.ok).toBe(true)
    expect(r.relative).toBe('personal/contacts/alice.md')
    expect(r.absolute).toBe(path.join(fs.realpathSync(VAULT_ROOT), 'personal/contacts/alice.md'))
  })

  it('rejects missing files when mustExist:true', () => {
    expect(resolveVaultPath('personal/contacts/ghost.md', { mustExist: true }).ok).toBe(false)
  })

  it('accepts missing files when mustExist:false (creates)', () => {
    const r = resolveVaultPath('personal/contacts/new-person.md', { mustExist: false })
    expect(r.ok).toBe(true)
  })

  it('rejects symlinks that escape the vault root', () => {
    const escape = path.join(os.tmpdir(), `cc-vault-escape-${Date.now()}.md`)
    fs.writeFileSync(escape, 'pwned')
    const link = path.join(VAULT_ROOT, 'personal', 'contacts', 'escape.md')
    fs.symlinkSync(escape, link)
    const r = resolveVaultPath('personal/contacts/escape.md', { mustExist: true })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/escape/)
    fs.unlinkSync(link)
    fs.unlinkSync(escape)
  })
})

// ── Localhost guard ─────────────────────────────────────────────────────

describe('localhost guard', () => {
  it('accepts requests from 127.0.0.1', async () => {
    const res = await fetch(`${baseUrl}/api/internal/vault/search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'alice' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { results: unknown[] }
    expect(body.results.length).toBeGreaterThanOrEqual(1)
  })

  it('rejects requests with an external X-Forwarded-For (trust-proxy on)', async () => {
    const res = await fetch(`${baseUrl}/api/internal/vault/search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.5' },
      body: JSON.stringify({ query: 'alice' }),
    })
    expect(res.status).toBe(403)
    const body = await res.json() as { error: string }
    expect(body.error).toMatch(/localhost/i)
  })

  it('rejects GET /rolodex/history from a non-loopback IP', async () => {
    const res = await fetch(`${baseUrl}/api/internal/rolodex/history/12345`, {
      headers: { 'x-forwarded-for': '198.51.100.42' },
    })
    expect(res.status).toBe(403)
  })
})

// ── Path traversal at the endpoint level ────────────────────────────────

describe('endpoint path traversal protection', () => {
  it('vault/read rejects traversal', async () => {
    const res = await fetch(`${baseUrl}/api/internal/vault/read`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: '../../../etc/passwd.md' }),
    })
    expect(res.status).toBe(400)
  })

  it('vault/read rejects absolute paths', async () => {
    const res = await fetch(`${baseUrl}/api/internal/vault/read`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: '/etc/passwd' }),
    })
    expect(res.status).toBe(400)
  })

  it('vault/append-note rejects non-.md', async () => {
    const res = await fetch(`${baseUrl}/api/internal/vault/append-note`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'personal/contacts/alice.txt', text: 'hi' }),
    })
    expect(res.status).toBe(400)
  })

  it('vault/update-field rejects non-whitelisted fields', async () => {
    const res = await fetch(`${baseUrl}/api/internal/vault/update-field`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'personal/contacts/alice.md', field: 'type', value: 'pwned' }),
    })
    expect(res.status).toBe(400)
    const body = await res.json() as { error: string }
    expect(body.error).toMatch(/field must be one of/)
  })
})

// ── Smoke tests: end-to-end happy paths to catch regressions ────────────

describe('vault endpoints (happy paths)', () => {
  it('vault/read returns the file content', async () => {
    const res = await fetch(`${baseUrl}/api/internal/vault/read`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'personal/contacts/alice.md' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { content: string }
    expect(body.content).toContain('name: Alice')
  })

  it('vault/append-touchpoint sets last_interaction and appends a line', async () => {
    const res = await fetch(`${baseUrl}/api/internal/vault/append-touchpoint`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        path: 'personal/contacts/alice.md',
        date: '2026-06-01',
        summary: 'Coffee at the office',
        channel: 'meeting',
      }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { last_interaction: string }
    expect(body.last_interaction).toBe('2026-06-01')
    const content = fs.readFileSync(path.join(VAULT_ROOT, 'personal/contacts/alice.md'), 'utf-8')
    expect(content).toContain('last_interaction: "2026-06-01"')
    expect(content).toMatch(/## Touchpoints[\s\S]*Coffee at the office/)
  })

  it('rolodex/history upserts and reads back', async () => {
    const post = await fetch(`${baseUrl}/api/internal/rolodex/history`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: 'chat-1',
        user_id: 'user-42',
        history: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }],
      }),
    })
    expect(post.status).toBe(200)
    const get = await fetch(`${baseUrl}/api/internal/rolodex/history/chat-1`)
    expect(get.status).toBe(200)
    const body = await get.json() as { user_id: string; history: { role: string }[] }
    expect(body.user_id).toBe('user-42')
    expect(body.history.length).toBe(2)
  })
})
