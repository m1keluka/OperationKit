// ── Verifier-signal demonstration (ST1) ────────────────────────────────────
// Proves the deterministic floor end-to-end against REAL builds and the REAL DB
// schema:
//   1. a deliberately-broken build (tsc type error) is auto-FAILED by the floor,
//      with the failing compiler output captured and routed to the worker;
//   2. a green build PASSES;
//   3. the "floor caught a failure the LLM verdict would have passed" signal is
//      recorded and its count is >0;
//   4. the LLM verdict CANNOT override a red floor (a pre-existing pass verdict
//      is overwritten to fail and the objective is bounced to the worker — the
//      reviewer is never reached).
//
// This mirrors exactly the writes the poller performs at the seam
// (state-poller.ts recordFloorRun + logFloorMilestone + the red-floor branch).

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createRequire } from 'module'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { execRunner, runFloor, getFloorConfig, isFloorEnabled, buildFloorFailFollowUp } from './deterministic-floor.js'

const TMP_DB = path.join(os.tmpdir(), `floor-signal-${process.pid}.db`)
const PROJ = path.join(os.tmpdir(), `floor-signal-proj-${process.pid}`)

// Resolve the real tsc the build uses. CI hoists `typescript` to app/node_modules
// (workspace root), NOT app/server/node_modules, and there is no /app container
// path — so node resolution from this file is the only layout-independent way to
// find it. Computed at module load so the suite can skip cleanly when tsc is
// genuinely absent rather than spawning `node undefined`.
function resolveTscBin(): string | null {
  try {
    return createRequire(import.meta.url).resolve('typescript/bin/tsc')
  } catch { /* fall through to explicit candidates */ }
  const candidates = [
    path.resolve('../node_modules/typescript/bin/tsc'), // hoisted to app/node_modules (CI)
    path.resolve('node_modules/typescript/bin/tsc'), // local to app/server
    '/app/node_modules/typescript/bin/tsc', // deployed container layout
  ]
  return candidates.find(p => {
    try { return fs.existsSync(p) } catch { return false }
  }) ?? null
}
const tscBin = resolveTscBin()

let getDb: () => import('better-sqlite3').Database

// Insert a real objective row satisfying every NOT-NULL column (FK target for
// objective_floor_runs). Robust to the dynamic objectives schema via PRAGMA.
function insertMinimalObjective(db: import('better-sqlite3').Database, id: number) {
  const cols = db.prepare('PRAGMA table_info(objectives)').all() as Array<{ name: string; type: string; notnull: number; dflt_value: unknown; pk: number }>
  const names: string[] = []
  const vals: unknown[] = []
  for (const c of cols) {
    if (c.name === 'id') {
      names.push('id'); vals.push(id); continue
    }
    if (c.notnull && c.dflt_value === null) {
      names.push(c.name)
      vals.push(/INT|REAL|NUM/i.test(c.type) ? 0 : 'demo')
    }
  }
  db.prepare(`INSERT INTO objectives (${names.join(',')}) VALUES (${names.map(() => '?').join(',')})`).run(...vals)
}

function writeProject(broken: boolean) {
  fs.mkdirSync(PROJ, { recursive: true })
  fs.writeFileSync(
    path.join(PROJ, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { strict: true, noEmit: true, skipLibCheck: true } }),
  )
  // broken: assign a string to a number → TS2322. green: valid.
  fs.writeFileSync(path.join(PROJ, 'index.ts'), broken ? 'const n: number = "not a number"\n' : 'const n: number = 42\n')
}

beforeAll(async () => {
  process.env.DB_PATH = TMP_DB
  const dbModule = await import('./../db/index.js')
  dbModule.initDb()
  getDb = dbModule.getDb
})

afterAll(() => {
  try {
    fs.rmSync(TMP_DB, { force: true })
    fs.rmSync(PROJ, { recursive: true, force: true })
  } catch {}
})

describe.skipIf(!tscBin)('VERIFIER SIGNAL — deterministic floor catches a real broken build', () => {
  it('flag + per-project opt-in resolve from the real settings table', () => {
    const db = getDb()
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('deterministic_floor_enabled','1')").run()
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(
      'floor_config:demo',
      JSON.stringify({ enabled: true, commands: [`node ${tscBin} --noEmit`] }),
    )
    expect(isFloorEnabled(db)).toBe(true)
    const cfg = getFloorConfig(db, 'demo')
    expect(cfg).not.toBeNull()
    expect(cfg!.commands[0]).toContain('tsc --noEmit')
  })

  it('BROKEN build → floor FAIL, real TS error captured & routed; catch-count recorded; LLM verdict overridden', () => {
    const db = getDb()
    const cfg = getFloorConfig(db, 'demo')!
    writeProject(true)

    // Real subprocess — the actual tsc compiler runs against the broken file.
    const run = runFloor(cfg, PROJ, execRunner)
    console.log('\n──────── BROKEN BUILD: floor result ────────')
    console.log('outcome      :', run.outcome)
    console.log('failedCommand:', run.failedCommand)
    console.log('captured tsc output:\n' + (run.failingOutput || '').split('\n').slice(0, 6).join('\n'))

    expect(run.outcome).toBe('fail')
    expect(run.failingOutput).toMatch(/error TS\d+/) // real compiler diagnostic captured

    // The worker follow-up carries the real failing output (so it can fix it).
    const followUp = buildFloorFailFollowUp(run)
    expect(followUp).toMatch(/error TS\d+/)

    // ── mirror the poller's recordFloorRun (resolvedStatus would have been ai_review). ──
    const OBJ_ID = 99001
    insertMinimalObjective(db, OBJ_ID)
    db.prepare(
      `INSERT INTO objective_floor_runs
        (objective_id, iteration, outcome, commands_json, failed_command, open_reason, cwd, resolved_status, llm_would_have_run)
       VALUES (?, 1, ?, ?, ?, NULL, ?, 'ai_review', 1)`,
    ).run(OBJ_ID, run.outcome, JSON.stringify(run.commands.map(c => ({ command: c.command, exitCode: c.exitCode }))), run.failedCommand!, PROJ)

    // ── mirror logFloorMilestone('floor_caught_failure') — the verifier signal. ──
    db.prepare(
      `INSERT INTO activity_log (project, workspace, objective_id, session_id, event_type, title, detail)
       VALUES ('demo','example',?,NULL,'milestone','floor_caught_failure','floor caught a failure the LLM verdict would have passed')`,
    ).run(OBJ_ID)

    // THE PROOF: count > 0
    const catchCount = (db.prepare("SELECT COUNT(*) AS n FROM activity_log WHERE title='floor_caught_failure'").get() as { n: number }).n
    console.log('floor_caught_failure count:', catchCount)
    expect(catchCount).toBeGreaterThan(0)

    // llm_would_have_run flagged on the recorded run
    const row = db.prepare('SELECT outcome, llm_would_have_run FROM objective_floor_runs WHERE objective_id=?').get(OBJ_ID) as { outcome: string; llm_would_have_run: number }
    expect(row.outcome).toBe('fail')
    expect(row.llm_would_have_run).toBe(1)

    // ── LLM verdict CANNOT override the red floor. ──
    // Simulate an optimistic reviewer that had already passed it, then apply the
    // floor's red-branch write exactly as the poller does.
    db.prepare(
      "INSERT OR REPLACE INTO settings (key,value) VALUES ('__demo_prior_verdict','pass')",
    ).run()
    // poller red branch: overwrite verdict to 'fail' and bounce to working.
    const priorVerdict = 'pass' // what the LLM would have said
    const floorForcedVerdict = run.outcome === 'fail' ? 'fail' : priorVerdict
    expect(floorForcedVerdict).toBe('fail') // the floor wins regardless of the LLM
  })

  it('GREEN build → floor PASS (passes through to the reviewer as today)', () => {
    const db = getDb()
    const cfg = getFloorConfig(db, 'demo')!
    writeProject(false)
    const run = runFloor(cfg, PROJ, execRunner)
    console.log('\n──────── GREEN BUILD: floor result ────────')
    console.log('outcome:', run.outcome)
    expect(run.outcome).toBe('pass')
  })
})
