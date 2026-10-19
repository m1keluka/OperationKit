/**
 * Universal Development — ADMIN dev-item routes A1..A11 (obj-704214).
 *
 * Spec: universal-development-api.md §1 (error envelope), §3.7 (admin auth),
 * §5.1-§5.11. Mounted at `/api/dev-items`.
 *
 * TWO DISCIPLINES THIS FILE MUST NOT BREAK:
 *
 *  1. **Scoping.** No route builds its own `SELECT ... FROM dev_items`. Every
 *     read funnels through `scopedDevItems()` / `getDevItem()` in
 *     services/dev-items.ts, which always apply the workspace predicate and the
 *     `deleted_at IS NULL` filter (schema §5 mitigation 1). The only direct SQL
 *     here touches OTHER tables (objectives, changelog_entries, dev_item_prs).
 *
 *  2. **Auth.** Triage is Mike-only via CC's EXISTING session admin gate
 *     (§3.7) — `requireAuth` + `requireAdmin`, not the browser-published ingest
 *     token and not `OBJECTIVES_API_TOKEN`. There is deliberately no
 *     per-workspace ACL: an admin sees every platform's board, which is the
 *     whole point of a unified board.
 */
import { Router, type Response } from 'express'
import { getDb } from '../db/index.js'
import { requireAuth, requireAdmin, type AuthRequest } from '../middleware/auth.js'
import { workspaceExists } from '../services/workspaces.js'
import { listWorkspaceRepos } from '../services/workspace-repos.js'
import {
  DEV_ITEM_SEVERITIES,
  DEV_ITEM_STATUSES,
  DEV_ITEM_TYPES,
  DEV_PR_STATES,
  DEV_NOTE_VISIBILITIES,
  DEV_SUBMITTED_VIA,
  PATCHABLE_FIELDS,
  addNote,
  countDevItems,
  createDevItem,
  facetCounts,
  getDevItem,
  listAttachments,
  listNotes,
  listUnifiedPrs,
  promoteDevItem,
  rankDevItem,
  scopedDevItems,
  serializeBoardRow,
  serializeDetailItem,
  softDeleteDevItem,
  triageDevItem,
  updateDevItem,
  upsertDevItemPr,
  type DevItemBoardRow,
  type DevItemFilters,
  type DevItemSeverity,
  type DevItemSort,
  type DevItemStatus,
  type DevItemType,
  type DevNoteVisibility,
  type DevPrState,
} from '../services/dev-items.js'
import {
  DevValidationError,
  FieldChecker,
  decodeCursor,
  encodeCursor,
  requestId,
  sendDevData,
  sendDevError,
  type DevErrorDetail,
} from '../lib/dev-api-envelope.js'

const router = Router()
router.use(requireAuth, requireAdmin)

// ── Plumbing ────────────────────────────────────────────────────────────────

type Handler = (req: AuthRequest, res: Response) => void

/**
 * A thrown `DevValidationError` is the ONLY error shape a handler may raise
 * deliberately; everything else is a bug and becomes a generic 500 whose real
 * cause goes to the server log keyed by the request id (api.md §1).
 */
function wrap(handler: Handler): Handler {
  return (req, res) => {
    try {
      handler(req, res)
    } catch (err) {
      if (err instanceof DevValidationError) {
        sendDevError(req, res, 'validation_failed', err.message, { details: err.details })
        return
      }
      const id = requestId(req, res)
      console.error(`[dev-items] ${id} unhandled error:`, err)
      sendDevError(req, res, 'internal_error', 'Something went wrong')
    }
  }
}

/** The session user's display name — `triaged_by` / note authorship (§3.7). */
function actor(req: AuthRequest): string {
  return req.user?.username ?? 'unknown'
}

function parseId(value: unknown): number | null {
  const n = Number(value)
  return Number.isInteger(n) && n > 0 ? n : null
}

/** A repeatable query param: `?x=a&x=b` and, as a superset, `?x=a,b`. */
function repeatable(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined
  const raw = Array.isArray(value) ? value : [value]
  const out: string[] = []
  for (const v of raw) {
    if (typeof v !== 'string') continue
    for (const part of v.split(',')) {
      const trimmed = part.trim()
      if (trimmed) out.push(trimmed)
    }
  }
  return out.length ? out : undefined
}

function single(value: unknown): string | undefined {
  const v = Array.isArray(value) ? value[0] : value
  if (typeof v !== 'string') return undefined
  const trimmed = v.trim()
  return trimmed ? trimmed : undefined
}

function flag(value: unknown): boolean {
  const v = single(value)
  return v === '1' || v === 'true'
}

/** Every value of a repeatable enum param must be in the vocabulary. */
function checkEnumList(
  c: FieldChecker,
  values: string[] | undefined,
  field: string,
  allowed: readonly string[],
  extraLiterals: readonly string[] = [],
): void {
  if (!values) return
  for (const v of values) {
    if (!allowed.includes(v) && !extraLiterals.includes(v)) {
      c.fail(field, `must be one of ${[...allowed, ...extraLiterals].join('|')}`)
      return
    }
  }
}

function body(req: AuthRequest): Record<string, unknown> {
  const b = req.body as unknown
  if (!b || typeof b !== 'object' || Array.isArray(b)) return {}
  return b as Record<string, unknown>
}

/** Re-read an item as a board row for serialisation. */
function boardRow(id: number, includeDeleted = false): DevItemBoardRow | null {
  return getDevItem(id, { includeDeleted })
}

function notFound(req: AuthRequest, res: Response): void {
  sendDevError(req, res, 'not_found', 'dev item not found')
}

/** `project` must name a repo registered for that workspace (api.md §5.3). */
function projectIsValid(workspace: string, project: string): boolean {
  return listWorkspaceRepos(workspace).some(r => r.name === project)
}

/** The pathname is the interesting part; query strings routinely carry tokens. */
function stripQuery(route: string | undefined): string | undefined {
  if (!route) return route
  return route.split('#')[0].split('?')[0] || undefined
}

// ── A1 — GET /api/dev-items ─────────────────────────────────────────────────

const SORTS: readonly DevItemSort[] = ['rank', 'newest', 'oldest', 'severity', 'updated']

router.get(
  '/',
  wrap((req, res) => {
    const q = req.query as Record<string, unknown>
    const c = new FieldChecker()

    const workspace = repeatable(q.workspace)
    const project = repeatable(q.project)
    const type = repeatable(q.type)
    const status = repeatable(q.status)
    const severity = repeatable(q.severity)
    const submittedVia = repeatable(q.submitted_via)

    checkEnumList(c, type, 'type', DEV_ITEM_TYPES)
    checkEnumList(c, status, 'status', DEV_ITEM_STATUSES)
    // `none` is the literal for "no severity set" — an untriaged bug (§5.1).
    checkEnumList(c, severity, 'severity', DEV_ITEM_SEVERITIES, ['none'])
    checkEnumList(c, submittedVia, 'submitted_via', DEV_SUBMITTED_VIA)

    const hasReplay = c.enum(single(q.has_replay), 'has_replay', ['yes', 'no'] as const)
    const hasScreenshot = c.enum(single(q.has_screenshot), 'has_screenshot', ['yes', 'no'] as const)
    const sort = c.enum(single(q.sort), 'sort', SORTS) ?? 'rank'
    const qText = c.optionalString(single(q.q), 'q', 128)
    const area = c.optionalString(single(q.area), 'area', 64)
    const route = c.optionalString(single(q.route), 'route', 512)
    const dateFrom = c.optionalString(single(q.date_from), 'date_from', 32)
    const dateTo = c.optionalString(single(q.date_to), 'date_to', 32)

    // limit: default 50, hard max 200 — over that is a 400, never a silent clamp,
    // so a client asking for 1000 learns it is wrong instead of silently paging.
    let limit = 50
    const rawLimit = single(q.limit)
    if (rawLimit !== undefined) {
      const n = Number(rawLimit)
      if (!Number.isInteger(n) || n < 1) c.fail('limit', 'must be a positive integer')
      else if (n > 200) c.fail('limit', 'must be at most 200')
      else limit = n
    }

    // Cursor carries an offset. Opaque to the client; unparseable is a 400.
    let offset = 0
    const rawCursor = single(q.cursor)
    if (rawCursor !== undefined) {
      const decoded = decodeCursor(rawCursor)
      const value = decoded ? Number(decoded.offset) : NaN
      if (!decoded || !Number.isInteger(value) || value < 0) c.fail('cursor', 'is not a valid cursor')
      else offset = value
    }

    c.throwIfFailed()

    const filters: DevItemFilters = {
      workspace,
      project,
      type,
      status,
      severity,
      area,
      route,
      hasReplay,
      hasScreenshot,
      untriaged: flag(q.untriaged) || undefined,
      unassigned: flag(q.unassigned) || undefined,
      submittedVia,
      q: qText,
      dateFrom,
      dateTo,
      includeDeleted: flag(q.include_deleted) || undefined,
    }

    // `scopedDevItems` deliberately returns limit+1 rows: the extra row is the
    // has_more probe, so pagination needs no second COUNT per page.
    const rows = scopedDevItems(filters, { sort, limit, offset })
    const hasMore = rows.length > limit
    const page = rows.slice(0, limit)

    const filtersApplied = [
      workspace,
      project,
      type,
      status,
      severity,
      submittedVia,
      area,
      route,
      hasReplay,
      hasScreenshot,
      qText,
      dateFrom,
      dateTo,
      filters.untriaged,
      filters.unassigned,
    ].filter(v => v !== undefined).length

    sendDevData(req, res, 200, page.map(serializeBoardRow), {
      page: { next_cursor: hasMore ? encodeCursor({ offset: offset + limit }) : null, has_more: hasMore },
      // Facets use the same WHERE minus their own dimension, so the number on a
      // chip says what SELECTING it would give you (§5.1).
      facets: {
        status: facetCounts(filters, 'status'),
        workspace: facetCounts(filters, 'workspace'),
        type: facetCounts(filters, 'type'),
      },
      meta: { total_matching: countDevItems(filters), filters_applied: filtersApplied },
    })
  }),
)

// ── A11 — POST /api/dev-items/bulk (before /:id so `bulk` is not an id) ─────

const BULK_OPS = [
  'set_status',
  'set_severity',
  'set_area',
  'set_project',
  'triage',
  'mark_duplicate',
  'delete',
  'restore',
] as const

router.post(
  '/bulk',
  wrap((req, res) => {
    const b = body(req)
    const c = new FieldChecker()

    const rawIds = b.ids
    let ids: number[] = []
    if (!Array.isArray(rawIds) || rawIds.length === 0) {
      c.fail('ids', 'must be a non-empty array')
    } else if (rawIds.length > 200) {
      c.fail('ids', 'must contain at most 200 ids')
    } else {
      ids = rawIds.map(v => parseId(v) ?? -1)
      if (ids.some(v => v < 0)) c.fail('ids', 'must contain only positive integers')
    }

    const op = c.enum(b.op, 'op', BULK_OPS)
    if (op === undefined && b.op === undefined) c.fail('op', 'required')
    const params = b.params && typeof b.params === 'object' && !Array.isArray(b.params)
      ? (b.params as Record<string, unknown>)
      : {}

    // Op-level parameter validation happens BEFORE the transaction opens: a
    // malformed `params` is a client bug, not a per-id failure.
    const status = op === 'set_status' ? c.enum(params.status, 'params.status', DEV_ITEM_STATUSES) : undefined
    if (op === 'set_status' && params.status === undefined) c.fail('params.status', 'required')
    const severity =
      op === 'set_severity' || op === 'triage'
        ? c.enum(params.severity, 'params.severity', DEV_ITEM_SEVERITIES)
        : undefined
    if (op === 'set_severity' && params.severity === undefined) c.fail('params.severity', 'required')
    const area =
      op === 'set_area' || op === 'triage' ? c.optionalString(params.area, 'params.area', 64) : undefined
    if (op === 'set_area' && area === undefined) c.fail('params.area', 'required')
    const impact = op === 'triage' ? c.intInRange(params.impact, 'params.impact', 1, 3) : undefined
    const effort = op === 'triage' ? c.intInRange(params.effort, 'params.effort', 1, 3) : undefined

    let project: string | null | undefined
    if (op === 'set_project') {
      if (params.project === null) project = null
      else {
        project = c.optionalString(params.project, 'params.project', 128)
        if (project === undefined) c.fail('params.project', 'required (use null to clear)')
      }
    }

    let duplicateOfId: number | undefined
    if (op === 'mark_duplicate') {
      duplicateOfId = parseId(params.duplicate_of_id) ?? undefined
      if (duplicateOfId === undefined) c.fail('params.duplicate_of_id', 'required')
    }
    // A4's guard applies to the bulk path too: `duplicate` without a target is
    // an item pointing at nothing.
    if (op === 'set_status' && status === 'duplicate') {
      duplicateOfId = parseId(params.duplicate_of_id) ?? undefined
      if (duplicateOfId === undefined) c.fail('params.duplicate_of_id', 'required when status is duplicate')
    }

    c.throwIfFailed()

    const includeDeleted = op === 'restore'
    const details: DevErrorDetail[] = []
    const user = actor(req)

    // ALL-OR-NOTHING (§5.11). Partial success on a bulk board action is worse
    // than none — the admin cannot tell what happened. Every per-id failure is
    // collected, then ONE throw rolls the whole batch back.
    const run = getDb().transaction(() => {
      const duplicateTarget =
        duplicateOfId !== undefined ? getDevItem(duplicateOfId) : null
      if (duplicateOfId !== undefined && !duplicateTarget) {
        details.push({ field: 'params.duplicate_of_id', issue: 'not a live dev item' })
      }

      for (const id of ids) {
        const item = getDevItem(id, { includeDeleted })
        if (!item) {
          details.push({ field: `ids[${id}]`, issue: 'not found' })
          continue
        }
        if (duplicateTarget) {
          if (duplicateTarget.workspace !== item.workspace) {
            details.push({ field: `ids[${id}]`, issue: 'duplicate_of_id is in another workspace' })
            continue
          }
          if (duplicateTarget.id === item.id) {
            details.push({ field: `ids[${id}]`, issue: 'cannot be a duplicate of itself' })
            continue
          }
        }
        if (op === 'set_project' && project) {
          if (!projectIsValid(item.workspace, project)) {
            details.push({ field: `ids[${id}]`, issue: `project is not a repo of workspace ${item.workspace}` })
            continue
          }
        }

        switch (op) {
          case 'set_status':
            updateDevItem(id, { status, ...(duplicateOfId !== undefined ? { duplicate_of_id: duplicateOfId } : {}) })
            break
          case 'set_severity':
            updateDevItem(id, { severity })
            break
          case 'set_area':
            updateDevItem(id, { area })
            break
          case 'set_project':
            updateDevItem(id, { project })
            break
          case 'triage':
            triageDevItem(id, { severity, impact, effort, area }, user)
            break
          case 'mark_duplicate':
            updateDevItem(id, { status: 'duplicate', duplicate_of_id: duplicateOfId })
            break
          case 'delete':
            softDeleteDevItem(id, false)
            break
          case 'restore':
            softDeleteDevItem(id, true)
            break
        }
      }

      if (details.length) throw new DevValidationError(details)
    })

    run()
    sendDevData(req, res, 200, { updated: ids.length, ids })
  }),
)

// ── A3 — POST /api/dev-items ────────────────────────────────────────────────

router.post(
  '/',
  wrap((req, res) => {
    const b = body(req)
    const c = new FieldChecker()

    const workspace = c.requiredString(b.workspace, 'workspace', 64)
    const title = c.requiredString(b.title, 'title', 200)
    const project = c.optionalString(b.project, 'project', 128)
    const type = c.enum(b.type, 'type', DEV_ITEM_TYPES)
    const status = c.enum(b.status, 'status', DEV_ITEM_STATUSES)
    const severity = c.enum(b.severity, 'severity', DEV_ITEM_SEVERITIES)
    const impact = c.intInRange(b.impact, 'impact', 1, 3)
    const effort = c.intInRange(b.effort, 'effort', 1, 3)
    const area = c.optionalString(b.area, 'area', 64)
    const description = typeof b.description === 'string' ? b.description.slice(0, 10000) : undefined
    const stepsToRepro = c.optionalString(b.steps_to_repro, 'steps_to_repro', 5000)
    const route = stripQuery(c.optionalString(b.route, 'route', 512))
    const loomUrl = b.loom_url === undefined || b.loom_url === null ? undefined : c.httpsUrl(b.loom_url, 'loom_url', 512)
    const loomTranscript = c.optionalString(b.loom_transcript, 'loom_transcript', 100000)
    const submitterLabel = c.optionalString(b.submitter_label, 'submitter_label', 128)

    // There is no ingest token here to infer the workspace from (§5.3), so it is
    // required AND must resolve to a real registry row — dev_items.workspace is
    // a hard FK, so an unknown slug would otherwise be a 500.
    if (workspace && !workspaceExists(workspace)) c.fail('workspace', 'is not a known workspace')
    if (workspace && project && workspaceExists(workspace) && !projectIsValid(workspace, project)) {
      c.fail('project', `is not a repo of workspace ${workspace}`)
    }
    c.throwIfFailed()

    // Supplying ANY triage dimension means a human has already triaged it, so
    // the item must not sit in the Inbox pretending to be untriaged (§5.3).
    const triaged = severity !== undefined || impact !== undefined || effort !== undefined || area !== undefined
    const now = new Date().toISOString().replace('T', ' ').slice(0, 19)

    const created = createDevItem({
      workspace: workspace as string,
      project: project ?? null,
      type: type as DevItemType | undefined,
      title: title as string,
      description,
      steps_to_repro: stepsToRepro ?? null,
      status: (status ?? (triaged ? 'triaged' : 'new')) as DevItemStatus,
      severity: (severity ?? null) as DevItemSeverity | null,
      impact: impact ?? null,
      effort: effort ?? null,
      area: area ?? null,
      route: route ?? null,
      loom_url: loomUrl ?? null,
      loom_transcript: loomTranscript ?? null,
      submitter_label: submitterLabel ?? null,
      // Server-set, never accepted from the client.
      submitted_via: 'admin',
      triaged_by: triaged ? actor(req) : null,
      triaged_at: triaged ? now : null,
    })

    const row = boardRow(created.id)
    sendDevData(req, res, 201, row ? serializeBoardRow(row) : null)
  }),
)

// ── A2 — GET /api/dev-items/:id ─────────────────────────────────────────────

const INCLUDES = ['notes', 'attachments', 'prs'] as const

router.get(
  '/:id',
  wrap((req, res) => {
    const id = parseId(req.params.id)
    if (id === null) {
      notFound(req, res)
      return
    }
    const includeDeleted = flag(req.query.include_deleted)
    const row = boardRow(id, includeDeleted)
    if (!row) {
      notFound(req, res)
      return
    }

    const requested = repeatable(req.query.include)
    const wants = (key: (typeof INCLUDES)[number]): boolean => !requested || requested.includes(key)

    const objective = row.objective_id
      ? (getDb()
          .prepare('SELECT id, status, branch_name, title FROM objectives WHERE id = ?')
          .get(row.objective_id) ?? null)
      : null

    const changelog = row.changelog_entry_id
      ? (getDb()
          .prepare('SELECT id, status, headline, published_at FROM changelog_entries WHERE id = ?')
          .get(row.changelog_entry_id) ?? null)
      : null

    sendDevData(req, res, 200, {
      item: serializeDetailItem(row),
      workspace: {
        slug: row.workspace,
        name: row.workspace_name,
        short_label: row.workspace_label,
        badge_color: row.workspace_badge_color,
      },
      objective,
      // Attachments are returned as the STORED columns. No `signed_url` is
      // minted here: that needs supabase-storage wiring which is out of scope
      // for this wave, and a half-signed URL is worse than an honest path.
      ...(wants('notes') ? { notes: listNotes(id) } : {}),
      ...(wants('attachments') ? { attachments: listAttachments(id) } : {}),
      ...(wants('prs') ? { prs: listUnifiedPrs(id) } : {}),
      changelog,
    })
  }),
)

// ── A4 — PATCH /api/dev-items/:id ───────────────────────────────────────────

const NON_NULLABLE_FIELDS = new Set(['type', 'title', 'description', 'status'])
const STRING_FIELD_LIMITS: Record<string, number> = {
  title: 200,
  description: 10000,
  steps_to_repro: 5000,
  area: 64,
  route: 512,
  project: 128,
  loom_url: 512,
  loom_transcript: 100000,
  submitter_label: 128,
}

router.patch(
  '/:id',
  wrap((req, res) => {
    const id = parseId(req.params.id)
    if (id === null) {
      notFound(req, res)
      return
    }
    const b = body(req)
    const c = new FieldChecker()

    // Re-homing an item across platforms would orphan its objective, PRs and
    // changelog entry, so `workspace` is a hard 400 rather than a silent ignore
    // (§5.4) — a client trying it has a real bug.
    if ('workspace' in b) c.fail('workspace', 'is not patchable; delete and re-create instead')

    const patch: Record<string, unknown> = {}
    for (const field of PATCHABLE_FIELDS) {
      if (!(field in b)) continue // JSON-merge-patch: absent means untouched.
      const value = b[field]
      if (value === null) {
        if (NON_NULLABLE_FIELDS.has(field)) c.fail(field, 'must not be null')
        else patch[field] = null
        continue
      }
      switch (field) {
        case 'type':
          patch[field] = c.enum(value, field, DEV_ITEM_TYPES)
          break
        case 'status':
          patch[field] = c.enum(value, field, DEV_ITEM_STATUSES)
          break
        case 'severity':
          patch[field] = c.enum(value, field, DEV_ITEM_SEVERITIES)
          break
        case 'impact':
        case 'effort':
          patch[field] = c.intInRange(value, field, 1, 3)
          break
        case 'duplicate_of_id':
        case 'changelog_entry_id': {
          const n = parseId(value)
          if (n === null) c.fail(field, 'must be a positive integer or null')
          else patch[field] = n
          break
        }
        case 'description': {
          if (typeof value !== 'string') c.fail(field, 'must be a string')
          else patch[field] = value.slice(0, STRING_FIELD_LIMITS.description)
          break
        }
        default: {
          const max = STRING_FIELD_LIMITS[field] ?? 512
          const s = c.optionalString(value, field, max)
          if (s === undefined && !c.details.some(d => d.field === field)) c.fail(field, 'must not be blank')
          else patch[field] = s
        }
      }
    }
    c.throwIfFailed()

    const existing = getDevItem(id)
    if (!existing) {
      notFound(req, res)
      return
    }

    if ('project' in patch && typeof patch.project === 'string' && !projectIsValid(existing.workspace, patch.project)) {
      throw new DevValidationError([
        { field: 'project', issue: `is not a repo of workspace ${existing.workspace}` },
      ])
    }

    const nextStatus = ('status' in patch ? patch.status : existing.status) as DevItemStatus
    const nextDuplicateOf = ('duplicate_of_id' in patch ? patch.duplicate_of_id : existing.duplicate_of_id) as
      | number
      | null

    // A `duplicate` with no target is an item pointing at nothing — the board
    // would render a dead-end chip (§5.4).
    if (nextStatus === 'duplicate' && !nextDuplicateOf) {
      throw new DevValidationError([{ field: 'duplicate_of_id', issue: 'required when status is duplicate' }])
    }
    if (typeof patch.duplicate_of_id === 'number') {
      if (patch.duplicate_of_id === id) {
        throw new DevValidationError([{ field: 'duplicate_of_id', issue: 'an item cannot duplicate itself' }])
      }
      const target = getDevItem(patch.duplicate_of_id)
      if (!target || target.workspace !== existing.workspace) {
        sendDevError(req, res, 'forbidden', 'duplicate_of_id must be a live item in the same workspace')
        return
      }
    }

    // `closed_at` stamping lives inside updateDevItem — not duplicated here.
    updateDevItem(id, patch)
    const row = boardRow(id)
    sendDevData(req, res, 200, row ? serializeBoardRow(row) : null)
  }),
)

// ── A5 — POST /api/dev-items/:id/triage ─────────────────────────────────────

router.post(
  '/:id/triage',
  wrap((req, res) => {
    const id = parseId(req.params.id)
    if (id === null) {
      notFound(req, res)
      return
    }
    const b = body(req)
    const c = new FieldChecker()
    const severity = c.enum(b.severity, 'severity', DEV_ITEM_SEVERITIES)
    const impact = c.intInRange(b.impact, 'impact', 1, 3)
    const effort = c.intInRange(b.effort, 'effort', 1, 3)
    const area = c.optionalString(b.area, 'area', 64)
    const status = c.enum(b.status, 'status', DEV_ITEM_STATUSES)
    const note = c.optionalString(b.note, 'note', 10000)
    const suggestRank = b.suggest_rank === true
    c.throwIfFailed()

    if (!getDevItem(id)) {
      notFound(req, res)
      return
    }

    // Stamping triaged_by/at, and the "never downgrade an already-planned item"
    // rule, both live in triageDevItem — this route only validates and delegates.
    const updated = triageDevItem(
      id,
      { severity, impact, effort, area, status, suggest_rank: suggestRank },
      actor(req),
    )
    if (!updated) {
      notFound(req, res)
      return
    }
    if (note) {
      addNote({
        devItemId: id,
        authorUserId: req.user?.id ?? null,
        authorLabel: actor(req),
        body: note,
        visibility: 'internal',
      })
    }
    const row = boardRow(id)
    sendDevData(req, res, 200, row ? serializeBoardRow(row) : null)
  }),
)

// ── A6 — POST /api/dev-items/:id/promote ────────────────────────────────────

router.post(
  '/:id/promote',
  wrap((req, res) => {
    const id = parseId(req.params.id)
    if (id === null) {
      notFound(req, res)
      return
    }
    const b = body(req)
    const c = new FieldChecker()
    const title = c.optionalString(b.title, 'title', 200)
    const completionGoal = c.optionalString(b.completion_goal, 'completion_goal', 2000)
    const project = c.optionalString(b.project, 'project', 128)
    const type = c.enum(b.type, 'type', DEV_ITEM_TYPES)
    c.throwIfFailed()

    const existing = getDevItem(id)
    if (!existing) {
      notFound(req, res)
      return
    }
    // objectives.workspace is FK-by-convention to workspaces.slug; a stale slug
    // would fail deep inside the INSERT (§5.6 error table).
    if (!workspaceExists(existing.workspace)) {
      throw new DevValidationError([{ field: 'workspace', issue: 'item workspace has no workspaces row' }])
    }
    if (project && !projectIsValid(existing.workspace, project)) {
      throw new DevValidationError([
        { field: 'project', issue: `is not a repo of workspace ${existing.workspace}` },
      ])
    }

    const result = promoteDevItem(id, { title, completion_goal: completionGoal, project, type })
    if (!result) {
      notFound(req, res)
      return
    }
    const row = boardRow(id)
    // Double-clicking Promote is not an error: idempotent repeat is a 200, never
    // a 409 (§5.6).
    sendDevData(
      req,
      res,
      result.alreadyPromoted ? 200 : 201,
      { dev_item: row ? serializeBoardRow(row) : null, objective: result.objective },
      { already_promoted: result.alreadyPromoted },
    )
  }),
)

// ── A7 — POST /api/dev-items/:id/rank ───────────────────────────────────────

router.post(
  '/:id/rank',
  wrap((req, res) => {
    const id = parseId(req.params.id)
    if (id === null) {
      notFound(req, res)
      return
    }
    const b = body(req)
    const c = new FieldChecker()
    const beforeId = b.before_id === undefined || b.before_id === null ? null : parseId(b.before_id)
    const afterId = b.after_id === undefined || b.after_id === null ? null : parseId(b.after_id)
    if (b.before_id !== undefined && b.before_id !== null && beforeId === null) {
      c.fail('before_id', 'must be a positive integer')
    }
    if (b.after_id !== undefined && b.after_id !== null && afterId === null) {
      c.fail('after_id', 'must be a positive integer')
    }
    c.throwIfFailed()

    // The SERVER computes the value (schema §4) so two concurrent drags cannot
    // both write the same rank.
    const result = rankDevItem(id, beforeId, afterId)
    if (result === null) {
      notFound(req, res)
      return
    }
    if ('error' in result) {
      throw new DevValidationError([{ field: 'before_id', issue: result.error }])
    }
    sendDevData(
      req,
      res,
      200,
      { id: result.id, priority_rank: result.priority_rank },
      { renormalized: result.renormalized },
    )
  }),
)

// ── A8 — POST /api/dev-items/:id/attach-pr ──────────────────────────────────

const PR_URL_RE = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)/
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

router.post(
  '/:id/attach-pr',
  wrap((req, res) => {
    const id = parseId(req.params.id)
    if (id === null) {
      notFound(req, res)
      return
    }
    const b = body(req)
    const c = new FieldChecker()
    const rawRepo = c.requiredString(b.repo, 'repo', 512)
    const state = c.enum(b.state, 'state', DEV_PR_STATES)
    let prUrl = c.optionalString(b.pr_url, 'pr_url', 512)
    c.throwIfFailed()

    // `repo` accepts either `owner/repo` or a full PR URL (§5.8); pasting the
    // browser URL is the common admin gesture, so it must not be a 400.
    let repo: string | undefined
    let prNumber = parseId(b.pr_number) ?? undefined
    const urlMatch = PR_URL_RE.exec(rawRepo as string)
    if (urlMatch) {
      repo = `${urlMatch[1]}/${urlMatch[2]}`
      prNumber = prNumber ?? Number(urlMatch[3])
      prUrl = prUrl ?? (rawRepo as string)
    } else if (REPO_RE.test(rawRepo as string)) {
      repo = rawRepo as string
    }
    const details: DevErrorDetail[] = []
    if (!repo) details.push({ field: 'repo', issue: 'must be owner/repo or a GitHub pull-request URL' })
    if (!prNumber) details.push({ field: 'pr_number', issue: 'required when repo is not a pull-request URL' })
    if (details.length) throw new DevValidationError(details)

    const item = getDevItem(id)
    if (!item) {
      notFound(req, res)
      return
    }

    // UNIQUE(dev_item_id, repo, pr_number) makes a repeat a no-op upsert
    // returning 200, NOT a 409 — re-attaching the same PR is not an error.
    const existed = getDb()
      .prepare('SELECT 1 FROM dev_item_prs WHERE dev_item_id = ? AND repo = ? AND pr_number = ?')
      .get(id, repo, prNumber)

    upsertDevItemPr({
      devItemId: id,
      repo: repo as string,
      prNumber: prNumber as number,
      prUrl: prUrl ?? null,
      state: state as DevPrState | undefined,
      linkSource: 'manual',
    })

    const row = getDb()
      .prepare('SELECT * FROM dev_item_prs WHERE dev_item_id = ? AND repo = ? AND pr_number = ?')
      .get(id, repo, prNumber)

    // The row is STILL written to dev_item_prs when an objective exists — the
    // A2 union handles it and nothing is duplicated across tables (§5.8).
    sendDevData(
      req,
      res,
      existed ? 200 : 201,
      row,
      item.objective_id ? { note: 'item has an objective; consider objective_prs' } : {},
    )
  }),
)

// ── A9 — POST /api/dev-items/:id/notes ──────────────────────────────────────

router.post(
  '/:id/notes',
  wrap((req, res) => {
    const id = parseId(req.params.id)
    if (id === null) {
      notFound(req, res)
      return
    }
    const b = body(req)
    const c = new FieldChecker()
    const noteBody = c.requiredString(b.body, 'body', 10000)
    const visibility = c.enum(b.visibility, 'visibility', DEV_NOTE_VISIBILITIES)
    // Agents may author notes, so an explicit label wins over the session user.
    const authorLabel = c.optionalString(b.author_label, 'author_label', 128)
    c.throwIfFailed()

    if (!getDevItem(id)) {
      notFound(req, res)
      return
    }
    const note = addNote({
      devItemId: id,
      authorUserId: req.user?.id ?? null,
      authorLabel: authorLabel ?? actor(req),
      body: noteBody as string,
      visibility: (visibility ?? 'internal') as DevNoteVisibility,
    })
    sendDevData(req, res, 201, note)
  }),
)

// ── A10 — DELETE /api/dev-items/:id ─────────────────────────────────────────

router.delete(
  '/:id',
  wrap((req, res) => {
    const id = parseId(req.params.id)
    if (id === null) {
      notFound(req, res)
      return
    }
    const restore = flag(req.query.restore)
    // A restore must be able to find a row that IS soft-deleted, so the lookup
    // is include-deleted in both directions.
    if (!getDevItem(id, { includeDeleted: true })) {
      notFound(req, res)
      return
    }
    softDeleteDevItem(id, restore)

    if (restore) {
      const row = boardRow(id)
      sendDevData(req, res, 200, row ? serializeBoardRow(row) : null)
      return
    }
    // Soft delete: nothing cascades, and there is no body to return (§5.10).
    requestId(req, res)
    res.status(204).end()
  }),
)

export default router
