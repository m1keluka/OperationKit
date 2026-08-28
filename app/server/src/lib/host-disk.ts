/**
 * Host-disk watermarks for Command Center.
 *
 * The Node process runs in a container; `df /` there is the overlay, not the
 * VPS root. Probe a bind-mount from the host (`/home/operator/projects`) so the
 * numbers match what `df -h /` shows on the droplet.
 *
 * 2026-08-25: the disk hit 100% / 0 bytes free. POST /message hung on the
 * SQLite UPDATE + jsonl append, so the composer looked dead. We now (a) refuse
 * that write with 507 before touching the DB, (b) page + run cleanup at 90%.
 */
import { execFileSync } from 'child_process'

/** Bind-mount that lives on the host root filesystem. */
export const HOST_DF_PATH = '/home/operator/projects'

export const DISK_WARN_PCT = 85
export const DISK_CLEAN_PCT = 90
/** Refuse new session writes when free space drops below this. */
export const DISK_BLOCK_AVAIL_BYTES = 2 * 1024 * 1024 * 1024

export type DiskAction = 'ok' | 'warn' | 'clean' | 'block'

export interface HostDisk {
  usedPct: number
  availBytes: number
  totalBytes: number
}

/**
 * Parse one `df -Pk` data line (POSIX, 1K blocks).
 * Example: `/dev/vda1  811000000  760000000  52000000  94% /`
 */
export function parseDfPkLine(line: string): HostDisk | null {
  const parts = line.trim().split(/\s+/)
  if (parts.length < 5) return null
  const totalK = Number.parseInt(parts[1], 10)
  const availK = Number.parseInt(parts[3], 10)
  const pct = Number.parseInt(String(parts[4]).replace('%', ''), 10)
  if (![totalK, availK, pct].every(n => Number.isFinite(n) && n >= 0)) return null
  return {
    usedPct: pct,
    availBytes: availK * 1024,
    totalBytes: totalK * 1024,
  }
}

export function diskAction(disk: HostDisk): DiskAction {
  if (disk.availBytes < DISK_BLOCK_AVAIL_BYTES) return 'block'
  if (disk.usedPct >= DISK_CLEAN_PCT) return 'clean'
  if (disk.usedPct >= DISK_WARN_PCT) return 'warn'
  return 'ok'
}

export function diskBlockReason(disk: HostDisk): string {
  const availGiB = disk.availBytes / (1024 * 1024 * 1024)
  return `Disk is ${disk.usedPct}% full (${availGiB.toFixed(1)} GiB free). Message not sent. Cleanup is running — retry in a minute.`
}

/** Best-effort. Returns null if df fails (fail open for non-write paths). */
export function readHostDisk(dfPath: string = HOST_DF_PATH): HostDisk | null {
  try {
    const out = execFileSync('df', ['-Pk', dfPath], {
      encoding: 'utf-8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    const lines = out.split('\n')
    const data = lines[lines.length - 1]
    return parseDfPkLine(data)
  } catch {
    return null
  }
}
