import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

// Parallel sub-jobs (obj 715699): registerFanout validation, the pure slot math,
// and tickFanout's ceiling under sequential and concurrent ticks. Real SQLite.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-fanout-test-'))
process.env.DB_PATH = path.join(TMP, 'db.sqlite')
process.env.JWT_SECRET = 'test-secret-fanout'
process.env.TRANSCRIPT_DIR = TMP

const { getDb, initDb } = await import('../db/index.js')
const { registerFanout, fanoutSlots, tickFanout, getFanoutGroup, FanoutError, FANOUT_GLOBAL_RESERVE } = await import('./fanout.js')

type Db = ReturnType<typeof getDb>
let db: Db
let parentId: number
let children: number[]
let otherParent: number

const POOL = () => ({ availableAccounts: 3, globalActive: 0, globalCap: 25 })

function insert(title: string, status: string, parent: number | null): number {
  return Number(
    db.prepare(`INSERT INTO objectives (title, status, type, workspace, parent_id) VALUES (?, ?, 'task', 'ws-a', ?)`).run(title, status, parent)
      .lastInsertRowid,
  )
}
function statusOf(id: number): string {
  return (db.prepare('SELECT status FROM objectives WHERE id = ?').get(id) as { status: string }).status
}
function setStatus(id: number, status: string): void {
  db.prepare('UPDATE objectives SET status = ? WHERE id = ?').run(status, id)
}
function runningCount(ids: number[]): number {
  return ids.filter(id => ['working', 'ai_review'].includes(statusOf(id))).length
}

/** Realistic fake: only a queued child can start (mirrors the status route's skip). */
function makeStarter(opts: { delayMs?: number; ids: number[]; ceiling: number }) {
  const calls: number[] = []
  let maxSeen = 0
  const start = async (id: number): Promise<boolean> => {
    calls.push(id)
    if (opts.delayMs) await new Promise(r => setTimeout(r, opts.delayMs))
    if (statusOf(id) !== 'queue') return false
    setStatus(id, 'working')
    maxSeen = Math.max(maxSeen, runningCount(opts.ids))
    return true
  }
  return { start, calls, maxSeen: () => maxSeen }
}

beforeAll(() => {
  initDb()
  db = getDb()
})

afterAll(() => {
  try { db.close() } catch { /* ignore */ }
  fs.rmSync(TMP, { recursive: true, force: true })
})

beforeEach(() => {
  db.prepare('DELETE FROM fanout_groups').run()
  parentId = insert('parent', 'working', null)
  otherParent = insert('other parent', 'working', null)
  children = [1, 2, 3, 4, 5].map(i => insert(`child ${i}`, 'queue', parentId))
})

describe('registerFanout — validation', () => {
  it('registers direct queued children with the given ceiling', () => {
    const g = registerFanout(db, parentId, children, 2)
    expect(g.parent_id).toBe(parentId)
    expect(g.max_concurrency).toBe(2)
    expect(g.child_ids).toEqual(children)
    expect(g.completed_at).toBeNull()
    expect(getFanoutGroup(db, parentId)!.child_ids).toEqual(children)
  })

  it('rejects an objective that is not a direct child', () => {
    const stranger = insert('stranger', 'queue', otherParent)
    expect(() => registerFanout(db, parentId, [children[0], stranger], 2)).toThrow(/not a direct child/)
    expect(getFanoutGroup(db, parentId)).toBeNull()
  })

  it('rejects a child that is not queued/running', () => {
    const done = insert('done child', 'done', parentId)
    expect(() => registerFanout(db, parentId, [done])).toThrow(/only queued/)
  })

  it('rejects bad max_concurrency and bad child_ids', () => {
    for (const bad of [0, -1, 11, 2.5, 'abc']) {
      expect(() => registerFanout(db, parentId, children, bad)).toThrow(/max_concurrency/)
    }
    expect(() => registerFanout(db, parentId, [], 2)).toThrow(/non-empty/)
    expect(() => registerFanout(db, parentId, 'nope', 2)).toThrow(/non-empty/)
    expect(() => registerFanout(db, parentId, [0], 2)).toThrow(/positive/)
  })

  it('404s an unknown parent / child', () => {
    let err: unknown
    try { registerFanout(db, 999999, children, 2) } catch (e) { err = e }
    expect(err).toBeInstanceOf(FanoutError)
    expect((err as InstanceType<typeof FanoutError>).status).toBe(404)
    expect(() => registerFanout(db, parentId, [999998], 2)).toThrow(/not found/)
  })

  it('re-registering merges child ids and updates the ceiling', () => {
    registerFanout(db, parentId, children.slice(0, 2), 2)
    const g = registerFanout(db, parentId, children.slice(1), 4)
    expect(g.child_ids).toEqual(children)
    expect(g.max_concurrency).toBe(4)
  })
})

describe('fanoutSlots — pure', () => {
  it('0 available accounts → 0', () => {
    expect(fanoutSlots(5, 0, { availableAccounts: 0, globalActive: 0, globalCap: 25 })).toBe(0)
  })
  it('group ceiling bounds the slots', () => {
    expect(fanoutSlots(3, 0, { availableAccounts: 1, globalActive: 0, globalCap: 25 })).toBe(3)
    expect(fanoutSlots(3, 2, { availableAccounts: 1, globalActive: 0, globalCap: 25 })).toBe(1)
    expect(fanoutSlots(3, 3, { availableAccounts: 1, globalActive: 0, globalCap: 25 })).toBe(0)
    expect(fanoutSlots(3, 5, { availableAccounts: 1, globalActive: 0, globalCap: 25 })).toBe(0)
  })
  it('global headroom minus the reserve bounds the slots', () => {
    const cap = 25
    expect(fanoutSlots(10, 0, { availableAccounts: 2, globalActive: cap - FANOUT_GLOBAL_RESERVE - 1, globalCap: cap })).toBe(1)
    expect(fanoutSlots(10, 0, { availableAccounts: 2, globalActive: cap - FANOUT_GLOBAL_RESERVE, globalCap: cap })).toBe(0)
    expect(fanoutSlots(10, 0, { availableAccounts: 2, globalActive: cap, globalCap: cap })).toBe(0)
  })
})

describe('tickFanout — ceiling across ticks', () => {
  it('starts up to the ceiling, refills as children finish, completes when all done', async () => {
    registerFanout(db, parentId, children, 2)
    const s = makeStarter({ ids: children, ceiling: 2 })

    let [r] = await tickFanout(db, s.start, POOL, parentId)
    expect(r.started).toHaveLength(2)
    expect(r.started).toEqual(children.slice(0, 2))
    expect(r.queued).toHaveLength(3)
    expect(r.completed).toBe(false)
    expect(runningCount(children)).toBe(2)

    ;[r] = await tickFanout(db, s.start, POOL, parentId)
    expect(r.started).toHaveLength(0)
    expect(r.running).toHaveLength(2)
    expect(runningCount(children)).toBe(2)

    setStatus(children[0], 'done')
    ;[r] = await tickFanout(db, s.start, POOL, parentId)
    expect(r.started).toEqual([children[2]])
    expect(r.finished).toEqual([children[0]])
    expect(runningCount(children)).toBe(2)

    // Drain the rest, one finish at a time, asserting the ceiling every tick.
    for (let guard = 0; guard < 10; guard++) {
      const live = children.filter(id => statusOf(id) === 'working')
      if (live.length === 0) break
      setStatus(live[0], 'done')
      ;[r] = await tickFanout(db, s.start, POOL, parentId)
      expect(runningCount(children)).toBeLessThanOrEqual(2)
      if (r.completed) break
    }
    // A final tick after the last child finishes marks completion.
    for (const id of children) if (statusOf(id) === 'working') setStatus(id, 'done')
    const finalTick = await tickFanout(db, s.start, POOL, parentId)
    const completedNow = finalTick.length === 0 ? true : finalTick[0].completed
    expect(completedNow).toBe(true)
    expect(getFanoutGroup(db, parentId)!.completed_at).not.toBeNull()
    expect(s.maxSeen()).toBeLessThanOrEqual(2)
    expect(new Set(s.calls).size).toBe(5)
    expect(s.calls).toHaveLength(5) // each child started exactly once
    // A completed group is skipped on later ticks.
    expect(await tickFanout(db, s.start, POOL, parentId)).toEqual([])
  })

  it('serialized ticks (the runFanoutTick shape) hold the ceiling even with a slow starter', async () => {
    registerFanout(db, parentId, children, 2)
    const s = makeStarter({ ids: children, ceiling: 2, delayMs: 5 })
    await tickFanout(db, s.start, POOL, parentId)
    await tickFanout(db, s.start, POOL, parentId)
    expect(runningCount(children)).toBe(2)
    expect(s.calls).toEqual(children.slice(0, 2))
  })

  it('a start that returns false / throws does not consume a slot', async () => {
    registerFanout(db, parentId, children, 2)
    const calls: number[] = []
    const start = async (id: number) => {
      calls.push(id)
      if (id === children[0]) throw new Error('boom')
      if (id === children[1]) return false
      setStatus(id, 'working')
      return true
    }
    const [r] = await tickFanout(db, start, POOL, parentId)
    expect(r.started).toEqual([children[2], children[3]])
    expect(runningCount(children)).toBe(2)
  })

  it('no available account → nothing starts', async () => {
    registerFanout(db, parentId, children, 2)
    const s = makeStarter({ ids: children, ceiling: 2 })
    const [r] = await tickFanout(db, s.start, () => ({ availableAccounts: 0, globalActive: 0 }), parentId)
    expect(r.started).toEqual([])
    expect(s.calls).toEqual([])
  })

  // Regression (found while writing these tests): the start loop must re-check the
  // ceiling and each child's status before every start, or two overlapping ticks
  // with a slow starter overshoot the ceiling and double-start a child.
  it('two concurrent ticks with a slow starter never exceed the ceiling', async () => {
    registerFanout(db, parentId, children, 2)
    const s = makeStarter({ ids: children, ceiling: 2, delayMs: 20 })
    const [a, b] = await Promise.all([
      tickFanout(db, s.start, POOL, parentId),
      tickFanout(db, s.start, POOL, parentId),
    ])
    expect(runningCount(children)).toBeLessThanOrEqual(2)
    expect(s.maxSeen()).toBeLessThanOrEqual(2)
    const startedDistinct = new Set([...a[0].started, ...b[0].started])
    expect(startedDistinct.size).toBeLessThanOrEqual(2)
    expect(a[0].started.length + b[0].started.length).toBeLessThanOrEqual(2)
  })

  it('concurrent ticks never issue duplicate start calls for the same child', async () => {
    registerFanout(db, parentId, children, 2)
    const s = makeStarter({ ids: children, ceiling: 2, delayMs: 20 })
    await Promise.all([tickFanout(db, s.start, POOL, parentId), tickFanout(db, s.start, POOL, parentId)])
    const dupes = s.calls.filter((id, i) => s.calls.indexOf(id) !== i)
    expect(dupes).toEqual([])
  })
})
