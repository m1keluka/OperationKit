/**
 * Parallel sub-jobs (obj 715699) — a card fans out N independent children under
 * itself and the server starts them in parallel, bounded by a concurrency ceiling
 * that respects the shared account pool, instead of the parent running them in
 * series.
 *
 * Flow: the worker creates the children (POST /api/internal/objectives with
 * `parent_id` — the existing route, so every delegation safety rail there still
 * applies), then registers them here (POST /api/internal/objectives/:id/fanout).
 * `tickFanout` starts queued children up to the ceiling now and again on every
 * poll as earlier siblings finish. The parent's GET /:id/progress shows each
 * child's latest progress + final result (see summarizeChildren), and the
 * existing [child-complete] wake tells a delegator parent when to aggregate.
 */
import type { Database } from 'better-sqlite3'
import { MAX_CONCURRENT_SESSIONS } from '@operationkit/shared'
import { initLiveProgressSchema } from '../db/schema/live-progress.js'

export const DEFAULT_FANOUT_CONCURRENCY = 3
export const MAX_FANOUT_CONCURRENCY = 10
export const MAX_FANOUT_CHILDREN = 20
/** Global slots a fan-out may never consume — kept free for humans and other cards. */
export const FANOUT_GLOBAL_RESERVE = 5

const RUNNING = new Set(['working', 'ai_review'])
const STARTABLE = new Set(['queue'])

export interface FanoutGroup {
  parent_id: number
  max_concurrency: number
  child_ids: number[]
  created_at: string
  updated_at: string
  completed_at: string | null
}

export class FanoutError extends Error {
  constructor(message: string, public readonly status = 400) {
    super(message)
  }
}

function ensure(db: Database): void {
  initLiveProgressSchema(db as never)
}

function rowToGroup(r: Omit<FanoutGroup, 'child_ids'> & { child_ids: string }): FanoutGroup {
  return { ...r, child_ids: JSON.parse(r.child_ids) as number[] }
}

export function getFanoutGroup(db: Database, parentId: number): FanoutGroup | null {
  ensure(db)
  const r = db.prepare('SELECT * FROM fanout_groups WHERE parent_id = ?').get(parentId) as
    | (Omit<FanoutGroup, 'child_ids'> & { child_ids: string })
    | undefined
  return r ? rowToGroup(r) : null
}

/**
 * Register (or extend) the fan-out group for `parentId`. Every child must exist,
 * be a DIRECT child of the parent, and still be startable (`queue`) or already
 * running. Re-registering merges child ids and may change the ceiling.
 */
export function registerFanout(db: Database, parentId: number, childIds: unknown, maxConcurrency?: unknown): FanoutGroup {
  ensure(db)
  if (!Array.isArray(childIds) || childIds.length === 0) throw new FanoutError('child_ids must be a non-empty array of objective ids')
  const ids = [...new Set(childIds.map(Number))]
  if (ids.some(id => !Number.isInteger(id) || id <= 0)) throw new FanoutError('child_ids must be positive integers')
  let cap = DEFAULT_FANOUT_CONCURRENCY
  if (maxConcurrency !== undefined && maxConcurrency !== null) {
    cap = Number(maxConcurrency)
    if (!Number.isInteger(cap) || cap < 1 || cap > MAX_FANOUT_CONCURRENCY) {
      throw new FanoutError(`max_concurrency must be an integer 1..${MAX_FANOUT_CONCURRENCY}`)
    }
  }
  const parent = db.prepare('SELECT id FROM objectives WHERE id = ?').get(parentId)
  if (!parent) throw new FanoutError(`parent ${parentId} not found`, 404)

  const existing = getFanoutGroup(db, parentId)
  const merged = [...new Set([...(existing?.child_ids ?? []), ...ids])]
  if (merged.length > MAX_FANOUT_CHILDREN) throw new FanoutError(`a fan-out group holds at most ${MAX_FANOUT_CHILDREN} children`)

  for (const id of ids) {
    const c = db.prepare('SELECT id, parent_id, status FROM objectives WHERE id = ?').get(id) as
      | { id: number; parent_id: number | null; status: string }
      | undefined
    if (!c) throw new FanoutError(`child ${id} not found`, 404)
    if (c.parent_id !== parentId) throw new FanoutError(`objective ${id} is not a direct child of ${parentId}`)
    if (!STARTABLE.has(c.status) && !RUNNING.has(c.status)) {
      throw new FanoutError(`child ${id} is '${c.status}' — only queued (or already running) children can join a fan-out`)
    }
  }

  db.prepare(
    `INSERT INTO fanout_groups (parent_id, max_concurrency, child_ids) VALUES (?, ?, ?)
     ON CONFLICT(parent_id) DO UPDATE SET max_concurrency = excluded.max_concurrency,
       child_ids = excluded.child_ids, updated_at = datetime('now'), completed_at = NULL`,
  ).run(parentId, cap, JSON.stringify(merged))
  return getFanoutGroup(db, parentId)!
}

export interface PoolSnapshot {
  /** Claude accounts currently able to take a session. 0 ⇒ starting would only queue. */
  availableAccounts: number
  /** Sessions running board-wide (working + ai_review). */
  globalActive: number
  globalCap?: number
}

/**
 * PURE: how many more children may start right now.
 * min(ceiling − running children, global headroom − reserve), and 0 when no account
 * in the pool is available (a start would just land in the account queue).
 */
export function fanoutSlots(maxConcurrency: number, runningChildren: number, pool: PoolSnapshot): number {
  if (pool.availableAccounts <= 0) return 0
  const globalCap = pool.globalCap ?? MAX_CONCURRENT_SESSIONS
  const groupRoom = maxConcurrency - runningChildren
  const globalRoom = globalCap - FANOUT_GLOBAL_RESERVE - pool.globalActive
  return Math.max(0, Math.min(groupRoom, globalRoom))
}

export interface FanoutTickResult {
  parent_id: number
  started: number[]
  running: number[]
  queued: number[]
  finished: number[]
  completed: boolean
}

const inFlight = new Set<number>()

/**
 * Start queued children of every open fan-out group up to its ceiling.
 * `startChild` performs the actual queue → working transition (the internal status
 * route in production) and resolves true when the child is now running.
 */
export async function tickFanout(
  db: Database,
  startChild: (childId: number) => Promise<boolean>,
  pool: () => PoolSnapshot,
  onlyParentId?: number,
): Promise<FanoutTickResult[]> {
  ensure(db)
  const groups = (
    onlyParentId
      ? db.prepare('SELECT * FROM fanout_groups WHERE parent_id = ? AND completed_at IS NULL').all(onlyParentId)
      : db.prepare('SELECT * FROM fanout_groups WHERE completed_at IS NULL').all()
  ) as Array<Omit<FanoutGroup, 'child_ids'> & { child_ids: string }>

  const results: FanoutTickResult[] = []
  for (const raw of groups) {
    const g = rowToGroup(raw)
    const statusOf = new Map<number, string>()
    for (const id of g.child_ids) {
      const r = db.prepare('SELECT status FROM objectives WHERE id = ?').get(id) as { status: string } | undefined
      statusOf.set(id, r?.status ?? 'cancelled') // a deleted child counts as finished
    }
    const running = g.child_ids.filter(id => RUNNING.has(statusOf.get(id)!) || inFlight.has(id))
    const queued = g.child_ids.filter(id => STARTABLE.has(statusOf.get(id)!) && !inFlight.has(id))
    const started: number[] = []

    // Re-derive the ceiling before EVERY start: a concurrent tick may have started
    // (or be starting) siblings while this one awaited a slow startChild.
    const liveRunning = (): number =>
      g.child_ids.filter(cid => {
        if (inFlight.has(cid)) return true
        const r = db.prepare('SELECT status FROM objectives WHERE id = ?').get(cid) as { status: string } | undefined
        return !!r && RUNNING.has(r.status)
      }).length
    for (const id of queued) {
      if (inFlight.has(id)) continue
      const cur = db.prepare('SELECT status FROM objectives WHERE id = ?').get(id) as { status: string } | undefined
      if (!cur || !STARTABLE.has(cur.status)) continue
      if (fanoutSlots(g.max_concurrency, liveRunning(), pool()) <= 0) break
      inFlight.add(id)
      try {
        if (await startChild(id)) started.push(id)
      } catch (err) {
        console.warn(`[fanout] parent ${g.parent_id}: failed to start child ${id}:`, (err as Error).message)
      } finally {
        inFlight.delete(id)
      }
    }

    const nowRunning = [...running, ...started]
    const stillQueued = queued.filter(id => !started.includes(id))
    const finished = g.child_ids.filter(id => !nowRunning.includes(id) && !stillQueued.includes(id))
    const completed = nowRunning.length === 0 && stillQueued.length === 0
    if (completed) {
      db.prepare("UPDATE fanout_groups SET completed_at = datetime('now'), updated_at = datetime('now') WHERE parent_id = ?").run(g.parent_id)
    }
    results.push({ parent_id: g.parent_id, started, running: nowRunning, queued: stillQueued, finished, completed })
  }
  return results
}

/**
 * Child ids owned by an OPEN fan-out group. Other queue starters (the flag-gated
 * orphaned-queue drainer) skip these so they can't push a group past its ceiling.
 */
export function fanoutManagedChildIds(db: Database): Set<number> {
  ensure(db)
  const out = new Set<number>()
  const rows = db.prepare('SELECT child_ids FROM fanout_groups WHERE completed_at IS NULL').all() as Array<{ child_ids: string }>
  for (const r of rows) {
    try { for (const id of JSON.parse(r.child_ids) as number[]) out.add(id) } catch { /* corrupt row */ }
  }
  return out
}
