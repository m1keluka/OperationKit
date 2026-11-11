import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { Objective } from '@operationkit/shared'

// Temp-file DB so initDb's real schema runs (mirrors model-registry.test.ts).
// Must set DB_PATH before importing the db module.
const TMP_DB = path.join(os.tmpdir(), `cc-corrections-test-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB

const { initDb, getDb } = await import('../db/index.js')
const { recordCorrection, listCorrections, getCorrectionsForContext } = await import('./corrections.js')
const { buildContext } = await import('./context-builder.js')

beforeAll(() => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
})

afterAll(() => {
  for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) {
    if (fs.existsSync(f)) fs.unlinkSync(f)
  }
})

function seedObjective(overrides: Partial<{ title: string; workspace: string; agent_context: string }> = {}): Objective {
  const db = getDb()
  const info = db
    .prepare(
      `INSERT INTO objectives (title, description, status, agent_context, workspace)
       VALUES (?, ?, 'working', ?, ?)`
    )
    .run(
      overrides.title ?? 'ST5 test objective',
      'desc',
      overrides.agent_context ?? 'cto',
      overrides.workspace ?? 'operator',
    )
  const id = Number(info.lastInsertRowid)
  // Minimal Objective shape — buildContext only reads id/workspace/agent_context/project/title/description.
  return {
    id,
    title: overrides.title ?? 'ST5 test objective',
    description: 'desc',
    workspace: overrides.workspace ?? 'operator',
    agent_context: overrides.agent_context ?? 'cto',
  } as unknown as Objective
}

describe('ST5 human correction surface', () => {
  it('a submitted correction becomes a high-priority gotcha in the next spawn context (before/after diff)', () => {
    const obj = seedObjective({ title: 'before/after objective' })

    // BEFORE: no correction submitted — the section must be absent.
    const before = buildContext(obj)
    expect(before).not.toContain('Human Corrections')
    expect(getCorrectionsForContext({ objectiveId: obj.id, workspace: obj.workspace, agentContext: obj.agent_context })).toHaveLength(0)

    // Submit a human correction.
    const created = recordCorrection({
      objectiveId: obj.id,
      label: 'Edited the live checkout instead of an isolated worktree.',
      createdBy: null,
    })
    expect(created.id).toBeGreaterThan(0)
    expect(created.active).toBe(true)
    expect(created.workspace).toBe('operator')
    expect(created.agent_context).toBe('cto')

    // AFTER: the same buildContext call now injects it as a high-priority gotcha.
    const after = buildContext(obj)
    expect(after).toContain('### ⚠ Human Corrections (HIGH PRIORITY')
    expect(after).toContain('Edited the live checkout instead of an isolated worktree.')

    // The correction is the new signal — present after, absent before.
    expect(after.length).toBeGreaterThan(before.length)
    expect(listCorrections(obj.id)).toHaveLength(1)
  })

  it('a correction warns sibling objectives of the same agent role in the same workspace', () => {
    const a = seedObjective({ title: 'objective A', workspace: 'operator', agent_context: 'cmo' })
    const b = seedObjective({ title: 'objective B', workspace: 'operator', agent_context: 'cmo' })

    recordCorrection({ objectiveId: a.id, label: 'Sibling-visible gotcha for cmo/operator.' })

    // Sibling B (same workspace + agent role) sees A's correction at spawn.
    const ctxB = buildContext(b)
    expect(ctxB).toContain('Sibling-visible gotcha for cmo/operator.')
  })

  it('does not leak corrections across workspaces or agent roles', () => {
    const src = seedObjective({ title: 'src obj', workspace: 'example2', agent_context: 'coo' })
    const other = seedObjective({ title: 'other obj', workspace: 'example', agent_context: 'cfo' })

    recordCorrection({ objectiveId: src.id, label: 'example2/coo-only gotcha.' })

    const ctxOther = buildContext(other)
    expect(ctxOther).not.toContain('example2/coo-only gotcha.')
  })
})
