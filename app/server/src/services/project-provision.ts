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
 *   1. clone `github` into `<PROJECTS_DIR>/<name>` on `branch` when the path is
 *      missing. An EXISTING path is never modified (no pull/reset/checkout) — it is
 *      only accepted when it is a git repo whose origin is the expected repo;
 *      anything else is refused.
 *   2. register it exactly like the admin route: workspaces.json upsert, repo-local
 *      credential helper, and a workspace_repos row (inserted only if absent).
 *   3. return `inspectProject` — the read-only verification, which runs the real
 *      resolveWorkdir for a synthetic objective in that workspace.
 *
 * `inspectProject` alone is the read-only `--check` mode; it writes nothing.
 * Every side effect is injectable so the unit test never touches a live path.
 */
import { execFileSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import type { Objective } from '@operationkit/shared'
import { PROJECTS_DIR } from '../config.js'
import { resolveWorkdir } from './prompt-builder-workdir.js'
import { upsertWorkspacesJsonProject, type UpsertResult } from './workspaces-json.js'

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

export interface ProvisionDeps {
  git?: (args: string[]) => string
  projectsDir?: string
  workspacesJsonFile?: string
  /** clone URL override (tests point this at a local bare repo) */
  cloneUrl?: string
  /** existing workspace_repos row for (workspace, name) */
  findRepoRow?: (workspace: string, name: string) => { id: number; repo_path: string | null } | undefined
  insertRepoRow?: (row: { workspace: string; name: string; github: string; repo_path: string }) => void
  credentialHelper?: (repoPath: string) => void
  resolve?: (objective: Objective) => string
}

export interface ProjectInspection {
  workspace: string
  name: string
  repoPath: string
  exists: boolean
  isGitRepo: boolean
  originUrl: string | null
  originMatches: boolean
  branch: string | null
  head: string | null
  clean: boolean
  resolvedWorkdir: string | null
  resolveError: string | null
  ok: boolean
}

function defaultGit(args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

/** `https://github.com/O/R(.git)`, `git@github.com:O/R(.git)`, `ssh://git@github.com/O/R` → `o/r`. */
export function normalizeGithubRemote(url: string): string | null {
  const m = url.trim().match(/github\.com[:/]+([^/]+\/[^/]+?)(?:\.git)?\/?$/i)
  return m ? m[1].toLowerCase() : null
}

export function validateProvisionOpts(o: ProvisionOpts): string | null {
  if (!SLUG_RE.test(o.workspace)) return `invalid workspace "${o.workspace}"`
  if (!SLUG_RE.test(o.name) || o.name.includes('..')) return `invalid project name "${o.name}"`
  if (!GITHUB_RE.test(o.github)) return `invalid github "${o.github}" (expected owner/repo)`
  if (o.branch !== undefined && !/^[A-Za-z0-9._/-]+$/.test(o.branch)) return `invalid branch "${o.branch}"`
  if (o.repoPath !== undefined && !path.isAbsolute(o.repoPath)) return `repo path must be absolute: "${o.repoPath}"`
  return null
}

function targetPath(o: ProvisionOpts, deps: ProvisionDeps): string {
  return path.resolve(o.repoPath ?? path.join(deps.projectsDir ?? PROJECTS_DIR, o.name))
}

/** Read-only. Never writes to the checkout, the DB, or workspaces.json. */
export function inspectProject(o: ProvisionOpts, deps: ProvisionDeps = {}): ProjectInspection {
  const git = deps.git ?? defaultGit
  const repoPath = targetPath(o, deps)
  const tryGit = (args: string[]): string | null => {
    try { return git(['-C', repoPath, ...args]) } catch { return null }
  }
  const exists = fs.existsSync(repoPath)
  const top = exists ? tryGit(['rev-parse', '--show-toplevel']) : null
  const isGitRepo = !!top && path.resolve(top) === fs.realpathSync(repoPath)
  const originUrl = isGitRepo ? tryGit(['remote', 'get-url', 'origin']) : null
  const originMatches = !!originUrl &&
    (normalizeGithubRemote(originUrl) === o.github.toLowerCase() || (!!deps.cloneUrl && originUrl === deps.cloneUrl))
  const branch = isGitRepo ? tryGit(['rev-parse', '--abbrev-ref', 'HEAD']) : null
  const head = isGitRepo ? tryGit(['rev-parse', 'HEAD']) : null
  const status = isGitRepo ? tryGit(['status', '--porcelain']) : null
  const clean = status === ''

  let resolvedWorkdir: string | null = null
  let resolveError: string | null = null
  try {
    const synthetic = { id: 0, workspace: o.workspace, project: o.name, agent_context: 'cto' } as Objective
    resolvedWorkdir = (deps.resolve ?? (obj => resolveWorkdir(obj)))(synthetic)
  } catch (err) {
    resolveError = (err as Error).message
  }

  const ok =
    isGitRepo && originMatches && clean &&
    branch === (o.branch ?? 'main') &&
    !!resolvedWorkdir && path.resolve(resolvedWorkdir) === repoPath
  return {
    workspace: o.workspace, name: o.name, repoPath, exists, isGitRepo, originUrl, originMatches,
    branch, head, clean, resolvedWorkdir, resolveError, ok,
  }
}

export interface ProvisionResult {
  cloned: boolean
  workspacesJson: UpsertResult
  repoRow: 'inserted' | 'present' | 'present-different-path'
  inspection: ProjectInspection
}

export function provisionProject(o: ProvisionOpts, deps: ProvisionDeps = {}): ProvisionResult {
  const invalid = validateProvisionOpts(o)
  if (invalid) throw new Error(`provisionProject: ${invalid}`)
  const git = deps.git ?? defaultGit
  const branch = o.branch ?? 'main'
  const repoPath = targetPath(o, deps)
  const projectsDir = path.resolve(deps.projectsDir ?? PROJECTS_DIR)
  if (repoPath === projectsDir || repoPath === '/') throw new Error('provisionProject: refusing the bare projects root')

  let cloned = false
  if (!fs.existsSync(repoPath)) {
    // Credentials come from the caller's env via gh (never argv, never the URL).
    git([
      '-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential',
      'clone', '-q', '--branch', branch, deps.cloneUrl ?? `https://github.com/${o.github}.git`, repoPath,
    ])
    cloned = true
  } else {
    const pre = inspectProject(o, { ...deps, resolve: () => repoPath })
    if (!pre.isGitRepo) throw new Error(`provisionProject: ${repoPath} exists but is not a git checkout — refusing to touch it`)
    if (!pre.originMatches) throw new Error(`provisionProject: ${repoPath} origin is "${pre.originUrl}", not ${o.github} — refusing to touch it`)
  }

  const workspacesJson = deps.workspacesJsonFile !== undefined
    ? upsertWorkspacesJsonProject({ workspace: o.workspace, name: o.name, repoPath }, deps.workspacesJsonFile)
    : upsertWorkspacesJsonProject({ workspace: o.workspace, name: o.name, repoPath })
  try { deps.credentialHelper?.(repoPath) } catch { /* best-effort, same as the admin route */ }

  let repoRow: ProvisionResult['repoRow'] = 'present'
  const existing = deps.findRepoRow?.(o.workspace, o.name)
  if (!existing) {
    deps.insertRepoRow?.({ workspace: o.workspace, name: o.name, github: o.github, repo_path: repoPath })
    repoRow = 'inserted'
  } else if ((existing.repo_path ?? '').replace(/\/+$/, '') !== repoPath) {
    repoRow = 'present-different-path' // left alone — workspaces.json (searched first) now wins
  }

  return { cloned, workspacesJson, repoRow, inspection: inspectProject(o, deps) }
}
