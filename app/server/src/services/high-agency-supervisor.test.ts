import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'

// High Agency supervisor (obj 900795). Private in-memory DB per test with the
// slice of the real schema the supervisor reads: objectives, settings, users,
// routines, agent_chat_high_agency. review_items / job accounting / the run log
// are created by the services' own lazy schema init — the migration path itself.
// The supervisor never calls getDb: every function gets the handle explicitly.

const {
  fileFlags,
  flagDedupeKey,
  listSupervisorRuns,
  loadSupervisedBots,
  operatorDate,
  reviewHighAgencyWork,
  runSupervisor,
  SUPERVISOR_ACTOR,
} = await import('./high-agency-supervisor.js')
const { decideReviewItem, getReviewItem, listReviewItemEvents, listReviewItems, snoozeReviewItem } = await import('./review-items.js')
const { setObjectiveCeiling, recordSpend } = await import('./job-accounting.js')

const NOW = new Date('2026-11-14T15:00:00.000Z') // 10:00 America/New_York
const DAY = 24 * 60 * 60 * 1000
let db: Database.Database

function iso(msAgo: number): string {
  return new Date(NOW.getTime() - msAgo).toISOString()
}

beforeEach(() => {
  db = new Database(':memory:')
  db.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, role TEXT NOT NULL DEFAULT 'member');
    CREATE TABLE routines (
      id INTEGER PRIMARY KEY, name TEXT, cron_expr TEXT, objective_template TEXT, enabled INTEGER NOT NULL DEFAULT 1,
      max_queue_depth INTEGER, kind TEXT, last_run_at TEXT, auto_paused_at TEXT, auto_pause_reason TEXT
    );
    CREATE TABLE agent_chat_high_agency (
      slug TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0, times_per_day INTEGER NOT NULL DEFAULT 1,
      first_hour INTEGER NOT NULL DEFAULT 9, workspace TEXT, allow_cards INTEGER NOT NULL DEFAULT 1,
      allow_workflows INTEGER NOT NULL DEFAULT 1, run_as_user_id INTEGER, routine_id INTEGER,
      updated_by TEXT, updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE objectives (
      id INTEGER PRIMARY KEY, title TEXT, status TEXT NOT NULL DEFAULT 'working', workspace TEXT,
      agent_context TEXT, parent_id INTEGER, routine_id INTEGER, source_job_id INTEGER, session_id TEXT,
      has_blockers INTEGER NOT NULL DEFAULT 0, blocked_reason TEXT, ai_review_verdict TEXT, needs_secret TEXT,
      deleted_at TEXT, created_at TEXT, updated_at TEXT
    );
  `)
  // Operator is the admin who switched High Agency on for both bots.
  db.prepare("INSERT INTO users (id, username, role) VALUES (1, 'operator', 'admin'), (2, 'teammate', 'member')").run()
  // sales-bot: on and waking. ops-bot: High Agency on but its routine auto-paused (it will NOT wake).
  db.prepare("INSERT INTO routines (id, name, enabled) VALUES (10, 'high-agency:sales-bot', 1), (11, 'high-agency:ops-bot', 1)").run()
  db.prepare("UPDATE routines SET auto_paused_at = ? WHERE id = 11").run(iso(DAY))
  db.prepare(`INSERT INTO agent_chat_high_agency (slug, enabled, workspace, run_as_user_id, routine_id)
              VALUES ('sales-bot', 1, 'operationkit', 1, 10), ('ops-bot', 1, 'operationkit', 1, 11)`).run()
})

const KNOWN = ['sales-bot', 'ops-bot', 'general']

function card(id: number, fields: Record<string, unknown> = {}): void {
  const row = {
    title: `Card ${id}`, status: 'working', workspace: 'operationkit', agent_context: 'sales-bot',
    updated_at: iso(60_000), created_at: iso(60_000), ...fields,
  }
  const cols = Object.keys(row)
  db.prepare(`INSERT INTO objectives (id, ${cols.join(', ')}) VALUES (?, ${cols.map(() => '?').join(', ')})`)
    .run(id, ...cols.map((c) => (row as Record<string, unknown>)[c]))
}

function review(opts: { knownBots?: string[] } = {}) {
  return reviewHighAgencyWork(db, { now: NOW, knownBots: opts.knownBots ?? KNOWN })
}

describe('scope and bots', () => {
  it('knows which bots will actually wake', () => {
    const bots = loadSupervisedBots(db, KNOWN)
    expect(bots.find((b) => b.slug === 'sales-bot')).toMatchObject({ enabled: true, exists: true, awake: true, owner_username: 'operator' })
    expect(bots.find((b) => b.slug === 'ops-bot')).toMatchObject({ enabled: true, awake: false })
  })

  it('a healthy board produces no flags', () => {
    card(1)
    card(2, { title: 'Something else' })
    const r = review()
    expect(r.cards).toBe(2)
    expect(r.flags).toEqual([])
  })

  it('does nothing when no bot has High Agency', () => {
    db.exec('DELETE FROM agent_chat_high_agency')
    card(1, { agent_context: null })
    expect(review().flags).toEqual([])
  })

  it('ignores cards that belong to nobody in a High Agency area (Operator\'s own manual cards)', () => {
    card(1, { agent_context: 'general' })
    card(2, { agent_context: null })
    const r = review()
    expect(r.cards).toBe(0)
    expect(r.flags).toEqual([])
  })

  it('ignores closed and soft-deleted cards', () => {
    card(1, { agent_context: null, status: 'done', source_job_id: 50 })
    card(50, { routine_id: 10, status: 'done', title: 'Sales: High Agency check' })
    card(2, { agent_context: null, deleted_at: iso(1), source_job_id: 50 })
    expect(review().flags).toEqual([])
  })
})

describe('flag 1 — orphaned (always routed to Operator)', () => {
  it('a card filed by a wake with no owner is orphaned → human:operator', () => {
    card(50, { routine_id: 10, status: 'done', title: 'Sales: High Agency check' })
    card(51, { agent_context: null, source_job_id: 50, title: 'Follow up on churned accounts' })
    const [f] = review().flags
    expect(f).toMatchObject({ kind: 'orphaned', objective_id: 51, route: 'human', routed_to: 'human:operator', owner: null })
    expect(f.why).toContain("sales-bot's High Agency wake")
  })

  it('a wake card handed to a non-area agent ("general") is orphaned', () => {
    card(50, { routine_id: 10, status: 'done', title: 'Sales: High Agency check' })
    card(52, { agent_context: 'general', parent_id: 50 })
    expect(review().flags).toEqual([expect.objectContaining({ kind: 'orphaned', objective_id: 52, fingerprint: 'not_area_bot:general' })])
  })

  it('a card owned by a bot whose file was removed is orphaned', () => {
    card(53, { agent_context: 'sales-bot' })
    const flags = review({ knownBots: ['ops-bot'] }).flags
    expect(flags).toEqual([expect.objectContaining({ kind: 'orphaned', objective_id: 53, route: 'human', fingerprint: 'bot_removed:sales-bot' })])
  })
})

describe('flag 2 — duplicate', () => {
  it('two open cards with the same title, same awake owner → routed to that bot', () => {
    card(60, { title: 'Refresh the pricing page' })
    card(61, { title: 'Refresh the pricing page (copy)' })
    const [f] = review().flags
    expect(f).toMatchObject({ kind: 'duplicate', objective_id: 61, related_ids: [60], route: 'bot', routed_to: 'agent:sales-bot' })
  })

  it('a bot re-filing a card Operator already has → different owners → routed to Operator', () => {
    card(62, { title: 'Fix onboarding email', agent_context: 'general' })
    card(63, { title: 'Fix onboarding email!', agent_context: 'sales-bot' })
    const [f] = review().flags
    expect(f).toMatchObject({ kind: 'duplicate', objective_id: 63, related_ids: [62], route: 'human', routed_to: 'human:operator' })
  })

  it('twins owned by a bot that is not waking → routed to Operator', () => {
    card(64, { title: 'Rotate on-call', agent_context: 'ops-bot' })
    card(65, { title: 'Rotate on-call', agent_context: 'ops-bot' })
    expect(review().flags[0]).toMatchObject({ kind: 'duplicate', route: 'human', routed_to: 'human:operator' })
  })

  it('never calls a parent/child pair, a routine wake, or a cross-workspace pair a duplicate', () => {
    card(66, { title: 'Launch plan' })
    card(67, { title: 'Launch plan', parent_id: 66 })
    card(68, { title: 'Sales: High Agency check', routine_id: 10 })
    card(69, { title: 'Sales: High Agency check', routine_id: 10 })
    card(70, { title: 'Quarterly review', workspace: 'operationkit' })
    card(71, { title: 'Quarterly review', workspace: 'other-ws' })
    expect(review().flags.filter((f) => f.kind === 'duplicate')).toEqual([])
  })
})

describe('flag 3 — stalled (only with a CONFIGURED window)', () => {
  beforeEach(() => {
    card(80, { session_id: null, updated_at: iso(3 * DAY) })
  })

  it('is OFF by default — no window is invented, and the run says why', () => {
    const r = review()
    expect(r.flags).toEqual([])
    expect(r.stalled_after_minutes).toBeNull()
    expect(r.checks_off).toEqual([expect.objectContaining({ check: 'stalled' })])
  })

  it('with settings.accountability_stalled_after_minutes set, an idle card owned by an awake bot → that bot', () => {
    db.prepare("INSERT INTO settings (key, value) VALUES ('accountability_stalled_after_minutes', '1440')").run()
    const r = review()
    expect(r.checks_off).toEqual([])
    expect(r.flags).toEqual([expect.objectContaining({ kind: 'stalled', objective_id: 80, route: 'bot', routed_to: 'agent:sales-bot' })])
  })

  it('a stalled card whose owner is not waking → Operator', () => {
    db.prepare("INSERT INTO settings (key, value) VALUES ('accountability_stalled_after_minutes', '1440')").run()
    db.prepare("UPDATE objectives SET agent_context = 'ops-bot' WHERE id = 80").run()
    expect(review().flags[0]).toMatchObject({ kind: 'stalled', route: 'human', routed_to: 'human:operator' })
  })

  it('never flags a card that is waiting on someone, has a live session, or is in review', () => {
    db.prepare("INSERT INTO settings (key, value) VALUES ('accountability_stalled_after_minutes', '1440')").run()
    review() // creates the accountability columns
    db.prepare("UPDATE objectives SET waiting_on = 'external:vendor', next_check_at = ? WHERE id = 80").run(new Date(NOW.getTime() + DAY).toISOString())
    card(81, { session_id: 'sess-live', updated_at: iso(3 * DAY) })
    card(82, { status: 'review', updated_at: iso(3 * DAY) })
    expect(review().flags.filter((f) => f.kind === 'stalled')).toEqual([])
  })
})

describe('flag 4 — over budget (only against a CONFIGURED ceiling; always Operator)', () => {
  it('a card with no ceiling anywhere is never over budget, however much it spent', () => {
    card(90)
    review()
    recordSpend(db, 90, { usd: 500 })
    expect(review().flags).toEqual([])
  })

  it('a card at its own ceiling → human:operator, even though its bot is awake', () => {
    card(91)
    review()
    setObjectiveCeiling(db, 91, { costUsd: 5 })
    recordSpend(db, 91, { usd: 5.5 })
    const [f] = review().flags
    expect(f).toMatchObject({ kind: 'over_budget', objective_id: 91, route: 'human', routed_to: 'human:operator', owner: 'sales-bot' })
    expect(f.why).toContain('$5 ceiling')
  })

  it('uses the workspace ceiling from settings when the card has none', () => {
    card(92)
    review()
    db.prepare("INSERT INTO settings (key, value) VALUES ('job_cost_ceiling_usd:operationkit', '2')").run()
    recordSpend(db, 92, { usd: 3 })
    expect(review().flags[0]).toMatchObject({ kind: 'over_budget', objective_id: 92, fingerprint: 'workspace:operationkit:2:-' })
  })
})

describe('routing into review_items (reuse of #900367)', () => {
  it('files one decision item per flag, routed, attributed to the supervisor, and never an approval', () => {
    card(60, { title: 'Refresh the pricing page' })
    card(61, { title: 'Refresh the pricing page' })
    card(50, { routine_id: 10, status: 'done', title: 'Sales: High Agency check' })
    card(51, { agent_context: null, source_job_id: 50 })
    const r = runSupervisor(db, { now: NOW, knownBots: KNOWN, trigger: 'manual' })
    expect(r.filed).toBe(2)
    const toBot = listReviewItems(db, { routed_to: 'agent:sales-bot' }, NOW)
    const toHuman = listReviewItems(db, { routed_to: 'human' }, NOW)
    expect(toBot.map((i) => i.dedupe_key)).toEqual(['supervisor:duplicate:61'])
    expect(toHuman.map((i) => i.dedupe_key)).toEqual(['supervisor:orphaned:51'])
    for (const item of [...toBot, ...toHuman]) {
      expect(item.kind).toBe('decision')
      expect(item.options).toEqual(['approve', 'reject', 'snooze'])
      expect(listReviewItemEvents(db, item.id)[0].actor).toBe(SUPERVISOR_ACTOR)
    }
    expect(toBot[0].lead).toBe('sales-bot')
  })

  it('a flag that persists is ONE item re-surfaced daily, not stacked', () => {
    card(60, { title: 'Twin' })
    card(61, { title: 'Twin' })
    runSupervisor(db, { now: NOW, knownBots: KNOWN })
    const next = runSupervisor(db, { now: new Date(NOW.getTime() + DAY), knownBots: KNOWN })
    expect(next).toMatchObject({ filed: 0, resurfaced: 1, withdrawn: 0 })
    expect(listReviewItems(db, { dedupe_prefix: 'supervisor:' }, NOW)).toHaveLength(1)
  })

  it('re-routes a live flag when the owning bot stops waking', () => {
    card(60, { title: 'Twin' })
    card(61, { title: 'Twin' })
    runSupervisor(db, { now: NOW, knownBots: KNOWN })
    db.prepare("UPDATE routines SET enabled = 0 WHERE id = 10").run()
    runSupervisor(db, { now: new Date(NOW.getTime() + DAY), knownBots: KNOWN })
    const [item] = listReviewItems(db, { dedupe_prefix: 'supervisor:' }, NOW)
    expect(item.routed_to).toBe('human:operator')
    expect(listReviewItemEvents(db, item.id).map((e) => e.event)).toContain('rerouted')
  })

  it('withdraws the flag with a reason once the condition clears (the pile shrinks by itself)', () => {
    card(60, { title: 'Twin' })
    card(61, { title: 'Twin' })
    runSupervisor(db, { now: NOW, knownBots: KNOWN })
    db.prepare("UPDATE objectives SET status = 'cancelled' WHERE id = 60").run()
    const r = runSupervisor(db, { now: new Date(NOW.getTime() + DAY), knownBots: KNOWN })
    expect(r.withdrawn).toBe(1)
    const item = getReviewItem(db, 1)!
    expect(item.state).toBe('withdrawn')
    expect(item.withdrawn_reason).toMatch(/no longer duplicate/)
  })

  it('does not re-ask a flag Operator already decided while the same condition persists', () => {
    card(62, { title: 'Fix onboarding email', agent_context: 'general' })
    card(63, { title: 'Fix onboarding email', agent_context: 'sales-bot' })
    runSupervisor(db, { now: NOW, knownBots: KNOWN })
    decideReviewItem(db, 1, { choice: 'reject', by: 'operator', note: 'intentional — two audiences' }, NOW)
    const next = runSupervisor(db, { now: new Date(NOW.getTime() + DAY), knownBots: KNOWN })
    expect(next).toMatchObject({ filed: 0, settled: 1 })
    expect(listReviewItems(db, { dedupe_prefix: 'supervisor:' }, NOW)).toHaveLength(0)
    // …but a NEW occurrence (a third twin appears) is asked again.
    card(64, { title: 'Fix onboarding email', agent_context: 'sales-bot' })
    expect(runSupervisor(db, { now: new Date(NOW.getTime() + 2 * DAY), knownBots: KNOWN }).filed).toBe(1)
  })

  it('respects Operator\'s snooze — a snoozed flag stays snoozed and is not withdrawn or duplicated', () => {
    card(62, { title: 'Fix onboarding email', agent_context: 'general' })
    card(63, { title: 'Fix onboarding email', agent_context: 'sales-bot' })
    runSupervisor(db, { now: NOW, knownBots: KNOWN })
    snoozeReviewItem(db, 1, new Date(NOW.getTime() + 7 * DAY).toISOString(), 'operator', NOW)
    runSupervisor(db, { now: new Date(NOW.getTime() + DAY), knownBots: KNOWN })
    expect(getReviewItem(db, 1)!.state).toBe('snoozed')
    expect((db.prepare('SELECT COUNT(*) AS n FROM review_items').get() as { n: number }).n).toBe(1)
  })

  it('uses one stable dedupe key per card per flag kind', () => {
    expect(flagDedupeKey({ kind: 'stalled', objective_id: 7 })).toBe('supervisor:stalled:7')
  })
})

describe('daily run + least privilege', () => {
  it('a scheduled run happens once per operator day; a manual run is not limited', () => {
    card(60, { title: 'Twin' })
    card(61, { title: 'Twin' })
    const first = runSupervisor(db, { now: NOW, knownBots: KNOWN, trigger: 'schedule' })
    const again = runSupervisor(db, { now: new Date(NOW.getTime() + 60 * 60_000), knownBots: KNOWN, trigger: 'schedule' })
    expect(first.skipped).toBeUndefined()
    expect(again.skipped).toMatch(/already ran for 2026-11-14/)
    expect(runSupervisor(db, { now: NOW, knownBots: KNOWN, trigger: 'manual' }).skipped).toBeUndefined()
    const runs = listSupervisorRuns(db)
    expect(runs.map((r) => r.trigger)).toEqual(['manual', 'schedule'])
    expect(runs[1]).toMatchObject({ status: 'ok', run_date: '2026-11-14', bots: 2, flags: 1, filed: 1 })
    expect(operatorDate(new Date('2026-11-15T03:00:00Z'))).toBe('2026-11-14') // 22:00 ET the previous day
  })

  it('never changes a card: status, owner and accountability columns are untouched', () => {
    card(50, { routine_id: 10, status: 'done', title: 'Sales: High Agency check' })
    card(51, { agent_context: null, source_job_id: 50 })
    card(60, { title: 'Twin' })
    card(61, { title: 'Twin' })
    review()
    const before = db.prepare('SELECT * FROM objectives ORDER BY id').all()
    runSupervisor(db, { now: NOW, knownBots: KNOWN })
    expect(db.prepare('SELECT * FROM objectives ORDER BY id').all()).toEqual(before)
  })

  it('writes only to review_items, review_item_events and its own run log', () => {
    card(60, { title: 'Twin' })
    card(61, { title: 'Twin' })
    review()
    const counts = () => Object.fromEntries(
      (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[])
        .map(({ name }) => [name, (db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get() as { n: number }).n]),
    )
    const before = counts()
    runSupervisor(db, { now: NOW, knownBots: KNOWN })
    const after = counts()
    const changed = Object.keys(after).filter((t) => after[t] !== before[t]).sort()
    expect(changed).toEqual(['review_item_events', 'review_items', 'supervisor_runs'])
  })

  it('fileFlags with no flags withdraws every live supervisor item and nothing else', () => {
    card(60, { title: 'Twin' })
    card(61, { title: 'Twin' })
    runSupervisor(db, { now: NOW, knownBots: KNOWN })
    expect(fileFlags(db, [], NOW)).toMatchObject({ filed: 0, withdrawn: 1 })
  })
})
