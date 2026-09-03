import { describe, it, expect, vi } from 'vitest'
import Database from 'better-sqlite3'
import {
  isGateRejectionMemoryEnabled,
  isGateRejectionMemoryKilled,
  isBlockedRegistryEnabled,
  isBlockedRegistryKilled,
  gateRejectionDecision,
  getObjectiveTreeSha,
  matchesBlockedPattern,
  findBlockingRule,
  listActiveBlockedObjectives,
  expireResolvedBlockedObjectives,
  addBlockedObjective,
} from './governance.js'

// ── test helpers ──────────────────────────────────────────────────────────────
function freshDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  db.exec(`
    CREATE TABLE blocked_objectives (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      objective_pattern TEXT NOT NULL,
      reason TEXT NOT NULL,
      since TEXT NOT NULL DEFAULT (datetime('now')),
      unblock_ticket TEXT,
      expires_at TEXT,
      resolved_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `)
  return db
}
function setSetting(db: Database.Database, key: string, value: string) {
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value)
}
const noEnv = {} as NodeJS.ProcessEnv

// ════════════════════════════════════════════════════════════════════════════
// FLAGS — default OFF, env-OR-settings, fail-closed
// ════════════════════════════════════════════════════════════════════════════
describe('governance flags', () => {
  it('gate-rejection memory + blocked registry both default OFF (no env, no settings)', () => {
    const db = freshDb()
    expect(isGateRejectionMemoryEnabled(db, noEnv)).toBe(false)
    expect(isBlockedRegistryEnabled(db, noEnv)).toBe(false)
    expect(isGateRejectionMemoryKilled(db, noEnv)).toBe(false)
    expect(isBlockedRegistryKilled(db, noEnv)).toBe(false)
  })
  it('enabled via settings row OR env var', () => {
    const db = freshDb()
    setSetting(db, 'gate_rejection_memory_enabled', '1')
    expect(isGateRejectionMemoryEnabled(db, noEnv)).toBe(true)
    expect(isBlockedRegistryEnabled(db, { CC_BLOCKED_REGISTRY_ENABLED: 'true' } as unknown as NodeJS.ProcessEnv)).toBe(true)
  })
  it('kill switch honored via env', () => {
    const db = freshDb()
    expect(isGateRejectionMemoryKilled(db, { CC_GATE_REJECTION_MEMORY_KILLED: 'yes' } as unknown as NodeJS.ProcessEnv)).toBe(true)
    expect(isBlockedRegistryKilled(db, { CC_BLOCKED_REGISTRY_KILLED: 'on' } as unknown as NodeJS.ProcessEnv)).toBe(true)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// KL-21 — gate-rejection memory decision (pure)
// ════════════════════════════════════════════════════════════════════════════
describe('gateRejectionDecision', () => {
  const SHA = 'a'.repeat(40)
  it('SKIPS the auditor when rejected + tree UNCHANGED', () => {
    const d = gateRejectionDecision({ enabled: true, killed: false, priorVerdict: 'fail', rejectedTreeSha: SHA, currentTreeSha: SHA })
    expect(d.skipAuditor).toBe(true)
    expect(d.reason).toMatch(/NOT_MERGEABLE/)
  })
  it('does NOT skip when tree CHANGED since rejection', () => {
    const d = gateRejectionDecision({ enabled: true, killed: false, priorVerdict: 'fail', rejectedTreeSha: SHA, currentTreeSha: 'b'.repeat(40) })
    expect(d.skipAuditor).toBe(false)
  })
  it('does NOT skip when prior verdict is not a rejection (pass/blocked/null)', () => {
    for (const v of ['pass', 'blocked', null, undefined]) {
      expect(gateRejectionDecision({ enabled: true, killed: false, priorVerdict: v, rejectedTreeSha: SHA, currentTreeSha: SHA }).skipAuditor).toBe(false)
    }
  })
  it('FAILS OPEN when either SHA is missing (auditor still runs)', () => {
    expect(gateRejectionDecision({ enabled: true, killed: false, priorVerdict: 'fail', rejectedTreeSha: null, currentTreeSha: SHA }).skipAuditor).toBe(false)
    expect(gateRejectionDecision({ enabled: true, killed: false, priorVerdict: 'fail', rejectedTreeSha: SHA, currentTreeSha: null }).skipAuditor).toBe(false)
  })
  it('never skips when disabled or killed', () => {
    expect(gateRejectionDecision({ enabled: false, killed: false, priorVerdict: 'fail', rejectedTreeSha: SHA, currentTreeSha: SHA }).skipAuditor).toBe(false)
    expect(gateRejectionDecision({ enabled: true, killed: true, priorVerdict: 'fail', rejectedTreeSha: SHA, currentTreeSha: SHA }).skipAuditor).toBe(false)
  })
})

describe('getObjectiveTreeSha (best-effort, fails open)', () => {
  it('returns null when no branch/projectDir and no worktree on disk', () => {
    expect(getObjectiveTreeSha({ objectiveId: 999999, branchName: null, projectDir: null, worktreePath: '/nonexistent/cc-wt' })).toBeNull()
  })
  it('reads HEAD^{tree} from the project dir via injected git exec', () => {
    const sha = 'deadbeef'.repeat(5)
    const gitExec = vi.fn(() => `${sha}\n`)
    const out = getObjectiveTreeSha(
      { objectiveId: 1, branchName: 'cc/obj-1-x', projectDir: '/repo', worktreePath: '/nonexistent/cc-wt' },
      gitExec,
    )
    expect(out).toBe(sha)
    expect(gitExec).toHaveBeenCalledOnce()
  })
})

// ════════════════════════════════════════════════════════════════════════════
// KL-21 — SMOKE PROOF: an unchanged rejected tree does NOT invoke the auditor
//          (auditor spawn count == 0). Mirrors the state-poller decision path.
// ════════════════════════════════════════════════════════════════════════════
describe('KL-21 smoke proof — auditor spawn count on unchanged rejected tree', () => {
  // A faithful miniature of the poller's reviewer-trigger decision: compute the
  // current tree SHA, ask gateRejectionDecision, and ONLY spawn when not skipped.
  function reviewerTriggerTick(opts: {
    enabled: boolean
    priorVerdict: string | null
    rejectedTreeSha: string | null
    currentTreeSha: string | null
    spawnReviewer: () => void
  }) {
    if (!opts.enabled) {
      opts.spawnReviewer()
      return
    }
    const decision = gateRejectionDecision({
      enabled: true,
      killed: false,
      priorVerdict: opts.priorVerdict,
      rejectedTreeSha: opts.rejectedTreeSha,
      currentTreeSha: opts.currentTreeSha,
    })
    if (decision.skipAuditor) return // NOT_MERGEABLE → no spawn
    opts.spawnReviewer()
  }

  it('auditor spawn count is 0 for an unchanged rejected tree', () => {
    const SHA = 'feedface'.repeat(5)
    const spawnReviewer = vi.fn()
    reviewerTriggerTick({ enabled: true, priorVerdict: 'fail', rejectedTreeSha: SHA, currentTreeSha: SHA, spawnReviewer })
    expect(spawnReviewer).toHaveBeenCalledTimes(0) // ← PROOF: auditor NOT invoked
  })

  it('auditor spawn count is 1 once the tree changes (control)', () => {
    const spawnReviewer = vi.fn()
    reviewerTriggerTick({ enabled: true, priorVerdict: 'fail', rejectedTreeSha: 'a'.repeat(40), currentTreeSha: 'c'.repeat(40), spawnReviewer })
    expect(spawnReviewer).toHaveBeenCalledTimes(1)
  })

  it('auditor spawn count is 1 when the flag is OFF (no behavior change)', () => {
    const SHA = 'feedface'.repeat(5)
    const spawnReviewer = vi.fn()
    reviewerTriggerTick({ enabled: false, priorVerdict: 'fail', rejectedTreeSha: SHA, currentTreeSha: SHA, spawnReviewer })
    expect(spawnReviewer).toHaveBeenCalledTimes(1)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// KL-11 — blocked-combos registry
// ════════════════════════════════════════════════════════════════════════════
describe('matchesBlockedPattern', () => {
  it('substring match, case-insensitive', () => {
    expect(matchesBlockedPattern('doppler cutover', 'Execute the Doppler Cutover phase 0')).toBe(true)
    expect(matchesBlockedPattern('doppler cutover', 'unrelated work')).toBe(false)
  })
  it('glob match with *', () => {
    expect(matchesBlockedPattern('deploy * to prod', 'Deploy example to prod')).toBe(true)
    expect(matchesBlockedPattern('deploy * to prod', 'Deploy example to staging')).toBe(false)
  })
  it('empty pattern/title never matches', () => {
    expect(matchesBlockedPattern('', 'x')).toBe(false)
    expect(matchesBlockedPattern('x', '')).toBe(false)
  })
})

describe('blocked registry read/auto-expire', () => {
  it('findBlockingRule returns the matching active rule', () => {
    const db = freshDb()
    addBlockedObjective(db, { objective_pattern: 'scoped-doppler cutover', reason: 'awaiting Mike approval', unblock_ticket: 'CC-1731' })
    const rule = findBlockingRule(db, 'Execute scoped-Doppler cutover (Phase 0)')
    expect(rule?.reason).toBe('awaiting Mike approval')
    expect(findBlockingRule(db, 'totally different objective')).toBeNull()
  })
  it('TIME-based auto-expiry: a past expires_at is filtered out on read', () => {
    const db = freshDb()
    addBlockedObjective(db, { objective_pattern: 'temp block', reason: 'short-lived', expires_at: '2000-01-01 00:00:00' })
    expect(listActiveBlockedObjectives(db)).toHaveLength(0)
    expect(findBlockingRule(db, 'temp block work')).toBeNull()
  })
  it('TICKET-based auto-expiry: expireResolvedBlockedObjectives stamps resolved_at', () => {
    const db = freshDb()
    addBlockedObjective(db, { objective_pattern: 'blocked on infra', reason: 'infra down', unblock_ticket: 'INFRA-9' })
    expect(findBlockingRule(db, 'blocked on infra now')).not.toBeNull()
    const n = expireResolvedBlockedObjectives(db, (ticket) => ticket === 'INFRA-9')
    expect(n).toBe(1)
    expect(findBlockingRule(db, 'blocked on infra now')).toBeNull() // auto-expired → no longer blocks
  })
  it('a failing ticket-status check does NOT expire a still-active block', () => {
    const db = freshDb()
    addBlockedObjective(db, { objective_pattern: 'keep blocked', reason: 'x', unblock_ticket: 'T-1' })
    const n = expireResolvedBlockedObjectives(db, () => { throw new Error('status API down') })
    expect(n).toBe(0)
    expect(findBlockingRule(db, 'keep blocked')).not.toBeNull()
  })
})

// ════════════════════════════════════════════════════════════════════════════
// KL-11 — SMOKE PROOF: a registered blocked objective does NOT spawn/create.
//          Mirrors the POST /api/internal/objectives insert loop.
// ════════════════════════════════════════════════════════════════════════════
describe('KL-11 smoke proof — a blocked objective is not created', () => {
  // Miniature of the internal.ts loop: skip items matching an active block.
  function generateObjectives(db: Database.Database, items: { title: string }[], enabled: boolean, create: (t: string) => void) {
    const blocked: string[] = []
    for (const item of items) {
      if (!item.title?.trim()) continue
      if (enabled) {
        const rule = findBlockingRule(db, item.title)
        if (rule) { blocked.push(item.title); continue }
      }
      create(item.title)
    }
    return blocked
  }

  it('blocked item is skipped (not created); others are created', () => {
    const db = freshDb()
    setSetting(db, 'blocked_registry_enabled', '1')
    addBlockedObjective(db, { objective_pattern: 'doppler cutover', reason: 'awaiting approval', unblock_ticket: 'CC-1731' })
    const create = vi.fn()
    const enabled = isBlockedRegistryEnabled(db, noEnv) && !isBlockedRegistryKilled(db, noEnv)
    const blocked = generateObjectives(
      db,
      [{ title: 'Execute Doppler cutover phase 0' }, { title: 'Write release notes' }],
      enabled,
      create,
    )
    expect(blocked).toEqual(['Execute Doppler cutover phase 0'])
    expect(create).toHaveBeenCalledTimes(1) // ← PROOF: blocked obj NOT created
    expect(create).toHaveBeenCalledWith('Write release notes')
  })

  it('with the flag OFF, the blocked item IS created (no behavior change)', () => {
    const db = freshDb()
    addBlockedObjective(db, { objective_pattern: 'doppler cutover', reason: 'awaiting approval' })
    const create = vi.fn()
    const enabled = isBlockedRegistryEnabled(db, noEnv) && !isBlockedRegistryKilled(db, noEnv)
    generateObjectives(db, [{ title: 'Execute Doppler cutover phase 0' }], enabled, create)
    expect(create).toHaveBeenCalledTimes(1)
  })
})
