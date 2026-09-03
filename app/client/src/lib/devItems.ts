/* ─────────────────────────────────────────────────────────────────────────
   Universal Development — typed client for the LOCKED admin API contract.

   Every function here is a 1:1 binding of one endpoint in
   `second-brain/workspaces/operator/projects/universal-development-api.md`
   (§5, routes A1–A16). Request params, response envelopes and field names are
   the contract's verbatim shapes — this file is written contract-first and
   makes ZERO server-side assumptions beyond that document.

   ── Fixture fallback (TEMPORARY, trivially removable) ───────────────────────
   The backend router (`app/server/src/routes/dev-items.ts`) is being built in
   parallel (obj 704214). Until it is mounted, `/api/dev-items*` 404s. Every
   call below therefore runs through `viaFixture()`, which:
     • calls the real endpoint first, always;
     • falls back to `./devItemsFixture` ONLY on a 404 (route not mounted);
     • flips `fixtureMode` so the page can render a loud banner.
   To remove the fixture layer once the routes land: delete
   `src/lib/devItemsFixture.ts`, delete `viaFixture` + the `fixtureMode`
   helpers below, and unwrap each call to its bare `api.*` expression.
   Nothing else in the UI touches the fixture.
   ───────────────────────────────────────────────────────────────────────── */
import { api } from './api'
import * as fixture from './devItemsFixture'

/* ── Enums (schema §2.1 / api.md §0) ───────────────────────────────────── */
export type DevType = 'bug' | 'feature' | 'improvement' | 'chore'
export type DevStatus =
  | 'new' | 'triaged' | 'planned' | 'in_progress' | 'shipped' | 'declined' | 'duplicate'
export type DevSeverity = 'blocker' | 'high' | 'medium' | 'low'
export type SubmittedVia = 'widget' | 'admin' | 'api' | 'import'
export type NoteVisibility = 'internal' | 'submitter'
export type PrState = 'open' | 'merged' | 'closed'
export type ChangelogStatus = 'draft' | 'published' | 'skipped'
export type ChangelogCategory = 'feature' | 'fix' | 'improvement' | 'infra'

export const DEV_TYPES: DevType[] = ['bug', 'feature', 'improvement', 'chore']
export const DEV_STATUSES: DevStatus[] = [
  'new', 'triaged', 'planned', 'in_progress', 'shipped', 'declined', 'duplicate',
]
export const DEV_SEVERITIES: DevSeverity[] = ['blocker', 'high', 'medium', 'low']

/* ── A1 row shape (api.md §5.1) ────────────────────────────────────────── */
export interface DevItemRow {
  id: number
  ref: string
  workspace: string
  workspace_label: string | null
  workspace_badge_color: string | null
  project: string | null
  type: DevType
  status: DevStatus
  severity: DevSeverity | null
  impact: number | null
  effort: number | null
  priority_rank: number | null
  area: string | null
  route: string | null
  title: string
  description: string
  submitter_label: string | null
  submitter_email: string | null
  submitted_via: SubmittedVia
  has_replay: boolean
  has_screenshot: boolean
  posthog_replay_url: string | null
  loom_url: string | null
  objective_id: number | null
  objective_status: string | null
  branch_name: string | null
  objective_pr_url: string | null
  changelog_status: ChangelogStatus | null
  note_count: number
  attachment_count: number
  triaged_at: string | null
  closed_at: string | null
  created_at: string
  updated_at: string
}

export interface DevListResponse {
  data: DevItemRow[]
  page: { next_cursor: string | null; has_more: boolean }
  facets: {
    status: Partial<Record<DevStatus, number>>
    workspace: Record<string, number>
    type: Partial<Record<DevType, number>>
  }
  meta: { total_matching: number; filters_applied: number }
}

/* ── A2 detail shape (api.md §5.2) ─────────────────────────────────────── */
export interface DevNote {
  id: number
  author_user_id: number | null
  author_label: string
  body: string
  visibility: NoteVisibility
  created_at: string
}
export interface DevAttachment {
  id: number
  storage_provider: 'local' | 'supabase'
  storage_bucket: string | null
  storage_path: string
  file_name: string
  mime_type: string
  size_bytes: number
  uploaded_by: string
  signed_url: string | null
  signed_url_expires_at: string | null
  created_at?: string
}
export interface DevPr {
  repo: string
  pr_number: number
  pr_url: string
  state: PrState
  via: 'objective' | 'manual' | 'pr_body'
}
export interface DevItemFull extends DevItemRow {
  steps_to_repro: string | null
  console_log: string | null
  route_history: { path: string; ts: string }[]
  client_meta: Record<string, unknown>
  legacy_ref: Record<string, unknown>
  source_system: string | null
  source_table: string | null
  source_id: string | null
  duplicate_of_id: number | null
  loom_transcript: string | null
  screenshot_path: string | null
  submitter_platform_user_id: string | null
  triaged_by: string | null
  promoted_at: string | null
  changelog_entry_id: number | null
  deleted_at: string | null
}
export interface DevItemDetail {
  item: DevItemFull
  workspace: { slug: string; name: string; short_label: string; badge_color: string } | null
  objective: {
    id: number
    status: string
    branch_name: string | null
    title: string
    completion_goal?: string | null
    ai_review_verdict?: string | null
  } | null
  notes: DevNote[]
  attachments: DevAttachment[]
  prs: DevPr[]
  changelog: {
    id: number
    status: ChangelogStatus
    headline: string
    category: ChangelogCategory | null
    published_at: string | null
    notified_at: string | null
  } | null
}

/* ── A12 changelog row (api.md §5.12) ──────────────────────────────────── */
export interface ChangelogEntryRow {
  id: number
  workspace: string | null
  repo: string | null
  pr_number: number | null
  title_eng: string | null
  headline: string
  body_stakeholder: string | null
  how_to: string | null
  category: ChangelogCategory | null
  status: ChangelogStatus
  author: string | null
  dev_item_id: number | null
  objective_id: number | null
  merged_at: string | null
  published_at: string | null
  notified_at: string | null
}

/* ── Filter model (api.md §5.1 query params, PRD §5.4) ─────────────────── */
export interface DevItemQuery {
  workspace?: string[]
  project?: string[]
  type?: DevType[]
  status?: DevStatus[]
  severity?: string[]
  area?: string
  route?: string
  has_replay?: 'yes' | 'no'
  has_screenshot?: 'yes' | 'no'
  untriaged?: boolean
  unassigned?: boolean
  submitted_via?: SubmittedVia[]
  q?: string
  date_from?: string
  date_to?: string
  sort?: 'rank' | 'newest' | 'oldest' | 'severity' | 'score' | 'updated'
  cursor?: string
  limit?: number
}

export function toQueryString(qy: DevItemQuery): string {
  const p = new URLSearchParams()
  const push = (k: string, v: string[] | undefined) => v?.forEach(x => p.append(k, x))
  push('workspace', qy.workspace)
  push('project', qy.project)
  push('type', qy.type)
  push('status', qy.status)
  push('severity', qy.severity)
  push('submitted_via', qy.submitted_via)
  if (qy.area) p.set('area', qy.area)
  if (qy.route) p.set('route', qy.route)
  if (qy.has_replay) p.set('has_replay', qy.has_replay)
  if (qy.has_screenshot) p.set('has_screenshot', qy.has_screenshot)
  if (qy.untriaged) p.set('untriaged', '1')
  if (qy.unassigned) p.set('unassigned', '1')
  if (qy.q) p.set('q', qy.q)
  if (qy.date_from) p.set('date_from', qy.date_from)
  if (qy.date_to) p.set('date_to', qy.date_to)
  if (qy.sort) p.set('sort', qy.sort)
  if (qy.cursor) p.set('cursor', qy.cursor)
  if (qy.limit) p.set('limit', String(qy.limit))
  const s = p.toString()
  return s ? `?${s}` : ''
}

/* ── Fixture fallback plumbing (DELETE WITH THE FIXTURE) ───────────────── */
let fixtureMode = false
const fixtureListeners = new Set<(on: boolean) => void>()
export function isFixtureMode() { return fixtureMode }
export function onFixtureMode(fn: (on: boolean) => void) {
  fixtureListeners.add(fn)
  return () => { fixtureListeners.delete(fn) }
}
function setFixtureMode() {
  if (fixtureMode) return
  fixtureMode = true
  fixtureListeners.forEach(fn => fn(true))
}
function isRouteMissing(err: unknown): boolean {
  const status = (err as { status?: number } | null)?.status
  if (status === 404 || status === 501) return true
  // CC's SPA catch-all (`app.get('*')` in server/src/index.ts) answers an
  // UNMOUNTED /api route with 200 text/html, so a missing router surfaces as a
  // JSON parse failure rather than a 404. Both mean "not mounted yet".
  return err instanceof SyntaxError
}
async function viaFixture<T>(live: () => Promise<T>, fake: () => Promise<T> | T): Promise<T> {
  if (fixtureMode) return fake()
  try {
    return await live()
  } catch (err) {
    if (!isRouteMissing(err)) throw err
    setFixtureMode()
    return fake()
  }
}

/* ── A1 ── GET /api/dev-items ──────────────────────────────────────────── */
export function listDevItems(qy: DevItemQuery): Promise<DevListResponse> {
  return viaFixture(
    () => api.get<DevListResponse>(`/dev-items${toQueryString(qy)}`),
    () => fixture.listDevItems(qy),
  )
}

/* ── A2 ── GET /api/dev-items/:id ──────────────────────────────────────── */
export function getDevItem(id: number): Promise<{ data: DevItemDetail }> {
  return viaFixture(
    () => api.get<{ data: DevItemDetail }>(`/dev-items/${id}`),
    () => fixture.getDevItem(id),
  )
}

/* ── A3 ── POST /api/dev-items ─────────────────────────────────────────── */
export interface CreateDevItemBody {
  workspace: string
  project?: string | null
  type?: DevType
  title: string
  description?: string
  steps_to_repro?: string
  severity?: DevSeverity | null
  impact?: number | null
  effort?: number | null
  area?: string | null
  route?: string | null
  loom_url?: string | null
  status?: DevStatus
}
export function createDevItem(body: CreateDevItemBody): Promise<{ data: DevItemRow }> {
  return viaFixture(
    () => api.post<{ data: DevItemRow }>('/dev-items', body),
    () => fixture.createDevItem(body),
  )
}

/* ── A4 ── PATCH /api/dev-items/:id ────────────────────────────────────── */
export type PatchDevItemBody = Partial<{
  type: DevType
  title: string
  description: string
  steps_to_repro: string
  status: DevStatus
  severity: DevSeverity | null
  impact: number | null
  effort: number | null
  area: string | null
  route: string | null
  project: string | null
  duplicate_of_id: number | null
  loom_url: string | null
  loom_transcript: string | null
  submitter_label: string | null
  changelog_entry_id: number | null
}>
export function patchDevItem(id: number, body: PatchDevItemBody): Promise<{ data: DevItemRow }> {
  return viaFixture(
    () => api.patch<{ data: DevItemRow }>(`/dev-items/${id}`, body),
    () => fixture.patchDevItem(id, body),
  )
}

/* ── A5 ── POST /api/dev-items/:id/triage ──────────────────────────────── */
export interface TriageBody {
  severity?: DevSeverity | null
  impact?: number | null
  effort?: number | null
  area?: string | null
  status?: DevStatus
  note?: string
  suggest_rank?: boolean
}
export function triageDevItem(id: number, body: TriageBody): Promise<{ data: DevItemRow }> {
  return viaFixture(
    () => api.post<{ data: DevItemRow }>(`/dev-items/${id}/triage`, body),
    () => fixture.triageDevItem(id, body),
  )
}

/* ── A6 ── POST /api/dev-items/:id/promote ─────────────────────────────── */
export interface PromoteResponse {
  data: {
    dev_item: { id: number; status: DevStatus; objective_id: number; promoted_at: string }
    objective: { id: number; workspace: string; project: string | null; category: string; type: string; title: string; status: string }
  }
  already_promoted: boolean
}
export function promoteDevItem(
  id: number,
  body: { title?: string; completion_goal?: string; project?: string; type?: DevType; priority?: string } = {},
): Promise<PromoteResponse> {
  return viaFixture(
    () => api.post<PromoteResponse>(`/dev-items/${id}/promote`, body),
    () => fixture.promoteDevItem(id, body),
  )
}

/* ── A7 ── POST /api/dev-items/:id/rank ────────────────────────────────── */
export function rankDevItem(
  id: number,
  body: { before_id?: number; after_id?: number },
): Promise<{ data: { id: number; priority_rank: number }; renormalized: boolean }> {
  return viaFixture(
    () => api.post<{ data: { id: number; priority_rank: number }; renormalized: boolean }>(`/dev-items/${id}/rank`, body),
    () => fixture.rankDevItem(id, body),
  )
}

/* ── A8 ── POST /api/dev-items/:id/attach-pr ───────────────────────────── */
export function attachPr(
  id: number,
  body: { repo: string; pr_number?: number; pr_url?: string; state?: PrState },
): Promise<{ data: DevPr; note?: string }> {
  return viaFixture(
    () => api.post<{ data: DevPr; note?: string }>(`/dev-items/${id}/attach-pr`, body),
    () => fixture.attachPr(id, body),
  )
}

/* ── A9 ── POST /api/dev-items/:id/notes ───────────────────────────────── */
export function addDevNote(
  id: number,
  body: { body: string; visibility?: NoteVisibility; author_label?: string },
): Promise<{ data: DevNote }> {
  return viaFixture(
    () => api.post<{ data: DevNote }>(`/dev-items/${id}/notes`, body),
    () => fixture.addDevNote(id, body),
  )
}

/* ── A10 ── DELETE /api/dev-items/:id ──────────────────────────────────── */
export function deleteDevItem(id: number): Promise<void> {
  return viaFixture(
    () => api.del<void>(`/dev-items/${id}`),
    () => fixture.deleteDevItem(id),
  )
}

/* ── A11 ── POST /api/dev-items/bulk ───────────────────────────────────── */
export type BulkOp =
  | { op: 'set_status'; params: { status: DevStatus } }
  | { op: 'set_severity'; params: { severity: DevSeverity } }
  | { op: 'set_area'; params: { area: string } }
  | { op: 'set_project'; params: { project: string } }
  | { op: 'triage'; params: { severity?: DevSeverity; impact?: number; effort?: number; area?: string } }
  | { op: 'mark_duplicate'; params: { duplicate_of_id: number } }
  | { op: 'delete' }
  | { op: 'restore' }
export function bulkDevItems(
  ids: number[],
  op: BulkOp,
): Promise<{ data: { updated: number; ids: number[] } }> {
  const body = { ids, ...op }
  return viaFixture(
    () => api.post<{ data: { updated: number; ids: number[] } }>('/dev-items/bulk', body),
    () => fixture.bulkDevItems(ids, op),
  )
}

/* ── A12 ── GET /api/dev-changelog ─────────────────────────────────────── */
export function listChangelog(params: { workspace?: string[]; status?: ChangelogStatus[]; q?: string } = {}):
  Promise<{ data: ChangelogEntryRow[] }> {
  const p = new URLSearchParams()
  params.workspace?.forEach(w => p.append('workspace', w))
  params.status?.forEach(s => p.append('status', s))
  if (params.q) p.set('q', params.q)
  const qs = p.toString() ? `?${p.toString()}` : ''
  return viaFixture(
    () => api.get<{ data: ChangelogEntryRow[] }>(`/dev-changelog${qs}`),
    () => fixture.listChangelog(params),
  )
}

/* ── A13 ── PATCH /api/dev-changelog/:id ───────────────────────────────── */
export function patchChangelog(
  id: number,
  body: Partial<Pick<ChangelogEntryRow, 'headline' | 'body_stakeholder' | 'how_to' | 'category' | 'workspace' | 'dev_item_id' | 'title_eng'>>,
): Promise<{ data: ChangelogEntryRow }> {
  return viaFixture(
    () => api.patch<{ data: ChangelogEntryRow }>(`/dev-changelog/${id}`, body),
    () => fixture.patchChangelog(id, body),
  )
}

/* ── A14 ── POST /api/dev-changelog/:id/publish ────────────────────────── */
export function publishChangelog(
  id: number,
  action: 'publish' | 'unpublish' | 'skip',
): Promise<{ data: ChangelogEntryRow }> {
  return viaFixture(
    () => api.post<{ data: ChangelogEntryRow }>(`/dev-changelog/${id}/publish`, { action }),
    () => fixture.publishChangelog(id, action),
  )
}

/* ── A15 ── POST /api/dev-changelog/:id/retranslate ────────────────────── */
export function retranslateChangelog(id: number): Promise<{ data: ChangelogEntryRow }> {
  return viaFixture(
    () => api.post<{ data: ChangelogEntryRow }>(`/dev-changelog/${id}/retranslate`, { force: true }),
    () => fixture.retranslateChangelog(id),
  )
}

/* ── A16 ── POST /api/dev-changelog/:id/notify ─────────────────────────── */
export function notifyChangelog(id: number): Promise<{ data: ChangelogEntryRow; already_notified?: boolean }> {
  return viaFixture(
    () => api.post<{ data: ChangelogEntryRow; already_notified?: boolean }>(`/dev-changelog/${id}/notify`, { channel: 'email', dry_run: false }),
    () => fixture.notifyChangelog(id),
  )
}

/* ── Presentation helpers (pure, no I/O) ───────────────────────────────── */
export const STATUS_LABEL: Record<DevStatus, string> = {
  new: 'New', triaged: 'Triaged', planned: 'Planned', in_progress: 'In progress',
  shipped: 'Shipped', declined: 'Declined', duplicate: 'Duplicate',
}
export const TYPE_LABEL: Record<DevType, string> = {
  bug: 'Bug', feature: 'Feature', improvement: 'Improvement', chore: 'Chore',
}
export function scoreOf(item: { impact: number | null; effort: number | null }): number | null {
  if (!item.impact || !item.effort) return null
  return Math.round((item.impact * 3.0) / item.effort * 100) / 100
}
/**
 * CC's `workspaces.badge_color` is historically a Tailwind class string
 * ("bg-green-500/20 text-green-400"), while api.md §5.1's example shows a hex
 * ("#7c3aed"). Treat anything that is not a hex literal as "no colour" so a
 * class string never lands in a CSS colour slot.
 */
export function hexColor(c: string | null | undefined): string | null {
  return c && /^#[0-9a-f]{3,8}$/i.test(c) ? c : null
}

export function relativeTime(iso: string | null): string {
  if (!iso) return '—'
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return '—'
  const secs = Math.max(1, Math.round((Date.now() - then) / 1000))
  if (secs < 60) return `${secs}s ago`
  const mins = Math.round(secs / 60)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 48) return `${hrs}h ago`
  const days = Math.round(hrs / 24)
  if (days < 60) return `${days}d ago`
  return new Date(iso).toLocaleDateString()
}
