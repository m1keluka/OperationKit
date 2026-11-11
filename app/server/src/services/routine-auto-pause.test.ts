// Script routines through fireRoutine + K-consecutive-failure auto-pause (obj 64 Part B).
//
// DB_PATH → temp sqlite; PORT → dead port and fetch is stubbed so the card-spawn
// PATCH never reaches a live Command Center. The script executor is stubbed via
// _setScriptExecutorForTests, so no real process runs here (the real executor is
// covered in routine-script.test.ts).

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { RoutineRow } from './routine-scheduler.js'
import type { ScriptExecResult } from './routine-script.js'

const TMP_DB = path.join(os.tmpdir(), `cc-routine-autopause-test-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB
process.env.PORT = '59948'
process.env.ALERTS_ENABLED = 'false'
delete process.env.CC_ROUTINE_AUTO_PAUSE_FAILURES

const { initDb, getDb } = await import('../db/index.js')
const { fireRoutine } = await import('./routine-scheduler.js')
const { _setScriptExecutorForTests } = await import('./routine-script.js')
const { reconcileAiRunOutcomes, resumeRoutine, autoPauseThreshold, classifyAiFireResult } = await import(
  './routine-auto-pause.js'
)
const { _resetDedupForTests } = await import('./notifier.js')

let seq = 0
function seedRoutine(fields: Partial<RoutineRow> & { objective_template?: string } = {}): RoutineRow {
  const db = getDb()
  const id = db
    .prepare(
      `INSERT INTO routines (name, cron_expr, objective_template, enabled, max_queue_depth)
       VALUES (?, '0 * * * *', ?, 1, ?)`,
    )
    .run(`r-${++seq}`, fields.objective_template ?? '{}', fields.max_queue_depth ?? 5).lastInsertRowid as number
  const cols = ['kind', 'script_command', 'alert_marker', 'max_consecutive_failures'] as const
  for (const c of cols) {
    if (fields[c] !== undefined) db.prepare(`UPDATE routines SET ${c} = ? WHERE id = ?`).run(fields[c], id)
  }
  return load(id)
}
const load = (id: number) => getDb().prepare('SELECT * FROM routines WHERE id = ?').get(id) as RoutineRow
const cardsFor = (id: number) =>
  getDb().prepare('SELECT * FROM objectives WHERE routine_id = ? ORDER BY id').all(id) as {
    id: number
    title: string
    description: string
  }[]

function stubExec(result: Partial<ScriptExecResult>) {
  const fn = vi.fn(async (): Promise<ScriptExecResult> => ({
    exitCode: 0,
    timedOut: false,
    output: '',
    durationMs: 1,
    ...result,
  }))
  _setScriptExecutorForTests(fn)
  return fn
}

function setGlobalK(v: string | null) {
  const db = getDb()
  if (v == null) db.prepare("DELETE FROM settings WHERE key = 'routine_auto_pause_failures'").run()
  else
    db.prepare(
      "INSERT INTO settings (key, value) VALUES ('routine_auto_pause_failures', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(v)
}

beforeAll(() => {
  for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) if (fs.existsSync(f)) fs.unlinkSync(f)
  initDb()
})
beforeEach(() => {
  getDb().prepare('DELETE FROM objectives').run()
  getDb().prepare('DELETE FROM activity_log').run()
  setGlobalK(null)
  _resetDedupForTests()
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }))
})
afterEach(() => {
  vi.restoreAllMocks()
  _setScriptExecutorForTests(null)
  delete process.env.CC_ROUTINE_AUTO_PAUSE_FAILURES
})
afterAll(() => {
  try { getDb().close() } catch { /* ignore */ }
  for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) if (fs.existsSync(f)) fs.unlinkSync(f)
})

describe('script routine via fireRoutine', () => {
  it('exit 0 → status ok, NO card, no model call, streak reset', async () => {
    const r = seedRoutine({ kind: 'script', script_command: 'check.sh' })
    getDb().prepare('UPDATE routines SET consecutive_failures = 3 WHERE id = ?').run(r.id)
    const exec = stubExec({ exitCode: 0, output: 'all fine\n' })
    const res = await fireRoutine(load(r.id), 'run-now')
    expect(exec).toHaveBeenCalledWith('check.sh', expect.objectContaining({ timeoutMs: 600_000 }))
    expect(res.ok).toBe(true)
    expect(cardsFor(r.id)).toHaveLength(0)
    expect(globalThis.fetch).not.toHaveBeenCalled()
    const row = load(r.id)
    expect(row).toMatchObject({ last_run_status: 'ok', last_exit_code: 0, consecutive_failures: 0, enabled: 1 })
    expect(row.last_output_tail).toBe('all fine\n')
    expect(row.last_run_at).toBeTruthy()
  })

  it('non-zero exit → escalation card from the template with the output tail, failure counted', async () => {
    const r = seedRoutine({
      kind: 'script',
      script_command: 'check.sh',
      objective_template: JSON.stringify({ title: 'Investigate check', description: 'Look into it.', workspace: 'example' }),
    })
    stubExec({ exitCode: 2, output: 'step 1\nconnection refused\n' })
    const res = await fireRoutine(load(r.id), 'run-now')
    expect(res.ok).toBe(false)
    const cards = cardsFor(r.id)
    expect(cards).toHaveLength(1)
    expect(cards[0].title).toBe('Investigate check')
    expect(cards[0].description).toContain('Look into it.')
    expect(cards[0].description).toContain('connection refused')
    expect(cards[0].description).toContain('exit 2')
    expect(load(r.id)).toMatchObject({ last_run_status: 'failed', last_exit_code: 2, consecutive_failures: 1 })
  })

  it("exit 0 with an 'ALERT:' line → card, NOT counted as a failure", async () => {
    const r = seedRoutine({ kind: 'script', script_command: 'check.sh' })
    getDb().prepare('UPDATE routines SET consecutive_failures = 2 WHERE id = ?').run(r.id)
    stubExec({ exitCode: 0, output: 'ok\nALERT: queue backlog 900\n' })
    const res = await fireRoutine(load(r.id), 'run-now')
    expect(res.ok).toBe(true)
    const cards = cardsFor(r.id)
    expect(cards).toHaveLength(1)
    // No template → generated fallback title.
    expect(cards[0].title).toBe(`Routine '${r.name}' script alert`)
    expect(cards[0].description).toContain('ALERT: queue backlog 900')
    expect(load(r.id)).toMatchObject({ last_run_status: 'alert', consecutive_failures: 0 })
  })

  it('custom marker escalates; the default marker is then ignored', async () => {
    const r = seedRoutine({ kind: 'script', script_command: 'x', alert_marker: '[page]' })
    stubExec({ exitCode: 0, output: 'ALERT: ignored\n' })
    await fireRoutine(load(r.id), 'run-now')
    expect(cardsFor(r.id)).toHaveLength(0)
    stubExec({ exitCode: 0, output: '[page] dns down\n' })
    await fireRoutine(load(r.id), 'run-now')
    expect(cardsFor(r.id)).toHaveLength(1)
    expect(load(r.id).last_run_status).toBe('alert')
  })

  it('marker mid-line does not escalate', async () => {
    const r = seedRoutine({ kind: 'script', script_command: 'x' })
    stubExec({ exitCode: 0, output: 'saw "ALERT: maybe" in a log\n' })
    await fireRoutine(load(r.id), 'run-now')
    expect(cardsFor(r.id)).toHaveLength(0)
    expect(load(r.id).last_run_status).toBe('ok')
  })

  it('timeout → failed + counted', async () => {
    const r = seedRoutine({ kind: 'script', script_command: 'sleep 999' })
    stubExec({ exitCode: null, timedOut: true, output: 'partial' })
    const res = await fireRoutine(load(r.id), 'run-now')
    expect(res.ok).toBe(false)
    expect(res.reason).toContain('timed out')
    expect(load(r.id)).toMatchObject({ last_run_status: 'failed', consecutive_failures: 1 })
  })

  it('background mode returns immediately and records the result when the script finishes', async () => {
    const r = seedRoutine({ kind: 'script', script_command: 'x' })
    let release!: () => void
    const gate = new Promise<void>(res => { release = res })
    _setScriptExecutorForTests(async () => {
      await gate
      return { exitCode: 0, timedOut: false, output: 'done', durationMs: 1 }
    })
    const res = await fireRoutine(load(r.id), 'run-now', { background: true })
    expect(res).toMatchObject({ ok: true, reason: 'script run started' })
    // A second fire while running is a benign skip, not a failure.
    const again = await fireRoutine(load(r.id), 'run-now')
    expect(again).toMatchObject({ ok: false, reason: 'script already running' })
    release()
    await vi.waitFor(() => expect(load(r.id).last_run_status).toBe('ok'))
    expect(load(r.id).consecutive_failures).toBe(0)
  })
})

describe('auto-pause after K consecutive failures', () => {
  it('K-1 failures stay enabled; the K-th pauses with reason, activity row and alert', async () => {
    const r = seedRoutine({ kind: 'script', script_command: 'x', max_queue_depth: 1 })
    stubExec({ exitCode: 7, output: 'bad' })
    for (let i = 0; i < 4; i++) await fireRoutine(load(r.id), 'run-now')
    expect(load(r.id)).toMatchObject({ enabled: 1, consecutive_failures: 4, auto_paused_at: null })

    await fireRoutine(load(r.id), 'run-now')
    const row = load(r.id)
    expect(row.enabled).toBe(0)
    expect(row.consecutive_failures).toBe(5)
    expect(row.auto_paused_at).toBeTruthy()
    expect(row.auto_pause_reason).toBe('auto-paused: 5 failures, last error exit 7')

    const act = getDb().prepare("SELECT * FROM activity_log WHERE title LIKE '%auto-paused%'").all() as {
      event_type: string
      metadata: string
    }[]
    expect(act).toHaveLength(1)
    expect(act[0].event_type).toBe('blocker')
    expect(JSON.parse(act[0].metadata)).toMatchObject({ kind: 'routine_auto_paused', routine_id: r.id })
    const alert = getDb().prepare('SELECT * FROM alerts WHERE dedup_key = ?').get(`routine-auto-paused-${r.id}`)
    expect(alert).toBeTruthy()
  })

  it('a success resets the streak', async () => {
    const r = seedRoutine({ kind: 'script', script_command: 'x' })
    stubExec({ exitCode: 1 })
    for (let i = 0; i < 4; i++) await fireRoutine(load(r.id), 'run-now')
    expect(load(r.id).consecutive_failures).toBe(4)
    stubExec({ exitCode: 0 })
    await fireRoutine(load(r.id), 'run-now')
    expect(load(r.id).consecutive_failures).toBe(0)
    stubExec({ exitCode: 1 })
    for (let i = 0; i < 4; i++) await fireRoutine(load(r.id), 'run-now')
    expect(load(r.id).enabled).toBe(1)
  })

  it('per-routine K overrides the global setting; env overrides the setting', async () => {
    setGlobalK('10')
    const r = seedRoutine({ kind: 'script', script_command: 'x', max_consecutive_failures: 2 })
    expect(autoPauseThreshold(load(r.id))).toBe(2)
    stubExec({ exitCode: 1 })
    await fireRoutine(load(r.id), 'run-now')
    expect(load(r.id).enabled).toBe(1)
    await fireRoutine(load(r.id), 'run-now')
    expect(load(r.id).enabled).toBe(0)
    expect(load(r.id).auto_pause_reason).toMatch(/^auto-paused: 2 failures/)

    const g = seedRoutine({ kind: 'script', script_command: 'x' })
    expect(autoPauseThreshold(load(g.id))).toBe(10)
    process.env.CC_ROUTINE_AUTO_PAUSE_FAILURES = '3'
    expect(autoPauseThreshold(load(g.id))).toBe(3)
    expect(autoPauseThreshold(load(r.id))).toBe(2)
  })

  it('K = 0 disables auto-pause', async () => {
    const r = seedRoutine({ kind: 'script', script_command: 'x', max_consecutive_failures: 0 })
    stubExec({ exitCode: 1 })
    for (let i = 0; i < 6; i++) await fireRoutine(load(r.id), 'run-now')
    expect(load(r.id)).toMatchObject({ enabled: 1, consecutive_failures: 6 })
  })

  it('resumeRoutine re-enables, clears the streak + auto-pause fields, logs activity', async () => {
    const r = seedRoutine({ kind: 'script', script_command: 'x', max_consecutive_failures: 1 })
    stubExec({ exitCode: 1 })
    await fireRoutine(load(r.id), 'run-now')
    expect(load(r.id).enabled).toBe(0)
    expect(resumeRoutine(r.id, 'test')).toBe(true)
    expect(load(r.id)).toMatchObject({ enabled: 1, consecutive_failures: 0, auto_paused_at: null, auto_pause_reason: null })
    const act = getDb().prepare("SELECT metadata FROM activity_log WHERE title LIKE '%resumed%'").get() as { metadata: string }
    expect(JSON.parse(act.metadata)).toMatchObject({ kind: 'routine_resumed', actor: 'test' })
    expect(resumeRoutine(999999)).toBe(false)
  })
})

describe('AI routine failure accounting', () => {
  it('classifies fire results: real errors fail, guard skips are neutral', () => {
    expect(classifyAiFireResult({ ok: false, reason: 'objective_template is not valid JSON' })).toBe('failure')
    expect(classifyAiFireResult({ ok: true, reason: 'created but spawn failed: 500 x' })).toBe('failure')
    expect(classifyAiFireResult({ ok: false, reason: 'stranded objective 4 still not spawning: 409' })).toBe('failure')
    expect(classifyAiFireResult({ ok: false, reason: 'queue depth guard: 1 in-flight' })).toBe('neutral')
    expect(classifyAiFireResult({ ok: false, reason: 'concurrency guard: 25 active' })).toBe('neutral')
    expect(classifyAiFireResult({ ok: false, reason: 'over-fire guard: last run 1 min ago' })).toBe('neutral')
    expect(classifyAiFireResult({ ok: false, reason: 'duplicate guard: open card #3' })).toBe('neutral')
    expect(classifyAiFireResult({ ok: true })).toBe('neutral')
  })

  it('an invalid template counts toward auto-pause', async () => {
    const r = seedRoutine({ objective_template: 'not json', max_consecutive_failures: 2 })
    await fireRoutine(load(r.id), 'run-now')
    expect(load(r.id)).toMatchObject({ consecutive_failures: 1, enabled: 1, last_error: 'objective_template is not valid JSON' })
    await fireRoutine(load(r.id), 'run-now')
    expect(load(r.id).enabled).toBe(0)
  })

  it('a queue-depth skip neither counts nor resets', async () => {
    const r = seedRoutine({ objective_template: JSON.stringify({ title: 'T' }), max_queue_depth: 1 })
    getDb().prepare('UPDATE routines SET consecutive_failures = 2 WHERE id = ?').run(r.id)
    getDb()
      .prepare("INSERT INTO objectives (title, agent_context, workspace, status, routine_id) VALUES ('T', 'general', 'example', 'working', ?)")
      .run(r.id)
    const res = await fireRoutine(load(r.id), 'run-now')
    expect(res.reason).toMatch(/queue depth guard/)
    expect(load(r.id).consecutive_failures).toBe(2)
  })

  it('run outcomes: cancelled / review-fail count; done resets; stops at the first in-flight run', async () => {
    const r = seedRoutine({ objective_template: JSON.stringify({ title: 'T' }), max_consecutive_failures: 3 })
    const ins = (status: string, verdict: string | null = null) =>
      getDb()
        .prepare(
          "INSERT INTO objectives (title, agent_context, workspace, status, routine_id, ai_review_verdict) VALUES ('T', 'general', 'example', ?, ?, ?)",
        )
        .run(status, r.id, verdict).lastInsertRowid as number
    ins('cancelled')
    ins('review', 'fail')
    const inflight = ins('working')
    ins('cancelled')
    await reconcileAiRunOutcomes(r.id)
    expect(load(r.id)).toMatchObject({ consecutive_failures: 2, enabled: 1 })
    // Re-running is idempotent (watermark).
    await reconcileAiRunOutcomes(r.id)
    expect(load(r.id).consecutive_failures).toBe(2)
    // The in-flight run finishes cancelled → it and the one after it count → K=3 reached.
    getDb().prepare("UPDATE objectives SET status = 'cancelled' WHERE id = ?").run(inflight)
    await reconcileAiRunOutcomes(r.id)
    const row = load(r.id)
    expect(row.enabled).toBe(0)
    expect(row.auto_pause_reason).toMatch(/^auto-paused: 3 failures, last error run objective #\d+ ended failed/)

    resumeRoutine(r.id)
    ins('done')
    getDb().prepare('UPDATE routines SET consecutive_failures = 2 WHERE id = ?').run(r.id)
    await reconcileAiRunOutcomes(r.id)
    expect(load(r.id).consecutive_failures).toBe(0)
  })

  it('a script routine ignores reconcile (its escalation cards are not runs)', async () => {
    const r = seedRoutine({ kind: 'script', script_command: 'x' })
    getDb()
      .prepare("INSERT INTO objectives (title, agent_context, workspace, status, routine_id) VALUES ('T', 'general', 'example', 'cancelled', ?)")
      .run(r.id)
    await reconcileAiRunOutcomes(r.id)
    expect(load(r.id).consecutive_failures).toBe(0)
  })
})
