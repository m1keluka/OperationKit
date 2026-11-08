import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync } from 'child_process'
import type { Objective } from '@operationkit/shared'

// obj 900326 — provisioning a missing project checkout. Everything is temp:
// a local bare repo stands in for GitHub, workspaces.json is a temp file.
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-provision-'))
const WS_JSON = path.join(DIR, 'workspaces.json')
process.env.WORKSPACES_JSON_PATH = WS_JSON

const { provisionProject, inspectProject, normalizeGithubRemote, validateProvisionOpts } = await import('./project-provision.js')
const { resolveWorkdir } = await import('./prompt-builder-workdir.js')

const g = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

// Seed a bare "origin" with one commit on main.
const BARE = path.join(DIR, 'origin.git')
const SEED = path.join(DIR, 'seed')
g('init', '-q', '--bare', '-b', 'main', BARE)
g('init', '-q', '-b', 'main', SEED)
fs.writeFileSync(path.join(SEED, 'README.md'), 'hi\n')
g('-C', SEED, '-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '.')
g('-C', SEED, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init')
g('-C', SEED, 'push', '-q', BARE, 'main')

const PROJECTS = path.join(DIR, 'projects')
const opts = { workspace: 'example', name: 'example-website', github: 'your-org/example-website' }
const resolveWith = (o: Objective) => resolveWorkdir(o, { dbRepoPaths: () => [] })

function deps(rows: Array<{ id: number; workspace: string; name: string; repo_path: string | null }>) {
  return {
    projectsDir: PROJECTS,
    workspacesJsonFile: WS_JSON,
    cloneUrl: BARE,
    findRepoRow: (ws: string, n: string) => rows.find(r => r.workspace === ws && r.name === n),
    insertRepoRow: (r: { workspace: string; name: string; repo_path: string }) => { rows.push({ id: rows.length + 1, ...r }) },
    resolve: resolveWith,
  }
}

beforeEach(() => {
  fs.rmSync(PROJECTS, { recursive: true, force: true })
  fs.mkdirSync(PROJECTS, { recursive: true })
  fs.writeFileSync(WS_JSON, JSON.stringify({ workspaces: { example: { projects: [{ name: 'example-crm-infra', path: '/x/example-crm-infra' }] } } }))
})
afterAll(() => fs.rmSync(DIR, { recursive: true, force: true }))

describe('provisionProject', () => {
  it('before provisioning, resolveWorkdir fails closed and --check reports not ok', () => {
    const i = inspectProject(opts, deps([]))
    expect(i.exists).toBe(false)
    expect(i.ok).toBe(false)
    expect(i.resolveError).toMatch(/no workspace in workspaces.json/)
  })

  it('clones main, registers it, and resolveWorkdir resolves the clean checkout', () => {
    const rows: Parameters<typeof deps>[0] = []
    const r = provisionProject(opts, deps(rows))
    const target = path.join(PROJECTS, 'example-website')
    expect(r.cloned).toBe(true)
    expect(r.workspacesJson).toBe('added')
    expect(r.repoRow).toBe('inserted')
    expect(rows[0]).toMatchObject({ workspace: 'example', name: 'example-website', repo_path: target })
    expect(r.inspection).toMatchObject({ ok: true, clean: true, branch: 'main', resolvedWorkdir: target })
    // other projects in workspaces.json are preserved
    const ws = JSON.parse(fs.readFileSync(WS_JSON, 'utf8')).workspaces.example.projects.map((p: { name: string }) => p.name)
    expect(ws).toEqual(['example-crm-infra', 'example-website'])
  })

  it('is idempotent and never modifies an existing checkout', () => {
    const rows: Parameters<typeof deps>[0] = []
    provisionProject(opts, deps(rows))
    const target = path.join(PROJECTS, 'example-website')
    const head = g('-C', target, 'rev-parse', 'HEAD')
    const r2 = provisionProject(opts, deps(rows))
    expect(r2.cloned).toBe(false)
    expect(r2.workspacesJson).toBe('unchanged')
    expect(r2.repoRow).toBe('present')
    expect(rows).toHaveLength(1)
    expect(g('-C', target, 'rev-parse', 'HEAD')).toBe(head)
  })

  it('refuses an existing path that is not a checkout of the expected repo', () => {
    fs.mkdirSync(path.join(PROJECTS, 'example-website'))
    expect(() => provisionProject(opts, deps([]))).toThrow(/not a git checkout/)
    fs.rmSync(path.join(PROJECTS, 'example-website'), { recursive: true })
    g('init', '-q', path.join(PROJECTS, 'example-website'))
    g('-C', path.join(PROJECTS, 'example-website'), 'remote', 'add', 'origin', 'https://github.com/someone/else.git')
    expect(() => provisionProject(opts, deps([]))).toThrow(/origin is/)
  })

  it('--check flags a dirty checkout as not ok', () => {
    provisionProject(opts, deps([]))
    fs.writeFileSync(path.join(PROJECTS, 'example-website', 'stray.txt'), 'x')
    const i = inspectProject(opts, deps([]))
    expect(i.clean).toBe(false)
    expect(i.ok).toBe(false)
  })

  it('validates inputs and normalizes remotes', () => {
    expect(validateProvisionOpts({ ...opts, name: '../etc' })).toMatch(/invalid project name/)
    expect(validateProvisionOpts({ ...opts, github: 'nope' })).toMatch(/invalid github/)
    expect(validateProvisionOpts({ ...opts, repoPath: 'rel/path' })).toMatch(/absolute/)
    expect(validateProvisionOpts(opts)).toBeNull()
    expect(normalizeGithubRemote('git@github.com:your-org/example-website.git')).toBe('your-org/example-website')
    expect(normalizeGithubRemote('https://github.com/your-org/example-website')).toBe('your-org/example-website')
  })
})
