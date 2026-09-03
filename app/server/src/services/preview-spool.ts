// PR preview spool — the in-container half of the auto-deploy/teardown wiring.
//
// PROBLEM this solves (obj 1452): a PR's harness/test-agent drives the live
// preview at https://pr-<N>.cc.example.com via Playwright. But the preview
// was only ever deployed by a HUMAN running scripts/preview-deploy.sh on the
// host. Every PR nobody hand-deployed got a spurious BLOCKED, because the
// test-agent navigated to a dead host. PR 102 only shipped via owner bypass.
//
// WHY a spool (and not a direct call): preview-deploy.sh fundamentally needs
// HOST ROOT that the Node server (running inside the command-center container)
// does not have:
//   1. `sudo` writes to /etc/caddy + `caddy reload` — host root only.
//   2. `docker build` uses the HOST daemon (mounted socket), so its build
//      context path (/tmp/cc-preview-N) must exist on the HOST filesystem, not
//      the container's /tmp.
//   3. `git worktree add` against the host checkout's .git.
// So the privileged work must run ON THE HOST. This module ENQUEUES a job into
// a directory shared host<->container via the /home/operator/projects bind mount;
// a host-side privileged runner (scripts/preview-spool-runner.sh, root, driven
// by the cc-preview-spool.path systemd unit) DEQUEUES it and runs the script.
//
// The enqueue is a single atomic file write (tmp + rename), so the watcher
// never observes a partial job. It is best-effort: a spool failure never breaks
// the calling HTTP handler (pr-created / github-webhook).

import fs from 'fs'
import path from 'path'
import { spawn } from 'child_process'

/** Default spool dir when PREVIEW_SPOOL_DIR is unset. */
export const DEFAULT_PREVIEW_SPOOL_DIR = '/home/operator/projects/.preview-spool'

/**
 * Spool directory shared between the container and the host at the SAME
 * absolute path (both see it through the /home/operator/projects bind mount).
 * Dot-prefixed and a sibling of the repos so it is never mistaken for a
 * checkout. Resolved per-call (not captured at import) so PREVIEW_SPOOL_DIR can
 * be overridden in tests.
 */
export function previewSpoolDir(): string {
  return process.env.PREVIEW_SPOOL_DIR || DEFAULT_PREVIEW_SPOOL_DIR
}

/**
 * Host-side runner path (lives in the deployed checkout). The kick below runs
 * THIS script on the host as root. Overridable for non-standard layouts.
 */
function runnerPath(): string {
  return (
    process.env.PREVIEW_SPOOL_RUNNER ||
    '/home/operator/projects/command-center-infra/scripts/preview-spool-runner.sh'
  )
}

export interface PreviewJob {
  action: 'deploy' | 'teardown'
  pr_number: number
  /** Required for deploy (the runner checks out origin/<branch>); ignored for teardown. */
  branch_name?: string
  /** Backlink for operator log correlation; optional. */
  objective_id?: number
  requested_at: string
}

/**
 * Stable filename per (action, pr). A re-request for the same PR atomically
 * OVERWRITES the prior pending job rather than piling up duplicates — the
 * runner is idempotent (preview-deploy.sh cleans any existing preview first).
 */
function jobFileName(action: PreviewJob['action'], prNumber: number): string {
  return `${action}-pr${prNumber}.json`
}

/**
 * Write a job atomically: serialize to a temp file in the same dir, then
 * rename over the final path (rename is atomic within a filesystem, so a
 * concurrent reader sees either the old file or the complete new one).
 * Returns true on success; logs and returns false on any failure (callers
 * treat the spool as best-effort).
 */
function writeJob(job: PreviewJob): boolean {
  try {
    const dir = previewSpoolDir()
    fs.mkdirSync(dir, { recursive: true })
    const finalPath = path.join(dir, jobFileName(job.action, job.pr_number))
    // Unique temp name avoids two near-simultaneous writers clobbering each
    // other's temp file before either renames.
    const tmpPath = `${finalPath}.${process.pid}.tmp`
    fs.writeFileSync(tmpPath, JSON.stringify(job, null, 2), { encoding: 'utf8' })
    fs.renameSync(tmpPath, finalPath)
    console.log(
      `[preview-spool] enqueued ${job.action} for PR #${job.pr_number}` +
        (job.branch_name ? ` (branch ${job.branch_name})` : '') +
        ` → ${finalPath}`,
    )
    return true
  } catch (err) {
    console.warn(
      `[preview-spool] failed to enqueue ${job.action} for PR #${job.pr_number}:`,
      err instanceof Error ? err.message : err,
    )
    return false
  }
}

/**
 * Enqueue a preview DEPLOY. No-op (returns false) without both a positive PR
 * number and a branch — the runner needs the branch to fetch/checkout, and
 * without the PR number there is no preview host to build.
 */
export function enqueuePreviewDeploy(
  prNumber: number | null | undefined,
  branchName: string | null | undefined,
  objectiveId?: number | null,
): boolean {
  if (!prNumber || prNumber <= 0 || !branchName) return false
  return writeJob({
    action: 'deploy',
    pr_number: prNumber,
    branch_name: branchName,
    objective_id: objectiveId ?? undefined,
    requested_at: new Date().toISOString(),
  })
}

/**
 * Enqueue a preview TEARDOWN. No-op (returns false) without a positive PR
 * number. Safe to call when no preview exists — preview-teardown.sh is a no-op
 * against a missing container/site.
 */
export function enqueuePreviewTeardown(
  prNumber: number | null | undefined,
  objectiveId?: number | null,
): boolean {
  if (!prNumber || prNumber <= 0) return false
  return writeJob({
    action: 'teardown',
    pr_number: prNumber,
    objective_id: objectiveId ?? undefined,
    requested_at: new Date().toISOString(),
  })
}

/**
 * Fire the host-side drain IMMEDIATELY after an enqueue, so a preview deploys
 * with ZERO host setup and no human in the loop (obj 1452).
 *
 * The drain needs host privilege this container's Node process lacks: a docker
 * build on the host daemon, a git worktree + branch fetch on the host checkout
 * (over the repo's SSH remote, whose creds belong to user `mike`), and a sudo
 * Caddy reload. The container DOES have the host Docker socket mounted (same
 * access the deploy UI already uses). So we launch a throwaway privileged
 * container that nsenters the host namespaces (PID 1), then drops to `mike` via
 * `su -` and runs preview-spool-runner.sh there. Running as `mike` (not root) is
 * required: preview-deploy.sh fetches over git@github.com using mike's SSH key,
 * and mike has passwordless sudo for the Caddy steps. The runner is flock
 * single-flight + idempotent, so racing kicks are safe.
 *
 * This makes the systemd cc-preview-spool.path unit OPTIONAL (redundant trigger
 * + boot-drain) rather than a required one-time install. Fire-and-forget and
 * fully best-effort: a missing socket / docker / image never throws into the
 * calling HTTP handler — the job still sits in the spool for the systemd unit
 * or a manual drain to pick up.
 *
 * Disabled by setting PREVIEW_SPOOL_HOST_KICK=0 (e.g. CI / non-host envs).
 * Returns true if a drain was spawned, false if disabled or the spawn failed.
 */
export function kickHostDrain(): boolean {
  if (process.env.PREVIEW_SPOOL_HOST_KICK === '0') return false
  const runner = runnerPath()
  const runAsUser = process.env.PREVIEW_SPOOL_RUN_AS || 'mike'
  // Image carrying nsenter; cached on the host daemon after first pull. No
  // user-controlled values appear in argv (runner path + user are fixed/env,
  // never request data), so there is no injection surface.
  const image = process.env.PREVIEW_SPOOL_KICK_IMAGE || 'alpine:latest'
  try {
    const child = spawn(
      'docker',
      [
        'run', '--rm', '--privileged', '--pid=host', image,
        'nsenter', '-t', '1', '-m', '-u', '-i', '-n', '-p', '--',
        'su', '-', runAsUser, '-c', `bash ${runner}`,
      ],
      { detached: true, stdio: 'ignore' },
    )
    child.on('error', (err) => {
      console.warn('[preview-spool] host-drain kick failed to spawn:', err.message)
    })
    child.unref()
    console.log('[preview-spool] kicked host drain via docker socket')
    return true
  } catch (err) {
    console.warn(
      '[preview-spool] host-drain kick error:',
      err instanceof Error ? err.message : err,
    )
    return false
  }
}

/**
 * Startup health probe (obj 1452). Logs a LOUD warning when the auto-deploy
 * path is silently non-operational, so an unwritable spool or a disabled kick
 * with no systemd fallback does not masquerade as green. Best-effort; never
 * throws. Called once from the server boot path.
 */
export function logPreviewSpoolHealth(): void {
  const dir = previewSpoolDir()
  let writable = false
  try {
    fs.mkdirSync(dir, { recursive: true })
    const probe = path.join(dir, `.health-${process.pid}`)
    fs.writeFileSync(probe, '')
    fs.unlinkSync(probe)
    writable = true
  } catch (err) {
    console.warn(
      `[preview-spool] WARNING: spool dir ${dir} is NOT writable — PR previews ` +
        `will NOT auto-deploy. (${err instanceof Error ? err.message : err})`,
    )
  }
  const kickEnabled = process.env.PREVIEW_SPOOL_HOST_KICK !== '0'
  if (writable && !kickEnabled) {
    console.warn(
      '[preview-spool] WARNING: host-drain kick is DISABLED (PREVIEW_SPOOL_HOST_KICK=0). ' +
        'Auto-deploy now relies on the cc-preview-spool.path systemd unit being installed ' +
        '(scripts/install-preview-spool.sh); otherwise queued previews will never deploy.',
    )
  }
  if (writable && kickEnabled) {
    console.log(`[preview-spool] ready: spool ${dir} writable, host-drain kick enabled`)
  }
}
