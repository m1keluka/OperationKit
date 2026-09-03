// ── Adversarial UAT gate proof (obj-2507, Rec #3) ───────────────────────────
// Proves, against the REAL DB schema and the REAL deterministic-floor command-runner:
//   1. card-validator rejects vim / sed -i / cat > / <placeholders> / no-negative → UAT_SPEC_FAIL;
//   2. the gate EXECUTES a card and returns PASS when every exit code matches;
//   3. PRODUCT_FAIL when a step's exit code does not match (the "green tests, broken service" case);
//   4. mechanical anti-cheat: a git diff showing a touched product file → EVAL_CHEAT_FAIL (overrides);
//   5. CANARY REGRESSION PROOF: a real Tier-1 canary fixture fed through the gate (real runner)
//      returns PRODUCT_FAIL, not PASS;
//   6. verdict taxonomy persists into objective_uat_runs (incl. the criteria_results slot);
//   7. flags: gate is OFF + shadow by default; shadow records without blocking; enforce mode blocks.

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { CommandRunner } from './deterministic-floor.js'

const TMP_DB = path.join(os.tmpdir(), `cc-uat-test-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB

const { initDb, getDb } = await import('../db/index.js')
const {
  validateCard,
  runCard,
  detectCheat,
  runUatGate,
  evaluateUatGate,
  recordUatRun,
  cardFromCanary,
  isUatGateEnabled,
  isUatGateActiveForProject,
  isUatGateShadowMode,
  isUatGateKilled,
  isReviewEnforceEnabled,
  isReviewEnforceActiveForTarget,
} = await import('./uat-gate.js')
const { loadCanaries } = await import('./canary-harness.js')

// Deterministic injected runners (no real process spawn).
const exitRunner = (code: number): CommandRunner => (command) => ({ command, exitCode: code, output: `exit ${code}`, durationMs: 1 })
/** Returns the exit code encoded as the trailing integer of the command, else 0. */
const echoExitRunner: CommandRunner = (command) => {
  const m = command.match(/exit\s+(\d+)/)
  const code = m ? Number(m[1]) : 0
  return { command, exitCode: code, output: command, durationMs: 1 }
}

beforeAll(() => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
})

beforeEach(() => {
  const db = getDb()
  db.exec('DELETE FROM objective_uat_runs')
  db.exec('DELETE FROM objectives')
  db.exec("DELETE FROM activity_log WHERE event_type IN ('error','milestone')")
  db.exec("DELETE FROM settings WHERE key LIKE 'uat_gate%'")
  delete process.env.CC_UAT_GATE_ENABLED
  delete process.env.CC_UAT_GATE_KILLED
  delete process.env.CC_UAT_GATE_BLOCKING
})

afterAll(() => { try { fs.unlinkSync(TMP_DB) } catch {} })

const okCard = {
  steps: [
    { command: 'node check.mjs', expectedExit: 0 },
    { command: 'node negative.mjs exit 1', expectedExit: 1, negative: true },
  ],
}

describe('card-validator', () => {
  it('accepts a clean card with a negative test', () => {
    expect(validateCard(okCard).ok).toBe(true)
  })
  it('rejects an empty card', () => {
    expect(validateCard({ steps: [] }).ok).toBe(false)
  })
  it('rejects a card with no negative test', () => {
    const v = validateCard({ steps: [{ command: 'npm test', expectedExit: 0 }] })
    expect(v.ok).toBe(false)
    expect(v.reason).toMatch(/negative test/i)
  })
  it.each([
    ['vim foo.ts', /editor/i],
    ['sed -i "s/a/b/" x.ts', /sed/i],
    ['cat > out.txt', /cat/i],
    ['npm test -- --id <your-id>', /placeholder/i],
  ])('rejects forbidden command %s', (command, reasonRe) => {
    const v = validateCard({ steps: [{ command, expectedExit: 0 }, { command: 'x', expectedExit: 1, negative: true }] })
    expect(v.ok).toBe(false)
    expect(v.reason).toMatch(reasonRe)
  })
  it('does NOT misfire on shell input redirection (`< file`)', () => {
    const v = validateCard({ steps: [{ command: 'node app.mjs < input.json', expectedExit: 0 }, { command: 'false', expectedExit: 1, negative: true }] })
    expect(v.ok).toBe(true)
  })
})

describe('runCard executes and grades by exact exit codes', () => {
  it('PASS when every step matches', () => {
    const r = runCard(okCard, '/tmp', echoExitRunner)
    expect(r.verdict).toBe('PASS')
    expect(r.steps.every(s => s.passed)).toBe(true)
  })
  it('PRODUCT_FAIL when a positive step exits non-zero (green-tests-broken-service case)', () => {
    // node check.mjs returns exit 7 (broken) though it was claimed to be 0.
    const runner: CommandRunner = (command) => ({ command, exitCode: command.includes('check.mjs') ? 7 : 1, output: '', durationMs: 1 })
    const r = runCard(okCard, '/tmp', runner)
    expect(r.verdict).toBe('PRODUCT_FAIL')
    expect(r.steps[0].passed).toBe(false)
    expect(r.steps[0].actualExit).toBe(7)
  })
})

describe('mechanical anti-cheat', () => {
  it('clean worktree → no cheat', () => {
    expect(detectCheat('').cheated).toBe(false)
  })
  it('a touched product file → cheat, with the path captured', () => {
    const status = ' M app/server/src/services/widget.ts\n?? app/server/src/new.ts'
    const c = detectCheat(status)
    expect(c.cheated).toBe(true)
    expect(c.changedPaths).toContain('app/server/src/services/widget.ts')
    expect(c.changedPaths).toContain('app/server/src/new.ts')
  })
  it('excludes the evidence dir', () => {
    const c = detectCheat('?? .uat-evidence/run.json', '.uat-evidence')
    expect(c.cheated).toBe(false)
  })
  it('runUatGate returns EVAL_CHEAT_FAIL when the evaluator touched a product file (overrides PASS)', () => {
    const result = runUatGate({
      card: okCard,
      worktreeDir: '/tmp/wt',
      runner: echoExitRunner, // product would PASS…
      gitStatus: () => ' M app/server/src/services/payments.ts', // …but evaluator cheated
      noSpawn: true,
    })
    expect(result.verdict).toBe('EVAL_CHEAT_FAIL')
    expect(result.cheatPaths).toContain('app/server/src/services/payments.ts')
    expect(result.criteriaResults.some(c => c.id === 'uat-anticheat' && c.status === 'fail')).toBe(true)
  })
})

describe('runUatGate verdict taxonomy', () => {
  it('UAT_SPEC_FAIL on an invalid card, before any exec', () => {
    const r = runUatGate({ card: { steps: [{ command: 'vim x', expectedExit: 0 }] }, worktreeDir: '/tmp/wt', noSpawn: true })
    expect(r.verdict).toBe('UAT_SPEC_FAIL')
    expect(r.steps).toHaveLength(0)
  })
  it('PASS on a clean run with no cheat', () => {
    const r = runUatGate({ card: okCard, worktreeDir: '/tmp/wt', runner: echoExitRunner, gitStatus: () => '', noSpawn: true })
    expect(r.verdict).toBe('PASS')
  })
  it('PRODUCT_FAIL on a red run with no cheat', () => {
    const r = runUatGate({ card: okCard, worktreeDir: '/tmp/wt', runner: exitRunner(0) /* negative step expects 1, gets 0 */, gitStatus: () => '', noSpawn: true })
    expect(r.verdict).toBe('PRODUCT_FAIL')
  })
})

describe('CANARY REGRESSION PROOF — real Tier-1 fixtures through the real runner', () => {
  it('every Tier-1 canary the UAT gate can mechanically catch returns PRODUCT_FAIL (not PASS)', () => {
    // SCOPE BOUNDARY (obj-2507 vs obj-2508): the UAT gate's mechanism is blind-exec of the
    // sealed card's commands + exact exit-code grading. It catches artifacts that fail to
    // compile, return a wrong value, or have a weakened test (a sealed reference check exits
    // non-zero). It CANNOT catch a "HTTP 200 but writes nothing" state-delta no-op, because
    // such a fixture's commands (compile + the author's own unit test) all pass by design —
    // only a separate `state_delta_command` exposes it, and that is the floor's LAYER-4
    // state-delta machinery shipped in obj-2508 (Rec #4), which this gate does not invoke.
    // We therefore exclude fixtures that carry `state_delta_command` from THIS proof, so the
    // assertion only claims what the gate can mechanically prove. See docs/uat-gate-ENABLEMENT.md.
    const canaries = loadCanaries().filter(c => !c.state_delta_command)
    expect(canaries.length).toBeGreaterThanOrEqual(3)
    for (const canary of canaries) {
      const card = cardFromCanary(canary)
      expect(validateCard(card).ok).toBe(true) // the adapted card is itself valid
      const result = runUatGate({
        card,
        worktreeDir: canary.dir, // run the REAL broken fixture with the REAL execRunner
        gitStatus: () => '',     // no cheat
        noSpawn: true,
      })
      expect(result.verdict, `${canary.id} must be PRODUCT_FAIL`).toBe('PRODUCT_FAIL')
      expect(result.verdict).not.toBe('PASS')
    }
  })
})

describe('persistence — verdict taxonomy + criteria_results slot', () => {
  it('recordUatRun writes the verdict and a criteria_results-shaped column', () => {
    const db = getDb()
    const result = runUatGate({ card: okCard, worktreeDir: '/tmp/wt', runner: echoExitRunner, gitStatus: () => '', noSpawn: true })
    const id = recordUatRun(db, { id: 4242, project: 'command-center-infra', workspace: 'operator', session_id: 'sess-1' }, result, true)
    expect(id).toBeGreaterThan(0)
    const row = db.prepare('SELECT * FROM objective_uat_runs WHERE id = ?').get(id) as any
    expect(row.verdict).toBe('PASS')
    expect(row.shadow).toBe(1)
    const cr = JSON.parse(row.criteria_results)
    expect(Array.isArray(cr)).toBe(true)
    expect(cr[0]).toHaveProperty('status')
    expect(cr[0]).toHaveProperty('expected')
  })
})

describe('flags: OFF + shadow by default; kill switch; enforce', () => {
  it('is OFF by default (not active for a project with no opt-in)', () => {
    const db = getDb()
    expect(isUatGateEnabled(db)).toBe(false)
    expect(isUatGateActiveForProject(db, 'command-center-infra')).toBe(false)
  })
  it('is in SHADOW mode by default', () => {
    expect(isUatGateShadowMode(getDb())).toBe(true)
  })
  it('per-project opt-in arms the gate without flipping the global default', () => {
    const db = getDb()
    db.prepare("INSERT INTO settings (key, value) VALUES ('uat_gate_config:command-center-infra', '{\"enabled\":true}')").run()
    expect(isUatGateEnabled(db)).toBe(false) // global default unchanged
    expect(isUatGateActiveForProject(db, 'command-center-infra')).toBe(true)
    db.exec("DELETE FROM settings WHERE key = 'uat_gate_config:command-center-infra'")
  })
  it('kill switch disarms even an opted-in project', () => {
    const db = getDb()
    db.prepare("INSERT INTO settings (key, value) VALUES ('uat_gate_config:command-center-infra', '{\"enabled\":true}')").run()
    db.prepare("INSERT INTO settings (key, value) VALUES ('uat_gate_killed', '1')").run()
    expect(isUatGateKilled(db)).toBe(true)
    expect(isUatGateActiveForProject(db, 'command-center-infra')).toBe(false)
  })

  it('SHADOW: evaluateUatGate records but does NOT block on PRODUCT_FAIL', () => {
    const db = getDb()
    db.prepare("INSERT INTO objectives (id, title, workspace, status) VALUES (99, 'uat shadow', 'operator', 'working')").run()
    process.env.CC_UAT_GATE_ENABLED = '1' // active, but shadow (no blocking flag)
    const decision = evaluateUatGate(
      db,
      { id: 99, project: 'command-center-infra', workspace: 'operator', session_id: null },
      { card: okCard, worktreeDir: '/tmp/wt', runner: exitRunner(0), gitStatus: () => '', noSpawn: true },
    )
    expect(decision.action).toBe('record') // recorded, not blocked
    const row = db.prepare('SELECT verdict, shadow FROM objective_uat_runs WHERE objective_id = 99').get() as any
    expect(row.verdict).toBe('PRODUCT_FAIL')
    expect(row.shadow).toBe(1)
    // milestone persisted (non-error, since not a cheat)
    const ms = db.prepare("SELECT title FROM activity_log WHERE objective_id = 99 AND event_type = 'milestone'").get() as any
    expect(ms?.title).toMatch(/UAT gate: PRODUCT_FAIL/)
  })

  it('ENFORCE: blocks on PRODUCT_FAIL when the blocking flag is set', () => {
    const db = getDb()
    db.prepare("INSERT INTO objectives (id, title, workspace, status) VALUES (100, 'uat enforce', 'operator', 'working')").run()
    process.env.CC_UAT_GATE_ENABLED = '1'
    process.env.CC_UAT_GATE_BLOCKING = '1'
    const decision = evaluateUatGate(
      db,
      { id: 100, project: 'command-center-infra', workspace: 'operator', session_id: null },
      { card: okCard, worktreeDir: '/tmp/wt', runner: exitRunner(0), gitStatus: () => '', noSpawn: true },
    )
    expect(decision.action).toBe('block')
  })

  it('skips (no-op) when not active', () => {
    const db = getDb()
    const decision = evaluateUatGate(
      db,
      { id: 101, project: 'some-other-project', workspace: 'operator', session_id: null },
      { card: okCard, worktreeDir: '/tmp/wt', runner: echoExitRunner, gitStatus: () => '', noSpawn: true },
    )
    expect(decision.action).toBe('skip')
  })
})

// ── Stage-C review enforcement (obj 700316; kitchen_loop_review_enforce) ────────
describe('kitchen_loop_review_enforce — cheat-check log-only → blocking, command-center ONLY', () => {
  beforeEach(() => {
    const db = getDb()
    db.exec("DELETE FROM settings WHERE key = 'kitchen_loop_review_enforce'")
    delete process.env.CC_KITCHEN_LOOP_REVIEW_ENFORCE
  })

  it('flag OFF by default; reads settings + env', () => {
    const db = getDb()
    expect(isReviewEnforceEnabled(db, {})).toBe(false)
    db.prepare("INSERT INTO settings (key, value) VALUES ('kitchen_loop_review_enforce', '1')").run()
    expect(isReviewEnforceEnabled(db, {})).toBe(true)
    db.exec("DELETE FROM settings WHERE key = 'kitchen_loop_review_enforce'")
    expect(isReviewEnforceEnabled(db, { CC_KITCHEN_LOOP_REVIEW_ENFORCE: 'yes' })).toBe(true)
  })

  it('active ONLY for command-center, even when the flag is ON (blast-radius isolation)', () => {
    const db = getDb()
    db.prepare("INSERT INTO settings (key, value) VALUES ('kitchen_loop_review_enforce', '1')").run()
    expect(isReviewEnforceActiveForTarget(db, 'command-center-infra', {})).toBe(true)
    for (const other of ['example-platform', 'example3-platform', 'example-project-platform', null]) {
      expect(isReviewEnforceActiveForTarget(db, other, {})).toBe(false)
    }
  })

  it('[review-enforce-off-logonly] flag OFF → PRODUCT_FAIL stays SHADOW (record, not block)', () => {
    const db = getDb()
    db.prepare("INSERT INTO objectives (id, title, workspace, status) VALUES (700316, 'enforce off', 'operator', 'working')").run()
    process.env.CC_UAT_GATE_ENABLED = '1' // active but shadow; review_enforce OFF
    const decision = evaluateUatGate(
      db,
      { id: 700316, project: 'command-center-infra', workspace: 'operator', session_id: null },
      { card: okCard, worktreeDir: '/tmp/wt', runner: exitRunner(0), gitStatus: () => '', noSpawn: true },
    )
    expect(decision.action).toBe('record')
    const row = db.prepare('SELECT shadow FROM objective_uat_runs WHERE objective_id = 700316').get() as any
    expect(row.shadow).toBe(1)
  })

  it('[review-enforce-on-cc-only] flag ON + command-center + PRODUCT_FAIL → BLOCK', () => {
    const db = getDb()
    db.prepare("INSERT INTO objectives (id, title, workspace, status) VALUES (700317, 'enforce on cc', 'operator', 'working')").run()
    process.env.CC_UAT_GATE_ENABLED = '1' // active, shadow by uat_gate_blocking…
    db.prepare("INSERT INTO settings (key, value) VALUES ('kitchen_loop_review_enforce', '1')").run() // …flipped by review_enforce
    const decision = evaluateUatGate(
      db,
      { id: 700317, project: 'command-center-infra', workspace: 'operator', session_id: null },
      { card: okCard, worktreeDir: '/tmp/wt', runner: exitRunner(0), gitStatus: () => '', noSpawn: true },
    )
    expect(decision.action).toBe('block')
    const row = db.prepare('SELECT shadow FROM objective_uat_runs WHERE objective_id = 700317').get() as any
    expect(row.shadow).toBe(0) // enforced, not shadow
  })

  it('[review-enforce-on-cc-only] flag ON but a NON-command-center project stays SHADOW (not blocked)', () => {
    const db = getDb()
    db.prepare("INSERT INTO objectives (id, title, workspace, status) VALUES (700318, 'other repo', 'example', 'working')").run()
    // Make the gate active for the other project via its own opt-in row, flag ON.
    db.prepare("INSERT INTO settings (key, value) VALUES ('uat_gate_config:example-platform', '{\"enabled\":true}')").run()
    db.prepare("INSERT INTO settings (key, value) VALUES ('kitchen_loop_review_enforce', '1')").run()
    const decision = evaluateUatGate(
      db,
      { id: 700318, project: 'example-platform', workspace: 'example', session_id: null },
      { card: okCard, worktreeDir: '/tmp/wt', runner: exitRunner(0), gitStatus: () => '', noSpawn: true },
    )
    // review_enforce must NEVER flip a non-pilot project out of shadow.
    expect(decision.action).toBe('record')
    db.exec("DELETE FROM settings WHERE key = 'uat_gate_config:example-platform'")
  })
})
