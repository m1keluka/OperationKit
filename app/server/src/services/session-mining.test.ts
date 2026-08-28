import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

// Real SQLite + a temp skills registry. We point AI_WORKSPACE_DIR at a temp dir
// BEFORE importing config so SKILLS_REGISTRY resolves to our fixture, then drive
// the dream-cycle session miner end-to-end and assert the promoted lessons show
// up in the built spawn context.
const TMP_DB = path.join(os.tmpdir(), `cc-session-mining-${process.pid}-${Date.now()}.db`)
const TMP_WS = path.join(os.tmpdir(), `cc-session-mining-ws-${process.pid}-${Date.now()}`)
process.env.DB_PATH = TMP_DB
process.env.AI_WORKSPACE_DIR = TMP_WS

const { initDb, getDb } = await import('../db/index.js')
const { SESSION_MINING_SENTINEL, SKILLS_REGISTRY } = await import('../config.js')
const { runDreamCycle } = await import('./dream-cycle.js')
const { buildContext } = await import('./context-builder.js')

const REPEATED_BLOCKER = 'Railway deploy token expired — second service cannot be provisioned'
const FAILING_SKILL = 'flaky-deploy-skill'

// A minimal Objective good enough for buildContext (it reads id/workspace/
// agent_context/project/title/description).
function makeObjective(id: number, agent = 'cto', workspace = 'personal') {
  return {
    id, title: `obj-${id}`, description: '', status: 'working',
    agent_context: agent, workspace, project: null,
  } as unknown as Parameters<typeof buildContext>[0]
}

beforeAll(() => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
  const db = getDb()

  // Write a temp skills registry with one flagged + one healthy skill for cto.
  fs.mkdirSync(path.dirname(SKILLS_REGISTRY), { recursive: true })
  fs.writeFileSync(SKILLS_REGISTRY, JSON.stringify({
    skills: {
      [FAILING_SKILL]: { name: FAILING_SKILL, agents: ['cto'], usage_count: 10, failure_count: 4, needs_improvement: true },
      'healthy-skill': { name: 'healthy-skill', agents: ['cto'], usage_count: 10, failure_count: 0, needs_improvement: false },
      'other-agent-skill': { name: 'other-agent-skill', agents: ['coo'], usage_count: 5, failure_count: 3, needs_improvement: true },
    },
  }))

  // Five objectives: 1-3 exhibit the recurring failure, 4 is a fresh consumer,
  // 5 is an unrelated control.
  for (let i = 1; i <= 5; i++) {
    db.prepare("INSERT INTO objectives (id, title, agent_context, workspace, status) VALUES (?, ?, 'cto', 'personal', 'working')")
      .run(i, `obj-${i}`)
  }

  // Same blocker description reported across objectives 1, 2, 3 → recurring gotcha.
  // Object 5 reports a one-off blocker that must NOT be promoted.
  for (const oid of [1, 2, 3]) {
    db.prepare("INSERT INTO session_events (session_id, objective_id, event_type, description) VALUES (?, ?, 'blocker', ?)")
      .run(`sess-blk-${oid}`, oid, REPEATED_BLOCKER)
  }
  db.prepare("INSERT INTO session_events (session_id, objective_id, event_type, description) VALUES ('sess-oneoff', 5, 'blocker', 'a unique one-off problem nobody else hit')")
    .run()

  // Failed sessions using FAILING_SKILL across objectives 1, 2, 3 → recurring pattern.
  for (const oid of [1, 2, 3]) {
    db.prepare(`INSERT INTO session_intel (objective_id, session_id, started_at, ended_at, outcome, skills_used, extraction_status)
                VALUES (?, ?, datetime('now','-1 hour'), datetime('now'), 'failed', ?, 'parsed')`)
      .run(oid, `sess-intel-${oid}`, JSON.stringify([FAILING_SKILL]))
  }
})

afterAll(() => {
  try { getDb().close() } catch {}
  for (const suffix of ['', '-wal', '-shm']) {
    const f = `${TMP_DB}${suffix}`
    if (fs.existsSync(f)) fs.unlinkSync(f)
  }
  try { fs.rmSync(TMP_WS, { recursive: true, force: true }) } catch {}
})

describe('session miner — recurring failure promotion', () => {
  it('(a) promotes a repeated failure mode into objective_learnings pattern + gotcha rows', async () => {
    await runDreamCycle('mining')
    const db = getDb()
    const rows = db.prepare(
      'SELECT content, learning_type FROM objective_learnings WHERE session_id = ?'
    ).all(SESSION_MINING_SENTINEL) as { content: string; learning_type: string }[]

    const gotcha = rows.find(r => r.learning_type === 'gotcha')
    const pattern = rows.find(r => r.learning_type === 'pattern')

    expect(gotcha).toBeDefined()
    expect(gotcha!.content).toContain(REPEATED_BLOCKER)
    expect(gotcha!.content).toContain('3 objectives')

    expect(pattern).toBeDefined()
    expect(pattern!.content).toContain(FAILING_SKILL)

    // The one-off blocker on objective 5 must NOT be promoted.
    expect(rows.some(r => r.content.includes('one-off'))).toBe(false)
  })

  it('is idempotent — a second run replaces, not duplicates, the mined rows', async () => {
    await runDreamCycle('mining')
    await runDreamCycle('mining')
    const db = getDb()
    const n = (db.prepare(
      "SELECT COUNT(*) as n FROM objective_learnings WHERE session_id = ? AND learning_type = 'gotcha'"
    ).get(SESSION_MINING_SENTINEL) as { n: number }).n
    expect(n).toBe(1)
  })

  it('(c) renders the Recurring Failure Modes section in the built spawn context', () => {
    const ctx = buildContext(makeObjective(4))
    expect(ctx).toContain('### Recurring Failure Modes (platform-wide)')
    expect(ctx).toContain(REPEATED_BLOCKER)
    expect(ctx).toContain(FAILING_SKILL)
  })

  it('(c) self-suppresses the section when there are no mined lessons', () => {
    const db = getDb()
    db.prepare('DELETE FROM objective_learnings WHERE session_id = ?').run(SESSION_MINING_SENTINEL)
    const ctx = buildContext(makeObjective(4))
    expect(ctx).not.toContain('### Recurring Failure Modes (platform-wide)')
  })
})

describe('needs_improvement wiring — flagged skills warning at spawn time', () => {
  it('(b) surfaces a flagged skill scoped to the agent role', () => {
    const ctx = buildContext(makeObjective(4, 'cto'))
    expect(ctx).toContain('### Skills Flagged for Improvement')
    expect(ctx).toContain(FAILING_SKILL)
    expect(ctx).toContain('40% failure rate')
  })

  it('does not surface healthy skills or skills for other agent roles', () => {
    const ctx = buildContext(makeObjective(4, 'cto'))
    expect(ctx).not.toContain('healthy-skill')
    expect(ctx).not.toContain('other-agent-skill')
  })
})
