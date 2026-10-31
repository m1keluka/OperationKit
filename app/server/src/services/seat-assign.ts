/**
 * Per-session seat assignment (seat pool v2).
 *
 * Every session start picks a SEAT first, then builds its sign-in from that
 * seat: a pasted token becomes the session's env (seatCredentialEnv), a Codex /
 * Grok CLI login is the seat's HOME on the host or its login dir mounted into
 * the jail (seatJailMount). The seat id is what session_runtime / session_intel
 * record as the session's account.
 *
 * Cross-engine failover is opt-in: a workspace setting (settings key
 * `seat_failover:<workspace>`, JSON `{ enabled, order }`) plus a per-card
 * override (objectives.engine_failover). A card only leaves its engine when
 * EVERY seat of that engine is unavailable, never when it is pinned, and the
 * move is logged on the card.
 */
import type { Objective } from '@operationkit/shared'
import { getDb } from '../db/index.js'
import { hasAvailableSeat, pickSeatOfKind, type AccountSlot } from './account-router.js'
import { seatCredentialEnv, seatJailMount, type SeatMount } from './seat-credentials.js'
import {
  DEFAULT_FAILOVER_ORDER,
  effectiveFailover,
  normalizeOrder,
  parseCardFailover,
  resolveEngineFailover,
  type FailoverPolicy,
  type SeatKind,
} from './seat-pool.js'
import { listEnabledModels, getDefaultModelId } from './model-registry.js'
import { CODEX_MODEL, GROK_DEFAULT_MODEL } from './session-spawn-command.js'

export const FAILOVER_SETTING_PREFIX = 'seat_failover:'

/** Workspace failover policy. Default: off, order Claude → Codex → Grok. */
export function getWorkspaceFailover(workspace: string | null | undefined): FailoverPolicy {
  const fallback: FailoverPolicy = { enabled: false, order: [...DEFAULT_FAILOVER_ORDER] }
  if (!workspace) return fallback
  try {
    const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(FAILOVER_SETTING_PREFIX + workspace) as { value: string } | undefined
    if (!row) return fallback
    const parsed = JSON.parse(row.value) as { enabled?: unknown; order?: unknown }
    const order = Array.isArray(parsed.order) ? normalizeOrder(parsed.order) : []
    return { enabled: parsed.enabled === true, order: order.length ? order : fallback.order }
  } catch {
    return fallback
  }
}

export function setWorkspaceFailover(workspace: string, policy: FailoverPolicy): FailoverPolicy {
  const order = normalizeOrder(policy.order)
  const clean: FailoverPolicy = { enabled: !!policy.enabled, order: order.length ? order : [...DEFAULT_FAILOVER_ORDER] }
  getDb()
    .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(FAILOVER_SETTING_PREFIX + workspace, JSON.stringify(clean))
  return clean
}

/** The model a card runs on when it fails over to `engine`: that engine's first enabled registry model. */
export function failoverModelFor(engine: SeatKind): string {
  try {
    const row = listEnabledModels().find(m => m.engine === engine)
    if (row) return row.id
  } catch { /* registry unavailable — use the built-in default */ }
  if (engine === 'codex') return CODEX_MODEL
  if (engine === 'grok') return GROK_DEFAULT_MODEL
  return getDefaultModelId()
}

export interface SeatAssignment {
  seat: AccountSlot
  engine: SeatKind
  /** Model to run this session on (differs from the card's only after a failover). */
  model: string | undefined
  fellBackFrom: SeatKind | null
  /** Sign-in env for this seat (a pasted token). Never an API key. */
  env: Record<string, string>
  /** Sandboxed Codex / Grok: the seat's login dir to bind into the jail. */
  mount: SeatMount | null
}

/**
 * Pick the seat for a fresh session on `cardEngine`, failing over across
 * engines only when the policy allows it. Returns null when no allowed engine
 * has a seat — the caller queues the card.
 */
export function assignSeatForStart(
  objective: Pick<Objective, 'id' | 'workspace' | 'model' | 'title' | 'project' | 'session_id'> & { engine_failover?: string | null },
  cardEngine: SeatKind,
): SeatAssignment | null {
  const policy = effectiveFailover(getWorkspaceFailover(objective.workspace), parseCardFailover(objective.engine_failover))
  const decision = resolveEngineFailover(cardEngine, policy, hasAvailableSeat)
  if (decision.queued) return null
  const seat = pickSeatOfKind(decision.engine)
  if (!seat) return null
  const model = decision.fellBackFrom ? failoverModelFor(decision.engine) : (objective.model || undefined)
  if (decision.fellBackFrom) logFailover(objective, decision.fellBackFrom, decision.engine, seat)
  return {
    seat,
    engine: decision.engine,
    model,
    fellBackFrom: decision.fellBackFrom,
    env: seatCredentialEnv(seat),
    mount: seatJailMount(seat),
  }
}

/** Sign-in for an already-chosen seat (follow-ups re-pick within the card's engine). */
export function seatSignIn(seat: AccountSlot): { env: Record<string, string>; mount: SeatMount | null } {
  return { env: seatCredentialEnv(seat), mount: seatJailMount(seat) }
}

function logFailover(
  objective: Pick<Objective, 'id' | 'workspace' | 'title' | 'project' | 'session_id'>,
  from: SeatKind,
  to: SeatKind,
  seat: AccountSlot,
): void {
  const label = seat.customLabel || seat.label
  const detail = `Every ${from} seat is unavailable; this session runs on ${to} (seat "${label}") per the failover setting. The card's own engine is unchanged.`
  console.log(`[seat-assign] Objective ${objective.id}: failover ${from} → ${to} (seat ${seat.id})`)
  try {
    getDb().prepare(
      `INSERT INTO activity_log (project, workspace, objective_id, session_id, event_type, title, detail)
       VALUES (?, ?, ?, ?, 'milestone', 'seat_failover', ?)`,
    ).run(objective.project || 'unknown', objective.workspace, objective.id, objective.session_id ?? null, detail)
  } catch (err) {
    console.warn('[seat-assign] failed to log failover:', err instanceof Error ? err.message : err)
  }
}

/**
 * Record which seat a session runs on as soon as it is assigned (death-time
 * persistence fills in the CLI session id later). session_runtime.account_id is
 * the per-session seat record the follow-up path and the dashboard read.
 */
export function recordSessionSeat(sessionId: string, seatId: string): void {
  try {
    getDb().prepare(
      `INSERT INTO session_runtime (session_id, claude_session_id, account_id, updated_at)
       VALUES (?, NULL, ?, datetime('now'))
       ON CONFLICT(session_id) DO UPDATE SET account_id = excluded.account_id, updated_at = excluded.updated_at`,
    ).run(sessionId, seatId)
  } catch (err) {
    console.warn(`[seat-assign] failed to record seat for ${sessionId}:`, err instanceof Error ? err.message : err)
  }
}
