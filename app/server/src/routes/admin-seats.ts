/**
 * Settings → Seats admin API (seat pool v2). Mounted under /api/admin, so the
 * admin.ts facade already applies requireAuth + requireAdmin (agent keys are
 * rejected; admin role only).
 *
 * Every response carries the masked SeatSummary only (seat-credentials.ts
 * maskSeat) — never a credential value, a secret key name or a machine path.
 * Every mutation writes a seat_audit_log row with the acting user; pasted
 * credentials additionally get the secrets store's own audit rows.
 */
import { Router } from 'express'
import { execSync, spawnSync } from 'child_process'
import fs from 'fs'
import type { AuthRequest } from '../middleware/auth.js'
import { getDb } from '../db/index.js'
import {
  addAccountSlot,
  clearAuthFailure,
  clearSeatHome,
  listSeatRecords,
  getAccountById,
  getRateLimitHistory,
  getRouterStatus,
  removeSeat,
  seatCredentialUsable,
  setSeatCredential,
  updateSeat,
} from '../services/account-router.js'
import { checkSlot } from '../services/account-health-check.js'
import {
  LOGIN_TTL_MS,
  cancelClaudeLogin,
  cancelClaudeLoginsForSeat,
  finishClaudeLogin,
  pendingLoginSeat,
  startClaudeLogin,
  type FinishError,
} from '../services/claude-oauth-login.js'
import { deleteSeatCredential, findSeatWithCredential, maskSeat, storeSeatCredential, type SeatSummary } from '../services/seat-credentials.js'
import { createOnce, parseIdempotencyKey } from '../services/seat-idempotency.js'
import { getWorkspaceFailover, setWorkspaceFailover } from '../services/seat-assign.js'
import { computeSeatUsage, RATE_LIMIT_HISTORY_SCAN, type ProvisioningHint, type SeatUsageView } from '../services/seat-usage.js'
import { normalizeOrder, parseCardFailover, SEAT_KINDS, type SeatKind } from '../services/seat-pool.js'
import { ensureGrokCliExecutable } from '../services/session-spawn-command.js'
import { extractGrokDeviceAuth, grokLoginSucceeded } from '../services/grok-device-auth.js'

const router = Router()

export function auditSeat(actorUserId: number | null | undefined, action: string, seatId: string | null, detail?: string): void {
  try {
    getDb()
      .prepare('INSERT INTO seat_audit_log (actor_user_id, action, seat_id, detail) VALUES (?, ?, ?, ?)')
      .run(actorUserId ?? null, action, seatId, detail ? detail.slice(0, 500) : null)
  } catch (err) {
    console.warn('[seats] audit write failed:', err instanceof Error ? err.message : err)
  }
}

type RouterSeat = ReturnType<typeof getRouterStatus>['accounts'][number]

/** Rolling usage + rate-limit state for every seat (seat-usage.ts). Never throws. */
function seatUsageView(accounts: RouterSeat[], now = Date.now()): SeatUsageView | null {
  try {
    return computeSeatUsage({ db: getDb(), now, seats: accounts, rateLimitEvents: getRateLimitHistory(RATE_LIMIT_HISTORY_SCAN) })
  } catch (err) {
    console.warn('[seats] usage aggregation failed:', err instanceof Error ? err.message : err)
    return null
  }
}

/** All seats, masked, with live availability and rolling usage, plus the pool provisioning hint. */
export function listSeatsWithUsage(): { seats: SeatSummary[]; provisioning: ProvisioningHint | null } {
  const accounts = getRouterStatus().accounts
  const now = Date.now()
  const view = seatUsageView(accounts, now)
  const seats = accounts.map(a => {
    const summary = maskSeat(a, now)
    const usage = view?.usage.get(a.id)
    return usage ? { ...summary, usage } : summary
  })
  return { seats, provisioning: view?.provisioning ?? null }
}

/** All seats, masked, with live availability and rolling usage. */
export function listSeatSummaries(): SeatSummary[] {
  return listSeatsWithUsage().seats
}

function seatOr404(id: string, res: import('express').Response) {
  const seat = getAccountById(id)
  if (!seat) {
    res.status(404).json({ error: 'seat_not_found' })
    return null
  }
  return seat
}

function summaryOf(id: string): SeatSummary | null {
  return listSeatsWithUsage().seats.find(s => s.id === id) ?? null
}

function parseKind(v: unknown): SeatKind | null {
  return v === 'claude' || v === 'codex' || v === 'grok' ? v : null
}

function parseExpiry(v: unknown): string | null | undefined {
  if (v === undefined) return undefined
  if (v === null || v === '') return null
  const t = typeof v === 'string' ? Date.parse(v) : NaN
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined
}

function credentialFrom(body: unknown): string | null {
  const v = (body as { credential?: unknown } | undefined)?.credential
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

router.get('/seats', (_req: AuthRequest, res) => {
  const { seats, provisioning } = listSeatsWithUsage()
  res.json({ seats, kinds: SEAT_KINDS, provisioning })
})

/**
 * Add a seat. Claude: paste a `claude setup-token` token (`credential`), stored
 * in the secrets store. That is the fallback: the no-terminal path is the
 * browser sign-in under /seats/claude-oauth/*. Codex / Grok: the seat is created
 * empty and the client then calls /login/start to run the CLI's own device login into its HOME.
 */
/** A finished seat write, replayable: HTTP status + the masked body only (never a credential). */
interface SeatWrite { status: number; body: Record<string, unknown> }
const isSuccess = (w: SeatWrite) => w.status < 300

// Same key → one write. Add keys live as long as a form is plausibly open;
// sign-in keys exactly as long as the sign-in link (claude-oauth-login.ts).
const addOnce = createOnce<SeatWrite>(30 * 60 * 1000)
const finishOnce = createOnce<SeatWrite>(LOGIN_TTL_MS)

/** Test hook: forget remembered seat writes. */
export function __resetSeatWriteMemory(): void {
  addOnce.clear()
  finishOnce.clear()
}

async function sendWrite(res: import('express').Response, run: Promise<{ value: SeatWrite; replayed: boolean }>): Promise<void> {
  const { value, replayed } = await run
  res.status(value.status).json(replayed && isSuccess(value) ? { ...value.body, replayed: true } : value.body)
}

router.post('/seats', async (req: AuthRequest, res) => {
  // A client-generated key (one per open Add form) makes a double-click or a
  // retry after a dropped response return the SAME seat instead of a second one.
  const key = parseIdempotencyKey(req.body?.idempotencyKey)
  const run = () => Promise.resolve(addSeat(req))
  if (!key) return sendWrite(res, run().then(value => ({ value, replayed: false })))
  return sendWrite(res, addOnce.run(`add:${req.user?.id ?? 0}:${key}`, run, isSuccess))
})

function addSeat(req: AuthRequest): SeatWrite {
  const kind = parseKind(req.body?.kind)
  if (!kind) return { status: 400, body: { error: 'kind must be claude, codex or grok' } }
  const credential = credentialFrom(req.body)
  if (kind === 'claude' && !credential) {
    return { status: 400, body: { error: 'paste the setup token for a Claude seat (from `claude setup-token`)' } }
  }
  if (kind !== 'claude' && credential) {
    return { status: 400, body: { error: `${kind} seats sign in with the CLI login flow, not a pasted token` } }
  }
  if (credential) {
    // The same token pasted twice is the same subscription: hand back that seat.
    const existing = findSeatWithCredential(listSeatRecords(), credential, req.user?.id)
    if (existing) {
      auditSeat(req.user?.id, 'add_duplicate', existing.id, 'kind=claude credential=setup_token')
      return { status: 200, body: { ok: true, duplicate: true, seat: summaryOf(existing.id) } }
    }
  }
  const expiresAt = parseExpiry(req.body?.expiresAt)
  const seat = addAccountSlot({
    kind,
    label: typeof req.body?.label === 'string' ? req.body.label : '',
    priority: typeof req.body?.priority === 'number' ? req.body.priority : undefined,
    credentialKind: credential ? 'setup_token' : 'cli_login',
    credentialExpiresAt: expiresAt ?? null,
  })
  if (credential) {
    const stored = storeSeatCredential(seat.id, credential, req.user?.id)
    setSeatCredential(seat.id, { ...stored, expiresAt: expiresAt ?? null, source: 'pasted' })
  }
  auditSeat(req.user?.id, 'add', seat.id, `kind=${kind}${credential ? ' credential=setup_token' : ''}`)
  return { status: 201, body: { ok: true, seat: summaryOf(seat.id) } }
}

// ── Claude sign-in from the browser (obj 720330) ────────────────────────────
// The same OAuth + PKCE flow `claude setup-token` runs (claude-oauth-login.ts):
// /start returns a "Sign in with Claude" link, the operator pastes back the
// `code#state` Claude shows, /finish exchanges it for the subscription token,
// stores it exactly like a pasted token, and runs the seat's test turn.
// Paths sit under /seats/claude-oauth/* so they never collide with /seats/:id/*.

const FINISH_STATUS: Record<FinishError, number> = {
  unknown_login: 404,
  expired: 410,
  bad_input: 400,
  state_mismatch: 400,
  too_many_attempts: 429,
  bad_code: 400,
  not_subscription: 400,
  exchange_failed: 502,
}

/** A Claude seat by id, or the error that stops a sign-in for it. */
function claudeSeatError(seatId: string): SeatWrite | null {
  const seat = getAccountById(seatId)
  if (!seat) return { status: 404, body: { error: 'This seat no longer exists. Nothing was saved.', code: 'seat_not_found' } }
  if ((seat.kind || 'claude') !== 'claude') return { status: 400, body: { error: 'Only Claude seats sign in with Claude', code: 'not_claude' } }
  return null
}

router.post('/seats/claude-oauth/start', (req: AuthRequest, res) => {
  const seatId = typeof req.body?.seatId === 'string' ? req.body.seatId : null
  if (seatId) {
    const err = claudeSeatError(seatId)
    if (err) {
      res.status(err.status).json(err.body)
      return
    }
  }
  // The link is bound to this seat (or to "a new seat"): the pasted code can
  // only ever land where the operator pressed the button.
  const started = startClaudeLogin({ actorUserId: req.user?.id ?? null, seatId })
  auditSeat(req.user?.id, 'oauth_start', seatId, seatId ? 'kind=claude mode=reconnect' : 'kind=claude mode=add')
  res.json({ ok: true, ...started })
})

router.post('/seats/claude-oauth/cancel', (req: AuthRequest, res) => {
  if (typeof req.body?.loginId === 'string') cancelClaudeLogin(req.body.loginId)
  res.json({ ok: true })
})

/**
 * Finish a sign-in. Idempotent per link: a double-click or a retry after a
 * dropped response joins / replays the first call (one exchange, one seat),
 * because the code is single-use and a second exchange would fail anyway.
 */
router.post('/seats/claude-oauth/finish', async (req: AuthRequest, res) => {
  const loginId = typeof req.body?.loginId === 'string' ? req.body.loginId : ''
  const run = () => finishSignIn(req, loginId)
  if (!loginId) return sendWrite(res, run().then(value => ({ value, replayed: false })))
  return sendWrite(res, finishOnce.run(`finish:${loginId}`, run, isSuccess))
})

async function finishSignIn(req: AuthRequest, loginId: string): Promise<SeatWrite> {
  const askedSeat = typeof req.body?.seatId === 'string' ? req.body.seatId : null
  // Which seat this link was started for (bound at /start). A live link always
  // wins over the body; a mismatch is refused rather than guessed at.
  const bound = pendingLoginSeat(loginId)
  if (bound !== undefined && askedSeat && askedSeat !== bound) {
    auditSeat(req.user?.id, 'oauth_failed', askedSeat, 'error=wrong_seat')
    return {
      status: 409,
      body: { error: 'This sign-in link was started for a different seat. Get a new link from this seat\'s Reconnect button.', code: 'wrong_seat' },
    }
  }
  const seatId = bound !== undefined ? bound : askedSeat
  if (seatId) {
    const err = claudeSeatError(seatId)
    if (err) return err
  }
  const result = await finishClaudeLogin({
    loginId,
    pasted: typeof req.body?.code === 'string' ? req.body.code : '',
  })
  if (!result.ok) {
    auditSeat(req.user?.id, 'oauth_failed', seatId, `error=${result.error}`)
    return { status: FINISH_STATUS[result.error], body: { error: result.message, code: result.error } }
  }
  // The seat may have been removed while the operator was on claude.ai.
  if (seatId && !getAccountById(seatId)) {
    auditSeat(req.user?.id, 'oauth_failed', seatId, 'error=seat_not_found')
    return { status: 404, body: { error: 'This seat was removed while you were signing in. Nothing was saved.', code: 'seat_not_found' } }
  }
  let id = seatId
  if (!id) {
    const seat = addAccountSlot({
      kind: 'claude',
      label: typeof req.body?.label === 'string' ? req.body.label : '',
      priority: typeof req.body?.priority === 'number' ? req.body.priority : undefined,
      credentialKind: 'setup_token',
      credentialExpiresAt: result.expiresAt,
    })
    id = seat.id
  }
  // In place: same seat id, label, nickname, priority and history. Only the
  // credential (same secrets-store key, overwritten) and its metadata change.
  const stored = storeSeatCredential(id, result.token, req.user?.id)
  setSeatCredential(id, { ...stored, expiresAt: result.expiresAt, source: 'oauth' })
  auditSeat(req.user?.id, seatId ? 'reconnect' : 'add', id, 'kind=claude credential=setup_token via=oauth')
  // Same proof as the installer: one tiny subscription turn before we call it healthy.
  const outcome = await checkSlot(id)
  auditSeat(req.user?.id, 'test', id, `outcome=${outcome}`)
  return { status: seatId ? 200 : 201, body: { ok: true, outcome, seat: summaryOf(id) } }
}


router.patch('/seats/:id', (req: AuthRequest, res) => {
  const id = req.params.id as string
  if (!seatOr404(id, res)) return
  const patch: Parameters<typeof updateSeat>[1] = {}
  const changed: string[] = []
  if (typeof req.body?.label === 'string') { patch.label = req.body.label; changed.push('label') }
  if (typeof req.body?.priority === 'number') { patch.priority = req.body.priority; changed.push('priority') }
  if (typeof req.body?.enabled === 'boolean') { patch.enabled = req.body.enabled; changed.push(req.body.enabled ? 'enable' : 'disable') }
  const expiresAt = parseExpiry(req.body?.expiresAt)
  if (expiresAt !== undefined) { patch.credentialExpiresAt = expiresAt; changed.push('expiry') }
  if (!changed.length) {
    res.status(400).json({ error: 'nothing to change (label, priority, enabled, expiresAt)' })
    return
  }
  updateSeat(id, patch)
  auditSeat(req.user?.id, 'update', id, changed.join(','))
  res.json({ ok: true, seat: summaryOf(id) })
})

/** Rotate a pasted credential (Claude). Clears parks so the seat gets a fresh start. */
router.post('/seats/:id/rotate', (req: AuthRequest, res) => {
  const id = req.params.id as string
  const seat = seatOr404(id, res)
  if (!seat) return
  if ((seat.kind || 'claude') !== 'claude') {
    res.status(400).json({ error: 'Codex / Grok seats rotate by signing in again (/login/start)' })
    return
  }
  const credential = credentialFrom(req.body)
  if (!credential) {
    res.status(400).json({ error: 'credential is required' })
    return
  }
  const stored = storeSeatCredential(id, credential, req.user?.id)
  setSeatCredential(id, { ...stored, expiresAt: parseExpiry(req.body?.expiresAt) ?? null, source: 'pasted' })
  auditSeat(req.user?.id, 'rotate', id, 'credential=setup_token')
  res.json({ ok: true, seat: summaryOf(id) })
})

/** Test now: one tiny subscription turn (Claude) or a login-file check (Codex / Grok). */
router.post('/seats/:id/test', async (req: AuthRequest, res) => {
  const id = req.params.id as string
  if (!seatOr404(id, res)) return
  const outcome = await checkSlot(id)
  auditSeat(req.user?.id, 'test', id, `outcome=${outcome}`)
  res.json({ ok: true, outcome, seat: summaryOf(id) })
})

/**
 * Remove a seat: out of the pool, its stored credential deleted, its own login
 * files deleted, its pending sign-ins dropped, tombstoned so it does not come
 * back on restart, audited.
 *
 * A seat with a running session is NOT removed (that would pull the credential
 * out from under live work). It is DRAINED instead: disabled so nothing new
 * starts on it, while the running sessions finish normally. The reply says so,
 * and Remove works once they are done.
 */
router.delete('/seats/:id', (req: AuthRequest, res) => {
  const id = req.params.id as string
  const seat = seatOr404(id, res)
  if (!seat) return
  const active = seat.activeSessions.length
  if (active > 0) {
    const wasEnabled = seat.enabled !== false
    if (wasEnabled) updateSeat(id, { enabled: false })
    auditSeat(req.user?.id, 'remove_blocked', id, `active_sessions=${active} drained=${wasEnabled ? 'now' : 'already'}`)
    res.status(409).json({
      error: `This seat is running ${active} session${active === 1 ? '' : 's'}. It is now disabled, so no new work starts on it, and the running work keeps going. Remove it again when they finish.`,
      code: 'seat_in_use',
      activeSessions: active,
      drained: true,
      seat: summaryOf(id),
    })
    return
  }
  const result = removeSeat(id)
  if (!result.removed) {
    // Lost a race with a session starting on it: same answer as above, nothing removed.
    res.status(result.error === 'seat_in_use' ? 409 : 404).json({ error: result.error, code: result.error })
    return
  }
  const removed = result.removed
  const credentialStillStored = deleteSeatCredential(removed.credentialRef, req.user?.id)
  const loginFiles = clearSeatHome(removed)
  cancelClaudeLoginsForSeat(id)
  try { spawnSync('tmux', ['kill-session', '-t', `seat-login-${id}`], { timeout: 5000, stdio: 'ignore' }) } catch { /* no login running */ }
  auditSeat(
    req.user?.id,
    'remove',
    id,
    `kind=${removed.kind || 'claude'} credential=${removed.credentialRef ? (credentialStillStored ? 'delete_failed' : 'deleted') : 'none'} login_files=${loginFiles}`,
  )
  res.json({ ok: true, removed: { id, credentialDeleted: !credentialStillStored, loginFiles } })
})

// ── CLI login flow (Codex / Grok) ───────────────────────────────────────────
// Runs the official CLI's own device login with HOME = the seat's HOME, so the
// login files land in that seat only. The operator approves on any browser; the
// client polls /login/status until the seat's login file appears.

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

function capturePane(tmuxName: string): string {
  try {
    return execSync(`tmux capture-pane -p -J -t ${tmuxName} 2>/dev/null || true`, { encoding: 'utf-8', timeout: 5000 })
  } catch {
    return ''
  }
}

export function deviceLoginCommand(kind: 'codex' | 'grok', homeDir: string): string {
  if (kind === 'grok') {
    // Global grok flags MUST precede `login`.
    return `runuser -u ccuser -- env -u XAI_API_KEY -u GROK_CODE_XAI_API_KEY HOME=${homeDir} PATH=/usr/local/bin:/usr/bin:/bin TERM=xterm-256color grok --no-auto-update --no-alt-screen login --device-auth`
  }
  return `runuser -u ccuser -- env -u OPENAI_API_KEY HOME=${homeDir} PATH=/usr/local/bin:/usr/bin:/bin TERM=xterm-256color codex login --device-auth`
}

router.post('/seats/:id/login/start', async (req: AuthRequest, res) => {
  const id = req.params.id as string
  const seat = seatOr404(id, res)
  if (!seat) return
  const kind = seat.kind || 'claude'
  if (kind === 'claude') {
    res.status(400).json({ error: 'Claude seats sign in with /seats/claude-oauth/start or a pasted setup token' })
    return
  }
  if (!/^[A-Za-z0-9/_.-]+$/.test(seat.homeDir)) {
    res.status(500).json({ error: 'seat home path is not shell-safe' })
    return
  }
  try {
    fs.mkdirSync(seat.homeDir, { recursive: true })
    fs.chmodSync(seat.homeDir, 0o777)
  } catch { /* runuser fails loudly if unwritable */ }
  if (kind === 'grok') ensureGrokCliExecutable()
  const tmuxName = `seat-login-${id}`
  try {
    execSync(`tmux kill-session -t ${tmuxName} 2>/dev/null || true`, { timeout: 5000 })
    execSync(`tmux new-session -d -s ${tmuxName} "${deviceLoginCommand(kind, seat.homeDir)}"`, { timeout: 10000 })
  } catch (err) {
    res.status(500).json({ error: `Failed to start the ${kind} login: ${err instanceof Error ? err.message : String(err)}` })
    return
  }
  auditSeat(req.user?.id, 'login_start', id, `kind=${kind}`)
  for (let i = 0; i < 20; i++) {
    await sleep(1000)
    const pane = capturePane(tmuxName)
    if (/permission denied|unexpected argument|unrecognized|command not found|No such file or directory/i.test(pane)) {
      res.json({ ok: false, error: `The ${kind} CLI could not start a device login. Check that the CLI is installed and up to date.` })
      return
    }
    const parsed = extractGrokDeviceAuth(pane)
    if (parsed) {
      res.json({ ok: true, flow: 'device', url: parsed.url, userCode: parsed.userCode })
      return
    }
  }
  res.json({ ok: false, error: 'Timed out waiting for the device-login code. Try again.' })
})

router.post('/seats/:id/login/status', async (req: AuthRequest, res) => {
  const id = req.params.id as string
  const seat = seatOr404(id, res)
  if (!seat) return
  const tmuxName = `seat-login-${id}`
  const done = () => {
    clearAuthFailure(id)
    try { execSync(`tmux kill-session -t ${tmuxName} 2>/dev/null || true`, { timeout: 5000 }) } catch { /* noop */ }
    auditSeat(req.user?.id, 'login_done', id)
    res.json({ ok: true, success: true, seat: summaryOf(id) })
  }
  if (seatCredentialUsable(seat, false)) return done()
  const pane = capturePane(tmuxName)
  if (grokLoginSucceeded(pane)) {
    for (let i = 0; i < 8; i++) {
      await sleep(500)
      if (seatCredentialUsable(seat, false)) return done()
    }
  }
  const parsed = extractGrokDeviceAuth(pane)
  res.json({ ok: true, pending: true, ...(parsed || {}) })
})

// ── Cross-engine failover (opt-in) ──────────────────────────────────────────

router.get('/seats/failover/:workspace', (req: AuthRequest, res) => {
  res.json({ workspace: req.params.workspace, ...getWorkspaceFailover(req.params.workspace as string) })
})

router.put('/seats/failover/:workspace', (req: AuthRequest, res) => {
  const workspace = req.params.workspace as string
  const order = Array.isArray(req.body?.order) ? normalizeOrder(req.body.order) : undefined
  const saved = setWorkspaceFailover(workspace, {
    enabled: req.body?.enabled === true,
    order: order && order.length ? order : getWorkspaceFailover(workspace).order,
  })
  auditSeat(req.user?.id, 'failover_workspace', null, `workspace=${workspace} enabled=${saved.enabled} order=${saved.order.join('>')}`)
  res.json({ workspace, ...saved })
})

/** Per-card override: `{ mode: 'inherit' | 'pinned' }` or `{ order: [...] }`. */
router.put('/seats/card/:objectiveId/failover', (req: AuthRequest, res) => {
  const objectiveId = Number(req.params.objectiveId)
  if (!Number.isInteger(objectiveId) || objectiveId <= 0) {
    res.status(400).json({ error: 'bad objective id' })
    return
  }
  let value: string | null
  if (req.body?.mode === 'inherit') value = null
  else if (req.body?.mode === 'pinned') value = 'pinned'
  else if (Array.isArray(req.body?.order) && normalizeOrder(req.body.order).length) value = JSON.stringify(normalizeOrder(req.body.order))
  else {
    res.status(400).json({ error: "send { mode: 'inherit' | 'pinned' } or { order: ['claude','codex','grok'] }" })
    return
  }
  const info = getDb().prepare("UPDATE objectives SET engine_failover = ?, updated_at = datetime('now') WHERE id = ?").run(value, objectiveId)
  if (!info.changes) {
    res.status(404).json({ error: 'objective_not_found' })
    return
  }
  auditSeat(req.user?.id, 'failover_card', null, `objective=${objectiveId} value=${value ?? 'inherit'}`)
  res.json({ objectiveId, failover: parseCardFailover(value) ?? 'inherit' })
})

/** Recent seat admin audit rows (no values ever recorded). */
router.get('/seats/audit', (req: AuthRequest, res) => {
  const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit || '50'), 10) || 50))
  const rows = getDb()
    .prepare('SELECT id, at, actor_user_id, action, seat_id, detail FROM seat_audit_log ORDER BY id DESC LIMIT ?')
    .all(limit)
  res.json(rows)
})

export default router
