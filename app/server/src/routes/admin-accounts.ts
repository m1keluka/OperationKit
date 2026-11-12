/**
 * Admin account-router routes: read-only status + rate-limit history, and the
 * two operator escape hatches (clear a false bench, live recheck).
 *
 * Seat MANAGEMENT (add, sign in, reconnect, rename, remove) lives in exactly one
 * place: Settings → Models (/settings/models), served by admin-seats.ts under
 * /api/admin/seats*. The pre-v2 Dashboard routes here (POST /accounts,
 * /accounts/:id/connect/*, PUT /accounts/:id/label) wrote seats without the seat
 * audit log, idempotency or the jail rules, so they are retired: each answers
 * 410 with a pointer to its replacement (obj 720330).
 *
 * Auth is applied by the admin.ts facade. Paths are unchanged.
 */
import { Router } from 'express'
import type { AuthRequest } from '../middleware/auth.js'
import { getAccountRouterStatus } from '../services/session-manager.js'
import {
  getRateLimitHistory,
  forceClearRateLimit,
  getAccountById,
  recordRateLimit,
  recordAuthFailure,
  clearAuthFailure,
  parseResetTime,
} from '../services/account-router.js'
import { probeAccount } from '../services/account-probe.js'

const router = Router()

/** Where every seat write lives now. */
export const SEATS_MANAGE_ROUTE = '/settings/models'

/** Body of the 410 a retired seat-write route returns. */
export function seatRouteMoved(use: string) {
  return {
    error: 'Seats are managed in one place now: Settings → Models.',
    code: 'seat_route_moved',
    manage: SEATS_MANAGE_ROUTE,
    use,
  } as const
}

// Account router status
router.get('/accounts', (_req: AuthRequest, res) => {
  res.json(getAccountRouterStatus())
})

// ── Retired seat writes (one place to manage seats: /api/admin/seats*) ──────
router.post('/accounts', (_req: AuthRequest, res) => {
  res.status(410).json(seatRouteMoved('POST /api/admin/seats'))
})
router.post('/accounts/:id/connect/:step', (_req: AuthRequest, res) => {
  res.status(410).json(seatRouteMoved('POST /api/admin/seats/claude-oauth/start (Claude) or /api/admin/seats/:id/login/start (Codex, Grok)'))
})
router.put('/accounts/:id/label', (_req: AuthRequest, res) => {
  res.status(410).json(seatRouteMoved('PATCH /api/admin/seats/:id { label }'))
})

// Rate limit history
router.get('/rate-limits', (req: AuthRequest, res) => {
  const limit = parseInt(req.query.limit as string) || 50
  res.json(getRateLimitHistory(Math.min(limit, 200)))
})

// Force-clear a stale / false rate-limit bench on an account slot.
// Operator escape hatch for when a healthy account is benched (e.g. a
// misattributed rate_limit_event) and no live session exists to auto-clear it.
router.post('/accounts/:id/clear-bench', (req: AuthRequest, res) => {
  const id = req.params.id as string
  const cleared = forceClearRateLimit(id)
  if (!cleared) {
    res.status(404).json({ error: `Unknown account slot: ${id}` })
    return
  }
  res.json({
    ok: true,
    cleared: { id: cleared.id, label: cleared.label, rateLimitResetsAt: cleared.rateLimitResetsAt },
    status: getAccountRouterStatus(),
  })
})

/**
 * Live recheck: actually verify a benched account's status against Anthropic
 * instead of trusting a possibly-stale/false flag. Fires one tiny non-interactive
 * `claude -p` turn as that slot's ccuser/HOME, with the API-key env stripped (see
 * probeAccount) so it exercises the SUBSCRIPTION OAuth — the same credential
 * sessions use — not the ANTHROPIC_API_KEY fallback:
 *   - completes cleanly  → serving → clear both rate-limit and auth-failure flags
 *   - rate-limit reply    → genuinely limited → re-record with the real reset
 *   - 401 / auth failure  → dead credential → park as "reconnect needed"
 *   - anything else       → inconclusive, leave state untouched
 *
 * Consumes a sliver of subscription quota — no marginal $ (flat-rate accounts).
 */
router.post('/accounts/:id/recheck', async (req: AuthRequest, res) => {
  const id = req.params.id as string
  const account = getAccountById(id)
  if (!account) {
    res.status(404).json({ error: `Unknown account slot: ${id}` })
    return
  }
  // Codex / Grok are flat-rate subs with no 5h/weekly Claude token bench.
  if (id === 'codex' || id === 'grok' || account.kind === 'grok') {
    res.json({ ok: true, stillLimited: false, probed: false, note: 'This subscription has no Claude token bench', status: getAccountRouterStatus() })
    return
  }
  // Nothing benched and no auth failure → nothing to verify; skip the token spend.
  if (!account.rateLimitResetsAt && !account.authFailedAt) {
    res.json({ ok: true, stillLimited: false, probed: false, note: 'Not benched', status: getAccountRouterStatus() })
    return
  }

  const probe = await probeAccount(account.homeDir)

  if (probe.rateLimited) {
    // Still limited — refresh the bench with the real reset the probe reported
    // (recordRateLimit keeps the earliest known future reset, so this can only
    // move recovery sooner, never push a working account out further).
    const reset = parseResetTime(probe.output) || undefined
    recordRateLimit(id, reset, `[admin recheck] ${probe.output.slice(0, 200)}`)
    const after = getAccountById(id)
    res.json({ ok: true, stillLimited: true, resetsAt: after?.rateLimitResetsAt ?? null, status: getAccountRouterStatus() })
    return
  }

  if (probe.authFailure) {
    // Dead credential — park as "reconnect needed" (permanent until re-login)
    // rather than a cooldown that can't fix an expired/revoked token.
    recordAuthFailure(id, `[admin recheck] ${probe.output.slice(0, 200)}`)
    res.json({ ok: true, stillLimited: false, needsReconnect: true, status: getAccountRouterStatus() })
    return
  }

  if (probe.ok) {
    // Live credential — clear both flags so it re-enters rotation immediately.
    clearAuthFailure(id)
    forceClearRateLimit(id)
    res.json({ ok: true, stillLimited: false, cleared: true, status: getAccountRouterStatus() })
    return
  }

  // Inconclusive (timeout / other error). Don't touch state; surface why.
  res.json({
    ok: false,
    stillLimited: true,
    inconclusive: true,
    error: probe.output.slice(0, 300) || 'probe failed',
    status: getAccountRouterStatus(),
  })
})

export default router
