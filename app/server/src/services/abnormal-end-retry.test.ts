import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { Objective } from '@operationkit/shared'

// obj 900547 — a worker killed mid-turn (real work, no `result`) gets ONE
// automatic resume-with-context; the next abnormal end flags it through the
// stall watchdog's path (stalled_at → objective_events 'stalled' → needs_agent,
// alert) and parks it blocked with the cause. The cap is the watchdog's own
// `stall_restarts` (PR 673), so the two automatic paths share one budget.

const TMP_DB = path.join(os.tmpdir(), `cc-abnormal-end-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB

const { initDb, getDb } = await import('../db/index.js')
const ae = await import('./abnormal-end-retry.js')
const wd = await import('./stall-watchdog.js')
const reasons = await import('./session-start-reasons.js')

beforeAll(() => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
})
afterAll(() => {
  try { getDb().close() } catch { /* closed */ }
  for (const s of ['', '-wal', '-shm']) { const f = `${TMP_DB}${s}`; if (fs.existsSync(f)) fs.unlinkSync(f) }
})
beforeEach(() => {
  const db = getDb()
  db.prepare('DELETE FROM objectives').run()
  db.prepare("DELETE FROM settings WHERE key LIKE 'stall_watchdog%'").run()
})

const J = (o: unknown) => JSON.stringify(o)
const toolTurn = (id: string) => J({ type: 'assistant', message: { id, model: 'claude-opus-5-5', usage: { input_tokens: 1, output_tokens: 10 }, content: [{ type: 'tool_use', id: `t${id}`, name: 'Bash', input: {} }] } })

/** #900543's shape: prompt, init, work, then nothing — the process was killed. */
const KILLED = [J({ type: 'prompt', text: 'go' }), J({ type: 'system', subtype: 'init' }), toolTurn('m1'), toolTurn('m2'), toolTurn('m3')]
const CLEAN = [...KILLED, J({ type: 'result', subtype: 'success', result: 'done' })]
const NO_MODEL = [J({ type: 'prompt', text: 'go' }), J({ type: 'system', subtype: 'init' })]

function seed(sessionId = 'cc-424242-1'): Objective {
  const db = getDb()
  const r = db.prepare(
    `INSERT INTO objectives (title, agent_context, workspace, project, status, session_id)
     VALUES ('UI quality pass', 'cto', 'operationkit', 'operationkit', 'working', ?)`,
  ).run(sessionId)
  return db.prepare('SELECT * FROM objectives WHERE id = ?').get(r.lastInsertRowid) as Objective
}

function harness(lines: string[], opts: { resumeThrows?: boolean } = {}) {
  const calls = { resume: [] as string[], notes: [] as string[], alerts: [] as string[], broadcasts: 0 }
  const deps = {
    db: getDb(),
    now: () => Date.parse('2026-11-11T05:11:00Z'),
    readLines: () => lines,
    resume: (_o: Objective, msg: string) => { if (opts.resumeThrows) throw new Error('spawn failed'); calls.resume.push(msg) },
    noteStartReason: (_id: number, d: string) => { calls.notes.push(d) },
    notify: (_row: unknown, reason: string) => { calls.alerts.push(reason) },
    broadcast: () => { calls.broadcasts++ },
  }
  return { deps, calls }
}

const row = (id: number) => getDb().prepare('SELECT * FROM objectives WHERE id = ?').get(id) as Record<string, unknown>

describe('analyzeSegmentEnd / decideAbnormalEnd', () => {
  it('a killed segment has work and no result', () => {
    expect(ae.analyzeSegmentEnd(KILLED)).toEqual({ hasResult: false, assistantMessages: 3, toolCalls: 3 })
    expect(ae.analyzeSegmentEnd(CLEAN).hasResult).toBe(true)
  })
  it('only the CURRENT spawn segment counts (an earlier result does not mask a later kill)', () => {
    const lines = [...CLEAN, J({ type: 'followup', text: 'more' }), toolTurn('m9')]
    expect(ae.analyzeSegmentEnd(lines)).toEqual({ hasResult: false, assistantMessages: 1, toolCalls: 1 })
  })
  it('decides none / retry / flag', () => {
    const base = { status: 'working', delegateMode: false, segment: ae.analyzeSegmentEnd(KILLED), autoRestarts: 0, maxAutoRestarts: 1, enabled: true }
    expect(ae.decideAbnormalEnd(base)).toBe('retry')
    expect(ae.decideAbnormalEnd({ ...base, autoRestarts: 1 })).toBe('flag')
    expect(ae.decideAbnormalEnd({ ...base, segment: ae.analyzeSegmentEnd(CLEAN) })).toBe('none')
    expect(ae.decideAbnormalEnd({ ...base, segment: ae.analyzeSegmentEnd(NO_MODEL) })).toBe('none')
    expect(ae.decideAbnormalEnd({ ...base, status: 'review' })).toBe('none')
    expect(ae.decideAbnormalEnd({ ...base, delegateMode: true })).toBe('none')
    expect(ae.decideAbnormalEnd({ ...base, enabled: false })).toBe('none')
  })
})

describe('handleAbnormalEnd', () => {
  it('first abnormal end → ONE resume with context, card stays working, budget spent', () => {
    const o = seed()
    const h = harness(KILLED)
    expect(ae.handleAbnormalEnd(o, h.deps)).toBe(true)
    expect(h.calls.resume).toHaveLength(1)
    expect(h.calls.resume[0]).toMatch(/auto-retry/)
    expect(h.calls.resume[0]).toMatch(/git status/)
    expect(h.calls.notes[0]).toMatch(/ended abnormally/)
    expect(h.calls.alerts).toEqual([])
    const r = row(o.id)
    expect(r.status).toBe('working')
    expect(r.stall_restarts).toBe(1)
    expect(r.stalled_at).toBeNull()
  })

  it('second abnormal end → flag (needs_agent kind=stalled + alert) and blocked verdict, no resume', () => {
    const o = seed()
    expect(ae.handleAbnormalEnd(o, harness(KILLED).deps)).toBe(true)

    const h2 = harness(KILLED)
    expect(ae.handleAbnormalEnd(row(o.id) as unknown as Objective, h2.deps)).toBe(false)
    expect(h2.calls.resume).toEqual([])
    expect(h2.calls.alerts).toHaveLength(1)
    expect(h2.calls.alerts[0]).toMatch(/second abnormal end/)
    const r = row(o.id)
    expect(r.stalled_at).not.toBeNull()
    expect(String(r.stall_reason)).toMatch(/ended abnormally/)
    expect(r.ai_review_verdict).toBe('blocked')
    expect(String(r.ai_review_findings)).toMatch(/3 tool call/)
    // The trigger PR 673 installed turns the flag into the needs_agent event.
    const ev = getDb().prepare("SELECT kind FROM objective_events WHERE objective_id = ? AND kind = 'stalled'").all(o.id)
    expect(ev).toHaveLength(1)
  })

  it('shares ONE budget with the stall watchdog: a spent stall restart means the abnormal end flags', () => {
    const o = seed()
    getDb().prepare('UPDATE objectives SET stall_restarts = 1 WHERE id = ?').run(o.id)
    const h = harness(KILLED)
    expect(ae.handleAbnormalEnd(o, h.deps)).toBe(false)
    expect(h.calls.resume).toEqual([])
    expect(h.calls.alerts).toHaveLength(1)
  })

  it('a failed retry flags instead of silently parking', () => {
    const o = seed()
    const h = harness(KILLED, { resumeThrows: true })
    expect(ae.handleAbnormalEnd(o, h.deps)).toBe(false)
    expect(h.calls.alerts[0]).toMatch(/Auto-retry failed: spawn failed/)
    expect(row(o.id).stalled_at).not.toBeNull()
  })

  it('a clean end and a no-model spawn are left to the existing routing', () => {
    const a = seed('cc-1-1')
    expect(ae.handleAbnormalEnd(a, harness(CLEAN).deps)).toBe(false)
    const b = seed('cc-2-1')
    expect(ae.handleAbnormalEnd(b, harness(NO_MODEL).deps)).toBe(false)
    expect(row(a.id).stall_restarts ?? 0).toBe(0)
    expect(row(b.id).stall_restarts ?? 0).toBe(0)
  })

  it('honours the stall watchdog kill switches', () => {
    const o = seed()
    getDb().prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('stall_watchdog_max_restarts', '0')").run()
    const h = harness(KILLED)
    expect(ae.handleAbnormalEnd(o, h.deps)).toBe(false)
    expect(h.calls.resume).toEqual([]) // restarts off → flag only
    expect(h.calls.alerts).toHaveLength(1)

    const o2 = seed('cc-9-9')
    getDb().prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('stall_watchdog_enabled', '0')").run()
    const h2 = harness(KILLED)
    expect(ae.handleAbnormalEnd(o2, h2.deps)).toBe(false)
    expect(h2.calls.alerts).toEqual([])
  })

  it('its own restart does NOT re-arm the budget; a human start does', () => {
    const o = seed()
    const db = getDb()
    db.prepare('UPDATE objectives SET stall_restarts = 1 WHERE id = ?').run(o.id)
    reasons.logSessionStart(db, { objectiveId: o.id, sessionId: o.session_id, kind: 'resume', reason: { reason: ae.ABNORMAL_END_START_REASON } as never })
    expect(row(o.id).stall_restarts).toBe(1)
    reasons.logSessionStart(db, { objectiveId: o.id, sessionId: o.session_id, kind: 'resume', reason: { reason: 'follow_up' } as never })
    expect(row(o.id).stall_restarts).toBe(0)
    expect(wd.STALL_START_REASON).toBe('stall_watchdog')
  })
})
