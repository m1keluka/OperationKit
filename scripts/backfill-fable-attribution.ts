// One-off backfill (obj 701053): recompute transcript-derived model attribution
// for every Fable-selected objective using the hardened MAIN-LOOP detector
// (app/server/src/services/model-attribution.ts) and reconcile the stored
// ran_on_fallback flags + activity_log entries.
//
// Run inside the command-center container (live DB + transcripts visible):
//   docker exec command-center /app/node_modules/.bin/tsx \
//     <repo>/scripts/backfill-fable-attribution.ts [--apply]
//
// Dry-run by default; pass --apply to write. Per objective it:
//   - sets objectives.ran_model to the comma-joined main-loop models observed
//     across ALL of its cc-<id>-*.jsonl session streams (most turns first)
//   - clears ran_on_fallback (+ fallback_detected_at, + deletes the spurious
//     activity_log row) when NO session shows a genuine main-loop fallback
//   - sets ran_on_fallback (+ activity_log) when a genuine main-loop fallback
//     exists but was never flagged
//   - rewrites the activity_log detail with accurate main-loop turn counts when
//     an existing flag is CONFIRMED genuine
// Objectives with no transcripts on disk are left untouched (reported as skipped).

import fs from 'fs'
import path from 'path'
import { createRequire } from 'module'
import { analyzeStreamAttribution, detectMainLoopFallback, FALLBACK_MODEL_ID } from '../app/server/src/services/model-attribution.js'

const requireFromApp = createRequire('/app/package.json')
const Database = requireFromApp('better-sqlite3')

const DB_PATH = process.env.DB_PATH || '/app/data/command-center.db'
const TRANSCRIPT_DIR = process.env.TRANSCRIPT_DIR || '/home/operator/transcripts'
const APPLY = process.argv.includes('--apply')

const db = new Database(DB_PATH)
db.pragma('journal_mode = WAL')

// Same guarded additive migration db/index.ts applies at boot — the backfill
// may run against the live DB before the server code carrying it is deployed.
const colNames = new Set((db.prepare('PRAGMA table_info(objectives)').all() as { name: string }[]).map(c => c.name))
if (!colNames.has('ran_model')) {
  if (APPLY) {
    db.exec('ALTER TABLE objectives ADD COLUMN ran_model TEXT')
    console.log('added objectives.ran_model column')
  } else {
    console.log('(dry-run) objectives.ran_model column missing — would be added on --apply')
  }
}
const hasRanModel = colNames.has('ran_model') || APPLY

interface ObjRow { id: number; title: string; model: string; ran_on_fallback: number; fallback_detected_at: string | null; ran_model: string | null; project: string | null; workspace: string | null }

const objectives = db.prepare(
  `SELECT id, title, model, ran_on_fallback, fallback_detected_at, ${hasRanModel ? 'ran_model' : 'NULL AS ran_model'}, project, workspace FROM objectives WHERE model LIKE '%fable%' ORDER BY id`
).all() as ObjRow[]

const allFiles = fs.readdirSync(TRANSCRIPT_DIR)
const beforeFlagged = objectives.filter(o => o.ran_on_fallback).map(o => o.id)

let scanned = 0, skippedNoTranscript = 0, cleared = 0, newlyFlagged = 0, confirmedGenuine = 0, ranModelSet = 0

for (const obj of objectives) {
  const files = allFiles.filter(f => f.startsWith(`cc-${obj.id}-`) && f.endsWith('.jsonl'))
  if (files.length === 0) {
    skippedNoTranscript++
    continue
  }
  scanned++

  const totalTurns: Record<string, number> = {}
  let genuineSessions = 0
  let fallbackSwitches = 0
  for (const f of files) {
    let content: string
    try { content = fs.readFileSync(path.join(TRANSCRIPT_DIR, f), 'utf-8') } catch { continue }
    const attr = analyzeStreamAttribution(content)
    for (const [m, n] of Object.entries(attr.mainLoopTurns)) totalTurns[m] = (totalTurns[m] ?? 0) + n
    fallbackSwitches += attr.fallbackSwitchTo.filter(m => m === FALLBACK_MODEL_ID).length
    if (detectMainLoopFallback(attr, obj.model)) genuineSessions++
  }

  const ranModels = Object.entries(totalTurns).sort((a, b) => b[1] - a[1]).map(([m]) => m)
  const ranModel = ranModels.length ? ranModels.join(',') : null
  const genuine = genuineSessions > 0
  const turnsDesc = Object.entries(totalTurns).sort((a, b) => b[1] - a[1]).map(([m, n]) => `${m}=${n}`).join(', ')
  const evidence = `main-loop turns across ${files.length} session(s): ${turnsDesc || 'none'}; sessions with genuine main-loop fallback: ${genuineSessions}; explicit fallback switches: ${fallbackSwitches}`

  // Historical guard: setting a NEW flag on an old objective requires the CLI's
  // own `{type:'fallback'}` switch block, not just an all-Opus main loop. Dozens
  // of pre-recovery "[recovered]" placeholders carry model='claude-fable-5'
  // metadata that cannot be trusted (their runs predate Fable being enabled and
  // show 100% Opus with zero switch blocks) — flagging those would rewrite
  // history on bad evidence. The LIVE detector doesn't need this guard because
  // the requested model is trustworthy at spawn time.
  const flagNew = genuine && !obj.ran_on_fallback && fallbackSwitches > 0
  const verdict = genuine
    ? (obj.ran_on_fallback ? 'CONFIRM-FLAG' : (flagNew ? 'NEW-FLAG' : 'ambiguous-metadata (not flagged)'))
    : (obj.ran_on_fallback ? 'CLEAR-FLAG' : 'ok')
  console.log(`#${obj.id} [${verdict}] ran_model=${ranModel ?? '(none)'} | ${evidence} | ${obj.title.slice(0, 50)}`)

  if (!APPLY) continue

  if (ranModel && ranModel !== obj.ran_model) {
    db.prepare('UPDATE objectives SET ran_model = ? WHERE id = ?').run(ranModel, obj.id)
    ranModelSet++
  }

  if (flagNew) {
    db.prepare("UPDATE objectives SET ran_on_fallback = 1, fallback_detected_at = COALESCE(fallback_detected_at, datetime('now')) WHERE id = ?").run(obj.id)
    db.prepare(
      `INSERT INTO activity_log (project, workspace, objective_id, session_id, event_type, title, detail)
       VALUES (?, ?, ?, NULL, 'milestone', 'ran_on_fallback', ?)`
    ).run(obj.project ?? 'command-center-infra', obj.workspace ?? 'example', obj.id,
      `Backfill (obj 701053): requested ${obj.model} but the main agentic loop ran on fallback ${FALLBACK_MODEL_ID}. ${evidence}.`)
    newlyFlagged++
  } else if (!genuine && obj.ran_on_fallback) {
    db.prepare('UPDATE objectives SET ran_on_fallback = 0, fallback_detected_at = NULL WHERE id = ?').run(obj.id)
    const del = db.prepare("DELETE FROM activity_log WHERE objective_id = ? AND title = 'ran_on_fallback'").run(obj.id)
    db.prepare(
      `INSERT INTO activity_log (project, workspace, objective_id, session_id, event_type, title, detail)
       VALUES (?, ?, ?, NULL, 'milestone', 'fallback_flag_cleared', ?)`
    ).run(obj.project ?? 'command-center-infra', obj.workspace ?? 'example', obj.id,
      `Backfill (obj 701053): cleared FALSE-POSITIVE fallback flag (removed ${del.changes} spurious log row(s)). The old detector keyed on the modelUsage rollup / sub-agent transcripts; the main loop did not run on ${FALLBACK_MODEL_ID}. ${evidence}.`)
    cleared++
  } else if (genuine && obj.ran_on_fallback) {
    db.prepare("UPDATE activity_log SET detail = ? WHERE objective_id = ? AND title = 'ran_on_fallback'").run(
      `Requested ${obj.model}; the main agentic loop GENUINELY ran on fallback ${FALLBACK_MODEL_ID} (verified by backfill obj 701053 against transcripts — ${evidence}).`, obj.id)
    confirmedGenuine++
  }
}

const afterFlagged = APPLY
  ? (db.prepare("SELECT id FROM objectives WHERE model LIKE '%fable%' AND ran_on_fallback = 1").all() as { id: number }[]).map(r => r.id)
  : beforeFlagged

console.log('\n── summary ──')
console.log(`mode: ${APPLY ? 'APPLY' : 'dry-run'}`)
console.log(`fable objectives: ${objectives.length} | with transcripts scanned: ${scanned} | skipped (no transcripts on disk): ${skippedNoTranscript}`)
console.log(`flags BEFORE: ${beforeFlagged.length} ${JSON.stringify(beforeFlagged)}`)
console.log(`flags AFTER:  ${afterFlagged.length} ${JSON.stringify(afterFlagged)}`)
console.log(`cleared (false positives): ${cleared} | newly flagged (genuine, previously missed): ${newlyFlagged} | confirmed genuine (log corrected): ${confirmedGenuine} | ran_model written: ${ranModelSet}`)
db.close()
