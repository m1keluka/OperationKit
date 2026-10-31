/**
 * Production adapters for the fan-out tick (obj 715699): start a child through the
 * SAME localhost status route the queue-drain uses (so every start guard — caps,
 * human-terminal guard, leases — applies), and read the account pool.
 */
import { getDb } from '../db/index.js'
import { SERVER_PORT } from '../config.js'
import { getRouterStatus } from './account-router.js'
import { tickFanout, type FanoutTickResult, type PoolSnapshot } from './fanout.js'

export async function startChildViaInternalApi(childId: number): Promise<boolean> {
  const r = await fetch(`http://localhost:${SERVER_PORT}/api/internal/objectives/${childId}/status`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'working', reason: 'fanout', actor: 'fanout-tick' }),
  })
  if (!r.ok) {
    console.warn(`[fanout] start child ${childId} → HTTP ${r.status} ${(await r.text().catch(() => '')).slice(0, 200)}`)
    return false
  }
  const body = (await r.json().catch(() => ({}))) as { status?: string; skipped?: boolean }
  return !body.skipped && body.status === 'working'
}

export function livePoolSnapshot(): PoolSnapshot {
  const status = getRouterStatus()
  const globalActive = (getDb()
    .prepare("SELECT COUNT(*) AS c FROM objectives WHERE status IN ('working', 'ai_review')")
    .get() as { c: number }).c
  return { availableAccounts: status.accounts.filter(a => a.available).length, globalActive }
}

let ticking = false
/** Poller hook — non-reentrant; a slow start never stacks ticks. */
export async function runFanoutTick(onlyParentId?: number): Promise<FanoutTickResult[]> {
  if (ticking) return []
  ticking = true
  try {
    return await tickFanout(getDb(), startChildViaInternalApi, livePoolSnapshot, onlyParentId)
  } finally {
    ticking = false
  }
}
