// ── High Agency: a per-bot "wake up and run your area" switch (obj 900748, 900794) ──
//
// An optional mode per bot. When it is on, the bot wakes on a schedule and runs
// one pass of the High Agency operating loop for its area of the business:
// orient, close out the work it already owns, then choose at most ONE next
// project, file it as a card it owns, start it and manage it to done — or say
// nothing is worth doing and stop. The model-facing brief is the activation
// prompt in the operationkit vault
// (decisions/2026-11-13-high-agency-activation-prompt-and-operating-loop.md).
//
// How it is built, and why:
//   - The SETTING is one row per bot in `agent_chat_high_agency`, edited on the
//     bot's settings panel. No row = off. That default is the whole safety
//     story for existing installs: nothing wakes until an admin switches it on.
//   - The schedule is a LEVEL 1–10 (shared/high-agency.ts): level 1 = one wake
//     at night, level 10 = every hour, the levels between spread 4…21 wakes
//     across the day, all in the install timezone (America/New_York by default).
//   - The SCHEDULE is an ordinary routine (`routines`, kind 'ai') named
//     `high-agency:<slug>`, derived from the row by syncHighAgencyRoutine(). It
//     is never hand-edited: saving the panel rewrites it. Reusing the routine
//     scheduler is what gives a wake the guards every job already has — one
//     wake in flight at a time (max_queue_depth 1), the over-fire guard, the
//     K-failure auto-pause, the global routines kill switch, the session cap —
//     and makes every wake visible on Jobs → Executions. No host crontab and no
//     per-bot flow cron is involved. The scheduler matches cron in server time,
//     so refreshHighAgencyCrons() re-derives each cron from the install
//     timezone every few minutes; a DST change moves the cron with the clocks.
//   - The name prefix is `high-agency:` and NOT `agent:<slug>:` on purpose:
//     re-installing an agent file switches off every `agent:<slug>:*` routine
//     the file no longer lists (agent-templates.ts syncSchedules), which would
//     silently turn High Agency off on every re-install.
//   - Turning it off disables the routine; it is never deleted, so the wake
//     history on the Jobs page survives.
//   - A wake files a board card worked by the bot (agent_context = its slug,
//     assigned to the admin who switched it on). The card runs on the bot's own
//     model when the board can run it (an enabled model in Settings → Models),
//     else on the board default — never a model hard-coded here.
//   - Permissions are the two panel switches: file the one next project as a
//     board card (MAX_NEW_PROJECTS_PER_WAKE = 1), and propose a repeatable
//     workflow as a DRAFT (publishing stays the owner's click). Neither grants
//     send, spend, merge or deploy; those go to the owner's decision queue.
import { getDb } from '../../db/index.js'
import { getUserWorkspaces } from '../../middleware/workspace.js'
import { listWorkspaces } from '../workspaces.js'
import { logActivity } from '../../routes/feed.js'
import { fireRoutine, nextRunAt, type FireResult, type RoutineRow } from '../routine-scheduler.js'
import { resumeRoutine } from '../routine-auto-pause.js'
import type { ChatAgent } from './agent-defs.js'
import { botMayUseWorkspace, botWorkspaceAllowlist, narrowToBot } from './bot-workspaces.js'
import { cardModelForBot } from './bot-card-model.js'
import {
  DEFAULT_INSTALL_TIMEZONE,
  DEFAULT_LEVEL,
  HIGH_AGENCY_LEVELS,
  highAgencyCron,
  isHighAgencyLevel,
  isValidTimeZone,
  levelSummary,
  MAX_NEW_PROJECTS_PER_WAKE,
  runsPerDay,
  wakeTimes,
  type HighAgencyLevel,
} from '../../../../shared/high-agency.js'

export { HIGH_AGENCY_LEVELS, MAX_NEW_PROJECTS_PER_WAKE, highAgencyCron, wakeTimes }

/** How much of the bot's own instructions is copied into a wake's brief. */
const PERSONA_SNAPSHOT_CHARS = 4000

const WS_SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/

export class HighAgencyError extends Error {
  readonly status: number
  constructor(message: string, status = 400) {
    super(message)
    this.status = status
  }
}

export interface HighAgencySettings {
  slug: string
  enabled: boolean
  level: HighAgencyLevel
  workspace: string | null
  allow_cards: boolean
  allow_workflows: boolean
  run_as_user_id: number | null
  routine_id: number | null
  updated_by: string | null
  updated_at: string | null
}

interface Row {
  slug: string
  enabled: number
  level: number | null
  workspace: string | null
  allow_cards: number
  allow_workflows: number
  run_as_user_id: number | null
  routine_id: number | null
  updated_by: string | null
  updated_at: string
}

/** What a bot with no row looks like: off. */
export function defaultHighAgency(slug: string): HighAgencySettings {
  return {
    slug,
    enabled: false,
    level: DEFAULT_LEVEL,
    workspace: null,
    allow_cards: true,
    allow_workflows: true,
    run_as_user_id: null,
    routine_id: null,
    updated_by: null,
    updated_at: null,
  }
}

function mapRow(r: Row): HighAgencySettings {
  const level = Number(r.level)
  return {
    slug: r.slug,
    enabled: Number(r.enabled) === 1,
    level: isHighAgencyLevel(level) ? level : DEFAULT_LEVEL,
    workspace: r.workspace || null,
    allow_cards: Number(r.allow_cards) === 1,
    allow_workflows: Number(r.allow_workflows) === 1,
    run_as_user_id: r.run_as_user_id ?? null,
    routine_id: r.routine_id ?? null,
    updated_by: r.updated_by,
    updated_at: r.updated_at,
  }
}

export function getHighAgency(slug: string): HighAgencySettings {
  const r = getDb().prepare('SELECT * FROM agent_chat_high_agency WHERE slug = ?').get(slug) as Row | undefined
  return r ? mapRow(r) : defaultHighAgency(slug)
}

export function allHighAgency(): Map<string, HighAgencySettings> {
  const rows = getDb().prepare('SELECT * FROM agent_chat_high_agency').all() as Row[]
  return new Map(rows.map(r => [r.slug, mapRow(r)]))
}

// ── schedule ──

export function routineNameFor(slug: string): string {
  return `high-agency:${slug}`
}

/**
 * The install/operator timezone wakes are scheduled in: env
 * CC_INSTALL_TIMEZONE, else settings.install_timezone, else America/New_York.
 * An unknown zone name falls back to the default rather than breaking the cron.
 */
export function installTimeZone(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = (env.CC_INSTALL_TIMEZONE || '').trim()
  if (isValidTimeZone(fromEnv)) return fromEnv
  try {
    const row = getDb().prepare("SELECT value FROM settings WHERE key = 'install_timezone'").get() as { value: string } | undefined
    if (row && isValidTimeZone(row.value?.trim())) return row.value.trim()
  } catch { /* no settings table → the default */ }
  return DEFAULT_INSTALL_TIMEZONE
}

/** The server-time cron of a bot's wake routine, as the install timezone stands at `now`. */
export function cronFor(slug: string, level: HighAgencyLevel, now: Date = new Date()): string {
  return highAgencyCron(slug, level, { timeZone: installTimeZone(), at: now })
}

// ── model ──

/**
 * The model a wake card runs on: the model the bot is explicitly set to (its file
 * `model:`, or the bot-page override), IF the board can run that model (an
 * enabled row in Settings → Models). Otherwise null, and the card takes the
 * board's default.
 * Nothing here names a model, so a model added later (e.g. a new Claude) works
 * the day it is enabled.
 */
export function wakeModelFor(agent: ChatAgent): string | null {
  // One rule for every card a bot works on (obj 900796, bot-card-model.ts):
  // the bot's own model when it is an enabled registry row, else null.
  return cardModelForBot(agent)
}

// ── the wake's brief ──

export function highAgencyTitle(agent: Pick<ChatAgent, 'name'>): string {
  return `${agent.name}: High Agency wake`
}

/** "Operator" for user `operator` — the same name the server stamps on the owner's chat messages. */
export function ownerNameFor(userId: number | null): string {
  if (userId == null) return 'the owner'
  try {
    const u = getDb().prepare('SELECT username FROM users WHERE id = ?').get(userId) as { username: string } | undefined
    const name = u?.username?.trim()
    return name ? name.charAt(0).toUpperCase() + name.slice(1) : 'the owner'
  } catch {
    return 'the owner'
  }
}

/**
 * The activation prompt — the five steps, in order, worded as in the vault note
 * (decisions/2026-11-13-high-agency-activation-prompt-and-operating-loop.md).
 * `owner` is who approves consequential actions on this install ("Operator").
 * Kept as its own function so the test can hold it to the vault text verbatim.
 */
export function activationPrompt(owner: string): string {
  return [
    'You are waking in High Agency mode for your area of the business. You own your projects end to end. Do the following in order, then stop.',
    '',
    '1. Orient.',
    '   - Read the current objectives for your area in the knowledge base.',
    '   - Read the latest relevant data and metrics.',
    '   - List every board card you own (open, working, blocked, in review, or otherwise unfinished).',
    '',
    '2. Close the loop first.',
    '   - For each owned card, compare it to its success criteria.',
    '   - Mark done what has been met. Unblock what you can. Cancel what is obsolete.',
    '   - Write short learnings back to the knowledge base.',
    '   - Do not start new work until this pass is honest and complete.',
    '',
    '3. Choose the next project — only one.',
    '   - If, after the close-out, there is a single highest-leverage next project that would move your area forward, name it.',
    '   - Include: rationale (why this, why now), success criteria, and the metric you will use to know it worked.',
    '   - If nothing is worth doing right now, say so clearly, leave a short report, and stop. No busywork, no filler cards, no chores invented to look active.',
    '',
    '4. If you chose a project, file it and run it.',
    '   - File it as a board card you own, with the rationale, success criteria, and metric in the brief.',
    '   - Start it and manage it toward completion.',
    '   - Stay inside the spend cap, your workspace access list, and standing approval rules.',
    `   - Sends, spend, and deploys do not happen on your say-so — route them to the decision queue for ${owner}.`,
    `   - Do not merge, deploy, send messages in ${owner}'s name, or touch Shared secrets or PR 645.`,
    '',
    '5. Leave a short report note on this wake: what you closed, what you started (or why you started nothing), and any risks or asks for ' + owner + '.',
  ].join('\n')
}

type BriefAgent = Pick<ChatAgent, 'slug' | 'name' | 'description' | 'system_prompt' | 'knowledge_folders'>
type BriefSettings = Pick<HighAgencySettings, 'level' | 'workspace' | 'allow_cards' | 'allow_workflows'>

/**
 * The card a wake files. Everything the bot needs is in here, because the card
 * session does not see the bot's chat: the activation prompt (the operating
 * loop, verbatim), who it is (a snapshot of its own instructions), then HOW to
 * do each step on this board and exactly what it may and may not do.
 */
export function buildHighAgencyBrief(agent: BriefAgent, s: BriefSettings, owner = 'the owner'): string {
  const ws = s.workspace ?? 'general'
  const persona = agent.system_prompt.trim()
  const snapshot = persona.length > PERSONA_SNAPSHOT_CHARS ? `${persona.slice(0, PERSONA_SNAPSHOT_CHARS)}\n…(truncated)` : persona
  const H = '-H "X-CC-Session-Token: $CC_SESSION_TOKEN"'
  const lines: string[] = [
    `High Agency wake for ${agent.name} — a scheduled wake (level ${s.level}: ${levelSummary(s.level).toLowerCase()}), not a message from a person.`,
    '',
    activationPrompt(owner),
    '',
    '## Who you are (your own bot instructions, copied when High Agency was last saved)',
    '',
    agent.description ? `${agent.name} — ${agent.description}` : agent.name,
    '',
    snapshot || '(This bot has no written instructions. Work from its name and description.)',
    '',
    agent.knowledge_folders.length
      ? `Your knowledge folders: ${agent.knowledge_folders.join(', ')}.`
      : 'You have no knowledge folders of your own; use the workspace knowledge base.',
    '',
    '## How to do each step on this board',
    '',
    `A card you OWN is a card in workspace \`${ws}\` whose agent_context is \`${agent.slug}\`. That is the whole list you close out, and the only cards you change.`,
    '',
    '**1. Orient.**',
    '   ```bash',
    `   curl -sG "http://localhost:3002/api/docs/search" ${H} --data-urlencode 'q=<your area> objectives'`,
    `   curl -s "http://localhost:3002/api/internal/objectives?workspace=${ws}&include_terminal=0&fields=minimal" ${H} \\`,
    `     | node -e 'const a=JSON.parse(require("fs").readFileSync(0,"utf8"));for(const o of a.filter(o=>o.agent_context==="${agent.slug}"))console.log(o.id,o.status,o.title)'`,
    '   ```',
    `   Read one card in full (description, success criteria, last summary) with \`curl -s http://localhost:3002/api/internal/objectives/<id> ${H}\`. Earlier wakes are the cards titled "${highAgencyTitle(agent)}"; read the last one's report so you do not repeat it.`,
    '   Then read what the daily supervisor flagged on YOUR cards (orphaned, duplicate, stalled or over-budget work). Fix those first in step 2, on your own cards; a flag clears itself on the next daily review once the card is fixed:',
    '   ```bash',
    `   curl -s "http://localhost:3002/api/internal/supervisor/flags?bot=${agent.slug}" ${H}`,
    '   ```',
    '',
    '**2. Close the loop.** Only on cards you own:',
    '   - done / cancelled: `curl -s -X PATCH http://localhost:3002/api/internal/objectives/<id>/status -H \'Content-Type: application/json\' -d \'{"status":"done"}\'` (or `"cancelled"`). A refused transition is not yours to force — note it in the report.',
    '   - unblock or steer a running card: `curl -s -X POST http://localhost:3002/api/internal/objectives/<id>/message -H \'Content-Type: application/json\' -d \'{"message":"<what to do next>"}\'`',
    '   - learnings: a short note through the knowledge-base API (`PUT http://localhost:3002/api/docs/file` with your session token), in your area\'s folder.',
    '',
  ]
  if (s.allow_cards) {
    lines.push(
      `**4. File and start the project** — at most ${MAX_NEW_PROJECTS_PER_WAKE} new card on this wake. You own it: agent_context \`${agent.slug}\`, workspace \`${ws}\`, linked to this wake with \`source_job_id\`:`,
      '   ```bash',
      '   curl -s -X POST http://localhost:3002/api/internal/objectives -H \'Content-Type: application/json\' \\',
      `     -d '[{"title":"<project>","description":"<rationale (why this, why now) + what to do>","acceptance_criteria":[{"id":"c1","criterion":"<success criterion>"}],"completion_goal":"<the metric that shows it worked>","agent_context":"${agent.slug}","workspace":"${ws}","type":"task","source_job_id":'"$CC_OBJECTIVE_ID"'}]'`,
      '   curl -s -X PATCH http://localhost:3002/api/internal/objectives/<new id>/status -H \'Content-Type: application/json\' -d \'{"status":"working"}\'',
      '   ```',
      '   A 409 with `existing_id` means that card already exists — do not file a twin; manage the existing one. "Manage it toward completion" means: the project runs as its own card, and every later wake\'s close-out pass checks it against its success criteria and steers, closes or cancels it. Do not hold this wake card open to babysit it.',
    )
  } else {
    lines.push(
      '**4. Filing cards is switched OFF for this bot\'s wakes.** Do not file or start any card. If you chose a project, put it in your report (title, rationale, success criteria, metric) for the owner to file.',
    )
  }
  if (s.allow_workflows) {
    lines.push(
      '   If the project you chose is work that recurs (the same steps every day or week), you may propose it as a repeatable workflow instead. It is a DRAFT — nothing runs until the owner publishes it:',
      '   ```bash',
      `   curl -s -X POST http://localhost:3002/api/flows ${H} -H 'Content-Type: application/json' \\`,
      `     -d '{"workspace":"${ws}","name":"<short name>","goal":"<what recurs, how often, what done looks like>"}'`,
      '   ```',
    )
  }
  lines.push(
    '',
    `**Decision queue.** Anything that needs a send, spend or deploy — or ${owner}'s judgement — is an ask, not an action: write the exact ask (what, why, cost) in your report and record this wake's disposition as \`needs_review\`.`,
    '',
    '**5. Report.** Finish with the short report note (closed / started or why nothing / risks and asks), then record the disposition — `needs_review` if you started a project or have an ask, otherwise `complete`:',
    '   ```bash',
    '   curl -s -X POST http://localhost:3002/api/internal/objectives/$CC_OBJECTIVE_ID/job-disposition -H \'Content-Type: application/json\' -d \'{"disposition":"complete","note":"<one-line report>"}\'',
    '   ```',
    '',
    '## Limits on a wake',
    '',
    `- At most ${MAX_NEW_PROJECTS_PER_WAKE} new project per wake. Close out first; no busywork, filler cards or chores.`,
    `- Change, close or cancel only cards you own (agent_context \`${agent.slug}\`). Stay in workspace \`${ws}\`.`,
    `- Never send email or messages to people, spend money, merge, deploy, publish a workflow or approve its send/spend steps, or grant yourself a permission. Those go to ${owner}'s decision queue.`,
    '- Stay inside this card\'s spend cap and the cap on any card you file.',
  )
  return lines.join('\n')
}

function templateFor(agent: ChatAgent, s: HighAgencySettings): Record<string, unknown> {
  const tpl: Record<string, unknown> = {
    title: highAgencyTitle(agent),
    description: buildHighAgencyBrief(agent, s, ownerNameFor(s.run_as_user_id)),
    agent_context: agent.slug,
    type: 'task',
    completion_goal:
      'Run one pass of the High Agency operating loop for this bot\'s area, in order: orient; close out every owned card honestly ' +
      '(done / unblocked / cancelled, learnings written back); then either choose ONE next project with rationale, success criteria and ' +
      'a metric — filed and started as an owned card if permitted — or state that nothing is worth doing now. ' +
      'End with a short report: what was closed, what was started (or why nothing), risks and asks for the owner.',
  }
  const model = wakeModelFor(agent)
  if (model) tpl.model = model
  if (s.workspace) tpl.workspace = s.workspace
  if (s.run_as_user_id != null) tpl.assigned_user_id = s.run_as_user_id
  return tpl
}

// ── routine sync ──

function routineRow(id: number | null, slug: string): RoutineRow | undefined {
  const db = getDb()
  if (id != null) {
    const r = db.prepare('SELECT * FROM routines WHERE id = ?').get(id) as RoutineRow | undefined
    if (r) return r
  }
  return db.prepare('SELECT * FROM routines WHERE name = ?').get(routineNameFor(slug)) as RoutineRow | undefined
}

/**
 * Make the bot's managed routine match its High Agency row: schedule, brief,
 * model and on/off. Creates the routine the first time it is needed (switched
 * on, or a Wake now); otherwise an off bot with no routine stays without one.
 */
export function syncHighAgencyRoutine(
  agent: ChatAgent,
  s: HighAgencySettings,
  opts: { create?: boolean; keepRunState?: boolean; now?: Date } = {},
): RoutineRow | null {
  const db = getDb()
  const existing = routineRow(s.routine_id, agent.slug)
  if (!existing && !s.enabled && !opts.create) return null
  const cron = cronFor(agent.slug, s.level, opts.now)
  const tpl = JSON.stringify(templateFor(agent, s))
  let id: number
  if (existing) {
    db.prepare("UPDATE routines SET cron_expr = ?, objective_template = ?, kind = 'ai', max_queue_depth = 1 WHERE id = ?").run(cron, tpl, existing.id)
    id = existing.id
  } else {
    id = Number(
      db.prepare("INSERT INTO routines (name, cron_expr, objective_template, enabled, max_queue_depth, kind) VALUES (?, ?, ?, 0, 1, 'ai')")
        .run(routineNameFor(agent.slug), cron, tpl).lastInsertRowid,
    )
  }
  const wasEnabled = existing ? Number(existing.enabled) === 1 : false
  // keepRunState (the boot resync, a bot-config change): refresh schedule +
  // brief only. A routine an operator paused on the Jobs page, or that
  // auto-paused, stays paused until someone saves the panel again.
  if (opts.keepRunState && existing) {
    // run state untouched
  } else if (s.enabled && (!wasEnabled || existing?.auto_paused_at)) {
    // Switching on (or saving while auto-paused) is the operator's explicit
    // "run this": same effect as Resume on the Jobs page.
    resumeRoutine(id, `high-agency:${s.updated_by ?? 'admin'}`)
  } else if (!s.enabled && wasEnabled) {
    db.prepare('UPDATE routines SET enabled = 0 WHERE id = ?').run(id)
  }
  if (s.routine_id !== id) db.prepare('UPDATE agent_chat_high_agency SET routine_id = ? WHERE slug = ?').run(id, agent.slug)
  return db.prepare('SELECT * FROM routines WHERE id = ?').get(id) as RoutineRow
}

/**
 * Re-derive each High Agency cron from the install timezone. The routine
 * scheduler matches cron in server time (UTC), so a wake at 02:xx New York is
 * 07:xx UTC in winter and 06:xx in summer; this moves the cron when the clocks
 * change. Touches cron_expr only — never the brief or the run state.
 */
export function refreshHighAgencyCrons(now: Date = new Date()): number {
  const db = getDb()
  let changed = 0
  let rows: HighAgencySettings[]
  try { rows = [...allHighAgency().values()] } catch { return 0 }
  for (const s of rows) {
    if (s.routine_id == null) continue
    const cron = cronFor(s.slug, s.level, now)
    changed += db.prepare('UPDATE routines SET cron_expr = ? WHERE id = ? AND cron_expr != ?').run(cron, s.routine_id, cron).changes
  }
  return changed
}

const CRON_REFRESH_MS = 10 * 60_000
let refreshTimer: ReturnType<typeof setInterval> | null = null

/** Start the DST refresher (never on a scratch instance — index.ts calls it with the other schedulers). */
export function startHighAgencyCronRefresh(): void {
  if (refreshTimer) return
  refreshTimer = setInterval(() => {
    try {
      const n = refreshHighAgencyCrons()
      if (n) console.log(`[high-agency] moved ${n} wake schedule(s) to the install timezone's current offset (${installTimeZone()})`)
    } catch (err) {
      console.warn('[high-agency] cron refresh failed:', err instanceof Error ? err.message : err)
    }
  }, CRON_REFRESH_MS)
  refreshTimer.unref?.()
}

export function stopHighAgencyCronRefresh(): void {
  if (refreshTimer) clearInterval(refreshTimer)
  refreshTimer = null
}

// ── save ──

export interface HighAgencyPatch {
  enabled?: unknown
  level?: unknown
  workspace?: unknown
  allow_cards?: unknown
  allow_workflows?: unknown
  times_per_day?: unknown
  first_hour?: unknown
}

function bool(v: unknown, name: string): boolean {
  if (typeof v !== 'boolean') throw new HighAgencyError(`${name} must be true or false`)
  return v
}

/**
 * The workspaces an admin may point a bot's wakes at: theirs, else every
 * workspace — and, given a bot (obj 900797), only the ones that bot is granted.
 * When the admin belongs to none of the bot's workspaces, the bot's granted
 * workspaces are offered (an admin may act install-wide).
 */
export function workspaceOptions(userId: number, botSlug?: string): string[] {
  const mine = getUserWorkspaces(userId).map(w => w.workspace)
  let all: string[] = []
  try { all = listWorkspaces().map(w => w.slug) } catch { all = [] }
  const base = mine.length ? mine : all
  if (!botSlug) return base
  const allow = botWorkspaceAllowlist(botSlug)
  if (allow === null) return base
  const narrowed = narrowToBot(botSlug, base)
  return narrowed.length ? narrowed : allow.filter(w => all.includes(w))
}

/** The refusal for a wake workspace this bot may not use (obj 900797). */
function notGranted(agent: Pick<ChatAgent, 'name'>, ws: string | null): HighAgencyError {
  return ws
    ? new HighAgencyError(`${agent.name} is not granted workspace "${ws}". Grant it under Workspace access first.`, 403)
    : new HighAgencyError(`${agent.name} has no workspace it may wake in. Grant one under Workspace access first.`, 409)
}

export function setHighAgency(
  agent: ChatAgent,
  patch: HighAgencyPatch,
  actor: { id: number; username: string },
): HighAgencySettings {
  // The cadence picker's fields are gone (obj 900794). Refuse them loudly
  // rather than silently saving a schedule the caller did not ask for.
  if (patch.times_per_day !== undefined || patch.first_hour !== undefined) {
    throw new HighAgencyError('times_per_day and first_hour were replaced by level (1-10)')
  }
  const cur = getHighAgency(agent.slug)
  const next: HighAgencySettings = { ...cur }
  if (patch.enabled !== undefined) next.enabled = bool(patch.enabled, 'enabled')
  if (patch.allow_cards !== undefined) next.allow_cards = bool(patch.allow_cards, 'allow_cards')
  if (patch.allow_workflows !== undefined) next.allow_workflows = bool(patch.allow_workflows, 'allow_workflows')
  if (patch.level !== undefined) {
    if (!isHighAgencyLevel(patch.level)) throw new HighAgencyError(`level must be a whole number from ${HIGH_AGENCY_LEVELS[0]} to ${HIGH_AGENCY_LEVELS[HIGH_AGENCY_LEVELS.length - 1]}`)
    next.level = patch.level
  }
  if (patch.workspace !== undefined) {
    const w = patch.workspace
    if (w === null || w === '') next.workspace = null
    else if (typeof w !== 'string' || !WS_SLUG.test(w)) throw new HighAgencyError('workspace must be a workspace slug')
    else {
      // obj 900797: granted-to-the-bot first, then the same option list the panel's picker shows.
      if (!botMayUseWorkspace(agent.slug, w)) throw notGranted(agent, w)
      const options = workspaceOptions(actor.id, agent.slug)
      if (options.length && !options.includes(w)) throw new HighAgencyError(`You are not a member of workspace "${w}"`, 403)
      next.workspace = w
    }
  }
  // Switching on fills in where the wake cards land and who they belong to, so
  // a wake is never an unassigned card in an arbitrary workspace.
  if (next.enabled) {
    if (!next.workspace) next.workspace = workspaceOptions(actor.id, agent.slug)[0] ?? null
    // obj 900797: a bot only wakes in a workspace it is granted.
    if (!botMayUseWorkspace(agent.slug, next.workspace)) throw notGranted(agent, next.workspace)
    next.run_as_user_id = actor.id
  }
  next.updated_by = actor.username

  getDb()
    .prepare(
      `INSERT INTO agent_chat_high_agency (slug, enabled, level, workspace, allow_cards, allow_workflows, run_as_user_id, routine_id, updated_by, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(slug) DO UPDATE SET enabled = excluded.enabled, level = excluded.level,
         workspace = excluded.workspace, allow_cards = excluded.allow_cards,
         allow_workflows = excluded.allow_workflows, run_as_user_id = excluded.run_as_user_id,
         updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    )
    .run(
      agent.slug, next.enabled ? 1 : 0, next.level, next.workspace,
      next.allow_cards ? 1 : 0, next.allow_workflows ? 1 : 0, next.run_as_user_id, next.routine_id, next.updated_by,
    )
  const saved = getHighAgency(agent.slug)
  syncHighAgencyRoutine(agent, saved)

  if (cur.enabled !== saved.enabled || cur.level !== saved.level) {
    try {
      logActivity({
        project: 'operationkit',
        workspace: saved.workspace ?? undefined,
        event_type: 'decision',
        title: saved.enabled
          ? `High Agency on for ${agent.name} (level ${saved.level}: ${levelSummary(saved.level).toLowerCase()})`
          : `High Agency off for ${agent.name}`,
        detail: saved.enabled ? `Wakes at ${wakeTimes(agent.slug, saved.level).join(', ')} ${installTimeZone()}` : null,
        metadata: { kind: 'high_agency_changed', slug: agent.slug, enabled: saved.enabled, level: saved.level, runs_per_day: runsPerDay(saved.level), actor: actor.username },
      })
    } catch { /* the activity feed is best-effort */ }
  }
  return getHighAgency(agent.slug)
}

// ── what the panel shows ──

export interface HighAgencyView extends HighAgencySettings {
  runs_per_day: number
  /** "02:17" … in `timezone`. */
  wake_times: string[]
  /** The install timezone the wake times are in (IANA name). */
  timezone: string
  /** Server-time cron of the routine (what the Jobs page shows). */
  cron: string
  /** The model a wake card runs on; null = the board's default model. */
  wake_model: string | null
  next_wake_at: string | null
  routine: {
    id: number
    enabled: boolean
    last_run_at: string | null
    auto_paused_at: string | null
    auto_pause_reason: string | null
  } | null
  last_wake: { objective_id: number; status: string; created_at: string } | null
}

export function highAgencyView(slug: string, now: Date = new Date(), agent?: ChatAgent | null): HighAgencyView {
  const s = getHighAgency(slug)
  const cron = cronFor(slug, s.level, now)
  const r = s.routine_id != null || s.enabled ? routineRow(s.routine_id, slug) : undefined
  let last: HighAgencyView['last_wake'] = null
  if (r) {
    const o = getDb()
      .prepare('SELECT id, status, created_at FROM objectives WHERE routine_id = ? ORDER BY id DESC LIMIT 1')
      .get(r.id) as { id: number; status: string; created_at: string } | undefined
    if (o) last = { objective_id: o.id, status: o.status, created_at: o.created_at }
  }
  const running = !!r && Number(r.enabled) === 1
  return {
    ...s,
    runs_per_day: runsPerDay(s.level),
    wake_times: wakeTimes(slug, s.level),
    timezone: installTimeZone(),
    cron,
    wake_model: agent ? wakeModelFor(agent) : null,
    next_wake_at: s.enabled && running ? nextRunAt(r!.cron_expr, now)?.toISOString() ?? null : null,
    routine: r
      ? {
          id: r.id,
          enabled: running,
          last_run_at: r.last_run_at,
          auto_paused_at: r.auto_paused_at ?? null,
          auto_pause_reason: r.auto_pause_reason ?? null,
        }
      : null,
    last_wake: last,
  }
}

// ── wake now ──

/**
 * The panel's "Wake now": one wake on demand, through the same routine fire
 * path the schedule uses (so it is guarded by one-wake-in-flight and shows on
 * Jobs → Executions). Works while High Agency is off too, so an admin can try a
 * wake before turning the schedule on; the routine stays disabled in that case.
 */
export async function wakeNow(agent: ChatAgent, actor: { id: number; username: string }): Promise<FireResult> {
  const s = getHighAgency(agent.slug)
  if (s.run_as_user_id == null || !s.workspace) {
    // First touch: record where the card lands and whose it is, without
    // switching the schedule on.
    getDb()
      .prepare(
        `INSERT INTO agent_chat_high_agency (slug, enabled, workspace, run_as_user_id, updated_by)
         VALUES (?, 0, ?, ?, ?)
         ON CONFLICT(slug) DO UPDATE SET workspace = COALESCE(agent_chat_high_agency.workspace, excluded.workspace),
           run_as_user_id = COALESCE(agent_chat_high_agency.run_as_user_id, excluded.run_as_user_id)`,
      )
      .run(agent.slug, s.workspace ?? workspaceOptions(actor.id, agent.slug)[0] ?? null, actor.id, actor.username)
  }
  const ws = getHighAgency(agent.slug).workspace
  if (!botMayUseWorkspace(agent.slug, ws)) throw notGranted(agent, ws)
  const routine = syncHighAgencyRoutine(agent, getHighAgency(agent.slug), { create: true })
  if (!routine) throw new HighAgencyError('Could not set up the wake', 500)
  return fireRoutine(routine, 'run-now')
}

// ── workspace access changed (obj 900797) ──

/**
 * After a bot loses a workspace: if its High Agency wakes pointed there, switch
 * High Agency off, clear the wake workspace and disable the managed routine, so
 * no wake ever lands in a workspace the bot was revoked from. (The routine
 * scheduler also refuses such a wake at fire time; this makes the panel say so.)
 * Returns true when it switched something off.
 */
export function reconcileHighAgencyAccess(slug: string, actor: string): boolean {
  let s: HighAgencySettings
  try { s = getHighAgency(slug) } catch { return false }
  if (!s.workspace || botMayUseWorkspace(slug, s.workspace)) return false
  const db = getDb()
  db.prepare("UPDATE agent_chat_high_agency SET enabled = 0, workspace = NULL, updated_by = ?, updated_at = datetime('now') WHERE slug = ?").run(actor, slug)
  const r = routineRow(s.routine_id, slug)
  if (r) db.prepare('UPDATE routines SET enabled = 0 WHERE id = ?').run(r.id)
  if (s.enabled) {
    try {
      logActivity({
        project: 'operationkit',
        workspace: s.workspace,
        event_type: 'decision',
        title: `High Agency off for ${slug}: workspace ${s.workspace} was revoked`,
        detail: null,
        metadata: { kind: 'high_agency_changed', slug, enabled: false, reason: 'workspace_revoked', workspace: s.workspace, actor },
      })
    } catch { /* the activity feed is best-effort */ }
  }
  return s.enabled
}

// ── boot / bot changes ──

/**
 * Re-render one bot's wake routine after something about the BOT changed (its
 * model, provider or tools on the bot page), keeping the run state. A bot with
 * no High Agency row is untouched.
 */
export function resyncHighAgencyFor(agent: ChatAgent): boolean {
  let s: HighAgencySettings
  try { s = getHighAgency(agent.slug) } catch { return false }
  if (!s.enabled && s.routine_id == null) return false
  return !!syncHighAgencyRoutine(agent, s, { keepRunState: true })
}

/**
 * Re-render every High Agency routine from the current agent files, once per
 * boot: an edited bot file reaches its next wake's brief, and a bot whose file
 * was removed stops waking (its routine is switched off, never deleted).
 */
export function resyncHighAgencyRoutines(agents: ChatAgent[]): { synced: number; disabled: number } {
  const db = getDb()
  let synced = 0
  let disabled = 0
  let rows: HighAgencySettings[]
  try { rows = [...allHighAgency().values()] } catch { return { synced, disabled } }
  for (const s of rows) {
    const agent = agents.find(a => a.slug === s.slug)
    if (!agent) {
      if (s.routine_id != null) {
        disabled += db.prepare('UPDATE routines SET enabled = 0 WHERE id = ? AND enabled = 1').run(s.routine_id).changes
      }
      continue
    }
    if (s.enabled || s.routine_id != null) {
      syncHighAgencyRoutine(agent, s, { keepRunState: true })
      synced++
    }
  }
  return { synced, disabled }
}
