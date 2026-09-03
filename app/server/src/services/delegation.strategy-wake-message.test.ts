// Strategy Layer P3 (obj 2341) — tier-aware wake message selection.
//
// fireWake sends a different follow-up to a STRATEGY node (project decision loop)
// than to an ordinary delegator (worker accept/iterate loop). This proves:
//   1. buildWakeMessage emits the project-loop text only for a strategy node, and
//      the NON-strategy branch is the exact pre-P3 [child-complete] text.
//   2. isStrategyNode detects a delegator-with-delegator-children, and is FALSE
//      for an ordinary top-level delegator whose children are plain tasks — which
//      is why flag-off (and a normal delegator) keep the original message.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const TMP_DB = path.join(os.tmpdir(), `cc-wake-message-test-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB

const { initDb, getDb } = await import('../db/index.js')
const { buildWakeMessage, isStrategyNode } = await import('./delegation.js')

function seed(opts: { title: string; parent_id?: number | null; depth?: number; delegate_mode?: 0 | 1 }): number {
  const r = getDb()
    .prepare(
      `INSERT INTO objectives (title, agent_context, workspace, status, parent_id, depth, delegate_mode)
       VALUES (?, 'cto', 'operator', 'queue', ?, ?, ?)`
    )
    .run(opts.title, opts.parent_id ?? null, opts.depth ?? 0, opts.delegate_mode ?? 0)
  return r.lastInsertRowid as number
}

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

describe('buildWakeMessage', () => {
  it('strategy node → project decision-loop message', () => {
    const msg = buildWakeMessage(true)
    expect(msg.startsWith('[project-complete]')).toBe(true)
    expect(msg).toContain('NEXT project')
    // The strategy lead-in differs from the worker message even though the body
    // still references the appended [child-complete] entries.
    expect(msg).not.toBe(buildWakeMessage(false))
  })

  it('ordinary delegator → the exact pre-P3 [child-complete] message', () => {
    const msg = buildWakeMessage(false)
    expect(msg).toBe(
      [
        '[child-complete] One or more of your worker objectives has finished.',
        'Read your NOTES.md — the CHILD REGISTRY and the appended [child-complete] entries hold the latest worker outcomes.',
        'For each finished worker: evaluate its summary/output, then ACCEPT (mark it done), ITERATE (send corrections), or ESCALATE.',
        'Spawn the next queued worker if you are under 5 in flight. Update NOTES.md, then end your turn.',
        'If every worker is accepted or escalated, write your final synthesis and stop.',
      ].join('\n'),
    )
  })
})

describe('isStrategyNode', () => {
  it('is TRUE for a delegator whose child is itself a delegator (a project)', () => {
    const strategyId = seed({ title: 'strategy', depth: 0, delegate_mode: 1 })
    seed({ title: 'project', parent_id: strategyId, depth: 1, delegate_mode: 1 })
    expect(isStrategyNode(getDb(), strategyId)).toBe(true)
  })

  it('is FALSE for an ordinary top-level delegator whose children are plain tasks', () => {
    const delegatorId = seed({ title: 'plain delegator', depth: 0, delegate_mode: 1 })
    seed({ title: 'task', parent_id: delegatorId, depth: 1, delegate_mode: 0 })
    expect(isStrategyNode(getDb(), delegatorId)).toBe(false)
  })
})
