/* ─────────────────────────────────────────────────────────────────────────
   ⚠ TEMPORARY FIXTURE LAYER — DELETE THIS FILE WHEN THE BACKEND LANDS ⚠

   This objective (704215) built the /development board CONTRACT-FIRST against
   `universal-development-api.md` while the admin routes (A1–A16) were being
   written in parallel by obj 704214. Until `/api/dev-items*` is mounted, those
   calls 404 and `lib/devItems.ts::viaFixture()` falls back here so the board is
   developable and demonstrable.

   Removal is two steps and touches no component:
     1. delete this file,
     2. in `lib/devItems.ts` delete `viaFixture` / `fixtureMode` / `isFixtureMode`
        / `onFixtureMode` and unwrap each call to its bare `api.*` expression,
        then delete the `<Alert>` in DevelopmentPage that reads `isFixtureMode()`.

   Every shape returned here is copied from the api.md response examples — it is
   a mirror of the contract, never an extension of it.
   ───────────────────────────────────────────────────────────────────────── */
import type {
  BulkOp, ChangelogEntryRow, ChangelogStatus, CreateDevItemBody, DevAttachment,
  DevItemDetail, DevItemFull, DevItemQuery, DevItemRow, DevListResponse, DevNote,
  DevPr, DevSeverity, DevStatus, DevType, NoteVisibility, PatchDevItemBody,
  PromoteResponse, TriageBody,
} from './devItems'

const WS = {
  'example-project': { name: 'Example Project', short: 'WS', color: '#7c3aed' },
  example2: { name: 'Example3', short: 'GF', color: '#1fb877' },
  example: { name: 'Example Growth', short: 'AX', color: '#5b9df0' },
} as const

const now = Date.now()
const ago = (mins: number) => new Date(now - mins * 60_000).toISOString()

interface Seed extends Partial<DevItemFull> {
  id: number
  workspace: keyof typeof WS
  title: string
  type: DevType
  status: DevStatus
}

const SEED: Seed[] = [
  {
    id: 4711, workspace: 'example-project', project: 'example-project-platform', type: 'bug',
    status: 'in_progress', severity: 'high', impact: 3, effort: 1, priority_rank: 12.5,
    area: 'checkout', route: '/checkout', title: 'Checkout total flickers to $0 on first paint',
    description: 'The order total renders as $0.00 for roughly 400ms before settling on the real amount. Consultants think the discount wiped the cart.',
    steps_to_repro: '1. Add any product to the cart\n2. Hit /checkout with a cold cache\n3. Watch the total in the summary rail',
    submitter_label: 'Dana R.', submitter_email: 'dana@weightsupply.co', submitted_via: 'widget',
    posthog_replay_url: 'https://us.posthog.com/replay/019243ab', screenshot_path: 'ws/4711/shot.png',
    objective_id: 703012, objective_status: 'working', branch_name: 'obj-703012-checkout-total',
    objective_pr_url: 'https://github.com/m1keluka/example-project-platform/pull/912',
    triaged_at: ago(2100), triaged_by: 'Mike', created_at: ago(2600), updated_at: ago(30),
  },
  {
    id: 4712, workspace: 'example-project', project: 'example-project-platform', type: 'bug',
    status: 'new', severity: 'blocker', route: '/admin/orders',
    title: 'Orders export returns an empty CSV for date ranges over 30 days',
    description: 'Anything wider than a month exports headers only. No error, no toast — it looks like there were no orders.',
    steps_to_repro: '1. /admin/orders\n2. Set range to 01 Jun → 31 Jul\n3. Export CSV',
    submitter_label: 'Colin P.', submitter_email: 'colin@weightsupply.co', submitted_via: 'widget',
    posthog_replay_url: 'https://us.posthog.com/replay/019243cd', created_at: ago(95), updated_at: ago(95),
  },
  {
    id: 4713, workspace: 'example2', project: 'example3-platform', type: 'bug',
    status: 'new', severity: 'medium', route: '/portal/leads',
    title: 'Leads map legend overlaps the zoom control on iPad',
    description: 'At 768px the legend sits on top of the +/- buttons so you cannot zoom out.',
    submitter_label: 'Trey Mccallie', submitted_via: 'widget', screenshot_path: 'gf/4713/ipad.png',
    created_at: ago(240), updated_at: ago(240),
  },
  {
    id: 4714, workspace: 'example2', project: 'example3-platform', type: 'feature',
    status: 'triaged', impact: 3, effort: 2, priority_rank: 20, area: 'campaigns',
    title: 'Let an agent pause a campaign from the inbox row',
    description: 'Right now pausing means opening the campaign detail. Agents want it inline on the row they are already looking at.',
    submitter_label: 'Ops (Kayla)', submitted_via: 'admin',
    triaged_at: ago(880), triaged_by: 'Mike', created_at: ago(1500), updated_at: ago(880),
  },
  {
    id: 4715, workspace: 'example-project', project: 'example-project-platform', type: 'improvement',
    status: 'triaged', severity: 'low', impact: 2, effort: 1, priority_rank: 14, area: 'reporting',
    route: '/admin/reports',
    title: 'Remember the last selected report range',
    description: 'Every visit resets to "Today". Mike almost always wants 30d.',
    submitter_label: 'Mike', submitted_via: 'admin',
    triaged_at: ago(700), triaged_by: 'Mike', created_at: ago(1900), updated_at: ago(700),
  },
  {
    id: 4716, workspace: 'example', project: 'example-platform', type: 'bug',
    status: 'new', severity: 'high', route: '/dialer',
    title: 'Dialer availability picker shows slots 90 days out',
    description: 'Booking horizon cap is not applied on the public submit path, so reps get appointments in November.',
    submitter_label: 'Phil D.', submitted_via: 'widget', created_at: ago(38), updated_at: ago(38),
  },
  {
    id: 4717, workspace: 'example2', project: 'example3-platform', type: 'chore',
    status: 'planned', impact: 1, effort: 1, priority_rank: 40, area: 'infra',
    title: 'Drop the dead calcom webhook route',
    description: 'Legacy path, nothing calls it, it just confuses new readers.',
    submitted_via: 'admin', objective_id: 703301, objective_status: 'queue',
    triaged_at: ago(400), triaged_by: 'Mike', created_at: ago(1200), updated_at: ago(400),
  },
  {
    id: 4718, workspace: 'example-project', project: 'example-project-platform', type: 'feature',
    status: 'in_progress', impact: 3, effort: 3, priority_rank: 11, area: 'mockups',
    title: 'Auto-generate a 3D mockup from an uploaded .skp',
    description: 'Convert the customer-supplied SketchUp file to GLB on upload so the buyer sees a real preview.',
    submitted_via: 'admin', objective_id: 701828, objective_status: 'review',
    branch_name: 'obj-701828-mockup-v4', objective_pr_url: 'https://github.com/m1keluka/example-project-platform/pull/235',
    triaged_at: ago(3000), triaged_by: 'Mike', created_at: ago(4000), updated_at: ago(120),
  },
  {
    id: 4719, workspace: 'example2', project: 'example3-platform', type: 'bug',
    status: 'shipped', severity: 'blocker', impact: 3, effort: 1, area: 'mailboxes',
    route: '/admin/campaigns',
    title: '1,092 senders silently flipped to in_repair',
    description: 'An EmailBison account_disconnected webhook flipped virgin senders with no status log entry.',
    submitted_via: 'admin', objective_id: 702611, objective_status: 'done',
    objective_pr_url: 'https://github.com/m1keluka/example3-platform/pull/479',
    changelog_status: 'published',
    triaged_at: ago(5000), triaged_by: 'Mike', closed_at: ago(4300), created_at: ago(5200), updated_at: ago(4300),
  },
  {
    id: 4720, workspace: 'example-project', project: 'example-project-platform', type: 'improvement',
    status: 'shipped', impact: 2, effort: 1, area: 'portal',
    title: 'Mobile pass across the client portal',
    description: 'Ported the Command Center responsive pattern to all 13 portal routes.',
    submitted_via: 'admin', objective_id: 704128, objective_status: 'done', changelog_status: 'draft',
    triaged_at: ago(3200), triaged_by: 'Mike', closed_at: ago(2000), created_at: ago(3600), updated_at: ago(2000),
  },
  {
    id: 4721, workspace: 'example', type: 'feature', status: 'declined',
    title: 'Add a Cal.com booking option alongside Calendly',
    description: 'Declined — Example is Calendly-only by decision; the calcom route is dead legacy.',
    submitted_via: 'widget', submitter_label: 'Example4 rep',
    closed_at: ago(900), created_at: ago(1400), updated_at: ago(900),
  },
  {
    id: 4722, workspace: 'example-project', project: 'example-project-platform', type: 'bug',
    status: 'duplicate', severity: 'high', duplicate_of_id: 4711, route: '/checkout',
    title: 'Cart total shows zero for a second',
    description: 'Same as DEV-4711.',
    submitted_via: 'widget', submitter_label: 'Ana G.',
    closed_at: ago(1800), created_at: ago(2000), updated_at: ago(1800),
  },
  {
    id: 4723, workspace: 'example2', project: 'example3-platform', type: 'improvement',
    status: 'new', route: '/portal/campaigns',
    title: 'Campaign cards should show the inbox count without opening the drawer',
    description: 'Backfilled campaigns look empty until you click in.',
    submitted_via: 'widget', submitter_label: 'Broker (Dana)', screenshot_path: 'gf/4723/card.png',
    created_at: ago(180), updated_at: ago(180),
  },
  {
    id: 4724, workspace: 'example', project: 'example-platform', type: 'improvement',
    status: 'triaged', impact: 2, effort: 2, priority_rank: 30, area: 'appointments',
    title: 'Show which rep is assigned on the appointments list',
    description: 'Two rep systems exist; the list only reflects one of them.',
    submitted_via: 'admin', triaged_at: ago(600), triaged_by: 'Mike',
    created_at: ago(1000), updated_at: ago(600),
  },
  {
    id: 4725, workspace: 'example-project', project: 'example-project-platform', type: 'bug',
    status: 'new', severity: 'low', route: '/customer/orders',
    title: 'Order status pill wraps onto two lines at 390px',
    description: 'Cosmetic, but it pushes the CTA below the fold on an iPhone SE.',
    submitted_via: 'widget', submitter_label: 'Sam K.', screenshot_path: 'ws/4725/se.png',
    created_at: ago(410), updated_at: ago(410),
  },
  {
    id: 4726, workspace: 'example2', project: 'example3-platform', type: 'feature',
    status: 'in_progress', impact: 3, effort: 2, priority_rank: 18, area: 'mls',
    title: 'Auto-reconcile MLS board codes from an agent’s own listings',
    description: 'Single unambiguous board → apply; otherwise flag for a human.',
    submitted_via: 'admin', objective_id: 703336, objective_status: 'ai',
    branch_name: 'obj-703336-board-reconciler',
    objective_pr_url: 'https://github.com/m1keluka/example3-platform/pull/559',
    triaged_at: ago(2400), triaged_by: 'Mike', created_at: ago(2900), updated_at: ago(60),
  },
]

let nextId = 4800
let nextNoteId = 900
let nextObjectiveId = 704900

function hydrate(s: Seed): DevItemFull {
  const meta = WS[s.workspace]
  return {
    id: s.id,
    ref: `DEV-${s.id}`,
    workspace: s.workspace,
    workspace_label: meta.short,
    workspace_badge_color: meta.color,
    project: s.project ?? null,
    type: s.type,
    status: s.status,
    severity: s.severity ?? null,
    impact: s.impact ?? null,
    effort: s.effort ?? null,
    priority_rank: s.priority_rank ?? null,
    area: s.area ?? null,
    route: s.route ?? null,
    title: s.title,
    description: s.description ?? '',
    submitter_label: s.submitter_label ?? null,
    submitter_email: s.submitter_email ?? null,
    submitted_via: s.submitted_via ?? 'widget',
    has_replay: !!s.posthog_replay_url,
    has_screenshot: !!s.screenshot_path,
    posthog_replay_url: s.posthog_replay_url ?? null,
    loom_url: s.loom_url ?? null,
    objective_id: s.objective_id ?? null,
    objective_status: s.objective_status ?? null,
    branch_name: s.branch_name ?? null,
    objective_pr_url: s.objective_pr_url ?? null,
    changelog_status: s.changelog_status ?? null,
    note_count: 0,
    attachment_count: s.screenshot_path ? 1 : 0,
    triaged_at: s.triaged_at ?? null,
    closed_at: s.closed_at ?? null,
    created_at: s.created_at ?? ago(500),
    updated_at: s.updated_at ?? ago(500),
    steps_to_repro: s.steps_to_repro ?? null,
    console_log: s.severity === 'blocker' || s.severity === 'high'
      ? '[14:02:58] GET /api/cart 200 in 41ms\n[14:02:58] warn: hydration mismatch on <OrderTotal />\n[14:02:59] error: Cannot read properties of undefined (reading "amount")\n    at OrderSummary (OrderSummary.tsx:88:22)\n[14:03:01] info: cart settled { total: 148.00 }'
      : null,
    route_history: s.route ? [
      { path: '/', ts: ago(12) },
      { path: '/products', ts: ago(11) },
      { path: s.route, ts: ago(10) },
    ] : [],
    client_meta: { viewport: { w: 1512, h: 856 }, userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/128', url: `https://app.example${s.route ?? '/'}`, role: 'consultant' },
    legacy_ref: {},
    source_system: 'native',
    source_table: null,
    source_id: null,
    duplicate_of_id: s.duplicate_of_id ?? null,
    loom_transcript: null,
    screenshot_path: s.screenshot_path ?? null,
    submitter_platform_user_id: s.submitted_via === 'admin' ? null : `plat_${s.id}_8f3c`,
    triaged_by: s.triaged_by ?? null,
    promoted_at: s.objective_id ? ago(800) : null,
    changelog_entry_id: s.changelog_status ? 800 + (s.id % 10) : null,
    deleted_at: null,
  }
}

const items = new Map<number, DevItemFull>(SEED.map(s => [s.id, hydrate(s)]))

const notes = new Map<number, DevNote[]>([
  [4711, [
    { id: 851, author_user_id: 1, author_label: 'Mike', body: 'Repro\'d on staging — the summary rail renders before the cart query resolves.', visibility: 'internal', created_at: ago(2050) },
    { id: 852, author_user_id: null, author_label: 'agent', body: 'Traced to `useCart()` returning `{}` on first paint. Fix is a loading guard in OrderSummary.tsx:88. Opened PR #912.', visibility: 'internal', created_at: ago(1400) },
    { id: 853, author_user_id: 1, author_label: 'Mike', body: 'Reproduced — the fix is in review and ships today. Thanks for the clear steps.', visibility: 'submitter', created_at: ago(600) },
  ]],
  [4719, [
    { id: 861, author_user_id: null, author_label: 'agent', body: 'EB never sends a reconnect event. Debounce + a floor of 20 restores 1,092 senders; verified against EB before writing.', visibility: 'internal', created_at: ago(4800) },
  ]],
  [4714, [
    { id: 871, author_user_id: 1, author_label: 'Mike', body: 'Worth doing after the campaign status sync lands.', visibility: 'internal', created_at: ago(870) },
  ]],
])
notes.forEach((list, id) => { const it = items.get(id); if (it) it.note_count = list.length })

const attachments = new Map<number, DevAttachment[]>([
  [4711, [{
    id: 903, storage_provider: 'supabase', storage_bucket: 'feedback-attachments',
    storage_path: 'ws/4711/shot.png', file_name: 'checkout-zero.png', mime_type: 'image/png',
    size_bytes: 184320, uploaded_by: 'widget', signed_url: null, signed_url_expires_at: null,
    created_at: ago(2590),
  }]],
  [4713, [{
    id: 904, storage_provider: 'supabase', storage_bucket: 'feedback-attachments',
    storage_path: 'gf/4713/ipad.png', file_name: 'legend-overlap.png', mime_type: 'image/png',
    size_bytes: 92110, uploaded_by: 'widget', signed_url: null, signed_url_expires_at: null,
    created_at: ago(239),
  }]],
])

const prs = new Map<number, DevPr[]>([
  [4711, [
    { repo: 'm1keluka/example-project-platform', pr_number: 912, pr_url: 'https://github.com/m1keluka/example-project-platform/pull/912', state: 'open', via: 'objective' },
    { repo: 'm1keluka/example-project-platform', pr_number: 918, pr_url: 'https://github.com/m1keluka/example-project-platform/pull/918', state: 'open', via: 'pr_body' },
  ]],
  [4719, [
    { repo: 'm1keluka/example3-platform', pr_number: 479, pr_url: 'https://github.com/m1keluka/example3-platform/pull/479', state: 'merged', via: 'objective' },
  ]],
  [4726, [
    { repo: 'm1keluka/example3-platform', pr_number: 559, pr_url: 'https://github.com/m1keluka/example3-platform/pull/559', state: 'open', via: 'objective' },
  ]],
])

const changelog: ChangelogEntryRow[] = [
  {
    id: 809, workspace: 'example2', repo: 'm1keluka/example3-platform', pr_number: 479,
    title_eng: 'fix(mailboxes): debounce account_disconnected + floor at 20',
    headline: 'Sender health no longer flips to “needs repair” by mistake',
    body_stakeholder: 'A provider disconnect notice could mark healthy senders as broken. Those senders are back online and the false alarm is gone.',
    how_to: 'Nothing to do — 1,092 senders were restored automatically.',
    category: 'fix', status: 'published', author: 'Mike', dev_item_id: 4719, objective_id: 702611,
    merged_at: ago(4310), published_at: ago(4200), notified_at: ago(4180),
  },
  {
    id: 810, workspace: 'example-project', repo: 'm1keluka/example-project-platform', pr_number: 231,
    title_eng: 'feat(portal): responsive pass across 13 routes',
    headline: 'The client portal now works properly on a phone',
    body_stakeholder: 'Every portal screen reflows to a single column, tables become cards, and every button is a real touch target.',
    how_to: 'Just open the portal on your phone.',
    category: 'improvement', status: 'draft', author: 'Mike', dev_item_id: 4720, objective_id: 704128,
    merged_at: ago(2010), published_at: null, notified_at: null,
  },
  {
    id: 811, workspace: 'example-project', repo: 'm1keluka/example-project-platform', pr_number: 235,
    title_eng: 'feat(mockups): skp → glb conversion pipeline',
    headline: 'Upload a SketchUp file, get a 3D preview',
    body_stakeholder: 'Customer-supplied .skp files are converted automatically so buyers see a real rotating preview instead of a placeholder.',
    how_to: 'Upload the .skp on the product page — the preview appears within a minute.',
    category: 'feature', status: 'draft', author: 'Mike', dev_item_id: 4718, objective_id: 701828,
    merged_at: ago(130), published_at: null, notified_at: null,
  },
  {
    id: 812, workspace: 'example', repo: 'm1keluka/example-platform', pr_number: 326,
    title_eng: 'chore(dialer): cap booking horizon at 42d',
    headline: 'Booking links stop offering slots months away',
    body_stakeholder: 'The scheduler now only offers the next six weeks.',
    how_to: 'No action needed.',
    category: 'improvement', status: 'skipped', author: 'Mike', dev_item_id: null, objective_id: null,
    merged_at: ago(1500), published_at: null, notified_at: null,
  },
]

/* ── query engine ──────────────────────────────────────────────────────── */
const SEV_ORDER: Record<string, number> = { blocker: 0, high: 1, medium: 2, low: 3 }

function live(): DevItemFull[] {
  return [...items.values()].filter(i => !i.deleted_at)
}

function matches(i: DevItemFull, q: DevItemQuery): boolean {
  if (q.workspace?.length && !q.workspace.includes(i.workspace)) return false
  if (q.project?.length && !q.project.includes(i.project ?? '__none__')) return false
  if (q.type?.length && !q.type.includes(i.type)) return false
  if (q.status?.length && !q.status.includes(i.status)) return false
  if (q.severity?.length) {
    const key = i.severity ?? 'none'
    if (!q.severity.includes(key)) return false
  }
  if (q.area && i.area !== q.area) return false
  if (q.route && !(i.route ?? '').startsWith(q.route)) return false
  if (q.has_replay === 'yes' && !i.posthog_replay_url) return false
  if (q.has_replay === 'no' && i.posthog_replay_url) return false
  if (q.has_screenshot === 'yes' && !i.screenshot_path) return false
  if (q.has_screenshot === 'no' && i.screenshot_path) return false
  if (q.untriaged && i.triaged_at) return false
  if (q.unassigned && i.objective_id) return false
  if (q.submitted_via?.length && !q.submitted_via.includes(i.submitted_via)) return false
  if (q.q) {
    const needle = q.q.toLowerCase()
    if (!i.title.toLowerCase().includes(needle) && !i.description.toLowerCase().includes(needle)) return false
  }
  const closedLane = q.status?.length && q.status.every(s => s === 'shipped' || s === 'declined' || s === 'duplicate')
  const dateField = closedLane ? i.closed_at : i.created_at
  if (q.date_from && dateField && dateField < q.date_from) return false
  if (q.date_to && dateField && dateField > q.date_to) return false
  return true
}

function sortRows(rows: DevItemFull[], sort: DevItemQuery['sort']): DevItemFull[] {
  const out = [...rows]
  switch (sort) {
    case 'newest': out.sort((a, b) => b.created_at.localeCompare(a.created_at)); break
    case 'oldest': out.sort((a, b) => a.created_at.localeCompare(b.created_at)); break
    case 'updated': out.sort((a, b) => b.updated_at.localeCompare(a.updated_at)); break
    case 'severity':
      out.sort((a, b) => (SEV_ORDER[a.severity ?? 'zz'] ?? 9) - (SEV_ORDER[b.severity ?? 'zz'] ?? 9))
      break
    case 'score':
      out.sort((a, b) => {
        const sa = a.impact && a.effort ? (a.impact * 3) / a.effort : -1
        const sb = b.impact && b.effort ? (b.impact * 3) / b.effort : -1
        return sb - sa
      })
      break
    default:
      out.sort((a, b) => {
        const ra = a.priority_rank, rb = b.priority_rank
        if (ra === null && rb === null) return b.created_at.localeCompare(a.created_at)
        if (ra === null) return 1
        if (rb === null) return -1
        return ra - rb
      })
  }
  return out
}

const delay = <T,>(v: T): Promise<T> => new Promise(res => setTimeout(() => res(v), 120))

export function listDevItems(q: DevItemQuery): Promise<DevListResponse> {
  const all = live()
  const rows = sortRows(all.filter(i => matches(i, q)), q.sort)
  const facetOn = <K extends keyof DevItemFull>(dim: K, omit: keyof DevItemQuery) => {
    const stripped = { ...q, [omit]: undefined } as DevItemQuery
    const counts: Record<string, number> = {}
    all.filter(i => matches(i, stripped)).forEach(i => {
      const k = String(i[dim])
      counts[k] = (counts[k] ?? 0) + 1
    })
    return counts
  }
  const filtersApplied = [
    q.workspace?.length, q.project?.length, q.type?.length, q.severity?.length,
    q.area, q.route, q.has_replay, q.has_screenshot, q.unassigned, q.q,
    q.date_from,
  ].filter(Boolean).length
  return delay({
    data: rows.map(r => ({ ...r })),
    page: { next_cursor: null, has_more: false },
    facets: {
      status: facetOn('status', 'status') as DevListResponse['facets']['status'],
      workspace: facetOn('workspace', 'workspace'),
      type: facetOn('type', 'type') as DevListResponse['facets']['type'],
    },
    meta: { total_matching: rows.length, filters_applied: filtersApplied },
  })
}

export function getDevItem(id: number): Promise<{ data: DevItemDetail }> {
  const item = items.get(id)
  if (!item) return Promise.reject(Object.assign(new Error('not_found'), { status: 404 }))
  const meta = WS[item.workspace as keyof typeof WS]
  const entry = changelog.find(c => c.dev_item_id === id) ?? null
  return delay({
    data: {
      item: { ...item },
      workspace: meta ? { slug: item.workspace, name: meta.name, short_label: meta.short, badge_color: meta.color } : null,
      objective: item.objective_id ? {
        id: item.objective_id,
        status: item.objective_status ?? 'queue',
        branch_name: item.branch_name,
        title: item.title,
        completion_goal: `${item.ref} is verified fixed on ${item.route ?? 'the affected surface'} and the item is shipped.`,
        ai_review_verdict: item.objective_status === 'review' ? 'pass' : null,
      } : null,
      notes: (notes.get(id) ?? []).map(n => ({ ...n })),
      attachments: (attachments.get(id) ?? []).map(a => ({ ...a })),
      prs: (prs.get(id) ?? []).map(p => ({ ...p })),
      changelog: entry ? {
        id: entry.id, status: entry.status, headline: entry.headline,
        category: entry.category, published_at: entry.published_at, notified_at: entry.notified_at,
      } : null,
    },
  })
}

export function createDevItem(body: CreateDevItemBody): Promise<{ data: DevItemRow }> {
  const id = nextId++
  const seed: Seed = {
    id,
    workspace: (body.workspace as keyof typeof WS) in WS ? (body.workspace as keyof typeof WS) : 'example-project',
    project: body.project ?? null,
    type: body.type ?? 'bug',
    status: body.status ?? (body.severity || body.impact || body.effort || body.area ? 'triaged' : 'new'),
    title: body.title,
    description: body.description ?? '',
    steps_to_repro: body.steps_to_repro ?? null,
    severity: body.severity ?? null,
    impact: body.impact ?? null,
    effort: body.effort ?? null,
    area: body.area ?? null,
    route: body.route ?? null,
    loom_url: body.loom_url ?? null,
    submitted_via: 'admin',
    submitter_label: 'Mike',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    triaged_at: body.severity || body.impact ? new Date().toISOString() : null,
    triaged_by: body.severity || body.impact ? 'Mike' : null,
  }
  const row = hydrate(seed)
  items.set(id, row)
  return delay({ data: { ...row } })
}

function stamp(item: DevItemFull) {
  item.updated_at = new Date().toISOString()
  const closed = item.status === 'shipped' || item.status === 'declined' || item.status === 'duplicate'
  if (closed && !item.closed_at) item.closed_at = item.updated_at
  if (!closed) item.closed_at = null
}

export function patchDevItem(id: number, body: PatchDevItemBody): Promise<{ data: DevItemRow }> {
  const item = items.get(id)
  if (!item) return Promise.reject(Object.assign(new Error('not_found'), { status: 404 }))
  Object.assign(item, body)
  stamp(item)
  return delay({ data: { ...item } })
}

export function triageDevItem(id: number, body: TriageBody): Promise<{ data: DevItemRow }> {
  const item = items.get(id)
  if (!item) return Promise.reject(Object.assign(new Error('not_found'), { status: 404 }))
  if (body.severity !== undefined) item.severity = body.severity as DevSeverity | null
  if (body.impact !== undefined) item.impact = body.impact
  if (body.effort !== undefined) item.effort = body.effort
  if (body.area !== undefined) item.area = body.area
  item.triaged_at = new Date().toISOString()
  item.triaged_by = 'Mike'
  if (body.status) item.status = body.status
  else if (item.status === 'new') item.status = 'triaged'
  if (body.suggest_rank && item.priority_rank === null && item.impact && item.effort) {
    item.priority_rank = Math.round(((item.impact * 3.0) / item.effort) * 100) / 100
  }
  if (body.note) {
    const list = notes.get(id) ?? []
    list.push({ id: nextNoteId++, author_user_id: 1, author_label: 'Mike', body: body.note, visibility: 'internal', created_at: new Date().toISOString() })
    notes.set(id, list)
    item.note_count = list.length
  }
  stamp(item)
  return delay({ data: { ...item } })
}

export function promoteDevItem(
  id: number,
  body: { title?: string; completion_goal?: string; project?: string; type?: DevType },
): Promise<PromoteResponse> {
  const item = items.get(id)
  if (!item) return Promise.reject(Object.assign(new Error('not_found'), { status: 404 }))
  const already = item.objective_id !== null
  if (!already) {
    item.objective_id = nextObjectiveId++
    item.objective_status = 'queue'
    item.promoted_at = new Date().toISOString()
    if (item.status === 'new' || item.status === 'triaged') item.status = 'planned'
    stamp(item)
  }
  return delay({
    data: {
      dev_item: { id: item.id, status: item.status, objective_id: item.objective_id!, promoted_at: item.promoted_at! },
      objective: {
        id: item.objective_id!, workspace: item.workspace, project: body.project ?? item.project,
        category: 'development', type: body.type ?? item.type, title: body.title ?? item.title, status: item.objective_status ?? 'queue',
      },
    },
    already_promoted: already,
  })
}

export function rankDevItem(
  id: number,
  body: { before_id?: number; after_id?: number },
): Promise<{ data: { id: number; priority_rank: number }; renormalized: boolean }> {
  const item = items.get(id)
  if (!item) return Promise.reject(Object.assign(new Error('not_found'), { status: 404 }))
  const rankOf = (x?: number) => (x !== undefined ? items.get(x)?.priority_rank ?? null : null)
  const before = rankOf(body.before_id)
  const after = rankOf(body.after_id)
  let next: number
  if (before !== null && after !== null) next = (before + after) / 2
  else if (before !== null) next = before + 1
  else if (after !== null) next = after - 1
  else next = 1000
  item.priority_rank = Math.round(next * 1000) / 1000
  stamp(item)
  return delay({ data: { id, priority_rank: item.priority_rank }, renormalized: false })
}

export function attachPr(
  id: number,
  body: { repo: string; pr_number?: number; pr_url?: string; state?: DevPr['state'] },
): Promise<{ data: DevPr; note?: string }> {
  const item = items.get(id)
  if (!item) return Promise.reject(Object.assign(new Error('not_found'), { status: 404 }))
  const parsed = body.pr_url?.match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/)
  const repo = parsed?.[1] ?? body.repo
  const num = body.pr_number ?? Number(parsed?.[2] ?? 0)
  const row: DevPr = {
    repo, pr_number: num,
    pr_url: body.pr_url ?? `https://github.com/${repo}/pull/${num}`,
    state: body.state ?? 'open', via: 'manual',
  }
  const list = prs.get(id) ?? []
  if (!list.some(p => p.repo === row.repo && p.pr_number === row.pr_number)) list.push(row)
  prs.set(id, list)
  return delay({ data: row })
}

export function addDevNote(
  id: number,
  body: { body: string; visibility?: NoteVisibility; author_label?: string },
): Promise<{ data: DevNote }> {
  const item = items.get(id)
  if (!item) return Promise.reject(Object.assign(new Error('not_found'), { status: 404 }))
  const note: DevNote = {
    id: nextNoteId++, author_user_id: 1, author_label: body.author_label ?? 'Mike',
    body: body.body, visibility: body.visibility ?? 'internal', created_at: new Date().toISOString(),
  }
  const list = notes.get(id) ?? []
  list.push(note)
  notes.set(id, list)
  item.note_count = list.length
  return delay({ data: note })
}

export function deleteDevItem(id: number): Promise<void> {
  const item = items.get(id)
  if (item) item.deleted_at = new Date().toISOString()
  return delay(undefined as unknown as void)
}

export function bulkDevItems(ids: number[], op: BulkOp): Promise<{ data: { updated: number; ids: number[] } }> {
  ids.forEach(id => {
    const item = items.get(id)
    if (!item) return
    switch (op.op) {
      case 'set_status': item.status = op.params.status as DevStatus; break
      case 'set_severity': item.severity = op.params.severity; break
      case 'set_area': item.area = op.params.area; break
      case 'set_project': item.project = op.params.project; break
      case 'triage':
        if (op.params.severity) item.severity = op.params.severity
        if (op.params.impact) item.impact = op.params.impact
        if (op.params.effort) item.effort = op.params.effort
        if (op.params.area) item.area = op.params.area
        item.triaged_at = new Date().toISOString()
        item.triaged_by = 'Mike'
        if (item.status === 'new') item.status = 'triaged'
        break
      case 'mark_duplicate':
        item.duplicate_of_id = op.params.duplicate_of_id
        item.status = 'duplicate'
        break
      case 'delete': item.deleted_at = new Date().toISOString(); break
      case 'restore': item.deleted_at = null; break
    }
    stamp(item)
  })
  return delay({ data: { updated: ids.length, ids } })
}

export function listChangelog(params: { workspace?: string[]; status?: ChangelogStatus[]; q?: string }): Promise<{ data: ChangelogEntryRow[] }> {
  let rows = [...changelog]
  if (params.workspace?.length) rows = rows.filter(r => r.workspace && params.workspace!.includes(r.workspace))
  if (params.status?.length) rows = rows.filter(r => params.status!.includes(r.status))
  if (params.q) {
    const n = params.q.toLowerCase()
    rows = rows.filter(r => r.headline.toLowerCase().includes(n) || (r.body_stakeholder ?? '').toLowerCase().includes(n))
  }
  rows.sort((a, b) => (b.merged_at ?? '').localeCompare(a.merged_at ?? ''))
  return delay({ data: rows.map(r => ({ ...r })) })
}

function findEntry(id: number) {
  const e = changelog.find(c => c.id === id)
  if (!e) throw Object.assign(new Error('not_found'), { status: 404 })
  return e
}

export function patchChangelog(id: number, body: Partial<ChangelogEntryRow>): Promise<{ data: ChangelogEntryRow }> {
  const e = findEntry(id)
  Object.assign(e, body)
  return delay({ data: { ...e } })
}

export function publishChangelog(id: number, action: 'publish' | 'unpublish' | 'skip'): Promise<{ data: ChangelogEntryRow }> {
  const e = findEntry(id)
  if (action === 'publish') {
    e.status = 'published'
    if (!e.published_at) e.published_at = new Date().toISOString()
  } else if (action === 'unpublish') {
    e.status = 'draft'
  } else {
    e.status = 'skipped'
  }
  return delay({ data: { ...e } })
}

export function retranslateChangelog(id: number): Promise<{ data: ChangelogEntryRow }> {
  const e = findEntry(id)
  return delay({ data: { ...e } })
}

export function notifyChangelog(id: number): Promise<{ data: ChangelogEntryRow; already_notified?: boolean }> {
  const e = findEntry(id)
  const already = !!e.notified_at
  if (!already) e.notified_at = new Date().toISOString()
  return delay({ data: { ...e }, already_notified: already })
}
