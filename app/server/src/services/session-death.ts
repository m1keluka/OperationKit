/**
 * Session death handling — extracted from session-manager.ts (behavior frozen).
 * Auto-resume *functions* stay in session-manager (they call sendFollowUp);
 * the counters they share live here so handleSessionDeath can reset them.
 */
import fs from 'fs'
import { getDb } from '../db/index.js'
import {
  recordSessionEnd,
  recordRateLimit,
  recordAuthFailure,
  clearRateLimit,
  isRateLimitMessage,
  isAuthFailureMessage,
  isSpendCapMessage,
  parseResetTime,
} from './account-router.js'
import { queueExtraction } from './session-intel-pipeline.js'
import { extractFinalUsage } from './session-usage.js'
import { extractClaudeSessionId } from './session-jsonl.js'
import { activeSessions, forgetSpawnClock, spawnSegmentOffset } from './session-registry.js'
import { computeIsolation } from './session-worktree.js'
import { scanStreamTelemetry } from './session-telemetry.js'

function persistSessionRuntime(sessionId: string, jsonlPath: string, accountId: string | null): void {
  const claudeSessionId = extractClaudeSessionId(jsonlPath)
  if (!claudeSessionId) return
  try {
    getDb().prepare(
      `INSERT INTO session_runtime (session_id, claude_session_id, account_id, updated_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(session_id) DO UPDATE SET
         claude_session_id = excluded.claude_session_id,
         account_id = COALESCE(excluded.account_id, session_runtime.account_id),
         updated_at = excluded.updated_at`
    ).run(sessionId, claudeSessionId, accountId)
  } catch (err) {
    console.warn(`[session-manager] Failed to persist session_runtime for ${sessionId}:`, (err as Error).message)
  }
}

export interface SessionDeathResult {
  /** True when the death was caused by the account hitting a usage/spend limit. */
  limitHit: boolean
  /**
   * True when the limit was specifically a monthly/org spend cap (a strict
   * subset of limitHit). Unlike a recoverable rate limit, this does not clear
   * in hours — the caller must park for human/admin action rather than
   * auto-rotate or enqueue for the drain timer.
   */
  spendCapHit: boolean
  /**
   * True when the death was caused by an Anthropic "Overloaded" (HTTP 529)
   * response. This is a GLOBAL Anthropic capacity error, not a per-account
   * limit — rotating accounts is futile, so the caller retries the SAME session
   * after a backoff instead. (2026-06-22)
   */
  overloaded: boolean
  /**
   * True when the death was the per-spawn turn cap (`--max-turns`, SPAWN_MAX_TURNS)
   * firing on a session that was still making progress. NOT an error with the
   * work or the account — the ST3 runaway backstop simply clipped a long-but-
   * healthy session. The caller AUTO-CONTINUES the SAME session (claude --resume,
   * bounded by MAX_TURNS_AUTO_CONTINUE) instead of stranding it for a manual
   * Resume in `review`. Mutually exclusive in practice with limitHit/overloaded
   * (a max_turns result carries subtype `error_max_turns`, not a 429/529). (obj 1487)
   */
  turnsExhausted: boolean
}

/**
 * Pure predicate: is this parsed stream event a max_turns terminal exit?
 *
 * The Claude CLI emits a `result` event with subtype `error_max_turns` (and
 * result text like "Reached maximum number of turns (150)") when `--max-turns`
 * fires. We match three independent signals so a CLI shape change doesn't
 * silently regress detection:
 *   - the structured subtype `error_max_turns`,
 *   - a `terminal_reason` of `max_turns` (defensive — some builds surface it here),
 *   - the result/error text matching /maximum number of turns/i.
 * The loose text match is gated to terminal result/error events so it never
 * trips on assistant prose that merely discusses turn limits. Crucially this is
 * DISTINCT from the rate-limit / 401 / 529 detection — a max_turns result is not
 * an account problem and must never be misclassified as one. Pure + exported so
 * the detection is unit-testable. (obj 1487)
 */
export function isMaxTurnsResultEvent(event: unknown): boolean {
  if (!event || typeof event !== 'object') return false
  const e = event as Record<string, unknown>
  if (e.subtype === 'error_max_turns') return true
  if (e.terminal_reason === 'max_turns') return true
  if (e.type === 'result' || e.type === 'error') {
    const text =
      (typeof e.result === 'string' && e.result) ||
      (typeof e.error === 'string' && e.error) ||
      (typeof e.text === 'string' && e.text) ||
      ''
    return /maximum number of turns/i.test(text)
  }
  return false
}

/**
 * Pure: scan a set of JSONL lines (the current spawn segment's tail) for a
 * max_turns terminal exit. Fail-safe-open: malformed lines are skipped and a
 * non-array input returns false, so a parse/stat glitch can never wedge the
 * caller. (obj 1487)
 */
export function detectTurnsExhausted(lines: string[]): boolean {
  if (!Array.isArray(lines)) return false
  for (const line of lines) {
    try {
      if (isMaxTurnsResultEvent(JSON.parse(line))) return true
    } catch {}
  }
  return false
}

/**
 * Pure decision: should a session that exhausted its turn budget be auto-
 * continued, given how many times it already has been (`count`) and the bound
 * (`max`)? Continue only while strictly under a POSITIVE bound. A zero/negative/
 * NaN bound disables auto-continue gracefully (fail-safe-open → never loops).
 * Mirrors the runaway-caps.ts pure-function convention so it is unit-testable
 * without spawning anything. (obj 1487)
 */
export function decideTurnsContinue(input: { count: number; max: number }): { continue: boolean } {
  const { count, max } = input
  if (!(max > 0)) return { continue: false }
  if (!(count >= 0)) return { continue: false }
  return { continue: count < max }
}

export function handleSessionDeath(sessionId: string): SessionDeathResult {
  const session = activeSessions.get(sessionId)
  if (!session) return { limitHit: false, spendCapHit: false, overloaded: false, turnsExhausted: false }

  const { accountId, jsonlPath, logPath, objective } = session
  let limitHit = false
  let spendCapHit = false
  let overloaded = false
  let turnsExhausted = false

  // Capture the Claude CLI session id for native --resume follow-ups, and
  // scan the finished turn for refusal / fallback-model telemetry.
  try { persistSessionRuntime(sessionId, jsonlPath, accountId) } catch {}
  try { scanStreamTelemetry(sessionId, jsonlPath, logPath, session.requestedModel, objective.id, computeIsolation(objective, sessionId)) } catch {}

  // Check JSONL tail for rate-limit messages and mark the account accordingly.
  // The CLI prints "You've hit your limit · resets 6:50pm (UTC)" as a result/error
  // event right before exiting, so we scan the last few lines.
  // IMPORTANT: Only check error-type events — successful result events contain the
  // assistant's response text, which may discuss "rate limits" in normal conversation
  // (e.g. API docs) and trigger false positives.
  if (accountId) {
    try {
      // Only scan lines from the CURRENT spawn segment. Lines before the recorded
      // offset belong to a previous account (auto-resume appends to the same jsonl)
      // and were already attributed to that account on its own death — re-reading
      // them here would falsely bench the current account. Unknown offset (e.g. a
      // session re-adopted after a server restart) → fall back to the whole-file tail.
      const allLines = fs.readFileSync(jsonlPath, 'utf-8').split('\n').filter(l => l.trim())
      const segOffset = spawnSegmentOffset.get(sessionId)
      const tail = (segOffset != null ? allLines.slice(segOffset) : allLines).slice(-5)
      for (const line of tail) {
        try {
          const event = JSON.parse(line)
          // Only check events that indicate an actual rate limit, not normal output
          if (event.type === 'rate_limit_event' || event.type === 'rate_limit') {
            const info = event.rate_limit_info || event
            if (info.status && info.status.startsWith('allowed')) continue
            const resetTime = info.resetsAt ? new Date(info.resetsAt * 1000) : undefined
            recordRateLimit(accountId, resetTime, JSON.stringify(event).slice(0, 500))
            limitHit = true
            console.log(`[session-manager] Rate limit event detected on session death for ${sessionId}, account ${accountId}`)
            break
          }
          // Rate-limited exits arrive as result events with is_error=true but
          // subtype "success" (api_error_status 429, result "You've hit your
          // limit · resets …"), so match any errored result — not just
          // subtype === 'error'. The is_error gate keeps the false-positive
          // protection: successful assistant text never sets it.
          if (event.type === 'error' || (event.type === 'result' && (event.subtype === 'error' || event.is_error))) {
            const errorsText = Array.isArray(event.errors) ? event.errors.filter(Boolean).join('; ') : ''
            const text = event.error || event.result || event.text || errorsText
            if (event.api_error_status === 429 || (text && isRateLimitMessage(text))) {
              const resetTime = text ? parseResetTime(text) : null
              recordRateLimit(accountId, resetTime || undefined, text || `HTTP ${event.api_error_status}`)
              limitHit = true
              if (text && isSpendCapMessage(text)) {
                spendCapHit = true
                console.log(`[session-manager] Spend-cap (monthly/org) detected on session death for ${sessionId}, account ${accountId} — will park for admin action`)
              } else {
                console.log(`[session-manager] Rate limit detected on session death for ${sessionId}, account ${accountId}`)
              }
              break
            }
            // HTTP 401 authentication_failed: the account's credential is invalid/
            // expired, so EVERY spawn on it instantly 401s with 0 tokens / 0 tool
            // calls. Untreated, the poller's classifyNoOpSpawn (which has no exit-
            // reason input) reads that as a benign no-op and re-spawns it — and
            // delegator/child-complete wakes re-queue past MAX_NOOP_RESPAWNS — so a
            // single ~3h credential outage burned ~100 empty sessions across 16
            // objectives on 2026-06-20 (obj 762 reached session_count=57). A 401 is
            // a credential problem like a 429 is a quota problem, so we bench the
            // account the same way: pickAccount() rotates away, and when no valid
            // credential remains the objective auto-pauses via the existing all-
            // accounts-limited path instead of storming. (The default ~5h bench
            // self-heals once the key is rotated; a 401 that outlives it re-benches
            // on the next death rather than re-entering the no-op respawn loop.)
            if (event.api_error_status === 401 || (text && isAuthFailureMessage(text))) {
              // A 401 is a CREDENTIAL problem, not quota — record it as an auth
              // failure so the slot is parked as "reconnect needed" (permanent
              // until re-login) instead of a fake 5h rate-limit that re-benches
              // in a loop on every subsequent 401. `limitHit` still fires so the
              // caller rotates away / auto-pauses via the all-accounts-down path.
              recordAuthFailure(accountId, text || `HTTP 401 authentication_failed`)
              limitHit = true
              console.error(`[session-manager] 401 auth failure on session death for ${sessionId}, account ${accountId} — parked as reconnect-needed (re-login required)`)
              break
            }
            // Anthropic "Overloaded" (HTTP 529): a transient GLOBAL capacity error,
            // NOT a per-account limit, so we do NOT bench the account (rotation is
            // futile — every account hits the same overloaded API). The caller
            // retries this same session after a backoff instead.
            if (event.api_error_status === 529 || (text && /overloaded/i.test(text))) {
              overloaded = true
              console.log(`[session-manager] Anthropic overload (529) detected on session death for ${sessionId}, account ${accountId}`)
              break
            }
          }
        } catch {}
      }
    } catch {}
  }

  // Max-turns terminal exit (ST3 `--max-turns` backstop fired on a still-
  // productive session). Detected independently of accountId and of the rate-
  // limit scan above — it is NOT an account/quota problem — over the SAME
  // current-spawn-segment tail (so a prior spawn's events aren't reconsidered).
  // Fail-safe-open: any read/parse error leaves turnsExhausted false, so the
  // session simply routes to review as before rather than wedging the poller.
  try {
    const allLines = fs.readFileSync(jsonlPath, 'utf-8').split('\n').filter(l => l.trim())
    const segOffset = spawnSegmentOffset.get(sessionId)
    const tail = (segOffset != null ? allLines.slice(segOffset) : allLines).slice(-5)
    turnsExhausted = detectTurnsExhausted(tail)
    if (turnsExhausted) {
      console.log(`[session-manager] max_turns terminal exit detected on session death for ${sessionId} — eligible for bounded auto-continue`)
    }
  } catch {}

  // Release the account slot
  if (accountId) {
    const { tokens, cost } = extractFinalUsage(jsonlPath)
    recordSessionEnd(accountId, sessionId, tokens, cost)
    // Live-success liveness signal: a turn that completed with real token usage
    // and was NOT rejected proves the account is currently serving traffic, so
    // clear any stale rate-limit flag (e.g. a 5h fallback set while this session
    // ran fine). A genuinely-limited account would have errored (limitHit), not
    // produced usage — so this can't un-bench a truly exhausted account.
    if (!limitHit && tokens > 0) clearRateLimit(accountId)
  }

  // Auto-trigger session intel extraction (Phase A deterministic + Phase B LLM
  // summary). Without this hook the extraction queue only ever drained from the
  // startup re-queue path, leaving session_intel + activity feed stale until the
  // server restarted. Idempotent: drainQueue dedupes by session_id internally.
  try {
    queueExtraction(objective.id, sessionId, jsonlPath, accountId, objective)
  } catch (err) {
    console.error(`[session-manager] queueExtraction failed for ${sessionId}:`, err)
  }

  activeSessions.delete(sessionId)
  forgetSpawnClock(sessionId)
  // Drop the spawn-segment offset; an auto-resume respawn re-records a fresh one.
  spawnSegmentOffset.delete(sessionId)
  // A clean (non-limit) death means the session completed a turn / made progress,
  // so reset the consecutive-limit-rotation breaker: a later limit starts from zero.
  if (!limitHit) autoResumeCounts.delete(sessionId)
  // Likewise reset the 529 retry breaker on any turn that wasn't an overload —
  // Anthropic served us, so a later overload starts its backoff budget fresh.
  if (!overloaded) overloadRetryCounts.delete(sessionId)
  // Reset the max-turns auto-continue breaker on any death that WASN'T a turns
  // exhaustion — a turn that ended cleanly (or for any other reason) proves the
  // session is progressing, so a later max_turns starts its continue budget
  // fresh. Only consecutive max_turns deaths accumulate toward the bound.
  if (!turnsExhausted) turnsContinueCounts.delete(sessionId)
  return { limitHit, spendCapHit, overloaded, turnsExhausted }
}

export const autoResumeCounts = new Map<string, number>()
export const overloadRetryCounts = new Map<string, number>()
export const overloadRetryPending = new Set<string>()
export const turnsContinueCounts = new Map<string, number>()
