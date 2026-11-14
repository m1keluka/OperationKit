/**
 * Installer hooks (obj 720210). Localhost + X-Internal-Secret, used by the
 * client installer through `docker exec command-center curl …`.
 *
 *   POST /api/internal/install/reload-caches
 *     install-bootstrap.ts writes workspaces and agents straight to SQLite from a
 *     separate process. The running server caches both registries in memory, so
 *     until it re-reads them it still sees the pre-bootstrap rows: the starter
 *     pack failed with `no workspace named "<ws>"`, and the archived sample
 *     workspaces/agents stayed visible. This drops both caches.
 *
 *   GET /api/internal/install/seat-status
 *     Can a new session start right now? install/verify.sh asks before it
 *     creates its test card, so an install whose only seat the sandbox refuses
 *     fails fast instead of waiting out the card timeout.
 */
import { Router } from 'express'
import { isLocalhost } from '../lib/is-localhost.js'
import { requireInternalSecret } from '../middleware/internal-secret.js'
import { invalidateWorkspacesCache, getWorkspaceSlugs } from '../services/workspaces.js'
import { invalidateAgentsCache, listAgents } from '../services/agent-registry.js'
import { hasAvailableSeat, seatCount } from '../services/account-router.js'
import { resolveBrowserPolicy } from '../lib/browser-policy.js'
import { sharedBrowserEgressProxy } from '../services/browser-egress-proxy.js'
import { PLAYWRIGHT_VERSION, PLAYWRIGHT_MCP_VERSION, CHROMIUM_VERSION } from '../lib/browser-pins.js'

const router = Router()
router.use((req, res, next) => {
  if (!isLocalhost(req)) { res.status(403).json({ error: 'Internal API: localhost only' }); return }
  if (!requireInternalSecret(req, res)) return
  next()
})

router.post('/reload-caches', (_req, res) => {
  invalidateWorkspacesCache()
  invalidateAgentsCache()
  const workspaces = getWorkspaceSlugs()
  const agents = listAgents().map(a => a.slug)
  console.log(`[install] caches reloaded: ${workspaces.length} workspace(s), ${agents.length} agent(s)`)
  res.json({ ok: true, workspaces, agents })
})

router.get('/seat-status', (_req, res) => {
  const usable = hasAvailableSeat('claude')
  res.json({
    claude: { usable, seats: seatCount('claude') },
    reason: usable ? null : 'no Claude seat a sandboxed session can use (connect Claude: install/claude-login.sh, or Settings → Seats → Add Claude seat)',
  })
})

/**
 * GET /api/internal/install/browser-status (obj 900024)
 *
 * What the card browser is actually locked down to, as the RUNNING process
 * sees it — not as client.conf claims. install/verify.sh reads this to decide
 * PASS/FAIL, so it has to report the live values and the live guard, including
 * every control an operator widened (`warnings`).
 *
 * Deliberately reports no secret and no credential: versions, booleans, origin
 * patterns and a port. An origin allowlist is not sensitive — an attacker who
 * could read this route already has the internal secret and loopback.
 */
router.get('/browser-status', (_req, res) => {
  const policy = resolveBrowserPolicy()
  const guard = sharedBrowserEgressProxy()
  res.json({
    sandbox: policy.sandbox,
    egress_guard: {
      configured: policy.egressGuard,
      running: !!guard,
      port: guard?.port ?? null,
    },
    allowed_origins: policy.allowedOrigins,
    blocked_origins: policy.blockedOrigins,
    allow_loopback: policy.allowLoopback,
    allow_private_network: policy.allowPrivateNetwork,
    allow_metadata: policy.allowMetadata,
    pins: {
      playwright: PLAYWRIGHT_VERSION,
      playwright_mcp: PLAYWRIGHT_MCP_VERSION,
      chromium: CHROMIUM_VERSION,
    },
    warnings: policy.warnings,
    // True only when every default control is still in place.
    locked_down:
      policy.sandbox &&
      policy.egressGuard &&
      !!guard &&
      !policy.allowPrivateNetwork &&
      !policy.allowMetadata &&
      !policy.allowedOrigins.includes('*'),
  })
})

export default router
