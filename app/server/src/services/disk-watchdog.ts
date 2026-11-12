/**
 * Disk watchdog — keep the VPS from filling up so hard that POST /message hangs.
 *
 * Complements scripts/disk-cleanup.sh (cron every 6h). This process:
 *   - reads host df every 5 min
 *   - pages AlertBell at 85% / 90% / <2 GiB, and (high) when free < 15%
 *   - shells out to disk-cleanup.sh at 90%+ (30 min cooldown)
 *   - kicks an extra finished-worktree sweep when free < 15% (obj 718070)
 *
 * Kill switch: CC_DISK_WATCHDOG=false
 */
import { execFile } from 'child_process'
import { insertAlert } from './notifier.js'
import { broadcast } from '../ws/index.js'
import { kickWorktreeSweep } from './worktree-reaper.js'
import {
  diskAction,
  freePct,
  isLowDisk,
  readHostDisk,
  DISK_LOW_FREE_PCT,
  type DiskAction,
  type HostDisk,
} from '../lib/host-disk.js'

const POLL_INTERVAL_MS = 5 * 60 * 1000
const CLEANUP_COOLDOWN_MS = 30 * 60 * 1000
const CLEANUP_TIMEOUT_MS = 3 * 60 * 1000
const CLEANUP_SCRIPT = '/home/operator/projects/operationkit/scripts/disk-cleanup.sh'

let pollTimer: ReturnType<typeof setInterval> | null = null
let lastCleanupMs = 0
let cleanupRunning = false
export interface DiskWatchdogState {
  disk: HostDisk | null
  action: DiskAction
  /** free < DISK_LOW_FREE_PCT of the filesystem (false when df failed). */
  low: boolean
  checkedAt: string
}

let latest: DiskWatchdogState | null = null

/** Last time bucket each alert family fired in (in-process throttle). */
const lastBucket = new Map<string, number>()

/**
 * At most one alert per family per `hours`. The dedup_key is the STABLE family
 * name (obj 900677): it used to embed the time bucket, so an unread "Disk low"
 * gained a twin every 3h. Now the notifier keeps a family to one unread item,
 * and it only comes back in a later bucket after it has been read.
 */
function fireAlert(severity: 'high' | 'normal', title: string, message: string, family: string, hours: number, kind?: string): void {
  const bucket = Math.floor(Date.now() / (hours * 3600 * 1000))
  if (lastBucket.get(family) === bucket) return
  lastBucket.set(family, bucket)
  try {
    const alert = insertAlert({
      severity,
      source: 'disk-watchdog',
      kind,
      title,
      message,
      dedup_key: family,
    })
    if (alert) broadcast({ type: 'alert', payload: alert })
  } catch (err) {
    console.warn('[disk-watchdog] failed to emit alert:', err instanceof Error ? err.message : err)
  }
}

function runCleanup(reason: string): void {
  const now = Date.now()
  if (cleanupRunning) return
  if (now - lastCleanupMs < CLEANUP_COOLDOWN_MS) {
    console.log(`[disk-watchdog] cleanup skipped (cooldown) reason=${reason}`)
    return
  }
  cleanupRunning = true
  lastCleanupMs = now
  console.log(`[disk-watchdog] running disk-cleanup.sh (${reason})`)
  execFile(
    '/bin/bash',
    [CLEANUP_SCRIPT],
    { timeout: CLEANUP_TIMEOUT_MS, env: { ...process.env, DISK_CLEANUP_REASON: reason } },
    (err, stdout, stderr) => {
      cleanupRunning = false
      if (err) {
        console.error('[disk-watchdog] cleanup failed:', err.message, stderr?.trim())
        return
      }
      const out = `${stdout ?? ''}${stderr ?? ''}`.trim()
      if (out) console.log(`[disk-watchdog] cleanup:\n${out}`)
    },
  )
}

function tick(): void {
  const disk = readHostDisk()
  const action: DiskAction = disk ? diskAction(disk) : 'ok'
  const low = disk ? isLowDisk(disk) : false
  latest = { disk, action, low, checkedAt: new Date().toISOString() }
  if (!disk) return

  const availGiB = (disk.availBytes / (1024 * 1024 * 1024)).toFixed(1)
  const summary = `${disk.usedPct}% used, ${availGiB} GiB free`

  // Low-free alert (obj 718070): independent of the used-% ladder below, which
  // keeps its own alerts. Own dedup bucket so it pages at most once per 3h.
  if (low) {
    fireAlert(
      'high',
      `Disk low — ${freePct(disk).toFixed(1)}% free`,
      `${summary} (under ${DISK_LOW_FREE_PCT}% free). Sweeping finished-card worktrees; check /home/operator/projects for leftovers.`,
      'disk-watchdog-low', 3,
    )
    kickWorktreeSweep('low-disk')
  }

  if (action === 'warn') {
    fireAlert(
      'normal',
      `Disk ${disk.usedPct}% full`,
      `${summary}. Cleanup runs at 90%. If this keeps climbing, messages will refuse to send.`,
      'disk-watchdog-warn', 6, 'warn',
    )
    return
  }

  if (action === 'clean' || action === 'block') {
    fireAlert(
      'high',
      action === 'block' ? 'Disk critically full — new messages will fail' : `Disk ${disk.usedPct}% full — cleaning`,
      `${summary}. Running disk-cleanup.sh.`,
      'disk-watchdog-clean', 1,
    )
    runCleanup(action)
  }
}

export function getDiskWatchdogState(): DiskWatchdogState | null {
  return latest
}

/** Latest state, or a fresh df read when the watchdog has not ticked (disabled / boot). */
export function readDiskStateNow(): DiskWatchdogState {
  if (latest) return latest
  const disk = readHostDisk()
  return {
    disk,
    action: disk ? diskAction(disk) : 'ok',
    low: disk ? isLowDisk(disk) : false,
    checkedAt: new Date().toISOString(),
  }
}

export function startDiskWatchdog(): void {
  if (process.env.CC_DISK_WATCHDOG === 'false') {
    console.log('[disk-watchdog] disabled via CC_DISK_WATCHDOG=false')
    return
  }
  if (pollTimer) return
  tick()
  pollTimer = setInterval(tick, POLL_INTERVAL_MS)
  pollTimer.unref()
  console.log(`[disk-watchdog] started (every ${POLL_INTERVAL_MS / 1000}s)`)
}
