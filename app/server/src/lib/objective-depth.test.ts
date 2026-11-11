// Transitive depth maintenance (obj 707003, P0-2).
//
// The column used to be set by a one-shot boot migration that flattened EVERY
// child to depth 1, plus two insert paths that never wrote it at all. These
// pin the replacement: derive on insert, recompute the subtree on reparent,
// and converge the whole table on boot — including on the shapes the old
// migration got wrong (grandchildren) and the shapes it never considered
// (dangling parents, parent cycles).

import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const TMP_DB = path.join(os.tmpdir(), `cc-obj-depth-test-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB

const { initDb, getDb } = await import('../db/index.js')
const { depthForParent, recomputeSubtreeDepth, backfillAllDepths, danglingParentRows } =
  await import('./objective-depth.js')

initDb()
const db = getDb()

/** Insert with an EXPLICIT (possibly wrong) depth, so backfill has work to do. */
function add(title: string, parent: number | null, depth = 0): number {
  return Number(
    db
      .prepare(
        `INSERT INTO objectives (title, status, agent_context, workspace, parent_id, depth)
         VALUES (?, 'queue', 'cto', 'example', ?, ?)`,
      )
      .run(title, parent, depth).lastInsertRowid,
  )
}

/**
 * Insert a row whose parent_id points at nothing. The live board carries 128 of
 * these (obj 707003 report), but the FK is enforced in a freshly-migrated test
 * DB, so the only way to reproduce the shape is to suspend it — exactly as the
 * historical deletes that produced them did.
 */
function addDangling(title: string, missingParent: number, depth = 0): number {
  db.pragma('foreign_keys = OFF')
  try {
    return add(title, missingParent, depth)
  } finally {
    db.pragma('foreign_keys = ON')
  }
}

const depthOf = (id: number) =>
  (db.prepare('SELECT depth FROM objectives WHERE id = ?').get(id) as { depth: number }).depth

beforeEach(() => {
  db.prepare('DELETE FROM objectives').run()
})

afterAll(() => {
  try { db.close() } catch { /* ignore */ }
  for (const suffix of ['', '-wal', '-shm']) {
    const f = `${TMP_DB}${suffix}`
    if (fs.existsSync(f)) fs.unlinkSync(f)
  }
})

describe('depthForParent — what an INSERT should store', () => {
  it('is 0 for a top-level row', () => {
    expect(depthForParent(db, null)).toBe(0)
    expect(depthForParent(db, undefined)).toBe(0)
  })

  it('is parent.depth + 1, at every level (not a flat 1)', () => {
    const root = add('root', null, 0)
    const child = add('child', root, 1)
    expect(depthForParent(db, root)).toBe(1)
    expect(depthForParent(db, child)).toBe(2)
    const grandchild = add('gc', child, depthForParent(db, child))
    expect(depthForParent(db, grandchild)).toBe(3)
  })

  it('treats a parent id that resolves to nothing as a root', () => {
    expect(depthForParent(db, 999999)).toBe(0)
  })
})

describe('recomputeSubtreeDepth — the REPARENT case', () => {
  it('moves the whole subtree, not just the moved node', () => {
    const a = add('a', null, 0)
    const b = add('b', null, 0)
    const child = add('child', a, 1)
    const grandchild = add('gc', child, 2)

    // Reparent `child` under `b`'s child, pushing the subtree one level deeper.
    const bChild = add('b-child', b, 1)
    db.prepare('UPDATE objectives SET parent_id = ? WHERE id = ?').run(bChild, child)
    recomputeSubtreeDepth(db, child)

    expect(depthOf(child)).toBe(2)
    expect(depthOf(grandchild)).toBe(3)
    // Untouched branches stay put.
    expect(depthOf(a)).toBe(0)
    expect(depthOf(bChild)).toBe(1)
  })

  it('handles a promotion to top level', () => {
    const root = add('root', null, 0)
    const child = add('child', root, 1)
    const grandchild = add('gc', child, 2)

    db.prepare('UPDATE objectives SET parent_id = NULL WHERE id = ?').run(child)
    recomputeSubtreeDepth(db, child)

    expect(depthOf(child)).toBe(0)
    expect(depthOf(grandchild)).toBe(1)
  })

  it('reports only the rows it actually changed', () => {
    const root = add('root', null, 0)
    add('child', root, 1)
    // Already correct — a recompute is a no-op, not a churn of every row.
    expect(recomputeSubtreeDepth(db, root)).toBe(0)
  })

  it('terminates on a parent cycle instead of looping forever', () => {
    const a = add('a', null, 0)
    const b = add('b', a, 1)
    db.prepare('UPDATE objectives SET parent_id = ? WHERE id = ?').run(b, a)
    expect(() => recomputeSubtreeDepth(db, a)).not.toThrow()
  })

  it('is a no-op for an id that does not exist', () => {
    expect(recomputeSubtreeDepth(db, 999999)).toBe(0)
  })
})

describe('backfillAllDepths — the boot migration', () => {
  it('fixes what the old flat `depth = 1` migration got wrong', () => {
    // Exactly the state the old migration produced: EVERY child flattened to 1.
    const root = add('root', null, 0)
    const child = add('child', root, 1)
    const grandchild = add('gc', child, 1)
    const greatGrandchild = add('ggc', grandchild, 1)

    expect(backfillAllDepths(db)).toBe(2)
    expect([depthOf(root), depthOf(child), depthOf(grandchild), depthOf(greatGrandchild)])
      .toEqual([0, 1, 2, 3])
  })

  it('is idempotent — a second run changes nothing', () => {
    const root = add('root', null, 0)
    const child = add('child', root, 0)
    add('gc', child, 0)
    expect(backfillAllDepths(db)).toBe(2)
    expect(backfillAllDepths(db)).toBe(0)
  })

  it('treats a DANGLING parent_id as a root rather than freezing its depth', () => {
    const orphan = addDangling('orphan', 999999, 7)
    const orphanChild = add('orphan-child', orphan, 7)
    backfillAllDepths(db)
    expect(depthOf(orphan)).toBe(0)
    expect(depthOf(orphanChild)).toBe(1)
  })

  it('leaves cycle members alone rather than guessing, and does not hang', () => {
    const a = add('a', null, 3)
    const b = add('b', a, 3)
    db.prepare('UPDATE objectives SET parent_id = ? WHERE id = ?').run(b, a)
    expect(() => backfillAllDepths(db)).not.toThrow()
    // Unreachable from any root => not enumerated => untouched.
    expect(depthOf(a)).toBe(3)
    expect(depthOf(b)).toBe(3)
  })
})

describe('danglingParentRows — visibility, not repair', () => {
  it('lists rows whose parent no longer exists', () => {
    const root = add('root', null, 0)
    add('ok', root, 1)
    const orphanA = addDangling('orphan-a', 999998, 1)
    const orphanB = addDangling('orphan-b', 999999, 1)
    expect(danglingParentRows(db).map(r => r.id)).toEqual([orphanA, orphanB])
  })

  it('is empty on an intact tree', () => {
    const root = add('root', null, 0)
    add('child', root, 1)
    expect(danglingParentRows(db)).toEqual([])
  })
})
