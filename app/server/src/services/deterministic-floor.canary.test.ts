// ── CANARY PROOF (obj 2335) ─────────────────────────────────────────────────
// End-to-end proof, against the REAL tsc compiler and the REAL DB schema, that:
//   1. a pilot project is armed via a `floor_config:<project>` row while the
//      GLOBAL default flag stays 0 (never flipped);
//   2. a GOOD change passes the floor → an objective_floor_runs row with passed=1
//      and the gate decision is `proceed` (the transition is allowed);
//   3. a CANARY known-bad change (a TS type error) FAILS the floor → a row with
//      passed=0 and the gate decision is `block` (the transition is REFUSED);
//   4. the proof row carries the criterion's flat columns
//      (objective_id, project, command, exit_code, passed, created_at).
//
// Mirrors exactly the seam both callers use: evaluateFloorGate + recordFloorRunRow.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createRequire } from 'module'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  evaluateFloorGate,
  execRunner,
  runFloor,
  getFloorConfig,
  isFloorEnabled,
  isFloorActiveForProject,
  recordFloorRunRow,
  logFloorMilestoneRow,
  type FloorObjectiveRef,
} from './deterministic-floor.js'

const TMP_DB = path.join(os.tmpdir(), `floor-canary-${process.pid}.db`)
const PROJ = path.join(os.tmpdir(), `floor-canary-proj-${process.pid}`)
const PILOT = 'pilot-project'

function resolveTscBin(): string | null {
  try {
    return createRequire(import.meta.url).resolve('typescript/bin/tsc')
  } catch { /* fall through */ }
  const candidates = [
    path.resolve('../node_modules/typescript/bin/tsc'),
    path.resolve('node_modules/typescript/bin/tsc'),
    '/app/node_modules/typescript/bin/tsc',
  ]
  return candidates.find(p => { try { return fs.existsSync(p) } catch { return false } }) ?? null
}
const tscBin = resolveTscBin()

function insertMinimalObjective(db: import('better-sqlite3').Database, id: number, project: string) {
  const cols = db.prepare('PRAGMA table_info(objectives)').all() as Array<{ name: string; type: string; notnull: number; dflt_value: unknown }>
  const names: string[] = []
  const vals: unknown[] = []
  for (const c of cols) {
    if (c.name === 'id') { names.push('id'); vals.push(id); continue }
    if (c.name === 'project') { names.push('project'); vals.push(project); continue }
    if (c.notnull && c.dflt_value === null) {
      names.push(c.name)
      vals.push(/INT|REAL|NUM/i.test(c.type) ? 0 : 'demo')
    }
  }
  db.prepare(`INSERT INTO objectives (${names.join(',')}) VALUES (${names.map(() => '?').join(',')})`).run(...vals)
}

function writeProject(broken: boolean) {
  fs.mkdirSync(PROJ, { recursive: true })
  fs.writeFileSync(path.join(PROJ, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, skipLibCheck: true } }))
  fs.writeFileSync(path.join(PROJ, 'index.ts'), broken ? 'const n: number = "canary — known bad change"\n' : 'const n: number = 42\n')
}

let getDb: () => import('better-sqlite3').Database

beforeAll(async () => {
  process.env.DB_PATH = TMP_DB
  const dbModule = await import('./../db/index.js')
  dbModule.initDb()
  getDb = dbModule.getDb
})
afterAll(() => {
  try { fs.rmSync(TMP_DB, { force: true }); fs.rmSync(PROJ, { recursive: true, force: true }) } catch {}
})

const ref = (id: number): FloorObjectiveRef => ({ id, project: PILOT, workspace: 'operator', session_id: null, ai_review_iteration: 0 })

describe.skipIf(!tscBin)('CANARY PROOF — pilot armed via DB row, global default stays 0', () => {
  it('pilot opt-in arms the floor while deterministic_floor_enabled stays 0', () => {
    const db = getDb()
    // Seed ONLY the per-project opt-in row. Do NOT touch the global flag.
    db.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)').run(
      `floor_config:${PILOT}`,
      JSON.stringify({ enabled: true, commands: [`node ${tscBin} --noEmit`] }),
    )
    expect(isFloorEnabled(db)).toBe(false)                       // global default UNTOUCHED
    expect(isFloorActiveForProject(db, PILOT)).toBe(true)        // pilot armed
    expect(isFloorActiveForProject(db, 'unrelated-project')).toBe(false) // nobody else
    expect(getFloorConfig(db, PILOT)).not.toBeNull()
  })

  it('GOOD change → gate proceeds, objective_floor_runs row passed=1', () => {
    const db = getDb()
    writeProject(false)
    const o = ref(95001)
    insertMinimalObjective(db, o.id, PILOT)
    const decision = evaluateFloorGate({
      getConfig: () => getFloorConfig(db, PILOT),
      resolveCwd: () => PROJ,
      run: (cfg, cwd) => runFloor(cfg, cwd, execRunner),
      record: (cwd, run) => recordFloorRunRow(db, o, 'done', cwd, run, false),
      logMilestone: (t, d) => logFloorMilestoneRow(db, o, t, d),
    })
    expect(decision.action).toBe('proceed')

    const row = db.prepare('SELECT objective_id, project, command, exit_code, passed, created_at FROM objective_floor_runs WHERE objective_id=?').get(o.id) as Record<string, unknown>
    console.log('\n──────── GOOD change — objective_floor_runs row ────────')
    console.log(JSON.stringify(row, null, 2))
    expect(row.passed).toBe(1)
    expect(row.project).toBe(PILOT)
    expect(row.exit_code).toBe(0)
  })

  it('CANARY bad change → gate BLOCKS, objective_floor_runs row passed=0, transition refused', () => {
    const db = getDb()
    writeProject(true)
    const o = ref(95002)
    insertMinimalObjective(db, o.id, PILOT)
    const decision = evaluateFloorGate({
      getConfig: () => getFloorConfig(db, PILOT),
      resolveCwd: () => PROJ,
      run: (cfg, cwd) => runFloor(cfg, cwd, execRunner),
      record: (cwd, run) => recordFloorRunRow(db, o, 'done', cwd, run, false),
      logMilestone: (t, d) => logFloorMilestoneRow(db, o, t, d),
    })

    // The gate refuses the completion — the caller must NOT advance to done.
    expect(decision.action).toBe('block')
    if (decision.action === 'block') {
      expect(decision.run.failedCommand).toContain('tsc')
      expect(decision.followUp).toMatch(/error TS\d+/) // real compiler diagnostic routed to the worker
    }

    const row = db.prepare('SELECT objective_id, project, command, exit_code, passed, created_at FROM objective_floor_runs WHERE objective_id=?').get(o.id) as Record<string, unknown>
    console.log('\n──────── CANARY bad change — objective_floor_runs row ────────')
    console.log(JSON.stringify(row, null, 2))
    expect(row.passed).toBe(0)
    expect(row.project).toBe(PILOT)
    expect(Number(row.exit_code)).not.toBe(0)

    // Prove the canary was CAUGHT and recorded as a blocking fail.
    const failCount = (db.prepare("SELECT COUNT(*) AS n FROM objective_floor_runs WHERE passed=0").get() as { n: number }).n
    expect(failCount).toBeGreaterThan(0)
  })
})
