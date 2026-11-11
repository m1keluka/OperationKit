/**
 * Project checkout provisioning (obj 900326).
 *
 * The supported registration path (POST /api/admin/workspaces/:slug/repos →
 * workspace_repos + workspaces.json, obj 79) only RECORDS a checkout path. Nothing
 * created the checkout itself, so a project whose repo was never cloned on the host
 * (e.g. example-website, card 900218) failed closed in resolveWorkdir with no
 * supported way to fix it short of a hand-run `git clone` + hand-edited JSON.
 *
 * `provisionProject` closes that gap, idempotently:
 *   1. clone `github` on `branch` when the target path is MISSING. The clone is
 *      atomic: it lands in a hidden sibling temp dir and is renamed into place only
 *      after it succeeded and verified, so a failed run leaves nothing behind.
 *      Credentials come from the install's existing server-side git mechanism
 *      (`resolveGitFetchToken` + the env-only credential-helper script that
 *      ensureWorktree's fetch uses) — never argv, never the URL, never disk.
 *   2. An EXISTING path is never modified (no pull/reset/stash/checkout/chown). It
 *      is accepted only when it is a clean checkout of the expected repo on the
 *      expected branch; anything else is refused with a distinct diagnostic.
 *   3. register it exactly like the admin route: workspaces.json upsert, repo-local
 *      credential helper, and a workspace_repos row (inserted only if absent).
 *   4. return `inspectProject` — the read-only verification, which runs the real
 *      resolveWorkdir for a synthetic objective in that workspace.
 *
 * Ownership: the checkouts are owned by the app user while `docker exec` runs as
 * root, so git refuses them as "dubious ownership". Every git call on a checkout
 * (a) runs AS the folder owner when we are root, and (b) carries a per-command
 * `-c safe.directory=<that exact realpath>`. Nothing ever writes a global
 * safe.directory, and never a wildcard.
 *
 * `inspectProject` alone is the read-only `--check` mode; it writes nothing
 * (GIT_OPTIONAL_LOCKS=0 stops `git status` from refreshing the index).
 * Every side effect is injectable so the unit test never touches a live path.
 */
import { execFileSync } from 'child_process'
import crypto from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { Objective } from '@operationkit/shared'
import { PROJECTS_DIR, WORKSPACES_JSON } from '../config.js'
import { resolveWorkdir } from './prompt-builder-workdir.js'
import { upsertWorkspacesJsonProject, type UpsertResult } from './workspaces-json.js'
import { GIT_TOKEN_ENV, ensureCredentialHelperScript, redactSecret } from './repo-git-auth.js'

const SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,99}$/i
const GITHUB_RE = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/

export interface ProvisionOpts {
  workspace: string
  name: string
  /** `owner/repo` on github.com */
  github: string
  branch?: string
  /** Defaults to `<PROJECTS_DIR>/<name>`. */
  repoPath?: string
}

/** How a git child is run. `uid`/`gid` set only when switching to the folder owner. */
export interface GitRunOpts {
  env?: NodeJS.ProcessEnv
  uid?: number
  gid?: number
}
export type GitRunner = (args: string[], opts?: GitRunOpts) => string

/** Where the clone credential came from — a KIND, never the value. */
export type TokenSource = 'stored-connection' | 'server-env' | 'none'
export interface CloneCredential { token: string | null; source: TokenSource }

export interface ProvisionDeps {
  git?: GitRunner
  projectsDir?: string
  workspacesJsonFile?: string
  /** clone URL override (tests point this at a local bare repo) */
  cloneUrl?: string
  /** existing workspace_repos row for (workspace, name) */
  findRepoRow?: (workspace: string, name: string) => { id: number; repo_path: string | null } | undefined
  insertRepoRow?: (row: { workspace: string; name: string; github: string; repo_path: string }) => void
  /** repo-local helper (ensureRepoCredentialHelper), run through the owner-aware git runner */
  credentialHelper?: (repoPath: string, run: (args: string[]) => string) => void
  resolve?: (objective: Objective) => string
  /** clone credential; defaults to none (public repos / tests) */
  credential?: () => CloneCredential
  /** dir for the static credential-helper script */
  helperDir?: string
  /** current uid (tests override); defaults to process.getuid() */
  uid?: number
  /** HOME for a git child run as `uid`; defaults to that user's passwd home */
  homeFor?: (uid: number) => string
}

/** Distinct, machine-readable reasons a checkout is not usable. */
export type ProblemCode =
  | 'missing'
  | 'not-git'
  | 'ownership'
  | 'wrong-origin'
  | 'wrong-branch'
  | 'dirty'
  | 'unresolved'
  | 'resolves-elsewhere'

export interface ProjectInspection {
  workspace: string
  name: string
  repoPath: string
  exists: boolean
  ownerUid: number | null
  runnerUid: number | null
  isGitRepo: boolean
  originUrl: string | null
  originMatches: boolean
  branch: string | null
  head: string | null
  clean: boolean
  resolvedWorkdir: string | null
  resolveError: string | null
  problems: ProblemCode[]
  diagnostics: string[]
  ok: boolean
}

export type ProvisionErrorCode =
  | 'invalid'
  | 'not-git'
  | 'ownership'
  | 'wrong-origin'
  | 'wrong-branch'
  | 'dirty'
  | 'no-access'
  | 'clone-failed'
  | 'register-failed'

export class ProvisionError extends Error {
  constructor(public readonly code: ProvisionErrorCode, message: string) {
    super(`provisionProject [${code}]: ${message}`)
    this.name = 'ProvisionError'
  }
}

function defaultGit(args: string[], opts: GitRunOpts = {}): string {
  return execFileSync('git', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 300_000,
    env: opts.env ?? process.env,
    ...(opts.uid !== undefined ? { uid: opts.uid, gid: opts.gid } : {}),
  }).trim()
}

/** That uid's home from /etc/passwd, else a temp dir (git must not read root's HOME as another uid). */
function defaultHomeFor(uid: number): string {
  try {
    for (const line of fs.readFileSync('/etc/passwd', 'utf8').split('\n')) {
      const f = line.split(':')
      if (f.length >= 6 && Number(f[2]) === uid && f[5] && fs.existsSync(f[5])) return f[5]
    }
  } catch { /* fall through */ }
  return os.tmpdir()
}

function errText(err: unknown): string {
  const e = err as { message?: string; stderr?: Buffer | string }
  const stderr = typeof e.stderr === 'string' ? e.stderr : e.stderr?.toString() ?? ''
  const msg = e.message ?? String(err)
  return (stderr && !msg.includes(stderr) ? `${msg} ${stderr}` : msg).trim()
}

const DUBIOUS_RE = /dubious ownership/i
const NO_ACCESS_RE =
  /could not read (Username|Password)|Authentication failed|terminal prompts disabled|Repository not found|returned error: 40[134]|Permission denied \(publickey\)|Invalid username or password/i

/** `https://github.com/O/R(.git)`, `git@github.com:O/R(.git)`, `ssh://git@github.com/O/R` → `o/r`. */
export function normalizeGithubRemote(url: string): string | null {
  const m = url.trim().match(/github\.com[:/]+([^/]+\/[^/]+?)(?:\.git)?\/?$/i)
  return m ? m[1].toLowerCase() : null
}

export function validateProvisionOpts(o: ProvisionOpts): string | null {
  if (!SLUG_RE.test(o.workspace)) return `invalid workspace "${o.workspace}"`
  if (!SLUG_RE.test(o.name) || o.name.includes('..')) return `invalid project name "${o.name}"`
  if (!GITHUB_RE.test(o.github)) return `invalid github "${o.github}" (expected owner/repo)`
  if (o.branch !== undefined && (!/^[A-Za-z0-9._/-]+$/.test(o.branch) || o.branch.startsWith('-'))) return `invalid branch "${o.branch}"`
  if (o.repoPath !== undefined && !path.isAbsolute(o.repoPath)) return `repo path must be absolute: "${o.repoPath}"`
  return null
}

function targetPath(o: ProvisionOpts, deps: ProvisionDeps): string {
  return path.resolve(o.repoPath ?? path.join(deps.projectsDir ?? PROJECTS_DIR, o.name))
}

function currentUid(deps: ProvisionDeps): number | null {
  if (deps.uid !== undefined) return deps.uid
  return typeof process.getuid === 'function' ? process.getuid() : null
}

/**
 * Owner-aware git for one directory: when we are root and `dir` belongs to someone
 * else, the child runs as that owner (so nothing it writes becomes root-owned);
 * always with a per-command safe.directory for that EXACT realpath.
 */
function gitIn(dir: string, deps: ProvisionDeps, extraEnv: NodeJS.ProcessEnv = {}) {
  const git = deps.git ?? defaultGit
  const st = fs.statSync(dir)
  const me = currentUid(deps)
  const switchTo = me === 0 && st.uid !== 0 ? { uid: st.uid, gid: st.gid } : {}
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', ...extraEnv }
  if (switchTo.uid !== undefined) env.HOME = (deps.homeFor ?? defaultHomeFor)(switchTo.uid)
  const real = fs.realpathSync(dir)
  const run = (args: string[]): string =>
    git(['-c', `safe.directory=${real}`, '-C', dir, ...args], { env, ...switchTo })
  return { run, ownerUid: st.uid, runnerUid: switchTo.uid ?? me }
}

/** Read-only. Never writes to the checkout, the DB, or workspaces.json. */
export function inspectProject(o: ProvisionOpts, deps: ProvisionDeps = {}): ProjectInspection {
  const branchWanted = o.branch ?? 'main'
  const repoPath = targetPath(o, deps)
  const problems: ProblemCode[] = []
  const diagnostics: string[] = []
  const add = (p: ProblemCode, msg: string) => { problems.push(p); diagnostics.push(`${p}: ${msg}`) }

  const exists = fs.existsSync(repoPath)
  let ownerUid: number | null = null
  let runnerUid: number | null = currentUid(deps)
  let isGitRepo = false
  let originUrl: string | null = null
  let branch: string | null = null
  let head: string | null = null
  let clean = false

  if (!exists) {
    add('missing', `${repoPath} does not exist`)
  } else {
    // GIT_OPTIONAL_LOCKS=0: `git status` must not refresh/rewrite the index.
    const g = gitIn(repoPath, deps, { GIT_OPTIONAL_LOCKS: '0' })
    ownerUid = g.ownerUid
    runnerUid = g.runnerUid
    let top: string | null = null
    try {
      top = g.run(['rev-parse', '--show-toplevel'])
    } catch (err) {
      const t = errText(err)
      if (DUBIOUS_RE.test(t)) {
        add('ownership', `git refused ${repoPath} as dubious ownership (owner uid ${ownerUid}, running as uid ${runnerUid}); run as the folder owner or with a per-command safe.directory for this exact path`)
      } else {
        add('not-git', `${repoPath} exists but is not a git checkout`)
      }
    }
    if (top !== null) {
      if (path.resolve(top) !== fs.realpathSync(repoPath)) {
        add('not-git', `${repoPath} is inside another checkout (${top}), not a checkout itself`)
      } else {
        isGitRepo = true
        const tryGit = (args: string[]): string | null => { try { return g.run(args) } catch { return null } }
        originUrl = tryGit(['remote', 'get-url', 'origin'])
        branch = tryGit(['rev-parse', '--abbrev-ref', 'HEAD'])
        head = tryGit(['rev-parse', 'HEAD'])
        const status = tryGit(['status', '--porcelain'])
        clean = status === ''
        if (!(originUrl && originMatchesFor(o, originUrl, deps))) {
          add('wrong-origin', `origin is ${originUrl ? `"${originUrl}"` : 'unset'}, expected github.com/${o.github}`)
        }
        if (branch !== branchWanted) add('wrong-branch', `on branch "${branch}" at ${head?.slice(0, 8) ?? '?'}, expected "${branchWanted}"`)
        if (!clean) {
          const n = status === null ? null : status.split('\n').filter(Boolean)
          add('dirty', n
            ? `${n.filter(l => !l.startsWith('??')).length} modified, ${n.filter(l => l.startsWith('??')).length} untracked`
            : 'git status failed')
        }
      }
    }
  }
  const originMatches = !!originUrl && originMatchesFor(o, originUrl, deps)

  let resolvedWorkdir: string | null = null
  let resolveError: string | null = null
  try {
    const synthetic = { id: 0, workspace: o.workspace, project: o.name, agent_context: 'cto' } as Objective
    resolvedWorkdir = (deps.resolve ?? (obj => resolveWorkdir(obj)))(synthetic)
  } catch (err) {
    resolveError = (err as Error).message
  }
  if (!resolvedWorkdir) add('unresolved', resolveError ?? 'resolveWorkdir returned nothing')
  else if (path.resolve(resolvedWorkdir) !== repoPath) add('resolves-elsewhere', `resolveWorkdir → ${resolvedWorkdir}, not ${repoPath}`)

  return {
    workspace: o.workspace, name: o.name, repoPath, exists, ownerUid, runnerUid, isGitRepo, originUrl,
    originMatches, branch, head, clean, resolvedWorkdir, resolveError, problems, diagnostics,
    ok: problems.length === 0,
  }
}

/** Remove `-c safe.directory=*` pairs (gitIn already passes the exact path). */
export function stripWildcardSafeDir(args: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-c' && args[i + 1] === 'safe.directory=*') { i++; continue }
    out.push(args[i])
  }
  return out
}

function originMatchesFor(o: ProvisionOpts, originUrl: string, deps: ProvisionDeps): boolean {
  return normalizeGithubRemote(originUrl) === o.github.toLowerCase() || (!!deps.cloneUrl && originUrl === deps.cloneUrl)
}

export interface ProvisionResult {
  cloned: boolean
  credentialSource: TokenSource | null
  workspacesJson: UpsertResult
  repoRow: 'inserted' | 'present' | 'present-different-path'
  inspection: ProjectInspection
}

/**
 * Clone into a hidden sibling temp dir as the parent dir's owner, verify, then
 * rename into place. Any failure removes the temp dir — nothing is left behind.
 */
function atomicClone(o: ProvisionOpts, repoPath: string, branch: string, deps: ProvisionDeps): TokenSource {
  const parent = path.dirname(repoPath)
  if (!fs.existsSync(parent)) throw new ProvisionError('clone-failed', `parent directory ${parent} does not exist`)
  const tmp = path.join(parent, `.${path.basename(repoPath)}.provision-${process.pid}-${crypto.randomBytes(4).toString('hex')}`)
  const cred = deps.credential?.() ?? { token: null, source: 'none' as const }
  const extraEnv: NodeJS.ProcessEnv = {}
  const pre: string[] = []
  if (cred.token) {
    // Same mechanism as ensureWorktree's authenticated fetch: a static helper
    // script answers from an env var set on THIS git child only.
    const helper = ensureCredentialHelperScript(deps.helperDir ?? (process.env.CC_SCRIPT_DIR || '/tmp/cc-scripts'))
    pre.push('-c', 'credential.helper=', '-c', `credential.helper=${helper}`)
    extraEnv[GIT_TOKEN_ENV] = cred.token
  } else {
    pre.push('-c', 'credential.helper=') // no inherited/global helper (e.g. an unauthenticated gh)
  }
  const url = deps.cloneUrl ?? `https://github.com/${o.github}.git`
  try {
    // The clone creates `tmp` itself, as the parent's owner when we are root.
    const g = gitIn(parent, deps, extraEnv)
    g.run([...pre, 'clone', '-q', '--branch', branch, '--', url, tmp])
    const after = inspectProject({ ...o, repoPath: tmp }, { ...deps, resolve: () => tmp })
    const bad = after.problems.filter(p => p !== 'unresolved' && p !== 'resolves-elsewhere')
    if (bad.length) throw new ProvisionError('clone-failed', `fresh clone failed verification: ${after.diagnostics.join('; ')}`)
    if (fs.existsSync(repoPath)) throw new ProvisionError('clone-failed', `${repoPath} appeared during the clone — not overwriting it`)
    fs.renameSync(tmp, repoPath)
  } catch (err) {
    fs.rmSync(tmp, { recursive: true, force: true })
    if (err instanceof ProvisionError) throw err
    const t = redactSecret(errText(err), cred.token)
    if (NO_ACCESS_RE.test(t)) {
      throw new ProvisionError('no-access',
        `cannot read ${o.github} with the install's GitHub credential (source: ${cred.source}). ` +
        (cred.source === 'none'
          ? 'No stored GitHub credential resolved — pass --user <id> for a user whose GitHub connection may be used server-side, or configure the workspace GitHub integration.'
          : 'That credential lacks read access to this repo.') +
        ` git: ${t.split('\n').find(l => NO_ACCESS_RE.test(l))?.trim() ?? ''}`)
    }
    throw new ProvisionError('clone-failed', t)
  }
  return cred.source
}

export function provisionProject(o: ProvisionOpts, deps: ProvisionDeps = {}): ProvisionResult {
  const invalid = validateProvisionOpts(o)
  if (invalid) throw new ProvisionError('invalid', invalid)
  const branch = o.branch ?? 'main'
  const repoPath = targetPath(o, deps)
  const projectsDir = path.resolve(deps.projectsDir ?? PROJECTS_DIR)
  if (repoPath === projectsDir || repoPath === '/') throw new ProvisionError('invalid', 'refusing the bare projects root')

  let cloned = false
  let credentialSource: TokenSource | null = null
  if (!fs.existsSync(repoPath)) {
    credentialSource = atomicClone(o, repoPath, branch, deps)
    cloned = true
  } else {
    // Existing path: inspect only. Never pull/reset/stash/checkout/chown it.
    const pre = inspectProject(o, { ...deps, resolve: () => repoPath })
    const refuse = (['ownership', 'not-git', 'wrong-origin', 'wrong-branch', 'dirty'] as const).find(p => pre.problems.includes(p))
    if (refuse) {
      throw new ProvisionError(refuse, `${repoPath} — ${pre.diagnostics.filter(d => !d.startsWith('unresolved') && !d.startsWith('resolves-elsewhere')).join('; ')} — refusing to touch it`)
    }
  }

  // Register exactly like the admin route. If registration throws after a clone
  // made by THIS run, roll both the clone and workspaces.json back.
  const wsFile = deps.workspacesJsonFile ?? WORKSPACES_JSON
  let wsBefore: string | null = null
  try { wsBefore = fs.readFileSync(wsFile, 'utf8') } catch { /* absent */ }
  let workspacesJson: UpsertResult = 'skipped'
  let repoRow: ProvisionResult['repoRow'] = 'present'
  try {
    workspacesJson = deps.workspacesJsonFile !== undefined
      ? upsertWorkspacesJsonProject({ workspace: o.workspace, name: o.name, repoPath }, deps.workspacesJsonFile)
      : upsertWorkspacesJsonProject({ workspace: o.workspace, name: o.name, repoPath })
    try {
      const g = gitIn(repoPath, deps)
      // Drop any wildcard safe.directory a shared helper adds: ours is the exact path.
      deps.credentialHelper?.(repoPath, args => g.run(stripWildcardSafeDir(args)))
    } catch { /* best-effort, same as the admin route */ }

    const existing = deps.findRepoRow?.(o.workspace, o.name)
    if (!existing) {
      deps.insertRepoRow?.({ workspace: o.workspace, name: o.name, github: o.github, repo_path: repoPath })
      repoRow = 'inserted'
    } else if ((existing.repo_path ?? '').replace(/\/+$/, '') !== repoPath) {
      repoRow = 'present-different-path' // left alone — workspaces.json (searched first) now wins
    }
  } catch (err) {
    if (cloned) {
      fs.rmSync(repoPath, { recursive: true, force: true })
      if (workspacesJson === 'added' || workspacesJson === 'updated' || workspacesJson === 'created') {
        if (wsBefore === null) fs.rmSync(wsFile, { force: true })
        else fs.writeFileSync(wsFile, wsBefore)
      }
    }
    throw new ProvisionError('register-failed', (err as Error).message)
  }

  return { cloned, credentialSource, workspacesJson, repoRow, inspection: inspectProject(o, deps) }
}
