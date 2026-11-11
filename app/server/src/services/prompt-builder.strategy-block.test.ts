import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import os from 'os'
import path from 'path'

// buildPrompt → buildContext → getDb(), so the DB must be initialized first.
// Point it at a throwaway temp file before importing the modules that read DB_PATH.
const TMP_DB = path.join(os.tmpdir(), `cc-prompt-builder-strategy-test-${process.pid}.db`)
process.env.DB_PATH = TMP_DB

import { initDb, getDb } from '../db/index.js'
import { buildPrompt, buildDelegatorBlock, buildStrategyBlock } from './prompt-builder.js'
import type { Objective } from '@operationkit/shared'

// ─────────────────────────────────────────────────────────────────────────────
// Strategy Layer P4 — the flag-gated buildStrategyBlock playbook variant.
//
// A depth-0 STRATEGY node (a delegator whose children are themselves
// delegate_mode projects) must get the decompose-into-PROJECTS framing when
// CC_STRATEGY_TIER=1, and EVERY node type must be byte-identical to pre-P4
// (the ordinary delegator block) when the flag is unset. The strategy node is
// recognized by EITHER the stored `is_strategy` marker (obj 2383 — works on the
// FIRST spawn, before any children exist) OR `isStrategyNode` (a delegate_mode
// child exists in the DB).
// ─────────────────────────────────────────────────────────────────────────────

// Stable, unique substrings of each block (chosen to never collide).
const STRATEGY_LINE = 'STRATEGY MODE (active for this objective — depth-0 strategy node)'
const STRATEGY_PROJECTS = 'You decompose your objective into'
const DELEGATOR_LINE = 'DELEGATOR MODE (active for this objective)'

beforeAll(() => {
  initDb()
})

// Hermetic against an INBOUND leak: another test file may set
// process.env.CC_STRATEGY_TIER (it is process-global and vitest's forks pool can
// reuse a worker across files), so reset it BEFORE each test too — not only after.
// The FLAG-ON cases set it explicitly inside the test, so this only neutralises a
// stale value from a sibling file. (Pre-existing cross-file isolation hole surfaced
// by obj 700316's added tests shifting the file→worker schedule.)
beforeEach(() => {
  delete process.env.CC_STRATEGY_TIER
  // The strategy flag also has a settings-row source (strategy_tier_enabled). vitest
  // resets the module registry between files but NOT process.env or the on-disk DB,
  // so a sibling file that armed either source can poison this file's FLAG-OFF
  // assertions. Clear both before each test (FLAG-ON cases set env explicitly).
  try {
    const db = getDb()
    db.prepare("DELETE FROM settings WHERE key = 'strategy_tier_enabled'").run()
    // The getDb() handle is a module singleton vitest can carry across files, so a
    // sibling file's objective rows (e.g. an explicit id this file also inserts)
    // can survive into this file and make insertDelegatorWithDelegateChild collide.
    // Clear the table before each test — matching the uat-gate / canary suites.
    db.exec('DELETE FROM objectives')
  } catch {
    /* DB not ready — nothing to clear */
  }
})

afterEach(() => {
  delete process.env.CC_STRATEGY_TIER
})

function makeObjective(overrides: Partial<Objective> = {}): Objective {
  return {
    id: 700001,
    title: 'Sample delegator objective',
    description: 'A sample objective for strategy-block tests.',
    status: 'working',
    agent_context: 'cto',
    workspace: 'operator',
    project: null,
    category: 'build',
    parent_id: null,
    depth: 0,
    assigned_user_id: null,
    routine_id: null,
    created_by: null,
    session_id: null,
    transcript_path: null,
    last_session_summary: null,
    session_count: 0,
    total_cost_usd: 0,
    total_tokens: 0,
    has_blockers: false,
    delegate_mode: true,
    is_strategy: false,
    create_pr: false,
    branch_name: null,
    pr_url: null,
    pr_number: null,
    completion_goal: null,
    workflow_hint: null,
    effort: 'medium',
    model: 'default',
    type: 'project',
    approved_plan: null,
    plan_approved_at: null,
    planning_session_id: null,
    ai_review_verdict: null,
    ai_review_findings: null,
    ai_review_session_id: null,
    skip_ai_review: false,
    acceptance_criteria: null,
    ai_review_iteration: 0,
    test_cred_slug: null,
    created_at: '2026-06-29T00:00:00Z',
    updated_at: '2026-06-29T00:00:00Z',
    ...overrides,
  } as Objective
}

/**
 * Insert a parent delegator row (so the child FK resolves) AND a delegate_mode
 * child under it, so isStrategyNode(parentId) resolves true. The parent is NOT
 * is_strategy-marked, so the only signal that makes it a strategy node is the
 * delegate_mode child.
 */
function insertDelegatorWithDelegateChild(parentId: number): void {
  const db = getDb()
  db.prepare(
    `INSERT INTO objectives (id, title, description, agent_context, workspace, parent_id, delegate_mode, is_strategy, status, type)
     VALUES (?, ?, ?, ?, ?, NULL, 1, 0, 'working', 'project')`,
  ).run(parentId, 'Parent delegator', 'parent', 'cto', 'operator')
  db.prepare(
    `INSERT INTO objectives (title, description, agent_context, workspace, parent_id, delegate_mode, status, type)
     VALUES (?, ?, ?, ?, ?, 1, 'queue', 'project')`,
  ).run('Child project', 'child', 'cto', 'operator', parentId)
}

describe('buildPrompt — P4 strategy-block injection (flag-gated)', () => {
  it('FLAG OFF: a strategy-marked delegator gets the ORDINARY delegator block, NOT the strategy framing', () => {
    const prompt = buildPrompt(makeObjective({ id: 700010, is_strategy: true }))
    expect(prompt).toContain(DELEGATOR_LINE)
    expect(prompt).not.toContain(STRATEGY_LINE)
    expect(prompt).not.toContain(STRATEGY_PROJECTS)
  })

  it('FLAG OFF: byte-identical to current behavior — the injected block equals buildDelegatorBlock for a strategy-marked node', () => {
    const obj = makeObjective({ id: 700011, is_strategy: true })
    const prompt = buildPrompt(obj)
    // The exact pre-P4 block (ordinary delegator) must appear verbatim.
    expect(prompt).toContain(buildDelegatorBlock(obj).join('\n'))
    expect(prompt).not.toContain(buildStrategyBlock(obj).join('\n'))
  })

  it('FLAG ON + is_strategy marker (first spawn, NO children yet): gets the decompose-into-PROJECTS strategy framing', () => {
    process.env.CC_STRATEGY_TIER = '1'
    const prompt = buildPrompt(makeObjective({ id: 700012, is_strategy: true }))
    expect(prompt).toContain(STRATEGY_LINE)
    expect(prompt).toContain(STRATEGY_PROJECTS)
    expect(prompt).toContain('"delegate_mode":true')
    expect(prompt).toContain('[project-complete]')
    expect(prompt).not.toContain(DELEGATOR_LINE)
  })

  it('FLAG ON + isStrategyNode (a delegate_mode child exists, NO stored marker): gets the strategy framing', () => {
    process.env.CC_STRATEGY_TIER = '1'
    const parentId = 700013
    insertDelegatorWithDelegateChild(parentId)
    const prompt = buildPrompt(makeObjective({ id: parentId, is_strategy: false }))
    expect(prompt).toContain(STRATEGY_LINE)
    expect(prompt).not.toContain(DELEGATOR_LINE)
  })

  it('FLAG ON + ordinary delegator (no marker, no delegate_mode children): stays on the ORDINARY delegator block', () => {
    process.env.CC_STRATEGY_TIER = '1'
    // id has no children inserted and is_strategy=false → not a strategy node.
    const prompt = buildPrompt(makeObjective({ id: 700014, is_strategy: false }))
    expect(prompt).toContain(DELEGATOR_LINE)
    expect(prompt).not.toContain(STRATEGY_LINE)
  })

  it('FLAG ON: a non-delegator objective is unaffected (no delegator OR strategy block)', () => {
    process.env.CC_STRATEGY_TIER = '1'
    const prompt = buildPrompt(makeObjective({ id: 700015, delegate_mode: false, is_strategy: false }))
    expect(prompt).not.toContain(STRATEGY_LINE)
    expect(prompt).not.toContain(DELEGATOR_LINE)
  })
})

describe('buildStrategyBlock — content contract', () => {
  it('teaches PROJECT decomposition, the decision loop, the human gate, and context discipline', () => {
    const block = buildStrategyBlock(makeObjective({ id: 700020 })).join('\n')
    expect(block).toContain('Strategy → Project → Task')
    expect(block).toContain('DECISION LOOP')
    expect(block).toContain('[project-complete]')
    expect(block).toContain('parent_id=700020')
    expect(block).toContain('"delegate_mode":true')
    expect(block).toContain('human gate')
    // one-decision-per-wake discipline
    expect(block).toContain('at most one new project per wake')
  })
})
