import fs from 'fs'

// Persistent marker recording when the last process restart was scheduled.
// Lives under /app/data (a mounted volume) so it survives the restart itself —
// that's what lets us coalesce a deploy that arrives moments AFTER a restart.
const MARKER = '/app/data/.last-restart'

// Restart/deploy requests that arrive within this window of a prior restart are
// coalesced (not acted on) unless forced. Self-deploys read mounted source at
// process start, so a restart that just happened already picked up the latest
// code — a second one within seconds only churns WebSockets for no benefit.
const COOLDOWN_MS = 30_000

// In-process guard: once a restart is scheduled, the process is about to exit,
// so any further restart calls in the ~1s pre-exit window are redundant.
let restartPending = false

function readLastRestart(): number {
  try {
    const n = parseInt(fs.readFileSync(MARKER, 'utf-8').trim(), 10)
    return Number.isFinite(n) ? n : 0
  } catch {
    return 0
  }
}

export type RestartResult =
  | { scheduled: true }
  | { scheduled: false; reason: 'pending' | 'cooldown'; sinceMs?: number }

/**
 * Schedule a single, coalesced process exit (the container auto-restarts).
 *
 * Guards against the self-deploy restart storm (2026-06-22 incident): multiple
 * sessions issuing deploys / forced restarts within seconds of each other each
 * dropped every WebSocket and reset in-flight HTTP (Caddy 502 "connection reset
 * by peer"), so the board went dark and follow-ups appeared to never register.
 *
 *  - `restartPending` dedupes concurrent calls before the exit fires.
 *  - The persistent marker dedupes calls that land just AFTER a restart.
 *
 * `force` bypasses the cooldown (manual/admin restarts, genuine emergencies) but
 * still respects the in-process dedupe. Returns whether an exit was scheduled.
 */
export function scheduleRestart(label: string, opts: { force?: boolean } = {}): RestartResult {
  if (restartPending) {
    console.log(`[restart-guard] ${label}: restart already pending — coalesced`)
    return { scheduled: false, reason: 'pending' }
  }
  if (!opts.force) {
    const sinceMs = Date.now() - readLastRestart()
    if (sinceMs < COOLDOWN_MS) {
      console.log(`[restart-guard] ${label}: a restart happened ${Math.round(sinceMs / 1000)}s ago (< ${COOLDOWN_MS / 1000}s cooldown) — coalesced`)
      return { scheduled: false, reason: 'cooldown', sinceMs }
    }
  }
  restartPending = true
  try {
    fs.writeFileSync(MARKER, String(Date.now()))
  } catch (err) {
    console.warn(`[restart-guard] could not write ${MARKER}:`, err instanceof Error ? err.message : err)
  }
  console.log(`[restart-guard] ${label}: scheduling restart in 1s${opts.force ? ' (forced)' : ''}`)
  setTimeout(() => process.exit(0), 1000)
  return { scheduled: true }
}
