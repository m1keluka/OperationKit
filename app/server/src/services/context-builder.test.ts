import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { getActiveBlockers } from './context-builder.js'
import type { Objective } from '@command-center/shared'

// QW6 / audit C#5: the Active-Blockers context query must (a) age out stale
// blockers via a recency window, (b) stay scoped to the objective's workspace,
// and (c) select o.id so the own-objective dedup guard actually fires. These
// tests build a minimal in-memory schema with only the columns the query
// touches and assert all three behaviours.

let db: Database.Database

function makeObjective(over: Partial<Objective> = {}): Objective {
  return {
    id: 1,
    title: 'Current objective',
    workspace: 'personal',
    agent_context: 'cto',
    status: 'working',
    ...over,
  } as Objective
}

// Insert an objective + its latest session_intel row carrying a blocker.
function seed(opts: {
  id: number
  workspace: string
  status?: string
  title?: string
  endedAt: string // SQLite datetime expression result, e.g. "datetime('now','-1 days')"
  blockers: string
}) {
  db.prepare(
    `INSERT INTO objectives (id, title, agent_context, workspace, status) VALUES (?, ?, 'cto', ?, ?)`
  ).run(opts.id, opts.title ?? `Obj ${opts.id}`, opts.workspace, opts.status ?? 'working')
  db.prepare(
    `INSERT INTO session_intel (objective_id, blockers, ended_at) VALUES (?, ?, ${opts.endedAt})`
  ).run(opts.id, opts.blockers)
}

const BLOCKER = JSON.stringify([{ severity: 'critical', description: 'X is down' }])

beforeEach(() => {
  db = new Database(':memory:')
  db.exec(`
    CREATE TABLE objectives (
      id INTEGER PRIMARY KEY,
      title TEXT NOT NULL,
      agent_context TEXT,
      workspace TEXT NOT NULL,
      status TEXT NOT NULL
    );
    CREATE TABLE session_intel (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      objective_id INTEGER NOT NULL,
      blockers TEXT NOT NULL DEFAULT '[]',
      ended_at TEXT NOT NULL
    );
  `)
})

afterEach(() => db.close())

describe('getActiveBlockers (QW6 / audit C#5)', () => {
  it('(b) excludes blockers from other workspaces', () => {
    seed({ id: 2, workspace: 'personal', endedAt: "datetime('now','-1 days')", blockers: BLOCKER })
    seed({ id: 3, workspace: 'example-project', endedAt: "datetime('now','-1 days')", blockers: BLOCKER })

    const rows = getActiveBlockers(db, makeObjective())
    expect(rows.map(r => r.objective_id)).toEqual([2])
  })

  it('(a) excludes stale blockers older than the recency window', () => {
    seed({ id: 2, workspace: 'personal', endedAt: "datetime('now','-2 days')", blockers: BLOCKER })
    seed({ id: 3, workspace: 'personal', endedAt: "datetime('now','-30 days')", blockers: BLOCKER })

    const rows = getActiveBlockers(db, makeObjective())
    expect(rows.map(r => r.objective_id)).toEqual([2])
  })

  it('(c) the dedup guard fires — the objective\'s own blockers are excluded (requires SELECT o.id)', () => {
    // Own objective (id 1) has a fresh in-workspace blocker. Without o.id in the
    // SELECT the guard could not match and this row would leak.
    seed({ id: 1, workspace: 'personal', endedAt: "datetime('now','-1 hours')", blockers: BLOCKER })
    seed({ id: 2, workspace: 'personal', endedAt: "datetime('now','-1 hours')", blockers: BLOCKER })

    const rows = getActiveBlockers(db, makeObjective({ id: 1 }))
    expect(rows.map(r => r.objective_id)).toEqual([2])
    // Every returned row carries a real numeric objective_id (proves o.id is selected).
    expect(rows.every(r => typeof r.objective_id === 'number')).toBe(true)
  })

  it('excludes done objectives and empty-blocker rows', () => {
    seed({ id: 2, workspace: 'personal', status: 'done', endedAt: "datetime('now','-1 hours')", blockers: BLOCKER })
    seed({ id: 3, workspace: 'personal', endedAt: "datetime('now','-1 hours')", blockers: '[]' })
    seed({ id: 4, workspace: 'personal', endedAt: "datetime('now','-1 hours')", blockers: BLOCKER })

    const rows = getActiveBlockers(db, makeObjective())
    expect(rows.map(r => r.objective_id)).toEqual([4])
  })

  it('combined: stale cross-workspace blockers no longer surface', () => {
    seed({ id: 2, workspace: 'personal', endedAt: "datetime('now','-1 hours')", blockers: BLOCKER }) // keep
    seed({ id: 3, workspace: 'example-project', endedAt: "datetime('now','-1 hours')", blockers: BLOCKER }) // wrong ws
    seed({ id: 4, workspace: 'personal', endedAt: "datetime('now','-14 days')", blockers: BLOCKER }) // stale

    const rows = getActiveBlockers(db, makeObjective())
    expect(rows.map(r => r.objective_id)).toEqual([2])
  })
})
