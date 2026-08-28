/**
 * Live-session poller helpers — extracted from state-poller.ts (behavior frozen).
 * Knowledge/scope scans, limit/overload/turns death, floor wrappers, arena promote.
 * The poll loop in state-poller.ts calls these.
 */
import fs from 'fs'
import path from 'path'
import type { Objective, ObjectiveStatus } from '@command-center/shared'
import { getDb } from '../db/index.js'
import {
  getSessionState,
  autoResumeOnLimit,
  autoResumeOnOverload,
  autoResumeOnTurns,
  getSessionOutput,
  resolveWorkdir,
} from './session-manager.js'
import {
  recordFloorRunRow,
  logFloorMilestoneRow,
  type FloorRunResult,
} from './deterministic-floor.js'
import { deriveBranchName, detectBranchBleed, detectProjectBleed } from './branch-scope.js'
import { getRouterStatus } from './account-router.js'
import { sendTelegram } from './notifier.js'
import { hasArenaCohort, getArenaCohort, evaluateAndPromoteArena } from './arena-lifecycle.js'
import { broadcast } from '../ws/index.js'
import { runMachineStatusUpdate } from '../lib/status-lock.js'
import { TRANSCRIPT_DIR, PROJECTS_DIR } from '../config.js'

// Track JSONL byte offsets for incremental knowledge capture scanning
export const knowledgeScanOffsets = new Map<string, number>()
// obj 994 — per-session byte offset for the incremental scope-bleed scan.
export const scopeScanOffsets = new Map<string, number>()
const SCOPE_EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const KNOWLEDGE_PATHS = ['second-brain/personal/decisions/', 'second-brain/workspaces/', 'second-brain/personal/insights/']
const KNOWLEDGE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])

/**
 * Real-time knowledge capture: scan new JSONL lines for Write/Edit events
 * targeting second-brain/ paths. Logs them immediately to session_events
 * so knowledge writes are visible before post-session extraction runs.
 */
export function scanForKnowledgeWrites(sessionId: string, objectiveId: number): void {
  const jsonlPath = path.join(TRANSCRIPT_DIR, `${sessionId}.jsonl`)
  const lastOffset = knowledgeScanOffsets.get(sessionId) || 0

  let stat: fs.Stats
  try {
    stat = fs.statSync(jsonlPath)
  } catch { return }

  if (stat.size <= lastOffset) return

  // Read only new bytes since last scan
  const fd = fs.openSync(jsonlPath, 'r')
  const buf = Buffer.alloc(stat.size - lastOffset)
  fs.readSync(fd, buf, 0, buf.length, lastOffset)
  fs.closeSync(fd)
  knowledgeScanOffsets.set(sessionId, stat.size)

  const db = getDb()
  const newLines = buf.toString('utf-8').split('\n')

  for (const line of newLines) {
    const trimmed = line.trim()
    if (!trimmed) continue

    let event: { type?: string; message?: { content?: Array<{ type?: string; name?: string; input?: Record<string, unknown> }> } }
    try {
      event = JSON.parse(trimmed)
    } catch { continue }

    if (event.type !== 'assistant' || !Array.isArray(event.message?.content)) continue

    for (const block of event.message!.content!) {
      if (block.type !== 'tool_use' || !block.name || !KNOWLEDGE_TOOLS.has(block.name)) continue
      const input = block.input || {}
      const filePath = String(input.file_path || input.notebook_path || '')
      if (!filePath) continue

      // Check if this write targets a knowledge path
      const isKnowledge = KNOWLEDGE_PATHS.some(kp => filePath.includes(kp))
      if (!isKnowledge) continue

      // Determine event type from path
      const isDecision = filePath.includes('/decisions/')
      const isInsight = filePath.includes('/insights/')
      const eventType = isDecision ? 'decision' : isInsight ? 'milestone' : 'milestone'
      const fileName = path.basename(filePath)

      // Avoid duplicate entries for the same file in the same session
      const existing = db.prepare(
        "SELECT id FROM session_events WHERE session_id = ? AND event_type = ? AND description LIKE ?"
      ).get(sessionId, eventType, `%${fileName}%`)

      if (!existing) {
        db.prepare(
          `INSERT INTO session_events (session_id, objective_id, event_type, description, metadata, created_at)
           VALUES (?, ?, ?, ?, ?, datetime('now'))`
        ).run(
          sessionId,
          objectiveId,
          eventType,
          `${isDecision ? 'Decision' : 'Insight'} captured: ${fileName}`,
          JSON.stringify({ file_path: filePath, tool: block.name, captured_at: new Date().toISOString() })
        )
        console.log(`[knowledge-capture] Real-time capture: ${eventType} from session ${sessionId} → ${fileName}`)
      }
    }
  }
}

/**
 * obj 994 — scope-bleed detector. Incrementally scans an active session's new
 * stream-json for git ops that create/push a branch OTHER than the one this
 * objective owns, or Edit/Write into a DIFFERENT project entirely. On a hit it
 * raises an advisory warning (jsonl event surfaced in SessionViewer + container
 * log) and bumps objectives.scope_flags so the board can badge it. Advisory only
 * — it never kills or blocks the session (fail-safe).
 */
export function scanForScopeBleed(objective: Objective): void {
  const ownedBranch = deriveBranchName(objective)
  if (!ownedBranch) return // non-PR objectives have no branch scope to defend
  const sessionId = objective.session_id!
  const jsonlPath = path.join(TRANSCRIPT_DIR, `${sessionId}.jsonl`)
  const lastOffset = scopeScanOffsets.get(sessionId) || 0

  let stat: fs.Stats
  try { stat = fs.statSync(jsonlPath) } catch { return }
  if (stat.size <= lastOffset) return

  const fd = fs.openSync(jsonlPath, 'r')
  const buf = Buffer.alloc(stat.size - lastOffset)
  fs.readSync(fd, buf, 0, buf.length, lastOffset)
  fs.closeSync(fd)
  scopeScanOffsets.set(sessionId, stat.size)

  // resolveWorkdir now fails closed (throws) for a project-linked objective that
  // resolves to nothing (obj 1451). This scan is read-only telemetry on an already
  // running session, so a throw here must not crash the poll loop — fall back to ''.
  let ownedProjectDir = ''
  try {
    ownedProjectDir = (resolveWorkdir(objective) || '').replace(/\/+$/, '')
  } catch (err) {
    console.warn(`[state-poller] scope-scan: resolveWorkdir failed for obj ${objective.id}; skipping scan: ${err instanceof Error ? err.message : err}`)
    return
  }
  const worktreePath = `/tmp/cc-worktree-${objective.id}`
  const hits: string[] = []

  for (const line of buf.toString('utf-8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let event: { type?: string; message?: { content?: Array<{ type?: string; name?: string; input?: Record<string, unknown> }> } }
    try { event = JSON.parse(trimmed) } catch { continue }
    if (event.type !== 'assistant' || !Array.isArray(event.message?.content)) continue

    for (const block of event.message!.content!) {
      if (block.type !== 'tool_use' || !block.name) continue
      const input = block.input || {}
      if (block.name === 'Bash') {
        const cmd = String(input.command || '')
        const foreign = detectBranchBleed(cmd, ownedBranch)
        if (foreign) hits.push(`git op targets foreign branch '${foreign}' (owned: '${ownedBranch}')`)
      } else if (SCOPE_EDIT_TOOLS.has(block.name)) {
        const raw = String(input.file_path || input.notebook_path || '')
        if (!raw) continue
        const abs = path.isAbsolute(raw) ? raw : path.resolve(ownedProjectDir, raw)
        if (detectProjectBleed(abs, ownedProjectDir, worktreePath, PROJECTS_DIR)) {
          hits.push(`${block.name} edits a different project: ${abs}`)
        }
      }
    }
  }

  if (hits.length === 0) return

  const db = getDb()
  const ts = new Date().toISOString()
  for (const hit of hits) {
    const summary = `[scope-bleed] objective=${objective.id} session=${sessionId} ${hit}`
    console.warn(summary)
    try {
      fs.appendFileSync(jsonlPath, JSON.stringify({
        type: 'warning',
        text: `⚠️ Scope-bleed: ${hit}. This objective is bound to branch '${ownedBranch}'. If this work belongs to a different objective, STOP and report it as a scope-split instead of building it here.`,
        timestamp: ts,
      }) + '\n')
      // NOTE: do NOT advance scopeScanOffsets past this append. The offset is
      // already set to the pre-append size; the warning we just wrote has
      // type:'warning' (the scan loop only processes type:'assistant'), so it is
      // harmless to re-read next tick. Advancing here would skip any session
      // events written between the statSync above and this append.
    } catch { /* non-fatal */ }
    try {
      // event_type MUST be 'warning', never 'blocker'. 'blocker' is load-bearing:
      // context-builder.ts injects blocker rows (matched by project name) into
      // OTHER objectives' spawn prompts, so an advisory here would leak into
      // unrelated sessions' context. This guardrail is advisory, never a kill.
      db.prepare(
        `INSERT INTO session_events (session_id, objective_id, event_type, description, metadata, created_at)
         VALUES (?, ?, 'warning', ?, ?, datetime('now'))`
      ).run(sessionId, objective.id, `Scope-bleed: ${hit}`, JSON.stringify({ owned_branch: ownedBranch, flagged_at: ts }))
    } catch { /* session_events insert is best-effort */ }
  }
  try {
    db.prepare("UPDATE objectives SET scope_flags = COALESCE(scope_flags, 0) + ? WHERE id = ?").run(hits.length, objective.id)
  } catch { /* non-fatal */ }
  try {
    broadcast({ type: 'objective_updated', payload: db.prepare('SELECT * FROM objectives WHERE id = ?').get(objective.id) as Objective })
  } catch { /* non-fatal */ }
}

// Park an objective whose every Claude account is now rate-limited. It is already
// enqueued (autoResumeOnLimit → enqueueSession), so the account-router drain timer
// will PATCH it review→working — re-spawning on a fresh account — the moment the
// earliest cooldown expires (≤5h). session_id is cleared so the poller stops
// re-handling the dead session each tick. (objective 337)
export function emitAllAccountsLimited(objective: Objective): void {
  const db = getDb()
  const earliest = getRouterStatus().earliestReset
  const resetNote = earliest ? ` Earliest account frees up ~${new Date(earliest).toLocaleString()}.` : ''

  runMachineStatusUpdate(
    db,
    "UPDATE objectives SET status = 'review', session_id = NULL, updated_at = datetime('now') WHERE id = ?",
    objective.id,
  )

  try {
    db.prepare(
      `INSERT INTO activity_log (project, workspace, objective_id, session_id, event_type, title, detail)
       VALUES (?, ?, ?, ?, 'milestone', 'all_accounts_limited', ?)`
    ).run(
      objective.project || 'unknown',
      objective.workspace,
      objective.id,
      objective.session_id,
      `All Claude accounts hit their usage limits — objective queued for automatic resume.${resetNote}`
    )
  } catch (err) {
    console.error(`[state-poller] Failed to log all-accounts-limited for obj ${objective.id}:`, err)
  }

  void sendTelegram(
    `⏸️ Objective #${objective.id} ("${objective.title}") paused — all Claude accounts hit their usage limits. It will auto-resume when one frees up.${resetNote}`
  )
  console.log(`[state-poller] Objective ${objective.id} parked (all accounts limited) — drain will auto-resume.${resetNote}`)
}

// Park an objective whose account hit a monthly/org spend cap. Unlike a usage
// rate limit, this never recovers on its own: siblings share the org cap, so
// rotation re-hits it instantly, and the drain timer re-resume re-hits it ~5h
// later — an endless loop. It only clears when an admin raises the cap or the
// billing month rolls over, so we park in `review` (session_id cleared so the
// poller stops re-handling the dead session) and require human/admin action.
export function emitSpendCapHit(objective: Objective): void {
  const db = getDb()
  runMachineStatusUpdate(
    db,
    "UPDATE objectives SET status = 'review', session_id = NULL, updated_at = datetime('now') WHERE id = ?",
    objective.id,
  )

  try {
    db.prepare(
      `INSERT INTO activity_log (project, workspace, objective_id, session_id, event_type, title, detail)
       VALUES (?, ?, ?, ?, 'milestone', 'spend_cap_hit', ?)`
    ).run(
      objective.project || 'unknown',
      objective.workspace,
      objective.id,
      objective.session_id,
      'Org monthly spend limit reached — paused for admin action (raise the cap at claude.ai/admin-settings/usage). Will NOT auto-resume.'
    )
  } catch (err) {
    console.error(`[state-poller] Failed to log spend-cap-hit for obj ${objective.id}:`, err)
  }

  void sendTelegram(
    `🛑 Objective #${objective.id} ("${objective.title}") paused — your org hit its monthly spend limit. Raise the cap at claude.ai/admin-settings/usage, then resume manually. This will NOT auto-resume.`
  )
  console.log(`[state-poller] Objective ${objective.id} parked (org spend cap) — needs admin action, no auto-resume.`)
}

/**
 * A session died because its account hit a usage/spend limit. Try to keep the
 * objective running uninterrupted by rotating to a fresh account. Returns true
 * when the objective was rotated (resumed) or parked-for-auto-resume — in both
 * cases the caller must `continue` and skip normal review routing. Returns false
 * for codex / circuit-breaker (caller falls back to its normal review handling).
 *
 * `spendCapHit` is the non-recoverable subset: park for admin action instead of
 * rotating (siblings share the cap) or enqueuing for the drain timer.
 */
export function handleLimitDeath(objective: Objective, spendCapHit = false): boolean {
  const db = getDb()

  if (spendCapHit) {
    emitSpendCapHit(objective)
    const parked = db.prepare('SELECT * FROM objectives WHERE id = ?').get(objective.id) as Objective
    broadcast({ type: 'objective_updated', payload: parked })
    return true
  }

  const outcome = autoResumeOnLimit(objective.session_id!, objective)

  if (outcome === 'rotated') {
    // sendFollowUp respawned on a fresh account under the SAME session_id —
    // keep the objective in 'working'; the user sees no interruption.
    runMachineStatusUpdate(
      db,
      "UPDATE objectives SET status = 'working', updated_at = datetime('now') WHERE id = ?",
      objective.id,
    )
    try {
      db.prepare(
        `INSERT INTO activity_log (project, workspace, objective_id, session_id, event_type, title, detail)
         VALUES (?, ?, ?, ?, 'milestone', 'account_auto_rotated', ?)`
      ).run(
        objective.project || 'unknown',
        objective.workspace,
        objective.id,
        objective.session_id,
        'Account hit its usage limit — auto-rotated to a fresh account and resumed uninterrupted.'
      )
    } catch {}
    const updated = db.prepare('SELECT * FROM objectives WHERE id = ?').get(objective.id) as Objective
    broadcast({ type: 'objective_updated', payload: updated })
    return true
  }

  if (outcome === 'exhausted') {
    emitAllAccountsLimited(objective)
    const updated = db.prepare('SELECT * FROM objectives WHERE id = ?').get(objective.id) as Objective
    broadcast({ type: 'objective_updated', payload: updated })
    return true
  }

  return false // 'skipped' → caller does normal review parking
}

/**
 * A session died because Anthropic returned an Overloaded (529) error. This is a
 * transient GLOBAL capacity problem (it hits every account at once), so instead
 * of rotating or parking we retry the same session after a backoff. Returns true
 * when a retry was scheduled (caller keeps it 'working' and skips review routing);
 * false for codex / exhausted retry budget (caller falls back to review parking).
 */
export function handleOverloadDeath(objective: Objective): boolean {
  const outcome = autoResumeOnOverload(objective.session_id!, objective)
  if (outcome !== 'retrying') return false // 'skipped' → normal review parking

  const db = getDb()
  runMachineStatusUpdate(
    db,
    "UPDATE objectives SET status = 'working', updated_at = datetime('now') WHERE id = ?",
    objective.id,
  )
  try {
    db.prepare(
      `INSERT INTO activity_log (project, workspace, objective_id, session_id, event_type, title, detail)
       VALUES (?, ?, ?, ?, 'milestone', 'anthropic_overloaded_retry', ?)`
    ).run(
      objective.project || 'unknown',
      objective.workspace,
      objective.id,
      objective.session_id,
      'Anthropic API returned Overloaded (529) — auto-retrying the same session with backoff. No work lost.'
    )
  } catch {}
  const updated = db.prepare('SELECT * FROM objectives WHERE id = ?').get(objective.id) as Objective
  broadcast({ type: 'objective_updated', payload: updated })
  return true
}

/**
 * A session died because it exhausted its per-spawn turn budget (`--max-turns`)
 * while still productive. Auto-continue the SAME session (claude --resume,
 * bounded by MAX_TURNS_AUTO_CONTINUE) instead of stranding it in `review` for a
 * manual Resume. Returns true when a continue was scheduled (caller keeps it
 * 'working' and skips review routing); false when the bound is exhausted/disabled
 * or the engine is codex (caller falls back to normal review parking, so a
 * genuine runaway still stops). Fail-safe: any error is logged and swallowed so
 * a turns-continue glitch can never wedge the poller — it just degrades to the
 * normal review fallthrough. (obj 1487)
 */
export function handleTurnsDeath(objective: Objective): boolean {
  try {
    const outcome = autoResumeOnTurns(objective.session_id!, objective)
    if (outcome !== 'continued') return false // 'exhausted'/'skipped' → normal review parking

    const db = getDb()
    runMachineStatusUpdate(
      db,
      "UPDATE objectives SET status = 'working', updated_at = datetime('now') WHERE id = ?",
      objective.id,
    )
    try {
      db.prepare(
        `INSERT INTO activity_log (project, workspace, objective_id, session_id, event_type, title, detail)
         VALUES (?, ?, ?, ?, 'milestone', 'max_turns_auto_continue', ?)`
      ).run(
        objective.project || 'unknown',
        objective.workspace,
        objective.id,
        objective.session_id,
        'Hit the per-spawn turn cap (--max-turns) while still productive — auto-continued the same session. No work lost.'
      )
    } catch {}
    const updated = db.prepare('SELECT * FROM objectives WHERE id = ?').get(objective.id) as Objective
    broadcast({ type: 'objective_updated', payload: updated })
    return true
  } catch (err) {
    console.error(`[state-poller] handleTurnsDeath failed for obj ${objective.id} (falling back to review routing):`, err)
    return false
  }
}

// ── Deterministic floor (ST1 / P1+P2) helpers ──────────────────────────────
type FloorDb = ReturnType<typeof getDb>

/**
 * Persist one floor run to the coupled observability table (best-effort).
 * Thin wrapper over the shared recordFloorRunRow (single source of truth for the
 * proof-row shape, reused by the working→done route). llm_would_have_run is true
 * iff this objective would otherwise have reached the LLM reviewer (ai_review).
 */
export function recordFloorRun(
  db: FloorDb,
  objective: Objective,
  resolvedStatus: ObjectiveStatus,
  cwd: string,
  run: FloorRunResult,
): void {
  recordFloorRunRow(db, objective, resolvedStatus, cwd, run, resolvedStatus === 'ai_review')
}

/** Emit a floor milestone to activity_log (delegates to the shared helper). */
export function logFloorMilestone(db: FloorDb, objective: Objective, title: string, detail: string): void {
  logFloorMilestoneRow(db, objective, title, detail)
}

/**
 * Design Arena cohort completion glue (obj 594). Wires the real session/DB IO into the
 * testable `evaluateAndPromoteArena`. Once every variant session has finished, the
 * winner is selected (R9 pre-filter → variant <scorecard> grade → rank → optional
 * single pairwise tiebreak) and PROMOTED by repointing the objective's `session_id` at
 * the winning variant's session — the existing working→ai_review transition then
 * reviews the winner unchanged. No-op while the cohort is still building.
 */
export async function promoteArenaCohortIfReady(objective: Objective): Promise<void> {
  const cohort = getArenaCohort(objective.id)
  if (!cohort) return
  const db = getDb()
  const outcome = await evaluateAndPromoteArena(objective, cohort, {
    getState: (sid) => getSessionState(sid),
    getTranscript: (sid) => {
      try {
        return getSessionOutput(sid)
          .filter((m) => m.type === 'assistant' && m.text)
          .map((m) => m.text!)
          .join('\n\n')
      } catch {
        return ''
      }
    },
    promote: (objId, winnerSid) => {
      db.prepare(
        "UPDATE objectives SET session_id = ?, updated_at = datetime('now') WHERE id = ?",
      ).run(winnerSid, objId)
    },
    log: (m) => console.log(m),
  })
  if (outcome.status === 'promoted' || outcome.status === 'no-winner') {
    db.prepare(
      `INSERT INTO activity_log (project, workspace, objective_id, session_id, event_type, title, detail)
       VALUES (?, ?, ?, ?, 'milestone', 'arena_winner_promoted', ?)`,
    ).run(
      objective.project || 'unknown',
      objective.workspace,
      objective.id,
      outcome.status === 'promoted' ? outcome.winnerSessionId : objective.session_id,
      `Design arena selected '${outcome.result.winner?.archetype ?? outcome.result.ranking[0]?.archetype ?? 'n/a'}' from ${cohort.length} variants → entering ai_review.`,
    )
    const updated = db.prepare('SELECT * FROM objectives WHERE id = ?').get(objective.id) as Objective
    broadcast({ type: 'objective_updated', payload: updated })
  }
}
