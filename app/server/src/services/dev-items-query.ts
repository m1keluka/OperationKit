/**
 * Universal Development scoped reads and serialisation —
 * extracted from dev-items.ts (behavior frozen).
 *
 * THE SCOPING RULE (schema §5 mitigation 1): every board listing goes through
 * scopedDevItems() / getDevItem() here. No route builds its own
 * SELECT ... FROM dev_items.
 */
import { escapeLike } from '../lib/dev-api-envelope.js'
import {
  CLOSED_STATUSES,
  db,
  devRef,
  statusLabel,
  type DevItemBoardRow,
  type DevItemStatus,
  type DevNoteVisibility,
} from './dev-items-schema.js'

// ── Reads ───────────────────────────────────────────────────────────────────

/** The SELECT + JOIN prefix shared by every board/detail read (schema §3). */
const BOARD_SELECT = `
  SELECT di.*,
         o.status  AS objective_status,
         o.branch_name,
         o.pr_url  AS objective_pr_url,
         (SELECT COUNT(*) FROM dev_item_notes n       WHERE n.dev_item_id = di.id) AS note_count,
         (SELECT COUNT(*) FROM dev_item_attachments a WHERE a.dev_item_id = di.id) AS attachment_count,
         ce.status AS changelog_status,
         w.name         AS workspace_name,
         w.short_label  AS workspace_label,
         w.badge_color  AS workspace_badge_color
    FROM dev_items di
    LEFT JOIN objectives        o  ON o.id = di.objective_id
    LEFT JOIN changelog_entries ce ON ce.id = di.changelog_entry_id
    LEFT JOIN workspaces        w  ON w.slug = di.workspace
`

export interface DevItemFilters {
  workspace?: string[]
  project?: string[]
  type?: string[]
  status?: string[]
  severity?: string[]
  area?: string
  route?: string
  hasReplay?: 'yes' | 'no'
  hasScreenshot?: 'yes' | 'no'
  untriaged?: boolean
  unassigned?: boolean
  submittedVia?: string[]
  q?: string
  dateFrom?: string
  dateTo?: string
  includeDeleted?: boolean
}

interface WhereClause {
  sql: string
  params: unknown[]
}

/**
 * Build the WHERE clause for the board query.
 *
 * `skipDimension` omits ONE filter so the same predicate can compute a facet
 * count: the number on a chip then tells you what SELECTING it would give you,
 * rather than what you already have selected (api.md §5.1).
 */
function buildWhere(f: DevItemFilters, skipDimension?: keyof DevItemFilters): WhereClause {
  const parts: string[] = []
  const params: unknown[] = []
  const use = (dim: keyof DevItemFilters) => skipDimension !== dim

  if (!f.includeDeleted) parts.push('di.deleted_at IS NULL')

  const inList = (dim: keyof DevItemFilters, column: string, values?: string[]) => {
    if (!use(dim) || !values || values.length === 0) return
    parts.push(`${column} IN (${values.map(() => '?').join(',')})`)
    params.push(...values)
  }

  inList('workspace', 'di.workspace', f.workspace)
  inList('type', 'di.type', f.type)
  inList('status', 'di.status', f.status)
  inList('submittedVia', 'di.submitted_via', f.submittedVia)

  // `__none__` is the literal for "workspace-wide" (project IS NULL), so the
  // board can filter to unscoped items — otherwise they are unreachable.
  if (use('project') && f.project && f.project.length) {
    const named = f.project.filter(p => p !== '__none__')
    const wantsNull = f.project.includes('__none__')
    const clauses: string[] = []
    if (named.length) {
      clauses.push(`di.project IN (${named.map(() => '?').join(',')})`)
      params.push(...named)
    }
    if (wantsNull) clauses.push('di.project IS NULL')
    if (clauses.length) parts.push(`(${clauses.join(' OR ')})`)
  }

  // `none` is the literal for "no severity set" — an untriaged bug.
  if (use('severity') && f.severity && f.severity.length) {
    const named = f.severity.filter(s => s !== 'none')
    const wantsNull = f.severity.includes('none')
    const clauses: string[] = []
    if (named.length) {
      clauses.push(`di.severity IN (${named.map(() => '?').join(',')})`)
      params.push(...named)
    }
    if (wantsNull) clauses.push('di.severity IS NULL')
    if (clauses.length) parts.push(`(${clauses.join(' OR ')})`)
  }

  if (use('area') && f.area) {
    parts.push('di.area = ?')
    params.push(f.area)
  }
  if (use('route') && f.route) {
    // Prefix match, hitting idx_dev_items_route.
    parts.push("di.route LIKE ? ESCAPE '\\'")
    params.push(`${escapeLike(f.route)}%`)
  }
  if (use('hasReplay') && f.hasReplay) {
    parts.push(f.hasReplay === 'yes' ? 'di.posthog_replay_url IS NOT NULL' : 'di.posthog_replay_url IS NULL')
  }
  if (use('hasScreenshot') && f.hasScreenshot) {
    parts.push(f.hasScreenshot === 'yes' ? 'di.screenshot_path IS NOT NULL' : 'di.screenshot_path IS NULL')
  }
  if (use('untriaged') && f.untriaged) parts.push('di.triaged_at IS NULL')
  if (use('unassigned') && f.unassigned) parts.push('di.objective_id IS NULL')

  if (use('q') && f.q) {
    // No FTS in v1 (schema §6 non-goal). `%`/`_` are escaped so `q=%` cannot
    // silently match every row.
    parts.push("(di.title LIKE ? ESCAPE '\\' OR di.description LIKE ? ESCAPE '\\')")
    const pattern = `%${escapeLike(f.q)}%`
    params.push(pattern, pattern)
  }

  // Date filtering targets `closed_at` when the caller asked ONLY for closed
  // statuses, else `created_at`. The PRD rule this implements: an old
  // untriaged item must never be silently hidden by a "last 30 days" filter.
  if (use('dateFrom') && (f.dateFrom || f.dateTo)) {
    const onlyClosed =
      !!f.status && f.status.length > 0 && f.status.every(s => CLOSED_STATUSES.has(s as DevItemStatus))
    const column = onlyClosed ? 'di.closed_at' : 'di.created_at'
    if (f.dateFrom) {
      parts.push(`${column} >= ?`)
      params.push(f.dateFrom)
    }
    if (f.dateTo) {
      // Inclusive of the whole end day.
      parts.push(`${column} < date(?, '+1 day')`)
      params.push(f.dateTo)
    }
  }

  return { sql: parts.length ? `WHERE ${parts.join(' AND ')}` : '', params }
}

export type DevItemSort = 'rank' | 'newest' | 'oldest' | 'severity' | 'updated'

const ORDER_BY: Record<DevItemSort, string> = {
  // The schema §3 board ordering: unranked sorts last, then rank ascending.
  rank: 'di.priority_rank IS NULL, di.priority_rank ASC, di.created_at DESC, di.id DESC',
  newest: 'di.created_at DESC, di.id DESC',
  oldest: 'di.created_at ASC, di.id ASC',
  // Severity is a text column, so order it by meaning, not alphabetically.
  severity:
    "CASE di.severity WHEN 'blocker' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END ASC, di.created_at DESC, di.id DESC",
  updated: 'di.updated_at DESC, di.id DESC',
}

/**
 * THE scoped read path (schema §5 mitigation 1). Every board listing goes
 * through here; no route builds its own dev_items SELECT.
 */
export function scopedDevItems(
  filters: DevItemFilters,
  opts: { sort?: DevItemSort; limit?: number; offset?: number } = {},
): DevItemBoardRow[] {
  const where = buildWhere(filters)
  const sort = opts.sort ?? 'rank'
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200)
  const offset = Math.max(opts.offset ?? 0, 0)
  return db()
    .prepare(`${BOARD_SELECT} ${where.sql} ORDER BY ${ORDER_BY[sort]} LIMIT ? OFFSET ?`)
    .all(...where.params, limit + 1, offset) as DevItemBoardRow[]
}

export function countDevItems(filters: DevItemFilters): number {
  const where = buildWhere(filters)
  const row = db()
    .prepare(`SELECT COUNT(*) AS c FROM dev_items di ${where.sql}`)
    .get(...where.params) as { c: number }
  return row.c
}

/**
 * Facet counts for one dimension, computed with the same WHERE clause MINUS
 * that dimension (api.md §5.1).
 */
export function facetCounts(
  filters: DevItemFilters,
  dimension: 'status' | 'workspace' | 'type',
): Record<string, number> {
  const dimKey: keyof DevItemFilters = dimension
  const where = buildWhere(filters, dimKey)
  const rows = db()
    .prepare(`SELECT di.${dimension} AS k, COUNT(*) AS c FROM dev_items di ${where.sql} GROUP BY di.${dimension}`)
    .all(...where.params) as Array<{ k: string | null; c: number }>
  const out: Record<string, number> = {}
  for (const r of rows) if (r.k !== null) out[r.k] = r.c
  return out
}

export function getDevItem(id: number, opts: { includeDeleted?: boolean } = {}): DevItemBoardRow | null {
  const clause = opts.includeDeleted ? '' : 'AND di.deleted_at IS NULL'
  const row = db()
    .prepare(`${BOARD_SELECT} WHERE di.id = ? ${clause}`)
    .get(id) as DevItemBoardRow | undefined
  return row ?? null
}

export function listNotes(devItemId: number, visibility?: DevNoteVisibility) {
  const clause = visibility ? 'AND visibility = ?' : ''
  const params: unknown[] = visibility ? [devItemId, visibility] : [devItemId]
  return db()
    .prepare(
      `SELECT id, dev_item_id, author_user_id, author_label, body, visibility, created_at
         FROM dev_item_notes WHERE dev_item_id = ? ${clause} ORDER BY created_at ASC, id ASC`,
    )
    .all(...params) as Array<{
    id: number
    dev_item_id: number
    author_user_id: number | null
    author_label: string | null
    body: string
    visibility: DevNoteVisibility
    created_at: string
  }>
}

export function listAttachments(devItemId: number) {
  return db()
    .prepare('SELECT * FROM dev_item_attachments WHERE dev_item_id = ? ORDER BY id ASC')
    .all(devItemId) as Array<{
    id: number
    dev_item_id: number
    storage_provider: 'local' | 'supabase'
    storage_bucket: string | null
    storage_path: string
    file_name: string | null
    mime_type: string | null
    size_bytes: number | null
    uploaded_by: string | null
    created_at: string
  }>
}

export interface UnifiedPr {
  repo: string | null
  pr_number: number
  pr_url: string | null
  state: string
  via: string
}

/**
 * The unified PR list for one item (schema §3 / api.md §5.2).
 *
 * `objective_prs` and `dev_item_prs` are UNIONED, never merged into one table:
 * when an item has an objective, its PR history already lives in
 * `objective_prs` and copying rows across would create the exact drift this
 * design exists to kill (schema §2.4 scope discipline). Dedupe prefers the
 * `objective_prs` row.
 */
export function listUnifiedPrs(devItemId: number): UnifiedPr[] {
  const item = db().prepare('SELECT objective_id FROM dev_items WHERE id = ?').get(devItemId) as
    | { objective_id: number | null }
    | undefined
  if (!item) return []

  const fromObjective = item.objective_id
    ? (db()
        .prepare(
          `SELECT repo, pr_number, pr_url, state, 'objective' AS via
             FROM objective_prs WHERE objective_id = ?`,
        )
        .all(item.objective_id) as UnifiedPr[])
    : []

  const fromItem = db()
    .prepare(
      `SELECT repo, pr_number, pr_url, state, link_source AS via
         FROM dev_item_prs WHERE dev_item_id = ?`,
    )
    .all(devItemId) as UnifiedPr[]

  const byKey = new Map<string, UnifiedPr>()
  for (const pr of fromObjective) byKey.set(`${pr.repo ?? ''}#${pr.pr_number}`, pr)
  for (const pr of fromItem) {
    const key = `${pr.repo ?? ''}#${pr.pr_number}`
    if (!byKey.has(key)) byKey.set(key, pr)
  }
  return [...byKey.values()].sort((a, b) => b.pr_number - a.pr_number)
}

// ── P3 "my requests" ────────────────────────────────────────────────────────

/**
 * The submitter-facing view (api.md §4.3), mitigating schema §5 point 2: a
 * submitter can no longer read their own rows out of their own database, so CC
 * must serve them.
 *
 * FIELD DISCIPLINE IS THE WHOLE POINT. This returns only id/ref/type/status/
 * status_label/title/route/created_at/closed_at, notes with
 * visibility='submitter', and the linked PUBLISHED changelog entry. It must
 * never expose severity, impact, effort, priority_rank, area, internal notes,
 * objective_id, console_log, client_meta, another submitter's rows, or
 * soft-deleted rows.
 */
export function listSubmitterItems(
  workspace: string,
  submitterId: string,
  opts: { statuses?: string[]; limit?: number; offset?: number } = {},
) {
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 50)
  const offset = Math.max(opts.offset ?? 0, 0)
  const params: unknown[] = [workspace, submitterId]
  let statusClause = ''
  if (opts.statuses && opts.statuses.length) {
    statusClause = `AND di.status IN (${opts.statuses.map(() => '?').join(',')})`
    params.push(...opts.statuses)
  }
  const rows = db()
    .prepare(
      `SELECT di.id, di.type, di.status, di.title, di.route, di.created_at, di.closed_at,
              ce.headline AS changelog_headline, ce.published_at AS changelog_published_at
         FROM dev_items di
         LEFT JOIN changelog_entries ce
                ON ce.id = di.changelog_entry_id AND ce.status = 'published'
        WHERE di.workspace = ? AND di.submitter_platform_user_id = ? AND di.deleted_at IS NULL
          ${statusClause}
        ORDER BY di.created_at DESC, di.id DESC
        LIMIT ? OFFSET ?`,
    )
    .all(...params, limit + 1, offset) as Array<{
    id: number
    type: string
    status: string
    title: string
    route: string | null
    created_at: string
    closed_at: string | null
    changelog_headline: string | null
    changelog_published_at: string | null
  }>

  const hasMore = rows.length > limit
  const page = rows.slice(0, limit)
  return {
    items: page.map(r => ({
      id: r.id,
      ref: devRef(r.id),
      type: r.type,
      status: r.status,
      status_label: statusLabel(r.status),
      title: r.title,
      route: r.route,
      created_at: r.created_at,
      closed_at: r.closed_at,
      public_notes: listNotes(r.id, 'submitter').map(n => ({ body: n.body, created_at: n.created_at })),
      changelog: r.changelog_published_at
        ? { headline: r.changelog_headline, published_at: r.changelog_published_at }
        : null,
    })),
    hasMore,
  }
}

// ── Serialisation for the admin board (api.md §5.1) ─────────────────────────

export function serializeBoardRow(row: DevItemBoardRow) {
  return {
    id: row.id,
    ref: devRef(row.id),
    workspace: row.workspace,
    workspace_label: row.workspace_label,
    workspace_badge_color: row.workspace_badge_color,
    project: row.project,
    type: row.type,
    status: row.status,
    severity: row.severity,
    impact: row.impact,
    effort: row.effort,
    priority_rank: row.priority_rank,
    area: row.area,
    route: row.route,
    title: row.title,
    description: row.description,
    submitter_label: row.submitter_label,
    submitter_email: row.submitter_email,
    submitted_via: row.submitted_via,
    has_replay: row.posthog_replay_url !== null,
    has_screenshot: row.screenshot_path !== null,
    posthog_replay_url: row.posthog_replay_url,
    loom_url: row.loom_url,
    objective_id: row.objective_id,
    objective_status: row.objective_status,
    branch_name: row.branch_name,
    objective_pr_url: row.objective_pr_url,
    changelog_status: row.changelog_status,
    note_count: row.note_count,
    attachment_count: row.attachment_count,
    triaged_at: row.triaged_at,
    closed_at: row.closed_at,
    deleted_at: row.deleted_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

function safeJsonParse(value: string, fallback: unknown): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

/** A2 detail: the full row, with the three JSON columns parsed. */
export function serializeDetailItem(row: DevItemBoardRow) {
  return {
    ...serializeBoardRow(row),
    steps_to_repro: row.steps_to_repro,
    duplicate_of_id: row.duplicate_of_id,
    submitter_platform_user_id: row.submitter_platform_user_id,
    posthog_session_id: row.posthog_session_id,
    console_log: row.console_log,
    route_history: safeJsonParse(row.route_history, []),
    client_meta: safeJsonParse(row.client_meta, {}),
    legacy_ref: safeJsonParse(row.legacy_ref, {}),
    screenshot_path: row.screenshot_path,
    loom_transcript: row.loom_transcript,
    source_system: row.source_system,
    source_table: row.source_table,
    source_id: row.source_id,
    promoted_at: row.promoted_at,
    changelog_entry_id: row.changelog_entry_id,
    triaged_by: row.triaged_by,
  }
}
