/**
 * In-memory live-session table + spawn-segment offsets.
 * Extracted from session-manager.ts (behavior frozen).
 */
import type { ChildProcess } from 'child_process'
import type { Objective } from '@operationkit/shared'
import { getDb } from '../db/index.js'
import { recordSessionSpawn, clearSessionSpawn } from './session-spawn-clock.js'

export interface ActiveSession {
  process?: ChildProcess              // Legacy: only set for non-tmux sessions
  logPath: string
  jsonlPath: string
  startedAt: number
  accountId: string | null
  objective: Objective
  stdin?: NodeJS.WritableStream | null  // Legacy: only set for non-tmux sessions
  tmuxName?: string                   // tmux session name (when spawned via tmux)
  requestedModel?: string             // model passed via --model (undefined = CLI default)
}

export const activeSessions = new Map<string, ActiveSession>()

/**
 * Register a freshly (re)spawned session: the in-memory map AND the durable
 * spawn clock. Every spawn path must go through this — a plain
 * `activeSessions.set` leaves the wall-clock watchdog with nothing to rehydrate
 * after a server restart, which is exactly the bug that force-routed
 * freshly-resumed sessions to review on stale transcript birthtimes.
 * Persistence is best-effort: a DB hiccup must never block a spawn.
 */
export function registerActiveSession(sessionId: string, session: ActiveSession): void {
  activeSessions.set(sessionId, session)
  try {
    recordSessionSpawn(getDb(), sessionId, session.startedAt)
  } catch (err) {
    console.error(`[session-manager] failed to persist spawn clock for ${sessionId}:`, err)
  }
}

/** Forget a session's durable spawn clock (session stopped / died). Best-effort. */
export function forgetSpawnClock(sessionId: string): void {
  try {
    clearSessionSpawn(getDb(), sessionId)
  } catch { /* best-effort cleanup */ }
}

// Per-session spawn-segment boundary: how many jsonl lines already existed when
// the CURRENT spawn began. The jsonl is appended across respawns (one file per
// session), so after auto-resume rotates an objective onto a fresh account the
// tail can still hold the PREVIOUS account's rate_limit_event. The death-scan
// must only look at lines from the current spawn segment, else a prior account's
// rejection is misattributed to the current (often healthy) account — the
// false-bench bug. (obj-1124: restored after the restart-storm wiped it.)
export const spawnSegmentOffset = new Map<string, number>()
