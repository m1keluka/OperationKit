/**
 * n8n watchdog — internal deep-health probe + self-healing for the self-hosted
 * n8n automation stack (containers `n8n` + `n8n-db`).
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
 * is the authoritative liveness signal — no in-container HTTP probe needed. We
 * additionally curl the public Caddy path (https://n8n.example.com/healthz) to
 * verify end-to-end reachability, but that is advisory only.
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
const PUBLIC_HEALTHZ_URL = 'https://n8n.example.com/healthz'
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
  status: 'up' | 'degraded' | 'down' | 'unknown'
  checkedAt: string
  n8n: ContainerState
  n8nDb: ContainerState
  publicHealthz: { ok: boolean; httpCode: number | null; ms: number | null }
  host: { diskUsedPct: number | null; loadAvg1: number | null }
  lastAutoRestart: { at: string; success: boolean; detail: string } | null
  lastError: string | null
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
    return { name, exists: false, status: 'unknown', health: 'unknown', exitCode: null, running: false }
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

function checkPublicHealthz(): Promise<N8nHealth['publicHealthz']> {
  const started = Date.now()
  return fetch(PUBLIC_HEALTHZ_URL, { method: 'GET', signal: AbortSignal.timeout(8000) })
    .then(res => ({ ok: res.ok, httpCode: res.status, ms: Date.now() - started }))
    .catch(() => ({ ok: false, httpCode: null, ms: null }))
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

// A container is "down" if it isn't running. n8n is additionally "degraded" if it
// runs but its own healthcheck reports unhealthy. n8n-db has no app-level health
// beyond pg_isready, which IS its healthcheck, so the same logic applies.
function deriveStatus(n8n: ContainerState, n8nDb: ContainerState): N8nHealth['status'] {
  if (!n8n.exists || !n8nDb.exists) return 'unknown'
  const dbDown = !n8nDb.running
  const n8nDown = !n8n.running
  if (n8nDown || dbDown) return 'down'
  const degraded = n8n.health === 'unhealthy' || n8nDb.health === 'unhealthy'
  if (degraded) return 'degraded'
  return 'up'
}

function attemptRestart(n8n: ContainerState, n8nDb: ContainerState): { success: boolean; detail: string } {
  const steps: string[] = []
  try {
    if (!n8nDb.running) {
      sh('docker start n8n-db', 20_000)
      steps.push('started n8n-db')
      // Give Postgres a moment to accept connections before n8n starts.
      try { sh('sleep 4', 8_000) } catch { /* sleep interrupt is harmless */ }
    }
    if (!n8n.running) {
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

function fireAlert(severity: 'high' | 'normal', title: string, message: string, dedupKey: string): void {
  try {
    const alert = insertAlert({
      severity,
      source: 'n8n-watchdog',
      title,
      message,
      dedup_key: dedupKey,
      url: 'https://n8n.example.com/',
    })
    // AlertBell-only: persist to the alerts table (AlertBell polls it) and push
    // over WS for instant display. No email/Telegram.
    if (alert) broadcast({ type: 'alert', payload: alert })
  } catch (err) {
    console.warn('[n8n-watchdog] failed to emit alert:', err instanceof Error ? err.message : err)
  }
}

async function runCheck(): Promise<void> {
  let lastError: string | null = null
  const n8n = inspectContainer('n8n')
  const n8nDb = inspectContainer('n8n-db')
  const publicHealthz = await checkPublicHealthz()
  const host = readHost()
  const status = deriveStatus(n8n, n8nDb)
  const ok = status === 'up'

  // Self-heal: only when a container is actually stopped, and only outside the
  // cooldown window (so a crash-looping container doesn't trigger a restart storm).
  const containerStopped = (n8n.exists && !n8n.running) || (n8nDb.exists && !n8nDb.running)
  if (containerStopped) {
    const now = Date.now()
    if (now - lastRestartAttemptMs >= RESTART_COOLDOWN_MS) {
      lastRestartAttemptMs = now
      const result = attemptRestart(n8n, n8nDb)
      lastAutoRestart = { at: new Date().toISOString(), success: result.success, detail: result.detail }
      console.log(`[n8n-watchdog] auto-restart ${result.success ? 'ok' : 'FAILED'}: ${result.detail}`)
      // Re-inspect so the snapshot + alert reflect the post-restart reality.
      const n8nAfter = inspectContainer('n8n')
      const n8nDbAfter = inspectContainer('n8n-db')
      n8n.status = n8nAfter.status; n8n.health = n8nAfter.health; n8n.running = n8nAfter.running; n8n.exitCode = n8nAfter.exitCode
      n8nDb.status = n8nDbAfter.status; n8nDb.health = n8nDbAfter.health; n8nDb.running = n8nDbAfter.running; n8nDb.exitCode = n8nDbAfter.exitCode
    } else {
      lastError = 'container down but within restart cooldown — not retrying yet'
    }
  }

  const finalStatus = deriveStatus(n8n, n8nDb)
  const finalOk = finalStatus === 'up'

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
  if (!finalOk && !alertedDown) {
    alertedDown = true
    const restartLine = lastAutoRestart
      ? `\nAuto-restart: ${lastAutoRestart.success ? 'succeeded' : 'FAILED'} — ${lastAutoRestart.detail}`
      : ''
    fireAlert(
      'high',
      finalStatus === 'down' ? 'n8n is DOWN' : 'n8n is degraded',
      `n8n=${n8n.status}/${n8n.health}, n8n-db=${n8nDb.status}/${n8nDb.health}, public healthz=${publicHealthz.httpCode ?? 'unreachable'}.${restartLine}`,
      'n8n-watchdog-down',
    )
  } else if (finalOk && alertedDown) {
    alertedDown = false
    fireAlert(
      'normal',
      'n8n recovered',
      `n8n is back up (n8n=${n8n.status}/${n8n.health}, n8n-db=${n8nDb.status}/${n8nDb.health}).`,
      'n8n-watchdog-up',
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
  const n8n = inspectContainer('n8n')
  const n8nDb = inspectContainer('n8n-db')
  lastRestartAttemptMs = Date.now()
  const result = attemptRestart(n8n, n8nDb)
  lastAutoRestart = { at: new Date().toISOString(), success: result.success, detail: `manual: ${result.detail}` }
  return result
}

export function startN8nWatchdog(): void {
  if (pollTimer) return
  void runCheck().catch(err => console.warn('[n8n-watchdog] initial check failed:', err))
  pollTimer = setInterval(() => {
    void runCheck().catch(err => console.warn('[n8n-watchdog] check failed:', err))
  }, POLL_INTERVAL_MS)
  console.log(`[n8n-watchdog] started (every ${POLL_INTERVAL_MS / 1000}s)`)
}
