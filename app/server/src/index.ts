import express from 'express'
import cookieParser from 'cookie-parser'
import cors from 'cors'
import { createServer } from 'http'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { initDb, getDb } from './db/index.js'
import { initWebSocket } from './ws/index.js'
import { startPoller } from './services/state-poller.js'
import { logPreviewSpoolHealth } from './services/preview-spool.js'
import authRouter from './routes/auth.js'
import objectivesRouter from './routes/objectives.js'
import objectivesSearchRouter from './routes/objectives-search.js'
import feedRouter from './routes/feed.js'
import shellRouter from './routes/shell.js'
import docsRouter from './routes/docs.js'
import mentorRouter from './routes/mentor.js'
import jarvisRouter from './routes/jarvis.js'
import assistantRouter from './routes/assistant.js'
import statusRouter from './routes/status.js'
import webhooksRouter from './routes/webhooks.js'
import costsRouter from './routes/costs.js'
import adminRouter from './routes/admin.js'
import n8nRouter from './routes/n8n.js'
import adminUsersRouter from './routes/admin-users.js'
import internalRouter from './routes/internal.js'
import internalVaultRouter from './routes/internal-vault.js'
import alertsRouter from './routes/alerts.js'
import internalRoutinesRouter from './routes/internal-routines.js'
import internalOperationkitRouter from './routes/internal-operationkit.js'
import prHealthRouter from './routes/pr-health.js'
import intelligenceRouter from './routes/intelligence.js'
import adminWorkspacesRouter from './routes/admin-workspaces.js'
import workspacesRouter from './routes/workspaces.js'
import contactsRouter from './routes/contacts.js'
import loopsRouter from './routes/loops.js'
import scratchpadRouter from './routes/scratchpad.js'
import granolaContentRouter from './routes/granola-content.js'
import meetingQueueRouter from './routes/meeting-queue.js'
import { reviewsRouter, internalReviewsRouter } from './routes/reviews.js'
import { correctionsRouter } from './routes/corrections.js'
import testCredentialsRouter, { internalTestCredentialsRouter } from './routes/test-credentials.js'
import modelsRouter from './routes/models.js'
import githubWebhookRouter from './routes/github-webhook.js'
import changelogRouter, { internalChangelogRouter } from './routes/changelog.js'
import publicDevRouter from './routes/public-dev.js'
import devItemsRouter from './routes/dev-items.js'
import devChangelogRouter from './routes/dev-changelog.js'
import { devIngestCors } from './middleware/dev-ingest-token.js'
import userGithubTokenRouter from './routes/user-github-token.js'
import secretsRouter from './routes/secrets.js'
import userGoogleRouter from './routes/user-google.js'
import resourceAssignmentsRouter from './routes/resource-assignments.js'
import projectsRouter from './routes/projects.js'
import { isLocalhost } from './lib/is-localhost.js'
import { requireAuth, requireAdmin, assertJwtSecret, type AuthRequest } from './middleware/auth.js'
import { securityHeaders } from './middleware/security-headers.js'
import { getUserWorkspaces } from './middleware/workspace.js'
import { WORKSPACES_JSON } from './config.js'
import { hydrateProcessEnvFromSecretsStore } from './services/secrets-store.js'
import {
  getIntelForObjective,
  requeueParsedSessions,
  backfillDailyUsage,
} from './services/session-intel-pipeline.js'
import { prewarmSessionOutputs } from './services/stream-parser.js'
import { startDreamCycleScheduler } from './services/dream-cycle.js'
import { startRoutineScheduler } from './services/routine-scheduler.js'
import { startCanaryHarnessScheduler } from './services/canary-harness.js'
import { startKitchenLoop } from './services/kitchen-loop.js'
import { startJarvisNudgeScheduler } from './services/jarvis-nudge.js'
import { startCiFeedbackBridge } from './services/ci-feedback-bridge.js'
import { startDriftGuard } from './services/drift-guard.js'
import { startObjectivesSafety } from './services/objectives-safety.js'
import { startPrHealthWatchdog } from './services/pr-health-watchdog.js'
import { startHostBootDaemons } from './services/host-boot-daemons.js'
import { startN8nWatchdog } from './services/n8n-watchdog.js'
import { startDiskWatchdog } from './services/disk-watchdog.js'
import { startRolodexSibling } from './services/rolodex-supervisor.js'
import { assertInternalApiSecret } from './middleware/internal-secret.js'
import agentApiRouter from './routes/agent-api.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PORT = parseInt(process.env.PORT || '3002', 10)

// Initialize database. A failed initDb() means the server CANNOT serve — do NOT
// let the global uncaughtException keep-alive (below) mask it as "alive but not
// listening". That masking turned the 2026-06-28 gate_false_pass migration bug
// into a silent outage (process up, port never bound, deploy reported success).
// Crash LOUD with a non-zero exit so the entrypoint respawn is honest and the
// deploy health-gate (scripts/self-deploy.sh) detects + auto-rolls-back. (obj-1955)
try {
  initDb()
  console.log('Database initialized')
} catch (err) {
  console.error('[FATAL] initDb() failed — the server cannot serve. Exiting for a clean supervised restart:', err)
  process.exit(1)
}

// Native secrets store → process.env for keys compose did not already set.
// Replaces the old `doppler secrets get` boot fetch. Must run after initDb.
const hydrated = hydrateProcessEnvFromSecretsStore()
if (hydrated > 0) console.log(`[startup] Loaded ${hydrated} secret(s) from the native store`)

// Fail boot if the internal-route shared secret is missing in production —
// internal localhost routes are unauthenticated without it (audit B5 / T6).
assertInternalApiSecret()
assertJwtSecret()
if (process.env.NODE_ENV === 'production' && !process.env.UPTIMEROBOT_WEBHOOK_TOKEN) {
  console.warn(
    '[startup] UPTIMEROBOT_WEBHOOK_TOKEN unset — /api/webhooks/uptimerobot accepts unauthenticated POSTs. ' +
      'Set the env var and append ?token=… to the UptimeRobot webhook URL.'
  )
}

// Reconcile per-account stats from session_intel + jsonl transcripts. Recovers
// historical tokens/cost the previous (broken) extractFinalUsage failed to record.
import { reconcileFromHistory, enqueueSession } from './services/account-router.js'
import { shouldRefusePrimaryBind } from './services/primary-server-guard.js'
import { extractUsageForSessionId, setQueueDrainCallback } from './services/session-manager.js'
try {
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
  const rows = getDb().prepare(
    `SELECT session_id, account_id, ended_at FROM session_intel
     WHERE ended_at > ? AND account_id IS NOT NULL
     ORDER BY ended_at ASC`
  ).all(cutoff) as Array<{ session_id: string; account_id: string; ended_at: string }>
  reconcileFromHistory(rows, extractUsageForSessionId)
} catch (err) {
  console.error('[startup] Account reconciliation failed:', err)
}

// Sessions now run in tmux and survive server restarts — no resume needed.

const app = express()
const server = createServer(app)

// Behind the Caddy reverse proxy (cc.example.com -> localhost:3002), so that
// req.ip reflects the real client via X-Forwarded-For instead of Caddy's
// loopback address. Without this, EVERY externally-proxied request would look
// like 127.0.0.1 and satisfy the isLocalhost() internal-route origin check.
// Genuine on-box first-party callers connect to localhost:3002 directly (no
// XFF) and still resolve to 127.0.0.1, so they remain "localhost" (obj 702304).
app.set('trust proxy', true)
app.disable('x-powered-by')

// Middleware
app.use(securityHeaders)
app.use(cors({
  origin: process.env.CORS_ORIGINS
    ? process.env.CORS_ORIGINS.split(',')
    : ['https://cc.example.com', 'http://localhost:5173', 'http://localhost:3002'],
  credentials: true,
}))
// GitHub webhook (obj 937 changelog collector) must read the RAW body to verify
// the HMAC-SHA256 signature, so it is mounted with express.raw BEFORE the global
// JSON parser. express.json then no-ops for this path (req._body already set).
app.use('/api/webhooks/github', express.raw({ type: '*/*', limit: '5mb' }), githubWebhookRouter)
app.use(express.json({ limit: '2mb' }))
app.use(cookieParser())

// API routes
app.use('/api/auth', authRouter)
app.use('/api/objectives/search', objectivesSearchRouter)  // server-side objective search (keyword+fuzzy + AI); before objectivesRouter so /search isn't captured by GET /:id (obj 702388)
app.use('/api/objectives', objectivesRouter)
app.use('/api/costs', costsRouter)  // /api/costs/summary, /daily, /by-objective, /by-account
app.use('/api', feedRouter)  // /api/projects/:project/feed, /api/feed/all
app.use('/api/docs', docsRouter)  // /api/docs/tree, /api/docs/file
app.use('/api/mentor', mentorRouter)  // /api/mentor/threads, /api/mentor/threads/:id/messages
app.use('/api/jarvis', jarvisRouter)  // /api/jarvis/briefing
app.use('/api/assistant', assistantRouter)  // /api/assistant/config — per-user Personal Assistant config (obj 701700)
app.use('/api/status', statusRouter)  // /api/status/monitors, /api/status/events
app.use('/api/webhooks', webhooksRouter)  // /api/webhooks/uptimerobot
app.use('/api/admin', adminRouter)  // /api/admin/accounts, /system, /agents, /dream-cycle, etc.
app.use('/api/n8n', n8nRouter)      // n8n watchdog: /health, /refresh, /restart
app.use('/api/projects', projectsRouter)  // /api/projects — board project CRUD (obj 708808)
app.use('/api/internal', internalRouter)  // /api/internal/deploy, /restart, /objectives, /pr-created, /progress
app.use('/api/internal', internalVaultRouter)  // /api/internal/vault/*, /rolodex/history — telegram-rolodex sibling (localhost)
app.use('/api/alerts', alertsRouter)  // ingest (bearer) + list/ack (JWT) — AlertBell + notify-failure.sh
app.use('/api/internal/routines', internalRoutinesRouter)  // routines CRUD + run-now (localhost-only)
app.use('/api/internal/pr-health', prHealthRouter)         // read-only PR-health surface: / (JSON) + /digest (markdown)
app.use('/api/internal/operationkit', internalOperationkitRouter)  // OperationKit authoring: registry / validate / scaffold (localhost-only)
app.use('/api/intel', intelligenceRouter)  // /api/intel/blockers, /conflicts, /recent
app.use('/api/admin/workspaces', adminWorkspacesRouter)  // workspace membership + workspace CRUD
app.use('/api/admin/users', adminUsersRouter)            // user CRUD + role + workspace memberships
app.use('/api/workspaces', workspacesRouter)              // DB-backed: workspaces visible to caller
app.use('/api/models', modelsRouter)                      // model registry: GET enabled (auth) / all + PATCH toggle (admin)
app.use('/api/contacts', contactsRouter)                  // Phase 1 Personal CRM: POST /reindex (admin)
app.use('/api/meeting-queue', meetingQueueRouter)         // Granola action-item review queue → CC objectives
app.use('/api/loops', loopsRouter)                        // personal loops tracker (Kanban: pending/queued/working/done; admin-only)
app.use('/api/scratchpad', scratchpadRouter)              // per-user human markdown store (auth; strictly per-account)
app.use('/api/granola-content', granolaContentRouter)     // personal Granola Content surface (drafts/hooks/ideas; admin-only)
app.use('/api/objectives', reviewsRouter)                 // /api/objectives/:id/reviews — AI Review iteration history
app.use('/api/objectives', correctionsRouter)             // /api/objectives/:id/corrections — human mistake-labeling (ST5)
app.use('/api/internal/reviews', internalReviewsRouter)   // /api/internal/reviews/:id/criteria (localhost-only)
app.use('/api/test-credentials', testCredentialsRouter)   // workspace-admin scoped CRUD (fields encrypted at rest)
app.use('/api/internal/test-credentials', internalTestCredentialsRouter)  // localhost-only plaintext fetch for reviewer spawn
app.use('/api/user/github-token', userGithubTokenRouter)  // per-user GitHub PAT: link/validate/revoke (auth; encrypted at rest, masked)
app.use('/api/user/google', userGoogleRouter)              // per-user Google Workspace OAuth: connect/callback/disconnect (auth except callback; encrypted at rest, masked)
app.use('/api/secrets', secretsRouter)                    // native scoped secrets store: scoped CRUD + versions + rollback (auth; encrypted at rest, masked summaries only)
app.use('/api/resource-assignments', resourceAssignmentsRouter)  // scoped agent/skill assignment (obj-2388): global/workspace/user/project CRUD + /resolve (reuses 1731 scope model)
// Stakeholder "What's Shipping" changelog (obj 937). Public surface (page + JSON feed)
// gated by CHANGELOG_PUBLIC/CHANGELOG_TOKEN; internal collect/retranslate is localhost-only.
app.use('/changelog', changelogRouter)                    // GET /changelog (page), GET /changelog/feed.json (embed feed)
app.use(
  '/api/internal/changelog',
  (req, res, next) => (isLocalhost(req) ? next() : res.status(403).json({ error: 'Internal API: localhost only' })),
  internalChangelogRouter,
)                                                          // /collect, /retranslate/:id, /entries (localhost-only)

// ── Universal Development (obj-704214) ──────────────────────────────────────
// Public ingest surface: called from ANOTHER platform's browser by the feedback
// widget, so it is authenticated by a per-workspace ingest token (NOT a CC
// session, NOT OBJECTIVES_API_TOKEN) and needs its own CORS handling.
// `devIngestCors` runs first so the preflight OPTIONS is answered before the
// token gate rejects it. The router owns its own express.json({limit:'1mb'}) —
// tighter than the global 2mb at :181 — because console_log/route_history are
// the only large fields and both are truncated server-side.
//
// This must sit AFTER the raw-body GitHub webhook mount above (so the JSON
// parser is never applied to webhook bytes) and BEFORE any SPA catch-all.
app.use('/api/public', devIngestCors, publicDevRouter)     // P1-P4: ingest, attachment, "my requests", per-workspace changelog feed
// Admin surface: CC session + admin gate (triage is Mike-only by decision; there
// is deliberately NO per-workspace ACL).
app.use('/api/dev-items', devItemsRouter)                  // A1-A11: board list/detail/create/patch/triage/promote/rank/attach-pr/notes/delete/bulk
app.use('/api/dev-changelog', devChangelogRouter)          // A12-A16: internal changelog list/edit/publish/retranslate/notify

// Health check
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() })
})

// Agent discovery + OpenAPI (no auth — the spec is not secret; board data is).
app.use('/api', agentApiRouter)

// Legacy workspaces project-metadata config (projects[], knowledge{}, context).
// Kept under /api/workspaces-config so the new DB-backed /api/workspaces can own
// the workspace list. ObjectiveModal/ConfigPage/ProjectFeed read this for project rosters.
app.get('/api/workspaces-config', requireAuth, (req: AuthRequest, res) => {
  try {
    const content = fs.readFileSync(WORKSPACES_JSON, 'utf-8')
    const parsed = JSON.parse(content) as { workspaces: Record<string, unknown> }
    const user = req.user!
    if (user.role === 'admin' || !parsed.workspaces) {
      res.json(parsed)
      return
    }
    // Phase 5: members only see their own workspaces' project rosters.
    const allowed = new Set(getUserWorkspaces(user.id).map(w => w.workspace))
    const filtered: Record<string, unknown> = {}
    for (const [slug, ws] of Object.entries(parsed.workspaces)) {
      if (allowed.has(slug)) filtered[slug] = ws
    }
    res.json({ ...parsed, workspaces: filtered })
  } catch {
    res.status(404).json({ error: 'Workspaces config not found' })
  }
})

// Phase 5: per-objective intel exposes session summaries, blockers, and
// file ops. Members must own the objective (or be admins) to see it. Returns
// the error string to surface (404 vs 403), or null on pass.
function checkObjectiveAccess(req: AuthRequest, objectiveId: number): { status: number; error: string } | null {
  const user = req.user!
  if (user.role === 'admin') return null
  const db = getDb()
  const row = db
    .prepare('SELECT workspace, created_by, assigned_user_id FROM objectives WHERE id = ?')
    .get(objectiveId) as { workspace: string; created_by: number | null; assigned_user_id: number | null } | undefined
  if (!row) return { status: 404, error: 'Objective not found' }
  const memberships = new Set(getUserWorkspaces(user.id).map(w => w.workspace))
  if (!memberships.has(row.workspace)) return { status: 403, error: 'No access to this objective' }
  if (row.created_by !== user.id && row.assigned_user_id !== user.id) {
    // Check the multi-assignee join table before denying — this caller may be
    // one of several listed assignees even when they're not the primary.
    const extra = db
      .prepare('SELECT 1 FROM objective_assignees WHERE objective_id = ? AND user_id = ?')
      .get(objectiveId, user.id)
    if (!extra) return { status: 403, error: 'No access to this objective' }
  }
  return null
}

// Get all session intel for an objective
app.get('/api/objectives/:id/intel', requireAuth, (req: AuthRequest, res) => {
  const id = parseInt(req.params.id as string)
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: 'invalid id' })
    return
  }
  const err = checkObjectiveAccess(req, id)
  if (err) {
    res.status(err.status).json({ error: err.error })
    return
  }
  res.json(getIntelForObjective(id))
})

// Get session events timeline for an objective
app.get('/api/objectives/:id/timeline', requireAuth, (req: AuthRequest, res) => {
  const id = parseInt(req.params.id as string)
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: 'invalid id' })
    return
  }
  const err = checkObjectiveAccess(req, id)
  if (err) {
    res.status(err.status).json({ error: err.error })
    return
  }
  const db = getDb()
  const events = db.prepare(
    'SELECT * FROM session_events WHERE objective_id = ? ORDER BY created_at DESC LIMIT 50'
  ).all(id)
  res.json(events)
})

// Shell terminal page (admin only, before static catch-all)
app.use('/shell', shellRouter)

// Serve static frontend in production
const clientDist = path.join(__dirname, '../../client/dist')
app.use(express.static(clientDist))
app.get('*', (_req, res) => {
  res.sendFile(path.join(clientDist, 'index.html'))
})

// Initialize WebSocket
initWebSocket(server)
console.log('WebSocket server initialized')

// Start state poller
startPoller()

// Start dream cycle scheduler (daily full + hourly light)
startDreamCycleScheduler()

// Start routines scheduler (cron-scheduled recurring objectives, 60s tick)
startRoutineScheduler()

// Start the anti-signal canary harness scheduler (obj-2376). Ticks are a NO-OP
// until Mike opts in via `canary_harness_enabled=1` — nothing auto-fires on deploy.
startCanaryHarnessScheduler()

// Start the Kitchen Loop driver (obj 700099) — Phase-0 SHADOW. A COMPLETE no-op
// until Mike opts in via `kitchen_loop_enabled=1`; with the flag OFF it returns
// before arming any timer (boot is byte-for-byte unchanged). When ON it ticks the
// six-phase machine in SHADOW only — dry-run ideate, read-only oracle, drift
// snapshots, logged-only pause gates. Nothing emits to the board.
startKitchenLoop()

// Start Jarvis morning-nudge scheduler (daily 07:00 America/New_York Telegram digest)
startJarvisNudgeScheduler()

// Start the CI → objective feedback bridge poller (obj 701617, 5-min tick). Reads open
// example-platform PRs' vitest check and, on FAILURE, posts the failing-test summary back
// into the originating objective so the worker re-opens and iterates until green. The
// timer arms but is INERT until Mike sets settings.ci_feedback_bridge_enabled=1 — while
// off it only logs "WOULD nudge" and posts nothing (no live worker is disturbed).
startCiFeedbackBridge()

// Start live-checkout drift guard (60s tick) — surfaces "unbacked production"
// (uncommitted served-path edits, or HEAD != origin/main) loudly in logs + the
// AlertBell UI so the obj-1124 silent-deletion class of failure can't recur.
startDriftGuard()
// Objectives blast-radius safety net (15-min snapshots + 60s drop-guard). See objectives-safety.ts.
startObjectivesSafety()

// PR-health watchdog (obj 704700, 10-min sweep). The RECONCILER under the event-driven
// remediation loop: enumerates every open PR across the tracked repos and guarantees a
// red PR is either being remediated or explicitly escalated, so a missed webhook or an
// ownerless PR can no longer sit red forever. The timer arms but is INERT until Mike
// sets settings.pr_health_watchdog_enabled=1 — while off, ticks return before shelling
// out to gh and every decided action only logs "WOULD act". The read-only surface at
// GET /api/internal/pr-health[/digest] works either way.
startPrHealthWatchdog()

// Host daemon supervision (obj 704925). THIS SERVER'S BOOT PATH IS THE ONLY
// ccuser-controllable code that runs after a container restart -- there is no cron,
// systemd or supervisord on this host, and /app/entrypoint.sh is not writable by ccuser.
// Runs (and periodically re-runs) /home/operator/ai-workspace/host-boot.d/run-all.sh, which
// flock-idempotently ensures each registered host daemon is up. Deliberately thin: all
// daemon logic lives outside this repo so adding one needs no CC deploy.
startHostBootDaemons()

// n8n sibling watchdog (30s): inspect n8n + n8n-db, auto-start if they died,
// AlertBell-only page on down/recovery. Docker socket is mounted.
startN8nWatchdog()
// Host disk watermarks (5 min): AlertBell at 85%, cleanup at 90%, POST /message
// returns 507 under 2 GiB free so a full disk cannot hang the composer.
startDiskWatchdog()
// Queue drain: when a rate-limited account recovers (or a new slot is added),
// auto-start objectives that were queued because all accounts were exhausted.
// Reuses the internal status endpoint so the full transition logic
// (session spawn, intel bookkeeping, concurrency cap) applies. This was the
// missing wiring — setQueueDrainCallback was defined but never invoked, so
// queued objectives sat forever after limits reset (found 2026-06-12).
setQueueDrainCallback((objectiveId) => {
  fetch(`http://localhost:${PORT}/api/internal/objectives/${objectiveId}/status`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'working' }),
  })
    .then(async (r) => {
      if (!r.ok) {
        const body = await r.text().catch(() => '')
        console.error(`[queue-drain] Failed to start objective ${objectiveId}: ${r.status} ${body.slice(0, 200)}`)
        // Don't silently drop: the objective was already dequeued, so a transient
        // failure (5xx, or a 409 concurrency-cap) would lose it forever. Re-queue
        // it for the next drain tick. A 400 (invalid transition — typically the
        // objective is already 'working') is NOT retried, since re-queuing would
        // just loop; the state-poller's orphan sweep moves such a stuck objective
        // to 'review' so a later drain PATCH (review→working) succeeds instead.
        if (r.status !== 400) enqueueSession(objectiveId)
      } else {
        console.log(`[queue-drain] Auto-started queued objective ${objectiveId}`)
      }
    })
    .catch((err) => console.error(`[queue-drain] Request error for objective ${objectiveId}:`, err))
})

// NOTE: there is deliberately NO generic "queue drain" here. `queue` is a manual
// holding/pending area — cards sit there as a reminder until a human (or their
// owning delegator) launches them, and must NOT be auto-spawned wholesale. The
// one case that genuinely must auto-advance — a delegator's own queued workers —
// is handled by the targeted delegator wake net (reconcileDecision treats a
// `queued > 0` child as actionable → reconcileDelegators/nudgeDelegator revives
// the dormant delegator so IT spawns its workers). That path, not a blanket
// sweep, is the real fix for the orphaned-delegator bug (obj 1284: 938/1017).

// Sessions run in tmux — they survive SIGTERM/SIGINT. No snapshot needed.
process.on('SIGTERM', () => process.exit(0))
process.on('SIGINT', () => process.exit(0))

// Last-resort resilience guard (obj 1180). A single unhandled throw in an async
// route handler (e.g. buildPrompt seeing a raw-string acceptance_criteria) was
// crash-looping the ENTIRE multi-tenant server under Node 22 — every request
// across every workspace died with it (502s, blank session logs). One bad
// request must never take the whole platform down: log loudly and keep serving.
// The underlying bug is still fixed at its source; this is defense in depth so
// the next unforeseen throw degrades to a single failed request, not an outage.
process.on('unhandledRejection', (reason) => {
  console.error('[fatal] unhandledRejection (kept alive — see obj 1180):', reason)
})
process.on('uncaughtException', (err) => {
  console.error('[fatal] uncaughtException (kept alive — see obj 1180):', err)
})

// Rogue-server guard (obj-1955): refuse to bind the PRIMARY port from a session
// worktree. A worktree-launched `tsx src/index.ts` once squatted :3002 for ~13h,
// breaking restarts. Throwaway/worktree servers must use a non-3002 PORT.
if (shouldRefusePrimaryBind({ port: PORT, moduleUrl: import.meta.url, cwd: process.cwd() })) {
  console.error(
    `[FATAL] Refusing to bind primary port ${PORT} from a worktree (cwd=${process.cwd()}). ` +
      `A throwaway/worktree server must set PORT to a non-3002 value. Exiting (obj-1955).`,
  )
  process.exit(1)
}

// A failed bind (EADDRINUSE from a restart race) must EXIT so the entrypoint
// respawn loop rebinds cleanly. Without this, the listen 'error' event throws
// into the global uncaughtException keep-alive above and the process keeps
// running WITHOUT an HTTP listener — "alive but not listening" — which silently
// blackholes the entire site while the pollers keep logging (2026-08-13 incident).
server.on('error', (err: NodeJS.ErrnoException) => {
  console.error(
    `[FATAL] HTTP server error (${err.code ?? 'unknown'}) on port ${PORT} — exiting for a clean entrypoint respawn:`,
    err.message,
  )
  process.exit(1)
})

server.listen(PORT, () => {
  console.log(`Command Center running on port ${PORT}`)
  // Telegram rolodex sibling — no-ops unless TELEGRAM_BOT_TOKEN + OWNER_ID are set.
  startRolodexSibling()
  // Re-queue any sessions that completed while summarizer was broken (LiteLLM era)
  requeueParsedSessions()

  // PR-preview auto-deploy health (obj 1452): warn loudly if the spool is
  // unwritable or the host-drain kick is disabled with no systemd fallback, so
  // a silently-dead auto-deploy path never reads as green.
  try { logPreviewSpoolHealth() } catch (err) {
    console.error('[startup] logPreviewSpoolHealth failed:', (err as Error).message)
  }

  // Cost ledger (session_usage_daily) is the source of truth for every cost
  // surface. The end-of-session extraction hook only catches a fraction of
  // transcripts, so rebuild the full ledger from disk on boot (async — does not
  // block the listener), then sweep recent transcripts on an interval so active
  // and multi-invocation sessions stay current without a full re-scan each tick.
  // backfillDailyUsage yields the event loop between transcript batches (it
  // scans ~13k files), so it is async and fire-and-forget here — the boot scan
  // must never block HTTP (2026-08-13: the synchronous full scan blacked out the
  // site for minutes after every restart).
  backfillDailyUsage().catch((err) => {
    console.error('[startup] backfillDailyUsage failed:', (err as Error).message)
  })
  setInterval(() => {
    backfillDailyUsage({ sinceMs: 12 * 60 * 60 * 1000 }).catch((err) => {
      console.error('[sweep] backfillDailyUsage failed:', (err as Error).message)
    })
  }, 15 * 60 * 1000).unref()

  // Pre-warm the session-output parse cache (obj 700585) for the most recently
  // active (non-done) objectives so the FIRST open of a large thread is already
  // warm instead of cold-parsing its whole JSONL on click. Dripped in the
  // background (see prewarmSessionOutputs) — additive, non-blocking, unref'd.
  setImmediate(() => {
    try {
      const rows = getDb().prepare(
        `SELECT session_id FROM objectives
         WHERE status != 'done' AND deleted_at IS NULL AND session_id IS NOT NULL
         ORDER BY updated_at DESC LIMIT 50`,
      ).all() as { session_id: string }[]
      prewarmSessionOutputs(rows.map(r => r.session_id))
    } catch (err) {
      console.error('[startup] session-output prewarm failed:', (err as Error).message)
    }
  })
})
