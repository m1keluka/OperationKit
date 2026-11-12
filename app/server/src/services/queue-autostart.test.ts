import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

// obj 900625 — queue auto-start: candidate selection, config, and the live gates
// (session cap, auto-start cap, seat availability, job-ceiling guard), run against
// a real initDb() schema in a throwaway file. No session is ever spawned: the tick
// takes an injected `start` and `seatCheck`.
const TMP_DB = path.join(os.tmpdir(), `cc-queue-autostart-unit-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB

const { initDb, getDb } = await import('../db/index.js')
const { MAX_CONCURRENT_SESSIONS } = await import('@operationkit/shared')
const qa = await import('./queue-autostart.js')
const { getWorkspaceFailover } = await import('./seat-assign.js')
const {
  selectQueueAutostartCandidates,
  resolveEnabledWorkspaces,
  setQueueAutostartWorkspace,
  parseWorkspaceList,
  queueAutostartMaxConcurrent,
  runQueueAutostartTick,
  markAutoStartRequested,
  defaultSeatCheck,
  parseQueueHoldPatch,
  applyQueueHoldPatch,
  ENABLED_AT_PREFIX,
  WORKSPACES_KEY,
} = qa

const WS = 'qa-ws'
const OTHER = 'qa-other'
const ENV: NodeJS.ProcessEnv = { CC_QUEUE_AUTOSTART_GRACE_MIN: '0' }

type Row = Record<string, unknown>

function db() {
  return getDb()
}

function setSetting(key: string, value: string) {
  db().prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)
}

/** Insert a card; `ageMin` back-dates created_at (the queue-entry fallback). */
function card(row: Row = {}, ageMin = 5): number {
  const base: Row = { title: `card ${Math.random().toString(36).slice(2, 8)}`, agent_context: 'general', workspace: WS, status: 'queue', type: 'task' }
  const all = { ...base, ...row }
  const cols = Object.keys(all)
  return Number(
    db()
      .prepare(`INSERT INTO objectives (${cols.join(',')}, created_at) VALUES (${cols.map(() => '?').join(',')}, datetime('now', ?))`)
      .run(...cols.map(c => all[c]), `-${ageMin} minutes`).lastInsertRowid,
  )
}

/** Enable WS with enabled_at = `agoMin` minutes ago. */
function enable(workspace = WS, agoMin = 60) {
  const cur = parseWorkspaceList((db().prepare('SELECT value FROM settings WHERE key = ?').get(WORKSPACES_KEY) as { value?: string } | undefined)?.value)
  if (!cur.includes(workspace)) setSetting(WORKSPACES_KEY, [...cur, workspace].join(','))
  db().prepare("INSERT INTO settings (key, value) VALUES (?, datetime('now', ?)) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(ENABLED_AT_PREFIX + workspace, `-${agoMin} minutes`)
}

function ceiling(workspace = WS) {
  setSetting(`job_wallclock_ceiling_ms:${workspace}`, '3600000')
}

function enabledList() {
  return resolveEnabledWorkspaces(db(), ENV)
}

function ids(rows: { id: number }[]) {
  return rows.map(r => r.id)
}

const okSeat = () => ({ ok: true, engine: 'claude' as const })
let startMock = vi.fn(async (o: { id: number }) => `sess-${o.id}`)

function tick(extra: Partial<Parameters<typeof runQueueAutostartTick>[0]> = {}) {
  return runQueueAutostartTick({ db: db(), env: ENV, start: startMock as never, seatCheck: okSeat, ...extra })
}

beforeAll(() => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
})

afterAll(() => {
  try { db().close() } catch {}
  for (const s of ['', '-wal', '-shm']) if (fs.existsSync(TMP_DB + s)) fs.unlinkSync(TMP_DB + s)
})

beforeEach(() => {
  db().prepare('DELETE FROM objectives').run()
  db().prepare("DELETE FROM settings WHERE key LIKE 'queue_autostart%' OR key LIKE 'job_%'").run()
  db().prepare('DELETE FROM objective_audit').run()
  db().prepare('DELETE FROM activity_log').run()
  startMock = vi.fn(async (o: { id: number }) => `sess-${o.id}`)
})

describe('config', () => {
  it('is OFF by default: no workspace, no candidates, no start', async () => {
    card({}, 1)
    expect(enabledList()).toEqual([])
    const r = await tick()
    expect(r.workspaces).toEqual([])
    expect(startMock).not.toHaveBeenCalled()
  })

  it('parses the comma list, dropping blanks, dupes and invalid slugs', () => {
    expect(parseWorkspaceList(' a, b ,,a, bad slug, ../x ,c-1')).toEqual(['a', 'b', 'c-1'])
  })

  it('unions the env list with the setting and stamps enabled_at for an env-only workspace', () => {
    setQueueAutostartWorkspace(db(), WS, true)
    const list = resolveEnabledWorkspaces(db(), { CC_QUEUE_AUTOSTART_WORKSPACES: `${WS},${OTHER}` })
    expect(list.map(w => [w.workspace, w.source])).toEqual([[WS, 'setting+env'], [OTHER, 'env']])
    const stamped = db().prepare('SELECT value FROM settings WHERE key = ?').get(ENABLED_AT_PREFIX + OTHER) as { value: string }
    expect(stamped.value).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/)
  })

  it('toggle on stamps enabled_at; off removes it; re-enable re-stamps (no backlog flood)', () => {
    setQueueAutostartWorkspace(db(), WS, true)
    const first = (db().prepare('SELECT value FROM settings WHERE key = ?').get(ENABLED_AT_PREFIX + WS) as { value: string }).value
    db().prepare('UPDATE settings SET value = ? WHERE key = ?').run('2020-01-01 00:00:00', ENABLED_AT_PREFIX + WS)
    setQueueAutostartWorkspace(db(), WS, true) // already on: enabled_at untouched
    expect((db().prepare('SELECT value FROM settings WHERE key = ?').get(ENABLED_AT_PREFIX + WS) as { value: string }).value).toBe('2020-01-01 00:00:00')
    setQueueAutostartWorkspace(db(), WS, false)
    expect(db().prepare('SELECT value FROM settings WHERE key = ?').get(ENABLED_AT_PREFIX + WS)).toBeUndefined()
    expect(enabledList()).toEqual([])
    setQueueAutostartWorkspace(db(), WS, true)
    const again = (db().prepare('SELECT value FROM settings WHERE key = ?').get(ENABLED_AT_PREFIX + WS) as { value: string }).value
    expect(again >= first).toBe(true)
  })

  it('max concurrent: env wins, then setting, then 4', () => {
    expect(queueAutostartMaxConcurrent(db(), {})).toEqual({ value: 4, source: 'default' })
    setSetting('queue_autostart_max_concurrent', '2')
    expect(queueAutostartMaxConcurrent(db(), {}).value).toBe(2)
    expect(queueAutostartMaxConcurrent(db(), { CC_QUEUE_AUTOSTART_MAX_CONCURRENT: '7' }).value).toBe(7)
    setSetting('queue_autostart_max_concurrent', 'nonsense')
    expect(queueAutostartMaxConcurrent(db(), {}).value).toBe(4)
  })
})

describe('selectQueueAutostartCandidates', () => {
  beforeEach(() => enable(WS, 60))

  it('only selects in enabled workspaces', () => {
    const mine = card({}, 5)
    card({ workspace: OTHER }, 5)
    expect(ids(selectQueueAutostartCandidates(db(), enabledList(), { graceMinutes: 0 }))).toEqual([mine])
  })

  it('is origin-agnostic: manual, agent_api, job_reply, strategy, routine all qualify', () => {
    const made = ['manual', 'agent_api', 'job_reply', 'strategy', 'routine'].map((origin, i) => card({ origin }, 10 - i))
    expect(ids(selectQueueAutostartCandidates(db(), enabledList(), { graceMinutes: 0 }))).toEqual(made)
  })

  it('enabled_at cutoff: a backlog card that entered queue before enabled_at is NOT selected', () => {
    const before = card({ title: 'backlog' }, 120) // created 2h ago, enabled 1h ago
    const after = card({ title: 'new' }, 5)
    const got = ids(selectQueueAutostartCandidates(db(), enabledList(), { graceMinutes: 0 }))
    expect(got).toEqual([after])
    expect(got).not.toContain(before)
  })

  it('a backlog card re-entering queue after enabled_at (queued_at) is selected', () => {
    const id = card({ title: 'old but requeued', status: 'planning' }, 120)
    db().prepare("UPDATE objectives SET status = 'queue' WHERE id = ?").run(id) // trigger stamps queued_at = now
    const row = db().prepare('SELECT queued_at FROM objectives WHERE id = ?').get(id) as { queued_at: string | null }
    expect(row.queued_at).not.toBeNull()
    expect(ids(selectQueueAutostartCandidates(db(), enabledList(), { graceMinutes: 0 }))).toEqual([id])
  })

  it('session_cap flag: an explicitly start-requested backlog card IS selected despite the cutoff', () => {
    const id = card({ title: 'requested' }, 600)
    expect(selectQueueAutostartCandidates(db(), enabledList(), { graceMinutes: 0 })).toHaveLength(0)
    expect(markAutoStartRequested(db(), id, ENV)).toEqual({ flagged: true, workspaceEnabled: true })
    expect(ids(selectQueueAutostartCandidates(db(), enabledList(), { graceMinutes: 0 }))).toEqual([id])
  })

  it('a card that already ran (session_count > 0) needs the explicit request flag', () => {
    const id = card({ session_count: 2 }, 5)
    expect(selectQueueAutostartCandidates(db(), enabledList(), { graceMinutes: 0 })).toHaveLength(0)
    markAutoStartRequested(db(), id, ENV)
    expect(ids(selectQueueAutostartCandidates(db(), enabledList(), { graceMinutes: 0 }))).toEqual([id])
  })

  it('excludes [Review] companions, project/planning cards, strategies, children, deleted and non-queue rows', () => {
    card({ title: '[Review] Some PR' }, 5)
    card({ type: 'project' }, 5)
    card({ type: 'project', status: 'planning' }, 5)
    card({ is_strategy: 1 }, 5)
    const parent = card({ status: 'working' }, 5)
    card({ parent_id: parent }, 5)
    card({ deleted_at: '2026-11-01 00:00:00' }, 5)
    for (const status of ['working', 'review', 'done', 'cancelled']) card({ status }, 5)
    expect(selectQueueAutostartCandidates(db(), enabledList(), { graceMinutes: 0 })).toHaveLength(0)
  })

  it('honours bug cards as well as tasks', () => {
    const id = card({ type: 'bug' }, 5)
    expect(ids(selectQueueAutostartCandidates(db(), enabledList(), { graceMinutes: 0 }))).toEqual([id])
  })

  it('hold: a queue_hold card is never selected, even when start-requested; clearing it releases', () => {
    const id = card({ queue_hold: 'WAIT for the vendor contract' }, 5)
    markAutoStartRequested(db(), id, ENV)
    expect(selectQueueAutostartCandidates(db(), enabledList(), { graceMinutes: 0 })).toHaveLength(0)
    db().prepare('UPDATE objectives SET queue_hold = NULL WHERE id = ?').run(id)
    expect(ids(selectQueueAutostartCandidates(db(), enabledList(), { graceMinutes: 0 }))).toEqual([id])
  })

  it('blocked_by: skipped until the blocking card is done', () => {
    const dep = card({ status: 'working', title: 'dependency' }, 5)
    const id = card({ blocked_by: dep }, 5)
    expect(selectQueueAutostartCandidates(db(), enabledList(), { graceMinutes: 0 })).toHaveLength(0)
    db().prepare("UPDATE objectives SET status = 'cancelled' WHERE id = ?").run(dep)
    expect(selectQueueAutostartCandidates(db(), enabledList(), { graceMinutes: 0 })).toHaveLength(0)
    db().prepare("UPDATE objectives SET status = 'done' WHERE id = ?").run(dep)
    expect(ids(selectQueueAutostartCandidates(db(), enabledList(), { graceMinutes: 0 }))).toEqual([id])
  })

  it('grace window: a fresh, un-requested card waits; a requested one does not', () => {
    const fresh = card({ title: 'fresh' }, 0)
    expect(selectQueueAutostartCandidates(db(), enabledList(), { graceMinutes: 2 })).toHaveLength(0)
    markAutoStartRequested(db(), fresh, ENV)
    expect(ids(selectQueueAutostartCandidates(db(), enabledList(), { graceMinutes: 2 }))).toEqual([fresh])
  })

  it('orders oldest queue entry first', () => {
    const newer = card({}, 5)
    const older = card({}, 30)
    expect(ids(selectQueueAutostartCandidates(db(), enabledList(), { graceMinutes: 0 }))).toEqual([older, newer])
  })

  it('leaving queue clears the request flag (trigger)', () => {
    const id = card({}, 5)
    markAutoStartRequested(db(), id, ENV)
    db().prepare("UPDATE objectives SET status = 'working' WHERE id = ?").run(id)
    const row = db().prepare('SELECT auto_start_requested_at FROM objectives WHERE id = ?').get(id) as { auto_start_requested_at: string | null }
    expect(row.auto_start_requested_at).toBeNull()
  })

  it('markAutoStartRequested never flags a card outside queue', () => {
    const id = card({ status: 'working' }, 5)
    expect(markAutoStartRequested(db(), id, ENV).flagged).toBe(false)
  })
})

describe('runQueueAutostartTick gating', () => {
  beforeEach(() => {
    enable(WS, 60)
    ceiling(WS)
  })

  it('starts an eligible card: status working, audit pathway queue-autostart, start reason recorded', async () => {
    const id = card({ title: 'go' }, 5)
    const r = await tick()
    expect(r.started).toEqual([id])
    expect(startMock).toHaveBeenCalledTimes(1)
    const row = db().prepare('SELECT status, session_id, autostarted_at, last_start_reason FROM objectives WHERE id = ?').get(id) as Row
    expect(row).toMatchObject({ status: 'working', session_id: `sess-${id}`, last_start_reason: 'queue_autostart' })
    expect(row.autostarted_at).toBeTruthy()
    const audit = db().prepare('SELECT pathway, actor, from_status, to_status, session_id FROM objective_audit WHERE objective_id = ?').all(id)
    expect(audit).toEqual([{ pathway: 'queue-autostart', actor: 'state-poller', from_status: 'queue', to_status: 'working', session_id: `sess-${id}` }])
  })

  it('stops at the global session cap', async () => {
    for (let i = 0; i < MAX_CONCURRENT_SESSIONS; i++) card({ status: 'working', workspace: OTHER }, 5)
    card({}, 5)
    const r = await tick()
    expect(r.stoppedBy).toBe('session_cap')
    expect(startMock).not.toHaveBeenCalled()
  })

  it('stops at queue_autostart_max_concurrent (counts running auto-started cards only)', async () => {
    setSetting('queue_autostart_max_concurrent', '2')
    // Manually-started running cards do not consume the auto-start budget.
    for (let i = 0; i < 3; i++) card({ status: 'working', workspace: OTHER }, 5)
    const a = card({}, 30)
    const b = card({}, 20)
    const c = card({}, 10)
    const r = await tick()
    expect(r.started).toEqual([a, b])
    expect(r.stoppedBy).toBe('autostart_cap')
    expect(db().prepare('SELECT status FROM objectives WHERE id = ?').get(c)).toEqual({ status: 'queue' })
    // A slot frees: one auto-started card finishes → the next tick starts c.
    db().prepare("UPDATE objectives SET status = 'review' WHERE id = ?").run(a)
    const r2 = await tick()
    expect(r2.started).toEqual([c])
  })

  it('skips (does not fail) when no seat can take work, and keeps the card queued with a note', async () => {
    const id = card({}, 5)
    const r = await tick({ seatCheck: () => ({ ok: false, engine: 'claude', reason: 'no claude seat can take work now (every seat is cooling down, parked or busy)' }) })
    expect(r.started).toEqual([])
    expect(r.skipped).toEqual([{ id, reason: expect.stringMatching(/^waiting: no claude seat/) }])
    const row = db().prepare('SELECT status, auto_start_note FROM objectives WHERE id = ?').get(id) as Row
    expect(row.status).toBe('queue')
    expect(String(row.auto_start_note)).toMatch(/cooling/)
    expect(startMock).not.toHaveBeenCalled()
  })

  it('seat gate is per card: a codex card waits while a claude card in the same tick starts', async () => {
    const codex = card({ model: 'codex' }, 30)
    const claude = card({}, 10)
    const r = await tick({ seatCheck: o => (o.id === codex ? { ok: false, engine: 'codex', reason: 'no codex seat' } : okSeat()) })
    expect(r.started).toEqual([claude])
    expect(r.skipped.map(s => s.id)).toEqual([codex])
  })

  it('ceiling guard (default enforce): an unbudgeted card is refused, stays queued, decision recorded once', async () => {
    db().prepare("DELETE FROM settings WHERE key LIKE 'job_%'").run()
    const id = card({}, 5)
    await tick()
    await tick()
    expect(startMock).not.toHaveBeenCalled()
    const row = db().prepare('SELECT status, auto_start_note FROM objectives WHERE id = ?').get(id) as Row
    expect(row.status).toBe('queue')
    expect(String(row.auto_start_note)).toMatch(/^refused: Auto-start refused \(policy enforce .*path queue_autostart\)/)
    const logs = db().prepare("SELECT title, metadata FROM activity_log WHERE objective_id = ? AND title = 'queue_autostart_refused'").all(id) as Row[]
    expect(logs).toHaveLength(1)
    expect(JSON.parse(String(logs[0].metadata))).toMatchObject({ path: 'queue_autostart', policy: 'enforce', code: 'auto_start_no_ceiling' })
  })

  it('ceiling guard observe (per workspace): starts unbudgeted and records it', async () => {
    db().prepare("DELETE FROM settings WHERE key LIKE 'job_%'").run()
    setSetting(`job_ceiling_policy:queue_autostart:${WS}`, 'observe')
    const id = card({}, 5)
    const r = await tick()
    expect(r.started).toEqual([id])
    const logs = db().prepare("SELECT title FROM activity_log WHERE objective_id = ?").all(id) as Row[]
    expect(logs.map(l => l.title)).toContain('queue_autostart_unbudgeted_start')
  })

  it('ceiling guard: a card over its own budget is refused even in observe', async () => {
    setSetting(`job_ceiling_policy:queue_autostart:${WS}`, 'observe')
    const id = card({}, 5)
    db().prepare('INSERT INTO objective_job_accounting (objective_id, cost_ceiling_usd, spent_usd) VALUES (?, 1, 5)').run(id)
    const r = await tick()
    expect(r.started).toEqual([])
    expect(String((db().prepare('SELECT auto_start_note FROM objectives WHERE id = ?').get(id) as Row).auto_start_note)).toMatch(/^refused:/)
  })

  it('a start failure leaves the card queued for the next tick', async () => {
    const id = card({}, 5)
    const r = await tick({ start: (async () => { throw new Error('lease conflict') }) as never })
    expect(r.started).toEqual([])
    expect(r.skipped[0]).toMatchObject({ id, reason: expect.stringMatching(/start failed, will retry: lease conflict/) })
    expect(db().prepare('SELECT status FROM objectives WHERE id = ?').get(id)).toEqual({ status: 'queue' })
  })

  it('does not start a card whose same-title twin is already running', async () => {
    card({ title: 'Same title', status: 'working' }, 5)
    const id = card({ title: 'Same title' }, 5)
    const r = await tick()
    expect(r.started).toEqual([])
    expect(r.skipped[0]).toMatchObject({ id, reason: expect.stringMatching(/already running/) })
  })

  it('a held card is never started by the tick', async () => {
    card({ queue_hold: 'DEPENDS on #123' }, 5)
    const r = await tick()
    expect(r.candidates).toBe(0)
    expect(startMock).not.toHaveBeenCalled()
  })
})

describe('defaultSeatCheck', () => {
  it('ok when the card engine has a seat', () => {
    const id = card({}, 5)
    const o = db().prepare('SELECT * FROM objectives WHERE id = ?').get(id) as never
    expect(defaultSeatCheck(o, () => true, getWorkspaceFailover)).toEqual({ ok: true, engine: 'claude' })
  })

  it('skip when every seat of the engine is cooling and failover is off', () => {
    const id = card({}, 5)
    const o = db().prepare('SELECT * FROM objectives WHERE id = ?').get(id) as never
    const r = defaultSeatCheck(o, () => false, getWorkspaceFailover)
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/no claude seat can take work now/)
  })

  it('takes the workspace failover policy into account', () => {
    setSetting(`seat_failover:${WS}`, JSON.stringify({ enabled: true, order: ['claude', 'codex', 'grok'] }))
    const id = card({}, 5)
    const o = db().prepare('SELECT * FROM objectives WHERE id = ?').get(id) as never
    expect(defaultSeatCheck(o, k => k === 'codex', getWorkspaceFailover)).toEqual({ ok: true, engine: 'codex' })
    db().prepare('DELETE FROM settings WHERE key = ?').run(`seat_failover:${WS}`)
  })
})

describe('parseQueueHoldPatch', () => {
  it('accepts a reason, true/false and null; rejects junk and over-long reasons', () => {
    const ctx = { selfId: null, workspace: WS }
    expect(parseQueueHoldPatch(db(), {}, ctx)).toEqual({ ok: true, touched: false })
    expect(parseQueueHoldPatch(db(), { queue_hold: ' WAIT for legal ' }, ctx)).toMatchObject({ ok: true, queueHold: 'WAIT for legal' })
    expect(parseQueueHoldPatch(db(), { queue_hold: true }, ctx)).toMatchObject({ ok: true, queueHold: 'held' })
    expect(parseQueueHoldPatch(db(), { queue_hold: '' }, ctx)).toMatchObject({ ok: true, queueHold: null })
    expect(parseQueueHoldPatch(db(), { queue_hold: 42 }, ctx).ok).toBe(false)
    expect(parseQueueHoldPatch(db(), { queue_hold: 'x'.repeat(501) }, ctx).ok).toBe(false)
  })

  it('blocked_by must be a live card in the same workspace and not itself', () => {
    const same = card({}, 5)
    const foreign = card({ workspace: OTHER }, 5)
    expect(parseQueueHoldPatch(db(), { blocked_by: same }, { selfId: null, workspace: WS })).toMatchObject({ ok: true, blockedBy: same })
    expect(parseQueueHoldPatch(db(), { blocked_by: same }, { selfId: same, workspace: WS }).ok).toBe(false)
    const cross = parseQueueHoldPatch(db(), { blocked_by: foreign }, { selfId: null, workspace: WS })
    const missing = parseQueueHoldPatch(db(), { blocked_by: 99999999 }, { selfId: null, workspace: WS })
    expect(cross.ok).toBe(false)
    expect(missing.ok).toBe(false)
    expect(parseQueueHoldPatch(db(), { blocked_by: 'abc' }, { selfId: null, workspace: WS }).ok).toBe(false)
    expect(parseQueueHoldPatch(db(), { blocked_by: null }, { selfId: null, workspace: WS })).toMatchObject({ ok: true, blockedBy: null })
  })

  it('applyQueueHoldPatch writes only the touched fields', () => {
    const id = card({ queue_hold: 'keep', blocked_by: null }, 5)
    const dep = card({}, 5)
    applyQueueHoldPatch(db(), id, parseQueueHoldPatch(db(), { blocked_by: dep }, { selfId: id, workspace: WS }))
    expect(db().prepare('SELECT queue_hold, blocked_by FROM objectives WHERE id = ?').get(id)).toEqual({ queue_hold: 'keep', blocked_by: dep })
  })
})
