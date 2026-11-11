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

const { provisionProject, inspectProject, normalizeGithubRemote, validateProvisionOpts, ProvisionError, stripWildcardSafeDir } = await import('./project-provision.js')
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

  // Every refusal must leave the target, workspaces.json and the DB rows untouched.
  function snapshot(target: string) {
    const files = fs.readdirSync(target).filter(f => f !== '.git').sort()
    return {
      head: g('-C', target, 'rev-parse', 'HEAD'),
      branch: g('-C', target, 'rev-parse', '--abbrev-ref', 'HEAD'),
      status: g('-C', target, 'status', '--porcelain'),
      files: files.map(f => [f, fs.readFileSync(path.join(target, f), 'utf8')]),
      wsJson: fs.readFileSync(WS_JSON, 'utf8'),
    }
  }
  function codeOf(fn: () => unknown): string {
    try { fn() } catch (err) { expect(err).toBeInstanceOf(ProvisionError); return (err as InstanceType<typeof ProvisionError>).code }
    throw new Error('expected a ProvisionError')
  }
  const leftovers = () => fs.readdirSync(PROJECTS)

  it('refuses a non-git path and a wrong-origin checkout with distinct codes', () => {
    const target = path.join(PROJECTS, 'example-website')
    fs.mkdirSync(target)
    expect(codeOf(() => provisionProject(opts, deps([])))).toBe('not-git')
    fs.rmSync(target, { recursive: true })
    g('init', '-q', '-b', 'main', target)
    g('-C', target, 'remote', 'add', 'origin', 'https://github.com/someone/else.git')
    const rows: Parameters<typeof deps>[0] = []
    expect(codeOf(() => provisionProject(opts, deps(rows)))).toBe('wrong-origin')
    expect(inspectProject(opts, deps([])).problems).toContain('wrong-origin')
    expect(rows).toHaveLength(0)
  })

  it('host scenario: refuses a dirty feature-branch checkout of the right repo and changes nothing', () => {
    // Mirrors /home/operator/projects/example-website on 2026-11-08: right origin,
    // branch seo/…, 3 modified + 2 untracked files.
    const target = path.join(PROJECTS, 'example-website')
    g('clone', '-q', BARE, target)
    g('-C', target, 'checkout', '-q', '-b', 'seo/obj719557-freshness-schema-sweep')
    fs.writeFileSync(path.join(target, 'README.md'), 'edited\n')
    fs.writeFileSync(path.join(target, 'new1.txt'), 'u1')
    fs.writeFileSync(path.join(target, 'new2.txt'), 'u2')
    const before = snapshot(target)
    const rows: Parameters<typeof deps>[0] = []

    const i = inspectProject(opts, deps(rows))
    expect(i.isGitRepo).toBe(true)
    expect(i.originMatches).toBe(true)
    expect(i.problems).toEqual(expect.arrayContaining(['wrong-branch', 'dirty']))
    expect(i.diagnostics.join('\n')).toMatch(/1 modified, 2 untracked/)
    expect(i.ok).toBe(false)

    expect(() => provisionProject(opts, deps(rows))).toThrow(/refusing to touch it/)
    expect(snapshot(target)).toEqual(before) // no pull/reset/stash/checkout; index not rewritten
    expect(rows).toHaveLength(0)

    // Dirty on main (right branch) is refused as 'dirty' specifically.
    g('-C', target, 'checkout', '-q', 'main')
    expect(codeOf(() => provisionProject(opts, deps(rows)))).toBe('dirty')
  })

  it('a fresh --path alongside the dirty checkout clones main and becomes the mapping', () => {
    const dirty = path.join(PROJECTS, 'example-website')
    g('clone', '-q', BARE, dirty)
    fs.writeFileSync(path.join(dirty, 'stray.txt'), 'x')
    const before = snapshot(dirty)
    const fresh = path.join(PROJECTS, 'example-website-main')
    const rows: Parameters<typeof deps>[0] = []
    const r = provisionProject({ ...opts, branch: 'main', repoPath: fresh }, deps(rows))
    expect(r.cloned).toBe(true)
    expect(r.inspection).toMatchObject({ ok: true, clean: true, branch: 'main', resolvedWorkdir: fresh, problems: [] })
    expect(snapshot(dirty).status).toBe(before.status)
    expect(leftovers().sort()).toEqual(['example-website', 'example-website-main'])
  })

  it('ownership: git refusing a foreign-owned checkout is reported as "ownership", and the exact-path safe.directory clears it', () => {
    const globalSafe = () => { try { return g('config', '--global', '--get-all', 'safe.directory') } catch { return '' } }
    const globalBefore = globalSafe()
    provisionProject(opts, deps([]))
    const target = path.join(PROJECTS, 'example-website')
    const prev = process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER
    process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER = '1' // git's own switch: treat the repo as owned by someone else
    try {
      const seen: string[][] = []
      const real = (args: string[], o?: { env?: NodeJS.ProcessEnv }) => {
        seen.push(args)
        // Isolate from any global/system safe.directory (CI runners and other suites may set '*').
        const env = { ...(o?.env ?? process.env), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
        return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env }).trim()
      }
      // With our per-command exact-path safe.directory: readable and ok.
      const ok = inspectProject(opts, { ...deps([]), git: real })
      expect(ok.ok).toBe(true)
      const safe = seen.flat().filter(a => a.startsWith('safe.directory='))
      expect(safe.length).toBeGreaterThan(0)
      expect(new Set(safe)).toEqual(new Set([`safe.directory=${fs.realpathSync(target)}`])) // never '*'

      // A runner that drops it (= the pre-fix behaviour) gets the distinct diagnostic.
      const noSafe = (args: string[], o?: { env?: NodeJS.ProcessEnv }) =>
        real(args.filter((a, i) => !a.startsWith('safe.directory=') && !(a === '-c' && args[i + 1]?.startsWith('safe.directory='))), o)
      const bad = inspectProject(opts, { ...deps([]), git: noSafe })
      expect(bad.problems).toContain('ownership')
      expect(bad.problems).not.toContain('not-git')
      expect(bad.diagnostics.join('\n')).toMatch(/dubious ownership/)
      expect(codeOf(() => provisionProject(opts, { ...deps([]), git: noSafe }))).toBe('ownership')
    } finally {
      if (prev === undefined) delete process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER
      else process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER = prev
    }
    // No global config was written.
    expect(globalSafe()).toBe(globalBefore)
  })

  it('as root, git on a checkout runs as the folder owner with that owner\'s HOME, and inspection is lock-free', () => {
    provisionProject(opts, deps([]))
    const target = path.join(PROJECTS, 'example-website')
    const calls: Array<{ args: string[]; uid?: number; gid?: number; home?: string; locks?: string }> = []
    const asRoot = (args: string[], o?: { env?: NodeJS.ProcessEnv; uid?: number; gid?: number }) => {
      calls.push({ args, uid: o?.uid, gid: o?.gid, home: o?.env?.HOME, locks: o?.env?.GIT_OPTIONAL_LOCKS })
      // we are not really root in the test: run as ourselves
      return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: o?.env }).trim()
    }
    const st = fs.statSync(target)
    const i = inspectProject(opts, { ...deps([]), git: asRoot, uid: 0, homeFor: () => '/home/owner' })
    expect(i.ok).toBe(true)
    expect(i.ownerUid).toBe(st.uid)
    expect(i.runnerUid).toBe(st.uid)
    expect(calls.length).toBeGreaterThan(0)
    for (const c of calls) {
      expect(c).toMatchObject({ uid: st.uid, gid: st.gid, home: '/home/owner', locks: '0' })
    }
  })

  it('clone credential travels only in the git child env via the helper script, never argv; no-access is distinct and leaves nothing', () => {
    const TOKEN = ['tok', 'en', '-', 'value', '-', 'x'].join('') // synthetic
    const helperDir = path.join(DIR, 'helper')
    const calls: Array<{ args: string[]; env?: NodeJS.ProcessEnv }> = []
    const failingAuth = (args: string[], o?: { env?: NodeJS.ProcessEnv }) => {
      calls.push({ args, env: o?.env })
      if (args.includes('clone')) {
        // half-written clone, then the auth failure git prints
        const dest = args[args.length - 1]
        fs.mkdirSync(path.join(dest, '.git'), { recursive: true })
        const e = new Error('Command failed: git clone') as Error & { stderr: string }
        e.stderr = `fatal: could not read Username for 'https://github.com': terminal prompts disabled (${TOKEN})`
        throw e
      }
      return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: o?.env }).trim()
    }
    const rows: Parameters<typeof deps>[0] = []
    const wsBefore = fs.readFileSync(WS_JSON, 'utf8')
    let err: InstanceType<typeof ProvisionError> | null = null
    try {
      provisionProject(opts, { ...deps(rows), cloneUrl: undefined, git: failingAuth, helperDir, credential: () => ({ token: TOKEN, source: 'stored-connection' }) })
    } catch (e) { err = e as InstanceType<typeof ProvisionError> }
    expect(err?.code).toBe('no-access')
    expect(err?.message).toMatch(/source: stored-connection/)
    expect(err?.message).not.toContain(TOKEN) // redacted
    const clone = calls.find(c => c.args.includes('clone'))!
    expect(clone.args.join(' ')).not.toContain(TOKEN)
    expect(clone.args).toContain(`credential.helper=${path.join(helperDir, 'git-credential-cc-token.sh')}`)
    expect(clone.args).toContain('https://github.com/your-org/example-website.git')
    expect(clone.env?.CC_GIT_FETCH_TOKEN).toBe(TOKEN)
    expect(fs.readFileSync(path.join(helperDir, 'git-credential-cc-token.sh'), 'utf8')).not.toContain(TOKEN)
    // atomic: no target, no temp dir, no registration
    expect(leftovers()).toEqual([])
    expect(fs.readFileSync(WS_JSON, 'utf8')).toBe(wsBefore)
    expect(rows).toHaveLength(0)

    // With no credential at all the message names the missing access need.
    try {
      provisionProject(opts, { ...deps(rows), git: failingAuth, credential: () => ({ token: null, source: 'none' }) })
    } catch (e) { err = e as InstanceType<typeof ProvisionError> }
    expect(err?.code).toBe('no-access')
    expect(err?.message).toMatch(/No stored GitHub credential resolved/)
    expect(leftovers()).toEqual([])
  })

  it('a real failed clone (bad remote) is clone-failed and leaves nothing behind', () => {
    const rows: Parameters<typeof deps>[0] = []
    expect(codeOf(() => provisionProject(opts, { ...deps(rows), cloneUrl: path.join(DIR, 'nope.git') }))).toBe('clone-failed')
    expect(leftovers()).toEqual([])
    expect(rows).toHaveLength(0)
  })

  it('a registration failure after a fresh clone rolls back the clone and workspaces.json', () => {
    const wsBefore = fs.readFileSync(WS_JSON, 'utf8')
    const d = { ...deps([]), insertRepoRow: () => { throw new Error('db locked') } }
    expect(codeOf(() => provisionProject(opts, d))).toBe('register-failed')
    expect(leftovers()).toEqual([])
    expect(fs.readFileSync(WS_JSON, 'utf8')).toBe(wsBefore)
  })

  it('the shared credential helper runs through the owner-aware runner without a wildcard safe.directory', () => {
    const seen: string[][] = []
    provisionProject(opts, { ...deps([]), credentialHelper: (_p, run) => { seen.push(['x']); run(['-c', 'safe.directory=*', 'config', '--local', '--get-all', 'core.bare']) } })
    expect(seen).toHaveLength(1)
    expect(stripWildcardSafeDir(['-c', 'safe.directory=*', '-C', '/r', 'config'])).toEqual(['-C', '/r', 'config'])
  })

  it('--check flags a dirty checkout as not ok', () => {
    provisionProject(opts, deps([]))
    fs.writeFileSync(path.join(PROJECTS, 'example-website', 'stray.txt'), 'x')
    const i = inspectProject(opts, deps([]))
    expect(i.clean).toBe(false)
    expect(i.problems).toEqual(['dirty'])
    expect(i.ok).toBe(false)
  })

  it('validates inputs and normalizes remotes', () => {
    expect(validateProvisionOpts({ ...opts, name: '../etc' })).toMatch(/invalid project name/)
    expect(validateProvisionOpts({ ...opts, github: 'nope' })).toMatch(/invalid github/)
    expect(validateProvisionOpts({ ...opts, repoPath: 'rel/path' })).toMatch(/absolute/)
    expect(validateProvisionOpts({ ...opts, branch: '--upload-pack=x' })).toMatch(/invalid branch/)
    expect(validateProvisionOpts(opts)).toBeNull()
    expect(normalizeGithubRemote('git@github.com:your-org/example-website.git')).toBe('your-org/example-website')
    expect(normalizeGithubRemote('https://github.com/your-org/example-website')).toBe('your-org/example-website')
  })
})
