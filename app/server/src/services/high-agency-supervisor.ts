/**
 * High Agency supervisor — the daily review of every area bot's work (obj 900795).
 *
 * Design note: `workspaces/operationkit/decisions/2026-11-13-high-agency-activation-
 * prompt-and-operating-loop.md` ("Supervisor bot"). Each High Agency bot owns its
 * projects end to end; once a day this supervisor looks across ALL of them and
 * flags four things, then routes each flag to whoever must act:
 *
 *   orphaned     a card in a bot's area with no area-bot owner        → Operator
 *   duplicate    two open cards that are the same work                → the bot if one awake bot owns every twin, else Operator
 *   stalled      no meaningful progress past the CONFIGURED window    → the owning bot if it is awake, else Operator
 *   over_budget  at/over the CONFIGURED job ceiling                    → Operator (a ceiling is a spend decision)
 *
 * What it is, deliberately:
 *
 * - **Deterministic code, not a model.** No LLM call, no session, no card, no
 *   tool. That is the least-privilege story in one line: the supervisor cannot
 *   send, spend, merge, deploy, post, publish, close or reassign anything
 *   because there is no code path here that does any of those. Its only writes
 *   are `review_items` rows (+ their audit) and its own run-log row.
 * - **It never touches another bot's card.** Not the status, not the owner, not
 *   the accountability columns (those are declared by the worker/lead, §3.2 of
 *   the #900367 design). Routing a flag is the whole intervention.
 * - **Reuses #900367 / PR 671 instead of a third review pile.** Flags are
 *   durable `review_items` (kind `decision`, `dedupe_key = supervisor:<kind>:<card>`),
 *   routed with `review_items.routed_to` (`agent:<bot>` or `human:<user>`).
 *   Stalled is `classifyAccountability`'s own `stalled` verdict; over-budget is
 *   `evaluateCeiling`'s own `exceeded` verdict; duplicate uses the board's own
 *   title normaliser (`normalizeTitle`, obj 64).
 * - **Invents no numbers.** Stalled needs `settings.accountability_stalled_after_minutes`
 *   (#900367 ships it default-OFF, so this check is off until Operator sets it).
 *   Over-budget needs a configured finite ceiling (card / `job_cost_ceiling_usd:<ws>`
 *   / `job_cost_ceiling_usd`); a card with no ceiling is never "over budget".
 *   Each run records which checks were off and why.
 * - **Quiet.** No notification, email, chat message or alert. A flag that is
 *   already live is re-surfaced (one audit row), never stacked; a flag Operator
 *   already decided is not re-asked while the same condition persists (the
 *   source-event id carries a fingerprint of the condition); a flag whose
 *   condition cleared is WITHDRAWN with a reason, so the pile shrinks by itself.
 *
 * Like `review-items.ts`, every function takes the Database handle explicitly and
 * nothing here imports `getDb` — the scheduler/route wrapper lives in
 * `high-agency-supervisor-scheduler.ts`.
 */
import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import { initAccountabilitySchema, LIVE_REVIEW_ITEM_STATES } from '../db/schema/accountability.js'
import { initJobAccountingSchema } from '../db/schema/job-accounting.js'
import { initSupervisorSchema } from '../db/schema/supervisor.js'
import { classifyAccountability } from '../lib/accountability.js'
import { normalizeTitle } from '../lib/title-normalize.js'
import { stalledWindowMinutes } from './accountability.js'
import { evaluateCeiling } from './job-accounting.js'
import { createReviewItem, withdrawReviewItem, type DecisionChoice } from './review-items.js'

export const SUPERVISOR_FLAG_KINDS = ['orphaned', 'duplicate', 'stalled', 'over_budget'] as const
export type SupervisorFlagKind = (typeof SUPERVISOR_FLAG_KINDS)[number]

/** Every review item the supervisor files carries this dedupe_key prefix. */
export const SUPERVISOR_DEDUPE_PREFIX = 'supervisor:'
/** The actor recorded on every review-item audit row the supervisor writes. */
export const SUPERVISOR_ACTOR = 'server:supervisor'

/** Statuses in which an owner is expected to be MOVING the card. `ai_review` /
 *  `review` are waiting on a reviewer or a human, so they are never "stalled". */
const STALLABLE_STATUSES = new Set(['planning', 'queue', 'working'])

/** What a person may answer on a supervisor flag. Never an `approval` kind, so a
 *  supervisor flag can never be mistaken for (or used as) an approval. */
const FLAG_OPTIONS: DecisionChoice[] = ['approve', 'reject', 'snooze']

export interface SupervisorBot {
  slug: string
  /** High Agency switched on for this bot. */
  enabled: boolean
  /** The bot's file is still installed. */
  exists: boolean
  /** It will actually wake: enabled, installed, and its routine is on and not auto-paused. */
  awake: boolean
  /** The admin who switched High Agency on (where a human-routed flag about this bot goes). */
  owner_username: string | null
  routine_id: number | null
}

export interface SupervisorFlag {
  kind: SupervisorFlagKind
  objective_id: number
  workspace: string
  title: string
  /** The owning bot slug, or null when there is none. */
  owner: string | null
  /** `agent:<bot>` or `human[:<user>]`. */
  routed_to: string
  route: 'bot' | 'human'
  /** One sentence, built from card state only. */
  why: string
  /** Identifies THIS occurrence of the condition (see fileFlags). */
  fingerprint: string
  related_ids: number[]
}

export interface SupervisorReview {
  bots: SupervisorBot[]
  /** Open cards in scope (owned by, or filed by a wake of, a High Agency bot). */
  cards: number
  flags: SupervisorFlag[]
  /** Checks that did not run, and why — so "no stalled flags" is never ambiguous. */
  checks_off: { check: SupervisorFlagKind; reason: string }[]
  stalled_after_minutes: number | null
}

export interface SupervisorRunResult extends SupervisorReview {
  run_id: number | null
  run_date: string
  trigger: 'schedule' | 'manual'
  /** New review items filed. */
  filed: number
  /** Flags that matched an item already live (re-surfaced, not stacked). */
  resurfaced: number
  /** Flags Operator or a bot already settled for this same occurrence (not re-asked). */
  settled: number
  /** Live supervisor items withdrawn because their condition cleared. */
  withdrawn: number
  /** Set when the run was skipped (already ran today). */
  skipped?: string
}

export interface SupervisorOptions {
  /** Slugs of the bot files currently installed. Omit to trust the High Agency rows. */
  knownBots?: string[]
  now?: Date
}

// ── loading ────────────────────────────────────────────────────────────────

interface CardRow {
  id: number
  title: string | null
  status: string
  workspace: string | null
  agent_context: string | null
  parent_id: number | null
  routine_id: number | null
  source_job_id: number | null
  session_id: string | null
  has_blockers: number | null
  blocked_reason: string | null
  ai_review_verdict: string | null
  needs_secret: string | null
  waiting_on: string | null
  next_check_at: string | null
  last_meaningful_progress_at: string | null
  updated_at: string | null
}

function tableCols(db: Database.Database, table: string): Set<string> {
  try {
    return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name))
  } catch {
    return new Set()
  }
}

function ensure(db: Database.Database): void {
  initAccountabilitySchema(db)
  initJobAccountingSchema(db)
  initSupervisorSchema(db)
}

/** Every bot that has ever been given High Agency (a row in `agent_chat_high_agency`). */
export function loadSupervisedBots(db: Database.Database, knownBots?: string[]): SupervisorBot[] {
  if (!tableCols(db, 'agent_chat_high_agency').size) return []
  const hasRoutines = tableCols(db, 'routines')
  const hasUsers = tableCols(db, 'users').size > 0
  const autoPaused = hasRoutines.has('auto_paused_at') ? 'r.auto_paused_at' : 'NULL'
  const routineJoin = hasRoutines.size
    ? `LEFT JOIN routines r ON r.id = COALESCE(h.routine_id, (SELECT id FROM routines WHERE name = 'high-agency:' || h.slug))`
    : ''
  const rows = db.prepare(
    `SELECT h.slug, h.enabled, h.routine_id AS ha_routine_id,
            ${hasRoutines.size ? 'r.id' : 'NULL'} AS routine_id,
            ${hasRoutines.size ? 'r.enabled' : 'NULL'} AS routine_enabled,
            ${hasRoutines.size ? autoPaused : 'NULL'} AS auto_paused_at,
            ${hasUsers ? 'u.username' : 'NULL'} AS username
       FROM agent_chat_high_agency h
       ${routineJoin}
       ${hasUsers ? 'LEFT JOIN users u ON u.id = h.run_as_user_id' : ''}
      ORDER BY h.slug`,
  ).all() as {
    slug: string; enabled: number; routine_id: number | null; routine_enabled: number | null
    auto_paused_at: string | null; username: string | null
  }[]
  const installed = knownBots ? new Set(knownBots) : null
  return rows.map((r) => {
    const enabled = Number(r.enabled) === 1
    const exists = installed ? installed.has(r.slug) : true
    return {
      slug: r.slug,
      enabled,
      exists,
      awake: enabled && exists && Number(r.routine_enabled) === 1 && !r.auto_paused_at,
      owner_username: r.username ?? null,
      routine_id: r.routine_id ?? null,
    }
  })
}

/** The human a flag goes to when no bot can take it: the bot's admin, else the first admin. */
function humanFor(db: Database.Database, bot: SupervisorBot | undefined): string {
  if (bot?.owner_username) return `human:${bot.owner_username}`
  try {
    const row = db.prepare("SELECT username FROM users WHERE role = 'admin' ORDER BY id LIMIT 1").get() as { username: string } | undefined
    if (row?.username) return `human:${row.username}`
  } catch { /* no users table (test DB) */ }
  return 'human'
}

function shortTitle(t: string | null): string {
  const s = (t ?? '').replace(/\s+/g, ' ').trim() || '(untitled)'
  return s.length > 80 ? `${s.slice(0, 79)}…` : s
}

function hash(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 16)
}

// ── the review (pure over the DB: reads only) ──────────────────────────────

/**
 * Look at the board and compute today's flags. READS ONLY — filing is
 * `fileFlags`, so the dry answer ("what would it flag") is always available.
 */
export function reviewHighAgencyWork(db: Database.Database, opts: SupervisorOptions = {}): SupervisorReview {
  ensure(db)
  const now = opts.now ?? new Date()
  const bots = loadSupervisedBots(db, opts.knownBots)
  const bySlug = new Map(bots.map((b) => [b.slug, b]))
  const stalledAfter = stalledWindowMinutes(db)
  const checksOff: SupervisorReview['checks_off'] = []
  if (stalledAfter === null) {
    checksOff.push({
      check: 'stalled',
      reason: 'settings.accountability_stalled_after_minutes is not set (stall inference is default-off in #900367; no window was assumed)',
    })
  }
  const empty: SupervisorReview = { bots, cards: 0, flags: [], checks_off: checksOff, stalled_after_minutes: stalledAfter }
  if (!bots.length) return empty

  const cols = tableCols(db, 'objectives')
  if (!cols.size) return empty
  const opt = (c: string) => (cols.has(c) ? c : `NULL AS ${c}`)

  // Wake cards: every card a High Agency routine ever filed (open or closed —
  // a wake finishes quickly, its children live on). Routine → bot slug.
  const routineSlug = new Map<number, string>()
  for (const b of bots) if (b.routine_id != null) routineSlug.set(b.routine_id, b.slug)
  if (tableCols(db, 'routines').size) {
    for (const r of db.prepare("SELECT id, name FROM routines WHERE name LIKE 'high-agency:%'").all() as { id: number; name: string }[]) {
      routineSlug.set(r.id, r.name.slice('high-agency:'.length))
    }
  }
  const wakeBot = new Map<number, string>()
  if (routineSlug.size && cols.has('routine_id')) {
    const ids = [...routineSlug.keys()]
    const wakes = db.prepare(`SELECT id, routine_id FROM objectives WHERE routine_id IN (${ids.map(() => '?').join(',')})`)
      .all(...ids) as { id: number; routine_id: number }[]
    for (const w of wakes) wakeBot.set(w.id, routineSlug.get(w.routine_id)!)
  }

  const open = db.prepare(
    `SELECT id, title, status, workspace, agent_context, ${opt('parent_id')}, ${opt('routine_id')}, ${opt('source_job_id')},
            ${opt('session_id')}, ${opt('has_blockers')}, ${opt('blocked_reason')}, ${opt('ai_review_verdict')}, ${opt('needs_secret')},
            ${opt('waiting_on')}, ${opt('next_check_at')}, ${opt('last_meaningful_progress_at')}, ${opt('updated_at')}
       FROM objectives
      WHERE status NOT IN ('done', 'cancelled')${cols.has('deleted_at') ? ' AND deleted_at IS NULL' : ''}
      ORDER BY id`,
  ).all() as CardRow[]

  const owner = (c: CardRow): string | null => (c.agent_context ?? '').trim() || null
  /** The wake (and so the bot) a card came from, if any. */
  const lineage = (c: CardRow): string | null => {
    if (c.routine_id != null && routineSlug.has(c.routine_id)) return routineSlug.get(c.routine_id)!
    if (c.source_job_id != null && wakeBot.has(c.source_job_id)) return wakeBot.get(c.source_job_id)!
    if (c.parent_id != null && wakeBot.has(c.parent_id)) return wakeBot.get(c.parent_id)!
    return null
  }
  const inScope = (c: CardRow): boolean => {
    const o = owner(c)
    return (o !== null && bySlug.has(o)) || lineage(c) !== null
  }
  const scoped = open.filter(inScope)
  const flags: SupervisorFlag[] = []
  const orphaned = new Set<number>()

  // ── orphaned: in a bot's area, but no area bot owns it ──
  for (const c of scoped) {
    const o = owner(c)
    const bot = o ? bySlug.get(o) : undefined
    const from = lineage(c)
    let code: string | null = null
    let why = ''
    if (!o) {
      code = 'no_owner'
      why = `filed by ${from}'s High Agency wake but has no owner`
    } else if (!bot) {
      code = `not_area_bot:${o}`
      why = `filed by ${from}'s High Agency wake but owned by "${o}", which is not a High Agency bot`
    } else if (!bot.exists) {
      code = `bot_removed:${o}`
      why = `owned by ${o}, whose bot file is no longer installed`
    }
    if (!code) continue
    orphaned.add(c.id)
    flags.push({
      kind: 'orphaned',
      objective_id: c.id,
      workspace: c.workspace || 'general',
      title: shortTitle(c.title),
      owner: o,
      routed_to: humanFor(db, from ? bySlug.get(from) : bot),
      route: 'human',
      why: `#${c.id} "${shortTitle(c.title)}" is ${why}. Assign it to a bot that will close it out, or close it.`,
      fingerprint: code,
      related_ids: [],
    })
  }

  // ── duplicate: two open cards that are the same work ──
  // Twins are looked for across EVERY open card in the workspace (a bot
  // re-filing a card Operator already has is the case worth catching), but a group
  // is only flagged if at least one member is in a bot's area. Routine-filed
  // cards (wakes) are excluded: same title every wake by design, and the
  // routine's max_queue_depth already governs them. A parent/child pair is never
  // a twin (same rule as lib/objective-dedupe.ts).
  const groups = new Map<string, CardRow[]>()
  for (const c of open) {
    if (c.routine_id != null) continue
    const key = normalizeTitle(c.title)
    if (!key) continue
    const k = `${c.workspace || 'general'}\u0000${key}`
    const g = groups.get(k)
    if (g) g.push(c)
    else groups.set(k, [c])
  }
  const scopedIds = new Set(scoped.map((c) => c.id))
  for (const g of groups.values()) {
    if (g.length < 2) continue
    const ids = new Set(g.map((c) => c.id))
    const members = g.filter((c) => c.parent_id == null || !ids.has(c.parent_id))
    if (members.length < 2 || !members.some((c) => scopedIds.has(c.id))) continue
    const sorted = [...members].sort((a, b) => a.id - b.id)
    const anchor = sorted[sorted.length - 1]
    const others = sorted.slice(0, -1).map((c) => c.id)
    const owners = new Set(sorted.map(owner))
    const only = owners.size === 1 ? [...owners][0] : null
    const soleBot = only ? bySlug.get(only) : undefined
    const toBot = !!soleBot && soleBot.awake
    flags.push({
      kind: 'duplicate',
      objective_id: anchor.id,
      workspace: anchor.workspace || 'general',
      title: shortTitle(anchor.title),
      owner: owner(anchor),
      routed_to: toBot ? `agent:${soleBot!.slug}` : humanFor(db, soleBot ?? bySlug.get(owner(anchor) ?? '')),
      route: toBot ? 'bot' : 'human',
      why:
        `#${anchor.id} "${shortTitle(anchor.title)}" looks like the same work as ${others.map((i) => `#${i}`).join(', ')} ` +
        `(same title, workspace ${anchor.workspace || 'general'}; owners: ${[...owners].map((o) => o ?? 'none').join(', ')}). ` +
        'Keep one and cancel the rest.',
      fingerprint: sorted.map((c) => c.id).join(','),
      related_ids: others,
    })
  }

  // ── stalled: #900367's own verdict, only with a configured window ──
  if (stalledAfter !== null) {
    for (const c of scoped) {
      if (orphaned.has(c.id) || !STALLABLE_STATUSES.has(c.status)) continue
      const verdict = classifyAccountability(c, now, { stalledAfterMinutes: stalledAfter })
      if (verdict.state !== 'stalled') continue
      const o = owner(c)
      const bot = o ? bySlug.get(o) : undefined
      const toBot = !!bot && bot.awake
      flags.push({
        kind: 'stalled',
        objective_id: c.id,
        workspace: c.workspace || 'general',
        title: shortTitle(c.title),
        owner: o,
        routed_to: toBot ? `agent:${bot!.slug}` : humanFor(db, bot),
        route: toBot ? 'bot' : 'human',
        why:
          `#${c.id} "${shortTitle(c.title)}" (owner ${o ?? 'none'}${bot && !bot.awake ? ', not waking' : ''}) is stalled: ${verdict.why}. ` +
          'Close it out, unblock it, or declare what it is waiting on.',
        fingerprint: `${verdict.basis}:${(verdict.basis === 'last_meaningful_progress_at' ? c.last_meaningful_progress_at : c.updated_at) ?? ''}`,
        related_ids: [],
      })
    }
  }

  // ── over budget: the job ledger's own verdict against a CONFIGURED ceiling ──
  // `absent` (no ceiling anywhere) is never over budget — no cap is invented.
  for (const c of scoped) {
    const verdict = evaluateCeiling(db, c.id, c.workspace)
    if (verdict.state !== 'exceeded') continue
    const o = owner(c)
    flags.push({
      kind: 'over_budget',
      objective_id: c.id,
      workspace: c.workspace || 'general',
      title: shortTitle(c.title),
      owner: o,
      // Raising a ceiling or spending more is a spend decision. Only Operator makes it.
      routed_to: humanFor(db, o ? bySlug.get(o) : undefined),
      route: 'human',
      why: `#${c.id} "${shortTitle(c.title)}" (owner ${o ?? 'none'}) is over budget: ${verdict.reason} Decide whether to raise the ceiling or stop the card.`,
      fingerprint: `${verdict.ceiling.source}:${verdict.ceiling.costUsd ?? '-'}:${verdict.ceiling.wallclockMs ?? '-'}`,
      related_ids: [],
    })
  }

  return { bots, cards: scoped.length, flags, checks_off: checksOff, stalled_after_minutes: stalledAfter }
}

// ── filing (the only write) ────────────────────────────────────────────────

export function flagDedupeKey(f: Pick<SupervisorFlag, 'kind' | 'objective_id'>): string {
  return `${SUPERVISOR_DEDUPE_PREFIX}${f.kind}:${f.objective_id}`
}

/**
 * File the flags as review items and withdraw the ones whose condition cleared.
 *
 * Two keys, both from #900367's createReviewItem:
 *   - `dedupe_key = supervisor:<kind>:<card>` — one live item per card per flag,
 *     so a flag that persists for a week is ONE item re-surfaced daily, not seven.
 *   - `created_from_event_id = supervisor:<kind>:<card>:<fingerprint>` — names
 *     THIS occurrence of the condition. Once Operator decides it (e.g. "reject: this
 *     is fine"), the same occurrence is never re-asked; a NEW occurrence (a third
 *     twin, the ceiling raised and hit again, fresh progress then a new stall)
 *     has a new fingerprint and is asked once more.
 */
export function fileFlags(
  db: Database.Database,
  flags: SupervisorFlag[],
  now: Date = new Date(),
): { filed: number; resurfaced: number; settled: number; withdrawn: number } {
  ensure(db)
  let filed = 0
  let resurfaced = 0
  let settled = 0
  const keep = new Set<string>()
  for (const f of flags) {
    const dedupe = flagDedupeKey(f)
    keep.add(dedupe)
    let eventId: string | null = `${dedupe}:${hash(f.fingerprint)}`
    const prior = db.prepare('SELECT state FROM review_items WHERE created_from_event_id = ?').get(eventId) as { state: string } | undefined
    // A WITHDRAWN/expired item for this occurrence means the condition cleared
    // and came back — that deserves a fresh item, not a silent replay no-op.
    if (prior && (prior.state === 'withdrawn' || prior.state === 'expired')) eventId = null
    const { item, created } = createReviewItem(db, {
      workspace: f.workspace,
      objective_id: f.objective_id,
      kind: 'decision',
      ask: `Supervisor — ${f.kind.replace('_', ' ')}: ${f.why}`,
      dedupe_key: dedupe,
      created_from_event_id: eventId,
      lead: f.owner,
      options: FLAG_OPTIONS,
      routed_to: f.routed_to,
      actor: SUPERVISOR_ACTOR,
    }, now)
    if (created) filed++
    else if ((LIVE_REVIEW_ITEM_STATES as readonly string[]).includes(item.state)) resurfaced++
    else settled++
  }

  // Withdraw every live supervisor item that today's review no longer raises.
  // This is what keeps the queue from growing: a twin that got cancelled, a card
  // that moved again, a ceiling that was raised — the item leaves with a reason.
  let withdrawn = 0
  const live = db.prepare(
    `SELECT id, dedupe_key FROM review_items
      WHERE substr(dedupe_key, 1, ?) = ? AND state IN (${LIVE_REVIEW_ITEM_STATES.map(() => '?').join(',')})`,
  ).all(SUPERVISOR_DEDUPE_PREFIX.length, SUPERVISOR_DEDUPE_PREFIX, ...LIVE_REVIEW_ITEM_STATES) as { id: number; dedupe_key: string }[]
  for (const row of live) {
    if (keep.has(row.dedupe_key)) continue
    const kind = row.dedupe_key.split(':')[1] ?? 'flag'
    withdrawReviewItem(db, row.id, `supervisor: no longer ${kind.replace('_', ' ')} on the ${now.toISOString().slice(0, 10)} review`, SUPERVISOR_ACTOR, now)
    withdrawn++
  }
  return { filed, resurfaced, settled, withdrawn }
}

// ── one run ────────────────────────────────────────────────────────────────

/** The America/New_York calendar date (YYYY-MM-DD) — the operator's day. */
export function operatorDate(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
}

/** The America/New_York hour (0–23). */
export function operatorHour(now: Date): number {
  const h = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hourCycle: 'h23' }).format(now))
  return Number.isFinite(h) ? h % 24 : 0
}

/**
 * Review + file + record, as ONE transaction. A `schedule` run happens at most
 * once per operator day (a UNIQUE index, so a restart or a double tick cannot
 * file twice); a `manual` run always runs.
 */
export function runSupervisor(
  db: Database.Database,
  opts: SupervisorOptions & { trigger?: 'schedule' | 'manual' } = {},
): SupervisorRunResult {
  ensure(db)
  const now = opts.now ?? new Date()
  const trigger = opts.trigger ?? 'manual'
  const runDate = operatorDate(now)
  if (trigger === 'schedule') {
    const done = db.prepare("SELECT id FROM supervisor_runs WHERE run_date = ? AND trigger = 'schedule'").get(runDate) as { id: number } | undefined
    if (done) {
      return {
        run_id: done.id, run_date: runDate, trigger, bots: [], cards: 0, flags: [], checks_off: [], stalled_after_minutes: null,
        filed: 0, resurfaced: 0, settled: 0, withdrawn: 0, skipped: `already ran for ${runDate} (run ${done.id})`,
      }
    }
  }
  const tx = db.transaction((): SupervisorRunResult => {
    const runId = Number(
      db.prepare('INSERT INTO supervisor_runs (run_date, trigger, started_at) VALUES (?, ?, ?)')
        .run(runDate, trigger, now.toISOString()).lastInsertRowid,
    )
    const review = reviewHighAgencyWork(db, { ...opts, now })
    const counts = fileFlags(db, review.flags, now)
    const byKind = Object.fromEntries(SUPERVISOR_FLAG_KINDS.map((k) => [k, review.flags.filter((f) => f.kind === k).length]))
    const byRoute = {
      bot: review.flags.filter((f) => f.route === 'bot').length,
      human: review.flags.filter((f) => f.route === 'human').length,
    }
    db.prepare(
      `UPDATE supervisor_runs SET status = 'ok', finished_at = ?, bots = ?, cards = ?, flags = ?, filed = ?, withdrawn = ?, summary_json = ?
        WHERE id = ?`,
    ).run(
      new Date().toISOString(), review.bots.length, review.cards, review.flags.length, counts.filed, counts.withdrawn,
      JSON.stringify({ by_kind: byKind, by_route: byRoute, resurfaced: counts.resurfaced, settled: counts.settled, checks_off: review.checks_off }),
      runId,
    )
    return { ...review, ...counts, run_id: runId, run_date: runDate, trigger }
  })
  return tx()
}

export interface SupervisorRunRow {
  id: number
  run_date: string
  trigger: string
  status: string
  started_at: string
  finished_at: string | null
  bots: number
  cards: number
  flags: number
  filed: number
  withdrawn: number
  summary: unknown
  error: string | null
}

export function listSupervisorRuns(db: Database.Database, limit = 14): SupervisorRunRow[] {
  ensure(db)
  const rows = db.prepare('SELECT * FROM supervisor_runs ORDER BY id DESC LIMIT ?').all(Math.min(Math.max(limit, 1), 100)) as (Omit<SupervisorRunRow, 'summary'> & { summary_json: string | null })[]
  return rows.map(({ summary_json, ...r }) => {
    let summary: unknown = null
    try { summary = summary_json ? JSON.parse(summary_json) : null } catch { /* keep null */ }
    return { ...r, summary }
  })
}

/** A run that threw: record it so a broken supervisor is visible, not silent. */
export function recordSupervisorFailure(db: Database.Database, trigger: 'schedule' | 'manual', err: unknown, now: Date = new Date()): void {
  try {
    ensure(db)
    db.prepare("INSERT INTO supervisor_runs (run_date, trigger, status, started_at, finished_at, error) VALUES (?, ?, 'failed', ?, ?, ?)")
      .run(operatorDate(now), trigger, now.toISOString(), new Date().toISOString(), (err instanceof Error ? err.message : String(err)).slice(0, 1000))
  } catch (e) {
    console.error('[supervisor] could not record failed run:', (e as Error).message)
  }
}

