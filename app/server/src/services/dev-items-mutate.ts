/**
 * Universal Development writes, PR linkage, and ingest idempotency —
 * extracted from dev-items.ts (behavior frozen).
 *
 * Listing reads stay in dev-items-query.ts.
 */
import { parseObjectiveIdCandidates } from './external-remediation-classify.js'
import {
  CLOSED_STATUSES,
  db,
  devRef,
  nowIso,
  type DevItemRow,
  type DevItemStatus,
  type DevItemSeverity,
  type DevItemType,
  type DevNoteVisibility,
  type DevPrLinkSource,
  type DevPrState,
  type DevSubmittedVia,
} from './dev-items-schema.js'

// ── Writes ──────────────────────────────────────────────────────────────────

export interface CreateDevItemInput {
  workspace: string
  project?: string | null
  type?: DevItemType
  title: string
  description?: string
  steps_to_repro?: string | null
  status?: DevItemStatus
  severity?: DevItemSeverity | null
  impact?: number | null
  effort?: number | null
  area?: string | null
  route?: string | null
  loom_url?: string | null
  loom_transcript?: string | null
  submitter_platform_user_id?: string | null
  submitter_email?: string | null
  submitter_label?: string | null
  submitted_via?: DevSubmittedVia
  posthog_session_id?: string | null
  posthog_replay_url?: string | null
  console_log?: string | null
  route_history?: unknown[]
  client_meta?: Record<string, unknown>
  screenshot_path?: string | null
  source_system?: string
  source_table?: string | null
  source_id?: string | null
  legacy_ref?: Record<string, unknown>
  triaged_by?: string | null
  triaged_at?: string | null
}

export function createDevItem(input: CreateDevItemInput): DevItemRow {
  const info = db()
    .prepare(
      `INSERT INTO dev_items (
         workspace, project, type, title, description, steps_to_repro,
         status, severity, impact, effort, area, route,
         loom_url, loom_transcript,
         submitter_platform_user_id, submitter_email, submitter_label, submitted_via,
         posthog_session_id, posthog_replay_url, console_log, route_history, client_meta,
         screenshot_path, source_system, source_table, source_id, legacy_ref,
         triaged_by, triaged_at
       ) VALUES (?,?,?,?,?,?, ?,?,?,?,?,?, ?,?, ?,?,?,?, ?,?,?,?,?, ?,?,?,?,?, ?,?)`,
    )
    .run(
      input.workspace,
      input.project ?? null,
      input.type ?? 'bug',
      input.title,
      input.description ?? '',
      input.steps_to_repro ?? null,
      input.status ?? 'new',
      input.severity ?? null,
      input.impact ?? null,
      input.effort ?? null,
      input.area ?? null,
      input.route ?? null,
      input.loom_url ?? null,
      input.loom_transcript ?? null,
      input.submitter_platform_user_id ?? null,
      input.submitter_email ?? null,
      input.submitter_label ?? null,
      input.submitted_via ?? 'widget',
      input.posthog_session_id ?? null,
      input.posthog_replay_url ?? null,
      input.console_log ?? null,
      JSON.stringify(input.route_history ?? []),
      JSON.stringify(input.client_meta ?? {}),
      input.screenshot_path ?? null,
      input.source_system ?? 'native',
      input.source_table ?? null,
      input.source_id ?? null,
      JSON.stringify(input.legacy_ref ?? {}),
      input.triaged_by ?? null,
      input.triaged_at ?? null,
    )
  return db().prepare('SELECT * FROM dev_items WHERE id = ?').get(Number(info.lastInsertRowid)) as DevItemRow
}

/** Columns A4 may patch. `workspace` is deliberately absent — re-homing an item
 *  across platforms would orphan its objective, PRs and changelog entry. */
export const PATCHABLE_FIELDS = [
  'type',
  'title',
  'description',
  'steps_to_repro',
  'status',
  'severity',
  'impact',
  'effort',
  'area',
  'route',
  'project',
  'duplicate_of_id',
  'loom_url',
  'loom_transcript',
  'submitter_label',
  'changelog_entry_id',
] as const

/**
 * JSON-merge-patch semantics (api.md §5.4): an explicit `null` clears a field,
 * an ABSENT key leaves it untouched. This is not PUT.
 *
 * Also owns the `closed_at` invariant: moving INTO shipped/declined/duplicate
 * stamps it when NULL; moving OUT of them clears it.
 */
export function updateDevItem(id: number, patch: Record<string, unknown>): DevItemRow | null {
  const existing = db().prepare('SELECT * FROM dev_items WHERE id = ?').get(id) as DevItemRow | undefined
  if (!existing) return null

  const sets: string[] = []
  const params: unknown[] = []
  for (const field of PATCHABLE_FIELDS) {
    if (!(field in patch)) continue
    sets.push(`${field} = ?`)
    params.push(patch[field] ?? null)
  }

  if ('status' in patch) {
    const next = patch.status as DevItemStatus
    const wasClosed = CLOSED_STATUSES.has(existing.status)
    const isClosed = CLOSED_STATUSES.has(next)
    if (isClosed && !existing.closed_at) {
      sets.push('closed_at = ?')
      params.push(nowIso())
    } else if (!isClosed && wasClosed) {
      sets.push('closed_at = NULL')
    }
  }

  if (!sets.length) return existing
  sets.push("updated_at = datetime('now')")
  db().prepare(`UPDATE dev_items SET ${sets.join(', ')} WHERE id = ?`).run(...params, id)
  return db().prepare('SELECT * FROM dev_items WHERE id = ?').get(id) as DevItemRow
}

export interface TriageInput {
  severity?: DevItemSeverity
  impact?: number
  effort?: number
  area?: string
  status?: DevItemStatus
  suggest_rank?: boolean
}

/**
 * A5 triage. `triaged_by`/`triaged_at` are stamped ALWAYS, even on a re-triage:
 * the board needs "last triaged", not "first triaged".
 *
 * Status only advances `new` -> `triaged`. It never downgrades an item that is
 * already planned / in_progress / closed — a re-triage of shipped work must not
 * reopen it.
 */
export function triageDevItem(id: number, input: TriageInput, triagedBy: string): DevItemRow | null {
  const existing = db().prepare('SELECT * FROM dev_items WHERE id = ?').get(id) as DevItemRow | undefined
  if (!existing) return null

  const sets: string[] = []
  const params: unknown[] = []
  const setIf = (key: keyof TriageInput, column: string) => {
    if (input[key] === undefined) return
    sets.push(`${column} = ?`)
    params.push(input[key])
  }
  setIf('severity', 'severity')
  setIf('impact', 'impact')
  setIf('effort', 'effort')
  setIf('area', 'area')

  sets.push('triaged_by = ?', "triaged_at = datetime('now')")
  params.push(triagedBy)

  const nextStatus = input.status ?? (existing.status === 'new' ? 'triaged' : undefined)
  if (nextStatus) {
    sets.push('status = ?')
    params.push(nextStatus)
    if (CLOSED_STATUSES.has(nextStatus) && !existing.closed_at) {
      sets.push('closed_at = ?')
      params.push(nowIso())
    }
  }

  // Rank suggestion: schema §4 pins the formula `(impact * 3.0) / effort` and
  // forbids re-deciding it. We store the resulting ABSOLUTE value, not the
  // formula, and only when the item is still unranked.
  const impact = input.impact ?? existing.impact
  const effort = input.effort ?? existing.effort
  if (input.suggest_rank && existing.priority_rank === null && impact && effort) {
    sets.push('priority_rank = ?')
    params.push((impact * 3.0) / effort)
  }

  sets.push("updated_at = datetime('now')")
  db().prepare(`UPDATE dev_items SET ${sets.join(', ')} WHERE id = ?`).run(...params, id)
  return db().prepare('SELECT * FROM dev_items WHERE id = ?').get(id) as DevItemRow
}

export interface PromoteInput {
  title?: string
  completion_goal?: string
  project?: string
  type?: DevItemType
}

export interface PromoteResult {
  item: DevItemRow
  objective: { id: number; workspace: string; project: string | null; category: string; type: string; title: string; status: string }
  alreadyPromoted: boolean
}

/**
 * A6 promote — turn a triaged item into a real unit of work.
 *
 * Idempotent by design: if `objective_id` is already set this returns the
 * existing objective and changes nothing. Double-clicking Promote is not an
 * error, so it is a 200, never a 409.
 *
 * It writes the `objectives` row IN PROCESS, in the SAME transaction as the
 * item update — deliberately NOT via `POST /api/internal/objectives`
 * (routes/internal.ts:186), which would make the CC server authenticate to
 * itself with OBJECTIVES_API_TOKEN and split the write across two transactions.
 */
export function promoteDevItem(id: number, input: PromoteInput, agentContext = 'cto'): PromoteResult | null {
  const item = db().prepare('SELECT * FROM dev_items WHERE id = ? AND deleted_at IS NULL').get(id) as
    | DevItemRow
    | undefined
  if (!item) return null

  if (item.objective_id) {
    const existing = db()
      .prepare('SELECT id, workspace, project, category, type, title, status FROM objectives WHERE id = ?')
      .get(item.objective_id) as PromoteResult['objective'] | undefined
    if (existing) return { item, objective: existing, alreadyPromoted: true }
    // A dangling objective_id: the objective was hard-deleted. Fall through and
    // cut a fresh one rather than leaving the item permanently unpromotable.
  }

  // Compose a description a worker agent can act on WITHOUT opening CC: the
  // report, the repro, and a provenance footer carrying the DEV ref, the route
  // and the session replay.
  const parts = [item.description || '(no description)']
  if (item.steps_to_repro) parts.push(`## Steps to reproduce\n\n${item.steps_to_repro}`)
  const footer = [`Promoted from ${devRef(item.id)} (${item.workspace} Development board).`]
  if (item.route) footer.push(`Route: ${item.route}`)
  if (item.posthog_replay_url) footer.push(`Session replay: ${item.posthog_replay_url}`)
  if (item.submitter_label) footer.push(`Reported by: ${item.submitter_label}`)
  parts.push(`---\n\n${footer.join('\n')}`)

  const title = input.title ?? item.title
  const project = input.project ?? item.project
  const type = input.type ?? item.type
  const completionGoal =
    input.completion_goal ??
    `${devRef(item.id)} is verified fixed${item.route ? ` on ${item.route}` : ''} and the item is shipped.`

  const tx = db().transaction(() => {
    const info = db()
      .prepare(
        `INSERT INTO objectives (title, description, agent_context, workspace, project, category, completion_goal, type, origin)
         VALUES (?, ?, ?, ?, ?, 'development', ?, ?, 'manual')`,
      )
      .run(title, parts.join('\n\n'), agentContext, item.workspace, project, completionGoal, type)
    const objectiveId = Number(info.lastInsertRowid)
    db()
      .prepare(
        `UPDATE dev_items
            SET objective_id = ?, promoted_at = datetime('now'),
                status = CASE WHEN status IN ('new','triaged') THEN 'planned' ELSE status END,
                updated_at = datetime('now')
          WHERE id = ?`,
      )
      .run(objectiveId, id)
    return objectiveId
  })

  const objectiveId = tx()
  return {
    item: db().prepare('SELECT * FROM dev_items WHERE id = ?').get(id) as DevItemRow,
    objective: db()
      .prepare('SELECT id, workspace, project, category, type, title, status FROM objectives WHERE id = ?')
      .get(objectiveId) as PromoteResult['objective'],
    alreadyPromoted: false,
  }
}

export interface RankResult {
  id: number
  priority_rank: number
  renormalized: boolean
}

/**
 * A7 drag-to-reorder, implementing schema §4 exactly.
 *
 * The SERVER computes the value (never the client) so two concurrent drags
 * cannot both write the same rank. Midpoint insertion means one reorder is one
 * UPDATE rather than an N-row renumber — which is precisely why D3 resolved
 * `priority_rank` to REAL rather than example2's INTEGER.
 */
export function rankDevItem(
  id: number,
  beforeId: number | null,
  afterId: number | null,
): RankResult | { error: string } | null {
  const item = db().prepare('SELECT * FROM dev_items WHERE id = ? AND deleted_at IS NULL').get(id) as
    | DevItemRow
    | undefined
  if (!item) return null
  if (beforeId === null && afterId === null) return { error: 'before_id or after_id is required' }

  const load = (nid: number | null): DevItemRow | null =>
    nid === null
      ? null
      : ((db().prepare('SELECT * FROM dev_items WHERE id = ? AND deleted_at IS NULL').get(nid) as DevItemRow) ??
        null)

  const before = load(beforeId)
  const after = load(afterId)
  if (beforeId !== null && !before) return { error: 'before_id not found' }
  if (afterId !== null && !after) return { error: 'after_id not found' }
  for (const n of [before, after]) {
    if (n && n.workspace !== item.workspace) return { error: 'neighbours must be in the same workspace' }
  }

  // A neighbour with no rank yet cannot anchor a midpoint. Seed it from the
  // list extremes so the drag still lands somewhere deterministic.
  const extremes = db()
    .prepare('SELECT MIN(priority_rank) AS lo, MAX(priority_rank) AS hi FROM dev_items WHERE workspace = ? AND deleted_at IS NULL')
    .get(item.workspace) as { lo: number | null; hi: number | null }
  const lo = extremes.lo ?? 0
  const hi = extremes.hi ?? 0

  const rankOf = (n: DevItemRow | null, fallback: number): number => n?.priority_rank ?? fallback

  let renormalized = false
  let next: number
  if (before && after) {
    let a = rankOf(before, lo - 1)
    let b = rankOf(after, hi + 1)
    if (Math.abs(a - b) < 1e-9) {
      // Precision exhausted between the two neighbours. Renormalise the whole
      // scoped list to ROW_NUMBER()*1000 and retry the midpoint once. Expected
      // roughly never, which is why no nightly job is required (schema §4).
      renormalizeWorkspaceRanks(item.workspace)
      renormalized = true
      a = (db().prepare('SELECT priority_rank FROM dev_items WHERE id = ?').get(before.id) as { priority_rank: number }).priority_rank
      b = (db().prepare('SELECT priority_rank FROM dev_items WHERE id = ?').get(after.id) as { priority_rank: number }).priority_rank
    }
    next = (a + b) / 2.0
  } else if (before) {
    next = rankOf(before, hi) + 1.0 // dropped at the bottom
  } else {
    next = rankOf(after, lo) - 1.0 // dropped at the top
  }

  db().prepare("UPDATE dev_items SET priority_rank = ?, updated_at = datetime('now') WHERE id = ?").run(next, id)
  return { id, priority_rank: next, renormalized }
}

/** Rewrite the whole workspace list to ROW_NUMBER()*1000.0, preserving order. */
export function renormalizeWorkspaceRanks(workspace: string): void {
  const rows = db()
    .prepare(
      `SELECT id FROM dev_items WHERE workspace = ? AND deleted_at IS NULL
        ORDER BY priority_rank IS NULL, priority_rank ASC, created_at DESC, id DESC`,
    )
    .all(workspace) as Array<{ id: number }>
  const update = db().prepare('UPDATE dev_items SET priority_rank = ? WHERE id = ?')
  db().transaction(() => {
    rows.forEach((r, i) => update.run((i + 1) * 1000.0, r.id))
  })()
}

export function addNote(input: {
  devItemId: number
  authorUserId?: number | null
  authorLabel?: string | null
  body: string
  visibility?: DevNoteVisibility
}) {
  const info = db()
    .prepare(
      `INSERT INTO dev_item_notes (dev_item_id, author_user_id, author_label, body, visibility)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      input.devItemId,
      input.authorUserId ?? null,
      input.authorLabel ?? null,
      input.body,
      input.visibility ?? 'internal',
    )
  return db().prepare('SELECT * FROM dev_item_notes WHERE id = ?').get(Number(info.lastInsertRowid))
}

export function addAttachment(input: {
  devItemId: number
  storageProvider: 'local' | 'supabase'
  storageBucket?: string | null
  storagePath: string
  fileName?: string | null
  mimeType?: string | null
  sizeBytes?: number | null
  uploadedBy?: string | null
  isScreenshot?: boolean
}) {
  const info = db()
    .prepare(
      `INSERT INTO dev_item_attachments
         (dev_item_id, storage_provider, storage_bucket, storage_path, file_name, mime_type, size_bytes, uploaded_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.devItemId,
      input.storageProvider,
      input.storageBucket ?? null,
      input.storagePath,
      input.fileName ?? null,
      input.mimeType ?? null,
      input.sizeBytes ?? null,
      input.uploadedBy ?? null,
    )
  // `dev_items.screenshot_path` is stamped IN ADDITION to the attachment row so
  // the board's "Has screenshot" filter is a column test and not a join.
  if (input.isScreenshot) {
    db()
      .prepare("UPDATE dev_items SET screenshot_path = ?, updated_at = datetime('now') WHERE id = ?")
      .run(input.storagePath, input.devItemId)
  }
  return db().prepare('SELECT * FROM dev_item_attachments WHERE id = ?').get(Number(info.lastInsertRowid))
}

export function softDeleteDevItem(id: number, restore = false): boolean {
  const info = db()
    .prepare(
      restore
        ? "UPDATE dev_items SET deleted_at = NULL, updated_at = datetime('now') WHERE id = ?"
        : "UPDATE dev_items SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?",
    )
    .run(id)
  return info.changes > 0
}

// ── PR linkage + GitHub webhook helpers (api.md §6) ─────────────────────────

export interface DevRef {
  id: number
  verb: 'fixes' | 'refs'
}

/**
 * `Fixes DEV-<id>` and friends, parsed out of a PR body (api.md §6.1).
 *
 * Semantics that are easy to get wrong, so they are pinned here:
 *  - case-insensitive, global, multi-match: one PR may close three items;
 *  - `fixes|closes|resolves` are CLOSING verbs (they ship the item on merge);
 *    `refs|re` link only — they can advance to in_progress but never ship;
 *  - duplicate ids collapse, and `fixes` outranks a weaker `refs` for the same id;
 *  - bare `#123` is DELIBERATELY not parsed: that is GitHub's own issue syntax
 *    and would false-positive on essentially every PR body in the org.
 */
const DEV_REF_RE = /\b(fixes|closes|resolves|refs|re)\s*:?\s*dev[-\s_]?(\d{1,8})\b/gi

export function parseDevRefs(body: string | null | undefined): DevRef[] {
  const out = new Map<number, DevRef>()
  for (const m of (body ?? '').matchAll(DEV_REF_RE)) {
    const verb = /^(fixes|closes|resolves)$/i.test(m[1]) ? 'fixes' : 'refs'
    const id = Number(m[2])
    if (!out.has(id) || verb === 'fixes') out.set(id, { id, verb })
  }
  return [...out.values()]
}

/** Repo -> workspace/project resolution for the webhook (schema §3). */
export function resolveWorkspaceFromRepo(repoFullName: string): { workspace: string; project: string } | null {
  if (!repoFullName) return null
  const row = db()
    .prepare('SELECT workspace, name AS project FROM workspace_repos WHERE github = ?')
    .get(repoFullName) as { workspace: string; project: string } | undefined
  return row ?? null
}

/**
 * Branch-name fallback (api.md §6.4), used ONLY when the PR body carries no
 * explicit `DEV-<id>`. The branch yields an OBJECTIVE id, so resolution takes
 * one extra hop through `dev_items.objective_id`.
 *
 * Reuses `parseObjectiveIdCandidates` from external-remediation.ts rather than
 * copying its three regexes into a second file.
 */
export function resolveDevItemsFromBranch(branch: string | null | undefined): DevRef[] {
  const candidates = parseObjectiveIdCandidates(branch)
  if (!candidates.length) return []
  const out: DevRef[] = []
  const stmt = db().prepare('SELECT id FROM dev_items WHERE objective_id = ? AND deleted_at IS NULL')
  for (const objectiveId of candidates) {
    for (const row of stmt.all(objectiveId) as Array<{ id: number }>) {
      // Always 'refs': inferring "close that item" from a branch NAME is too
      // weak a signal to ship work. Shipping stays an explicit `Fixes DEV-<id>`.
      out.push({ id: row.id, verb: 'refs' })
    }
  }
  return out
}

/**
 * Upsert a dev_item <-> PR link. `synchronize` fires on EVERY push to the
 * branch, so this must be an upsert, never an insert.
 *
 * `state` transitions are MONOTONIC (open -> merged|closed, never back). That
 * is what makes out-of-order delivery safe: if `closed+merged` arrives before
 * `opened`, the row is created as merged and a late `synchronize` cannot
 * downgrade it (api.md §6.5).
 */
export function upsertDevItemPr(input: {
  devItemId: number
  repo: string
  prNumber: number
  prUrl?: string | null
  state?: DevPrState
  linkSource?: DevPrLinkSource
}): boolean {
  const exists = db().prepare('SELECT 1 FROM dev_items WHERE id = ? AND deleted_at IS NULL').get(input.devItemId)
  if (!exists) return false
  db()
    .prepare(
      `INSERT INTO dev_item_prs (dev_item_id, repo, pr_number, pr_url, state, link_source)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(dev_item_id, repo, pr_number) DO UPDATE SET
         pr_url = COALESCE(excluded.pr_url, dev_item_prs.pr_url),
         state = CASE WHEN dev_item_prs.state = 'open' THEN excluded.state ELSE dev_item_prs.state END,
         updated_at = datetime('now')`,
    )
    .run(
      input.devItemId,
      input.repo,
      input.prNumber,
      input.prUrl ?? null,
      input.state ?? 'open',
      input.linkSource ?? 'manual',
    )
  return true
}

/** Freshen every dev_item_prs row for a PR — the dev_item_prs analogue of what
 *  markPRStateByRepoAndNumber() already does for objective_prs. */
export function setDevItemPrState(repo: string, prNumber: number, state: DevPrState): number {
  const info = db()
    .prepare(
      `UPDATE dev_item_prs SET state = ?, updated_at = datetime('now')
        WHERE repo = ? AND pr_number = ? AND state = 'open'`,
    )
    .run(state, repo, prNumber)
  return info.changes
}

/**
 * Guarded transition to `in_progress`. Moves ONLY from new|triaged|planned, so
 * a reopened PR on a shipped item does not un-ship it and a late `synchronize`
 * cannot regress a closed item (api.md §6.2 / §6.5).
 */
export function advanceDevItemToInProgress(devItemId: number): boolean {
  const info = db()
    .prepare(
      `UPDATE dev_items SET status = 'in_progress', updated_at = datetime('now')
        WHERE id = ? AND deleted_at IS NULL AND status IN ('new','triaged','planned')`,
    )
    .run(devItemId)
  return info.changes > 0
}

/**
 * Ship an item on a merged closing ref.
 *
 * `closedAt` is the PR's `merged_at`, NEVER `datetime('now')` — a delivery that
 * GitHub replays a week later must still date the ship correctly. Idempotent:
 * an already-shipped item is a no-op and a non-NULL `closed_at` is never
 * overwritten.
 */
export function shipDevItem(
  devItemId: number,
  opts: { closedAt?: string | null; changelogEntryId?: number | null } = {},
): boolean {
  const info = db()
    .prepare(
      `UPDATE dev_items
          SET status = 'shipped',
              closed_at = COALESCE(closed_at, ?),
              changelog_entry_id = COALESCE(?, changelog_entry_id),
              updated_at = datetime('now')
        WHERE id = ? AND deleted_at IS NULL AND status != 'shipped'`,
    )
    .run(opts.closedAt ?? nowIso(), opts.changelogEntryId ?? null, devItemId)
  return info.changes > 0
}

// ── Ingest idempotency (api.md §3.6) ────────────────────────────────────────

export interface IdempotencyHit {
  status: number
  response: unknown
}

/**
 * Look up a previous response for (workspace, endpoint, key).
 *
 * Returns `'conflict'` when the key was seen with a DIFFERENT body — replaying
 * one key with new content is a client bug, not a retry, and must not silently
 * return the old row.
 */
export function lookupIdempotency(
  workspace: string,
  endpoint: string,
  key: string,
  bodySha256: string,
): IdempotencyHit | 'conflict' | null {
  const row = db()
    .prepare(
      `SELECT body_sha256, response_json, status FROM dev_ingest_idempotency
        WHERE workspace = ? AND endpoint = ? AND key = ?`,
    )
    .get(workspace, endpoint, key) as
    | { body_sha256: string; response_json: string; status: number }
    | undefined
  if (!row) return null
  if (row.body_sha256 !== bodySha256) return 'conflict'
  try {
    return { status: row.status, response: JSON.parse(row.response_json) }
  } catch {
    return null
  }
}

/** Record a SUCCESSFUL response. 5xx deliberately records nothing, so a retry
 *  after a server error is a clean fresh attempt (api.md §3.6). */
export function recordIdempotency(
  workspace: string,
  endpoint: string,
  key: string,
  bodySha256: string,
  status: number,
  response: unknown,
): void {
  if (status >= 500) return
  db()
    .prepare(
      `INSERT INTO dev_ingest_idempotency (key, workspace, endpoint, body_sha256, response_json, status)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(workspace, endpoint, key) DO NOTHING`,
    )
    .run(key, workspace, endpoint, bodySha256, JSON.stringify(response), status)
}

