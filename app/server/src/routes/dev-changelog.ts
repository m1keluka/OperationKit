/**
 * Admin changelog — A12-A16 of the Universal Development API (obj-704214).
 * Spec: universal-development-api.md §5.12; schema: universal-development-schema.md §2.5.
 *
 * Mounted at `/api/dev-changelog`, session-authenticated (requireAuth +
 * requireAdmin). These are the SIBLINGS of the pre-existing localhost-only
 * routes in `routes/changelog.ts` (`/collect`, `/retranslate/:id`, `/entries`) —
 * those stay exactly as they are; this router adds the UI path.
 *
 * THE INVERSION vs the public feed (P4): P4 redacts (no `title_eng`, no
 * `status`, no `objective_id`, no `author`). A12 is the INTERNAL view and
 * deliberately returns every column, because the operator curating the feed
 * needs to see the engineering title next to the stakeholder headline.
 *
 * THE TWO INVARIANTS this router exists to protect:
 *  1. `status` is NOT patchable via A13. Publishing is an explicit, audited
 *     action (A14) — otherwise a stray PATCH from an admin form silently
 *     pushes a half-written entry into a customer-facing feed.
 *  2. A published entry must have a non-NULL `workspace`. The public feed
 *     hard-filters on workspace; a NULL-workspace published row is the one
 *     shape that could fan out into EVERY platform's changelog. Fail closed.
 */
import { Router } from 'express'
import type { Response } from 'express'
import { getDb } from '../db/index.js'
import { requireAuth, requireAdmin, type AuthRequest } from '../middleware/auth.js'
import { getDevelopmentIntegration } from '../middleware/dev-ingest-token.js'
import { translateEntry } from '../services/changelog.js'
import {
  sendDevError,
  sendDevData,
  FieldChecker,
  escapeLike,
  encodeCursor,
  decodeCursor,
  type DevErrorDetail,
} from '../lib/dev-api-envelope.js'

const router = Router()
router.use(requireAuth, requireAdmin)

const db = () => getDb()

const CHANGELOG_STATUSES = ['draft', 'published', 'skipped'] as const
type ChangelogStatusLiteral = (typeof CHANGELOG_STATUSES)[number]

const CATEGORIES = ['feature', 'fix', 'improvement', 'infra'] as const

const MAX_LIMIT = 200
const DEFAULT_LIMIT = 50

/** Every column of `changelog_entries`, plus the joined dev-item projection. */
const SELECT_COLUMNS = `
  ce.id, ce.repo, ce.pr_number, ce.pr_url, ce.merge_commit_sha, ce.platform,
  ce.author, ce.merged_at, ce.category, ce.status, ce.title_eng, ce.headline,
  ce.body_stakeholder, ce.overview, ce.feature_brief, ce.screenshots,
  ce.objective_id, ce.created_at, ce.updated_at,
  ce.workspace, ce.how_to, ce.published_at, ce.notified_at, ce.dev_item_id,
  di.title  AS dev_item_title,
  di.status AS dev_item_status,
  di.workspace AS dev_item_workspace
`

interface EntryRow {
  id: number
  repo: string
  pr_number: number
  pr_url: string
  status: string
  workspace: string | null
  headline: string
  body_stakeholder: string
  overview: string
  how_to: string
  published_at: string | null
  notified_at: string | null
  dev_item_id: number | null
  screenshots: string
  merged_at: string
  [key: string]: unknown
}

function parseJsonArray(raw: unknown): unknown[] {
  if (typeof raw !== 'string' || !raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

/** Row -> API shape. `screenshots` is stored stringified; callers get an array. */
function serializeEntry(row: EntryRow): Record<string, unknown> {
  return { ...row, screenshots: parseJsonArray(row.screenshots) }
}

function fetchEntry(id: number): EntryRow | null {
  const row = db()
    .prepare(
      `SELECT ${SELECT_COLUMNS}
         FROM changelog_entries ce
         LEFT JOIN dev_items di ON di.id = ce.dev_item_id
        WHERE ce.id = ?`,
    )
    .get(id) as EntryRow | undefined
  return row ?? null
}

/** `?workspace=a&workspace=b` and `?workspace=a,b` both yield ['a','b']. */
function repeatable(value: unknown): string[] {
  const out: string[] = []
  const push = (v: unknown) => {
    if (typeof v !== 'string') return
    for (const part of v.split(',')) {
      const t = part.trim()
      if (t) out.push(t)
    }
  }
  if (Array.isArray(value)) value.forEach(push)
  else push(value)
  return out
}

function idParam(raw: unknown): number | null {
  const n = Number(Array.isArray(raw) ? raw[0] : raw)
  return Number.isInteger(n) && n > 0 ? n : null
}

// ── A12 — GET /api/dev-changelog ────────────────────────────────────────────

router.get('/', (req: AuthRequest, res: Response) => {
  try {
    const q = req.query as Record<string, unknown>
    const details: DevErrorDetail[] = []

    const workspaces = repeatable(q.workspace)
    const statuses = repeatable(q.status)
    for (const s of statuses) {
      if (!(CHANGELOG_STATUSES as readonly string[]).includes(s)) {
        details.push({ field: 'status', issue: `must be one of ${CHANGELOG_STATUSES.join('|')}` })
      }
    }

    const category = typeof q.category === 'string' ? q.category.trim() : ''
    if (category && !(CATEGORIES as readonly string[]).includes(category)) {
      details.push({ field: 'category', issue: `must be one of ${CATEGORIES.join('|')}` })
    }

    let hasDevItem: boolean | null = null
    if (q.has_dev_item !== undefined && q.has_dev_item !== '') {
      if (q.has_dev_item === '1' || q.has_dev_item === 1 || q.has_dev_item === 'true') hasDevItem = true
      else if (q.has_dev_item === '0' || q.has_dev_item === 0 || q.has_dev_item === 'false') hasDevItem = false
      else details.push({ field: 'has_dev_item', issue: 'must be 1 or 0' })
    }

    let limit = DEFAULT_LIMIT
    if (q.limit !== undefined && q.limit !== '') {
      const n = Number(q.limit)
      if (!Number.isInteger(n) || n < 1) details.push({ field: 'limit', issue: 'must be a positive integer' })
      else limit = Math.min(n, MAX_LIMIT)
    }

    let cursorPos: { merged_at?: unknown; id?: unknown } | null = null
    if (typeof q.cursor === 'string' && q.cursor) {
      cursorPos = decodeCursor(q.cursor)
      if (!cursorPos || typeof cursorPos.merged_at !== 'string' || typeof cursorPos.id !== 'number') {
        details.push({ field: 'cursor', issue: 'malformed cursor' })
        cursorPos = null
      }
    }

    if (details.length) {
      return sendDevError(req, res, 'validation_failed', 'invalid query parameters', { details })
    }

    const where: string[] = []
    const params: unknown[] = []

    if (workspaces.length) {
      where.push(`ce.workspace IN (${workspaces.map(() => '?').join(',')})`)
      params.push(...workspaces)
    }
    if (statuses.length) {
      where.push(`ce.status IN (${statuses.map(() => '?').join(',')})`)
      params.push(...statuses)
    }
    if (category) {
      where.push('ce.category = ?')
      params.push(category)
    }
    if (typeof q.repo === 'string' && q.repo.trim()) {
      where.push('ce.repo = ?')
      params.push(q.repo.trim())
    }
    if (hasDevItem === true) where.push('ce.dev_item_id IS NOT NULL')
    if (hasDevItem === false) where.push('ce.dev_item_id IS NULL')

    if (typeof q.q === 'string' && q.q.trim()) {
      // `%` and `_` are LIKE wildcards; unescaped, `q=%` would match every row.
      const pattern = `%${escapeLike(q.q.trim())}%`
      where.push(
        `(ce.headline LIKE ? ESCAPE '\\' OR ce.body_stakeholder LIKE ? ESCAPE '\\'
          OR ce.title_eng LIKE ? ESCAPE '\\' OR ce.overview LIKE ? ESCAPE '\\')`,
      )
      params.push(pattern, pattern, pattern, pattern)
    }
    if (typeof q.date_from === 'string' && q.date_from.trim()) {
      where.push('ce.merged_at >= ?')
      params.push(q.date_from.trim())
    }
    if (typeof q.date_to === 'string' && q.date_to.trim()) {
      where.push('ce.merged_at <= ?')
      params.push(q.date_to.trim())
    }
    if (cursorPos) {
      // Keyset pagination on the (merged_at DESC, id DESC) sort key.
      where.push('(ce.merged_at < ? OR (ce.merged_at = ? AND ce.id < ?))')
      params.push(cursorPos.merged_at, cursorPos.merged_at, cursorPos.id)
    }

    const sql = `
      SELECT ${SELECT_COLUMNS}
        FROM changelog_entries ce
        LEFT JOIN dev_items di ON di.id = ce.dev_item_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY ce.merged_at DESC, ce.id DESC
       LIMIT ?`
    // Over-fetch by one to decide has_more without a second COUNT query.
    const rows = db().prepare(sql).all(...params, limit + 1) as EntryRow[]
    const hasMore = rows.length > limit
    const page = hasMore ? rows.slice(0, limit) : rows
    const last = page[page.length - 1]

    return sendDevData(req, res, 200, page.map(serializeEntry), {
      page: {
        next_cursor: hasMore && last ? encodeCursor({ merged_at: last.merged_at, id: last.id }) : null,
        has_more: hasMore,
      },
    })
  } catch (err) {
    console.error('[dev-changelog] A12 list failed:', (err as Error).message)
    return sendDevError(req, res, 'internal_error', 'failed to list changelog entries')
  }
})

// ── A13 — PATCH /api/dev-changelog/:id ──────────────────────────────────────

/** The ONLY writable columns. `status` is deliberately absent — see A14. */
const PATCHABLE = [
  'headline',
  'body_stakeholder',
  'overview',
  'how_to',
  'feature_brief',
  'category',
  'screenshots',
  'workspace',
  'dev_item_id',
  'title_eng',
] as const

router.patch('/:id', (req: AuthRequest, res: Response) => {
  const id = idParam(req.params.id)
  if (id === null) {
    return sendDevError(req, res, 'validation_failed', 'id must be a positive integer', {
      details: [{ field: 'id', issue: 'must be a positive integer' }],
    })
  }
  const existing = fetchEntry(id)
  if (!existing) return sendDevError(req, res, 'not_found', 'no such changelog entry')

  const body = (req.body ?? {}) as Record<string, unknown>

  // Publish is an audited action, not a field write (api.md §5.12 A13).
  if ('status' in body) {
    return sendDevError(req, res, 'validation_failed', 'status is not writable here — use POST /:id/publish', {
      details: [{ field: 'status', issue: 'not writable; use POST /api/dev-changelog/:id/publish' }],
    })
  }
  for (const key of ['published_at', 'notified_at']) {
    if (key in body) {
      return sendDevError(req, res, 'validation_failed', `${key} is not writable here`, {
        details: [{ field: key, issue: 'not writable' }],
      })
    }
  }

  const checker = new FieldChecker()
  const set: Record<string, unknown> = {}

  for (const field of ['headline', 'body_stakeholder', 'overview', 'how_to', 'feature_brief', 'title_eng'] as const) {
    if (!(field in body)) continue
    const raw = body[field]
    if (raw === null) {
      // These columns are NOT NULL DEFAULT '' — null means "clear".
      set[field] = ''
      continue
    }
    if (typeof raw !== 'string') {
      checker.fail(field, 'must be a string')
      continue
    }
    if (raw.length > 20000) {
      checker.fail(field, 'must be at most 20000 characters')
      continue
    }
    set[field] = raw
  }

  if ('category' in body) {
    const cat = checker.enum(body.category, 'category', CATEGORIES)
    if (cat) set.category = cat
    else if (body.category === null || body.category === '') checker.fail('category', 'required')
  }

  if ('screenshots' in body) {
    if (!Array.isArray(body.screenshots)) {
      checker.fail('screenshots', 'must be a JSON array')
    } else if (body.screenshots.some(s => typeof s !== 'string')) {
      checker.fail('screenshots', 'must be an array of strings')
    } else {
      set.screenshots = JSON.stringify(body.screenshots)
    }
  }

  if ('workspace' in body) {
    if (body.workspace === null) {
      set.workspace = null
    } else if (typeof body.workspace !== 'string' || !body.workspace.trim()) {
      checker.fail('workspace', 'must be a non-empty string or null')
    } else {
      set.workspace = body.workspace.trim()
    }
  }

  let devItemChange: { next: number | null } | null = null
  if ('dev_item_id' in body) {
    if (body.dev_item_id === null) {
      devItemChange = { next: null }
    } else {
      const n = Number(body.dev_item_id)
      if (!Number.isInteger(n) || n <= 0) {
        checker.fail('dev_item_id', 'must be a positive integer or null')
      } else {
        const exists = db().prepare('SELECT 1 FROM dev_items WHERE id = ? AND deleted_at IS NULL').get(n)
        if (!exists) checker.fail('dev_item_id', 'no such dev item')
        else devItemChange = { next: n }
      }
    }
  }

  if (!checker.ok) {
    return sendDevError(req, res, 'validation_failed', 'invalid patch body', { details: checker.details })
  }
  if (!Object.keys(set).length && !devItemChange) {
    return sendDevError(req, res, 'validation_failed', 'no writable fields supplied', {
      details: [{ field: 'body', issue: `must contain at least one of ${PATCHABLE.join('|')}` }],
    })
  }

  try {
    db().transaction(() => {
      if (devItemChange) set.dev_item_id = devItemChange.next
      const assignments = Object.keys(set)
        .map(k => `${k} = ?`)
        .join(', ')
      db()
        .prepare(`UPDATE changelog_entries SET ${assignments}, updated_at = datetime('now') WHERE id = ?`)
        .run(...Object.values(set), id)

      // The link is bidirectional in the schema and must not drift: point the
      // NEW item back at this entry, and release the PREVIOUS one — both in
      // this transaction, so a crash can never leave two items claiming the
      // same entry (or an orphaned back-pointer).
      if (devItemChange) {
        const prev = existing.dev_item_id
        if (prev && prev !== devItemChange.next) {
          db()
            .prepare(
              "UPDATE dev_items SET changelog_entry_id = NULL, updated_at = datetime('now') WHERE id = ? AND changelog_entry_id = ?",
            )
            .run(prev, id)
        }
        if (devItemChange.next) {
          db()
            .prepare("UPDATE dev_items SET changelog_entry_id = ?, updated_at = datetime('now') WHERE id = ?")
            .run(id, devItemChange.next)
        }
      }
    })()
  } catch (err) {
    console.error('[dev-changelog] A13 patch failed:', (err as Error).message)
    return sendDevError(req, res, 'internal_error', 'failed to update changelog entry')
  }

  return sendDevData(req, res, 200, serializeEntry(fetchEntry(id) as EntryRow))
})

// ── A14 — POST /api/dev-changelog/:id/publish ───────────────────────────────

router.post('/:id/publish', (req: AuthRequest, res: Response) => {
  const id = idParam(req.params.id)
  if (id === null) {
    return sendDevError(req, res, 'validation_failed', 'id must be a positive integer', {
      details: [{ field: 'id', issue: 'must be a positive integer' }],
    })
  }
  const entry = fetchEntry(id)
  if (!entry) return sendDevError(req, res, 'not_found', 'no such changelog entry')

  const body = (req.body ?? {}) as Record<string, unknown>
  const action = body.action
  if (action !== 'publish' && action !== 'unpublish' && action !== 'skip') {
    return sendDevError(req, res, 'validation_failed', 'action must be publish|unpublish|skip', {
      details: [{ field: 'action', issue: 'must be one of publish|unpublish|skip' }],
    })
  }

  try {
    if (action === 'publish') {
      // Fail closed. A published entry with no workspace would be visible in
      // EVERY platform's feed, because P4 filters BY workspace (api.md §5.12).
      const details: DevErrorDetail[] = []
      if (!entry.headline || !entry.headline.trim()) details.push({ field: 'headline', issue: 'required to publish' })
      if (!entry.body_stakeholder || !entry.body_stakeholder.trim()) {
        details.push({ field: 'body_stakeholder', issue: 'required to publish' })
      }
      if (!entry.workspace) {
        details.push({ field: 'workspace', issue: 'required to publish — a NULL workspace would leak into every feed' })
      }
      if (details.length) {
        return sendDevError(req, res, 'validation_failed', 'entry is not ready to publish', { details })
      }
      db()
        .prepare(
          `UPDATE changelog_entries
              SET status = 'published',
                  published_at = COALESCE(published_at, datetime('now')),
                  updated_at = datetime('now')
            WHERE id = ?`,
        )
        .run(id)
    } else if (action === 'unpublish') {
      // published_at is PRESERVED by default so a re-publish keeps the original
      // public date; `reset_published_at` is the explicit opt-out.
      const reset = body.reset_published_at === true
      db()
        .prepare(
          reset
            ? "UPDATE changelog_entries SET status = 'draft', published_at = NULL, updated_at = datetime('now') WHERE id = ?"
            : "UPDATE changelog_entries SET status = 'draft', updated_at = datetime('now') WHERE id = ?",
        )
        .run(id)
    } else {
      db()
        .prepare("UPDATE changelog_entries SET status = 'skipped', updated_at = datetime('now') WHERE id = ?")
        .run(id)
    }
  } catch (err) {
    console.error('[dev-changelog] A14 publish failed:', (err as Error).message)
    return sendDevError(req, res, 'internal_error', 'failed to change publish state')
  }

  return sendDevData(req, res, 200, serializeEntry(fetchEntry(id) as EntryRow))
})

// ── A15 — POST /api/dev-changelog/:id/retranslate ───────────────────────────

/** The copy fields an admin edits via A13; preserved across a retranslate
 *  unless `overwrite_edits` is passed. */
const ADMIN_COPY_FIELDS = ['headline', 'body_stakeholder', 'overview', 'how_to'] as const

router.post('/:id/retranslate', (req: AuthRequest, res: Response) => {
  const id = idParam(req.params.id)
  if (id === null) {
    return sendDevError(req, res, 'validation_failed', 'id must be a positive integer', {
      details: [{ field: 'id', issue: 'must be a positive integer' }],
    })
  }
  const entry = fetchEntry(id)
  if (!entry) return sendDevError(req, res, 'not_found', 'no such changelog entry')

  const body = (req.body ?? {}) as Record<string, unknown>
  const force = body.force === true
  const overwriteEdits = body.overwrite_edits === true

  if (entry.status === 'published' && !force) {
    return sendDevError(req, res, 'validation_failed', 'entry is published — pass {"force":true} to re-translate it', {
      details: [{ field: 'force', issue: 'required to re-translate a published entry' }],
    })
  }

  // Snapshot BEFORE the call: translateEntry overwrites headline/body/overview
  // outright on the audited-brief path, which would silently discard an admin's
  // hand-written copy.
  const snapshot: Record<string, string> = {}
  if (!overwriteEdits) {
    for (const field of ADMIN_COPY_FIELDS) {
      const value = entry[field]
      if (typeof value === 'string' && value.trim()) snapshot[field] = value
    }
  }

  try {
    translateEntry(id)
  } catch (err) {
    console.error('[dev-changelog] A15 translate failed:', (err as Error).message)
    return sendDevError(req, res, 'internal_error', 'failed to re-translate entry')
  }

  const restoreKeys = Object.keys(snapshot)
  if (restoreKeys.length) {
    try {
      db()
        .prepare(
          `UPDATE changelog_entries SET ${restoreKeys.map(k => `${k} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`,
        )
        .run(...restoreKeys.map(k => snapshot[k]), id)
    } catch (err) {
      console.warn('[dev-changelog] A15 edit-restore failed:', (err as Error).message)
    }
  }

  return sendDevData(req, res, 200, serializeEntry(fetchEntry(id) as EntryRow))
})

// ── A16 — POST /api/dev-changelog/:id/notify ────────────────────────────────

/**
 * Render the notification payload for an entry. Pure — no IO, no send.
 * Deliberately small: the real template lives with whatever provider is wired
 * in a later wave, and this is the contract a `dry_run` shows the operator.
 */
function renderNotification(entry: EntryRow): Record<string, unknown> {
  return {
    workspace: entry.workspace,
    subject: entry.headline || entry.title_eng || `Update in ${entry.repo}`,
    headline: entry.headline,
    body: entry.body_stakeholder,
    overview: entry.overview,
    how_to: entry.how_to,
    category: entry.category,
    published_at: entry.published_at,
    screenshots: parseJsonArray(entry.screenshots),
    pr_url: entry.pr_url,
  }
}

router.post('/:id/notify', (req: AuthRequest, res: Response) => {
  const id = idParam(req.params.id)
  if (id === null) {
    return sendDevError(req, res, 'validation_failed', 'id must be a positive integer', {
      details: [{ field: 'id', issue: 'must be a positive integer' }],
    })
  }
  const entry = fetchEntry(id)
  if (!entry) return sendDevError(req, res, 'not_found', 'no such changelog entry')

  const body = (req.body ?? {}) as Record<string, unknown>
  const channel = body.channel === undefined || body.channel === null ? 'email' : body.channel
  if (channel !== 'email') {
    return sendDevError(req, res, 'validation_failed', 'channel must be email', {
      details: [{ field: 'channel', issue: 'must be one of email' }],
    })
  }
  const dryRun = body.dry_run === true
  const force = body.force === true

  if (entry.status !== 'published') {
    return sendDevError(req, res, 'validation_failed', 'entry must be published before it can be notified', {
      details: [{ field: 'status', issue: "must be 'published'" }],
    })
  }
  if (!entry.workspace) {
    return sendDevError(req, res, 'validation_failed', 'entry has no workspace', {
      details: [{ field: 'workspace', issue: 'required to resolve a notify provider' }],
    })
  }

  const integration = getDevelopmentIntegration(entry.workspace)
  const notify = integration?.config.notify
  if (!notify || !notify.provider || notify.provider === 'none') {
    return sendDevError(req, res, 'validation_failed', 'no notify provider configured for workspace', {
      details: [{ field: 'workspace', issue: 'workspace_integrations config.notify is absent or provider=none' }],
    })
  }

  const payload = renderNotification(entry)
  // There is no recipient list in this wave (schema §2.6 carries a provider and
  // a from-address only), so the count is honestly reported as 0 rather than
  // invented.
  const recipientCount = 0

  if (entry.notified_at && !force) {
    return sendDevData(req, res, 200, serializeEntry(entry), {
      already_notified: true,
      notified_at: entry.notified_at,
      payload,
      recipient_count: recipientCount,
    })
  }

  if (dryRun) {
    return sendDevData(req, res, 200, serializeEntry(entry), {
      dry_run: true,
      payload,
      recipient_count: recipientCount,
    })
  }

  // ─────────────────────────────────────────────────────────────────────────
  // DISPATCH IS A DELIBERATE NO-OP IN THIS WAVE. Nothing is sent to anybody.
  //
  // The gate, the idempotency and the stamping above are the parts worth
  // getting right now; the send itself is not wired because there is no
  // recipient list yet — `config.notify` carries {provider, from} and no `to`.
  // Wiring a Resend call here would either send to nobody (a lie in the
  // response) or require inventing a recipient source. When the recipient list
  // lands, replace this block with the real provider call and keep every gate
  // above unchanged.
  // ─────────────────────────────────────────────────────────────────────────
  console.log(
    `[dev-changelog] notify NO-OP (dispatch not implemented) entry=${id} workspace=${entry.workspace} provider=${String(notify.provider)} recipients=${recipientCount}`,
  )

  try {
    db()
      .prepare("UPDATE changelog_entries SET notified_at = datetime('now'), updated_at = datetime('now') WHERE id = ?")
      .run(id)
  } catch (err) {
    console.error('[dev-changelog] A16 stamp failed:', (err as Error).message)
    return sendDevError(req, res, 'internal_error', 'failed to stamp notified_at')
  }

  return sendDevData(req, res, 200, serializeEntry(fetchEntry(id) as EntryRow), {
    sent: false,
    dispatch: 'not_implemented',
    payload,
    recipient_count: recipientCount,
  })
})

export default router
