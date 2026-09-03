import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'

// SAFETY: bind the DB to a per-process temp FILE BEFORE importing db/index.
// db/index reads DB_PATH at module-load; setting it here (then dynamic-importing)
// guarantees these tests never open the live board DB.
const TMP_DB = path.join(os.tmpdir(), `cc-deadrepark-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB

const { initDb, getDb } = await import('../db/index.js')
const { decideDeadSessionRepark } = await import('./state-poller.js')

// The EXACT main-poll select query (state-poller.ts) — the churn's selection set.
const SELECT = "SELECT * FROM objectives WHERE status IN ('working', 'review') AND session_id IS NOT NULL AND deleted_at IS NULL"

function seedReviewWithDeadSession(sessionId: string): number {
  const r = getDb().prepare(
    `INSERT INTO objectives (title, agent_context, workspace, status, session_id)
     VALUES ('churn victim', 'cto', 'example', 'review', ?)`
  ).run(sessionId)
  return Number(r.lastInsertRowid)
}

/** Apply ONE poll pass of the dead-session handling using the REAL decision fn. */
function pollPass(clearEnabled: boolean): void {
  const db = getDb()
  const actives = db.prepare(SELECT).all() as { id: number; status: string; session_id: string | null }[]
  for (const obj of actives) {
    const action = decideDeadSessionRepark(obj as Parameters<typeof decideDeadSessionRepark>[0], clearEnabled)
    if (action === 'skip-noop') continue
    if (action === 'clear-session') {
      db.prepare("UPDATE objectives SET status = 'review', session_id = NULL, updated_at = datetime('now') WHERE id = ?").run(obj.id)
    } else {
      // route-to-review: legacy in-place re-park (session_id retained) — the churn.
      db.prepare("UPDATE objectives SET status = 'review', updated_at = datetime('now') WHERE id = ?").run(obj.id)
    }
  }
}

beforeAll(() => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
})
afterAll(() => {
  try { getDb().close() } catch {}
  for (const s of ['', '-wal', '-shm']) { const f = `${TMP_DB}${s}`; if (fs.existsSync(f)) fs.unlinkSync(f) }
})
beforeEach(() => { getDb().prepare('DELETE FROM objectives').run() })

describe('decideDeadSessionRepark (FIX A pure branch)', () => {
  it('already-review + stale dead session_id → clear-session', () => {
    expect(decideDeadSessionRepark({ status: 'review', session_id: 'cc-3-1' }, true)).toBe('clear-session')
  })
  it('already-review + session_id already null → skip-noop', () => {
    expect(decideDeadSessionRepark({ status: 'review', session_id: null }, true)).toBe('skip-noop')
  })
  it('working→review transition → route-to-review (legacy behavior preserved)', () => {
    expect(decideDeadSessionRepark({ status: 'working', session_id: 'cc-3-1' }, true)).toBe('route-to-review')
  })
  it('flag OFF → always route-to-review (no clear)', () => {
    expect(decideDeadSessionRepark({ status: 'review', session_id: 'cc-3-1' }, false)).toBe('route-to-review')
  })
})

describe('MODE-1 churn is killed after one pass (flag ON)', () => {
  it('a review objective with a resultless dead session is removed from the select set + session_id NULL', () => {
    const id = seedReviewWithDeadSession('cc-3-dead')
    // Before: the row IS in the churn selection set.
    expect((getDb().prepare(SELECT).all() as { id: number }[]).some(o => o.id === id)).toBe(true)

    pollPass(true) // ONE pass with FIX A on

    const row = getDb().prepare('SELECT * FROM objectives WHERE id = ?').get(id) as { session_id: string | null; status: string }
    expect(row.session_id).toBeNull()
    expect(row.status).toBe('review')
    // After: gone from the select set → the poller will never re-park it again.
    expect((getDb().prepare(SELECT).all() as { id: number }[]).some(o => o.id === id)).toBe(false)
  })

  it('updated_at no longer bumps on subsequent passes (churn stopped)', () => {
    const id = seedReviewWithDeadSession('cc-2-dead')
    pollPass(true) // clears session_id
    const afterClear = (getDb().prepare('SELECT updated_at FROM objectives WHERE id = ?').get(id) as { updated_at: string }).updated_at
    // Two more passes must be complete no-ops for this row.
    pollPass(true)
    pollPass(true)
    const afterMore = (getDb().prepare('SELECT updated_at FROM objectives WHERE id = ?').get(id) as { updated_at: string }).updated_at
    expect(afterMore).toBe(afterClear)
  })

  it('flag OFF reproduces the churn: the row stays in the select set and keeps being re-parked', () => {
    const id = seedReviewWithDeadSession('cc-9-dead')
    pollPass(false)
    const row = getDb().prepare('SELECT * FROM objectives WHERE id = ?').get(id) as { session_id: string | null }
    expect(row.session_id).toBe('cc-9-dead') // NOT cleared
    expect((getDb().prepare(SELECT).all() as { id: number }[]).some(o => o.id === id)).toBe(true) // still churning
  })
})

describe('live poller does not tmux-probe Needs-You cards (HTTP-starve fix)', () => {
  const here = path.dirname(fileURLToPath(import.meta.url))

  it('poller-loop sweeps review session_id before the live select', () => {
    const src = fs.readFileSync(path.join(here, 'poller-loop.ts'), 'utf8')
    const sweep = src.indexOf("WHERE status = 'review'")
    const select = src.indexOf(SELECT)
    expect(sweep).toBeGreaterThan(0)
    expect(select).toBeGreaterThan(0)
    expect(sweep).toBeLessThan(select)
    expect(src).toContain("if (objective.status === 'review') continue")
  })

  it('poller skips overlapping ticks', () => {
    const src = fs.readFileSync(path.join(here, 'state-poller.ts'), 'utf8')
    expect(src).toContain('if (pollInFlight) return')
  })
})
