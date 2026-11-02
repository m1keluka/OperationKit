/**
 * Git credentials for server-side git operations (OVH install fix, obj 79).
 *
 * 1. `bestEffortFetch` — ensureWorktree's `git fetch origin` runs as the server
 *    user, which has no GitHub credentials on a fresh install, so it failed with
 *    "could not read Username". When a stored GitHub token is available the fetch
 *    now authenticates through a credential-helper SCRIPT that reads the token
 *    from the git child's environment. The token is never in argv (so never in
 *    `ps`, never in an execSync error message), never written to disk, never put
 *    into the remote URL and never logged. Failure stays non-fatal.
 *
 * 2. `ensureRepoCredentialHelper` — when a repo is registered, give it a
 *    repo-local `credential.helper = !gh auth git-credential` so https pushes from
 *    sessions (which carry GH_TOKEN in their env) authenticate.
 */
import { execFileSync, execSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import type { Objective } from '@operationkit/shared'
import { getDecryptedForUser } from './user-github-tokens.js'
import { getRawConfig } from './workspace-integrations.js'

/** Env var the helper script reads. Only ever set on the git child's env. */
export const GIT_TOKEN_ENV = 'CC_GIT_FETCH_TOKEN'
export const CREDENTIAL_HELPER_FILENAME = 'git-credential-cc-token.sh'
export const REPO_CREDENTIAL_HELPER = '!gh auth git-credential'

/**
 * The helper script. Static — it contains no secret. Answers only `get` for
 * github.com over https, and only when the token env var is set.
 */
export const CREDENTIAL_HELPER_SCRIPT = `#!/bin/sh
# Command Center git credential helper (no secret in this file).
# The token arrives in $${GIT_TOKEN_ENV} on the calling git process's env only.
[ "$1" = "get" ] || exit 0
host=""
while IFS= read -r line; do
  [ -z "$line" ] && break
  case "$line" in host=*) host="\${line#host=}" ;; esac
done
[ "$host" = "github.com" ] || exit 0
[ -n "$${GIT_TOKEN_ENV}" ] || exit 0
printf 'username=x-access-token\\npassword=%s\\n' "$${GIT_TOKEN_ENV}"
`

/** Write (idempotently) the helper script into `dir`; returns its path. */
export function ensureCredentialHelperScript(dir: string): string {
  const p = path.join(dir, CREDENTIAL_HELPER_FILENAME)
  fs.mkdirSync(dir, { recursive: true })
  let current: string | null = null
  try { current = fs.readFileSync(p, 'utf8') } catch { /* absent */ }
  if (current !== CREDENTIAL_HELPER_SCRIPT) fs.writeFileSync(p, CREDENTIAL_HELPER_SCRIPT, { mode: 0o755 })
  fs.chmodSync(p, 0o755)
  return p
}

/**
 * The stored GitHub token for an objective's fetch, most specific first:
 * the owner's linked PAT → the workspace's GitHub integration token → the
 * server env (GH_TOKEN / GITHUB_TOKEN). Never throws; null when none.
 */
export function resolveGitFetchToken(
  objective: Pick<Objective, 'workspace'> & { assigned_user_id?: number | null; created_by?: number | null },
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const ownerId = objective.assigned_user_id ?? objective.created_by
  if (ownerId != null) {
    try {
      const t = getDecryptedForUser(ownerId)
      if (t) return t
    } catch { /* fall through */ }
  }
  if (objective.workspace) {
    try {
      const cfg = getRawConfig(objective.workspace, 'github')
      const t = typeof cfg?.token === 'string' ? cfg.token : ''
      if (t) return t
    } catch { /* fall through */ }
  }
  return env.GH_TOKEN || env.GITHUB_TOKEN || null
}

/** argv (after `git`) for an authenticated fetch. Token-free by construction. */
export function buildAuthedFetchArgv(projectDir: string, helperPath: string): string[] {
  return [
    // Empty value first resets any inherited helper list, so only ours answers.
    '-c', 'credential.helper=',
    '-c', `credential.helper=${helperPath}`,
    '-C', projectDir,
    'fetch', 'origin', '--quiet',
  ]
}

/** Replace every occurrence of `secret` in `text`. */
export function redactSecret(text: string, secret: string | null | undefined): string {
  if (!secret) return text
  return text.split(secret).join('[REDACTED]')
}

export interface FetchDeps {
  execFile?: (file: string, args: string[], opts: { env: NodeJS.ProcessEnv; timeout: number; stdio: 'pipe' }) => unknown
  execShell?: (cmd: string, opts: { timeout: number; stdio: 'pipe' }) => unknown
  warn?: (msg: string) => void
  helperDir?: string
  baseEnv?: NodeJS.ProcessEnv
}

/**
 * Best-effort `git fetch origin` for `projectDir`. Returns whether it succeeded.
 * No token → exactly the pre-existing unauthenticated command. Never throws.
 */
export function bestEffortFetch(projectDir: string, token: string | null, deps: FetchDeps = {}): boolean {
  const warn = deps.warn ?? ((m: string) => console.warn(m))
  const execShell = deps.execShell ?? ((cmd, opts) => execSync(cmd, opts))
  const execFile = deps.execFile ?? ((file, args, opts) => execFileSync(file, args, opts))
  try {
    if (!token) {
      execShell(`git -C ${JSON.stringify(projectDir)} fetch origin --quiet`, { timeout: 30000, stdio: 'pipe' })
      return true
    }
    const helper = ensureCredentialHelperScript(deps.helperDir ?? (process.env.CC_SCRIPT_DIR || '/tmp/cc-scripts'))
    execFile('git', buildAuthedFetchArgv(projectDir, helper), {
      env: { ...(deps.baseEnv ?? process.env), [GIT_TOKEN_ENV]: token, GIT_TERMINAL_PROMPT: '0' },
      timeout: 30000,
      stdio: 'pipe',
    })
    return true
  } catch (e) {
    const e2 = e as { message?: string; stderr?: Buffer | string }
    const stderr = typeof e2.stderr === 'string' ? e2.stderr : e2.stderr?.toString() ?? ''
    const msg = redactSecret(`${e2.message ?? e}${stderr && !String(e2.message).includes(stderr) ? ` ${stderr}` : ''}`, token)
    warn(`[session-manager] ensureWorktree: best-effort fetch failed for ${projectDir} (continuing on local refs): ${msg.trim()}`)
    return false
  }
}

export interface GitConfigRunner {
  (args: string[]): string
}

const defaultGitConfigRunner: GitConfigRunner = (args) =>
  execFileSync('git', args, { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] })

/**
 * Set a repo-local `credential.helper = !gh auth git-credential` on `repoPath`
 * unless it already has a local helper. Returns 'set' | 'kept' | 'skipped'.
 * Best-effort: never throws (registration must not fail on this).
 */
export function ensureRepoCredentialHelper(
  repoPath: string,
  run: GitConfigRunner = defaultGitConfigRunner,
): 'set' | 'kept' | 'skipped' {
  if (!repoPath || !repoPath.startsWith('/')) return 'skipped'
  try {
    if (!fs.existsSync(path.join(repoPath, '.git'))) return 'skipped'
  } catch { return 'skipped' }
  // safe.directory on the command line: the server may not own the checkout.
  const base = ['-c', 'safe.directory=*', '-C', repoPath, 'config', '--local']
  try {
    const existing = run([...base, '--get-all', 'credential.helper']).trim()
    if (existing) return 'kept'
  } catch { /* exit 1 = unset → set it below */ }
  try {
    run([...base, 'credential.helper', REPO_CREDENTIAL_HELPER])
    return 'set'
  } catch (err) {
    console.warn(`[workspace-repos] could not set credential.helper on ${repoPath}: ${(err as Error).message?.split('\n')[0]}`)
    return 'skipped'
  }
}
