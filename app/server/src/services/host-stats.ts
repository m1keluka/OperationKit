/**
 * Host stats for the System page (GET /api/admin/system) — obj 900495.
 *
 * Every number is read from the kernel (/proc, statfs), never from a spawned
 * shell, and each helper is a pure parser so the math is unit-tested against
 * fixtures captured from a real host.
 *
 * What was wrong before (verified against /proc on a running host):
 *  - Process count was `ps aux | wc -l` − 1: it counted its own sh/ps/wc (+2)
 *    and, inside a container, only the container's PID namespace — while being
 *    shown next to host-wide CPU/memory/uptime as if it were host-wide.
 *  - Memory relied on os.freemem(). On Node ≥ 20 that is MemAvailable (correct);
 *    on older runtimes it is MemFree, which counts page cache as "used" and
 *    reads ~95% on an idle box. We now read MemAvailable explicitly.
 *  - Hostname is a random container id under Docker; we flag that so the UI
 *    does not present it as the machine's name.
 */
import fs from 'fs'
import os from 'os'

export interface MemoryStats { total: number; used: number; free: number; usagePercent: number }
export interface DiskStats { total: number; used: number; available: number; usagePercent: number }

/** Parse /proc/meminfo → bytes. Uses MemAvailable (what `free` calls "available"). */
export function parseMeminfo(text: string): { total: number; available: number } | null {
  const kb = (key: string) => {
    const m = text.match(new RegExp(`^${key}:\\s+(\\d+)\\s*kB`, 'm'))
    return m ? Number(m[1]) * 1024 : null
  }
  const total = kb('MemTotal')
  const available = kb('MemAvailable')
  if (total == null || available == null || total <= 0) return null
  return { total, available }
}

export function memoryStats(meminfo: string | null): MemoryStats {
  const parsed = meminfo ? parseMeminfo(meminfo) : null
  const total = parsed?.total ?? os.totalmem()
  const free = parsed?.available ?? os.freemem()
  const used = Math.max(0, total - free)
  return { total, used, free, usagePercent: total > 0 ? Math.round((used / total) * 1000) / 10 : 0 }
}

/**
 * Disk usage from statfs, with exactly df's arithmetic: used = blocks − bfree,
 * Use% = used ÷ (used + bavail), rounded UP (reserved root blocks excluded).
 */
export function diskStats(s: { bsize: number; blocks: number; bfree: number; bavail: number }): DiskStats {
  const total = s.blocks * s.bsize
  const used = (s.blocks - s.bfree) * s.bsize
  const available = s.bavail * s.bsize
  const denom = used + available
  return { total, used, available, usagePercent: denom > 0 ? Math.ceil((used / denom) * 100) : 0 }
}

/** Count of processes in /proc (numeric entries) — what `ps -e` lists, without spawning ps. */
export function countProcesses(entries: string[]): number {
  return entries.filter(e => /^\d+$/.test(e)).length
}

/** True when the server runs inside a container (Docker / Podman / k8s). */
export function detectContainer(exists: (p: string) => boolean = fs.existsSync, cgroup: string | null = readOrNull('/proc/1/cgroup')): boolean {
  if (exists('/.dockerenv') || exists('/run/.containerenv')) return true
  return !!cgroup && /(docker|containerd|kubepods|libpod)/.test(cgroup)
}

function readOrNull(p: string): string | null {
  try { return fs.readFileSync(p, 'utf-8') } catch { return null }
}

export function readMemory(): MemoryStats {
  return memoryStats(readOrNull('/proc/meminfo'))
}

export function readDisk(path = '/'): DiskStats {
  try {
    const s = fs.statfsSync(path)
    return diskStats({ bsize: s.bsize, blocks: s.blocks, bfree: s.bfree, bavail: s.bavail })
  } catch {
    return { total: 0, used: 0, available: 0, usagePercent: 0 }
  }
}

export function readProcessCount(): number {
  try { return countProcesses(fs.readdirSync('/proc')) } catch { return 0 }
}
