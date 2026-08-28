import { describe, it, expect } from 'vitest'
import {
  parseDfPkLine,
  diskAction,
  DISK_BLOCK_AVAIL_BYTES,
} from './host-disk.js'

describe('parseDfPkLine', () => {
  it('parses a POSIX df -Pk data line', () => {
    const disk = parseDfPkLine('/dev/vda1  811000000  760000000  52000000  94% /')
    expect(disk).toEqual({
      usedPct: 94,
      availBytes: 52000000 * 1024,
      totalBytes: 811000000 * 1024,
    })
  })

  it('parses 100% / 0 available (the 2026-08-25 outage)', () => {
    const disk = parseDfPkLine('/dev/vda1 811000000 811000000 0 100% /')
    expect(disk?.usedPct).toBe(100)
    expect(disk?.availBytes).toBe(0)
    expect(diskAction(disk!)).toBe('block')
  })

  it('returns null on garbage', () => {
    expect(parseDfPkLine('')).toBeNull()
    expect(parseDfPkLine('Filesystem')).toBeNull()
  })
})

describe('diskAction', () => {
  const giB = 1024 * 1024 * 1024
  const at = (usedPct: number, availGiB: number) =>
    diskAction({ usedPct, availBytes: availGiB * giB, totalBytes: 774 * giB })

  it('is ok under 85%', () => {
    expect(at(50, 400)).toBe('ok')
    expect(at(84, 100)).toBe('ok')
  })

  it('warns at 85–89% when plenty of bytes remain', () => {
    expect(at(85, 100)).toBe('warn')
    expect(at(89, 80)).toBe('warn')
  })

  it('cleans at 90%+ when still above the byte floor', () => {
    expect(at(90, 50)).toBe('clean')
    expect(at(94, 49)).toBe('clean')
  })

  it('blocks when free space is under 2 GiB, even if percent looks fine', () => {
    expect(DISK_BLOCK_AVAIL_BYTES).toBe(2 * giB)
    expect(at(50, 1.5)).toBe('block')
    expect(at(99, 0)).toBe('block')
    expect(at(94, 2)).toBe('clean') // exactly 2 GiB is still writable
  })
})
