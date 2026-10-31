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
import { execSync } from 'child_process'
import fs from 'fs'
import type { AuthRequest } from '../middleware/auth.js'
import { getDb } from '../db/index.js'
import {
  addAccountSlot,
  clearAuthFailure,
  getAccountById,
  getRouterStatus,
  removeSeat,
  seatCredentialUsable,
  setSeatCredential,
  updateSeat,
} from '../services/account-router.js'
import { checkSlot } from '../services/account-health-check.js'
import { deleteSeatCredential, maskSeat, storeSeatCredential, type SeatSummary } from '../services/seat-credentials.js'
import { getWorkspaceFailover, setWorkspaceFailover } from '../services/seat-assign.js'
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

/** All seats, masked, with live availability. */
export function listSeatSummaries(): SeatSummary[] {
  return getRouterStatus().accounts.map(a => maskSeat(a))
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
  const row = getRouterStatus().accounts.find(a => a.id === id)
  return row ? maskSeat(row) : null
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
  res.json({ seats: listSeatSummaries(), kinds: SEAT_KINDS })
})

/**
 * Add a seat. Claude: paste a `claude setup-token` token (`credential`), stored
 * in the secrets store. Codex / Grok: the seat is created empty and the client
 * then calls /login/start to run the CLI's own device login into its HOME.
 */
router.post('/seats', (req: AuthRequest, res) => {
  const kind = parseKind(req.body?.kind)
  if (!kind) {
    res.status(400).json({ error: 'kind must be claude, codex or grok' })
    return
  }
  const credential = credentialFrom(req.body)
  if (kind === 'claude' && !credential) {
    res.status(400).json({ error: 'paste the setup token for a Claude seat (from `claude setup-token`)' })
    return
  }
  if (kind !== 'claude' && credential) {
    res.status(400).json({ error: `${kind} seats sign in with the CLI login flow, not a pasted token` })
    return
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
    setSeatCredential(seat.id, { ...stored, expiresAt: expiresAt ?? null })
  }
  auditSeat(req.user?.id, 'add', seat.id, `kind=${kind}${credential ? ' credential=setup_token' : ''}`)
  res.status(201).json({ ok: true, seat: summaryOf(seat.id) })
})

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
  setSeatCredential(id, { ...stored, expiresAt: parseExpiry(req.body?.expiresAt) ?? null })
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

router.delete('/seats/:id', (req: AuthRequest, res) => {
  const id = req.params.id as string
  const result = removeSeat(id)
  if (!result.removed) {
    res.status(result.error === 'seat_in_use' ? 409 : 404).json({ error: result.error })
    return
  }
  deleteSeatCredential(result.removed.credentialRef, req.user?.id)
  auditSeat(req.user?.id, 'remove', id, `kind=${result.removed.kind || 'claude'}`)
  res.json({ ok: true })
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
    res.status(400).json({ error: 'Claude seats are added by pasting a setup token' })
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
