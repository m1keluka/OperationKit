/**
 * Slot health check (obj 717767). Probes every Claude subscription slot on a
 * timer (and right after a reconnect) so a disabled org / dead OAuth is caught
 * BEFORE a card is routed to it: a failing slot is parked with the right reason
 * and alerted; a parked slot that passes is un-parked back into rotation.
 *
 * Subscription login only — see account-probe.ts. Never the API key.
 */
import fs from 'fs'
import path from 'path'
import {
  getRouterStatus,
  getAccountById,
  isClaudeRotationSlot,
  recordAuthFailure,
  clearAuthFailure,
  clearRateLimit,
  recordRateLimit,
  parseResetTime,
  authParkReason,
  seatCredentialUsable,
  listSeatRecords,
  updateSeat,
  type AccountSlot,
} from './account-router.js'
import { probeAccount, type ProbeFn } from './account-probe.js'
import { raiseAccountParkedAlert } from './account-auth-park.js'
import { seatCredentialEnv } from './seat-credentials.js'
import { expiryStatus, seatKind, EXPIRY_WARNING_DAYS } from './seat-pool.js'
import { insertAlert } from './notifier.js'
import { broadcast } from '../ws/index.js'

export type SlotCheckOutcome =
  | 'healthy'        // served, was not parked
  | 'unparked'       // served (or rate-limited, which proves auth works), was parked → back in rotation
  | 'parked'         // auth failure → parked (alerted if newly parked / reason changed)
  | 'rate_limited'   // credential live but limited → rate-limit recorded
  | 'inconclusive'   // timeout / other error → state untouched
  | 'skipped'        // not a Claude rotation slot, or no credentials on disk (not set up)

function hasCredentials(account: AccountSlot): boolean {
  // A pasted-token seat's credential is in the secrets store, not on disk.
  if (account.credentialKind === 'setup_token') return seatCredentialUsable(account, false)
  return fs.existsSync(path.join(account.homeDir, '.claude', '.credentials.json'))
}

/** Probe one slot and apply the park / un-park policy. Never throws. */
export async function checkSlot(
  accountId: string,
  probe: ProbeFn = probeAccount,
  credentialsPresent: (account: AccountSlot) => boolean = hasCredentials,
): Promise<SlotCheckOutcome> {
  const account = getAccountById(accountId)
  if (!account) return 'skipped'
  if (seatKind(account) !== 'claude') return checkLoginSeat(account)
  if (!isClaudeRotationSlot(account) || !credentialsPresent(account)) return 'skipped'
  const wasParked = !!account.authFailedAt
  const priorReason = account.authFailureReason || null

  let result
  try {
    const seatEnv = account.credentialKind === 'setup_token' ? seatCredentialEnv(account) : undefined
    result = await probe(account.homeDir, seatEnv)
  } catch (err) {
    console.warn(`[slot-health] probe threw for ${accountId}:`, err instanceof Error ? err.message : err)
    return 'inconclusive'
  }

  if (result.authFailure) {
    const trigger = `[health-check] ${result.output.slice(0, 300)}`
    recordAuthFailure(accountId, trigger)
    const reason = authParkReason(trigger)
    if (!wasParked || priorReason !== reason) {
      raiseAccountParkedAlert(accountId, reason, 'Caught by the slot health check before any card ran on it.')
    }
    return 'parked'
  }

  if (result.rateLimited) {
    // A rate-limit reply means the credential authenticated — un-park, but bench for the window.
    if (wasParked) clearAuthFailure(accountId)
    recordRateLimit(accountId, parseResetTime(result.output) || undefined, `[health-check] ${result.output.slice(0, 200)}`)
    return wasParked ? 'unparked' : 'rate_limited'
  }

  if (result.ok) {
    // A served turn also clears a false cooldown / credits park.
    clearRateLimit(accountId)
    if (wasParked) {
      clearAuthFailure(accountId)
      console.log(`[slot-health] ${accountId} passed the health check — back in rotation`)
      return 'unparked'
    }
    return 'healthy'
  }

  return 'inconclusive'
}

/**
 * Codex / Grok seats: the official CLIs have no cheap, side-effect-free probe
 * turn we can run without spending the plan, so "Test now" checks the seat's
 * login file. Present → healthy (and un-park); missing → parked needs_reconnect.
 */
function checkLoginSeat(account: AccountSlot): SlotCheckOutcome {
  const usable = seatCredentialUsable(account, false)
  if (usable) {
    if (account.authFailedAt) {
      clearAuthFailure(account.id)
      return 'unparked'
    }
    return 'healthy'
  }
  if (!account.authFailedAt) recordAuthFailure(account.id, '[health-check] login file missing — not logged in')
  return 'parked'
}

/** Pull a CLI login's refresh-token expiry onto the seat so the 14-day warning can see it. */
function syncLoginExpiry(account: AccountSlot): void {
  if (seatKind(account) !== 'claude' || account.credentialKind === 'setup_token') return
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(account.homeDir, '.claude', '.credentials.json'), 'utf-8'))
    const ms = (parsed.claudeAiOauth || parsed)?.refreshTokenExpiresAt
    if (typeof ms !== 'number') return
    const iso = new Date(ms).toISOString()
    if (iso !== account.credentialExpiresAt) updateSeat(account.id, { credentialExpiresAt: iso })
  } catch { /* no file / unknown shape — expiry stays unknown */ }
}

/**
 * Raise a dashboard alert when a seat's credential expires within
 * EXPIRY_WARNING_DAYS (or already has). Dedup'd per seat + expiry date, so a
 * rotated credential with a new expiry warns again. Names the seat label only.
 */
export function warnExpiringSeats(now = Date.now(), seats: AccountSlot[] = listSeatRecords()): string[] {
  const warned: string[] = []
  for (const seat of seats) {
    const status = expiryStatus(seat.credentialExpiresAt, now)
    if (!status) continue
    warned.push(seat.id)
    const label = seat.customLabel || seat.label
    const day = seat.credentialExpiresAt!.slice(0, 10)
    try {
      const alert = insertAlert({
        severity: status === 'expired' ? 'high' : 'normal',
        source: 'seat-pool',
        title: status === 'expired' ? `Seat credential expired: ${label}` : `Seat credential expires soon: ${label}`,
        message: status === 'expired'
          ? `The credential for seat "${label}" expired on ${day}. Rotate it in Settings → Seats.`
          : `The credential for seat "${label}" expires on ${day} (within ${EXPIRY_WARNING_DAYS} days). Rotate it in Settings → Seats before then.`,
        dedup_key: `seat-expiry:${seat.id}:${day}:${status}`,
      })
      if (alert) broadcast({ type: 'alert', payload: alert })
    } catch (err) {
      console.warn('[slot-health] expiry alert failed:', err instanceof Error ? err.message : err)
    }
  }
  return warned
}

let running = false

/** Probe every Claude rotation slot sequentially (keeps load and usage trivial). Skips if a run is in flight. */
export async function runSlotHealthCheck(
  probe: ProbeFn = probeAccount,
  credentialsPresent?: (account: AccountSlot) => boolean,
): Promise<Record<string, SlotCheckOutcome>> {
  if (running) return {}
  running = true
  const outcomes: Record<string, SlotCheckOutcome> = {}
  try {
    for (const account of getRouterStatus().accounts) {
      if (account.enabled === false) continue
      syncLoginExpiry(account)
      if (!isClaudeRotationSlot(account)) continue
      outcomes[account.id] = await checkSlot(account.id, probe, credentialsPresent)
    }
    warnExpiringSeats()
    const changed = Object.entries(outcomes).filter(([, o]) => o === 'parked' || o === 'unparked')
    if (changed.length) console.log(`[slot-health] ${changed.map(([id, o]) => `${id}=${o}`).join(' ')}`)
  } finally {
    running = false
  }
  return outcomes
}

const DEFAULT_INTERVAL_MIN = 30
const FIRST_RUN_DELAY_MS = 2 * 60 * 1000

/** Interval from CC_SLOT_HEALTH_INTERVAL_MIN (default 30, floor 5). 0 / negative disables; non-numeric → default. */
export function slotHealthIntervalMs(raw = process.env.CC_SLOT_HEALTH_INTERVAL_MIN): number {
  if (raw == null || raw.trim() === '') return DEFAULT_INTERVAL_MIN * 60_000
  const n = Number(raw)
  if (!Number.isFinite(n)) return DEFAULT_INTERVAL_MIN * 60_000
  return n > 0 ? Math.max(5, n) * 60_000 : 0
}

let timer: ReturnType<typeof setInterval> | null = null
let firstRun: ReturnType<typeof setTimeout> | null = null

export function startSlotHealthCheck(): void {
  if (timer || firstRun) return
  const intervalMs = slotHealthIntervalMs()
  if (!intervalMs) {
    console.log('[slot-health] disabled (CC_SLOT_HEALTH_INTERVAL_MIN<=0)')
    return
  }
  const tick = () => { void runSlotHealthCheck().catch(err => console.error('[slot-health] run failed:', err)) }
  firstRun = setTimeout(() => {
    firstRun = null
    tick()
    timer = setInterval(tick, intervalMs)
  }, FIRST_RUN_DELAY_MS)
  console.log(`[slot-health] started (every ${intervalMs / 60_000} min, first run in ${FIRST_RUN_DELAY_MS / 60_000} min)`)
}

export function stopSlotHealthCheck(): void {
  if (firstRun) { clearTimeout(firstRun); firstRun = null }
  if (timer) { clearInterval(timer); timer = null }
}
