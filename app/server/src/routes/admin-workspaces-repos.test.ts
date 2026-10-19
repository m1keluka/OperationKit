import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'
import cookieParser from 'cookie-parser'
import jwt from 'jsonwebtoken'
import type { WorkspaceRepo } from '@operationkit/shared'

// Real SQLite via initDb() — exercises the actual workspaces / workspace_repos
// schema (FK cascade included), not a fake.
const TMP_DB = path.join(os.tmpdir(), `cc-wsrepos-test-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB
process.env.JWT_SECRET = 'test-secret-wsrepos'

const { initDb, getDb } = await import('../db/index.js')
const { default: adminWorkspacesRouter } = await import('./admin-workspaces.js')
const { invalidateWorkspacesCache } = await import('../services/workspaces.js')

let server: http.Server
let baseUrl: string
let adminCookie: string

function makeApp(): express.Express {
  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  app.use('/api/admin/workspaces', adminWorkspacesRouter)
  return app
}

function token(role: 'admin' | 'member'): string {
  return jwt.sign({ id: 1, username: 'tester', role }, process.env.JWT_SECRET as string, { expiresIn: '1h' })
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
  adminCookie = `token=${token('admin')}`
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
  getDb().exec('DELETE FROM workspace_repos')
  getDb().exec("DELETE FROM workspaces WHERE slug NOT IN ('example','example-project','operator')")
  invalidateWorkspacesCache()
})

async function req(method: string, path: string, body?: unknown, cookie = adminCookie) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const json = await res.json().catch(() => null)
  return { status: res.status, json }
}

describe('workspace create/remove (admin)', () => {
  it('creates a workspace that then appears in the list', async () => {
    const created = await req('POST', '/api/admin/workspaces', { slug: 'acme', name: 'Acme Co' })
    expect(created.status).toBe(201)
    expect(created.json.slug).toBe('acme')

    const list = await req('GET', '/api/admin/workspaces')
    expect(list.json.some((w: { slug: string }) => w.slug === 'acme')).toBe(true)
  })

  it('rejects an invalid slug', async () => {
    const bad = await req('POST', '/api/admin/workspaces', { slug: 'Bad Slug!', name: 'X' })
    expect(bad.status).toBe(400)
  })

  it('archives (soft-deletes) a workspace via DELETE', async () => {
    await req('POST', '/api/admin/workspaces', { slug: 'temp', name: 'Temp' })
    const del = await req('DELETE', '/api/admin/workspaces/temp')
    expect(del.status).toBe(200)
    const row = getDb().prepare('SELECT archived FROM workspaces WHERE slug = ?').get('temp') as { archived: number }
    expect(row.archived).toBe(1)
  })

  it('blocks unauthenticated workspace creation', async () => {
    const res = await fetch(`${baseUrl}/api/admin/workspaces`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug: 'sneaky', name: 'Sneaky' }),
    })
    expect(res.status).toBe(401)
    expect(getDb().prepare('SELECT 1 FROM workspaces WHERE slug = ?').get('sneaky')).toBeUndefined()
  })

  it('blocks non-admin workspace creation', async () => {
    const res = await req('POST', '/api/admin/workspaces', { slug: 'member-made', name: 'X' }, `token=${token('member')}`)
    expect(res.status).toBe(403)
  })
})

describe('workspace repos (admin)', () => {
  beforeEach(async () => {
    await req('POST', '/api/admin/workspaces', { slug: 'acme', name: 'Acme Co' })
  })

  it('adds, lists, and removes a repo; persists across reads', async () => {
    const added = await req('POST', '/api/admin/workspaces/acme/repos', {
      name: 'acme-web',
      description: 'Marketing site',
      github: 'acme/acme-web',
      stack: ['React', 'Vite'],
    })
    expect(added.status).toBe(201)
    const repo = added.json as WorkspaceRepo
    expect(repo.name).toBe('acme-web')
    expect(repo.stack).toEqual(['React', 'Vite'])
    expect(repo.docs_enabled).toBe(true)
    expect(repo.docs_path).toBe('docs/product')

    const list = await req('GET', '/api/admin/workspaces/acme/repos')
    expect((list.json as WorkspaceRepo[]).map(r => r.name)).toContain('acme-web')

    const del = await req('DELETE', `/api/admin/workspaces/acme/repos/${repo.id}`)
    expect(del.status).toBe(200)

    const after = await req('GET', '/api/admin/workspaces/acme/repos')
    expect((after.json as WorkspaceRepo[]).length).toBe(0)
  })

  it('pauses living docs on a repo', async () => {
    const added = await req('POST', '/api/admin/workspaces/acme/repos', { name: 'acme-web' })
    const repo = added.json as WorkspaceRepo
    const patched = await req('PATCH', `/api/admin/workspaces/acme/repos/${repo.id}`, { docs_enabled: false })
    expect(patched.status).toBe(200)
    expect((patched.json as WorkspaceRepo).docs_enabled).toBe(false)
  })

  it('rejects a repo with no name', async () => {
    const res = await req('POST', '/api/admin/workspaces/acme/repos', { description: 'no name' })
    expect(res.status).toBe(400)
  })

  it('404s for repos on an unknown workspace', async () => {
    const res = await req('POST', '/api/admin/workspaces/nope/repos', { name: 'x' })
    expect(res.status).toBe(404)
  })

  it('cascade-deletes repos when the workspace row is removed', async () => {
    const added = await req('POST', '/api/admin/workspaces/acme/repos', { name: 'acme-api' })
    const repo = added.json as WorkspaceRepo
    getDb().prepare('DELETE FROM workspaces WHERE slug = ?').run('acme')
    const remaining = getDb().prepare('SELECT 1 FROM workspace_repos WHERE id = ?').get(repo.id)
    expect(remaining).toBeUndefined()
  })

  it('blocks unauthenticated repo creation', async () => {
    const res = await fetch(`${baseUrl}/api/admin/workspaces/acme/repos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'sneaky-repo' }),
    })
    expect(res.status).toBe(401)
  })
})
