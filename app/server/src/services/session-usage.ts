/**
 * Transcript usage math — extracted from session-manager.ts (behavior frozen).
 *
 * Stream-json emits one `result` per Claude turn (per-turn usage, not
 * cumulative). Codex emits `turn.completed`. Reading only the last event
 * undercounts a multi-turn session (dashboard $5.38-instead-of-$112).
 */
import fs from 'fs'
import path from 'path'
import { getDb } from '../db/index.js'
import { TRANSCRIPT_DIR } from '../config.js'

/**
 * Sum token count and cost across every `result` event in a jsonl file.
 *
 * Stream-json emits one `result` per agent turn; each carries that turn's own
 * `usage.{input,output,cache_read_input,cache_creation_input}_tokens` and
 * `total_cost_usd` (per-turn, not cumulative). Reading only the last event
 * undercounts a 32-turn session by ~32×, which is what produced the
 * dashboard's $5.38-instead-of-$112 symptom.
 */
export function extractFinalUsage(jsonlPath: string): { tokens: number; cost: number } {
  try {
    return sumResultEventsFromContent(fs.readFileSync(jsonlPath, 'utf-8'))
  } catch {
    return { tokens: 0, cost: 0 }
  }
}

export function sumResultEventsFromContent(content: string): { tokens: number; cost: number } {
  let tokens = 0
  let cost = 0
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const event = JSON.parse(trimmed)
      if (event.type === 'result') {
        const u = extractUsageFromResultEvent(event)
        tokens += u.tokens
        cost += u.cost
      } else if (event.type === 'turn.completed' && event.usage) {
        // Codex engine: one `turn.completed` per turn with per-turn usage.
        // cached_input_tokens / reasoning_output_tokens are subsets of
        // input/output — don't double-count. Cost stays 0 (ChatGPT subscription).
        tokens += (event.usage.input_tokens || 0) + (event.usage.output_tokens || 0)
      }
    } catch {}
  }
  return { tokens, cost }
}

export function extractUsageFromResultEvent(event: Record<string, unknown>): { tokens: number; cost: number } {
  const usage = (event.usage as Record<string, unknown> | undefined) || {}
  const tokens =
    ((usage.input_tokens as number) || 0) +
    ((usage.output_tokens as number) || 0) +
    ((usage.cache_read_input_tokens as number) || 0) +
    ((usage.cache_creation_input_tokens as number) || 0)
  const cost = (event.total_cost_usd as number) || 0
  return { tokens, cost }
}

/**
 * Cached listing of the transcript dir, shared across computeObjectiveSpend
 * calls. That function runs for EVERY active objective on EVERY poll tick, and
 * each call previously did its own fs.readdirSync(TRANSCRIPT_DIR) over ~30k
 * files — so a single tick issued dozens of 30k-entry directory scans and
 * blacked out the single-threaded event loop (2026-08-17 accept-starvation
 * incident). The listing only changes when a session starts, so a short TTL
 * lets every objective in a tick share ONE readdir while a just-created
 * transcript is still picked up on the next tick.
 */
let transcriptListCache: { at: number; files: string[] } | null = null
export const TRANSCRIPT_LIST_TTL_MS = 5_000
export function listTranscriptJsonl(): string[] {
  const now = Date.now()
  if (transcriptListCache && now - transcriptListCache.at < TRANSCRIPT_LIST_TTL_MS) {
    return transcriptListCache.files
  }
  let files: string[] = []
  try {
    files = fs.readdirSync(TRANSCRIPT_DIR).filter((f) => f.endsWith('.jsonl'))
  } catch {
    files = []
  }
  transcriptListCache = { at: now, files }
  return files
}
/** Test-only: clear the transcript-listing cache between cases. */
export function __resetTranscriptListCache(): void {
  transcriptListCache = null
}

/**
 * Cumulative spend (USD) for an objective across ALL its sessions: work
 * sessions, bounce re-work turns, planner and reviewer sessions.
 *
 * Source of truth is `session_intel.total_cost_usd` (one row per extracted
 * session, summed from result events). Extraction is async, so sessions that
 * just ended — typically the reviewer whose verdict we're acting on — may not
 * have an intel row yet; for those we parse the JSONL directly. Session ids
 * are deterministic (`cc-{id}-*`, `cc-plan-{id}-*`, `cc-review-{id}-*`), so a
 * transcript-dir scan catches every session even after server restarts.
 *
 * NOT the same as `objectives.total_cost_usd`: that accumulator double-counts
 * on follow-up respawns (each extraction re-adds the cumulative JSONL total).
 */
export function computeObjectiveSpend(objectiveId: number): number {
  let spend = 0
  const known = new Set<string>()
  try {
    const rows = getDb()
      .prepare('SELECT session_id, total_cost_usd FROM session_intel WHERE objective_id = ?')
      .all(objectiveId) as { session_id: string; total_cost_usd: number }[]
    for (const r of rows) {
      spend += r.total_cost_usd || 0
      known.add(r.session_id)
    }
  } catch (err) {
    console.warn(`[session-manager] computeObjectiveSpend: intel query failed for obj ${objectiveId}:`, (err as Error).message)
  }
  try {
    const prefixes = [`cc-${objectiveId}-`, `cc-plan-${objectiveId}-`, `cc-review-${objectiveId}-`]
    for (const f of listTranscriptJsonl()) {
      const sid = f.slice(0, -'.jsonl'.length)
      if (known.has(sid) || !prefixes.some(p => sid.startsWith(p))) continue
      spend += extractFinalUsage(path.join(TRANSCRIPT_DIR, f)).cost
      known.add(sid)
    }
  } catch {}
  return spend
}

/**
 * Re-parse the jsonl for a given session and return its recorded usage. Used by
 * account-router's reconcileFromHistory to backfill correct tokens/cost on a
 * restart (since the prior `extractFinalUsage` always returned 0 tokens).
 */
export function extractUsageForSessionId(sessionId: string): { tokens: number; cost: number } {
  const jsonlPath = path.join(TRANSCRIPT_DIR, `${sessionId}.jsonl`)
  return extractFinalUsage(jsonlPath)
}
