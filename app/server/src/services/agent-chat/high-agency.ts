// ── High Agency: a per-bot "wake up and move your area forward" switch (obj 900748) ──
//
// Operator's idea (2026-11-12 walkthrough): an optional mode per bot. When it is
// on, the bot wakes a few times a day and asks itself "What's the next thing I
// need to do? If nothing is urgent, what can I do to help move my area of the
// business forward?" — and it may file board cards and propose repeatable
// workflows for recurring work.
//
// How it is built, and why:
//   - The SETTING is one row per bot in `agent_chat_high_agency`, edited on the
//     bot's settings panel. No row = off. That default is the whole safety
//     story for existing installs: nothing wakes until an admin switches it on.
//   - The SCHEDULE is an ordinary routine (`routines`, kind 'ai') named
//     `high-agency:<slug>`, derived from the row by syncHighAgencyRoutine(). It
//     is never hand-edited: saving the panel rewrites it. Reusing the routine
//     scheduler is what gives a wake the guards every job already has — one
//     wake in flight at a time (max_queue_depth 1), the over-fire guard, the
//     K-failure auto-pause, the global routines kill switch, the session cap —
//     and makes every wake visible on Jobs → Executions. No host crontab and no
//     per-bot flow cron is involved.
//   - The name prefix is `high-agency:` and NOT `agent:<slug>:` on purpose:
//     re-installing an agent file switches off every `agent:<slug>:*` routine
//     the file no longer lists (agent-templates.ts syncSchedules), which would
//     silently turn High Agency off on every re-install.
//   - Turning it off disables the routine; it is never deleted, so the wake
//     history on the Jobs page survives.
//   - A wake files a board card worked by the bot (agent_context = its slug,
//     assigned to the admin who switched it on). The card's brief carries the
//     high-agency question, a snapshot of the bot's own instructions, and the
//     exact permissions: board cards (at most MAX_CARDS_PER_WAKE) and workflow
//     PROPOSALS (a draft through POST /api/flows — publishing stays the owner's
//     click). Both permissions are switches on the panel.
import { getDb } from '../../db/index.js'
import { getUserWorkspaces } from '../../middleware/workspace.js'
import { listWorkspaces } from '../workspaces.js'
import { logActivity } from '../../routes/feed.js'
import { fireRoutine, nextRunAt, type FireResult, type RoutineRow } from '../routine-scheduler.js'
import { resumeRoutine } from '../routine-auto-pause.js'
import type { ChatAgent } from './agent-defs.js'
import {
  DEFAULT_FIRST_HOUR,
  HIGH_AGENCY_CADENCES,
  highAgencyCron,
  isHighAgencyCadence,
  MAX_CARDS_PER_WAKE,
  wakeTimes,
  type HighAgencyCadence,
} from '../../../../shared/high-agency.js'

export { HIGH_AGENCY_CADENCES, MAX_CARDS_PER_WAKE, highAgencyCron, wakeTimes }

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
  times_per_day: HighAgencyCadence
  first_hour: number
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
  times_per_day: number
  first_hour: number
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
    times_per_day: 1,
    first_hour: DEFAULT_FIRST_HOUR,
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
  const hour = Number(r.first_hour)
  return {
    slug: r.slug,
    enabled: Number(r.enabled) === 1,
    times_per_day: isHighAgencyCadence(Number(r.times_per_day)) ? (Number(r.times_per_day) as HighAgencyCadence) : 1,
    first_hour: Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : DEFAULT_FIRST_HOUR,
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

// ── the wake's brief ──

export function highAgencyTitle(agent: Pick<ChatAgent, 'name'>): string {
  return `${agent.name}: High Agency check`
}

/**
 * The card a wake files. Everything the bot needs is in here, because the card
 * session does not see the bot's chat: who it is (a snapshot of its own
 * instructions), the question, what it may do, and what it must not.
 */
export function buildHighAgencyBrief(
  agent: Pick<ChatAgent, 'slug' | 'name' | 'description' | 'system_prompt' | 'knowledge_folders'>,
  s: Pick<HighAgencySettings, 'times_per_day' | 'workspace' | 'allow_cards' | 'allow_workflows'>,
): string {
  const ws = s.workspace ?? 'general'
  const persona = agent.system_prompt.trim()
  const snapshot = persona.length > PERSONA_SNAPSHOT_CHARS ? `${persona.slice(0, PERSONA_SNAPSHOT_CHARS)}\n…(truncated)` : persona
  const lines: string[] = [
    `High Agency check for ${agent.name} — a scheduled wake (${s.times_per_day}x a day), not a message from a person.`,
    '',
    'Ask yourself, as this bot:',
    '',
    '> What\'s the next thing I need to do? If there\'s nothing urgent, what can I do to help move my area of the business forward?',
    '',
    'Then do the most valuable small thing, or set it up so it gets done. Doing nothing is a fine answer when nothing is worth doing — say so and finish. No busywork.',
    '',
    '## Who you are (your own bot instructions, copied when High Agency was last saved)',
    '',
    agent.description ? `${agent.name} — ${agent.description}` : agent.name,
    '',
    snapshot || '(This bot has no written instructions. Work from its name and description.)',
    '',
    agent.knowledge_folders.length
      ? `Your knowledge folders: ${agent.knowledge_folders.join(', ')} (read them through the knowledge-base API for workspace \`${ws}\`).`
      : 'You have no knowledge folders.',
    '',
    '## How to run this check',
    '',
    `1. Look first. Read the open board for workspace \`${ws}\` and anything recent in your area:`,
    '   ```bash',
    `   curl -s "http://localhost:3002/api/internal/objectives?workspace=${ws}&include_terminal=0&fields=minimal" -H "X-CC-Session-Token: $CC_SESSION_TOKEN"`,
    '   ```',
    `   Check what earlier High Agency wakes already filed (cards titled "${highAgencyTitle(agent)}" and the cards they link to) so you never file the same idea twice.`,
    '2. Pick at most three concrete moves. Prefer finishing or unblocking something already on the board over starting something new.',
  ]
  if (s.allow_cards) {
    lines.push(
      `3. **You may write cards to the board** — at most ${MAX_CARDS_PER_WAKE} new cards on this wake, each a self-contained brief (what, why now, done when). Link them back to this wake with \`source_job_id\`:`,
      '   ```bash',
      '   curl -s -X POST http://localhost:3002/api/internal/objectives -H \'Content-Type: application/json\' \\',
      `     -d '[{"title":"<card>","description":"<full brief: what, why now, done when>","agent_context":"${agent.slug}","workspace":"${ws}","type":"task","source_job_id":'"$CC_OBJECTIVE_ID"'}]'`,
      '   ```',
      '   A 409 with `existing_id` means that card already exists — leave it, mention it in your summary.',
    )
  } else {
    lines.push('3. Board cards are switched OFF for this bot\'s wakes. Do not file any. Write the cards you would have filed into your summary instead.')
  }
  if (s.allow_workflows) {
    lines.push(
      '4. **You may propose repeatable workflows.** If you see work in your area that recurs (the same steps every day or week), propose it as a workflow instead of doing it by hand again. One call files a draft-builder card; it is a PROPOSAL — nothing runs until the owner publishes it:',
      '   ```bash',
      '   curl -s -X POST http://localhost:3002/api/flows -H "X-CC-Session-Token: $CC_SESSION_TOKEN" -H \'Content-Type: application/json\' \\',
      `     -d '{"workspace":"${ws}","name":"<short name>","goal":"<what recurs, how often, what done looks like>"}'`,
      '   ```',
      '   Never publish a workflow, and never approve its send/spend steps. That is always the owner\'s click.',
    )
  } else {
    lines.push('4. Workflow proposals are switched OFF for this bot\'s wakes. If you spot recurring work, describe it in your summary instead.')
  }
  lines.push(
    '5. Finish with a short summary: what you looked at, the cards you filed (#ids), the workflows you proposed, and what you would look at on the next wake. Then record your job disposition: `needs_review` if you filed cards or proposed a workflow the owner should look at, otherwise `complete`.',
    '',
    '## Limits on a wake',
    '',
    '- Never send email or messages to people, merge, deploy, publish a workflow, spend money, or change or close cards you did not file.',
    '- Stay in your own area and in workspace `' + ws + '`.',
    '- Keep the wake short: this is a check-in, not a project. Bigger work belongs on a card.',
  )
  return lines.join('\n')
}

function templateFor(agent: ChatAgent, s: HighAgencySettings): Record<string, unknown> {
  const tpl: Record<string, unknown> = {
    title: highAgencyTitle(agent),
    description: buildHighAgencyBrief(agent, s),
    agent_context: agent.slug,
    type: 'task',
    completion_goal:
      'Answer the High Agency question for this bot\'s area: either act on the next most valuable thing (filing at most ' +
      `${MAX_CARDS_PER_WAKE} board cards and/or proposing a repeatable workflow, as permitted) or state that nothing is worth doing now. ` +
      'End with a summary that lists every card id filed and workflow proposed.',
  }
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
 * Make the bot's managed routine match its High Agency row: cadence, brief and
 * on/off. Creates the routine the first time it is needed (switched on, or a
 * Wake now); otherwise an off bot with no routine stays without one.
 */
export function syncHighAgencyRoutine(
  agent: ChatAgent,
  s: HighAgencySettings,
  opts: { create?: boolean; keepRunState?: boolean } = {},
): RoutineRow | null {
  const db = getDb()
  const existing = routineRow(s.routine_id, agent.slug)
  if (!existing && !s.enabled && !opts.create) return null
  const cron = highAgencyCron(agent.slug, s.times_per_day, s.first_hour)
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
  // keepRunState (the boot resync): refresh cadence + brief only. A routine an
  // operator paused on the Jobs page, or that auto-paused, stays paused until
  // someone saves the panel again — a restart must never un-pause it.
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

// ── save ──

export interface HighAgencyPatch {
  enabled?: unknown
  times_per_day?: unknown
  first_hour?: unknown
  workspace?: unknown
  allow_cards?: unknown
  allow_workflows?: unknown
}

function bool(v: unknown, name: string): boolean {
  if (typeof v !== 'boolean') throw new HighAgencyError(`${name} must be true or false`)
  return v
}

/** The workspaces an admin may point a bot's wakes at: theirs, else every workspace. */
export function workspaceOptions(userId: number): string[] {
  const mine = getUserWorkspaces(userId).map(w => w.workspace)
  if (mine.length) return mine
  try { return listWorkspaces().map(w => w.slug) } catch { return [] }
}

export function setHighAgency(
  agent: ChatAgent,
  patch: HighAgencyPatch,
  actor: { id: number; username: string },
): HighAgencySettings {
  const cur = getHighAgency(agent.slug)
  const next: HighAgencySettings = { ...cur }
  if (patch.enabled !== undefined) next.enabled = bool(patch.enabled, 'enabled')
  if (patch.allow_cards !== undefined) next.allow_cards = bool(patch.allow_cards, 'allow_cards')
  if (patch.allow_workflows !== undefined) next.allow_workflows = bool(patch.allow_workflows, 'allow_workflows')
  if (patch.times_per_day !== undefined) {
    if (!isHighAgencyCadence(patch.times_per_day)) throw new HighAgencyError(`times_per_day must be one of ${HIGH_AGENCY_CADENCES.join(', ')}`)
    next.times_per_day = patch.times_per_day
  }
  if (patch.first_hour !== undefined) {
    const h = patch.first_hour
    if (typeof h !== 'number' || !Number.isInteger(h) || h < 0 || h > 23) throw new HighAgencyError('first_hour must be a whole hour from 0 to 23 (UTC)')
    next.first_hour = h
  }
  if (patch.workspace !== undefined) {
    const w = patch.workspace
    if (w === null || w === '') next.workspace = null
    else if (typeof w !== 'string' || !WS_SLUG.test(w)) throw new HighAgencyError('workspace must be a workspace slug')
    else {
      const options = workspaceOptions(actor.id)
      if (options.length && !options.includes(w)) throw new HighAgencyError(`You are not a member of workspace "${w}"`, 403)
      next.workspace = w
    }
  }
  // Switching on fills in where the wake cards land and who they belong to, so
  // a wake is never an unassigned card in an arbitrary workspace.
  if (next.enabled) {
    if (!next.workspace) next.workspace = workspaceOptions(actor.id)[0] ?? null
    next.run_as_user_id = actor.id
  }
  next.updated_by = actor.username

  getDb()
    .prepare(
      `INSERT INTO agent_chat_high_agency (slug, enabled, times_per_day, first_hour, workspace, allow_cards, allow_workflows, run_as_user_id, routine_id, updated_by, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(slug) DO UPDATE SET enabled = excluded.enabled, times_per_day = excluded.times_per_day,
         first_hour = excluded.first_hour, workspace = excluded.workspace, allow_cards = excluded.allow_cards,
         allow_workflows = excluded.allow_workflows, run_as_user_id = excluded.run_as_user_id,
         updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    )
    .run(
      agent.slug, next.enabled ? 1 : 0, next.times_per_day, next.first_hour, next.workspace,
      next.allow_cards ? 1 : 0, next.allow_workflows ? 1 : 0, next.run_as_user_id, next.routine_id, next.updated_by,
    )
  const saved = getHighAgency(agent.slug)
  syncHighAgencyRoutine(agent, saved)

  if (cur.enabled !== saved.enabled || cur.times_per_day !== saved.times_per_day || cur.first_hour !== saved.first_hour) {
    try {
      logActivity({
        project: 'operationkit',
        workspace: saved.workspace ?? undefined,
        event_type: 'decision',
        title: saved.enabled
          ? `High Agency on for ${agent.name} (${saved.times_per_day}x a day)`
          : `High Agency off for ${agent.name}`,
        detail: saved.enabled ? `Wakes at ${wakeTimes(agent.slug, saved.times_per_day, saved.first_hour).join(', ')} UTC` : null,
        metadata: { kind: 'high_agency_changed', slug: agent.slug, enabled: saved.enabled, times_per_day: saved.times_per_day, actor: actor.username },
      })
    } catch { /* the activity feed is best-effort */ }
  }
  return getHighAgency(agent.slug)
}

// ── what the panel shows ──

export interface HighAgencyView extends HighAgencySettings {
  /** "09:17" … in UTC. */
  wake_times: string[]
  cron: string
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

export function highAgencyView(slug: string, now: Date = new Date()): HighAgencyView {
  const s = getHighAgency(slug)
  const cron = highAgencyCron(slug, s.times_per_day, s.first_hour)
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
    wake_times: wakeTimes(slug, s.times_per_day, s.first_hour),
    cron,
    next_wake_at: s.enabled && running ? nextRunAt(cron, now)?.toISOString() ?? null : null,
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
      .run(agent.slug, s.workspace ?? workspaceOptions(actor.id)[0] ?? null, actor.id, actor.username)
  }
  const routine = syncHighAgencyRoutine(agent, getHighAgency(agent.slug), { create: true })
  if (!routine) throw new HighAgencyError('Could not set up the wake', 500)
  return fireRoutine(routine, 'run-now')
}

// ── boot ──

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
