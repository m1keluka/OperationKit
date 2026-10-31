/**
 * Read side of the control-layer endpoints (obj 714091): GET /api/agent/changes
 * and GET /api/agent/attention. Both are built for an LLM orchestrator that
 * POLLS the board — every field is trimmed, every list is bounded, and the
 * visibility rules are exactly the board LIST's (admin: all; member: own
 * workspaces, filtered to own cards unless the membership is 'all').
 */
import type Database from 'better-sqlite3'
import { getUserWorkspaces } from '../middleware/workspace.js'

export interface ControlUser {
  id: number
  role: string
  /** An agent key's workspace allowlist (obj 714100). null/undefined = no extra limit. */
  allowWorkspaces?: string[] | null
}

/** SQL predicate (alias `o`) + params restricting rows to what `user` may read.
 *  Returns null when the user can see nothing. */
export function visibilityClause(
  user: ControlUser,
  workspace?: string,
): { sql: string; params: unknown[] } | null {
  const allow = user.allowWorkspaces
  if (allow) {
    if (workspace && !allow.includes(workspace)) return null
    if (allow.length === 0) return null
    const base = baseVisibility(user, workspace)
    if (!base) return null
    return {
      sql: `(${base.sql} AND o.workspace IN (${allow.map(() => '?').join(',')}))`,
      params: [...base.params, ...allow],
    }
  }
  return baseVisibility(user, workspace)
}

function baseVisibility(
  user: ControlUser,
  workspace?: string,
): { sql: string; params: unknown[] } | null {
  if (user.role === 'admin') {
    return workspace
      ? { sql: 'o.workspace = ?', params: [workspace] }
      : { sql: '1 = 1', params: [] }
  }
  const memberships = getUserWorkspaces(user.id)
    .filter(m => !workspace || m.workspace === workspace)
  if (memberships.length === 0) return null
  const allWs = memberships.filter(m => m.objective_visibility === 'all').map(m => m.workspace)
  const ownWs = memberships.filter(m => m.objective_visibility !== 'all').map(m => m.workspace)
  const clauses: string[] = []
  const params: unknown[] = []
  if (allWs.length > 0) {
    clauses.push(`o.workspace IN (${allWs.map(() => '?').join(',')})`)
    params.push(...allWs)
  }
  if (ownWs.length > 0) {
    clauses.push(
      `(o.workspace IN (${ownWs.map(() => '?').join(',')}) AND (
         o.assigned_user_id = ? OR o.created_by = ?
         OR o.id IN (SELECT objective_id FROM objective_assignees WHERE user_id = ?)
       ))`,
    )
    params.push(...ownWs, user.id, user.id, user.id)
  }
  return { sql: `(${clauses.join(' OR ')})`, params }
}

/** First line, whitespace-collapsed, capped at `max` chars with an ellipsis. */
export function oneLine(text: string | null | undefined, max: number): string | null {
  if (!text) return null
  const first = text
    .split('\n')
    .map(l => l.replace(/^[#>*\-\s]+/, '').trim())
    .find(l => l.length > 0)
  if (!first) return null
  const collapsed = first.replace(/\s+/g, ' ')
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed
}

// ── Changes feed ─────────────────────────────────────────────────────────────

export const CHANGES_DEFAULT_LIMIT = 100
export const CHANGES_MAX_LIMIT = 500

export type ChangeType =
  | 'created'
  | 'status'
  | 'entered_review'
  | 'verdict'
  | 'session_ended'
  | 'pr_opened'
  | 'pr_merged'
  | 'pr_closed'
  | 'deleted'

export interface ChangeEvent {
  cursor: string
  at: string
  objective_id: number
  title: string | null
  workspace: string | null
  type: ChangeType
  from?: string
  to?: string
  detail?: string
}

export interface ChangesPage {
  events: ChangeEvent[]
  next_cursor: string
  has_more: boolean
}

interface EventRow {
  id: number
  objective_id: number
  kind: string
  from_value: string | null
  to_value: string | null
  detail: string | null
  created_at: string
  title: string | null
  workspace: string | null
}

function changeType(row: EventRow): ChangeType {
  switch (row.kind) {
    case 'status':
      return row.to_value === 'review' ? 'entered_review' : 'status'
    case 'pr':
      if (row.to_value === 'merged') return 'pr_merged'
      if (row.to_value === 'closed') return 'pr_closed'
      return 'pr_opened'
    default:
      return row.kind as ChangeType
  }
}

function toEvent(row: EventRow): ChangeEvent {
  const ev: ChangeEvent = {
    cursor: String(row.id),
    at: row.created_at,
    objective_id: row.objective_id,
    title: oneLine(row.title, 80),
    workspace: row.workspace,
    type: changeType(row),
  }
  if (row.from_value != null) ev.from = row.from_value
  if (row.to_value != null) ev.to = row.to_value
  const detailMax = row.kind === 'pr' ? 200 : 160
  const detail = oneLine(row.detail, detailMax)
  if (detail) ev.detail = detail
  return ev
}

/**
 * Parse a `since` cursor. Returns null when the value is not a non-negative
 * integer string (the route answers 400).
 */
export function parseCursor(raw: unknown): number | null {
  if (typeof raw !== 'string' || !/^\d{1,15}$/.test(raw)) return null
  return Number(raw)
}

/**
 * One page of events strictly after `since`, ascending by id.
 *
 * `since` undefined → start 24h back (the first poll is "what happened
 * recently", not a 30-day replay); pass since=0 for everything retained.
 *
 * `next_cursor` is the id of the last returned event — or, when nothing visible
 * matched, the head id observed in the SAME read snapshot, so a caller never
 * rescans rows it cannot see and never skips one that commits later.
 */
export function readChanges(
  db: Database.Database,
  user: ControlUser,
  opts: { since?: number; workspace?: string; limit?: number },
): ChangesPage {
  const limit = Math.min(Math.max(opts.limit ?? CHANGES_DEFAULT_LIMIT, 1), CHANGES_MAX_LIMIT)

  return db.transaction((): ChangesPage => {
    const head = (db.prepare('SELECT COALESCE(MAX(id), 0) AS head FROM objective_events').get() as { head: number }).head
    let since = opts.since
    if (since === undefined) {
      const row = db
        .prepare(`SELECT MIN(id) AS first FROM objective_events WHERE created_at >= datetime('now', '-1 day')`)
        .get() as { first: number | null }
      since = row.first != null ? row.first - 1 : head
    }

    const vis = visibilityClause(user, opts.workspace)
    if (!vis) return { events: [], next_cursor: String(Math.max(since, head)), has_more: false }

    // LEFT JOIN: a hard-deleted card has no objectives row any more. Only an admin
    // sees those (members' visibility needs the row), filtered on the stored
    // workspace snapshot. PR events store workspace NULL and resolve via the join.
    // A workspace-restricted agent key only sees orphans whose snapshot is in
    // its allowlist (obj 714100); PR events with no snapshot are dropped for it.
    const allow = user.allowWorkspaces
    let adminOrphan = ''
    const orphanParams: unknown[] = []
    if (user.role === 'admin') {
      if (opts.workspace) {
        adminOrphan = ' OR (o.id IS NULL AND e.workspace = ?)'
        orphanParams.push(opts.workspace)
      } else if (allow) {
        adminOrphan = ` OR (o.id IS NULL AND e.workspace IN (${allow.map(() => '?').join(',')}))`
        orphanParams.push(...allow)
      } else {
        adminOrphan = ' OR o.id IS NULL'
      }
    }
    const params: unknown[] = [since, head, ...vis.params, ...orphanParams]
    params.push(limit + 1)

    const rows = db
      .prepare(
        `SELECT e.id, e.objective_id, e.kind, e.from_value, e.to_value, e.detail, e.created_at,
                COALESCE(o.title, CASE WHEN e.kind = 'deleted' THEN e.detail END) AS title,
                COALESCE(o.workspace, e.workspace) AS workspace
           FROM objective_events e
           LEFT JOIN objectives o ON o.id = e.objective_id
          WHERE e.id > ? AND e.id <= ?
            AND ((o.id IS NOT NULL AND ${vis.sql})${adminOrphan})
          ORDER BY e.id ASC
          LIMIT ?`,
      )
      .all(...params) as EventRow[]

    const hasMore = rows.length > limit
    const page = hasMore ? rows.slice(0, limit) : rows
    // Not hasMore ⇒ every row up to `head` was scanned (visible or not).
    const nextCursor = hasMore ? page[page.length - 1].id : Math.max(since, head)
    return {
      events: page.map(r => {
        const ev = toEvent(r)
        // A deleted card's title came from the detail snapshot — don't repeat it.
        if (r.kind === 'deleted') delete ev.detail
        return ev
      }),
      next_cursor: String(nextCursor),
      has_more: hasMore,
    }
  })()
}

// ── Attention brief ──────────────────────────────────────────────────────────

export const ATTENTION_DEFAULT_STALE_MIN = 30
export const ATTENTION_DEFAULT_LIMIT = 15
export const ATTENTION_MAX_LIMIT = 50

export type AttentionKind = 'needs_secret' | 'failed_review' | 'review' | 'blocked' | 'stuck'

export interface AttentionItem {
  id: number
  kind: AttentionKind
  title: string
  why: string
  age_min: number
  ws?: string
  /** obj 719065: kind needs_secret only — what to relay (fulfill_secret_request). Never a value. */
  secret_requests?: { request_id: string; name: string; reason: string; scope: string }[]
}

export interface AttentionBrief {
  as_of: string
  workspace: string | null
  counts: Record<AttentionKind, number>
  items: AttentionItem[]
  truncated: boolean
}

interface AttentionRow {
  id: number
  title: string
  status: string
  workspace: string
  has_blockers: number
  ai_review_verdict: string | null
  ai_review_findings: string | null
  last_session_summary: string | null
  last_note: string | null
  idle_min: number
  needs_secret: string | null
}

// Most urgent first: a failed review is a human decision blocking a branch; a
// blocker is a worker asking for help; plain review is "accept or bounce"; stuck
// is a heuristic.
// needs_secret leads: only the owner can unblock it, and it names exactly what to do (obj 718944).
const KIND_ORDER: AttentionKind[] = ['needs_secret', 'failed_review', 'blocked', 'review', 'stuck']
/** Cap on the WHOLE why line (lead + snippet). */
const WHY_MAX = 140

function classify(row: AttentionRow, staleMin: number): { kind: AttentionKind; why: string } | null {
  const secrets = parseNeedsSecretNames(row.needs_secret)
  if (secrets.length) {
    return { kind: 'needs_secret', why: `Needs secret from you: ${secrets.join('; ')}` }
  }
  if (row.status === 'review') {
    if (row.ai_review_verdict === 'fail') {
      return {
        kind: 'failed_review',
        why: `AI review FAIL: ${oneLine(row.ai_review_findings, WHY_MAX) ?? 'no findings recorded'}`,
      }
    }
    const summary = oneLine(row.last_session_summary, WHY_MAX) ?? oneLine(row.last_note, WHY_MAX)
    const lead = row.ai_review_verdict === 'pass' ? 'AI review passed — accept or reopen' : 'Awaiting you'
    return { kind: 'review', why: summary ? `${lead}: ${summary}` : lead }
  }
  if (row.status === 'working') {
    if (row.has_blockers) {
      return { kind: 'blocked', why: `Blocker raised: ${oneLine(row.last_note, WHY_MAX) ?? 'see /timeline'}` }
    }
    if (row.idle_min >= staleMin) {
      return { kind: 'stuck', why: `No activity for ${row.idle_min} min while working` }
    }
  }
  return null
}

/** obj 719065: addressable requests for a needs_secret card (same id shape as services/secret-requests). */
function secretRequestsOf(row: AttentionRow): NonNullable<AttentionItem['secret_requests']> {
  try {
    const v = JSON.parse(row.needs_secret ?? '[]')
    if (!Array.isArray(v)) return []
    return v
      .filter(x => x && typeof x.name === 'string')
      .map(x => ({ request_id: `sr-${row.id}-${x.name}`, name: x.name, reason: String(x.reason ?? ''), scope: typeof x.scope === 'string' ? x.scope : 'workspace' }))
  } catch {
    return []
  }
}

/** "NAME (reason)" per pending secret; names + reasons only (obj 718944). */
function parseNeedsSecretNames(raw: string | null): string[] {
  if (!raw) return []
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? v.filter(x => x && typeof x.name === 'string').map(x => (x.reason ? `${x.name} (${x.reason})` : x.name)) : []
  } catch {
    return []
  }
}

export function buildAttention(
  db: Database.Database,
  user: ControlUser,
  opts: { workspace?: string; staleMin?: number; limit?: number; now?: Date },
): AttentionBrief {
  const staleMin = opts.staleMin ?? ATTENTION_DEFAULT_STALE_MIN
  const limit = Math.min(Math.max(opts.limit ?? ATTENTION_DEFAULT_LIMIT, 1), ATTENTION_MAX_LIMIT)
  const now = opts.now ?? new Date()
  const counts: Record<AttentionKind, number> = { needs_secret: 0, failed_review: 0, blocked: 0, review: 0, stuck: 0 }
  const empty: AttentionBrief = {
    as_of: now.toISOString(),
    workspace: opts.workspace ?? null,
    counts,
    items: [],
    truncated: false,
  }

  const vis = visibilityClause(user, opts.workspace)
  if (!vis) return empty

  // idle_min: minutes since the last observed activity. last_activity_at is the
  // heartbeat the poller stamps; updated_at is the fallback for rows that predate it.
  // last_note: the newest milestone/blocker on the card. last_session_summary is
  // empty on most parked cards (14 of 171 on the live board, 2026-10-04), while
  // the milestone says why it parked ("auto_merge_decision: PR is behind — rebase").
  const rows = db
    .prepare(
      `SELECT o.id, o.title, o.status, o.workspace, o.has_blockers, o.ai_review_verdict, o.needs_secret,
              substr(o.ai_review_findings, 1, 600) AS ai_review_findings,
              substr(o.last_session_summary, 1, 600) AS last_session_summary,
              (SELECT substr(a.title || COALESCE(': ' || a.detail, ''), 1, 300)
                 FROM activity_log a
                WHERE a.objective_id = o.id AND a.event_type IN ('milestone', 'blocker')
                ORDER BY a.id DESC LIMIT 1) AS last_note,
              CAST((julianday(?) - julianday(COALESCE(o.last_activity_at, o.updated_at))) * 1440 AS INTEGER) AS idle_min
         FROM objectives o
        WHERE o.status IN ('review', 'working') AND o.deleted_at IS NULL AND ${vis.sql}
        ORDER BY o.updated_at DESC`,
    )
    .all(now.toISOString().replace('T', ' ').slice(0, 19), ...vis.params) as AttentionRow[]

  const classified: AttentionItem[] = []
  for (const row of rows) {
    const c = classify(row, staleMin)
    if (!c) continue
    counts[c.kind]++
    const item: AttentionItem = {
      id: row.id,
      kind: c.kind,
      title: oneLine(row.title, 70) ?? '',
      why: oneLine(c.why, WHY_MAX) ?? '',
      age_min: Math.max(row.idle_min, 0),
    }
    if (!opts.workspace) item.ws = row.workspace
    if (c.kind === 'needs_secret') item.secret_requests = secretRequestsOf(row)
    classified.push(item)
  }
  classified.sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind))

  return {
    ...empty,
    counts,
    items: classified.slice(0, limit),
    truncated: classified.length > limit,
  }
}
