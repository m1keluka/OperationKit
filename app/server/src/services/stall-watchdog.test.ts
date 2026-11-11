/**
 * obj 900372 — stall watchdog for cards that sit in `working` doing nothing.
 *
 * Incident: #900228 sat in `working` 09:33 → 10:12 ET on 2026-11-09 with no steps,
 * output or commits until a human restarted it; nothing woke the bots. These tests
 * drive `runStallWatchdogTick` against the REAL schema (columns + the
 * objective_events trigger) with the session layer injected, covering the four
 * failure shapes the brief names plus the one-restart cap:
 *
 *   1. never spawned            — card in working, no session id / no process, no output
 *   2. hung, no heartbeat       — process alive, transcript silent past the threshold
 *   3. died silently            — process gone, card still working
 *   4. one auto-restart only    — a second stall flags + notifies, never restarts again
 *
 * Plus the API surface (stalled / last_activity_at in one read) and the transcript
 * classifier the decision depends on. Nothing here spawns tmux, docker or a model.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { Objective } from '@operationkit/shared'

process.env.SECRETS_MASTER_KEY = Buffer.alloc(32, 29).toString('base64')
const TMP_DB = path.join(os.tmpdir(), `cc-stall-wd-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB

const { initDb, getDb } = await import('../db/index.js')
const wd = await import('./stall-watchdog.js')
const reasons = await import('./session-start-reasons.js')
const helpers = await import('../routes/objectives-helpers.js')
const webhooks = await import('./agent-webhooks.js')

const MIN = 60_000
const NOW = Date.parse('2026-11-09T14:50:00.000Z') // 09:50 ET — 17 min into the #900228 window
const CONFIG = { enabled: true, thresholdMs: 10 * MIN, inflightThresholdMs: 30 * MIN, maxAutoRestarts: 1 }

beforeAll(() => {
  initDb()
  getDb().prepare("INSERT OR IGNORE INTO users (id, username, password_hash, role) VALUES (1, 'operator', 'x', 'admin')").run()
})
afterAll(() => {
  try { getDb().close() } catch { /* already closed */ }
  for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) { try { fs.unlinkSync(f) } catch { /* gone */ } }
})
beforeEach(() => {
  const db = getDb()
  db.prepare('DELETE FROM objective_events').run()
  db.prepare('DELETE FROM activity_log').run()
  db.prepare("DELETE FROM objectives WHERE title LIKE 'stall-test%'").run()
})

function seedWorking(opts: { sessionId: string | null; startedMinAgo: number; workspace?: string }): number {
  const startedIso = new Date(NOW - opts.startedMinAgo * MIN).toISOString()
  const r = getDb()
    .prepare(
      `INSERT INTO objectives (title, description, agent_context, workspace, created_by, status, session_id, last_start_at, updated_at)
       VALUES (?, '', 'cto', ?, 1, 'working', ?, ?, ?)`,
    )
    .run(`stall-test ${Math.random()}`, opts.workspace ?? 'your-org', opts.sessionId, startedIso, startedIso.replace('T', ' ').slice(0, 19))
  return Number(r.lastInsertRowid)
}

function row(id: number): Record<string, unknown> {
  return getDb().prepare('SELECT * FROM objectives WHERE id = ?').get(id) as Record<string, unknown>
}

const silentProbe = (lastWriteMinAgo: number | null, cliEvents: number, toolInFlight = false) => () => ({
  exists: lastWriteMinAgo !== null,
  lastWriteMs: lastWriteMinAgo === null ? null : NOW - lastWriteMinAgo * MIN,
  cliEventsSinceSpawn: cliEvents,
  phase: (cliEvents === 0 ? 'no_cli_output' : 'model_active') as 'no_cli_output' | 'model_active',
  toolInFlight,
})

/** Injected session layer. `start` records calls and returns a fresh id. */
function harness(opts: {
  alive: boolean
  probe: ReturnType<typeof silentProbe>
  startThrows?: boolean
  exempt?: boolean
}) {
  const calls = { stop: [] as number[], start: [] as number[], notify: [] as Array<{ id: number; reason: string }>, notes: [] as string[] }
  let seq = 0
  const deps: Parameters<typeof wd.runStallWatchdogTick>[0] = {
    db: getDb(),
    now: () => NOW,
    config: CONFIG,
    transcriptPath: (sid) => `/nonexistent/${sid}.jsonl`,
    probe: opts.probe,
    isAlive: () => opts.alive,
    spawnStartMs: () => null,
    isExempt: () => !!opts.exempt,
    stop: async (r) => { calls.stop.push(r.id) },
    start: async (o: Objective) => {
      calls.start.push(o.id)
      if (opts.startThrows) throw new Error('no seat available')
      return `cc-${o.id}-restart-${++seq}`
    },
    noteStartReason: (_id, detail) => { calls.notes.push(detail) },
    notify: (r, reason) => { calls.notify.push({ id: r.id, reason }) },
    broadcast: () => {},
  }
  return { deps, calls }
}

function stalledEvents(id: number): number {
  return (getDb().prepare("SELECT COUNT(*) AS n FROM objective_events WHERE objective_id = ? AND kind = 'stalled'").get(id) as { n: number }).n
}

describe('stall watchdog — the four failure shapes', () => {
  it('never spawned: working card with no session id and no output → one restart with a recorded reason', async () => {
    const id = seedWorking({ sessionId: null, startedMinAgo: 17 })
    const { deps, calls } = harness({ alive: false, probe: silentProbe(null, 0) })

    const res = await wd.runStallWatchdogTick(deps)

    expect(res.restarted).toEqual([id])
    expect(calls.start).toEqual([id])
    expect(calls.notes[0]).toMatch(/^never_spawned:/)
    const r = row(id)
    expect(r.stall_restarts).toBe(1)
    expect(r.session_id).toBe(`cc-${id}-restart-1`)
    expect(r.stalled_at).toBeNull()
    const log = getDb().prepare("SELECT title, metadata FROM activity_log WHERE objective_id = ?").get(id) as { title: string; metadata: string }
    expect(log.title).toBe('stall_auto_restart')
    expect(JSON.parse(log.metadata).class).toBe('never_spawned')
  })

  it('hung with no heartbeat: live process, transcript silent 17 min → restart (and last_activity_at is heartbeated)', async () => {
    const id = seedWorking({ sessionId: 'cc-hung-1', startedMinAgo: 40 })
    const { deps, calls } = harness({ alive: true, probe: silentProbe(17, 4) })

    const res = await wd.runStallWatchdogTick(deps)

    expect(res.restarted).toEqual([id])
    expect(calls.stop).toEqual([id])
    expect(calls.notes[0]).toMatch(/^hung_no_heartbeat:/)
    // The live heartbeat landed before the decision: a bot reading the card sees the last real write.
    expect(row(id).last_activity_at).toBe(new Date(NOW - 17 * MIN).toISOString())
  })

  it('hung at startup: live process that never wrote a CLI event is classified hung_startup', async () => {
    const id = seedWorking({ sessionId: 'cc-hung-2', startedMinAgo: 12 })
    const { deps, calls } = harness({ alive: true, probe: silentProbe(12, 0) })
    await wd.runStallWatchdogTick(deps)
    expect(calls.start).toEqual([id])
    expect(calls.notes[0]).toMatch(/^hung_startup:/)
  })

  it('died silently: process gone, card still working → restart', async () => {
    const id = seedWorking({ sessionId: 'cc-dead-1', startedMinAgo: 30 })
    const { deps, calls } = harness({ alive: false, probe: silentProbe(11, 9) })
    const res = await wd.runStallWatchdogTick(deps)
    expect(res.restarted).toEqual([id])
    expect(calls.notes[0]).toMatch(/^died_silently:/)
  })

  it('a busy session is left alone, and a tool call in flight gets the longer threshold', async () => {
    const busy = seedWorking({ sessionId: 'cc-busy', startedMinAgo: 60 })
    const r1 = await wd.runStallWatchdogTick(harness({ alive: true, probe: silentProbe(2, 50) }).deps)
    expect(r1.restarted).toEqual([])
    expect(row(busy).stall_restarts).toBe(0)

    // 15 min silent but an assistant tool_use is still awaiting its result (a long test run).
    const r2 = await wd.runStallWatchdogTick(harness({ alive: true, probe: silentProbe(15, 50, true) }).deps)
    expect(r2.restarted).toEqual([])
    expect(r2.flagged).toEqual([])
  })

  it('exempt cards (pending wakeup / 529 retry / arena) are never touched', async () => {
    seedWorking({ sessionId: 'cc-exempt', startedMinAgo: 60 })
    const { deps, calls } = harness({ alive: true, probe: silentProbe(45, 3), exempt: true })
    const res = await wd.runStallWatchdogTick(deps)
    expect(res.restarted).toEqual([])
    expect(calls.start).toEqual([])
  })
})

describe('stall watchdog — exactly one auto-restart, then flag + notify (no restart loop)', () => {
  it('second stall in the same episode flags stalled, emits a stalled event + notification, and never restarts again', async () => {
    const id = seedWorking({ sessionId: 'cc-loop-1', startedMinAgo: 20 })

    // Tick 1: first stall → the one restart.
    const t1 = harness({ alive: true, probe: silentProbe(20, 0) })
    expect((await wd.runStallWatchdogTick(t1.deps)).restarted).toEqual([id])
    expect(row(id).stall_restarts).toBe(1)

    // The restarted session ALSO hangs. Tick 2 (time has moved on): flag, do not restart.
    const t2 = harness({ alive: true, probe: silentProbe(20, 0) })
    const r2 = await wd.runStallWatchdogTick(t2.deps)
    expect(r2.restarted).toEqual([])
    expect(r2.flagged).toEqual([id])
    expect(t2.calls.start).toEqual([])
    expect(t2.calls.notify).toHaveLength(1)
    expect(t2.calls.notify[0].reason).toMatch(/^hung_startup:/)
    const r = row(id)
    expect(r.stalled_at).toBeTruthy()
    expect(String(r.stall_reason)).toMatch(/hung_startup/)
    expect(r.status).toBe('working') // flagged, not silently moved
    expect(stalledEvents(id)).toBe(1) // → /api/agent/changes + needs_agent webhook

    // Ticks 3..5: still hung → nothing more happens. No restart, no duplicate event/alert.
    for (let i = 0; i < 3; i++) {
      const t = harness({ alive: true, probe: silentProbe(30 + i, 0) })
      const rr = await wd.runStallWatchdogTick(t.deps)
      expect(rr.restarted).toEqual([])
      expect(t.calls.start).toEqual([])
      expect(t.calls.notify).toEqual([])
    }
    expect(stalledEvents(id)).toBe(1)
    expect(row(id).stall_restarts).toBe(1)
  })

  it('exported restartStalled enforces the one-attempt cap itself (safe for reuse outside the tick)', async () => {
    const id = seedWorking({ sessionId: 'cc-reuse-1', startedMinAgo: 20 })
    const d = wd.decideStall({
      sessionId: 'cc-reuse-1', alive: false, probe: silentProbe(20, 0)(), spawnStartMs: null,
      fallbackStartMs: NOW - 20 * MIN, nowMs: NOW, config: CONFIG, autoRestarts: 0,
    })
    const first = harness({ alive: false, probe: silentProbe(20, 0) })
    const r0 = row(id) as unknown as Parameters<typeof wd.restartStalled>[1]
    expect(await wd.restartStalled(first.deps, r0, d, 'died_silently: test')).toBe(true)
    expect(first.calls.start).toEqual([id])

    // A second caller passing the CURRENT row (stall_restarts = 1) is refused: no stop, no start.
    const second = harness({ alive: false, probe: silentProbe(20, 0) })
    const r1 = row(id) as unknown as Parameters<typeof wd.restartStalled>[1]
    expect(await wd.restartStalled(second.deps, r1, d, 'died_silently: again')).toBe(false)
    expect(second.calls.stop).toEqual([])
    expect(second.calls.start).toEqual([])
    expect(row(id).stall_restarts).toBe(1)
  })

  it('a failed restart flags immediately instead of retrying', async () => {
    const id = seedWorking({ sessionId: 'cc-nospawn', startedMinAgo: 25 })
    const { deps, calls } = harness({ alive: false, probe: silentProbe(null, 0), startThrows: true })
    const res = await wd.runStallWatchdogTick(deps)
    expect(calls.start).toEqual([id])
    expect(res.flagged).toEqual([id])
    expect(String(row(id).stall_reason)).toMatch(/auto-restart failed: no seat available/)
    expect(stalledEvents(id)).toBe(1)

    const again = harness({ alive: false, probe: silentProbe(null, 0) })
    await wd.runStallWatchdogTick(again.deps)
    expect(again.calls.start).toEqual([])
  })

  it('the cap re-arms only on a start that is NOT the watchdog (human / bot / follow-up)', () => {
    const db = getDb()
    const id = seedWorking({ sessionId: 'cc-rearm', startedMinAgo: 5 })
    db.prepare("UPDATE objectives SET stall_restarts = 1, stalled_at = '2026-11-09T14:45:00.000Z', stall_reason = 'x' WHERE id = ?").run(id)

    reasons.logSessionStart(db, { objectiveId: id, sessionId: 's-wd', kind: 'spawn', reason: { reason: wd.STALL_START_REASON } as never })
    expect(row(id).stall_restarts).toBe(1)

    reasons.logSessionStart(db, { objectiveId: id, sessionId: 's-human', kind: 'spawn', reason: { reason: 'manual' } as never })
    const r = row(id)
    expect(r.stall_restarts).toBe(0)
    expect(r.stalled_at).toBeNull()
  })

  it('a flag clears on fresh activity and when the card leaves working', async () => {
    const id = seedWorking({ sessionId: 'cc-recover', startedMinAgo: 40 })
    getDb().prepare("UPDATE objectives SET stall_restarts = 1, stalled_at = ? WHERE id = ?").run(new Date(NOW - 5 * MIN).toISOString(), id)
    const res = await wd.runStallWatchdogTick(harness({ alive: true, probe: silentProbe(1, 12) }).deps)
    expect(res.cleared).toEqual([id])
    expect(row(id).stalled_at).toBeNull()

    getDb().prepare("UPDATE objectives SET stalled_at = ?, status = 'review' WHERE id = ?").run(new Date(NOW).toISOString(), id)
    await wd.runStallWatchdogTick(harness({ alive: false, probe: silentProbe(null, 0) }).deps)
    expect(row(id).stalled_at).toBeNull()
  })

  it('config: a setting can turn restarts off but never raise the cap above one', () => {
    const db = getDb()
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('stall_watchdog_max_restarts', '5')").run()
    expect(wd.resolveStallConfig(db, {}).maxAutoRestarts).toBe(1)
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('stall_watchdog_max_restarts', '0')").run()
    expect(wd.resolveStallConfig(db, {}).maxAutoRestarts).toBe(0)
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('stall_watchdog_minutes', '7')").run()
    expect(wd.resolveStallConfig(db, {}).thresholdMs).toBe(7 * MIN)
    expect(wd.resolveStallConfig(db, { CC_STALL_WATCHDOG_MINUTES: '3' }).thresholdMs).toBe(3 * MIN)
    db.prepare("DELETE FROM settings WHERE key LIKE 'stall_watchdog_%'").run()
    expect(wd.resolveStallConfig(db, {}).thresholdMs).toBe(10 * MIN)
  })
})

describe('API surface — stalled + last_activity_at in one read', () => {
  it('mapObjective (get_objective / list_objectives) carries stalled, stall_reason and last_activity_at', () => {
    const id = seedWorking({ sessionId: 'cc-api', startedMinAgo: 30 })
    getDb().prepare("UPDATE objectives SET stalled_at = '2026-11-09T14:45:00.000Z', stall_reason = 'hung_startup: …', last_activity_at = '2026-11-09T14:33:10.000Z' WHERE id = ?").run(id)
    const mapped = helpers.mapObjective(row(id) as unknown as Objective) as unknown as Record<string, unknown>
    expect(mapped.stalled).toBe(true)
    expect(mapped.stall_reason).toBe('hung_startup: …')
    expect(mapped.last_activity_at).toBe('2026-11-09T14:33:10.000Z')

    getDb().prepare("UPDATE objectives SET status = 'review' WHERE id = ?").run(id)
    expect((helpers.mapObjective(row(id) as unknown as Objective) as unknown as Record<string, unknown>).stalled).toBe(false)
  })

  it('needs_agent classifies a flagged working card as kind=stalled, ahead of failed_review', () => {
    const base = { status: 'working', has_blockers: 0, ai_review_verdict: null, needs_secret: null }
    expect(webhooks.classifyNeed({ ...base, stalled_at: null })).toBeNull()
    const need = webhooks.classifyNeed({ ...base, stalled_at: '2026-11-09T14:45:00.000Z', stall_reason: 'hung_startup: x — idle 12 min' })
    expect(need?.kind).toBe('stalled')
    expect(need?.why).toMatch(/hung_startup/)
    expect(webhooks.NEED_ORDER.indexOf('stalled')).toBeLessThan(webhooks.NEED_ORDER.indexOf('failed_review'))
  })

  it('the stalled objective_events row maps to a needs_agent-feed event', () => {
    expect(webhooks.mapChange('stalled', null, 'working')).toEqual({ event: 'stalled' })
  })
})

describe('transcript classifier', () => {
  const L = (o: unknown) => JSON.stringify(o)

  it('counts only CLI events after the last spawn marker', () => {
    const a = wd.analyzeTranscriptLines([
      L({ type: 'prompt' }), L({ type: 'assistant', message: { content: [{ type: 'text' }] } }),
      L({ type: 'followup' }), L({ type: 'warning' }),
    ])
    expect(a.cliEventsSinceSpawn).toBe(0)
    expect(a.phase).toBe('no_cli_output')
  })

  it('init-only vs model-active, and tool-in-flight detection', () => {
    expect(wd.analyzeTranscriptLines([L({ type: 'prompt' }), L({ type: 'system', subtype: 'init' })]).phase).toBe('init_only')
    const inflight = wd.analyzeTranscriptLines([
      L({ type: 'prompt' }), L({ type: 'system' }),
      L({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash' }] } }),
    ])
    expect(inflight.phase).toBe('model_active')
    expect(inflight.toolInFlight).toBe(true)
    const done = wd.analyzeTranscriptLines([
      L({ type: 'assistant', message: { content: [{ type: 'tool_use' }] } }),
      L({ type: 'user', message: { content: [{ type: 'tool_result' }] } }),
    ])
    expect(done.toolInFlight).toBe(false)
  })

  it('decideStall does not depend on session_count (a card with 0 recorded sessions is judged on liveness + transcript)', () => {
    const d = wd.decideStall({
      sessionId: 'cc-x', alive: true, probe: silentProbe(3, 20)(), spawnStartMs: null,
      fallbackStartMs: NOW - 60 * MIN, nowMs: NOW, config: CONFIG, autoRestarts: 0,
    })
    expect(d.stalled).toBe(false) // wrote 3 min ago → alive and well, whatever the accounting says
  })
})
