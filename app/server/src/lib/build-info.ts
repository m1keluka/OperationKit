/**
 * Which code is running (obj 720210). Client installs bake the commit into the
 * image (`GIT_SHA` build arg → env); a live-checkout deployment has no build
 * arg, so fall back to asking git once. Never throws; `null` = unknown.
 */
import { execFileSync } from 'child_process'
import path from 'path'
import { fileURLToPath } from 'url'

let cached: string | null | undefined

export function resolveCommit(env: NodeJS.ProcessEnv = process.env, git: () => string = readGitHead): string | null {
  const fromEnv = (env.GIT_SHA || '').trim()
  if (/^[0-9a-f]{7,40}$/i.test(fromEnv)) return fromEnv.slice(0, 12).toLowerCase()
  try {
    const sha = git().trim()
    return /^[0-9a-f]{7,40}$/i.test(sha) ? sha.slice(0, 12).toLowerCase() : null
  } catch {
    return null
  }
}

function readGitHead(): string {
  const here = path.dirname(fileURLToPath(import.meta.url))
  return execFileSync('git', ['-c', 'safe.directory=*', 'rev-parse', 'HEAD'], {
    cwd: here, encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'],
  })
}

/** The running commit (short sha), resolved once per process. */
export function buildCommit(): string | null {
  if (cached === undefined) cached = resolveCommit()
  return cached
}
