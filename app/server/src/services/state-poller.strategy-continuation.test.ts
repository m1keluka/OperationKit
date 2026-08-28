// Strategy Layer P3 (obj 2341) — the depth-aware continuation engine.
//
// Proves the wake that re-invokes a persistent strategy node after each project
// finishes, all gated behind CC_STRATEGY_TIER:
//
//   1. depth-1 parent resolution: delegatorParentOf returns the STRATEGY parent
//      (depth 0) for a PROJECT node (depth 1), and null when the parent is not a
//      delegator.
//   2. flag-ON: a finishing delegate_mode project committing to `review` fires
//      EXACTLY ONE wakeDelegator to its strategy parent.
//   3. flag-OFF: the same commit fires ZERO new parent wakes — byte-identical to
//      pre-P3.
//   4. no-double-wake: a resolvedStatus === 'ai_review' transition does NOT wake
//      here (the ai_review single-hop loop owns it), so a single finishing child
//      yields exactly one parent wake across the two paths.
//
// wakeDelegator is mocked so we count invocations without driving session-manager.

import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { Objective, ObjectiveStatus } from '@command-center/shared'

const TMP_DB = path.join(os.tmpdir(), `cc-strategy-continuation-test-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB

// Spy on wakeDelegator; keep the rest of the module real (state-poller imports
// nudgeDelegator/recentlyNudged/reconcileDecision from here too).
vi.mock('./delegation.js', async (importActual) => {
  const actual = await importActual<typeof import('./delegation.js')>()
  return { ...actual, wakeDelegator: vi.fn() }
})

const { initDb, getDb } = await import('../db/index.js')
const { delegatorParentOf, continueDelegationOnCommit } = await import('./state-poller.js')
const { wakeDelegator } = await import('./delegation.js')
const wakeSpy = vi.mocked(wakeDelegator)

function seed(opts: {
  title: string
  parent_id?: number | null
  depth?: number
  delegate_mode?: 0 | 1
  status?: string
}): number {
  const r = getDb()
    .prepare(
      `INSERT INTO objectives (title, agent_context, workspace, status, parent_id, depth, delegate_mode)
       VALUES (?, 'cto', 'personal', ?, ?, ?, ?)`
    )
    .run(
      opts.title,
      opts.status ?? 'queue',
      opts.parent_id ?? null,
      opts.depth ?? 0,
      opts.delegate_mode ?? 0,
    )
  return r.lastInsertRowid as number
}

const row = (id: number): Objective => getDb().prepare('SELECT * FROM objectives WHERE id = ?').get(id) as Objective

beforeAll(() => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
})

afterAll(() => {
  try { getDb().close() } catch { /* ignore */ }
  for (const suffix of ['', '-wal', '-shm']) {
    const f = `${TMP_DB}${suffix}`
    if (fs.existsSync(f)) fs.unlinkSync(f)
  }
})

beforeEach(() => {
  wakeSpy.mockClear()
})

afterEach(() => {
  delete process.env.CC_STRATEGY_TIER
})

describe('delegatorParentOf — depth-1 parent resolution', () => {
  it('returns the strategy parent (depth 0) for a project node (depth 1)', () => {
    const strategyId = seed({ title: 'strategy root', depth: 0, delegate_mode: 1 })
    const projectId = seed({ title: 'project', parent_id: strategyId, depth: 1, delegate_mode: 1 })
    expect(delegatorParentOf(row(projectId))).toBe(strategyId)
  })

  it('returns null when the immediate parent is NOT a delegator', () => {
    const plainParent = seed({ title: 'plain parent', depth: 0, delegate_mode: 0 })
    const childId = seed({ title: 'child', parent_id: plainParent, depth: 1, delegate_mode: 0 })
    expect(delegatorParentOf(row(childId))).toBeNull()
  })

  it('returns null for a top-level node (no parent)', () => {
    const topId = seed({ title: 'top', depth: 0, delegate_mode: 1 })
    expect(delegatorParentOf(row(topId))).toBeNull()
  })
})

describe('continueDelegationOnCommit — flag-ON fires exactly one parent wake', () => {
  it('a finishing project committing to review wakes its strategy parent once', () => {
    process.env.CC_STRATEGY_TIER = '1'
    const strategyId = seed({ title: 'strategy', depth: 0, delegate_mode: 1 })
    const projectId = seed({ title: 'project', parent_id: strategyId, depth: 1, delegate_mode: 1 })
    const proj = row(projectId)

    const woke = continueDelegationOnCommit(proj, proj, 'review' as ObjectiveStatus)

    expect(woke).toBe(strategyId)
    expect(wakeSpy).toHaveBeenCalledTimes(1)
    expect(wakeSpy.mock.calls[0][0]).toBe(strategyId)
  })

  it('also fires for a commit to done', () => {
    process.env.CC_STRATEGY_TIER = '1'
    const strategyId = seed({ title: 'strategy d', depth: 0, delegate_mode: 1 })
    const projectId = seed({ title: 'project d', parent_id: strategyId, depth: 1, delegate_mode: 1 })
    const proj = row(projectId)
    expect(continueDelegationOnCommit(proj, proj, 'done' as ObjectiveStatus)).toBe(strategyId)
    expect(wakeSpy).toHaveBeenCalledTimes(1)
  })
})

describe('continueDelegationOnCommit — flag-OFF equivalence (zero new wakes)', () => {
  it('does NOT wake the parent when CC_STRATEGY_TIER is unset', () => {
    delete process.env.CC_STRATEGY_TIER
    const strategyId = seed({ title: 'strategy off', depth: 0, delegate_mode: 1 })
    const projectId = seed({ title: 'project off', parent_id: strategyId, depth: 1, delegate_mode: 1 })
    const proj = row(projectId)

    const woke = continueDelegationOnCommit(proj, proj, 'review' as ObjectiveStatus)

    expect(woke).toBeNull()
    expect(wakeSpy).not.toHaveBeenCalled()
  })
})

describe('continueDelegationOnCommit — no double-wake invariant', () => {
  it('does NOT wake on an ai_review transition (the ai_review loop owns that path)', () => {
    process.env.CC_STRATEGY_TIER = '1'
    const strategyId = seed({ title: 'strategy ar', depth: 0, delegate_mode: 1 })
    const projectId = seed({ title: 'project ar', parent_id: strategyId, depth: 1, delegate_mode: 1 })
    const proj = row(projectId)

    const woke = continueDelegationOnCommit(proj, proj, 'ai_review' as ObjectiveStatus)

    expect(woke).toBeNull()
    expect(wakeSpy).not.toHaveBeenCalled()
  })

  it('a single finishing child yields exactly ONE parent wake', () => {
    process.env.CC_STRATEGY_TIER = '1'
    const strategyId = seed({ title: 'strategy one', depth: 0, delegate_mode: 1 })
    const projectId = seed({ title: 'project one', parent_id: strategyId, depth: 1, delegate_mode: 1 })
    const proj = row(projectId)

    continueDelegationOnCommit(proj, proj, 'review' as ObjectiveStatus)

    expect(wakeSpy).toHaveBeenCalledTimes(1)
  })
})
