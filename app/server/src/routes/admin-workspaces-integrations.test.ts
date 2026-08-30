import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'
import cookieParser from 'cookie-parser'
import jwt from 'jsonwebtoken'
import type { WorkspaceIntegration, GithubOrgRepo, WorkspaceRepo } from '@operationkit/shared'

// Real SQLite via initDb() — exercises the actual workspace_integrations schema.
const TMP_DB = path.join(os.tmpdir(), `cc-wsintg-test-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB
process.env.JWT_SECRET = 'test-secret-wsintg'

const { initDb, getDb } = await import('../db/index.js')
const { default: adminWorkspacesRouter } = await import('./admin-workspaces.js')
const { invalidateWorkspacesCache } = await import('../services/workspaces.js')
const { __setFetchForTests } = await import('../services/workspace-integrations.js')

let server: http.Server
let baseUrl: string
let adminCookie: string

// ── Fake GitHub / PostHog endpoints (no real network) ──
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

// Default fake: a valid org "acme" with token "ghp_valid", PostHog key "phc_valid".
function installDefaultFake() {
  __setFetchForTests(async (input: string, init?: RequestInit) => {
    const url = String(input)
    const auth = (init?.headers as Record<string, string> | undefined)?.Authorization || ''
    // GitHub
    if (url.startsWith('https://api.github.com/orgs/')) {
      if (!auth.includes('ghp_valid')) return jsonResponse(401, { message: 'Bad credentials' })
      if (!url.includes('/orgs/acme')) return jsonResponse(404, { message: 'Not Found' })
      if (url.includes('/repos')) {
        return jsonResponse(200, [
          { name: 'web', full_name: 'acme/web', private: false, language: 'TypeScript' },
          { name: 'api', full_name: 'acme/api', private: true, language: 'Go' },
        ])
      }
      return jsonResponse(200, { login: 'acme', public_repos: 5, total_private_repos: 2 })
    }
    // PostHog decide
    if (url.includes('/decide/')) {
      const body = init?.body ? JSON.parse(String(init.body)) : {}
      if (!String(body.api_key).startsWith('phc_valid')) return jsonResponse(401, { type: 'authentication_error' })
      return jsonResponse(200, { featureFlags: {} })
    }
    return jsonResponse(500, { error: 'unexpected url ' + url })
  })
}

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
  await new Promise<void>(resolve => { server = app.listen(0, () => resolve()) })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('server has no address')
  baseUrl = `http://127.0.0.1:${addr.port}`
  adminCookie = `token=${token('admin')}`
})

afterAll(async () => {
  __setFetchForTests(null)
  await new Promise<void>(resolve => server.close(() => resolve()))
  try { getDb().close() } catch {}
  for (const suffix of ['', '-wal', '-shm']) {
    const f = `${TMP_DB}${suffix}`
    if (fs.existsSync(f)) fs.unlinkSync(f)
  }
})

beforeEach(async () => {
  getDb().exec('DELETE FROM workspace_integrations')
  getDb().exec('DELETE FROM workspace_repos')
  getDb().exec("DELETE FROM workspaces WHERE slug NOT IN ('example','example-project','personal')")
  invalidateWorkspacesCache()
  installDefaultFake()
  await req('POST', '/api/admin/workspaces', { slug: 'acme', name: 'Acme Co' })
  await req('POST', '/api/admin/workspaces', { slug: 'beta', name: 'Beta Inc' })
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

describe('github integration (admin)', () => {
  it('validates against GitHub and persists a connected, masked integration', async () => {
    const r = await req('POST', '/api/admin/workspaces/acme/integrations/github', {
      org: 'acme',
      token: 'ghp_valid_secret_1234',
    })
    expect(r.status).toBe(201)
    const intg = r.json as WorkspaceIntegration
    expect(intg.status).toBe('connected')
    expect(intg.org).toBe('acme')
    // masked — last4 only, never the raw token
    expect(intg.token_last4).toBe('••••1234')
    expect(JSON.stringify(intg)).not.toContain('ghp_valid_secret_1234')
  })

  it('returns an error (not a false success) for an invalid token', async () => {
    const r = await req('POST', '/api/admin/workspaces/acme/integrations/github', {
      org: 'acme',
      token: 'ghp_WRONG',
    })
    expect(r.status).toBe(400)
    expect(r.json.error).toMatch(/invalid|401/i)
    // nothing persisted
    const list = await req('GET', '/api/admin/workspaces/acme/integrations')
    expect((list.json as WorkspaceIntegration[]).length).toBe(0)
  })

  it('returns an error for an unknown org', async () => {
    const r = await req('POST', '/api/admin/workspaces/acme/integrations/github', {
      org: 'ghost-org',
      token: 'ghp_valid',
    })
    expect(r.status).toBe(400)
    expect(r.json.error).toMatch(/not found|access/i)
  })

  it('lists org repos once connected and attaches a picked repo to REPOS & PROJECTS', async () => {
    await req('POST', '/api/admin/workspaces/acme/integrations/github', { org: 'acme', token: 'ghp_valid' })
    const repos = await req('GET', '/api/admin/workspaces/acme/integrations/github/repos')
    expect(repos.status).toBe(200)
    const list = repos.json as GithubOrgRepo[]
    expect(list.map(r => r.full_name)).toContain('acme/web')

    // pick one into the existing repo route
    const added = await req('POST', '/api/admin/workspaces/acme/repos', {
      name: 'web',
      github: 'acme/web',
      stack: ['TypeScript'],
    })
    expect(added.status).toBe(201)
    const repoList = await req('GET', '/api/admin/workspaces/acme/repos')
    expect((repoList.json as WorkspaceRepo[]).map(r => r.github)).toContain('acme/web')
  })

  it('409s listing org repos when GitHub is not connected', async () => {
    const r = await req('GET', '/api/admin/workspaces/acme/integrations/github/repos')
    expect(r.status).toBe(409)
  })
})

describe('posthog integration (admin)', () => {
  it('validates via a PostHog API call and persists a connected, masked integration', async () => {
    const r = await req('POST', '/api/admin/workspaces/acme/integrations/posthog', {
      host: 'https://us.i.posthog.com',
      project_api_key: 'phc_valid_abcd',
    })
    expect(r.status).toBe(201)
    const intg = r.json as WorkspaceIntegration
    expect(intg.status).toBe('connected')
    expect(intg.host).toBe('https://us.i.posthog.com')
    expect(intg.project_api_key_last4).toBe('••••abcd')
    expect(JSON.stringify(intg)).not.toContain('phc_valid_abcd')
  })

  it('returns an error for bad PostHog creds', async () => {
    const r = await req('POST', '/api/admin/workspaces/acme/integrations/posthog', {
      host: 'https://us.i.posthog.com',
      project_api_key: 'phc_WRONG',
    })
    expect(r.status).toBe(400)
    expect(r.json.error).toMatch(/invalid/i)
  })
})

describe('isolation, masking & auth', () => {
  it('scopes integrations per workspace — connecting acme does not touch beta', async () => {
    await req('POST', '/api/admin/workspaces/acme/integrations/github', { org: 'acme', token: 'ghp_valid' })
    const betaList = await req('GET', '/api/admin/workspaces/beta/integrations')
    expect((betaList.json as WorkspaceIntegration[]).length).toBe(0)
    const acmeList = await req('GET', '/api/admin/workspaces/acme/integrations')
    expect((acmeList.json as WorkspaceIntegration[]).length).toBe(1)
  })

  it('GET responses never include raw secrets', async () => {
    await req('POST', '/api/admin/workspaces/acme/integrations/github', { org: 'acme', token: 'ghp_topsecret_9999' })
    await req('POST', '/api/admin/workspaces/acme/integrations/posthog', {
      host: 'https://eu.i.posthog.com', project_api_key: 'phc_valid_zzzz',
    })
    const list = await req('GET', '/api/admin/workspaces/acme/integrations')
    const raw = JSON.stringify(list.json)
    expect(raw).not.toContain('ghp_topsecret_9999')
    expect(raw).not.toContain('phc_valid_zzzz')
  })

  it('disconnects an integration via DELETE', async () => {
    await req('POST', '/api/admin/workspaces/acme/integrations/github', { org: 'acme', token: 'ghp_valid' })
    const del = await req('DELETE', '/api/admin/workspaces/acme/integrations/github')
    expect(del.status).toBe(200)
    const list = await req('GET', '/api/admin/workspaces/acme/integrations')
    expect((list.json as WorkspaceIntegration[]).length).toBe(0)
  })

  it('blocks non-admins from connecting', async () => {
    const r = await req(
      'POST', '/api/admin/workspaces/acme/integrations/github',
      { org: 'acme', token: 'ghp_valid' }, `token=${token('member')}`,
    )
    expect(r.status).toBe(403)
  })

  it('blocks unauthenticated reads', async () => {
    const res = await fetch(`${baseUrl}/api/admin/workspaces/acme/integrations`)
    expect(res.status).toBe(401)
  })

  it('cascade-deletes integrations when the workspace row is removed', async () => {
    await req('POST', '/api/admin/workspaces/acme/integrations/github', { org: 'acme', token: 'ghp_valid' })
    getDb().prepare('DELETE FROM workspaces WHERE slug = ?').run('acme')
    const remaining = getDb().prepare("SELECT 1 FROM workspace_integrations WHERE workspace = 'acme'").get()
    expect(remaining).toBeUndefined()
  })
})
