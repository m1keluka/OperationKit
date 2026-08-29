/**
 * Live-checkout drift guard.
 *
 * The running server serves source from a bind-mounted checkout
 * (CC_REPO_DIR). That checkout can hold UNCOMMITTED edits that are "live but
 * unbacked" — one `git reset` from silent deletion and invisible on origin/main
 * (incident obj-1124, 2026-06-21: a restart-storm hard-reset the live checkout
 * and silently deleted two whole features that existed only as working-tree
 * edits). This guard detects that class of drift and surfaces it LOUDLY so
 * "unbacked production" can never go unnoticed again:
 *
 *   (a) the checkout is DIRTY in a bind-mounted SERVED path
 *       (app/server/src, app/client/src, app/shared, app/client/dist), or
 *   (b) HEAD != origin/main (ahead OR behind).
 *
 * Harmless untracked files OUTSIDE served paths (e.g. scripts/*.mjs scratch
 * files left by other sessions) MUST NOT trip the guard.
 *
 * The analysis core (`analyzeDrift`) is a PURE function over raw git output so
 * it can be unit-tested without a real repo. `collectGitState` shells out;
 * `runDriftCheck` ties them together and raises an alert via notify().
 */
import { execFileSync } from 'child_process'
import { CC_REPO_DIR, CC_SERVED_PATHS, GIT_SSH_COMMAND } from '../config.js'
import { notify } from './notifier.js'

export interface GitState {
  /** Raw `git status --porcelain` output (one entry per line, untracked as `??`). */
  porcelain: string
  /** Raw `git rev-list --left-right --count origin/main...HEAD` => "<behind>\t<ahead>". */
  leftRight: string
  /** Whether the pre-check `git fetch` succeeded (affects ahead/behind confidence). */
  fetchOk: boolean
  /** Whether git could be queried at all (false → check is inconclusive, not "clean"). */
  ok: boolean
}

export interface DriftResult {
  /** True when any drift condition holds (dirty-served OR ahead OR behind). */
  drifted: boolean
  /** Served-path entries that are dirty/untracked (the live-but-unbacked set). */
  dirtyServedFiles: string[]
  /** Commits on origin/main not in HEAD (checkout is behind by this many). */
  behind: number
  /** Commits in HEAD not on origin/main (checkout is ahead/unpushed by this many). */
  ahead: number
  /** Human-readable reasons, one per triggered condition. */
  reasons: string[]
  /** Whether origin was successfully fetched before comparing (false = possibly stale). */
  fetchOk: boolean
  /** False when git itself could not be queried — result is inconclusive. */
  ok: boolean
}

/**
 * Extract the path from a single `git status --porcelain` line.
 * Format is `XY <path>` (XY = 2-char status, path starts at column 3).
 * Renames/copies render as `R  old -> new`; we take the destination path.
 */
function porcelainPath(line: string): string {
  const raw = line.slice(3)
  const arrow = raw.indexOf(' -> ')
  const p = arrow >= 0 ? raw.slice(arrow + 4) : raw
  // git may quote paths containing special chars: "path with space"
  return p.replace(/^"|"$/g, '').trim()
}

function isServedPath(p: string): boolean {
  return CC_SERVED_PATHS.some(
    (prefix) => p === prefix || p.startsWith(prefix.endsWith('/') ? prefix : prefix + '/'),
  )
}

/**
 * PURE drift analysis over raw git output. No I/O — fully unit-testable.
 */
export function analyzeDrift(state: GitState): DriftResult {
  if (!state.ok) {
    return {
      drifted: false,
      dirtyServedFiles: [],
      behind: 0,
      ahead: 0,
      reasons: ['git could not be queried — drift check inconclusive'],
      fetchOk: state.fetchOk,
      ok: false,
    }
  }

  const dirtyServedFiles = state.porcelain
    .split('\n')
    .map((l) => l.replace(/\r$/, ''))
    .filter((l) => l.trim().length > 0)
    .map(porcelainPath)
    .filter((p) => p.length > 0 && isServedPath(p))
  // De-dupe (a rename can list the same dest once; defensive).
  const dirtyServed = Array.from(new Set(dirtyServedFiles))

  // leftRight is "<behind>\t<ahead>" from `git rev-list --left-right --count origin/main...HEAD`.
  let behind = 0
  let ahead = 0
  const parts = state.leftRight.trim().split(/\s+/)
  if (parts.length === 2) {
    behind = Number.parseInt(parts[0], 10) || 0
    ahead = Number.parseInt(parts[1], 10) || 0
  }

  const reasons: string[] = []
  if (dirtyServed.length > 0) {
    reasons.push(
      `Live checkout has ${dirtyServed.length} uncommitted change(s) in SERVED paths (live-but-unbacked): ${dirtyServed
        .slice(0, 10)
        .join(', ')}${dirtyServed.length > 10 ? ', …' : ''}`,
    )
  }
  if (ahead > 0) {
    reasons.push(`HEAD is ${ahead} commit(s) AHEAD of origin/main (unpushed — would be lost on a reset).`)
  }
  if (behind > 0) {
    reasons.push(`HEAD is ${behind} commit(s) BEHIND origin/main (serving stale code).`)
  }
  if (!state.fetchOk && (ahead > 0 || behind > 0)) {
    reasons.push('(origin fetch failed — ahead/behind compared against a possibly-stale origin/main.)')
  }

  return {
    drifted: dirtyServed.length > 0 || ahead > 0 || behind > 0,
    dirtyServedFiles: dirtyServed,
    behind,
    ahead,
    reasons,
    fetchOk: state.fetchOk,
    ok: true,
  }
}

/**
 * Shell out to git against the live checkout. Never throws — on any failure
 * returns an inconclusive (ok:false) state so the caller alerts/logs rather
 * than treating a query failure as "clean".
 */
export function collectGitState(repoDir: string = CC_REPO_DIR): GitState {
  // Root inside the container has an empty ~/.ssh. Sessions already get
  // GIT_SSH_COMMAND (host key + admin's deploy key); drift-guard must too or
  // `git fetch` dies on "Host key verification failed".
  const gitEnv = { ...process.env, GIT_SSH_COMMAND }
  const git = (args: string[], timeout = 15000): string =>
    execFileSync('git', ['-C', repoDir, ...args], { encoding: 'utf-8', timeout, env: gitEnv }).trim()

  // Best-effort fetch of just origin/main so ahead/behind is accurate. Network
  // hiccups must not break the check — we fall back to the last-known ref.
  let fetchOk = false
  try {
    git(['fetch', 'origin', 'main', '--quiet'], 20000)
    fetchOk = true
  } catch {
    fetchOk = false
  }

  try {
    const porcelain = git(['status', '--porcelain'])
    let leftRight = '0\t0'
    try {
      leftRight = git(['rev-list', '--left-right', '--count', 'origin/main...HEAD'])
    } catch {
      // origin/main ref may be missing (fresh clone, detached) — leave 0/0.
      leftRight = '0\t0'
    }
    return { porcelain, leftRight, fetchOk, ok: true }
  } catch (err) {
    console.warn(`[drift-guard] git query failed for ${repoDir}:`, (err as Error).message)
    return { porcelain: '', leftRight: '0\t0', fetchOk, ok: false }
  }
}

/**
 * Run one drift check against the live checkout. On drift, log LOUDLY to the
 * container log and raise a high-severity alert (surfaces in the AlertBell UI;
 * dedup_key throttles to one alert per ~10min). Returns the structured result
 * (used by GET /api/internal/drift-check). Never throws.
 */
export function runDriftCheck(repoDir: string = CC_REPO_DIR): DriftResult {
  let result: DriftResult
  try {
    result = analyzeDrift(collectGitState(repoDir))
  } catch (err) {
    console.warn('[drift-guard] runDriftCheck failed:', (err as Error).message)
    return {
      drifted: false,
      dirtyServedFiles: [],
      behind: 0,
      ahead: 0,
      reasons: ['drift check threw — inconclusive'],
      fetchOk: false,
      ok: false,
    }
  }

  if (result.drifted) {
    const summary = result.reasons.join(' ')
    console.warn(
      `\n========================================================================\n` +
        `[drift-guard] ⚠️  LIVE-CHECKOUT DRIFT DETECTED in ${repoDir}\n` +
        result.reasons.map((r) => `  - ${r}`).join('\n') +
        `\n  This is UNBACKED PRODUCTION. Commit -> PR -> merge -> deploy from main.\n` +
        `========================================================================\n`,
    )
    // Fire-and-forget alert; notify() swallows its own errors.
    void notify({
      severity: 'high',
      source: 'drift-guard',
      title: 'Live checkout drift detected (unbacked production)',
      message: summary,
      dedup_key: 'drift-guard:live-checkout',
      url: 'https://cc.example.com',
    })
  }

  return result
}

let driftTimer: ReturnType<typeof setInterval> | null = null
const DRIFT_TICK_MS = 60 * 1000

/**
 * Start the periodic drift guard (60s). Idempotent. Runs one check shortly
 * after boot, then on each tick. Folded in alongside startPoller/startRoutineScheduler.
 */
export function startDriftGuard(): void {
  if (driftTimer) return
  // Initial check after a short grace so the server finishes booting first.
  setTimeout(() => {
    try {
      runDriftCheck()
    } catch {
      /* never let the guard crash boot */
    }
  }, 10_000)
  driftTimer = setInterval(() => {
    try {
      runDriftCheck()
    } catch {
      /* swallow — covered by runDriftCheck's own guard, belt-and-suspenders */
    }
  }, DRIFT_TICK_MS)
  console.log('[drift-guard] started (60s tick, watching live checkout for unbacked drift)')
}

export function stopDriftGuard(): void {
  if (driftTimer) {
    clearInterval(driftTimer)
    driftTimer = null
  }
}
