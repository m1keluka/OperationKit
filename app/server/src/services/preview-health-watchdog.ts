/**
 * Preview-tier health watchdog (obj 719327).
 *
 * WHY THIS EXISTS: the pr-N.cc.example.com preview tier went TLS-dead
 * (handshake `internal error`) with zero alerting anywhere — three reviewer
 * sessions each independently discovered it by burning 15-41 failed Playwright
 * reachability probes before giving up with a BLOCKED verdict (2026-10-28).
 * This watches the tier itself on a fixed interval and pages AlertBell the
 * moment it goes dark, instead of letting every future reviewer rediscover the
 * same outage from scratch.
 *
 * SCOPE: monitoring/alerting only — it does NOT attempt remediation (no
 * cc-preview-spool drain, no Caddy reload). This container has no docker
 * socket / systemd access to do that safely even if it wanted to (see obj
 * 719327's NOTES); auto-heal is tracked separately as CC-719328, which also
 * needs a schema change (`blocked_reason`) this watchdog does not touch.
 *
 * Alerts: AlertBell-only (insertAlert + WS broadcast), same house style as
 * n8n-watchdog.ts and disk-watchdog.ts. Edge-triggered: pages once on down,
 * once on recovery, never once per poll.
 */
import { getDb } from '../db/index.js'
import { insertAlert } from './notifier.js'
import { broadcast } from '../ws/index.js'
import { pickPreviewCanary, previewHostFor, derivePreviewStatus, type PreviewCanary, type PreviewHealthStatus, type PreviewProbeResult } from '../lib/preview-health.js'

const POLL_INTERVAL_MS = 10 * 60 * 1000
const PROBE_TIMEOUT_MS = 8_000

export interface PreviewHealthState {
  status: PreviewHealthStatus
  canary: PreviewCanary | null
  probe: PreviewProbeResult | null
  checkedAt: string
}

let latest: PreviewHealthState | null = null
let pollTimer: ReturnType<typeof setInterval> | null = null
let alertedDown = false

async function probePreviewHost(prNumber: number): Promise<PreviewProbeResult> {
  const url = `https://${previewHostFor(prNumber)}`
  const started = Date.now()
  try {
    const res = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
    return { ok: res.ok, httpCode: res.status, ms: Date.now() - started, error: null }
  } catch (err) {
    return { ok: false, httpCode: null, ms: null, error: err instanceof Error ? err.message : String(err) }
  }
}

function fireAlert(severity: 'high' | 'normal', title: string, message: string, url: string | undefined, dedupKey: string): void {
  try {
    const alert = insertAlert({ severity, source: 'preview-health-watchdog', title, message, dedup_key: dedupKey, url })
    if (alert) broadcast({ type: 'alert', payload: alert })
  } catch (err) {
    console.warn('[preview-health-watchdog] failed to emit alert:', err instanceof Error ? err.message : err)
  }
}

async function runCheck(): Promise<void> {
  const canary = pickPreviewCanary(getDb())
  const probe = canary ? await probePreviewHost(canary.prNumber) : null
  const status = derivePreviewStatus(canary, probe)

  latest = { status, canary, probe, checkedAt: new Date().toISOString() }

  if (status === 'down' && !alertedDown) {
    alertedDown = true
    fireAlert(
      'high',
      'PR preview tier is DOWN',
      `https://${previewHostFor(canary!.prNumber)} (obj ${canary!.objectiveId}, "${canary!.title}") is unreachable: ` +
        `${probe!.error || `HTTP ${probe!.httpCode}`}. Every open PR's preview is likely dead until this is fixed — ` +
        `check cc-preview-spool.{path,service} on the host and the Caddy site for this domain.`,
      `https://${previewHostFor(canary!.prNumber)}`,
      'preview-health-watchdog-down',
    )
  } else if (status === 'up' && alertedDown) {
    alertedDown = false
    fireAlert(
      'normal',
      'PR preview tier recovered',
      `https://${previewHostFor(canary!.prNumber)} is reachable again (HTTP ${probe!.httpCode}).`,
      `https://${previewHostFor(canary!.prNumber)}`,
      'preview-health-watchdog-up',
    )
  }
}

export function getPreviewHealthState(): PreviewHealthState | null {
  return latest
}

/** Force an immediate check (used by a manual-refresh endpoint, mirrors n8n-watchdog). */
export async function refreshPreviewHealth(): Promise<PreviewHealthState | null> {
  await runCheck().catch(err => console.warn('[preview-health-watchdog] refresh failed:', err))
  return latest
}

export function startPreviewHealthWatchdog(): void {
  if (process.env.CC_PREVIEW_HEALTH_WATCHDOG === 'false') {
    console.log('[preview-health-watchdog] disabled via CC_PREVIEW_HEALTH_WATCHDOG=false')
    return
  }
  if (pollTimer) return
  void runCheck()
  pollTimer = setInterval(() => { void runCheck() }, POLL_INTERVAL_MS)
  pollTimer.unref()
  console.log(`[preview-health-watchdog] started (every ${POLL_INTERVAL_MS / 1000}s)`)
}
