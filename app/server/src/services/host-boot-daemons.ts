/**
 * host-boot.d runner (obj 704925).
 *
 * WHY THIS EXISTS
 * ---------------
 * This container has no cron, no crond, no crontab(1), no systemd (`systemctl` is on PATH
 * but /run/systemd/system does not exist), no supervisord, no runsvdir, no s6, no monit,
 * no at, no anacron and no incron. Verified 2026-08-07.
 *
 * PID 1 is `docker-init -- docker-entrypoint.sh bash /app/entrypoint.sh`, and that
 * entrypoint is a bare `while true; do tsx server/src/index.ts || true; sleep 2; done`.
 * /app/entrypoint.sh is root-owned and not writable by ccuser, but /app/server/src is a
 * bind mount of the live checkout at
 * /home/operator/projects/command-center-infra/app/server/src (same device:inode).
 *
 * => THIS SERVER'S BOOT PATH IS THE ONLY ccuser-CONTROLLABLE CODE GUARANTEED TO RUN AFTER
 *    A CONTAINER RESTART. Every other "daemon" on this host is a setsid-detached orphan
 *    that dies with the container and has to be relaunched by hand. That is how the EXAMPLE2
 *    legacy-sync poller went down for 21.5 hours on 2026-08-06 without anyone noticing.
 *
 * WHAT IT DOES
 * ------------
 * Shells out to /home/operator/ai-workspace/host-boot.d/run-all.sh at boot and every
 * HOST_BOOT_TICK_MS. That script runs every executable NN-*.sh in that directory; each one
 * is flock-guarded, so a re-run while the daemon is already up is a cheap no-op. The
 * periodic tick makes this a watchdog as well as a boot hook: a daemon whose own supervisor
 * died is brought back on the next tick, without waiting for a container restart.
 *
 * DELIBERATELY THIN. All the actual daemon logic lives in host-boot.d, outside this repo,
 * so adding or changing a supervised daemon needs no CC deploy. This file should not need
 * to change again.
 *
 * Kill switch: HOST_BOOT_DAEMONS_ENABLED=false disables it entirely.
 */
import { execFile } from 'child_process'

const RUN_ALL = '/home/operator/ai-workspace/host-boot.d/run-all.sh'
const TICK_MS = Number(process.env.HOST_BOOT_TICK_MS ?? 5 * 60 * 1000)
const EXEC_TIMEOUT_MS = 90_000

let timer: ReturnType<typeof setInterval> | null = null

function tick(invoker: string): void {
  execFile(
    '/bin/bash',
    [RUN_ALL],
    { timeout: EXEC_TIMEOUT_MS, env: { ...process.env, HOST_BOOT_INVOKER: invoker } },
    (err, stdout, stderr) => {
      if (err) {
        // Never throw: a failing host daemon must not take the CC server down with it.
        console.error(`[host-boot] run-all failed (${invoker}):`, err.message, stderr?.trim())
        return
      }
      const out = `${stdout ?? ''}${stderr ?? ''}`.trim()
      if (out) console.log(`[host-boot] ${invoker}: ${out}`)
    },
  )
}

export function startHostBootDaemons(): void {
  if (process.env.HOST_BOOT_DAEMONS_ENABLED === 'false') {
    console.log('[host-boot] disabled via HOST_BOOT_DAEMONS_ENABLED=false')
    return
  }
  if (timer) return

  console.log(`[host-boot] ensuring host-boot.d daemons at boot, re-checking every ${TICK_MS / 1000}s`)
  tick('boot')
  timer = setInterval(() => tick('tick'), TICK_MS)
  timer.unref()
}
