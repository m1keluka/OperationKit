/**
 * Refusal / fallback-model telemetry — extracted from session-manager.ts
 * (behavior frozen). Scanned from the JSONL at session end.
 */
import fs from 'fs'
import { getDb } from '../db/index.js'
import { FALLBACK_MODEL_ID, analyzeStreamAttribution, detectMainLoopFallback, mainLoopModelsRan, mergeRanModel } from './model-attribution.js'
import {
  type WorktreeIsolation,
  checkWorktreeViolation,
} from './session-worktree.js'

// ── Refusal / fallback-model telemetry ──
// Scanned from the JSONL at session end (sessions are single-turn --print
// processes, so "end of process" ≈ "end of turn"). Detections emit a
// `[telemetry]` container-log line plus a `type: 'warning'` event in the
// session jsonl — the same surfacing mechanism worktree violations use.

const telemetryFlagged = new Set<string>()  // `${sessionId}:refusal` / `${sessionId}:fallback`

function emitTelemetryWarning(sessionId: string, jsonlPath: string, logPath: string, kind: 'refusal' | 'fallback', detail: string): void {
  const flag = `${sessionId}:${kind}`
  if (telemetryFlagged.has(flag)) return
  telemetryFlagged.add(flag)
  const summary = `[telemetry] ${kind} session=${sessionId} ${detail}`
  console.warn(summary)
  try { fs.appendFileSync(logPath, `[WARNING] ${summary}\n`) } catch {}
  const text = kind === 'refusal'
    ? `⚠️ Telemetry: model refused (stop_reason=refusal). ${detail}`
    : `⚠️ Telemetry: fallback model used — ${detail}`
  try {
    fs.appendFileSync(jsonlPath, JSON.stringify({ type: 'warning', text, timestamp: new Date().toISOString() }) + '\n')
  } catch {}
}

/**
 * Persist a durable Fable→Opus fallback marker (audit 2026-07-04). Unlike the
 * in-memory `telemetryFlagged` Set and the jsonl warning event, this survives a
 * process restart: it sets `objectives.ran_on_fallback = 1` (+ a first-detection
 * timestamp) and writes an `activity_log` row capturing requested-vs-actual
 * model, so a Fable objective that actually ran on Opus is permanently attributed
 * correctly and can be surfaced on the card. The persisted marker also doubles as
 * the cross-restart de-dupe key: if the row is already flagged we no-op, so we
 * never double-log the same fallback across scans/restarts.
 */
function persistFallbackMarker(objectiveId: number, sessionId: string, requestedModel: string, actualModel: string): void {
  try {
    const db = getDb()
    const row = db
      .prepare('SELECT ran_on_fallback, project, workspace FROM objectives WHERE id = ?')
      .get(objectiveId) as { ran_on_fallback: number; project: string | null; workspace: string | null } | undefined
    // De-dupe on the PERSISTED marker (not just the in-memory Set): already flagged → nothing to do.
    if (!row || row.ran_on_fallback) return
    db.prepare(
      "UPDATE objectives SET ran_on_fallback = 1, fallback_detected_at = datetime('now') WHERE id = ?"
    ).run(objectiveId)
    db.prepare(
      `INSERT INTO activity_log (project, workspace, objective_id, session_id, event_type, title, detail)
       VALUES (?, ?, ?, ?, 'milestone', ?, ?)`
    ).run(
      row.project ?? 'command-center-infra',
      row.workspace ?? 'example',
      objectiveId,
      sessionId,
      'ran_on_fallback',
      `Requested ${requestedModel} but session ran on fallback model ${actualModel}.`,
    )
  } catch (err) {
    console.warn(`[telemetry] failed to persist fallback marker for objective ${objectiveId}:`, (err as Error).message)
  }
}

export function scanStreamTelemetry(sessionId: string, jsonlPath: string, logPath: string, requestedModel: string | null | undefined, objectiveId?: number, isolation?: WorktreeIsolation): void {
  let content: string
  try {
    content = fs.readFileSync(jsonlPath, 'utf-8')
  } catch {
    return
  }
  if (isolation) {
    for (const line of content.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      // obj 1059 — warn-only telemetry backstop. The PreToolUse guard already
      // BLOCKS live-checkout edits pre-write; this post-hoc scan catches anything
      // that somehow landed (e.g. a non-Claude engine without the hook) and
      // surfaces it as a [worktree-violation] in the log + a UI warning event.
      try { checkWorktreeViolation(trimmed, jsonlPath, logPath, isolation, new Date().toISOString()) } catch {}
    }
  }

  // Hardened attribution (obj 701053): decide refusal/fallback from the MAIN
  // LOOP only. Sub-agent (sidechain) turns, helper models, and the rolled-up
  // `result.modelUsage` map legitimately contain Opus/Haiku on a Fable
  // objective and must never flag a fallback — see model-attribution.ts.
  const attribution = analyzeStreamAttribution(content)

  if (attribution.sawRefusal) {
    emitTelemetryWarning(sessionId, jsonlPath, logPath, 'refusal', 'stop_reason=refusal')
  }

  // Positive attribution: persist the main-loop model(s) that actually ran so
  // the UI can show a transcript-derived "ran on <model>" badge, not just the
  // negative fallback warning.
  if (objectiveId != null) {
    persistRanModel(objectiveId, mainLoopModelsRan(attribution))
  }

  if (detectMainLoopFallback(attribution, requestedModel)) {
    emitTelemetryWarning(sessionId, jsonlPath, logPath, 'fallback', `requested ${requestedModel} but the main loop ran on ${FALLBACK_MODEL_ID}`)
    // Durable attribution: persist the marker + activity_log row so it survives a
    // restart (the jsonl warning + in-memory Set above do not). De-duped on the
    // persisted marker inside the helper.
    if (objectiveId != null) {
      persistFallbackMarker(objectiveId, sessionId, requestedModel as string, FALLBACK_MODEL_ID)
    }
  }
}

/** Merge the observed main-loop models into objectives.ran_model (durable,
 *  transcript-derived positive attribution — obj 701053). Idempotent across
 *  repeat scans of the same session. */
function persistRanModel(objectiveId: number, observed: string[]): void {
  if (observed.length === 0) return
  try {
    const db = getDb()
    const row = db.prepare('SELECT ran_model FROM objectives WHERE id = ?').get(objectiveId) as { ran_model: string | null } | undefined
    if (!row) return
    const merged = mergeRanModel(row.ran_model, observed)
    if (merged !== row.ran_model) {
      db.prepare('UPDATE objectives SET ran_model = ? WHERE id = ?').run(merged, objectiveId)
    }
  } catch (err) {
    console.warn(`[telemetry] failed to persist ran_model for objective ${objectiveId}:`, (err as Error).message)
  }
}
