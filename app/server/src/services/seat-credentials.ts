/**
 * Seat credentials (seat pool v2) — the only bridge between a seat record and
 * the secrets store.
 *
 * A pasted credential (a `claude setup-token` token) is written to the secrets
 * store (AES-256-GCM, audited, never returned after write) under a reserved
 * `CC_SEAT_<ID>` key. The seat record keeps only that key NAME plus a masked
 * hint (last 4 characters at most). The value is decrypted in exactly one place
 * — seatCredentialEnv — and handed to the single session assigned to the seat.
 *
 * CLI-login seats (Codex / Grok, or a Claude seat logged in on the host) keep
 * their login files in the seat's own HOME. A sandboxed session assigned to a
 * Codex / Grok seat gets that seat's login dir bind-mounted into its jail
 * (seatJailMount) and nothing else.
 */
import path from 'path'
import {
  registerSeatCredentialCheck,
  type AccountSlot,
} from './account-router.js'
import { SANDBOX_ACCOUNT_ID, sandboxClaudeAuthEnv } from './sandbox-claude-auth.js'
import { JAIL_HOME_PATH } from './session-jail.js'
import {
  SEAT_SECRET_PREFIX,
  deleteSecret,
  getSecret,
  getSecretValue,
  setSecret,
  type SecretScope,
} from './secrets-store.js'
import { credentialHint, expiryStatus, seatHealth, seatKind, type SeatHealth, type SeatKind } from './seat-pool.js'

const GLOBAL: SecretScope = { scopeType: 'global' }

export function seatSecretKey(seatId: string): string {
  return `${SEAT_SECRET_PREFIX}${seatId.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`
}

/** Store (or rotate) a seat's pasted credential. Returns only the key name and the masked hint. */
export function storeSeatCredential(
  seatId: string,
  value: string,
  actorUserId?: number | null,
): { ref: string; hint: string | null } {
  const v = (value || '').trim()
  if (!v) throw new Error('credential is empty')
  const ref = seatSecretKey(seatId)
  setSecret({ scope: GLOBAL, key: ref, value: v, actorUserId: actorUserId ?? null, via: 'seat-pool' })
  return { ref, hint: credentialHint(v) }
}

export function deleteSeatCredential(ref: string | null | undefined, actorUserId?: number | null): void {
  if (!ref) return
  try { deleteSecret(GLOBAL, ref, actorUserId ?? null) } catch { /* already gone */ }
}

export function seatCredentialStored(ref: string | null | undefined): boolean {
  if (!ref) return false
  try { return !!getSecret(GLOBAL, ref) } catch { return false }
}

registerSeatCredentialCheck(seatCredentialStored)

/**
 * SERVER-ONLY: the env a session on this seat needs to sign in. Decrypts a
 * pasted token (audited as a `read` by the system actor). Returns {} for a
 * CLI-login seat — its login files are in the seat HOME / mounted dir.
 * Never contains an API key: a seat never falls back to metered billing.
 */
export function seatCredentialEnv(seat: AccountSlot): Record<string, string> {
  if (seat.id === SANDBOX_ACCOUNT_ID) return sandboxClaudeAuthEnv()
  if (seat.credentialKind === 'setup_token' && seat.credentialRef && seatKind(seat) === 'claude') {
    const value = getSecretValue(GLOBAL, seat.credentialRef, 0)
    if (!value) throw new Error(`seat ${seat.id}: credential missing from the secrets store`)
    return { CLAUDE_CODE_OAUTH_TOKEN: value }
  }
  return {}
}

export interface SeatMount {
  source: string
  target: string
}

/** The one extra bind a sandboxed Codex / Grok session gets: its seat's login dir. */
export function seatJailMount(seat: Pick<AccountSlot, 'homeDir' | 'kind' | 'credentialKind'>): SeatMount | null {
  const kind = seatKind(seat)
  if (seat.credentialKind === 'setup_token') return null
  if (kind === 'codex') return { source: path.join(seat.homeDir, '.codex'), target: `${JAIL_HOME_PATH}/.codex` }
  if (kind === 'grok') return { source: path.join(seat.homeDir, '.grok'), target: `${JAIL_HOME_PATH}/.grok` }
  return null
}

// ── Masked summary (the ONLY seat shape an API returns) ─────────────────────

export interface SeatSummary {
  id: string
  label: string
  kind: SeatKind
  priority: number
  enabled: boolean
  health: SeatHealth
  available: boolean
  cooldownUntil: string | null
  consecutiveFailures: number
  credential: {
    kind: 'setup_token' | 'cli_login'
    /** Last 4 characters at most; null when unknown or too short to show safely. */
    last4: string | null
    addedAt: string | null
    expiresAt: string | null
    expiry: 'expired' | 'expiring' | null
  }
  sessions: { active: number; today: number }
  usageToday: { tokens: number; cost: number }
}

/**
 * Build the masked summary. Allowlist by construction: no homeDir (a machine
 * path), no secret key name, no value — only what the screen needs.
 */
export function maskSeat(
  seat: AccountSlot & { available?: boolean },
  now = Date.now(),
): SeatSummary {
  const health = seatHealth(seat, now)
  return {
    id: seat.id,
    label: seat.customLabel || seat.label,
    kind: seatKind(seat),
    priority: seat.priority ?? 0,
    enabled: seat.enabled !== false,
    health,
    available: seat.available ?? health === 'healthy',
    cooldownUntil: health === 'cooling_down' ? seat.rateLimitResetsAt : null,
    consecutiveFailures: seat.consecutiveFailures || 0,
    credential: {
      kind: seat.credentialKind === 'setup_token' ? 'setup_token' : 'cli_login',
      last4: seat.credentialHint ? seat.credentialHint.slice(-4) : null,
      addedAt: seat.credentialAddedAt || null,
      expiresAt: seat.credentialExpiresAt || null,
      expiry: expiryStatus(seat.credentialExpiresAt, now),
    },
    sessions: { active: seat.activeSessions.length, today: seat.sessionsToday },
    usageToday: { tokens: seat.tokensToday, cost: seat.costToday },
  }
}

// ── Read-only pool view (agent API + MCP get_seat_pool) ─────────────────────

export interface SeatPoolView {
  engines: Array<{
    kind: SeatKind
    seats: number
    available: number
    cooling_down: number
    parked: number
    /** Earliest cooldown end among this engine's seats; null when none is cooling. */
    next_reset_at: string | null
  }>
  seats: Array<{ id: string; label: string; kind: SeatKind; health: SeatHealth; available: boolean; cooldown_until: string | null }>
}

/** Which seats can take work now and when the next one frees up. No credentials, no paths. */
export function seatPoolView(rows: Array<AccountSlot & { available?: boolean }>, now = Date.now()): SeatPoolView {
  const seats = rows.map(r => maskSeat(r, now))
  const engines = (['claude', 'codex', 'grok'] as SeatKind[]).map(kind => {
    const mine = seats.filter(s => s.kind === kind)
    const cooling = mine.filter(s => s.health === 'cooling_down')
    const next = cooling.map(s => s.cooldownUntil!).sort()[0] ?? null
    return {
      kind,
      seats: mine.length,
      available: mine.filter(s => s.available).length,
      cooling_down: cooling.length,
      parked: mine.filter(s => s.health === 'needs_reconnect' || s.health === 'needs_admin' || s.health === 'credits_exhausted').length,
      next_reset_at: next,
    }
  })
  return {
    engines,
    seats: seats.map(s => ({ id: s.id, label: s.label, kind: s.kind, health: s.health, available: s.available, cooldown_until: s.cooldownUntil })),
  }
}
