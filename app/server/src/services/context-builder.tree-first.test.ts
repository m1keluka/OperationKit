import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { Objective } from '@operationkit/shared'

// P1-2 / gap G8 — tree-first session context, gated by CONTEXT_TREE_FIRST.
//
// Real schema + a real delegator-shaped tree (modelled on the live "Graph setup"
// delegator 706936 and its P0/P1 children), because the ON path reads
// objectives.parent_id and the OFF path must be proven byte-identical against the
// pre-change SQL, which is inlined verbatim below as the baseline.
//
// The flag is read LAZILY (config.contextTreeFirstEnabled()), so both orderings
// can be exercised in a single test process by flipping process.env.

const TMP_DB = path.join(os.tmpdir(), `cc-treefirst-test-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB
delete process.env.CONTEXT_TREE_FIRST

const { initDb, getDb } = await import('../db/index.js')
const { getActiveBlockers, getRecentFileOps, buildContext } = await import('./context-builder.js')

// ── the live delegator tree, reproduced ───────────────────────────────────────
const DELEGATOR = 706936 // "Graph setup" — the parent
const SELF = 707078      // this objective (P1-2), a child of DELEGATOR
const SIBLING_A = 707003 // P0-2, same parent_id → sibling
const SIBLING_B = 707038 // P1-3, same parent_id → sibling
const CHILD = 707079     // a child of SELF
const STRANGER = 700001  // same workspace, unrelated tree
const OTHER_WS = 700002  // another workspace entirely

const BLOCKER = (what: string) => JSON.stringify([{ severity: 'moderate', description: what }])

function insertObjective(id: number, parentId: number | null, title: string, workspace = 'operator') {
  getDb().prepare(
    `INSERT INTO objectives (id, title, description, status, agent_context, workspace, parent_id)
     VALUES (?, ?, 'desc', 'working', 'cto', ?, ?)`
  ).run(id, title, workspace, parentId)
}

function insertIntel(id: number, opts: { blockers?: string; endedAt?: string } = {}) {
  getDb().prepare(
    `INSERT INTO session_intel (objective_id, session_id, started_at, ended_at, blockers, extraction_status)
     VALUES (?, ?, datetime('now','-2 hours'), ${opts.endedAt ?? "datetime('now','-1 hours')"}, ?, 'parsed')`
  ).run(id, `sess-${id}`, opts.blockers ?? '[]')
}

function insertFileOp(objectiveId: number, filePath: string, timestampSql: string) {
  getDb().prepare(
    `INSERT INTO session_file_ops (session_id, objective_id, file_path, operation, timestamp)
     VALUES (?, ?, ?, 'modify', ${timestampSql})`
  ).run(`sess-${objectiveId}`, objectiveId, filePath)
}

function self(over: Partial<Objective> = {}): Objective {
  return {
    id: SELF,
    title: 'P1-2: Tree-first session context',
    description: 'desc',
    status: 'working',
    workspace: 'operator',
    agent_context: 'cto',
    parent_id: DELEGATOR,
    ...over,
  } as Objective
}

/**
 * The pre-change "Recently Modified Files" query, copied VERBATIM from
 * context-builder.ts as it stood before P1-2. This is the byte-identical
 * baseline: with the flag OFF, getRecentFileOps must return exactly this.
 */
function baselineFileOps(objectiveId: number) {
  return getDb().prepare(`
    SELECT sfo.file_path, sfo.operation, sfo.session_id, o.title as objective_title
    FROM session_file_ops sfo
    JOIN session_intel si ON sfo.session_id = si.session_id
    JOIN objectives o ON sfo.objective_id = o.id
    WHERE sfo.objective_id != ?
      AND sfo.operation IN ('create', 'modify')
      AND sfo.timestamp > datetime('now', '-24 hours')
    ORDER BY sfo.timestamp DESC
    LIMIT 10
  `).all(objectiveId)
}

/** The pre-change "Active Blockers Across System" query, copied VERBATIM. */
function baselineBlockers(objective: Objective) {
  const rows = getDb().prepare(`
    SELECT o.id as objective_id, si.blockers, o.title as objective_title, o.agent_context
    FROM session_intel si
    JOIN objectives o ON si.objective_id = o.id
    WHERE si.blockers != '[]' AND o.status != 'done'
      AND o.workspace = ?
      AND si.ended_at > datetime('now', ?)
      AND si.id = (SELECT MAX(id) FROM session_intel WHERE objective_id = o.id)
    ORDER BY si.ended_at DESC
    LIMIT 10
  `).all(objective.workspace, '-7 days') as { objective_id: number }[]
  return rows.filter(r => r.objective_id !== objective.id)
}

beforeAll(() => {
  for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) if (fs.existsSync(f)) fs.unlinkSync(f)
  initDb()
})

afterAll(() => {
  for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) if (fs.existsSync(f)) fs.unlinkSync(f)
})

beforeEach(() => {
  const db = getDb()
  db.exec('DELETE FROM session_file_ops; DELETE FROM session_intel; DELETE FROM objective_learnings; DELETE FROM objectives')
  delete process.env.CONTEXT_TREE_FIRST
})

afterEach(() => { delete process.env.CONTEXT_TREE_FIRST })

/** Seed the tree: parent, two siblings, a child, a same-workspace stranger, a cross-workspace row. */
function seedTree() {
  insertObjective(DELEGATOR, null, 'Graph setup')
  insertObjective(SELF, DELEGATOR, 'P1-2: Tree-first session context')
  insertObjective(SIBLING_A, DELEGATOR, 'P0-2: DAG queryability')
  insertObjective(SIBLING_B, DELEGATOR, 'P1-3: Sibling read edge')
  insertObjective(CHILD, SELF, 'P1-2 sub-worker')
  insertObjective(STRANGER, null, 'Unrelated objective')
  insertObjective(OTHER_WS, null, 'Cross-workspace objective', 'example-project')
}

describe('[tree-first-ordering] Active Blockers, flag ON', () => {
  it('orders siblings → parent → child → workspace, with the global tier last', () => {
    seedTree()
    // Seed so that RECENCY alone would produce the exact OPPOSITE order —
    // the stranger is the newest, the siblings the oldest. Any tree-first
    // result therefore cannot be an accident of ended_at.
    insertIntel(STRANGER, { blockers: BLOCKER('stranger blocker'), endedAt: "datetime('now','-1 minutes')" })
    insertIntel(CHILD, { blockers: BLOCKER('child blocker'), endedAt: "datetime('now','-10 minutes')" })
    insertIntel(DELEGATOR, { blockers: BLOCKER('parent blocker'), endedAt: "datetime('now','-20 minutes')" })
    insertIntel(SIBLING_B, { blockers: BLOCKER('sibling B blocker'), endedAt: "datetime('now','-30 minutes')" })
    insertIntel(SIBLING_A, { blockers: BLOCKER('sibling A blocker'), endedAt: "datetime('now','-40 minutes')" })

    // OFF (current behaviour): pure recency — the stranger wins, siblings last.
    expect(getActiveBlockers(getDb(), self()).map(r => r.objective_id))
      .toEqual([STRANGER, CHILD, DELEGATOR, SIBLING_B, SIBLING_A])

    process.env.CONTEXT_TREE_FIRST = '1'

    // ON: siblings (recency-ordered within the tier) → parent → child → workspace.
    expect(getActiveBlockers(getDb(), self()).map(r => r.objective_id))
      .toEqual([SIBLING_B, SIBLING_A, DELEGATOR, CHILD, STRANGER])
  })

  it('still drops the objective\'s own blockers and stays workspace-bounded', () => {
    seedTree()
    process.env.CONTEXT_TREE_FIRST = '1'
    insertIntel(SELF, { blockers: BLOCKER('my own blocker') })
    insertIntel(SIBLING_A, { blockers: BLOCKER('sibling blocker') })
    insertIntel(OTHER_WS, { blockers: BLOCKER('other-workspace blocker') })

    const ids = getActiveBlockers(getDb(), self()).map(r => r.objective_id)
    expect(ids).toEqual([SIBLING_A])
  })
})

describe('[tree-first-ordering] Recently Modified Files, flag ON', () => {
  it('fills the LIMIT with tree rows first and lets platform-wide rows take only the remainder', () => {
    seedTree()
    insertIntel(SELF); insertIntel(SIBLING_A); insertIntel(SIBLING_B)
    insertIntel(DELEGATOR); insertIntel(CHILD); insertIntel(STRANGER)

    // 12 stranger ops, all newer than every tree op → under recency-only ordering
    // they would consume the whole LIMIT 10 and the tree would get ZERO slots.
    for (let i = 0; i < 12; i++) {
      insertFileOp(STRANGER, `/tmp/stranger-${i}.ts`, `datetime('now','-${i + 1} minutes')`)
    }
    insertFileOp(SIBLING_A, '/app/server/src/lib/objectives-projection.ts', "datetime('now','-3 hours')")
    insertFileOp(SIBLING_B, '/app/server/src/lib/objective-relations.ts', "datetime('now','-4 hours')")
    insertFileOp(DELEGATOR, '/home/operator/NOTES.md', "datetime('now','-5 hours')")

    // OFF: exactly the 10 newest stranger ops. Zero sibling context — this IS G8.
    const off = getRecentFileOps(getDb(), self())
    expect(off).toHaveLength(10)
    expect(off.every(r => r.file_path.startsWith('/tmp/stranger-'))).toBe(true)

    process.env.CONTEXT_TREE_FIRST = '1'

    const on = getRecentFileOps(getDb(), self())
    expect(on).toHaveLength(10)
    // Tree rows first, in tier order (siblings → parent) ...
    expect(on.slice(0, 3).map(r => r.file_path)).toEqual([
      '/app/server/src/lib/objectives-projection.ts',
      '/app/server/src/lib/objective-relations.ts',
      '/home/operator/NOTES.md',
    ])
    // ... and the global tier fills only the 7 remaining slots of the same LIMIT.
    expect(on.slice(3).every(r => r.file_path.startsWith('/tmp/stranger-'))).toBe(true)
    expect(on.slice(3)).toHaveLength(7)
  })

  it('never returns the objective\'s own file ops', () => {
    seedTree()
    process.env.CONTEXT_TREE_FIRST = '1'
    insertIntel(SELF); insertIntel(SIBLING_A)
    insertFileOp(SELF, '/app/mine.ts', "datetime('now','-1 minutes')")
    insertFileOp(SIBLING_A, '/app/theirs.ts', "datetime('now','-2 hours')")

    expect(getRecentFileOps(getDb(), self()).map(r => r.file_path)).toEqual(['/app/theirs.ts'])
  })

  it('a root objective (parent_id NULL) has no sibling tier — "both are orphans" is not a relationship', () => {
    seedTree()
    process.env.CONTEXT_TREE_FIRST = '1'
    insertIntel(SELF); insertIntel(STRANGER); insertIntel(DELEGATOR)
    // STRANGER and DELEGATOR are both roots (parent_id IS NULL).
    insertFileOp(DELEGATOR, '/app/other-root.ts', "datetime('now','-1 hours')")

    const rootSelf = self({ id: STRANGER, parent_id: null })
    const rows = getRecentFileOps(getDb(), rootSelf)
    // It is returned (workspace tier), not promoted to the sibling tier.
    expect(rows.map(r => r.file_path)).toEqual(['/app/other-root.ts'])
  })
})

describe('[flag-default-off] OFF is byte-identical to the pre-change queries', () => {
  it('the flag is OFF when CONTEXT_TREE_FIRST is unset', async () => {
    delete process.env.CONTEXT_TREE_FIRST
    const { contextTreeFirstEnabled } = await import('../config.js')
    expect(contextTreeFirstEnabled()).toBe(false)
    process.env.CONTEXT_TREE_FIRST = '1'
    expect(contextTreeFirstEnabled()).toBe(true)
  })

  it('getRecentFileOps / getActiveBlockers match the verbatim pre-change SQL row-for-row', () => {
    seedTree()
    insertIntel(SELF, { blockers: BLOCKER('mine') })
    insertIntel(SIBLING_A, { blockers: BLOCKER('sibling') })
    insertIntel(DELEGATOR, { blockers: BLOCKER('parent') })
    insertIntel(STRANGER, { blockers: BLOCKER('stranger') })
    insertIntel(CHILD, { blockers: BLOCKER('child') })
    insertFileOp(SIBLING_A, '/app/a.ts', "datetime('now','-3 hours')")
    insertFileOp(STRANGER, '/app/b.ts', "datetime('now','-1 hours')")
    insertFileOp(DELEGATOR, '/app/c.ts', "datetime('now','-2 hours')")

    expect(getRecentFileOps(getDb(), self())).toEqual(baselineFileOps(SELF))
    expect(getActiveBlockers(getDb(), self()).map(r => r.objective_id))
      .toEqual(baselineBlockers(self()).map(r => r.objective_id))
  })

  it('buildContext output is byte-identical with the flag unset vs. explicitly OFF, and CHANGES when ON', () => {
    seedTree()
    insertIntel(SIBLING_A, { blockers: BLOCKER('sibling blocker'), endedAt: "datetime('now','-40 minutes')" })
    insertIntel(STRANGER, { blockers: BLOCKER('stranger blocker'), endedAt: "datetime('now','-1 minutes')" })
    insertFileOp(SIBLING_A, '/app/sibling.ts', "datetime('now','-3 hours')")
    insertFileOp(STRANGER, '/app/stranger.ts', "datetime('now','-1 hours')")

    const unset = buildContext(self())
    process.env.CONTEXT_TREE_FIRST = '0'
    const explicitlyOff = buildContext(self())
    expect(explicitlyOff).toBe(unset)

    // Current behaviour: the stranger leads both sections.
    expect(unset).toContain('- [moderate] stranger blocker (from "Unrelated objective" / cto)')
    expect(unset.indexOf('stranger blocker')).toBeLessThan(unset.indexOf('sibling blocker'))
    expect(unset.indexOf('/app/stranger.ts')).toBeLessThan(unset.indexOf('/app/sibling.ts'))

    process.env.CONTEXT_TREE_FIRST = '1'
    const on = buildContext(self())
    expect(on).not.toBe(unset)
    expect(on.indexOf('sibling blocker')).toBeLessThan(on.indexOf('stranger blocker'))
    expect(on.indexOf('/app/sibling.ts')).toBeLessThan(on.indexOf('/app/stranger.ts'))
  })
})

describe('[failure-modes-stays-global] Recurring Failure Modes is unaffected by the flag', () => {
  it('renders the identical platform-wide section whether the flag is OFF or ON', () => {
    seedTree()
    // Mined lessons live under the sentinel session with no tree relationship at
    // all — they are promoted only after recurring across DISTINCT objectives.
    const db = getDb()
    for (const content of ['Telegram/Hermes send path not available', 'No files were created or modified']) {
      db.prepare(
        `INSERT INTO objective_learnings (objective_id, session_id, content, learning_type)
         VALUES (?, 'session-mining', ?, 'gotcha')`
      ).run(STRANGER, content)
    }
    // Give the tree-ordered sections something to reorder, so an identical
    // failure-modes section is a real carve-out and not an empty-input tautology.
    insertIntel(SIBLING_A, { blockers: BLOCKER('sibling blocker'), endedAt: "datetime('now','-40 minutes')" })
    insertIntel(STRANGER, { blockers: BLOCKER('stranger blocker'), endedAt: "datetime('now','-1 minutes')" })

    const sectionOf = (ctx: string) =>
      ctx.split('\n\n').find(s => s.startsWith('### Recurring Failure Modes (platform-wide)'))

    const off = buildContext(self())
    process.env.CONTEXT_TREE_FIRST = '1'
    const on = buildContext(self())

    expect(sectionOf(off)).toBeDefined()
    expect(sectionOf(on)).toBe(sectionOf(off))
    expect(sectionOf(on)).toContain('Telegram/Hermes send path not available')
    // ...while the tree-ordered blocker section DID change in the same pair.
    expect(off.indexOf('stranger blocker')).toBeLessThan(off.indexOf('sibling blocker'))
    expect(on.indexOf('sibling blocker')).toBeLessThan(on.indexOf('stranger blocker'))
  })
})
