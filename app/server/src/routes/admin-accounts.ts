/**
 * Admin account-router routes (status, rate-limits, connect, labels) —
 * extracted from admin.ts (behavior frozen).
 *
 * Auth is applied by the admin.ts facade. Paths are unchanged.
 */
import { Router } from 'express'
import type { Response } from 'express'
import { execSync, spawn, spawnSync } from 'child_process'
import fs from 'fs'
import type { AuthRequest } from '../middleware/auth.js'
import { getAccountRouterStatus } from '../services/session-manager.js'
import {
  getRateLimitHistory,
  forceClearRateLimit,
  getAccountById,
  setAccountLabel,
  addAccountSlot,
  recordRateLimit,
  recordAuthFailure,
  clearAuthFailure,
  isRateLimitMessage,
  isAuthFailureMessage,
  parseResetTime,
} from '../services/account-router.js'
import { grokAuthAvailable, GROK_HOME_DIR, ensureGrokCliExecutable } from '../services/session-spawn-command.js'
import { extractGrokDeviceAuth, grokLoginSucceeded } from '../services/grok-device-auth.js'

const router = Router()

// Account router status
router.get('/accounts', (_req: AuthRequest, res) => {
  res.json(getAccountRouterStatus())
})

router.post('/accounts', (req: AuthRequest, res) => {
  const label = typeof req.body?.label === 'string' ? req.body.label : ''
  const kind = req.body?.kind === 'grok' ? 'grok' : 'claude'
  const created = addAccountSlot({ label, kind })
  res.status(201).json({ ok: true, account: { id: created.id, label: created.customLabel || created.label, kind: created.kind || 'claude', homeDir: created.homeDir }, status: getAccountRouterStatus() })
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

// ── Account connect (server-driven OAuth login) ──────────────────────────────
// The whole `claude` login TUI is driven server-side via tmux send-keys /
// capture-pane so the operator never touches a terminal: press Connect → get URL
// → paste code → press Connect. No xterm, no copying wrapped URLs out of a pane.

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

function capturePane(tmuxName: string): string {
  try {
    return execSync(`tmux capture-pane -p -J -t ${tmuxName} 2>/dev/null || true`, { encoding: 'utf-8', timeout: 5000 })
  } catch {
    return ''
  }
}

// send-keys with an args array (no shell) — safe for arbitrary code text.
function tmuxKeys(tmuxName: string, ...keys: string[]): void {
  spawnSync('tmux', ['send-keys', '-t', tmuxName, ...keys], { timeout: 5000 })
}

/**
 * Press Connect → generate the sign-in URL. Drives the login TUI end-to-end:
 * launch `claude` → accept the "Bypass Permissions" prompt if it appears
 * (Down,Enter) → `/login` → the "Select login method" menu defaults to the
 * subscription option (Enter) → capture + stitch the hard-wrapped OAuth URL.
 * Each step is polled because the prompts are conditional. Returns { url } or an
 * error the client shows with a retry.
 */
router.post('/accounts/:id/connect/start', async (req: AuthRequest, res) => {
  const id = req.params.id as string
  if (id === 'grok') {
    await startGrokDeviceLogin(res)
    return
  }
  const account = getAccountById(id)
  if (!account) {
    res.status(404).json({ error: `Unknown account slot: ${id}` })
    return
  }
  const tmuxName = `reconnect-${id}`
  try {
    execSync(`tmux kill-session -t ${tmuxName} 2>/dev/null || true`, { timeout: 5000 })
    execSync(
      `tmux new-session -d -s ${tmuxName} "runuser -u ccuser -- env HOME=${account.homeDir} TERM=xterm-256color claude"`,
      { timeout: 10000 },
    )
  } catch (err) {
    res.status(500).json({ error: `Failed to start login session: ${err instanceof Error ? err.message : String(err)}` })
    return
  }

  // Drive the login TUI as a small state machine. A slot's home dir can be in
  // several states: already-onboarded (jumps to the main prompt), or FRESH
  // (Claude's first-run onboarding gates the prompt — theme picker + "use this
  // API key?"). Handle every screen we might hit, in any order, until we reach
  // the OAuth URL. Each guard is idempotent (fires once per screen) so extra
  // iterations are harmless.
  let themeDone = false      // "Choose the text style" theme picker (fresh dirs)
  let apiKeyDone = false     // "Detected a custom API key … use this API key?" (default No)
  let bypassDone = false     // "Bypass Permissions" responsibility prompt
  let loginTyped = false     // typed /login on an already-onboarded main prompt
  let methodPicked = false   // "Select login method" → subscription (default)

  for (let i = 0; i < 30; i++) {
    await sleep(1000)
    const p = capturePane(tmuxName)

    // Reached the URL already — stop driving and go extract it.
    if (/oauth\/authorize|claude\.(ai|com)\/.*oauth/i.test(p)) break

    // First-run: theme picker. Accept the highlighted default (Enter).
    if (!themeDone && /Choose the text style|Let's get started/i.test(p)) {
      tmuxKeys(tmuxName, 'Enter'); themeDone = true; await sleep(1200); continue
    }
    // First-run: "Detected a custom API key … use this API key?" Default is
    // "No (recommended)" — exactly what we want (subscription OAuth, not the key).
    if (!apiKeyDone && /Detected a custom API key|use this API key/i.test(p)) {
      tmuxKeys(tmuxName, 'Enter'); apiKeyDone = true; await sleep(1200); continue
    }
    // Bypass-permissions responsibility prompt (Down → "Yes, I accept" → Enter).
    if (!bypassDone && /Yes, I accept|accept all responsibility/i.test(p)) {
      tmuxKeys(tmuxName, 'Down'); await sleep(300); tmuxKeys(tmuxName, 'Enter')
      bypassDone = true; await sleep(1500); continue
    }
    // "Select login method" menu — subscription is the default (Enter).
    if (!methodPicked && /Select login method/i.test(p)) {
      tmuxKeys(tmuxName, 'Enter'); methodPicked = true; await sleep(800); continue
    }
    // Already-onboarded account sitting at the main prompt with no login screen
    // yet: trigger /login ourselves (fresh accounts auto-prompt, so only do this
    // if we haven't seen the method menu).
    if (!loginTyped && !methodPicked && /bypass permissions on|for agents|for shortcuts/i.test(p)) {
      tmuxKeys(tmuxName, '-l', '/login'); await sleep(500); tmuxKeys(tmuxName, 'Enter')
      loginTyped = true; await sleep(800); continue
    }
  }

  // Poll for the URL and stitch it back together.
  for (let i = 0; i < 15; i++) {
    const url = extractOAuthUrl(capturePane(tmuxName))
    if (url) { res.json({ ok: true, url }); return }
    await sleep(1000)
  }
  res.json({ ok: false, error: 'Timed out generating the sign-in link — press Connect to try again.' })
})

/**
 * Press Connect (step 2) → submit the pasted code. Sends it to the login TUI,
 * confirms "Login successful", clears the slot's auth-failure / rate-limit flags
 * so it re-enters rotation, and tears down the login tmux. A bad/expired code
 * returns an error so the client can prompt for a fresh link.
 */
router.post('/accounts/:id/connect/submit', async (req: AuthRequest, res) => {
  const id = req.params.id as string
  if (!getAccountById(id)) {
    res.status(404).json({ error: `Unknown account slot: ${id}` })
    return
  }
  const code = typeof req.body?.code === 'string' ? req.body.code.trim() : ''
  if (!code) {
    res.status(400).json({ error: 'Missing code' })
    return
  }
  const tmuxName = `reconnect-${id}`
  tmuxKeys(tmuxName, '-l', code)
  await sleep(300)
  tmuxKeys(tmuxName, 'Enter')

  for (let i = 0; i < 12; i++) {
    await sleep(1000)
    const p = capturePane(tmuxName)
    if (/Login successful/i.test(p)) {
      clearAuthFailure(id)
      forceClearRateLimit(id)
      try { execSync(`tmux kill-session -t ${tmuxName} 2>/dev/null || true`, { timeout: 5000 }) } catch { /* noop */ }
      res.json({ ok: true, success: true, status: getAccountRouterStatus() })
      return
    }
    if (/invalid|expired|failed|not valid|error/i.test(p)) {
      res.json({ ok: false, success: false, error: 'Login failed — the code may be wrong or expired. Get a fresh link and retry.' })
      return
    }
  }
  res.json({ ok: false, success: false, error: 'Timed out confirming login — check the account and retry.' })
})

/**
 * SuperGrok device-code login. `grok login --device-auth` prints a URL + short
 * code; the operator approves on any browser; the CLI writes ~/.grok/auth.json.
 * No paste-back — the client polls /connect/status until the file appears.
 */
async function startGrokDeviceLogin(res: Response): Promise<void> {
  addAccountSlot({ kind: 'grok' })
  try {
    fs.mkdirSync(GROK_HOME_DIR, { recursive: true })
    fs.chmodSync(GROK_HOME_DIR, 0o777)
  } catch { /* runuser will fail loudly if the home is unwritable */ }
  ensureGrokCliExecutable()
  const tmuxName = 'reconnect-grok'
  try {
    execSync(`tmux kill-session -t ${tmuxName} 2>/dev/null || true`, { timeout: 5000 })
    // Global grok flags MUST precede `login`. `grok login --no-auto-update`
    // is "unexpected argument" and never prints a device URL.
    execSync(
      `tmux new-session -d -s ${tmuxName} "runuser -u ccuser -- env -u XAI_API_KEY -u GROK_CODE_XAI_API_KEY HOME=${GROK_HOME_DIR} PATH=/usr/local/bin:/usr/bin:/bin TERM=xterm-256color grok --no-auto-update --no-alt-screen login --device-auth"`,
      { timeout: 10000 },
    )
  } catch (err) {
    res.status(500).json({ error: `Failed to start Grok login: ${err instanceof Error ? err.message : String(err)}` })
    return
  }

  for (let i = 0; i < 20; i++) {
    await sleep(1000)
    const p = capturePane(tmuxName)
    if (/permission denied/i.test(p)) {
      res.json({ ok: false, error: 'grok CLI is not executable by ccuser (installer left it under /root). Rebuild, or Connect will try to flatten the binary.' })
      return
    }
    if (/unexpected argument|command not found|No such file or directory/i.test(p)) {
      res.json({ ok: false, error: 'grok CLI rejected the login command. Rebuild the container, then press Connect again.' })
      return
    }
    const parsed = extractGrokDeviceAuth(p)
    if (parsed) {
      res.json({ ok: true, flow: 'device', url: parsed.url, userCode: parsed.userCode })
      return
    }
  }
  res.json({ ok: false, error: 'Timed out waiting for the SuperGrok device-login code. Press Connect to try again.' })
}

router.post('/accounts/:id/connect/status', async (req: AuthRequest, res) => {
  const id = req.params.id as string
  if (id !== 'grok') {
    res.status(400).json({ error: 'Status poll is only for Grok device login' })
    return
  }
  if (grokAuthAvailable()) {
    clearAuthFailure('grok')
    try { execSync('tmux kill-session -t reconnect-grok 2>/dev/null || true', { timeout: 5000 }) } catch { /* noop */ }
    res.json({ ok: true, success: true, status: getAccountRouterStatus() })
    return
  }
  const p = capturePane('reconnect-grok')
  if (grokLoginSucceeded(p)) {
    for (let i = 0; i < 8; i++) {
      await sleep(500)
      if (grokAuthAvailable()) break
    }
    if (grokAuthAvailable()) {
      clearAuthFailure('grok')
      try { execSync('tmux kill-session -t reconnect-grok 2>/dev/null || true', { timeout: 5000 }) } catch { /* noop */ }
      res.json({ ok: true, success: true, status: getAccountRouterStatus() })
      return
    }
  }
  if (/permission denied|unexpected argument|command not found|No such file or directory/i.test(p)) {
    res.json({ ok: false, error: 'grok CLI failed to start device login. Close and press Connect again.' })
    return
  }
  const parsed = extractGrokDeviceAuth(p)
  res.json({ ok: true, pending: true, ...(parsed || {}) })
})

/**
 * Rename an account slot (operator display label). Empty string reverts to the
 * built-in default name.
 */
router.put('/accounts/:id/label', (req: AuthRequest, res) => {
  const id = req.params.id as string
  const label = typeof req.body?.label === 'string' ? req.body.label : ''
  const updated = setAccountLabel(id, label)
  if (!updated) {
    res.status(404).json({ error: `Unknown account slot: ${id}` })
    return
  }
  res.json({ ok: true, id, label: updated.customLabel || updated.label, status: getAccountRouterStatus() })
})

/**
 * Stitch a hard-wrapped Claude OAuth URL out of captured tmux pane text. The URL
 * starts at `https://claude.<com|ai>/…oauth/authorize` and continues on the next
 * lines as contiguous non-whitespace fragments until a blank line / a line with
 * internal spaces (i.e. non-URL text). Returns the joined URL or null.
 */
function extractOAuthUrl(pane: string): string | null {
  const lines = pane.split('\n')
  const start = lines.findIndex(l => /https:\/\/claude\.(com|ai)\/\S*oauth\/authorize/.test(l.trim()))
  if (start < 0) return null
  let url = ''
  for (let i = start; i < lines.length; i++) {
    const t = lines[i].trim()
    if (t === '') break
    if (/\s/.test(t)) break // a line with an internal space is no longer the URL
    url += t
  }
  return /^https:\/\/claude\.(com|ai)\/\S*oauth\/authorize\?/.test(url) ? url : null
}

/**
 * Run a single non-interactive Claude turn as the given account HOME and report
 * whether it served, was rate-limited, or failed. Uses spawn (not execSync) so
 * the ~45s probe never blocks the event loop, with a hard kill on timeout.
 *
 * CRITICAL: the probe must `unset` ANTHROPIC_API_KEY (and the other provider
 * keys) exactly like session-manager does before spawning a session. The server
 * process has ANTHROPIC_API_KEY in its env; without unsetting it, `claude` falls
 * back to API-key billing and returns a healthy "Pong" even when the account's
 * SUBSCRIPTION OAuth credential is dead — a false "serving" that masks the very
 * auth failure we're trying to detect. Stripping the keys makes the probe use
 * the same OAuth path sessions do, so its verdict matches real session behavior.
 */
function probeAccount(homeDir: string): Promise<{ ok: boolean; rateLimited: boolean; authFailure: boolean; output: string }> {
  return new Promise((resolve) => {
    let out = ''
    let settled = false
    const child = spawn(
      'runuser',
      [
        '-u', 'ccuser', '--', 'bash', '-c',
        `unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN OPENAI_API_KEY GEMINI_API_KEY GOOGLE_API_KEY; ` +
        `export HOME=${JSON.stringify(homeDir)} TERM=dumb; ` +
        `exec claude -p ping --dangerously-skip-permissions`,
      ],
      { cwd: homeDir, env: { ...process.env, TERM: 'dumb' } },
    )
    const done = (result: { ok: boolean; rateLimited: boolean; authFailure: boolean; output: string }) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch {}
      done({ ok: false, rateLimited: false, authFailure: false, output: out || 'probe timed out after 45s' })
    }, 45000)
    child.stdout?.on('data', (d) => { out += d.toString() })
    child.stderr?.on('data', (d) => { out += d.toString() })
    child.on('error', (err) => {
      done({ ok: false, rateLimited: false, authFailure: false, output: `spawn error: ${err.message}` })
    })
    child.on('close', (code) => {
      const rateLimited = isRateLimitMessage(out)
      const authFailure = isAuthFailureMessage(out)
      // Serving iff a clean exit that isn't secretly a rate-limit/auth message.
      const ok = code === 0 && !rateLimited && !authFailure
      done({ ok, rateLimited, authFailure, output: out })
    })
  })
}


export default router
