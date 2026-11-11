import { describe, it, expect } from 'vitest'
import { execSync } from 'child_process'
import fs from 'fs'
import {
  parseMeminfo,
  memoryStats,
  diskStats,
  countProcesses,
  detectContainer,
  readDisk,
  readMemory,
} from './host-stats.js'

// Captured from a real 256 GB host (obj 900495 verification). MemFree is tiny
// because the page cache is large; MemAvailable is what is actually free.
const MEMINFO = `MemTotal:       263979332 kB
MemFree:        13666532 kB
MemAvailable:   256503320 kB
Buffers:          1229440 kB
Cached:         232129228 kB
`

describe('host-stats (obj 900495)', () => {
  it('memory uses MemAvailable, not MemFree (page cache is not "used")', () => {
    const m = memoryStats(MEMINFO)
    expect(m.total).toBe(263979332 * 1024)
    expect(m.free).toBe(256503320 * 1024)
    expect(m.usagePercent).toBe(2.8)
    // The MemFree reading would have claimed ~94.8% used on an idle box.
    const wrong = Math.round(((263979332 - 13666532) / 263979332) * 1000) / 10
    expect(wrong).toBeGreaterThan(90)
  })

  it('parseMeminfo rejects input without MemAvailable', () => {
    expect(parseMeminfo('MemTotal: 100 kB\nMemFree: 10 kB\n')).toBeNull()
  })

  it('disk uses df arithmetic: used/(used+avail), rounded up', () => {
    // df -B1 / on the same host: 941723856896 total, 335487381504 used, 558324105216 avail, 38%
    const bsize = 4096
    const d = diskStats({
      bsize,
      blocks: 941723856896 / bsize,
      bfree: (941723856896 - 335487381504) / bsize,
      bavail: 558324105216 / bsize,
    })
    expect(d.total).toBe(941723856896)
    expect(d.used).toBe(335487381504)
    expect(d.available).toBe(558324105216)
    expect(d.usagePercent).toBe(38)
  })

  it('process count only counts numeric /proc entries', () => {
    expect(countProcesses(['1', '42', 'self', 'meminfo', 'sys', '1001'])).toBe(3)
  })

  it('detects a container from /.dockerenv or the cgroup path', () => {
    expect(detectContainer(p => p === '/.dockerenv', null)).toBe(true)
    expect(detectContainer(() => false, '0::/system.slice/docker-abc.scope')).toBe(true)
    expect(detectContainer(() => false, '0::/init.scope')).toBe(false)
  })

  // Live cross-check against the kernel / coreutils on whatever box runs the suite.
  const linux = process.platform === 'linux' && fs.existsSync('/proc/meminfo')
  it.skipIf(!linux)('live: readDisk matches `df -B1 /` (total exact, Use% within 1)', () => {
    let row: string[]
    try {
      row = execSync('df -B1 / | tail -1', { encoding: 'utf-8' }).trim().split(/\s+/)
    } catch {
      return // no df in this environment
    }
    const d = readDisk('/')
    expect(d.total).toBe(Number(row[1]))
    expect(Math.abs(d.usagePercent - parseInt(row[4]))).toBeLessThanOrEqual(1)
  })

  it.skipIf(!linux)('live: readMemory total matches /proc/meminfo MemTotal', () => {
    const parsed = parseMeminfo(fs.readFileSync('/proc/meminfo', 'utf-8'))!
    expect(readMemory().total).toBe(parsed.total)
  })
})
