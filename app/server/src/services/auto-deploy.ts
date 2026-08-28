// Auto-deploy on merge (obj-1955) — the deploy-lag killer.
//
// The 2026-06-28 incidents all traced back to the same root: merges land on main
// but nothing deploys, so the live checkout drifts many commits behind and a single
// manual deploy then ships a big, risky batch (and fixes sit dark in the meantime).
//
// This closes the loop: when a PR merges to the command-center's OWN main, trigger a
// health-gated self-deploy so each merge goes live in a small batch that self-verifies
// and AUTO-ROLLS-BACK on failure (scripts/self-deploy.sh, obj-1955 health-gate).
//
// Ships DARK behind settings.auto_deploy_enabled (default '0'). While off, a merge is
// logged as a DRY-RUN ("WOULD auto-deploy") and nothing happens — arm it by flipping
// the setting to '1' (mirrors auto_merge_enabled / auto_remediation_enabled).
//
// Safety:
//  - Scoped to the SELF repo only (we can only self-deploy the command-center).
//  - main only (base ref).
//  - Debounced via a TTL lockfile so a burst of merges coalesces to one deploy (each
//    deploy fast-forwards to LATEST origin/main, so the first deploy already covers
//    the burst). The deploy itself is health-gated + auto-rolls-back.
//  - Spawned DETACHED so it survives the very server restart it triggers.

import { spawn } from 'child_process'
import fs from 'fs'
import type { Database } from 'better-sqlite3'

/** The only repo we can self-deploy (the command-center itself). Env-overridable. */
export const SELF_REPO = process.env.HARNESS_REPO || 'your-org/command-center-infra'
const REPO_DIR = process.env.CC_REPO_DIR || '/home/operator/projects/command-center-infra'
const SELF_DEPLOY_SH = `${REPO_DIR}/scripts/self-deploy.sh`
const LOCK = '/tmp/cc-auto-deploy.lock'
const DEBOUNCE_MS = 180_000 // a burst of merges within ~3min coalesces to one deploy

/** Owner switch — settings.auto_deploy_enabled='1' OR env CC_AUTO_DEPLOY. Default OFF.
 *  Read at call time so it arms/disarms instantly. Fail-safe: unreadable → off. */
export function isAutoDeployEnabled(db: Database, env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.CC_AUTO_DEPLOY || '').trim().toLowerCase()
  if (v === '1' || v === 'true' || v === 'yes' || v === 'on') return true
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'auto_deploy_enabled'").get() as
      | { value?: string }
      | undefined
    return row?.value === '1' || row?.value === 'true'
  } catch {
    return false
  }
}

/** Pure predicate: does this merged-PR event target the self-deploy path? */
export function shouldAutoDeploy(input: { repo?: string | null; baseRef?: string | null }): boolean {
  return input.repo === SELF_REPO && input.baseRef === 'main'
}

/** Fire a detached, health-gated self-deploy. Debounced (skips if a deploy ran within
 *  DEBOUNCE_MS). `now` is injectable for tests. Returns the decision, never throws. */
export function triggerAutoDeploy(
  reason: string,
  now: number = Date.now(),
): { triggered: boolean; reason: string } {
  try {
    const st = fs.statSync(LOCK)
    if (now - st.mtimeMs < DEBOUNCE_MS) {
      console.log(`[auto-deploy] skipped (${reason}) — a deploy ran <${Math.round(DEBOUNCE_MS / 1000)}s ago; it covers latest main`)
      return { triggered: false, reason: 'debounced' }
    }
  } catch {
    /* no lock yet — proceed */
  }
  try {
    fs.writeFileSync(LOCK, `${now}\n${reason}\n`)
  } catch {
    /* lock is best-effort */
  }
  try {
    const child = spawn('bash', [SELF_DEPLOY_SH, 'both'], {
      detached: true, // survive the server restart this deploy will trigger
      stdio: 'ignore',
      cwd: REPO_DIR,
      env: process.env,
    })
    child.unref()
    console.log(`[auto-deploy] triggered health-gated self-deploy (${reason})`)
    return { triggered: true, reason: 'triggered' }
  } catch (err) {
    console.error('[auto-deploy] spawn failed:', err instanceof Error ? err.message : err)
    return { triggered: false, reason: 'spawn-error' }
  }
}
