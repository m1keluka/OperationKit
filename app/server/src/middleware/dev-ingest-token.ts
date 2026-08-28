/**
 * Per-platform ingest-token gate for the public Development API (obj-704214).
 * Spec: universal-development-api.md §3.1-§3.5.
 *
 * Token format:  dvi_<workspace-slug>_<32 hex>
 *   e.g.         dvi_example-project_9f3c1a77b2e04d6a8c15f0b3d7e29a4c
 *
 * Only sha256(token) is ever persisted, in
 * `workspace_integrations.config.ingest_token_hash` (schema §2.6). The raw
 * value exists exactly once, at mint time (scripts/mint-dev-ingest-token.ts),
 * and is NEVER written to the DB or a log line.
 *
 * WHY NOT reuse OBJECTIVES_API_TOKEN (api.md §3.2) — any one of these is
 * disqualifying:
 *  (a) it authorises `POST /api/internal/objectives` (routes/internal.ts:186),
 *      so handing it to a browser-adjacent widget puts every end-user one
 *      devtools tab away from writing into the objectives queue that drives AI
 *      workers;
 *  (b) one shared secret cannot be revoked per platform;
 *  (c) it carries no workspace identity, so the server would have to trust a
 *      client-supplied `workspace` — i.e. any platform could write into any
 *      other platform's board. The `dvi_<workspace>_` prefix makes workspace a
 *      property of the CREDENTIAL, which is what makes cross-platform leakage
 *      structurally impossible;
 *  (d) it has no per-caller record and no rotation story.
 * Nothing here alters middleware/objectives-token.ts.
 */
import crypto from 'crypto'
import type { Request, Response, NextFunction } from 'express'
import { getDb } from '../db/index.js'
import { sendDevError } from '../lib/dev-api-envelope.js'

/** Parsed `workspace_integrations.config` for kind='development' (schema §2.6). */
export interface DevelopmentConfig {
  enabled?: boolean
  display_name?: string
  repo?: string
  ingest_token_hash?: string
  /** Optional second valid hash so a rotation can run both values for 24h. */
  ingest_token_hash_previous?: string
  ingest_token_prefix?: string
  allowed_origins?: string[]
  allow_anonymous?: boolean
  feed_public?: boolean
  feed_categories?: string[]
  posthog_project_id?: string
  attachment_storage?: {
    provider?: 'local' | 'supabase'
    bucket?: string
    project_url?: string
  }
  notify?: { provider?: string; from?: string }
  /** Unknown keys are preserved on write (api.md §2 forward-compat). */
  [key: string]: unknown
}

export interface DevIngestContext {
  /** Resolved from the token prefix — NEVER from the request body. */
  workspace: string
  integrationId: number
  config: DevelopmentConfig
}

declare module 'express-serve-static-core' {
  interface Request {
    devIngest?: DevIngestContext
  }
}

/** Shape gate (api.md §3.3 step 2). Slug has no `_`, so the split is unambiguous. */
const TOKEN_RE = /^dvi_([a-z0-9-]{1,40})_([0-9a-f]{32})$/

export function hashIngestToken(token: string): string {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex')
}

/** Constant-time compare; false (not throw) on length mismatch. Mirrors
 *  safeEqual() in middleware/objectives-token.ts:51. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  if (ab.length !== bb.length) return false
  return crypto.timingSafeEqual(ab, bb)
}

export interface DevelopmentIntegration {
  id: number
  workspace: string
  config: DevelopmentConfig
  status: string
}

/** Load the kind='development' integration row for a workspace, or null. */
export function getDevelopmentIntegration(workspace: string): DevelopmentIntegration | null {
  const row = getDb()
    .prepare(
      "SELECT id, workspace, config, status FROM workspace_integrations WHERE workspace = ? AND kind = 'development'",
    )
    .get(workspace) as { id: number; workspace: string; config: string; status: string } | undefined
  if (!row) return null
  let config: DevelopmentConfig = {}
  try {
    const parsed = JSON.parse(row.config) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      config = parsed as DevelopmentConfig
    }
  } catch {
    // A corrupt config must not 500 the endpoint; it degrades to "no hash
    // configured", which fails closed at the comparison step below.
    console.warn(`[dev-ingest] unparseable config for workspace=${row.workspace}`)
  }
  return { id: row.id, workspace: row.workspace, config, status: row.status }
}

/** Read the credential from Authorization: Bearer, else X-CC-Ingest-Token.
 *  Query-string tokens are deliberately NOT accepted — they land in access
 *  logs and Referer headers (api.md §3.3 step 1). */
function extractToken(req: Request): string | null {
  const header = req.header('authorization') || ''
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  if (match) return match[1].trim()
  const alt = req.header('x-cc-ingest-token')?.trim()
  return alt || null
}

/**
 * Resolve a presented ingest token to its integration, WITHOUT deciding the
 * HTTP outcome. Exported so P4 (the changelog feed) can accept a token
 * optionally — it is public when `config.feed_public` is true.
 *
 * Returns null for every failure mode: malformed, unknown workspace, or hash
 * mismatch. Callers must not distinguish these to the client (api.md §3.3
 * step 3: do not confirm which slugs exist).
 */
export function resolveIngestToken(token: string | null): DevelopmentIntegration | null {
  if (!token) return null
  const m = TOKEN_RE.exec(token)
  if (!m) return null
  const integration = getDevelopmentIntegration(m[1])
  if (!integration) return null
  const presented = hashIngestToken(token)
  const current = integration.config.ingest_token_hash
  const previous = integration.config.ingest_token_hash_previous
  // An empty/absent hash means no token has been minted for this platform yet.
  // Fail closed: every presented token is rejected until one is minted.
  const matches =
    (typeof current === 'string' && current.length > 0 && safeEqual(presented, current)) ||
    (typeof previous === 'string' && previous.length > 0 && safeEqual(presented, previous))
  return matches ? integration : null
}

/**
 * Express gate for the public ingest endpoints. On success attaches
 * `req.devIngest` and continues.
 *
 * Order matters and follows api.md §3.3 exactly:
 *   1-4. credential -> shape -> integration row -> constant-time hash compare  => 401
 *   5.   kill switch (`status !== 'connected'` or `config.enabled === false`)   => 503
 *   6.   body/query `workspace` disagreeing with the token's workspace         => 403
 *
 * Step 5 returning a RETRYABLE 503 (not a terminal 4xx) is load-bearing: the
 * widget treats 503 exactly like an outage and keeps the item in its
 * localStorage queue, so flipping the kill switch never destroys a report.
 */
export function requireDevIngestToken(req: Request, res: Response, next: NextFunction): void {
  const token = extractToken(req)
  const integration = resolveIngestToken(token)
  if (!integration) {
    sendDevError(req, res, 'unauthorized', 'A valid ingest token is required')
    return
  }

  if (integration.status !== 'connected' || integration.config.enabled === false) {
    sendDevError(
      req,
      res,
      'integration_disconnected',
      'The development integration for this platform is disconnected',
      { retryAfter: 300 },
    )
    return
  }

  // A body/query `workspace` that disagrees with the credential is a 403, never
  // a silent redirect of the write. This is the check that makes (c) above real.
  const body = (req.body ?? {}) as Record<string, unknown>
  const claimed =
    typeof body.workspace === 'string'
      ? body.workspace
      : typeof req.query.workspace === 'string'
        ? req.query.workspace
        : undefined
  if (claimed !== undefined && claimed !== integration.workspace) {
    sendDevError(req, res, 'forbidden', 'workspace does not match the presented credential')
    return
  }

  req.devIngest = {
    workspace: integration.workspace,
    integrationId: integration.id,
    config: integration.config,
  }
  next()
}

/**
 * CORS for the ingest endpoints (api.md §3.5). These are called from ANOTHER
 * origin's browser, so this is load-bearing rather than decorative.
 *
 * Design points:
 *  - allowed origins are an exact-match list from config — no wildcards, no
 *    regex, no `*` where credentials could ever be involved;
 *  - a non-allowed origin gets NO `Access-Control-Allow-Origin` header (the
 *    browser blocks it) but the request is still PROCESSED, so a
 *    server-to-server caller with no `Origin` is unaffected;
 *  - no `Access-Control-Allow-Credentials`: the ingest token is a bearer,
 *    never a cookie;
 *  - `Vary: Origin` on every response, so a shared cache cannot serve one
 *    platform's CORS decision to another.
 *
 * The origin list is resolved from the token when one is presented; a public
 * feed request (no token) falls back to the `:workspace` path param.
 */
export function devIngestCors(req: Request, res: Response, next: NextFunction): void {
  res.setHeader('Vary', 'Origin')
  const origin = req.header('origin')

  if (origin) {
    const integration =
      resolveIngestToken(extractToken(req)) ??
      (typeof req.params.workspace === 'string'
        ? getDevelopmentIntegration(req.params.workspace)
        : null)
    const allowed = Array.isArray(integration?.config.allowed_origins)
      ? integration.config.allowed_origins
      : []
    if (integration?.config.feed_public === true && req.method === 'GET') {
      res.setHeader('Access-Control-Allow-Origin', '*')
    } else if (allowed.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin)
    }
  }

  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Authorization, Content-Type, Idempotency-Key, X-CC-Ingest-Token, X-CC-Widget-Version, X-Request-Id',
  )
  res.setHeader('Access-Control-Max-Age', '86400')

  if (req.method === 'OPTIONS') {
    res.status(204).end()
    return
  }
  next()
}

// ── Rate limiting (api.md §3.4) ─────────────────────────────────────────────
// Per-process sliding window. Explicitly an abuse-shaping measure and NOT a
// security control: counters reset on restart and CC runs a single API process.
// A 429 is a RETRYABLE outage from the widget's point of view — it re-queues.

const buckets = new Map<string, number[]>()

export function checkRateLimit(key: string, limit: number, windowMs = 60_000): number | null {
  const now = Date.now()
  const hits = (buckets.get(key) ?? []).filter(t => now - t < windowMs)
  if (hits.length >= limit) {
    buckets.set(key, hits)
    // Seconds until the oldest hit falls out of the window.
    return Math.max(1, Math.ceil((windowMs - (now - hits[0])) / 1000))
  }
  hits.push(now)
  buckets.set(key, hits)
  return null
}

/** Test seam — the map is module-global and would otherwise leak across specs. */
export function resetRateLimits(): void {
  buckets.clear()
}
