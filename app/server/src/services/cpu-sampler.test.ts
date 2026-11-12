import { describe, it, expect } from 'vitest'
import { sumCpuTimes, usageBetween, breakdownBetween, summarise, createCpuSampler, type CpuTotals, type Sample } from './cpu-sampler.js'

const T = (busy: { user?: number; nice?: number; sys?: number; irq?: number }, idle: number): CpuTotals => {
  const t = { user: busy.user ?? 0, nice: busy.nice ?? 0, sys: busy.sys ?? 0, irq: busy.irq ?? 0, idle }
  return { ...t, total: t.user + t.nice + t.sys + t.irq + t.idle }
}

describe('cpu-sampler (obj 900685)', () => {
  it('sums every core', () => {
    const c = { times: { user: 1, nice: 2, sys: 3, idle: 4, irq: 0 } }
    expect(sumCpuTimes([c, c])).toEqual({ user: 2, nice: 4, sys: 6, idle: 8, irq: 0, total: 20 })
  })

  it('counts niced session time as busy and splits it out', () => {
    const a = T({}, 0)
    const b = T({ nice: 30, sys: 15, user: 5 }, 50)
    expect(usageBetween(a, b)).toBe(50)
    expect(breakdownBetween(a, b)).toEqual({ sessions: 30, kernel: 15, other: 5 })
  })

  it('returns null on a zero-length window', () => {
    expect(usageBetween(T({}, 5), T({}, 5))).toBeNull()
  })

  it('reports a 10s average, the minute average and the worst 2s interval', () => {
    // 60s of history: one 2s burst at 100%, otherwise 10% busy.
    const samples: Sample[] = []
    let busy = 0, idle = 0
    for (let i = 0; i <= 30; i++) {
      if (i > 0) {
        const burst = i === 5
        busy += burst ? 200 : 20
        idle += burst ? 0 : 180
      }
      samples.push({ at: i * 2000, totals: T({ nice: busy }, idle) })
    }
    const s = summarise(samples, 60_000)!
    expect(s.peak1mPercent).toBe(100)
    expect(s.usagePercent).toBe(10)          // the burst is outside the last 10s
    expect(s.windowSeconds).toBe(10)
    expect(s.avg1mPercent).toBe(13)          // (29*20+200) / (30*200)
    expect(s.breakdown).toEqual({ sessions: 10, kernel: 0, other: 0 })
  })

  it('needs two samples before it has an answer', () => {
    expect(summarise([{ at: 0, totals: T({}, 1) }], 0)).toBeNull()
  })

  it('starts lazily, keeps a bounded window and stops when nobody reads', () => {
    let now = 0, n = 0
    const s = createCpuSampler({ read: () => T({ nice: ++n }, n), now: () => now, intervalMs: 1e9, keepMs: 10_000, idleStopMs: 30_000 })
    expect(s.get()).toBeNull()               // cold: first sample only
    expect(s.size).toBe(1)
    for (let i = 0; i < 10; i++) { now += 2000; s.tick() }
    expect(s.size).toBe(6)                   // 10s window kept
    expect(s.get()!.usagePercent).toBe(50)
    now += 40_000; s.tick()                  // no reads for 40s
    expect(s.size).toBe(0)
    s.stop()
  })
})
