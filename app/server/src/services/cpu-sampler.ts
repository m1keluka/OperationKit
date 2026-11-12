/**
 * Host CPU for the System page (GET /api/admin/system) — obj 900685.
 *
 * Before this, the route took ONE 500ms snapshot per request. The number was
 * real (host-wide /proc/stat via os.cpus(), every core, every container) but a
 * 500ms window on a 32-core box running build/test-heavy sessions swings hard:
 * measured on the OVH host on 2026-11-12 it went 17% → 59% within one minute
 * while the since-boot average was ~1.2%. A single unlucky poll read as "CPU
 * maxed out" with nothing on the page saying what was using it.
 *
 * Now a light in-process sampler (one os.cpus() read every 2s, only while the
 * page is being polled) keeps the last minute and reports:
 *  - usagePercent: average over the last ~10s (what the bar shows)
 *  - avg1mPercent / peak1mPercent: the minute's average and worst 2s interval
 *  - breakdown: sessions (niced — every worker session renices itself to 15,
 *    see session-tmux.ts), kernel (sys + irq) and other (un-niced user time:
 *    the Node server and anything else at nice 0)
 */
import os from 'os'

export interface CpuTotals { user: number; nice: number; sys: number; idle: number; irq: number; total: number }

export interface CpuBreakdown { sessions: number; kernel: number; other: number }

export interface CpuUsage {
  usagePercent: number
  avg1mPercent: number | null
  peak1mPercent: number | null
  breakdown: CpuBreakdown | null
  windowSeconds: number
}

/** Sum per-core cumulative times into one host-wide total. */
export function sumCpuTimes(cpus: Array<{ times: { user: number; nice: number; sys: number; idle: number; irq: number } }>): CpuTotals {
  const t = { user: 0, nice: 0, sys: 0, idle: 0, irq: 0, total: 0 }
  for (const c of cpus) {
    t.user += c.times.user
    t.nice += c.times.nice
    t.sys += c.times.sys
    t.idle += c.times.idle
    t.irq += c.times.irq
  }
  t.total = t.user + t.nice + t.sys + t.idle + t.irq
  return t
}

const r1 = (n: number) => Math.round(n * 10) / 10

/** Busy % between two cumulative snapshots. Only idle counts as free, so niced session work is busy. */
export function usageBetween(a: CpuTotals, b: CpuTotals): number | null {
  const total = b.total - a.total
  if (!(total > 0)) return null
  return r1((1 - (b.idle - a.idle) / total) * 100)
}

/** Who used the CPU between two snapshots, as % of all CPU time. */
export function breakdownBetween(a: CpuTotals, b: CpuTotals): CpuBreakdown | null {
  const total = b.total - a.total
  if (!(total > 0)) return null
  const pct = (n: number) => r1((n / total) * 100)
  return {
    sessions: pct(b.nice - a.nice),
    kernel: pct(b.sys - a.sys + b.irq - a.irq),
    other: pct(b.user - a.user),
  }
}

export interface Sample { at: number; totals: CpuTotals }

/** Summarise a window of snapshots (oldest first). Needs at least two. */
export function summarise(samples: Sample[], now: number, recentMs = 10_000): CpuUsage | null {
  if (samples.length < 2) return null
  const last = samples[samples.length - 1]
  const first = samples[0]
  // Oldest sample still inside the recent window (but never the last one itself).
  let recentStart = samples[samples.length - 2]
  for (const s of samples) {
    if (s !== last && now - s.at <= recentMs) { recentStart = s; break }
  }
  let peak: number | null = null
  for (let i = 1; i < samples.length; i++) {
    const u = usageBetween(samples[i - 1].totals, samples[i].totals)
    if (u != null && (peak == null || u > peak)) peak = u
  }
  const usage = usageBetween(recentStart.totals, last.totals)
  if (usage == null) return null
  return {
    usagePercent: usage,
    avg1mPercent: usageBetween(first.totals, last.totals),
    peak1mPercent: peak,
    breakdown: breakdownBetween(recentStart.totals, last.totals),
    windowSeconds: Math.round((last.at - recentStart.at) / 1000),
  }
}

export interface SamplerOptions {
  read?: () => CpuTotals
  now?: () => number
  intervalMs?: number
  keepMs?: number
  idleStopMs?: number
}

/**
 * Lazily-started sampler. The first `get()` starts a 2s timer; it stops itself
 * after `idleStopMs` with no reads, so nothing runs while nobody is on the page.
 */
export function createCpuSampler(opts: SamplerOptions = {}) {
  const read = opts.read ?? (() => sumCpuTimes(os.cpus()))
  const now = opts.now ?? Date.now
  const intervalMs = opts.intervalMs ?? 2000
  const keepMs = opts.keepMs ?? 62_000
  const idleStopMs = opts.idleStopMs ?? 5 * 60_000
  let samples: Sample[] = []
  let timer: ReturnType<typeof setInterval> | null = null
  let lastRead = 0

  const tick = () => {
    const t = now()
    samples.push({ at: t, totals: read() })
    samples = samples.filter(s => t - s.at <= keepMs)
    if (t - lastRead > idleStopMs) stop()
  }
  const stop = () => {
    if (timer) clearInterval(timer)
    timer = null
    samples = []
  }
  const start = () => {
    if (timer) return
    tick()
    timer = setInterval(tick, intervalMs)
    timer.unref?.()
  }

  return {
    /** Summary from history, or null when there is not enough yet (caller falls back). */
    get(): CpuUsage | null {
      lastRead = now()
      start()
      return summarise(samples, lastRead)
    },
    tick,
    stop,
    get size() { return samples.length },
  }
}

const shared = createCpuSampler()

/** Route helper: sampler summary, or a one-off 500ms sample on a cold start. */
export async function readCpuUsage(): Promise<CpuUsage> {
  const fromHistory = shared.get()
  if (fromHistory) return fromHistory
  const a = sumCpuTimes(os.cpus())
  await new Promise(resolve => setTimeout(resolve, 500))
  const b = sumCpuTimes(os.cpus())
  return {
    usagePercent: usageBetween(a, b) ?? 0,
    avg1mPercent: null,
    peak1mPercent: null,
    breakdown: breakdownBetween(a, b),
    windowSeconds: 0.5,
  }
}
