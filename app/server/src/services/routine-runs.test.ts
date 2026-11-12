// Per-run execution history (obj 900676): every routine fire is recorded in
// routine_runs and can be listed / opened through the Jobs → Executions API.
//
// DB_PATH → temp sqlite; PORT → a dead port and fetch is stubbed so the card-spawn
// PATCH never reaches a live Command Center; the script executor is stubbed.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'
import type { RoutineRow } from './routine-scheduler.js'
import type { ScriptExecResult } from './routine-script.js'
import type { JobExecutionDetailResponse, JobExecutionsResponse } from '../../../shared/job-executions.js'

const TMP_DB = path.join(os.tmpdir(), `cc-routine-runs-test-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB
process.env.PORT = '59947'
process.env.ALERTS_ENABLED = 'false'

const { initDb, getDb } = await import('../db/index.js')
const { fireRoutine } = await import('./routine-scheduler.js')
const { _setScriptExecutorForTests } = await import('./routine-script.js')
const { fireResultStatus, objectiveExecutionStatus, flowRunExecutionStatus, beginRoutineRun, ROUTINE_RUNS_KEEP_PER_ROUTINE } =
  await import('./routine-runs.js')
const { default: jobsRouter } = await import('../routes/admin-jobs.js')

let seq = 0
function seedRoutine(fields: { kind?: string; script_command?: string; objective_template?: string; max_queue_depth?: number } = {}): RoutineRow {
  const db = getDb()
  const id = db
    .prepare(
      `INSERT INTO routines (name, cron_expr, objective_template, enabled, max_queue_depth)
       VALUES (?, '3 6 * * *', ?, 1, ?)`,
    )
    .run(`rr-${++seq}`, fields.objective_template ?? JSON.stringify({ title: 'Daily check', workspace: 'example' }), fields.max_queue_depth ?? 5)
    .lastInsertRowid as number
  if (fields.kind) db.prepare('UPDATE routines SET kind = ?, script_command = ? WHERE id = ?').run(fields.kind, fields.script_command ?? null, id)
  return load(id)
}
const load = (id: number) => getDb().prepare('SELECT * FROM routines WHERE id = ?').get(id) as RoutineRow
const runsFor = (id: number) =>
  getDb().prepare('SELECT * FROM routine_runs WHERE routine_id = ? ORDER BY id').all(id) as Record<string, unknown>[]

function stubExec(result: Partial<ScriptExecResult>) {
  _setScriptExecutorForTests(async () => ({ exitCode: 0, timedOut: false, output: '', durationMs: 42, ...result }))
}

let server: http.Server
let base: string
function getJson<T>(p: string): Promise<{ status: number; body: T }> {
  return new Promise((resolve, reject) => {
    http.get(base + p, res => {
      let data = ''
      res.on('data', c => { data += c })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) as T }))
    }).on('error', reject)
  })
}

beforeAll(async () => {
  for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) if (fs.existsSync(f)) fs.unlinkSync(f)
  initDb()
  const app = express()
  app.use(express.json())
  app.use('/api/admin', jobsRouter)
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => resolve()) })
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})
beforeEach(() => {
  getDb().prepare('DELETE FROM objectives').run()
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }))
})
afterEach(() => {
  vi.restoreAllMocks()
  _setScriptExecutorForTests(null)
})
afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
  try { getDb().close() } catch { /* ignore */ }
  for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) if (fs.existsSync(f)) fs.unlinkSync(f)
})

describe('recording: every fire leaves a routine_runs row', () => {
  it('script run → succeeded row with exit code, duration and the FULL output (not just the 4KB tail)', async () => {
    const r = seedRoutine({ kind: 'script', script_command: 'check.sh' })
    const big = 'line\n'.repeat(2000) + 'final ok\n' // ~10KB > the 4KB last_output_tail
    stubExec({ exitCode: 0, output: big })
    await fireRoutine(load(r.id), 'cron')
    const rows = runsFor(r.id)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: 'script', source: 'cron', status: 'succeeded', exit_code: 0, duration_ms: 42, output: big })
    expect(rows[0].ended_at).toBeTruthy()
  })

  it('two runs are two rows — the earlier run is not overwritten', async () => {
    const r = seedRoutine({ kind: 'script', script_command: 'check.sh' })
    stubExec({ exitCode: 0, output: 'first\n' })
    await fireRoutine(load(r.id), 'run-now')
    stubExec({ exitCode: 3, output: 'second broke\n' })
    await fireRoutine(load(r.id), 'run-now')
    const rows = runsFor(r.id)
    expect(rows.map(x => [x.status, x.output])).toEqual([['succeeded', 'first\n'], ['failed', 'second broke\n']])
    expect(rows[1].objective_id).toBeTruthy() // the failure escalated to a card, linked on the run
  })

  it('a background script run closes its own row when the script exits', async () => {
    const r = seedRoutine({ kind: 'script', script_command: 'slow.sh' })
    let release!: () => void
    const gate = new Promise<void>(res => { release = res })
    _setScriptExecutorForTests(async () => { await gate; return { exitCode: 0, timedOut: false, output: 'done\n', durationMs: 5 } })
    const res = await fireRoutine(load(r.id), 'run-now', { background: true })
    expect(res.reason).toBe('script run started')
    expect(runsFor(r.id)[0].status).toBe('running')
    release()
    await vi.waitFor(() => expect(runsFor(r.id)[0]).toMatchObject({ status: 'succeeded', output: 'done\n' }))
  })

  it('AI run → dispatched row linked to the card it filed', async () => {
    const r = seedRoutine()
    const res = await fireRoutine(load(r.id), 'run-now')
    expect(res.ok).toBe(true)
    const rows = runsFor(r.id)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: 'ai', source: 'run-now', status: 'dispatched', objective_id: res.objective_id })
  })

  it('a refused fire is recorded as skipped, with the guard reason', async () => {
    const r = seedRoutine({ max_queue_depth: 1 })
    await fireRoutine(load(r.id), 'run-now')
    const res = await fireRoutine(load(r.id), 'run-now') // first card still in flight
    expect(res.ok).toBe(false)
    const rows = runsFor(r.id)
    expect(rows[1]).toMatchObject({ status: 'skipped' })
    expect(String(rows[1].reason)).toMatch(/^queue depth guard/)
  })

  it('history is capped per routine', () => {
    const r = seedRoutine()
    for (let i = 0; i < ROUTINE_RUNS_KEEP_PER_ROUTINE + 3; i++) beginRoutineRun(getDb(), r, 'cron')
    expect(runsFor(r.id)).toHaveLength(ROUTINE_RUNS_KEEP_PER_ROUTINE)
  })
})

describe('API: GET /api/admin/routines/:id/executions[/:key]', () => {
  it('lists every run newest first, including a card filed before history existed', async () => {
    const r = seedRoutine()
    // A routine card from before obj 900676 (no routine_runs row).
    const legacy = getDb()
      .prepare(
        "INSERT INTO objectives (title, workspace, status, routine_id, origin, created_at) VALUES ('Old run', 'example', 'done', ?, 'routine', '2026-11-01 06:03:00')",
      )
      .run(r.id).lastInsertRowid as number
    const fired = await fireRoutine(load(r.id), 'cron')
    const { status, body } = await getJson<JobExecutionsResponse>(`/api/admin/routines/${r.id}/executions`)
    expect(status).toBe(200)
    expect(body.routine).toMatchObject({ id: r.id, title: 'Daily check', kind: 'ai' })
    expect(body.executions.map(e => e.objective_id)).toEqual([fired.objective_id, legacy])
    expect(body.executions[0]).toMatchObject({ source: 'cron', status: 'running', key: expect.stringMatching(/^rr-\d+$/) })
    expect(body.executions[1]).toMatchObject({ key: `obj-${legacy}`, source: 'unknown', status: 'succeeded', started_at: '2026-11-01T06:03:00Z' })
  })

  it('opens one run: the log says what happened, a script run carries its output and command', async () => {
    const r = seedRoutine({ kind: 'script', script_command: 'check.sh --deep' })
    stubExec({ exitCode: 0, output: 'checked 12 hosts\nALERT: disk 91%\n' })
    await fireRoutine(load(r.id), 'cron')
    const list = await getJson<JobExecutionsResponse>(`/api/admin/routines/${r.id}/executions`)
    const exec = list.body.executions[0]
    expect(exec).toMatchObject({ kind: 'script', status: 'alert', exit_code: 0 })
    const { status, body } = await getJson<JobExecutionDetailResponse>(`/api/admin/routines/${r.id}/executions/${exec.key}`)
    expect(status).toBe(200)
    expect(body.output).toBe('checked 12 hosts\nALERT: disk 91%\n')
    expect(body.command).toBe('check.sh --deep')
    expect(body.log.map(l => l.label)).toEqual(['Fired by the schedule', 'Script exited with code 0', expect.stringMatching(/^Escalated to card #\d+$/)])
    expect(body.objective?.id).toBe(exec.objective_id)
  })

  it('an AI run log carries the card, its activity and the outcome', async () => {
    const r = seedRoutine()
    const fired = await fireRoutine(load(r.id), 'run-now')
    const id = fired.objective_id as number
    getDb().prepare("INSERT INTO activity_log (project, workspace, objective_id, event_type, title) VALUES ('p', 'example', ?, 'milestone', 'Report sent')").run(id)
    getDb().prepare("UPDATE objectives SET status = 'done', last_session_summary = 'All 4 checks passed.' WHERE id = ?").run(id)
    const list = await getJson<JobExecutionsResponse>(`/api/admin/routines/${r.id}/executions`)
    const { body } = await getJson<JobExecutionDetailResponse>(`/api/admin/routines/${r.id}/executions/${list.body.executions[0].key}`)
    expect(body.execution.status).toBe('succeeded')
    const labels = body.log.map(l => l.label)
    expect(labels[0]).toBe('Fired by Run now')
    expect(labels).toContain(`Card #${id} filed`)
    expect(labels).toContain('Report sent')
    expect(labels).toContain('Session summary')
    expect(labels[labels.length - 1]).toBe('Finished: succeeded')
  })

  it('404s a key that belongs to another routine, 400s a bad id', async () => {
    const a = seedRoutine()
    const b = seedRoutine()
    const fired = await fireRoutine(load(a.id), 'run-now')
    expect((await getJson(`/api/admin/routines/${b.id}/executions/obj-${fired.objective_id}`)).status).toBe(404)
    expect((await getJson(`/api/admin/routines/${b.id}/executions/nonsense`)).status).toBe(404)
    expect((await getJson('/api/admin/routines/abc/executions')).status).toBe(400)
    expect((await getJson('/api/admin/routines/999999/executions')).status).toBe(404)
  })
})

describe('status mapping', () => {
  it('fire results', () => {
    expect(fireResultStatus({ ok: true, objective_id: 1 })).toBe('dispatched')
    expect(fireResultStatus({ ok: true, flow_run_id: 1 })).toBe('dispatched')
    expect(fireResultStatus({ ok: true, objective_id: 1, reason: 'created but spawn failed: 500' })).toBe('failed')
    expect(fireResultStatus({ ok: false, reason: 'over-fire guard: …' })).toBe('skipped')
    expect(fireResultStatus({ ok: false, reason: 'flows disabled: settings.flows_enabled is not 1' })).toBe('skipped')
    expect(fireResultStatus({ ok: false, reason: 'objective_template is not valid JSON' })).toBe('failed')
  })
  it('cards and flow runs', () => {
    expect(objectiveExecutionStatus({ status: 'working', job_disposition: null })).toBe('running')
    expect(objectiveExecutionStatus({ status: 'done', job_disposition: 'needs_review' })).toBe('needs_review')
    expect(objectiveExecutionStatus({ status: 'done', job_disposition: null })).toBe('succeeded')
    expect(objectiveExecutionStatus({ status: 'cancelled', job_disposition: null })).toBe('cancelled')
    expect(flowRunExecutionStatus({ status: 'succeeded', goal_met: 0 })).toBe('failed')
    expect(flowRunExecutionStatus({ status: 'waiting', goal_met: null })).toBe('waiting')
    expect(flowRunExecutionStatus({ status: 'queued', goal_met: null })).toBe('running')
  })
})
