/**
 * n8n watchdog — internal deep-health probe + self-healing for the self-hosted
 * n8n automation stack (containers `n8n` + optional `n8n-db`).
 *
 * Why this exists: on 2026-06-20 the host rebooted and the n8n containers (despite
 * `restart: unless-stopped`) never came back. They sat dead for 5 days because
 * nothing watched them and the only signal would have been an automation silently
 * not firing. This watchdog closes that gap from inside the command-center
 * container, which runs as root with the Docker socket mounted, so it can both
 * observe (`docker inspect`) and remediate (`docker start`) sibling containers.
 *
 * Up/down signal: n8n is bound to the HOST's 127.0.0.1:5678, which the
 * command-center container cannot reach directly. But the n8n container defines
 * its own healthcheck (`wget healthz`), so `docker inspect`'s State.Health.Status
 * is the authoritative liveness signal — no in-container HTTP probe needed. When
 * `N8N_PUBLIC_URL` is set we additionally GET `<N8N_PUBLIC_URL>/healthz` to verify
 * end-to-end reachability, but that is advisory only. Unset (or a placeholder such
 * as n8n.example.com) = no public probe and no link on the alert.
 *
 * Hosts without n8n (obj 900746): most installs — including the OSS/OVH install —
 * have no `n8n` container at all. `startN8nWatchdog()` checks once at boot and does
 * NOT start when the container is absent, and even a running watchdog classifies an
 * absent container as `absent` and never alerts on it. `degraded` is reserved for a
 * present-but-unhealthy instance. `N8N_WATCHDOG=0` turns it off, `=1` forces it on.
 *
 * Alerts: AlertBell-only by design (insertAlert + WS broadcast). No email/Telegram.
 */
import { execSync } from 'child_process'
import { insertAlert } from './notifier.js'
import { broadcast } from '../ws/index.js'

const POLL_INTERVAL_MS = 30 * 1000
// Don't hammer `docker start` in a loop if a container keeps dying — wait this
// long between remediation attempts.
const RESTART_COOLDOWN_MS = 5 * 60 * 1000
// Host filesystem visible via the bind-mounted projects dir — `df` of an overlay
// path inside the container would report the container fs, not the host's 240GB
// root, so probe a path we know is bind-mounted from the host.
const HOST_DF_PATH = '/home/operator/projects'

export interface ContainerState {
  name: string
  exists: boolean
  status: string          // running | exited | created | dead | restarting | unknown
  health: string          // healthy | unhealthy | starting | none | unknown
  exitCode: number | null
  running: boolean
}

export interface N8nHealth {
  ok: boolean
  // absent = no `n8n` container on this host (not installed). Never alerted on.
  status: 'up' | 'degraded' | 'down' | 'absent'
  checkedAt: string
  n8n: ContainerState
  n8nDb: ContainerState
  // configured=false when N8N_PUBLIC_URL is unset or a placeholder: probe skipped.
  publicHealthz: { configured: boolean; ok: boolean; httpCode: number | null; ms: number | null }
  host: { diskUsedPct: number | null; loadAvg1: number | null }
  lastAutoRestart: { at: string; success: boolean; detail: string } | null
  lastError: string | null
}

type AlertArgs = Parameters<typeof insertAlert>[0]

/** Injectable side effects, so tests never touch Docker, the network or the DB. */
export interface N8nWatchdogDeps {
  inspect: (name: string) => ContainerState
  fetchHealthz: (url: string) => Promise<{ ok: boolean; httpCode: number | null; ms: number | null }>
  emitAlert: (alert: AlertArgs) => void
  env: NodeJS.ProcessEnv
}

let latest: N8nHealth | null = null
let pollTimer: ReturnType<typeof setInterval> | null = null
let lastRestartAttemptMs = 0
let alertedDown = false
let lastAutoRestart: N8nHealth['lastAutoRestart'] = null

function sh(cmd: string, timeoutMs = 12_000): string {
  return execSync(cmd, { encoding: 'utf-8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'ignore'] }).trim()
}

function shSafe(cmd: string, timeoutMs = 12_000): string | null {
  try {
    return sh(cmd, timeoutMs)
  } catch {
    return null
  }
}

function inspectContainer(name: string): ContainerState {
  // Single format string returns: status|health|exitCode. `docker inspect` exits
  // non-zero if the container doesn't exist at all.
  const out = shSafe(
    `docker inspect -f '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}|{{.State.ExitCode}}' ${name}`,
  )
  if (out === null) {
    return { name, exists: false, status: 'absent', health: 'none', exitCode: null, running: false }
  }
  const [status = 'unknown', health = 'unknown', exitRaw = ''] = out.split('|')
  const exitCode = exitRaw === '' ? null : Number.parseInt(exitRaw, 10)
  return {
    name,
    exists: true,
    status,
    health,
    exitCode: Number.isFinite(exitCode as number) ? exitCode : null,
    running: status === 'running',
  }
}

const defaultDeps: N8nWatchdogDeps = {
  inspect: inspectContainer,
  fetchHealthz: url => {
    const started = Date.now()
    return fetch(url, { method: 'GET', signal: AbortSignal.timeout(8000) })
      .then(res => ({ ok: res.ok, httpCode: res.status, ms: Date.now() - started }))
      .catch(() => ({ ok: false, httpCode: null, ms: null }))
  },
  emitAlert: args => {
    const alert = insertAlert(args)
    // AlertBell-only: persist to the alerts table (AlertBell polls it) and push
    // over WS for instant display. No email/Telegram.
    if (alert) broadcast({ type: 'alert', payload: alert })
  },
  env: process.env,
}
let deps: N8nWatchdogDeps = defaultDeps

/** Test seam: override side effects and reset module state. Call with nothing to restore. */
export function __setN8nWatchdogDepsForTest(override?: Partial<N8nWatchdogDeps>): void {
  deps = { ...defaultDeps, ...(override ?? {}) }
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = null
  latest = null
  lastRestartAttemptMs = 0
  alertedDown = false
  lastAutoRestart = null
}

/**
 * The public n8n base URL from `N8N_PUBLIC_URL`, or null when it is unset, not an
 * http(s) URL, or a documentation placeholder (example.com/.org/.net, *.example,
 * *.invalid, *.test). A placeholder is never probed and never linked from an alert.
 */
export function resolveN8nPublicUrl(env: NodeJS.ProcessEnv = deps.env): string | null {
  const raw = (env.N8N_PUBLIC_URL ?? '').trim()
  if (!raw) return null
  let u: URL
  try { u = new URL(raw) } catch { return null }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
  const host = u.hostname.toLowerCase()
  if (host === 'example' || /(^|\.)example\.(com|org|net)$/.test(host) || /\.(example|invalid|test)$/.test(host)) return null
  return `${u.origin}${u.pathname}`.replace(/\/+$/, '')
}

/** N8N_WATCHDOG: 0/false/off/no = disabled, 1/true/on/yes = forced on, else auto-detect. */
function watchdogMode(env: NodeJS.ProcessEnv): 'off' | 'on' | 'auto' {
  const v = (env.N8N_WATCHDOG ?? '').trim().toLowerCase()
  if (['0', 'false', 'off', 'no'].includes(v)) return 'off'
  if (['1', 'true', 'on', 'yes'].includes(v)) return 'on'
  return 'auto'
}

/** True when an `n8n` container exists on this host (running or not). */
export function isN8nInstalled(): boolean {
  return deps.inspect('n8n').exists
}

async function checkPublicHealthz(): Promise<N8nHealth['publicHealthz']> {
  const base = resolveN8nPublicUrl()
  if (!base) return { configured: false, ok: false, httpCode: null, ms: null }
  const r = await deps.fetchHealthz(`${base}/healthz`)
  return { configured: true, ...r }
}

function readHost(): N8nHealth['host'] {
  let diskUsedPct: number | null = null
  let loadAvg1: number | null = null
  // df -P prints a stable POSIX format; the 5th column of the data row is "NN%".
  const df = shSafe(`df -P ${HOST_DF_PATH} | tail -1`)
  if (df) {
    const m = df.match(/(\d+)%/)
    if (m) diskUsedPct = Number.parseInt(m[1], 10)
  }
  const load = shSafe('cat /proc/loadavg')
  if (load) {
    const first = Number.parseFloat(load.split(/\s+/)[0])
    if (Number.isFinite(first)) loadAvg1 = first
  }
  return { diskUsedPct, loadAvg1 }
}

// No `n8n` container = n8n is not installed here: 'absent', never alerted on. n8n-db
// is optional (n8n can run on SQLite) and only counts when it exists. A present
// container is "down" if it isn't running, and "degraded" only if it runs but its own
// healthcheck reports unhealthy. n8n-db has no app-level health beyond pg_isready,
// which IS its healthcheck, so the same logic applies.
export function deriveStatus(n8n: ContainerState, n8nDb: ContainerState): N8nHealth['status'] {
  if (!n8n.exists) return 'absent'
  const dbDown = n8nDb.exists && !n8nDb.running
  const n8nDown = !n8n.running
  if (n8nDown || dbDown) return 'down'
  const degraded = n8n.health === 'unhealthy' || (n8nDb.exists && n8nDb.health === 'unhealthy')
  if (degraded) return 'degraded'
  return 'up'
}

function attemptRestart(n8n: ContainerState, n8nDb: ContainerState): { success: boolean; detail: string } {
  const steps: string[] = []
  try {
    if (n8nDb.exists && !n8nDb.running) {
      sh('docker start n8n-db', 20_000)
      steps.push('started n8n-db')
      // Give Postgres a moment to accept connections before n8n starts.
      try { sh('sleep 4', 8_000) } catch { /* sleep interrupt is harmless */ }
    }
    if (n8n.exists && !n8n.running) {
      sh('docker start n8n', 20_000)
      steps.push('started n8n')
    }
    if (steps.length === 0) steps.push('nothing to restart (already running)')
    return { success: true, detail: steps.join('; ') }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { success: false, detail: `${steps.join('; ') || 'no steps'} — failed: ${msg}`.slice(0, 500) }
  }
}

function fireAlert(severity: 'high' | 'normal', title: string, message: string, dedupKey: string, extra: { kind?: string; resolves?: string } = {}): void {
  try {
    // Link only to a real, configured n8n URL — never a placeholder.
    const url = resolveN8nPublicUrl()
    deps.emitAlert({
      severity,
      source: 'n8n-watchdog',
      ...extra,
      title,
      message,
      dedup_key: dedupKey,
      ...(url ? { url: `${url}/` } : {}),
    })
  } catch (err) {
    console.warn('[n8n-watchdog] failed to emit alert:', err instanceof Error ? err.message : err)
  }
}

async function runCheck(): Promise<void> {
  let lastError: string | null = null
  const n8n = deps.inspect('n8n')
  const n8nDb = deps.inspect('n8n-db')
  // Not installed: nothing to probe, restart or page about.
  const publicHealthz: N8nHealth['publicHealthz'] = n8n.exists
    ? await checkPublicHealthz()
    : { configured: resolveN8nPublicUrl() !== null, ok: false, httpCode: null, ms: null }
  const host = readHost()

  // Self-heal: only when a present container is actually stopped, and only outside the
  // cooldown window (so a crash-looping container doesn't trigger a restart storm).
  const containerStopped = n8n.exists && (!n8n.running || (n8nDb.exists && !n8nDb.running))
  if (containerStopped) {
    const now = Date.now()
    if (now - lastRestartAttemptMs >= RESTART_COOLDOWN_MS) {
      lastRestartAttemptMs = now
      const result = attemptRestart(n8n, n8nDb)
      lastAutoRestart = { at: new Date().toISOString(), success: result.success, detail: result.detail }
      console.log(`[n8n-watchdog] auto-restart ${result.success ? 'ok' : 'FAILED'}: ${result.detail}`)
      // Re-inspect so the snapshot + alert reflect the post-restart reality.
      const n8nAfter = deps.inspect('n8n')
      const n8nDbAfter = deps.inspect('n8n-db')
      n8n.status = n8nAfter.status; n8n.health = n8nAfter.health; n8n.running = n8nAfter.running; n8n.exitCode = n8nAfter.exitCode
      n8nDb.status = n8nDbAfter.status; n8nDb.health = n8nDbAfter.health; n8nDb.running = n8nDbAfter.running; n8nDb.exitCode = n8nDbAfter.exitCode
    } else {
      lastError = 'container down but within restart cooldown — not retrying yet'
    }
  }

  const finalStatus = deriveStatus(n8n, n8nDb)
  const finalOk = finalStatus === 'up'
  // Only a PRESENT instance that is down or unhealthy pages. 'absent' never does.
  const alertable = finalStatus === 'down' || finalStatus === 'degraded'

  latest = {
    ok: finalOk,
    status: finalStatus,
    checkedAt: new Date().toISOString(),
    n8n,
    n8nDb,
    publicHealthz,
    host,
    lastAutoRestart,
    lastError,
  }

  // Edge-triggered alerting: page once on down, once on recovery.
  if (alertable && !alertedDown) {
    alertedDown = true
    const restartLine = lastAutoRestart
      ? `\nAuto-restart: ${lastAutoRestart.success ? 'succeeded' : 'FAILED'} — ${lastAutoRestart.detail}`
      : ''
    const dbPart = n8nDb.exists ? `${n8nDb.status}/${n8nDb.health}` : 'not present'
    const healthzPart = publicHealthz.configured ? (publicHealthz.httpCode ?? 'unreachable') : 'not configured'
    fireAlert(
      'high',
      finalStatus === 'down' ? 'n8n is DOWN' : 'n8n is degraded',
      `n8n=${n8n.status}/${n8n.health}, n8n-db=${dbPart}, public healthz=${healthzPart}.${restartLine}`,
      'n8n-watchdog-down',
    )
  } else if (finalOk && alertedDown) {
    alertedDown = false
    fireAlert(
      'normal',
      'n8n recovered',
      `n8n is back up (n8n=${n8n.status}/${n8n.health}, n8n-db=${n8nDb.exists ? `${n8nDb.status}/${n8nDb.health}` : 'not present'}).`,
      'n8n-watchdog-up',
      { kind: 'recovered', resolves: 'n8n-watchdog-down' },
    )
  }
}

export function getN8nHealth(): N8nHealth | null {
  return latest
}

/** Force an immediate check (used by the manual restart endpoint to refresh). */
export async function refreshN8nHealth(): Promise<N8nHealth | null> {
  await runCheck().catch(err => console.warn('[n8n-watchdog] refresh failed:', err))
  return latest
}

/** Manual remediation trigger (admin endpoint). Bypasses the cooldown. */
export function manualRestart(): { success: boolean; detail: string } {
  const n8n = deps.inspect('n8n')
  const n8nDb = deps.inspect('n8n-db')
  if (!n8n.exists) return { success: false, detail: 'n8n is not installed on this host (no n8n container)' }
  lastRestartAttemptMs = Date.now()
  const result = attemptRestart(n8n, n8nDb)
  lastAutoRestart = { at: new Date().toISOString(), success: result.success, detail: `manual: ${result.detail}` }
  return result
}

/**
 * Start the 30s poll. Returns false and starts nothing when disabled with
 * N8N_WATCHDOG=0, or (auto mode) when this host has no `n8n` container — so a host
 * without n8n never pages "n8n is degraded/DOWN" on boot.
 */
export function startN8nWatchdog(): boolean {
  if (pollTimer) return true
  const mode = watchdogMode(deps.env)
  if (mode === 'off') {
    console.log('[n8n-watchdog] disabled (N8N_WATCHDOG=0)')
    return false
  }
  if (mode === 'auto' && !isN8nInstalled()) {
    console.log('[n8n-watchdog] not started: no n8n container on this host (set N8N_WATCHDOG=1 to force)')
    return false
  }
  void runCheck().catch(err => console.warn('[n8n-watchdog] initial check failed:', err))
  pollTimer = setInterval(() => {
    void runCheck().catch(err => console.warn('[n8n-watchdog] check failed:', err))
  }, POLL_INTERVAL_MS)
  console.log(`[n8n-watchdog] started (every ${POLL_INTERVAL_MS / 1000}s)`)
  return true
}
