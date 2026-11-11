/**
 * Which code is running (obj 720210). Client installs bake the commit into the
 * image (`GIT_SHA` build arg → env); a live-checkout deployment has no build
 * arg, so fall back to asking git once. Never throws; `null` = unknown.
 *
 * obj 900368 — WHEN that fallback runs is the whole value of the field.
 *
 * `buildCommit()` memoises, but it used to memoise on FIRST CALL, and the first
 * call is a request handler (`GET /api/health`). On a live-checkout install the
 * fallback shells `git rev-parse HEAD` against the checkout *as it is at that
 * moment* — so a process that booted on commit A, then had the checkout
 * fast-forwarded to B underneath it without a restart, answers "B" while still
 * executing A. `tsx` does not hot-reload, so that answer is exactly backwards:
 * health reports the code that is NOT running.
 *
 * That is not academic here — it is the trap CLAUDE.md calls "merge ≠ deployed",
 * and `/api/health` is the probe every deploy runbook reaches for first. So the
 * resolution is pinned at BOOT (`initBuildInfo()`, called from index.ts before
 * anything can serve), when on-disk HEAD and the loaded module graph are the same
 * thing by construction. After that the value is frozen for the process's life:
 * a later checkout move cannot change the answer, which is the property that makes
 * "restart it and check again" a real verification step instead of a tautology.
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

/**
 * Pin the running commit at process start. Call once, from boot, BEFORE the
 * server listens. Idempotent: a second call is a no-op, so it can never be used
 * to re-point a live process at a newer checkout.
 *
 * Returns the pinned value so boot can log it — "which code am I" belongs in the
 * startup log, not only behind an HTTP request.
 */
export function initBuildInfo(): string | null {
  if (cached === undefined) cached = resolveCommit()
  return cached
}

/** The running commit (short sha), pinned at boot by initBuildInfo(). */
export function buildCommit(): string | null {
  if (cached === undefined) cached = resolveCommit()
  return cached
}

/** Test-only: drop the pin so a spec can exercise resolution more than once. */
export function __resetBuildInfoForTests(): void {
  cached = undefined
}
