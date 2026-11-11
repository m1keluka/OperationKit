import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import { execFileSync } from 'child_process'
import express from 'express'
import cookieParser from 'cookie-parser'
import jwt from 'jsonwebtoken'
import type { Objective } from '@operationkit/shared'

// obj 79 — fresh installs: registering a repo must make it resolvable for
// session spawns (workspaces.json + DB fallback) and give it a repo-local
// credential helper. Everything points at temp paths; nothing live is touched.
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-repo-reg-'))
const TMP_DB = path.join(DIR, 'test.db')
const WS_JSON = path.join(DIR, 'ai-workspace', 'workspaces.json')
process.env.DB_PATH = TMP_DB
process.env.JWT_SECRET = 'test-secret-repo-reg'
process.env.WORKSPACES_JSON_PATH = WS_JSON

const { initDb, getDb } = await import('../db/index.js')
const { default: adminWorkspacesRouter } = await import('./admin-workspaces.js')
const { invalidateWorkspacesCache } = await import('../services/workspaces.js')
const { resolveWorkdir, loadDbRepoPaths } = await import('../services/prompt-builder-workdir.js')
const { upsertWorkspacesJsonProject } = await import('../services/workspaces-json.js')
const { PROJECTS_DIR } = await import('../config.js')

let server: http.Server
let baseUrl: string
const cookie = `token=${jwt.sign({ id: 1, username: 'tester', role: 'admin' }, 'test-secret-repo-reg', { expiresIn: '1h' })}`

function gitRepo(name: string): string {
  const p = path.join(DIR, 'projects', name)
  fs.mkdirSync(p, { recursive: true })
  execFileSync('git', ['init', '-q', p])
  return p
}
const localHelper = (repo: string): string => {
  try {
    return execFileSync('git', ['-C', repo, 'config', '--local', '--get-all', 'credential.helper'], { encoding: 'utf8' }).trim()
  } catch { return '' }
}
const obj = (over: Partial<Objective>): Objective => ({ id: 7, workspace: 'example', project: 'proj', agent_context: 'cto', ...over } as Objective)

async function post(p: string, body: unknown) {
  const res = await fetch(`${baseUrl}${p}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(body),
  })
  return { status: res.status, json: await res.json().catch(() => null) }
}

beforeAll(async () => {
  initDb()
  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  app.use('/api/admin/workspaces', adminWorkspacesRouter)
  await new Promise<void>(r => { server = app.listen(0, () => r()) })
  const a = server.address()
  if (!a || typeof a === 'string') throw new Error('no address')
  baseUrl = `http://127.0.0.1:${a.port}`
})
afterAll(async () => {
  await new Promise<void>(r => server.close(() => r()))
  try { getDb().close() } catch {}
  fs.rmSync(DIR, { recursive: true, force: true })
})
beforeEach(() => {
  getDb().exec('DELETE FROM workspace_repos')
  invalidateWorkspacesCache()
  fs.rmSync(WS_JSON, { force: true })
})

describe('POST /api/admin/workspaces/:slug/repos — registration side effects', () => {
  it('creates workspaces.json when missing and records the project under the workspace', async () => {
    const repo = gitRepo('alpha')
    const r = await post('/api/admin/workspaces/example/repos', { name: 'alpha', repo_path: repo })
    expect(r.status).toBe(201)
    const data = JSON.parse(fs.readFileSync(WS_JSON, 'utf8'))
    expect(data.workspaces.example.projects).toEqual([{ name: 'alpha', path: repo }])
  })

  it('merges into an existing workspaces.json without dropping other workspaces/projects', async () => {
    fs.mkdirSync(path.dirname(WS_JSON), { recursive: true })
    fs.writeFileSync(WS_JSON, JSON.stringify({ version: 2, workspaces: { other: { projects: [{ name: 'x', path: '/x' }] }, example: { label: 'A', projects: [] } } }))
    const repo = gitRepo('beta')
    await post('/api/admin/workspaces/example/repos', { name: 'beta', repo_path: repo })
    const data = JSON.parse(fs.readFileSync(WS_JSON, 'utf8'))
    expect(data.version).toBe(2)
    expect(data.workspaces.other.projects).toEqual([{ name: 'x', path: '/x' }])
    expect(data.workspaces.example.label).toBe('A')
    expect(data.workspaces.example.projects).toEqual([{ name: 'beta', path: repo }])
  })

  it('then resolveWorkdir resolves a card linked to that project (was: fail-closed on fresh installs)', async () => {
    const repo = gitRepo('gamma')
    await post('/api/admin/workspaces/example/repos', { name: 'gamma', repo_path: repo })
    expect(resolveWorkdir(obj({ project: 'gamma' }))).toBe(repo)
  })

  it('sets a repo-local credential.helper "!gh auth git-credential" on the checkout', async () => {
    const repo = gitRepo('delta')
    await post('/api/admin/workspaces/example/repos', { name: 'delta', repo_path: repo })
    expect(localHelper(repo)).toBe('!gh auth git-credential')
  })

  it('keeps an existing repo-local credential helper', async () => {
    const repo = gitRepo('epsilon')
    execFileSync('git', ['-C', repo, 'config', '--local', 'credential.helper', 'store'])
    await post('/api/admin/workspaces/example/repos', { name: 'epsilon', repo_path: repo })
    expect(localHelper(repo)).toBe('store')
  })

  it('never overwrites an unparseable workspaces.json (hand-edited)', async () => {
    fs.mkdirSync(path.dirname(WS_JSON), { recursive: true })
    fs.writeFileSync(WS_JSON, '{ not json')
    const r = await post('/api/admin/workspaces/example/repos', { name: 'zeta', repo_path: gitRepo('zeta') })
    expect(r.status).toBe(201) // registration itself still succeeds
    expect(fs.readFileSync(WS_JSON, 'utf8')).toBe('{ not json')
  })

  it('a repo without repo_path writes nothing', async () => {
    await post('/api/admin/workspaces/example/repos', { name: 'no-path' })
    expect(fs.existsSync(WS_JSON)).toBe(false)
  })
})

describe('upsertWorkspacesJsonProject', () => {
  it('updates a moved path and reports unchanged on a repeat', () => {
    const f = path.join(DIR, 'ws-upsert.json')
    expect(upsertWorkspacesJsonProject({ workspace: 'w', name: 'p', repoPath: '/a/p/' }, f)).toBe('created')
    expect(upsertWorkspacesJsonProject({ workspace: 'w', name: 'p', repoPath: '/a/p' }, f)).toBe('unchanged')
    expect(upsertWorkspacesJsonProject({ workspace: 'w', name: 'p', repoPath: '/b/p' }, f)).toBe('updated')
    expect(JSON.parse(fs.readFileSync(f, 'utf8')).workspaces.w.projects).toEqual([{ name: 'p', path: '/b/p' }])
  })
  it('rejects a relative path', () => {
    expect(upsertWorkspacesJsonProject({ workspace: 'w', name: 'p', repoPath: 'rel/p' }, path.join(DIR, 'rel.json'))).toBe('skipped')
  })
})

describe('resolveWorkdir — workspace_repos DB fallback, still fail-closed', () => {
  const exists = (set: string[]) => (p: string) => set.includes(p)

  it('no workspaces.json + a DB-registered repo → its repo_path', () => {
    expect(resolveWorkdir(obj({}), {
      workspaces: null,
      dbRepoPaths: () => ['/srv/projects/proj/'],
      existsSync: exists(['/srv/projects/proj']),
    })).toBe('/srv/projects/proj')
  })

  it('workspaces.json still wins when it maps the project', () => {
    expect(resolveWorkdir(obj({}), {
      workspaces: { example: { projects: [{ name: 'proj', path: '/json/proj' }] } },
      dbRepoPaths: () => ['/db/proj'],
      existsSync: exists(['/json/proj', '/db/proj']),
    })).toBe('/json/proj')
  })

  it('skips DB rows whose path does not exist, then fails closed', () => {
    expect(() => resolveWorkdir(obj({}), {
      workspaces: null, dbRepoPaths: () => ['/gone/proj'], existsSync: () => false,
    })).toThrow(/fail-closed/)
  })

  it('NEVER falls back to the bare projects root, even when a DB row points at it', () => {
    expect(() => resolveWorkdir(obj({}), {
      workspaces: null, dbRepoPaths: () => [PROJECTS_DIR, `${PROJECTS_DIR}/`, '/'], existsSync: () => true,
    })).toThrow(/Refusing to fall back to the bare projects root/)
  })

  it('ignores relative DB paths', () => {
    expect(() => resolveWorkdir(obj({}), {
      workspaces: null, dbRepoPaths: () => ['projects/proj'], existsSync: () => true,
    })).toThrow(/fail-closed/)
  })

  it('no project at all → no DB lookup, agent workdir as before', () => {
    let asked = false
    resolveWorkdir(obj({ project: null as unknown as string }), { dbRepoPaths: () => { asked = true; return [] } })
    expect(asked).toBe(false)
  })

  it('loadDbRepoPaths reads workspace_repos, the objective’s own workspace first', () => {
    const ins = getDb().prepare('INSERT INTO workspace_repos (workspace, name, repo_path) VALUES (?, ?, ?)')
    ins.run('operator', 'shared', '/other/shared')
    ins.run('example', 'shared', '/own/shared')
    ins.run('example', 'shared', null)
    expect(loadDbRepoPaths('shared', 'example')).toEqual(['/own/shared', '/other/shared'])
    expect(loadDbRepoPaths('shared', 'operator')).toEqual(['/other/shared', '/own/shared'])
    expect(loadDbRepoPaths('nope', 'example')).toEqual([])
  })
})
