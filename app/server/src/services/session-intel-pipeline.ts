/**
 * Session-intel extraction queue, pipeline, queries, and usage backfill —
 * extracted from session-intel.ts (behavior frozen).
 *
 * Parse lives in session-intel-parse.ts; LLM summary in session-intel-summary.ts.
 */
import fs from 'fs'
import path from 'path'
import { getDb } from '../db/index.js'
import { broadcast } from '../ws/index.js'
import { logActivity } from '../routes/feed.js'
import { wakeDelegator } from './delegation.js'
import type { Objective, SessionIntel } from '@command-center/shared'
import { extractDeterministic } from './session-intel-parse.js'
import { generateSummary } from './session-intel-summary.js'

// ── Extraction Queue ──

interface QueueItem {
  objectiveId: number
  sessionId: string
  jsonlPath: string
  accountId: string | null
  objective: Objective
}

const extractionQueue: QueueItem[] = []
let drainTimer: ReturnType<typeof setInterval> | null = null

/**
 * Should this session be flagged as a vault capture gap? Pure, no I/O.
 * A gap = at least one extracted "decision" AND no second-brain/.../decisions/*.md
 * AND the objective is NOT a recurring scheduled job (`routine_id` set).
 * Recurring jobs over-extract their own task description into decisions[].
 */
export function isCaptureGap(
  decisionCount: number,
  routineId: number | null | undefined,
  filesTouched: string[],
): boolean {
  if (decisionCount <= 0) return false
  if (routineId != null) return false
  return !filesTouched.some(f => /(?:^|\/)second-brain\/.*\/decisions\/[^/]+\.md$/.test(f))
}

export function queueExtraction(
  objectiveId: number,
  sessionId: string,
  jsonlPath: string,
  accountId: string | null,
  objective: Objective
): void {
  extractionQueue.push({ objectiveId, sessionId, jsonlPath, accountId, objective })
  if (!drainTimer) {
    drainTimer = setInterval(drainQueue, 2000)
  }
}

async function drainQueue(): Promise<void> {
  if (extractionQueue.length === 0) {
    if (drainTimer) {
      clearInterval(drainTimer)
      drainTimer = null
    }
    return
  }

  const item = extractionQueue.shift()!
  try {
    await processExtraction(item)
  } catch (err) {
    console.error(`[session-intel] Extraction failed for ${item.sessionId}:`, err)
  }
}

// ── Main Processing Pipeline ──

async function processExtraction(item: QueueItem): Promise<void> {
  const { objectiveId, sessionId, jsonlPath, accountId, objective } = item
  const db = getDb()

  // Phase A: Deterministic extraction
  const intel = await extractDeterministic(jsonlPath)

  const endedAt = intel.endedAt || new Date().toISOString()

  // Insert initial session_intel row
  db.prepare(`
    INSERT OR REPLACE INTO session_intel
    (objective_id, session_id, account_id, started_at, ended_at, duration_ms,
     total_tokens, total_cost_usd, files_created, files_modified, commands_run,
     tool_calls, errors, exit_code, skills_used, agents_invoked, subagents_spawned,
     model_usage, extraction_status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'parsed')
  `).run(
    objectiveId, sessionId, accountId,
    intel.startedAt || new Date().toISOString(),
    endedAt,
    intel.durationMs,
    intel.totalTokens, intel.totalCost,
    JSON.stringify(intel.filesCreated),
    JSON.stringify(intel.filesModified),
    intel.commandsRun, intel.toolCalls,
    JSON.stringify(intel.errors),
    intel.exitCode,
    JSON.stringify(intel.skillsUsed),
    JSON.stringify(intel.agentsInvoked),
    JSON.stringify(intel.subagentsSpawned),
    JSON.stringify(intel.modelUsage),
  )

  // Keep the denormalized objectives.last_activity_at fresh (obj 700850). This is
  // the same code path that writes the session_intel row, so the board's recency
  // marker advances the moment a session's intel lands. Forward-only: the guard
  // never moves it backwards (a re-extraction of an older session, or an
  // out-of-order arrival, must not regress a newer timestamp).
  db.prepare(`
    UPDATE objectives
       SET last_activity_at = ?
     WHERE id = ?
       AND (last_activity_at IS NULL OR last_activity_at < ?)
  `).run(endedAt, objectiveId, endedAt)

  // Per-day usage attribution — DELETE+reinsert so re-extraction is idempotent
  // (matches INSERT OR REPLACE on session_intel above).
  const insDaily = db.prepare(
    'INSERT INTO session_usage_daily (session_id, day, model, account_id, objective_id, cost_usd, tokens) VALUES (?, ?, ?, ?, ?, ?, ?)'
  )
  db.transaction(() => {
    db.prepare('DELETE FROM session_usage_daily WHERE session_id = ?').run(sessionId)
    for (const d of intel.dailyUsage) {
      insDaily.run(sessionId, d.day, d.model, accountId, objectiveId, d.cost_usd, d.tokens)
    }
  })()

  // Insert file operations
  const insertFileOp = db.prepare(
    'INSERT INTO session_file_ops (session_id, objective_id, file_path, operation, timestamp) VALUES (?, ?, ?, ?, ?)'
  )
  const now = new Date().toISOString()
  const fileOpTransaction = db.transaction(() => {
    for (const f of intel.filesCreated) {
      insertFileOp.run(sessionId, objectiveId, f, 'create', now)
    }
    for (const f of intel.filesModified) {
      insertFileOp.run(sessionId, objectiveId, f, 'modify', now)
    }
  })
  fileOpTransaction()

  // Update objective aggregate stats
  db.prepare(`
    UPDATE objectives SET
      session_count = session_count + 1,
      total_cost_usd = total_cost_usd + ?,
      total_tokens = total_tokens + ?,
      updated_at = datetime('now')
    WHERE id = ?
  `).run(intel.totalCost, intel.totalTokens, objectiveId)

  console.log(`[session-intel] Parsed ${sessionId}: ${intel.toolCalls} tools, ${intel.filesCreated.length} created, ${intel.filesModified.length} modified, ${intel.errors.length} errors`)

  // Phase B: LLM summary (async, non-blocking)
  // Skip summarization for empty/trivial sessions to save API costs.
  // Sessions with 0 tool calls did nothing useful — no point summarizing.
  if (intel.toolCalls === 0 && intel.filesCreated.length === 0 && intel.filesModified.length === 0) {
    if (intel.truncatedByUsageLimit) {
      // A 429 on turn 1 produces 0 tool calls — this is an exhausted-account
      // spawn, NOT an idle worker. Record it truthfully instead of stamping
      // the fabricated "produced no output" failure. extraction_status stays
      // 'summarized' (its CHECK constraint forbids new enum values); the
      // truncation is flagged on the dedicated truncated_usage_limit column.
      console.log(`[session-intel] ${sessionId}: 0 tool calls due to a 429 usage-limit truncation — recording truthfully`)
      db.prepare("UPDATE session_intel SET extraction_status = 'summarized', outcome = 'blocked', truncated_usage_limit = 1, summary = 'Session truncated by a Claude API 429 (usage/rate limit) before any tool call. NOT a work failure — re-run when account quota resets.' WHERE session_id = ?").run(sessionId)
      return
    }
    console.log(`[session-intel] Skipping LLM summary for ${sessionId}: no tool calls or file changes`)
    db.prepare("UPDATE session_intel SET extraction_status = 'summarized', outcome = 'failed', summary = 'Session produced no output (0 tool calls)' WHERE session_id = ?").run(sessionId)

    return
  }

  // Mid-run 429 truncation (the session DID make tool calls before the limit
  // hit — e.g. a reviewer that Read the deliverable, then got killed). Do NOT
  // summarize the truncated transcript: the LLM fabricates a "deliverable
  // missing" content reason that contradicts the tools the session actually
  // ran. Record the truth and skip both the LLM call and the capture-gap
  // detector (which lives inside the `if (summary)` block below).
  if (intel.truncatedByUsageLimit) {
    const truthful = 'Session truncated mid-run by a Claude API 429 (usage/rate limit). The transcript is incomplete; this is NOT a judgment that the deliverable is missing or the work failed. Disposition: RE-REVIEW / re-run after quota reset.'
    console.log(`[session-intel] ${sessionId}: truncated by a 429 usage limit mid-run — recording truthfully, skipping LLM summary`)
    db.prepare(`
      UPDATE session_intel SET
        summary = ?, decisions = '[]', blockers = '[]', follow_ups = '[]',
        outcome = 'blocked', truncated_usage_limit = 1, extraction_status = 'summarized'
      WHERE session_id = ?
    `).run(truthful, sessionId)
    db.prepare(`
      UPDATE objectives SET last_session_summary = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(truthful, objectiveId)
    return
  }

  const isReviewSession = sessionId.startsWith('cc-review-')
  let reviewVerdict: 'pass' | 'fail' | 'blocked' | null = null
  if (isReviewSession) {
    const v = db.prepare(
      'SELECT verdict FROM objective_reviews WHERE objective_id = ? ORDER BY iteration DESC LIMIT 1'
    ).get(objectiveId) as { verdict?: string } | undefined
    if (v?.verdict === 'pass' || v?.verdict === 'fail' || v?.verdict === 'blocked') reviewVerdict = v.verdict
  }
  const isDelegatorSession = !isReviewSession && !!objective.delegate_mode
  const summary = await generateSummary(intel, objective, isReviewSession, reviewVerdict, isDelegatorSession)

  if (summary) {
    db.prepare(`
      UPDATE session_intel SET
        summary = ?,
        decisions = ?,
        blockers = ?,
        follow_ups = ?,
        outcome = ?,
        extraction_status = 'summarized'
      WHERE session_id = ?
    `).run(
      summary.summary,
      JSON.stringify(summary.decisions),
      JSON.stringify(summary.blockers),
      JSON.stringify(summary.follow_ups),
      summary.outcome,
      sessionId,
    )

    // Update objective with summary and blocker status
    const hasBlockers = summary.blockers.length > 0 ? 1 : 0
    db.prepare(`
      UPDATE objectives SET
        last_session_summary = ?,
        has_blockers = ?,
        updated_at = datetime('now')
      WHERE id = ?
    `).run(summary.summary, hasBlockers, objectiveId)

    // Insert session events
    const insertEvent = db.prepare(
      'INSERT INTO session_events (session_id, objective_id, event_type, description, metadata) VALUES (?, ?, ?, ?, ?)'
    )
    const eventTransaction = db.transaction(() => {
      for (const d of summary.decisions) {
        insertEvent.run(sessionId, objectiveId, 'decision', d.decision, JSON.stringify({ rationale: d.rationale }))
      }
      for (const b of summary.blockers) {
        insertEvent.run(sessionId, objectiveId, 'blocker', b.description, JSON.stringify({ severity: b.severity }))
      }
      for (const f of summary.follow_ups) {
        insertEvent.run(sessionId, objectiveId, 'follow_up', f.task, JSON.stringify({ priority: f.priority, context: f.context }))
      }
    })
    eventTransaction()

    // Capture-gap detector. Read routine_id from the DB: the re-queue path
    // builds a PARTIAL objective literal that omits it.
    const jobMarker = db.prepare('SELECT routine_id FROM objectives WHERE id = ?')
      .get(objectiveId) as { routine_id?: number | null } | undefined
    if (isCaptureGap(summary.decisions.length, jobMarker?.routine_id, [...intel.filesCreated, ...intel.filesModified])) {
      db.prepare(
        'INSERT INTO session_events (session_id, objective_id, event_type, description, metadata) VALUES (?, ?, ?, ?, ?)'
      ).run(
        sessionId,
        objectiveId,
        'milestone',
        `capture_gap: ${summary.decisions.length} decision(s) claimed, no vault doc written`,
        JSON.stringify({
          kind: 'capture_gap',
          decision_count: summary.decisions.length,
          decisions: summary.decisions.map(d => d.decision),
        }),
      )
      console.warn(`[session-intel] capture_gap on ${sessionId}: ${summary.decisions.length} decisions claimed, no second-brain decision file written`)
      if (objective.project) {
        logActivity({
          project: objective.project,
          workspace: objective.workspace,
          objective_id: objectiveId,
          session_id: sessionId,
          event_type: 'milestone',
          title: `Capture gap: ${summary.decisions.length} decision(s) claimed, no vault write`,
          detail: summary.decisions.map(d => `• ${d.decision}`).join('\n').slice(0, 500),
          metadata: { kind: 'capture_gap', decision_count: summary.decisions.length },
        })
      }
    }

    console.log(`[session-intel] Summarized ${sessionId}: "${summary.summary.slice(0, 80)}..."`)
  } else {
    // Mark as parsed-only (no summary available)
    console.log(`[session-intel] No LLM summary for ${sessionId} (Anthropic API unavailable or failed)`)
  }

  // Broadcast intel ready
  const intelRow = db.prepare('SELECT * FROM session_intel WHERE session_id = ?').get(sessionId) as Record<string, unknown> | undefined
  if (intelRow) {
    const parsed = deserializeIntel(intelRow)
    broadcast({ type: 'session_intel_ready', payload: { objective_id: objectiveId, intel: parsed } })

    // Also broadcast updated objective so UI refreshes
    const updatedObjective = db.prepare('SELECT * FROM objectives WHERE id = ?').get(objectiveId)
    if (updatedObjective) {
      broadcast({ type: 'objective_updated', payload: updatedObjective as unknown as import('@command-center/shared').Objective })
    }
  }

  // Delegator wake-on-completion: if this objective is a worker of a delegator,
  // record its result in the delegator's NOTES.md and nudge the delegator to
  // continue. The summary + blocker status are persisted by this point, so the
  // delegator wakes with complete information instead of polling for it.
  try {
    const child = db.prepare('SELECT * FROM objectives WHERE id = ?').get(objectiveId) as Objective | undefined
    if (child?.parent_id) {
      wakeDelegator(child.parent_id, child)
    }
  } catch (err) {
    console.warn(`[session-intel] delegator wake hook failed for objective ${objectiveId}:`, (err as Error).message)
  }

  // Log session_end to activity feed
  if (objective.project) {
    const outcome = summary?.outcome || (intel.exitCode === 0 ? 'success' : 'failed')
    logActivity({
      project: objective.project,
      workspace: objective.workspace,
      objective_id: objectiveId,
      session_id: sessionId,
      event_type: 'session_end',
      title: `Session ${outcome}: ${objective.title}`,
      detail: summary?.summary?.slice(0, 500) || null,
      metadata: {
        outcome,
        duration_ms: intel.durationMs,
        files_created: intel.filesCreated.length,
        files_modified: intel.filesModified.length,
        tool_calls: intel.toolCalls,
        cost_usd: intel.totalCost,
      },
    })

    // Log decisions as separate activity events
    if (summary?.decisions) {
      for (const d of summary.decisions.slice(0, 5)) {
        logActivity({
          project: objective.project,
          workspace: objective.workspace,
          objective_id: objectiveId,
          session_id: sessionId,
          event_type: 'decision',
          title: d.decision,
          detail: d.rationale,
        })
      }
    }

    // Log blockers
    if (summary?.blockers) {
      for (const b of summary.blockers) {
        logActivity({
          project: objective.project,
          workspace: objective.workspace,
          objective_id: objectiveId,
          session_id: sessionId,
          event_type: 'blocker',
          title: b.description,
          metadata: { severity: b.severity },
        })
      }
    }
  }

}

// ── Utilities ──

export function deserializeIntel(row: Record<string, unknown>): SessionIntel {
  return {
    ...row,
    files_created: JSON.parse((row.files_created as string) || '[]'),
    files_modified: JSON.parse((row.files_modified as string) || '[]'),
    errors: JSON.parse((row.errors as string) || '[]'),
    decisions: JSON.parse((row.decisions as string) || '[]'),
    blockers: JSON.parse((row.blockers as string) || '[]'),
    follow_ups: JSON.parse((row.follow_ups as string) || '[]'),
    skills_used: JSON.parse((row.skills_used as string) || '[]'),
    agents_invoked: JSON.parse((row.agents_invoked as string) || '[]'),
    subagents_spawned: JSON.parse((row.subagents_spawned as string) || '[]'),
    model_usage: JSON.parse((row.model_usage as string) || '{}'),
  } as SessionIntel
}

export function getIntelForObjective(objectiveId: number): SessionIntel[] {
  const db = getDb()
  const rows = db.prepare(
    'SELECT * FROM session_intel WHERE objective_id = ? ORDER BY ended_at DESC'
  ).all(objectiveId) as Record<string, unknown>[]
  return rows.map(deserializeIntel)
}

export function getRecentIntel(limit: number = 20): (SessionIntel & { objective_title: string; agent_context: string })[] {
  const db = getDb()
  const rows = db.prepare(`
    SELECT si.*, o.title as objective_title, o.agent_context
    FROM session_intel si
    JOIN objectives o ON si.objective_id = o.id
    WHERE si.extraction_status IN ('parsed', 'summarized')
    ORDER BY si.ended_at DESC
    LIMIT ?
  `).all(limit) as Record<string, unknown>[]
  return rows.map(r => ({
    ...deserializeIntel(r),
    objective_title: r.objective_title as string,
    agent_context: r.agent_context as string,
  }))
}

export function getActiveBlockers(): { blocker: string; severity: string; objective_id: number; objective_title: string; session_id: string }[] {
  const db = getDb()
  const rows = db.prepare(`
    SELECT si.blockers, si.objective_id, si.session_id, o.title as objective_title
    FROM session_intel si
    JOIN objectives o ON si.objective_id = o.id
    WHERE si.blockers != '[]' AND o.status != 'done'
      AND si.session_id NOT LIKE 'cc-review-%'
    ORDER BY si.ended_at DESC
  `).all() as Record<string, unknown>[]

  const result: { blocker: string; severity: string; objective_id: number; objective_title: string; session_id: string }[] = []
  for (const row of rows) {
    const blockers = JSON.parse((row.blockers as string) || '[]') as { description: string; severity: string }[]
    for (const b of blockers) {
      result.push({
        blocker: b.description,
        severity: b.severity,
        objective_id: row.objective_id as number,
        objective_title: row.objective_title as string,
        session_id: row.session_id as string,
      })
    }
  }
  return result
}

export function getFileConflicts(): { file_path: string; session_count: number; sessions: string }[] {
  const db = getDb()
  return db.prepare(`
    SELECT file_path, COUNT(DISTINCT session_id) as session_count,
           GROUP_CONCAT(DISTINCT session_id) as sessions
    FROM session_file_ops
    WHERE operation IN ('create', 'modify')
      AND timestamp > datetime('now', '-24 hours')
    GROUP BY file_path
    HAVING session_count > 1
    ORDER BY session_count DESC
  `).all() as { file_path: string; session_count: number; sessions: string }[]
}

// ── Startup Backlog Re-queue ──

// Re-queue sessions stuck at 'parsed' that never got LLM summarization.
// Called on server startup (full) + on an interval (incremental) — runs async,
// never blocks the HTTP listener.
/**
 * Idempotent rebuild of session_usage_daily from EVERY cc-* transcript on disk.
 *
 * This is the authoritative cost ledger. It does NOT key off session_intel —
 * that table only ever covered the sessions the end-of-session extraction hook
 * happened to catch (~127 of ~1,450 transcripts: the hook is recent, and
 * multi-invocation objectives spawn many transcripts that never each get their
 * own intel row). Scanning the transcript dir directly is the only way to count
 * the full ~$12k of subscription-account usage instead of the ~$2k subset.
 *
 * Each `result`/`turn.completed` event carries a globally-unique `uuid`, and the
 * cost per turn (`total_cost_usd`) equals the sum of its per-model `modelUsage`
 * (subagents included). No turn appears in two transcripts, so summing every
 * transcript — keyed by full session_id (DELETE+reinsert) — never double-counts.
 *
 * account_id / objective_id aren't in the transcript: resolved from session_intel
 * when known (forward sessions record account on end), else objective_id is parsed
 * from the `cc-<N>` stem and account falls back to NULL ('unknown' in rollups).
 * Cost/token TOTALS are correct regardless of account attribution.
 *
 * @param opts.sinceMs  when set, only (re)process transcripts whose file mtime is
 *                      within the last `sinceMs` ms — the cheap incremental sweep
 *                      that keeps active/recent sessions current without re-reading
 *                      every transcript each tick.
 */
export async function backfillDailyUsage(opts: { sinceMs?: number } = {}): Promise<{ sessions: number; rows: number }> {
  const db = getDb()
  const TRANSCRIPT_DIR = '/home/operator/transcripts'
  // Yield the event loop every YIELD_EVERY files so a full scan (~13k transcripts,
  // each read+parsed synchronously) can never monopolize the single-threaded loop
  // and blackhole HTTP (2026-08-13 incident). setImmediate lets pending I/O —
  // including new HTTP connections — run between batches.
  const YIELD_EVERY = 100
  const yieldLoop = () => new Promise<void>((resolve) => setImmediate(resolve))

  // account_id / objective_id live in CC's own records, not the transcript.
  const known = new Map<string, { account_id: string | null; objective_id: number | null }>()
  for (const r of db.prepare(
    'SELECT session_id, account_id, objective_id FROM session_intel'
  ).all() as Array<{ session_id: string; account_id: string | null; objective_id: number | null }>) {
    known.set(r.session_id, { account_id: r.account_id, objective_id: r.objective_id })
  }

  // Manual account attribution fallback for sessions whose real account was never
  // recorded (see session_account_override). Applied only when session_intel
  // doesn't already know the account, so a recovered real value always wins.
  const override = new Map<string, string>()
  for (const r of db.prepare(
    'SELECT session_id, account_id FROM session_account_override'
  ).all() as Array<{ session_id: string; account_id: string }>) {
    override.set(r.session_id, r.account_id)
  }

  // Incremental boot scan (2026-08-13): the full scan re-parses ~8GB of transcripts
  // on EVERY restart, pegging a core for minutes. On boot we only need to FILL GAPS
  // — sessions the end-of-session hook missed — not re-attribute the whole ledger.
  // So skip session_ids already present in session_usage_daily. The 15-min sinceMs
  // sweep still re-verifies recently-active sessions (account overrides, late turns).
  // First boot on an empty ledger still does the full scan.
  const alreadyAttributed = new Set<string>()
  if (!opts.sinceMs) {
    for (const r of db.prepare(
      'SELECT DISTINCT session_id FROM session_usage_daily'
    ).all() as Array<{ session_id: string }>) {
      alreadyAttributed.add(r.session_id)
    }
  }

  let files: string[]
  try {
    files = fs.readdirSync(TRANSCRIPT_DIR).filter((f) => f.startsWith('cc-') && f.endsWith('.jsonl'))
  } catch {
    return { sessions: 0, rows: 0 }
  }

  const cutoff = opts.sinceMs ? Date.now() - opts.sinceMs : 0
  const insDaily = db.prepare(
    'INSERT INTO session_usage_daily (session_id, day, model, account_id, objective_id, cost_usd, tokens) VALUES (?, ?, ?, ?, ?, ?, ?)'
  )
  const delDaily = db.prepare('DELETE FROM session_usage_daily WHERE session_id = ?')

  let done = 0
  let rows = 0
  let scanned = 0
  for (const f of files) {
    if (++scanned % YIELD_EVERY === 0) await yieldLoop()
    const full = path.join(TRANSCRIPT_DIR, f)
    if (cutoff) {
      try { if (fs.statSync(full).mtimeMs < cutoff) continue } catch { continue }
    }
    const sessionId = f.slice(0, -'.jsonl'.length)
    if (alreadyAttributed.has(sessionId)) continue // already in the ledger — skip the expensive re-parse
    let intel
    try { intel = await extractDeterministic(full) } catch { continue }
    if (intel.dailyUsage.length === 0) continue // no paid turns — nothing to attribute
    const k = known.get(sessionId)
    const stem = sessionId.match(/^cc-(\d+)/)
    const objectiveId = k?.objective_id ?? (stem ? Number(stem[1]) : null)
    const accountId = k?.account_id ?? override.get(sessionId) ?? null
    db.transaction(() => {
      delDaily.run(sessionId)
      for (const d of intel.dailyUsage) {
        insDaily.run(sessionId, d.day, d.model, accountId, objectiveId, d.cost_usd, d.tokens)
      }
    })()
    done++; rows += intel.dailyUsage.length
  }
  const scope = opts.sinceMs ? `sweep(${Math.round(opts.sinceMs / 3_600_000)}h)` : 'full'
  console.log(`[session-intel] backfillDailyUsage ${scope}: ${done} sessions, ${rows} daily rows`)
  return { sessions: done, rows }
}

export function requeueParsedSessions(): void {
  const TRANSCRIPT_DIR = '/home/operator/transcripts'
  const db = getDb()

  // Only re-queue recent sessions (last 24h) and cap at 10 to avoid API cost spikes on restart
  const stuckSessions = db.prepare(`
    SELECT si.objective_id, si.session_id, si.account_id, si.tool_calls,
           o.id, o.title, o.description, o.agent_context, o.workspace, o.project,
           o.status, o.create_pr
    FROM session_intel si
    JOIN objectives o ON si.objective_id = o.id
    WHERE si.extraction_status = 'parsed'
      AND si.ended_at > datetime('now', '-24 hours')
      AND si.tool_calls > 0
    ORDER BY si.ended_at DESC
    LIMIT 10
  `).all() as Array<Record<string, unknown>>

  if (stuckSessions.length === 0) {
    console.log('[session-intel] No stuck parsed sessions to re-queue')
    return
  }

  console.log(`[session-intel] Re-queuing ${stuckSessions.length} sessions stuck at 'parsed'`)

  for (const row of stuckSessions) {
    const sessionId = row.session_id as string
    const jsonlPath = path.join(TRANSCRIPT_DIR, `${sessionId}.jsonl`)
    if (!fs.existsSync(jsonlPath)) {
      console.log(`[session-intel] Skipping ${sessionId}: no JSONL at ${jsonlPath}`)
      continue
    }
    const objective = {
      id: row.objective_id,
      title: row.title,
      description: row.description,
      agent_context: row.agent_context,
      workspace: row.workspace,
      project: row.project,
      status: row.status,
      create_pr: row.create_pr,
    } as unknown as Objective
    queueExtraction(row.objective_id as number, sessionId, jsonlPath, row.account_id as string | null, objective)
  }
}
