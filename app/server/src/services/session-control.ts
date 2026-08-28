/**
 * Interrupt / stop / live-session state — extracted from session-manager.ts
 * (behavior frozen). queueFollowUp is unwired; checkStreamForRateLimit is unused
 * here (mentor-session has its own copy). Kept as copy-unchanged.
 */
import { execSync } from 'child_process'
import path from 'path'
import { getDb } from '../db/index.js'
import {
  recordRateLimit,
  recordSessionEnd,
  isRateLimitMessage,
  parseResetTime,
} from './account-router.js'
import { TRANSCRIPT_DIR } from '../config.js'
import { getPersistedSpawnStart, resolveSpawnStartMs } from './session-spawn-clock.js'
import { extractFinalUsage } from './session-usage.js'
import { tmuxSessionAlive } from './session-tmux.js'
import { readJsonlTail, jsonlHasResult } from './session-jsonl.js'
import { activeSessions, forgetSpawnClock } from './session-registry.js'

// Queued follow-up messages per objective (sent when current turn finishes)
const followUpQueue = new Map<number, string[]>()

export function queueFollowUp(objectiveId: number, message: string): void {
  const queue = followUpQueue.get(objectiveId) || []
  queue.push(message)
  followUpQueue.set(objectiveId, queue)
  console.log(`[session-manager] Queued follow-up for objective ${objectiveId} (${queue.length} in queue)`)
}

/** Check stream-json stdout for rate_limit or error events indicating exhaustion */
function checkStreamForRateLimit(data: Buffer, accountId: string): void {
  const text = data.toString()
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const event = JSON.parse(trimmed)
      // Check for rate_limit_event from stream-json
      // Only trigger on actual denials, not informational "allowed" status events
      if (event.type === 'rate_limit_event' || event.type === 'rate_limit') {
        const info = event.rate_limit_info || event
        if (info.status && info.status.startsWith('allowed')) continue // not a real rate limit
        const resetTime = info.resetsAt ? new Date(info.resetsAt * 1000) : (event.reset_at ? new Date(event.reset_at) : undefined)
        recordRateLimit(accountId, resetTime, JSON.stringify(event).slice(0, 500))
        return
      }
      // Check error events for rate limit messages
      if (event.type === 'error' || (event.type === 'result' && event.subtype === 'error')) {
        const errorText = event.error || event.result || event.text || ''
        if (isRateLimitMessage(errorText)) {
          const resetTime = parseResetTime(errorText)
          recordRateLimit(accountId, resetTime || undefined, errorText)
          return
        }
      }
    } catch {}
  }
}

/** Send Ctrl+C to a tmux session to interrupt the current Claude turn without killing the session */
export function interruptSession(sessionId: string): boolean {
  const session = activeSessions.get(sessionId)
  const tmuxName = session?.tmuxName || sessionId
  try {
    execSync(`tmux send-keys -t ${JSON.stringify(tmuxName)} C-c 2>/dev/null`, { timeout: 5000 })
    console.log(`[session-manager] Sent interrupt (Ctrl+C) to session ${sessionId}`)
    return true
  } catch {
    console.log(`[session-manager] Failed to interrupt session ${sessionId} — tmux session may not exist`)
    return false
  }
}

export async function stopSession(sessionId: string): Promise<void> {
  const session = activeSessions.get(sessionId)
  if (session) {
    // Kill tmux session if it exists
    if (session.tmuxName) {
      try { execSync(`tmux kill-session -t ${JSON.stringify(session.tmuxName)} 2>/dev/null`, { timeout: 5000 }) } catch {}
    }
    // Legacy: kill child process if it exists
    if (session.process) {
      try { (session.stdin as any)?.end?.() } catch {}
      try { session.process.kill('SIGTERM') } catch {}
      setTimeout(() => {
        try { session.process!.kill('SIGKILL') } catch {}
      }, 3000)
    }
    // Record end on the account router
    if (session.accountId) {
      const { tokens, cost } = extractFinalUsage(session.jsonlPath)
      recordSessionEnd(session.accountId, sessionId, tokens, cost)
    }
    activeSessions.delete(sessionId)
    forgetSpawnClock(sessionId)
  }
}

/**
 * Epoch-ms start time of the CURRENT spawn for a session, or null if it isn't
 * tracked in-memory (e.g. before re-adoption after a restart). Reset to now on
 * every (re)spawn — including a follow-up resume — so it reflects the current
 * turn, NOT the objective's whole lifetime. The wall-clock watchdog needs this:
 * the transcript file's birthtime spans every resume, so using it force-routed a
 * freshly-resumed follow-up to review the instant it started on any objective
 * older than the wall-clock budget. (obj 1234 — 2026-06-22)
 *
 * Restart-durable since obj 705463: the in-memory map is wiped by a server
 * restart while the tmux session survives, so a rehydrate from the persisted
 * `session_spawns` row backs it up. Without that fallback the watchdog dropped
 * to the transcript birthtime and force-routed freshly-resumed sessions with
 * fake multi-day runtimes (702774/705254/705357).
 */
export function getSessionStartedAt(sessionId: string): number | null {
  const inMemoryMs = activeSessions.get(sessionId)?.startedAt ?? null
  let persistedMs: number | null = null
  if (!inMemoryMs) {
    try {
      persistedMs = getPersistedSpawnStart(getDb(), sessionId)
    } catch { /* DB unavailable → fall through to the caller's own fallback */ }
  }
  return resolveSpawnStartMs({ inMemoryMs, persistedMs })
}

export function getSessionState(sessionId: string): 'working' | 'review' | 'dead' {
  const session = activeSessions.get(sessionId)

  // ── tmux-based detection (primary) ──
  // Check tmux first — works even after server restarts since tmux persists
  const tmuxName = session?.tmuxName || sessionId
  const tmuxAlive = tmuxSessionAlive(tmuxName)

  if (tmuxAlive) {
    // tmux session alive — check JSONL for a result event (Claude may have
    // finished but tmux shell hasn't exited yet)
    const jsonlPath = session?.jsonlPath || path.join(TRANSCRIPT_DIR, `${sessionId}.jsonl`)
    // The verdict only depends on whether the LAST typed event is a `result`
    // (Claude finished but the tmux shell hasn't exited yet). Scan the transcript
    // tail from the end and stop at the first parseable typed event — O(1) per
    // call instead of re-reading + parsing the whole file every poll tick.
    try {
      const lines = readJsonlTail(jsonlPath).split('\n')
      for (let i = lines.length - 1; i >= 0; i--) {
        const trimmed = lines[i].trim()
        if (!trimmed) continue
        try {
          const event = JSON.parse(trimmed)
          if (event.type) return event.type === 'result' ? 'review' : 'working'
        } catch {}
      }
    } catch {}
    return 'working'
  }

  // tmux session dead — check if it completed (has result event) or crashed
  const jsonlPath = session?.jsonlPath || path.join(TRANSCRIPT_DIR, `${sessionId}.jsonl`)
  if (jsonlHasResult(jsonlPath)) return 'review'

  // ── Legacy fallback: check in-memory process ──
  if (session?.process) {
    try {
      process.kill(session.process.pid!, 0)
      return 'working'
    } catch {
      activeSessions.delete(sessionId)
      forgetSpawnClock(sessionId)
      return 'review'
    }
  }

  return 'dead'
}

export function listSessions(): string[] {
  return Array.from(activeSessions.keys())
}

/**
 * True when the session is allocated to an account and its process is alive —
 * regardless of whether it is mid-turn or idling between turns waiting on stdin.
 * `getSessionState` returning `working` OR `review` both mean the process is
 * up; only `dead` means the entry is a ghost (process gone, never cleaned up).
 *
 * We can't use a pure JSONL-only test, because a fresh session that hasn't
 * emitted any events yet would look the same as one whose process died before
 * its first turn. The Map+pid check is the authoritative signal.
 */
export function isSessionActive(sessionId: string): boolean {
  return getSessionState(sessionId) !== 'dead'
}
