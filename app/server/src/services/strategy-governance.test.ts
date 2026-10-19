import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

// Temp-file DB so initDb's real schema runs (incl. the obj-2385 objective_reviews
// rebuild that allows mode='decision' + verdict='pending'). Set DB_PATH before
// importing the db module (mirrors false-pass.test).
const TMP_DB = path.join(os.tmpdir(), `cc-strategy-gov-test-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB

const { initDb, getDb } = await import('../db/index.js')
const gov = await import('./strategy-governance.js')

let nextObjId = 1
function makeStrategy(effort = 'normal', costUsd = 0): number {
  const db = getDb()
  const id = nextObjId++
  db.prepare(
    "INSERT INTO objectives (id, title, agent_context, workspace, status, delegate_mode, parent_id, depth, effort, total_cost_usd) VALUES (?, ?, 'cto', 'operator', 'working', 1, NULL, 0, ?, ?)"
  ).run(id, `strategy-${id}`, effort, costUsd)
  return id
}
function makeProject(parentId: number, depth: number, costUsd = 0): number {
  const db = getDb()
  const id = nextObjId++
  db.prepare(
    "INSERT INTO objectives (id, title, agent_context, workspace, status, delegate_mode, parent_id, depth, total_cost_usd) VALUES (?, ?, 'cto', 'operator', 'working', 1, ?, ?, ?)"
  ).run(id, `project-${id}`, parentId, depth, costUsd)
  return id
}

beforeAll(() => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
})
beforeEach(() => {
  const db = getDb()
  db.exec('DELETE FROM objective_reviews')
  db.exec('DELETE FROM objectives')
  nextObjId = 1
  delete process.env.STRATEGY_MAX_PROJECTS
  delete process.env.STRATEGY_CEILING_NORMAL_USD
  delete process.env.CC_STRATEGY_TIER
  try { getDb().prepare("DELETE FROM settings WHERE key = 'strategy_tier_enabled'").run() } catch {}
})
afterAll(() => { try { fs.unlinkSync(TMP_DB) } catch {} })

describe('decideKillSwitch (pure)', () => {
  it('does not trip below both ceilings', () => {
    const v = gov.decideKillSwitch({ spendUsd: 500, spendCeilingUsd: 1000, projectCount: 3, projectCeiling: 12 })
    expect(v.tripped).toBe(false)
    expect(v.reasons).toHaveLength(0)
  })
  it('trips on spend ceiling', () => {
    const v = gov.decideKillSwitch({ spendUsd: 1000, spendCeilingUsd: 1000, projectCount: 1, projectCeiling: 12 })
    expect(v.tripped).toBe(true)
    expect(v.reasons[0]).toMatch(/spend ceiling/)
  })
  it('trips on project ceiling', () => {
    const v = gov.decideKillSwitch({ spendUsd: 1, spendCeilingUsd: 1000, projectCount: 12, projectCeiling: 12 })
    expect(v.tripped).toBe(true)
    expect(v.reasons[0]).toMatch(/project ceiling/)
  })
  it('reports both reasons when both trip', () => {
    const v = gov.decideKillSwitch({ spendUsd: 2000, spendCeilingUsd: 1000, projectCount: 20, projectCeiling: 12 })
    expect(v.reasons).toHaveLength(2)
  })
  it('treats a zero/negative ceiling as disabled', () => {
    const v = gov.decideKillSwitch({ spendUsd: 9999, spendCeilingUsd: 0, projectCount: 99, projectCeiling: 0 })
    expect(v.tripped).toBe(false)
  })
})

describe('evaluateKillSwitch (live subtree)', () => {
  it('sums subtree spend and counts direct projects, honoring effort + env', () => {
    const db = getDb()
    const s = makeStrategy('normal', 100)
    const p1 = makeProject(s, 1, 200)
    makeProject(s, 1, 300)
    makeProject(p1, 2, 50) // grandchild task — counts toward spend, NOT project count
    const strat = db.prepare('SELECT * FROM objectives WHERE id = ?').get(s) as any
    const ks = gov.evaluateKillSwitch(db, strat)
    expect(ks.spendUsd).toBe(650)
    expect(ks.projectCount).toBe(2)
    expect(ks.spendCeilingUsd).toBe(1000)
    expect(ks.tripped).toBe(false)
  })
  it('trips once env-lowered ceiling is crossed', () => {
    process.env.STRATEGY_CEILING_NORMAL_USD = '100'
    const db = getDb()
    const s = makeStrategy('normal', 0)
    makeProject(s, 1, 150)
    const strat = db.prepare('SELECT * FROM objectives WHERE id = ?').get(s) as any
    const ks = gov.evaluateKillSwitch(db, strat)
    expect(ks.tripped).toBe(true)
  })
})

describe('isStrategyObjective', () => {
  it('true only for top-level delegators', () => {
    expect(gov.isStrategyObjective({ delegate_mode: true, parent_id: null })).toBe(true)
    expect(gov.isStrategyObjective({ delegate_mode: true, parent_id: 5 })).toBe(false)
    expect(gov.isStrategyObjective({ delegate_mode: false, parent_id: null })).toBe(false)
  })
})

describe('validateDecisionRequest', () => {
  const good = {
    kind: 'spawn-next',
    decision: 'Spawn the auth-hardening project',
    evidence: ['Project #10 passed 4/4 criteria', 'Subtree spend $120'],
    options: [{ id: 'A', label: 'Spawn auth project' }, { id: 'B', label: 'Stop here' }],
    recommendation: 'A',
  }
  it('accepts a well-formed request', () => {
    const r = gov.validateDecisionRequest(good)
    expect(r.ok).toBe(true)
  })
  it('rejects an unknown kind', () => {
    expect(gov.validateDecisionRequest({ ...good, kind: 'frobnicate' }).ok).toBe(false)
  })
  it('rejects empty evidence', () => {
    expect(gov.validateDecisionRequest({ ...good, evidence: [] }).ok).toBe(false)
    expect(gov.validateDecisionRequest({ ...good, evidence: ['   '] }).ok).toBe(false)
  })
  it('rejects missing recommendation', () => {
    const { recommendation, ...rest } = good
    expect(gov.validateDecisionRequest(rest).ok).toBe(false)
  })
  it('rejects empty options', () => {
    expect(gov.validateDecisionRequest({ ...good, options: [] }).ok).toBe(false)
  })
})

describe('decision lifecycle (objective_reviews mode=decision)', () => {
  const req = {
    kind: 'spawn-next' as const,
    decision: 'Spawn project X',
    evidence: ['signal 1'],
    options: [{ id: 'A', label: 'do it' }],
    recommendation: 'A',
  }
  it('creates a pending decision and reads it back', () => {
    const db = getDb()
    const s = makeStrategy()
    const created = gov.createDecisionRequest(db, s, req, 'sess-1')
    expect(created.verdict).toBe('pending')
    const pending = gov.getPendingDecision(db, s)
    expect(pending?.id).toBe(created.id)
    expect(pending?.request.decision).toBe('Spawn project X')
  })
  it('approve resolves to pass and emits APPROVED follow-up', () => {
    const db = getDb()
    const s = makeStrategy()
    const created = gov.createDecisionRequest(db, s, req, 'sess-1')
    const resolved = gov.resolveDecision(db, created.id, { choice: 'approve', option_id: 'A' })
    expect(resolved?.decision.verdict).toBe('pass')
    expect(resolved?.followUp).toMatch(/APPROVED/)
    expect(gov.getPendingDecision(db, s)).toBeNull()
  })
  it('deny resolves to fail and emits DENIED follow-up', () => {
    const db = getDb()
    const s = makeStrategy()
    const created = gov.createDecisionRequest(db, s, req, 'sess-1')
    const resolved = gov.resolveDecision(db, created.id, { choice: 'deny', note: 'wrong direction' })
    expect(resolved?.decision.verdict).toBe('fail')
    expect(resolved?.followUp).toMatch(/DENIED/)
    expect(resolved?.followUp).toMatch(/wrong direction/)
  })
  it('persists pending verdict (CHECK allows it) — proves the rebuild ran', () => {
    const db = getDb()
    const s = makeStrategy()
    gov.createDecisionRequest(db, s, req, 'sess-1')
    const row = db.prepare("SELECT verdict, mode FROM objective_reviews WHERE objective_id = ?").get(s) as any
    expect(row.verdict).toBe('pending')
    expect(row.mode).toBe('decision')
  })
})

// ── Progressive-trust ladder (obj 2511) — pure functions, no DB ──────────────
const ALL_KINDS = ['spawn-next', 'pivot', 'stop', 're-scope'] as const

describe('decideTrustStageAction (pure)', () => {
  it('Stage 0 gates EVERY decision kind (full-gate default)', () => {
    for (const kind of ALL_KINDS) {
      // metrics that would otherwise auto-allow at a higher stage must not matter
      expect(gov.decideTrustStageAction(0, kind, { autonomyEnabled: true, conformsToPlanOfRecord: true, reversible: true }))
        .toBe('gate')
    }
  })

  it('a negative / NaN stage is treated as full-gate (fail-safe)', () => {
    expect(gov.decideTrustStageAction(-1, 'spawn-next', { conformsToPlanOfRecord: true })).toBe('gate')
    expect(gov.decideTrustStageAction(NaN, 'spawn-next', { conformsToPlanOfRecord: true })).toBe('gate')
  })

  it('Stage 1 auto-allows a plan-conforming reversible spawn, gates a deviating one', () => {
    expect(gov.decideTrustStageAction(1, 'spawn-next', { conformsToPlanOfRecord: true, reversible: true })).toBe('auto-allow')
    expect(gov.decideTrustStageAction(1, 'spawn-next', { conformsToPlanOfRecord: false, reversible: true })).toBe('gate')
    // re-scope is NOT auto-allowed until Stage 2
    expect(gov.decideTrustStageAction(1, 're-scope', { reversible: true })).toBe('gate')
  })

  it('Stage 2 auto-allows reversible spawn-next + re-scope, gates irreversible', () => {
    expect(gov.decideTrustStageAction(2, 'spawn-next', { reversible: true })).toBe('auto-allow')
    expect(gov.decideTrustStageAction(2, 're-scope', { reversible: true })).toBe('auto-allow')
    expect(gov.decideTrustStageAction(2, 'spawn-next', { reversible: false })).toBe('gate')
  })

  it('PIVOT and STOP stay gated until the FINAL stage (3)', () => {
    for (const s of [1, 2]) {
      expect(gov.decideTrustStageAction(s, 'pivot', { autonomyEnabled: true })).toBe('gate')
      expect(gov.decideTrustStageAction(s, 'stop', { autonomyEnabled: true })).toBe('gate')
    }
    // only at the final stage do direction + termination auto-allow
    expect(gov.decideTrustStageAction(3, 'pivot', {})).toBe('auto-allow')
    expect(gov.decideTrustStageAction(3, 'stop', {})).toBe('auto-allow')
  })

  it('a tripped kill-switch gates everything regardless of stage (instant demotion)', () => {
    for (const s of [1, 2, 3]) {
      for (const kind of ALL_KINDS) {
        expect(gov.decideTrustStageAction(s, kind, { killSwitchTripped: true, reversible: true, conformsToPlanOfRecord: true }))
          .toBe('gate')
      }
    }
  })

  it('an explicitly disabled master switch gates everything (global off-switch)', () => {
    expect(gov.decideTrustStageAction(3, 'spawn-next', { autonomyEnabled: false, reversible: true })).toBe('gate')
    expect(gov.decideTrustStageAction(3, 'pivot', { autonomyEnabled: false })).toBe('gate')
  })
})

describe('decideTrustTransition (pure) — asymmetric ladder', () => {
  const HEALTHY = {
    consecutiveApproved: 8, denials: 0, approvalRate: 0.95,
    falsePassRate: 0.02, shippedProjects: 5, strategyReviewPassRate: 0.99, mikeOptIn: true,
  }

  it('promotion is metric-driven: 0→1 only when consecutive/denials/rate thresholds all clear', () => {
    expect(gov.decideTrustTransition(0, HEALTHY).promoteTo).toBe(1)
    // one short of the streak → not eligible
    expect(gov.decideTrustTransition(0, { ...HEALTHY, consecutiveApproved: 7 }).promoteTo).toBeNull()
    // any denial → not eligible
    expect(gov.decideTrustTransition(0, { ...HEALTHY, denials: 1 }).promoteTo).toBeNull()
    // approval rate below 0.90 → not eligible
    expect(gov.decideTrustTransition(0, { ...HEALTHY, approvalRate: 0.89 }).promoteTo).toBeNull()
  })

  it('promotion never auto-applies — it only reports eligibility (advisory)', () => {
    const t = gov.decideTrustTransition(0, HEALTHY)
    expect(t.promoteTo).toBe(1) // eligible…
    expect(t.demoteTo).toBeNull() // …but the stage itself is unchanged; a human confirms
  })

  it('1→2 requires the streak, a low false-pass rate, and ≥3 shipped projects', () => {
    expect(gov.decideTrustTransition(1, { ...HEALTHY, consecutiveApproved: 15 }).promoteTo).toBe(2)
    expect(gov.decideTrustTransition(1, { ...HEALTHY, consecutiveApproved: 15, falsePassRate: 0.1 }).promoteTo).toBeNull()
    expect(gov.decideTrustTransition(1, { ...HEALTHY, consecutiveApproved: 15, shippedProjects: 2 }).promoteTo).toBeNull()
  })

  it('2→3 additionally requires explicit Mike opt-in (never automatic)', () => {
    expect(gov.decideTrustTransition(2, HEALTHY).promoteTo).toBe(3)
    expect(gov.decideTrustTransition(2, { ...HEALTHY, mikeOptIn: false }).promoteTo).toBeNull()
  })

  it('no promotion past the final stage', () => {
    expect(gov.decideTrustTransition(3, HEALTHY).promoteTo).toBeNull()
  })

  it('demotion is instant + automatic on a kill-switch trip, one rung down, floored at 0', () => {
    expect(gov.decideTrustTransition(3, { ...HEALTHY, killSwitchTripped: true }).demoteTo).toBe(2)
    expect(gov.decideTrustTransition(1, { ...HEALTHY, killSwitchTripped: true }).demoteTo).toBe(0)
    expect(gov.decideTrustTransition(0, { ...HEALTHY, killSwitchTripped: true }).demoteTo).toBe(0)
  })

  it('a kill-switch trip wins over otherwise-eligible promotion metrics', () => {
    // metrics clear the bar, but the kill-switch forces demotion, not promotion
    const t = gov.decideTrustTransition(2, { ...HEALTHY, killSwitchTripped: true })
    expect(t.promoteTo).toBeNull()
    expect(t.demoteTo).toBe(1)
  })
})

// ── Part A: the ONE shared strategy-tier flag (obj 700030) ───────────────────
// isStrategyTierEnabled is true when EITHER the env var OR the settings row is on
// (OR semantics, env back-compat), false when both are off (flag-off equivalence).
function setTierSetting(value: string) {
  getDb().prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('strategy_tier_enabled', ?)").run(value)
}

describe('isStrategyTierEnabled (env OR settings)', () => {
  it('TRUE when env CC_STRATEGY_TIER=1 and the setting is unset (back-compat path unchanged)', () => {
    process.env.CC_STRATEGY_TIER = '1'
    getDb().prepare("DELETE FROM settings WHERE key = 'strategy_tier_enabled'").run()
    expect(gov.isStrategyTierEnabled(getDb())).toBe(true)
    expect(gov.isStrategyTierEnabled()).toBe(true) // db arg optional → shared db
  })
  it('TRUE when settings.strategy_tier_enabled=1 and env is unset (new runtime toggle)', () => {
    delete process.env.CC_STRATEGY_TIER
    setTierSetting('1')
    expect(gov.isStrategyTierEnabled(getDb())).toBe(true)
  })
  it('FALSE when BOTH are off (env unset AND setting absent) — flag-off equivalence', () => {
    delete process.env.CC_STRATEGY_TIER
    getDb().prepare("DELETE FROM settings WHERE key = 'strategy_tier_enabled'").run()
    expect(gov.isStrategyTierEnabled(getDb())).toBe(false)
  })
  it('FALSE when the setting is explicitly 0 and env unset', () => {
    delete process.env.CC_STRATEGY_TIER
    setTierSetting('0')
    expect(gov.isStrategyTierEnabled(getDb())).toBe(false)
  })
})

// ── Part B helpers: approved-decision consumption (obj 700030) ───────────────
describe('listApprovedUnconsumedDecisions / consumeDecision', () => {
  const req = {
    kind: 'spawn-next' as const,
    decision: 'Spawn project X',
    evidence: ['signal 1'],
    options: [{ id: 'A', label: 'do it' }],
    recommendation: 'A',
  }
  it('lists an approved decision until it is consumed, then never again (no replay)', () => {
    const db = getDb()
    const s = makeStrategy()
    const created = gov.createDecisionRequest(db, s, req, 'sess-1')
    // pending is not yet authorizing
    expect(gov.listApprovedUnconsumedDecisions(db, s)).toHaveLength(0)
    gov.resolveDecision(db, created.id, { choice: 'approve', option_id: 'A' })
    expect(gov.listApprovedUnconsumedDecisions(db, s).map((d) => d.id)).toEqual([created.id])
    // consume → removed from the authorizing set (one approval = one spawn)
    expect(gov.consumeDecision(db, created.id)).toBe(true)
    expect(gov.listApprovedUnconsumedDecisions(db, s)).toHaveLength(0)
    // request + resolution preserved through consumption
    const after = gov.getDecisionById(db, created.id)
    expect(after?.verdict).toBe('pass')
    expect(after?.consumed).toBe(true)
    expect(after?.request.decision).toBe('Spawn project X')
  })
  it('a DENIED decision never authorizes a spawn', () => {
    const db = getDb()
    const s = makeStrategy()
    const created = gov.createDecisionRequest(db, s, req, 'sess-1')
    gov.resolveDecision(db, created.id, { choice: 'deny' })
    expect(gov.listApprovedUnconsumedDecisions(db, s)).toHaveLength(0)
  })
})

describe('computeStrategyRollup (shared list+detail rollup, obj 700132)', () => {
  // Seed a direct child of `parentId` with an explicit status (and optional cost).
  function makeChild(parentId: number, status: string, costUsd = 0): number {
    const db = getDb()
    const id = nextObjId++
    db.prepare(
      "INSERT INTO objectives (id, title, agent_context, workspace, status, delegate_mode, parent_id, depth, total_cost_usd) VALUES (?, ?, 'cto', 'operator', ?, 0, ?, 1, ?)"
    ).run(id, `child-${id}`, status, parentId, costUsd)
    return id
  }
  const rollupReq: import('./strategy-governance.js').DecisionRequest = {
    kind: 'spawn-next',
    decision: 'Spawn project X',
    evidence: ['signal'],
    options: [{ id: 'A', label: 'do A' }],
    recommendation: 'A',
  }

  it('returns the full rollup shape with mixed-status counts + a pending decision', () => {
    const db = getDb()
    const s = makeStrategy('normal', 100)
    // Mixed-status direct children: 2 done, 1 working, 1 queue, 1 review, 1 planning.
    makeChild(s, 'done', 10)
    makeChild(s, 'done', 20)
    makeChild(s, 'working', 30)
    makeChild(s, 'queue')
    makeChild(s, 'review')
    makeChild(s, 'planning') // counts toward total only (not a named bucket)
    // A pending Stage-0 decision.
    const decision = gov.createDecisionRequest(db, s, rollupReq, 'sess-1')

    const strat = db.prepare('SELECT * FROM objectives WHERE id = ?').get(s) as any
    const rollup = gov.computeStrategyRollup(db, strat)

    // children counts
    expect(rollup.children).toEqual({ total: 6, done: 2, working: 1, queued: 1, review: 1 })
    // budget mirrors evaluateKillSwitch (subtree spend = 100+10+20+30 = 160; 6 projects)
    expect(rollup.budget.spendUsd).toBe(160)
    expect(rollup.budget.projectCount).toBe(6)
    expect(rollup.budget.spendCeilingUsd).toBe(1000)
    expect(rollup.budget.projectCeiling).toBe(12)
    expect(rollup.budget.killSwitchTripped).toBe(false)
    // pending decision id surfaced
    expect(rollup.pendingDecisionId).toBe(decision.id)
  })

  it('never diverges from evaluateKillSwitch + getPendingDecision for the same strategy', () => {
    const db = getDb()
    const s = makeStrategy('normal', 50)
    makeChild(s, 'working', 25)
    const strat = db.prepare('SELECT * FROM objectives WHERE id = ?').get(s) as any
    const rollup = gov.computeStrategyRollup(db, strat)
    const ks = gov.evaluateKillSwitch(db, strat)
    expect(rollup.budget.spendUsd).toBe(ks.spendUsd)
    expect(rollup.budget.spendCeilingUsd).toBe(ks.spendCeilingUsd)
    expect(rollup.budget.projectCount).toBe(ks.projectCount)
    expect(rollup.budget.projectCeiling).toBe(ks.projectCeiling)
    expect(rollup.budget.killSwitchTripped).toBe(ks.tripped)
    expect(rollup.pendingDecisionId).toBe(gov.getPendingDecision(db, s)?.id ?? null)
  })

  it('zeroes counts and nulls the decision id for a childless, decisionless strategy', () => {
    const db = getDb()
    const s = makeStrategy()
    const strat = db.prepare('SELECT * FROM objectives WHERE id = ?').get(s) as any
    const rollup = gov.computeStrategyRollup(db, strat)
    expect(rollup.children).toEqual({ total: 0, done: 0, working: 0, queued: 0, review: 0 })
    expect(rollup.budget.projectCount).toBe(0)
    expect(rollup.pendingDecisionId).toBeNull()
  })
})
