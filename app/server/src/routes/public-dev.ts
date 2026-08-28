/**
 * Public ingest + public feed for the Universal Development API (obj-704214).
 * Spec: universal-development-api.md §3 (auth/CORS/rate-limit/idempotency) and
 * §4 (P1-P4). Mounted at `/api/public` behind `devIngestCors`.
 *
 *   P1  POST /dev-items                       submit an item from a widget
 *   P2  POST /dev-items/:id/attachment        upload bytes CC stores itself
 *   P3  GET  /dev-items/mine                  the submitter's own requests
 *   P4  GET  /changelog/:workspace/feed.json  published changelog for a platform
 *
 * THREE THINGS THIS FILE IS RESPONSIBLE FOR, all of which are security
 * properties rather than conveniences:
 *
 *  1. The workspace ALWAYS comes from the credential (`req.devIngest.workspace`),
 *     never from the body. A body `workspace` that disagrees is a 403, enforced
 *     upstream in requireDevIngestToken.
 *  2. Nothing a token holder sends can widen its own reach: `project` must be a
 *     registered repo of ITS workspace, a Route-A screenshot `bucket` must equal
 *     the configured bucket (else CC would sign URLs for arbitrary buckets), and
 *     P4's `categories` are INTERSECTED with `config.feed_categories`.
 *  3. Retryable vs terminal is explicit (api.md §4.1). The widget drops a queued
 *     entry on 400/401/403/409/413 and keeps it on 429/5xx, so a transient
 *     condition must never answer 400 and a permanently malformed body must
 *     never answer 503.
 */
import { Router, type Request, type Response, type NextFunction, type ErrorRequestHandler } from 'express'
import express from 'express'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import multer from 'multer'
import { getDb } from '../db/index.js'
import {
  sendDevError,
  sendDevData,
  requestId,
  FieldChecker,
  DevValidationError,
  encodeCursor,
  decodeCursor,
} from '../lib/dev-api-envelope.js'
import {
  requireDevIngestToken,
  resolveIngestToken,
  getDevelopmentIntegration,
  checkRateLimit,
  type DevIngestContext,
} from '../middleware/dev-ingest-token.js'
import {
  createDevItem,
  addAttachment,
  listSubmitterItems,
  lookupIdempotency,
  recordIdempotency,
  getDevItem,
  devRef,
  DEV_ITEM_TYPES,
  DEV_ITEM_STATUSES,
  DEV_ITEM_SEVERITIES,
  CHANGELOG_CATEGORIES,
  type DevItemType,
  type DevItemSeverity,
} from '../services/dev-items.js'

const router: Router = Router()

// ── Constants ───────────────────────────────────────────────────────────────

/** api.md §4.1: the console ring buffer is capped at 64 KB server-side. */
const CONSOLE_LOG_MAX_BYTES = 64 * 1024
/** api.md §4.1: `client_meta` is capped at 8 KB. */
const CLIENT_META_MAX_BYTES = 8 * 1024
/** api.md §4.1: keep the LAST 100 route-history entries. */
const ROUTE_HISTORY_MAX = 100
/** api.md §4.2 / schema §2.3 — CC-stored attachment root. Overridable so tests
 *  (which cannot write to /app/data) can point it at a temp dir. */
const DEFAULT_UPLOAD_DIR = '/app/data/dev-item-uploads'
const ATTACHMENT_MIME_ALLOWLIST = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'text/plain',
  'application/json',
  'application/pdf',
] as const

function uploadRoot(): string {
  return process.env.DEV_ITEM_UPLOAD_DIR || DEFAULT_UPLOAD_DIR
}

// ── Request plumbing ────────────────────────────────────────────────────────

/**
 * The raw JSON bytes, kept so the idempotency `body_sha256` is computed over
 * exactly what the client sent (api.md §3.6). Held in a WeakMap rather than
 * bolted onto `Request` so no other router's type surface changes.
 */
const rawBodies = new WeakMap<Request, Buffer>()

router.use(
  express.json({
    limit: '1mb',
    verify: (req, _res, buf) => {
      rawBodies.set(req as Request, Buffer.from(buf))
    },
  }),
)

function bodySha256(req: Request): string {
  const raw = rawBodies.get(req)
  const material = raw ?? Buffer.from(JSON.stringify(req.body ?? {}), 'utf8')
  return crypto.createHash('sha256').update(material).digest('hex')
}

type AsyncHandler = (req: Request, res: Response) => void | Promise<void>

/**
 * Every handler is wrapped: a thrown DevValidationError becomes a 400 carrying
 * its `details[]`, anything else becomes a generic 500 plus a server-side log
 * keyed by the request id. A raw stack must never reach a platform's browser.
 */
function wrap(fn: AsyncHandler) {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      await fn(req, res)
    } catch (err) {
      if (res.headersSent) return
      if (err instanceof DevValidationError) {
        sendDevError(req, res, 'validation_failed', 'Request validation failed', { details: err.details })
        return
      }
      logInternal(req, res, err)
      sendDevError(req, res, 'internal_error', 'An unexpected error occurred')
    }
  }
}

/** Never log the raw token: only the configured prefix + the last 4 chars
 *  (api.md §3.3). */
function tokenHint(req: Request): string {
  const ctx = req.devIngest
  if (!ctx) return 'anonymous'
  const header = req.header('authorization')?.replace(/^Bearer\s+/i, '') || req.header('x-cc-ingest-token') || ''
  const last4 = header.slice(-4)
  return `${ctx.config.ingest_token_prefix ?? `dvi_${ctx.workspace}_`}…${last4}`
}

function logInternal(req: Request, res: Response, err: unknown): void {
  console.error(`[public-dev] ${requestId(req, res)} ${req.method} ${req.path} caller=${tokenHint(req)}`, err)
}

function rateLimit(req: Request, res: Response, key: string, limit: number): boolean {
  const retryAfter = checkRateLimit(key, limit)
  if (retryAfter === null) return true
  sendDevError(req, res, 'rate_limited', 'Too many requests', { retryAfter })
  return false
}

function qStr(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function qList(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string')
  return []
}

/** Shared `limit`/`cursor` parsing. The cursor is an opaque base64 offset. */
function parsePaging(req: Request, check: FieldChecker, def: number, max: number): { limit: number; offset: number } {
  let limit = def
  const rawLimit = qStr(req.query.limit)
  if (rawLimit !== undefined && rawLimit !== '') {
    const n = Number(rawLimit)
    if (!Number.isInteger(n) || n < 1 || n > max) check.fail('limit', `must be an integer between 1 and ${max}`)
    else limit = n
  }
  let offset = 0
  const rawCursor = qStr(req.query.cursor)
  if (rawCursor) {
    const decoded = decodeCursor(rawCursor)
    const o = decoded && typeof decoded.offset === 'number' ? decoded.offset : null
    if (o === null || !Number.isInteger(o) || o < 0) check.fail('cursor', 'is not a valid cursor')
    else offset = o
  }
  return { limit, offset }
}

// ── P1 field normalisation ──────────────────────────────────────────────────

/**
 * Query strings and fragments are stripped from `route` server-side: they
 * routinely carry access tokens, and the column is indexed for prefix search on
 * the pathname anyway (api.md §4.1).
 */
function stripRoute(route: string): string {
  return route.split('#')[0].split('?')[0]
}

/**
 * Cap `console_log` at 64 KB, truncating FROM THE FRONT — the tail of a ring
 * buffer is the interesting end (the errors right before the report). The
 * dropped byte count is preserved in the prefix so nobody mistakes a truncated
 * log for a complete one.
 */
function capConsoleLog(value: string): string {
  const buf = Buffer.from(value, 'utf8')
  if (buf.length <= CONSOLE_LOG_MAX_BYTES) return value
  let keep = CONSOLE_LOG_MAX_BYTES
  let marker = ''
  // Two passes converge: the marker length only moves with the digit count of
  // the dropped-byte figure, which is stable after the first correction.
  for (let i = 0; i < 3; i++) {
    marker = `…[truncated ${buf.length - keep} bytes]\n`
    const next = CONSOLE_LOG_MAX_BYTES - Buffer.byteLength(marker, 'utf8')
    if (next === keep) break
    keep = Math.max(0, next)
  }
  return marker + buf.subarray(buf.length - keep).toString('utf8')
}

/**
 * Cap `client_meta` at 8 KB by dropping trailing keys, never by rejecting the
 * submit: an oversized diagnostic blob must not cost us the bug report. Unknown
 * keys are otherwise preserved verbatim (api.md §2 forward-compat).
 */
function capClientMeta(meta: Record<string, unknown>): Record<string, unknown> {
  if (Buffer.byteLength(JSON.stringify(meta), 'utf8') <= CLIENT_META_MAX_BYTES) return meta
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(meta)) {
    const candidate = { ...out, [k]: v, _truncated: true }
    if (Buffer.byteLength(JSON.stringify(candidate), 'utf8') > CLIENT_META_MAX_BYTES) break
    out[k] = v
  }
  out._truncated = true
  return out
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** `project` must be a registered repo of the TOKEN's workspace (api.md §3.3
 *  step 6): a wrong project is a config bug worth surfacing, not silent data. */
function projectExists(workspace: string, project: string): boolean {
  return !!getDb()
    .prepare('SELECT 1 FROM workspace_repos WHERE workspace = ? AND name = ? LIMIT 1')
    .get(workspace, project)
}

function repoForProject(workspace: string, project: string): string | null {
  const row = getDb()
    .prepare('SELECT github FROM workspace_repos WHERE workspace = ? AND name = ? LIMIT 1')
    .get(workspace, project) as { github: string | null } | undefined
  return row ? (row.github ?? null) : null
}

interface ScreenshotRef {
  bucket: string
  path: string
  mime_type?: string
  size_bytes?: number
  file_name?: string
}

interface P1Input {
  project: string | null
  type: DevItemType
  title: string
  description: string
  steps_to_repro: string | null
  severity: DevItemSeverity | null
  area: string | null
  route: string | null
  loom_url: string | null
  submitter_platform_user_id: string | null
  submitter_email: string | null
  submitter_label: string | null
  posthog_session_id: string | null
  posthog_replay_url: string | null
  console_log: string | null
  route_history: unknown[]
  client_meta: Record<string, unknown>
  legacy_ref: Record<string, unknown>
  screenshot: ScreenshotRef | null
}

/** Everything the server owns. Present in a body, these are IGNORED silently
 *  rather than rejected — a future widget sending a field this server does not
 *  know must not break (api.md §2 / §4.1). */
function validateP1(req: Request, ctx: DevIngestContext): P1Input {
  const body = (req.body ?? {}) as Record<string, unknown>
  const check = new FieldChecker()

  const title = check.requiredString(body.title, 'title', 200)
  const project = check.optionalString(body.project, 'project', 128)
  const type = check.enum(body.type, 'type', DEV_ITEM_TYPES) ?? 'bug'
  const description = check.optionalString(body.description, 'description', 10_000) ?? ''
  const steps = check.optionalString(body.steps_to_repro, 'steps_to_repro', 5_000) ?? null
  const severity = check.enum(body.severity, 'severity', DEV_ITEM_SEVERITIES) ?? null
  const area = check.optionalString(body.area, 'area', 64) ?? null
  const rawRoute = check.optionalString(body.route, 'route', 512)
  const loomUrl = check.httpsUrl(body.loom_url, 'loom_url', 512) ?? null
  const submitterId = check.optionalString(body.submitter_platform_user_id, 'submitter_platform_user_id', 128) ?? null
  const submitterEmail = check.optionalString(body.submitter_email, 'submitter_email', 320) ?? null
  const submitterLabel = check.optionalString(body.submitter_label, 'submitter_label', 128) ?? null
  const posthogSessionId = check.optionalString(body.posthog_session_id, 'posthog_session_id', 128) ?? null
  const posthogReplayUrl = check.httpsUrl(body.posthog_replay_url, 'posthog_replay_url', 1024) ?? null

  if (submitterEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(submitterEmail)) {
    check.fail('submitter_email', 'must be a valid email address')
  }
  // Anonymous submission is opt-in per platform; without it an item nobody can
  // be replied to is not worth storing (api.md §4.1).
  if (!submitterId && ctx.config.allow_anonymous !== true) {
    check.fail('submitter_platform_user_id', 'required')
  }

  let consoleLog: string | null = null
  if (body.console_log !== undefined && body.console_log !== null) {
    if (typeof body.console_log !== 'string') check.fail('console_log', 'must be a string')
    else consoleLog = capConsoleLog(body.console_log) || null
  }

  let routeHistory: unknown[] = []
  if (body.route_history !== undefined && body.route_history !== null) {
    if (!Array.isArray(body.route_history)) check.fail('route_history', 'must be an array')
    else routeHistory = body.route_history.slice(-ROUTE_HISTORY_MAX)
  }

  let clientMeta: Record<string, unknown> = {}
  if (body.client_meta !== undefined && body.client_meta !== null) {
    if (!isPlainObject(body.client_meta)) check.fail('client_meta', 'must be an object')
    else clientMeta = capClientMeta(body.client_meta)
  }

  // Route A (zero-copy): the platform already stored the bytes in its own
  // bucket and sends us the object path. No bytes cross the wire.
  let screenshot: ScreenshotRef | null = null
  if (body.screenshot !== undefined && body.screenshot !== null) {
    if (!isPlainObject(body.screenshot)) {
      check.fail('screenshot', 'must be an object')
    } else {
      const shot = body.screenshot
      check.enum(shot.provider, 'screenshot.provider', ['supabase'] as const)
      const bucket = check.requiredString(shot.bucket, 'screenshot.bucket', 128)
      const objectPath = check.requiredString(shot.path, 'screenshot.path', 1024)
      const mime = check.optionalString(shot.mime_type, 'screenshot.mime_type', 128)
      const fileName = check.optionalString(shot.file_name, 'screenshot.file_name', 128)
      const size = shot.size_bytes === undefined || shot.size_bytes === null ? undefined : Number(shot.size_bytes)
      if (size !== undefined && (!Number.isFinite(size) || size < 0)) {
        check.fail('screenshot.size_bytes', 'must be a non-negative number')
      }
      if (bucket && objectPath) {
        screenshot = {
          bucket,
          path: objectPath,
          mime_type: mime,
          file_name: fileName,
          size_bytes: size,
        }
      }
    }
  }

  // legacy_ref carries the two fields that deliberately have no column: the
  // client's own submit time (clock skew is tolerated, never validated, never
  // used for ordering) and the widget build that produced the report.
  const legacyRef: Record<string, unknown> = {}
  const clientSubmittedAt = check.optionalString(body.client_submitted_at, 'client_submitted_at', 64)
  if (clientSubmittedAt) legacyRef.client_submitted_at = clientSubmittedAt
  const widgetVersion =
    check.optionalString(body.widget_version, 'widget_version', 32) ??
    check.optionalString(req.header('x-cc-widget-version'), 'widget_version', 32)
  if (widgetVersion) legacyRef.widget_version = widgetVersion

  check.throwIfFailed()

  // Derive the replay URL when the platform gave us a session id and its
  // PostHog project is configured — the widget should not have to know the URL
  // shape (api.md §4.1 enrichment 2/6).
  let replayUrl = posthogReplayUrl
  if (!replayUrl && posthogSessionId && ctx.config.posthog_project_id) {
    replayUrl = `https://us.posthog.com/project/${ctx.config.posthog_project_id}/replay/${posthogSessionId}`
  }

  return {
    project: project ?? null,
    type: type as DevItemType,
    title: title as string,
    description,
    steps_to_repro: steps,
    severity: severity as DevItemSeverity | null,
    area,
    route: rawRoute ? stripRoute(rawRoute) : null,
    loom_url: loomUrl,
    submitter_platform_user_id: submitterId,
    submitter_email: submitterEmail,
    submitter_label: submitterLabel,
    posthog_session_id: posthogSessionId,
    posthog_replay_url: replayUrl,
    console_log: consoleLog,
    route_history: routeHistory,
    client_meta: clientMeta,
    legacy_ref: legacyRef,
    screenshot,
  }
}

// ── P1 — POST /dev-items ────────────────────────────────────────────────────

router.post(
  '/dev-items',
  requireDevIngestToken,
  wrap(async (req, res) => {
    const ctx = req.devIngest as DevIngestContext

    if (!rateLimit(req, res, `p1:token:${ctx.workspace}`, 20)) return

    // Idempotency is REQUIRED on P1: the widget retries from a localStorage
    // queue, so without a key a CC outage would multiply one report into five.
    const key = req.header('idempotency-key')?.trim()
    if (!key) {
      throw new DevValidationError([{ field: 'Idempotency-Key', issue: 'required' }])
    }

    const sha = bodySha256(req)
    const prior = lookupIdempotency(ctx.workspace, 'P1', key, sha)
    if (prior === 'conflict') {
      sendDevError(req, res, 'conflict', 'Idempotency-Key was already used with a different body')
      return
    }
    if (prior) {
      // Replay verbatim, with the ORIGINAL status — a 201 stays a 201.
      res.setHeader('Idempotency-Replayed', 'true')
      requestId(req, res)
      res.status(prior.status).json(prior.response)
      return
    }

    const input = validateP1(req, ctx)

    if (input.project && !projectExists(ctx.workspace, input.project)) {
      sendDevError(req, res, 'forbidden', 'project is not registered for this workspace')
      return
    }
    if (input.submitter_platform_user_id) {
      if (!rateLimit(req, res, `p1:user:${ctx.workspace}:${input.submitter_platform_user_id}`, 5)) return
    }

    // A bucket other than the configured one is a 403: otherwise a token holder
    // could make CC mint signed URLs for arbitrary buckets (api.md §4.2).
    const configuredBucket = ctx.config.attachment_storage?.bucket
    if (input.screenshot && input.screenshot.bucket !== configuredBucket) {
      sendDevError(req, res, 'forbidden', 'screenshot bucket is not the configured attachment bucket')
      return
    }

    const item = createDevItem({
      workspace: ctx.workspace, // ALWAYS the credential's workspace, never the body's
      project: input.project,
      type: input.type,
      title: input.title,
      description: input.description,
      steps_to_repro: input.steps_to_repro,
      status: 'new',
      severity: input.severity,
      area: input.area,
      route: input.route,
      loom_url: input.loom_url,
      submitter_platform_user_id: input.submitter_platform_user_id,
      submitter_email: input.submitter_email,
      submitter_label: input.submitter_label,
      submitted_via: 'widget',
      posthog_session_id: input.posthog_session_id,
      posthog_replay_url: input.posthog_replay_url,
      console_log: input.console_log,
      route_history: input.route_history,
      client_meta: input.client_meta,
      source_system: 'native',
      legacy_ref: input.legacy_ref,
    })

    if (input.screenshot) {
      addAttachment({
        devItemId: item.id,
        storageProvider: 'supabase',
        storageBucket: input.screenshot.bucket,
        storagePath: input.screenshot.path,
        fileName: input.screenshot.file_name ?? null,
        mimeType: input.screenshot.mime_type ?? null,
        sizeBytes: input.screenshot.size_bytes ?? null,
        uploadedBy: 'widget',
        isScreenshot: true,
      })
    }

    const data: Record<string, unknown> = {
      id: item.id,
      ref: devRef(item.id),
      workspace: item.workspace,
      project: item.project,
      type: item.type,
      status: item.status,
      title: item.title,
      created_at: item.created_at,
      my_requests_url: '/api/public/dev-items/mine',
    }
    // The server tells the widget which screenshot route to take; the widget
    // never guesses (api.md §4.2).
    if (ctx.config.attachment_storage?.provider === 'local') {
      data.attachment_upload_url = `/api/public/dev-items/${item.id}/attachment`
    }

    recordIdempotency(ctx.workspace, 'P1', key, sha, 201, { data })
    sendDevData(req, res, 201, data)
  }),
)

// ── P2 — POST /dev-items/:id/attachment ─────────────────────────────────────

/** Per-request state for the multipart path; a WeakMap keeps it off the shared
 *  Request type surface. */
const attachmentItems = new WeakMap<Request, { id: number; workspace: string }>()
const mimeRejected = new WeakSet<Request>()

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, _file, cb) => {
      const dir = path.join(uploadRoot(), String(req.params.id))
      fs.mkdirSync(dir, { recursive: true })
      cb(null, dir)
    },
    filename: (_req, file, cb) => {
      const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_')
      cb(null, `${Date.now()}-${safeName}`)
    },
  }),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    if (!(ATTACHMENT_MIME_ALLOWLIST as readonly string[]).includes(file.mimetype)) {
      mimeRejected.add(req as Request)
      cb(null, false)
      return
    }
    cb(null, true)
  },
})

/**
 * Ownership gate, deliberately BEFORE multer so we never write a stranger's
 * bytes to disk. An item in another workspace is reported as 404, not 403 —
 * revealing existence would leak that another platform has item N.
 */
function loadAttachmentTarget(req: Request, res: Response, next: NextFunction): void {
  const ctx = req.devIngest as DevIngestContext
  if (!rateLimit(req, res, `p2:token:${ctx.workspace}`, 20)) return
  const id = Number(req.params.id)
  if (!Number.isInteger(id) || id <= 0) {
    sendDevError(req, res, 'not_found', 'No such item')
    return
  }
  const item = getDevItem(id)
  if (!item || item.workspace !== ctx.workspace) {
    sendDevError(req, res, 'not_found', 'No such item')
    return
  }
  attachmentItems.set(req, { id: item.id, workspace: item.workspace })
  next()
}

/** Magic-byte sniff for the formats that have one: the declared Content-Type of
 *  a multipart part is client-supplied and therefore not trusted (api.md §4.2). */
function sniffMatches(declared: string, filePath: string): boolean {
  let head: Buffer
  try {
    const fd = fs.openSync(filePath, 'r')
    head = Buffer.alloc(12)
    fs.readSync(fd, head, 0, 12, 0)
    fs.closeSync(fd)
  } catch {
    return false
  }
  switch (declared) {
    case 'image/png':
      return head.subarray(0, 4).toString('hex') === '89504e47'
    case 'image/jpeg':
      return head.subarray(0, 3).toString('hex') === 'ffd8ff'
    case 'image/webp':
      return head.subarray(0, 4).toString('ascii') === 'RIFF' && head.subarray(8, 12).toString('ascii') === 'WEBP'
    case 'application/pdf':
      return head.subarray(0, 4).toString('ascii') === '%PDF'
    default:
      // text/plain and application/json have no signature; nothing to sniff.
      return true
  }
}

function unlinkQuietly(filePath: string | undefined): void {
  if (!filePath) return
  try {
    fs.unlinkSync(filePath)
  } catch {
    /* best effort — a stray temp file must not fail the request */
  }
}

/** basename only, no `..`, no separators, ≤128 chars (api.md §4.2). */
function sanitiseFileName(value: string): string {
  return path.basename(value).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 128)
}

router.post(
  '/dev-items/:id/attachment',
  requireDevIngestToken,
  loadAttachmentTarget,
  upload.single('file'),
  wrap(async (req, res) => {
    const ctx = req.devIngest as DevIngestContext
    const target = attachmentItems.get(req)
    const file = req.file

    if (!file) {
      const issue = mimeRejected.has(req) ? 'has a disallowed MIME type' : 'required'
      mimeRejected.delete(req)
      throw new DevValidationError([{ field: 'file', issue }])
    }
    if (!target) {
      // Unreachable: loadAttachmentTarget always sets it or answers 404.
      unlinkQuietly(file.path)
      sendDevError(req, res, 'not_found', 'No such item')
      return
    }

    const bodyParts = (req.body ?? {}) as Record<string, unknown>
    const check = new FieldChecker()
    const kind = check.enum(bodyParts.kind, 'kind', ['screenshot', 'attachment'] as const) ?? 'screenshot'
    const requestedName = check.optionalString(bodyParts.file_name, 'file_name', 128)
    if (!check.ok) {
      unlinkQuietly(file.path)
      check.throwIfFailed()
    }

    if (!sniffMatches(file.mimetype, file.path)) {
      unlinkQuietly(file.path)
      throw new DevValidationError([{ field: 'file', issue: 'content does not match its declared MIME type' }])
    }

    const fileName = sanitiseFileName(requestedName || file.originalname || path.basename(file.path))

    // Idempotency is HONOURED (not required) on P2: the widget uploads after
    // the item exists, so a retried upload must not stack duplicate rows.
    const key = req.header('idempotency-key')?.trim()
    const sha = crypto
      .createHash('sha256')
      .update(`${target.id}:${kind}:${fileName}:${file.mimetype}:${file.size}`)
      .digest('hex')
    if (key) {
      const prior = lookupIdempotency(ctx.workspace, 'P2', key, sha)
      if (prior === 'conflict') {
        unlinkQuietly(file.path)
        sendDevError(req, res, 'conflict', 'Idempotency-Key was already used with a different body')
        return
      }
      if (prior) {
        unlinkQuietly(file.path)
        res.setHeader('Idempotency-Replayed', 'true')
        requestId(req, res)
        res.status(prior.status).json(prior.response)
        return
      }
    }

    const row = addAttachment({
      devItemId: target.id,
      storageProvider: 'local',
      storageBucket: null,
      storagePath: file.path,
      fileName,
      mimeType: file.mimetype,
      sizeBytes: file.size,
      uploadedBy: 'widget',
      isScreenshot: kind === 'screenshot',
    }) as {
      id: number
      dev_item_id: number
      storage_provider: string
      storage_path: string
      file_name: string | null
      mime_type: string | null
      size_bytes: number | null
      created_at: string
    }

    const data = {
      id: row.id,
      dev_item_id: row.dev_item_id,
      storage_provider: row.storage_provider,
      storage_path: row.storage_path,
      file_name: row.file_name,
      mime_type: row.mime_type,
      size_bytes: row.size_bytes,
      created_at: row.created_at,
    }
    if (key) recordIdempotency(ctx.workspace, 'P2', key, sha, 201, { data })
    sendDevData(req, res, 201, data)
  }),
)

// ── P3 — GET /dev-items/mine ────────────────────────────────────────────────

router.get(
  '/dev-items/mine',
  requireDevIngestToken,
  wrap(async (req, res) => {
    const ctx = req.devIngest as DevIngestContext
    if (!rateLimit(req, res, `p3:token:${ctx.workspace}`, 60)) return

    const check = new FieldChecker()
    const submitterId = check.requiredString(
      qStr(req.query.submitter_platform_user_id),
      'submitter_platform_user_id',
      128,
    )
    const statuses = qList(req.query.status)
    for (const s of statuses) check.enum(s, 'status', DEV_ITEM_STATUSES)
    const { limit, offset } = parsePaging(req, check, 20, 50)
    check.throwIfFailed()

    // Delegated wholesale: the field-redaction discipline (never severity,
    // never console_log, never another submitter's rows) lives in the service,
    // and no route may re-implement a dev_items SELECT (schema §5 mitigation 1).
    const { items, hasMore } = listSubmitterItems(ctx.workspace, submitterId as string, {
      statuses: statuses.length ? statuses : undefined,
      limit,
      offset,
    })

    sendDevData(req, res, 200, items, {
      page: {
        next_cursor: hasMore ? encodeCursor({ offset: offset + limit }) : null,
        has_more: hasMore,
      },
    })
  }),
)

// ── P4 — GET /changelog/:workspace/feed.json ────────────────────────────────

interface FeedRow {
  id: number
  headline: string
  body_stakeholder: string
  how_to: string
  category: string
  published_at: string
  merged_at: string
  screenshots: string
  pr_url: string
}

function parseScreenshots(value: string): unknown[] {
  try {
    const parsed = JSON.parse(value) as unknown
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

router.get(
  '/changelog/:workspace/feed.json',
  wrap(async (req, res) => {
    const workspace = String(req.params.workspace)
    const integration = getDevelopmentIntegration(workspace)
    // Unknown workspace is a 404 whether or not a token was presented, so the
    // feed cannot be used to enumerate platform slugs.
    if (!integration) {
      sendDevError(req, res, 'not_found', 'No such changelog feed')
      return
    }
    const config = integration.config
    const isPublic = config.feed_public === true

    const presented =
      /^Bearer\s+(.+)$/i.exec((req.header('authorization') || '').trim())?.[1]?.trim() ||
      req.header('x-cc-ingest-token')?.trim() ||
      null
    const resolved = resolveIngestToken(presented)

    if (!isPublic) {
      if (!resolved) {
        sendDevError(req, res, 'unauthorized', 'A valid ingest token is required')
        return
      }
      if (resolved.workspace !== workspace) {
        sendDevError(req, res, 'forbidden', 'token does not grant access to this workspace')
        return
      }
    }
    // The kill switch applies to the feed too: `status='disconnected'` takes a
    // platform fully offline rather than half of it.
    if (integration.status !== 'connected' || config.enabled === false) {
      sendDevError(req, res, 'integration_disconnected', 'The development integration for this platform is disconnected', {
        retryAfter: 300,
      })
      return
    }

    const bucketKey = resolved ? `p4:token:${resolved.workspace}` : `p4:ip:${req.ip ?? 'unknown'}`
    if (!rateLimit(req, res, bucketKey, 300)) return

    const check = new FieldChecker()
    const project = check.optionalString(qStr(req.query.project), 'project', 128)
    const since = check.optionalString(qStr(req.query.since), 'since', 32)
    if (since && Number.isNaN(Date.parse(since))) check.fail('since', 'must be an ISO date')
    const { limit, offset } = parsePaging(req, check, 10, 100)

    // A client may only ever NARROW the configured category set. Widening it
    // server-side is the leak this intersection exists to prevent.
    const configured = (Array.isArray(config.feed_categories) && config.feed_categories.length
      ? config.feed_categories
      : [...CHANGELOG_CATEGORIES]
    ).filter(c => (CHANGELOG_CATEGORIES as readonly string[]).includes(c))
    const requested = (qStr(req.query.categories) ?? '')
      .split(',')
      .map(c => c.trim())
      .filter(Boolean)
    for (const c of requested) check.enum(c, 'categories', CHANGELOG_CATEGORIES)
    check.throwIfFailed()

    const categories = requested.length ? configured.filter(c => requested.includes(c)) : configured

    let repo: string | null = null
    if (project) {
      repo = repoForProject(workspace, project)
      if (!repo) {
        sendDevError(req, res, 'forbidden', 'project is not registered for this workspace')
        return
      }
    }

    // HARD filter, always. Never draft, never skipped, never another platform.
    const where: string[] = ["status = 'published'", 'workspace = ?', 'published_at IS NOT NULL']
    const params: unknown[] = [workspace]
    if (repo) {
      where.push('repo = ?')
      params.push(repo)
    }
    if (categories.length) {
      where.push(`category IN (${categories.map(() => '?').join(',')})`)
      params.push(...categories)
    } else {
      where.push('1 = 0') // every category was filtered out — an empty feed, not an error
    }
    if (since) {
      where.push('published_at >= ?')
      params.push(since)
    }
    const whereSql = `WHERE ${where.join(' AND ')}`

    // The ETag is computed over the QUERY plus the aggregate state of the whole
    // matching set, so publishing an entry changes it without a purge.
    const agg = getDb()
      .prepare(`SELECT COUNT(*) AS c, MAX(published_at) AS m FROM changelog_entries ${whereSql}`)
      .get(...params) as { c: number; m: string | null }
    const etag = `"${crypto
      .createHash('sha1')
      .update(
        JSON.stringify([workspace, project ?? null, categories, limit, since ?? null, agg.m, agg.c, offset]),
      )
      .digest('hex')}"`

    res.setHeader('Cache-Control', 'public, max-age=300, stale-while-revalidate=3600')
    res.setHeader('ETag', etag)
    if (req.header('if-none-match') === etag) {
      requestId(req, res)
      res.status(304).end()
      return
    }

    const rows = getDb()
      .prepare(
        `SELECT id, headline, body_stakeholder, how_to, category, published_at, merged_at, screenshots, pr_url
           FROM changelog_entries ${whereSql}
          ORDER BY published_at DESC, id DESC
          LIMIT ? OFFSET ?`,
      )
      .all(...params, limit + 1, offset) as FeedRow[]

    const hasMore = rows.length > limit
    // Serialisation allowlist. dev_item_id, objective_id, author, title_eng,
    // status, notified_at and merge_commit_sha are NEVER exposed (api.md §4.4).
    const data = rows.slice(0, limit).map(r => ({
      id: r.id,
      headline: r.headline,
      body: r.body_stakeholder,
      how_to: r.how_to,
      category: r.category,
      published_at: r.published_at,
      merged_at: r.merged_at,
      screenshots: parseScreenshots(r.screenshots),
      pr_url: r.pr_url,
    }))

    sendDevData(req, res, 200, data, {
      page: {
        next_cursor: hasMore ? encodeCursor({ offset: offset + limit }) : null,
        has_more: hasMore,
      },
      meta: { workspace, generated_at: new Date().toISOString() },
    })
  }),
)

// ── Error normalisation ─────────────────────────────────────────────────────

/**
 * body-parser and multer throw rather than calling a handler, so their failures
 * would otherwise escape as Express's HTML error page — which the widget cannot
 * parse into a retry decision. Both are mapped onto the canonical envelope.
 */
const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  if (res.headersSent) return
  if (err instanceof DevValidationError) {
    sendDevError(req, res, 'validation_failed', 'Request validation failed', { details: err.details })
    return
  }
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      sendDevError(req, res, 'payload_too_large', 'File exceeds the 10 MB limit')
      return
    }
    sendDevError(req, res, 'validation_failed', 'Invalid multipart upload', {
      details: [{ field: err.field ?? 'file', issue: err.code }],
    })
    return
  }
  const typed = err as { type?: string; status?: number }
  if (typed?.type === 'entity.too.large') {
    sendDevError(req, res, 'payload_too_large', 'Request body exceeds the 1 MB limit')
    return
  }
  if (typed?.type === 'entity.parse.failed') {
    sendDevError(req, res, 'validation_failed', 'Request body is not valid JSON', {
      details: [{ field: 'body', issue: 'must be valid JSON' }],
    })
    return
  }
  logInternal(req, res, err)
  sendDevError(req, res, 'internal_error', 'An unexpected error occurred')
}
router.use(errorHandler)

export default router
