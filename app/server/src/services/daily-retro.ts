// ── Daily Session Retrospective (DSR) — core service ─────────────────────────
//
// Spec: ~/second-brain/workspaces/personal/decisions/
//       2026-08-08-cc-daily-session-retrospective-loop-design.md  (Part D)
//
// WHAT THIS DOES. Once a day (as a dream-cycle phase at 03:00 UTC) it reads
// every session from the target day, detects the issues that a human or the
// agent itself had to correct, puts each candidate through THREE independent
// fresh-context review lenses, and — only when all three agree and only when
// Operator has flipped `dsr_live` — raises a fix objective on the board.
//
// WHAT IT DOES NOT DO AS SHIPPED. Both `dsr_enabled` and `dsr_live` default to
// '0'. With `dsr_enabled=0` the dream-cycle phase returns before touching
// anything. With `dsr_enabled=1, dsr_live=0` (SHADOW — the intended first
// cutover step) the FULL pipeline runs, including the lenses, and writes
// `dsr_candidates` rows — but posts NOTHING to the board. Shadow deliberately
// exercises the whole gate so the output Operator reviews is the actual set of
// objectives that WOULD have been created, not a raw candidate dump.
//
// THREE-TIER READ (§C.1), cheapest first:
//   Tier 0  SQL only — session_intel × objectives × objective_reviews ×
//           session_events. Free. Yields weak candidates + the shortlist.
//   Tier 1  Transcript structural scan — `type:"followup"` lines and
//           `tool_result.is_error` blocks ONLY. No LLM. MANDATORY, because the
//           audit proved session_intel.errors is empty in 0/5,692 rows ever and
//           the correction channel exists nowhere else (findings A.1-a, A.6-a).
//   Tier 2  LLM, per-candidate only — a ±20-message window handed to the lenses.
//           Never a whole 4 MB transcript.
//
// SAFETY BRAKES (§C.3), all enforced here: kill switch → flags → WIP brake →
// watermark → sanity abort → fingerprint ledger → rank → cost ceiling → per-run
// cap. Every drop is LOGGED; nothing is silently truncated.
//
// Split: flags/types in daily-retro-config.ts, scan/detect in
// daily-retro-scan.ts, gate/lenses/post/tuner in daily-retro-gate.ts.
// Classifiers already live in daily-retro.detect.ts. This file is the run
// facade + re-exports.

import type { Database } from 'better-sqlite3'
import { getDb } from '../db/index.js'
import { recordCorrection } from './corrections.js'
import {
  DSR_ORIGIN,
  DSR_PROJECT,
  OPEN_STATUSES,
  isRetroEnabled,
  isRetroKilled,
  isRetroLive,
  loadConfig,
  type RunOptions,
  type RunResult,
} from './daily-retro-config.js'
import { detectCandidates } from './daily-retro-scan.js'
import {
  anthropicLensRunner,
  buildObjectivePayload,
  effectiveThreshold,
  localhostPoster,
  postObjective,
  runReviewGate,
  tunePrecision,
} from './daily-retro-gate.js'

export {
  DSR_ORIGIN,
  DSR_PROJECT,
  OPEN_STATUSES,
  TRANSCRIPT_DIR,
  WINDOW_RADIUS,
  isRetroEnabled,
  isRetroKilled,
  isRetroLive,
  loadConfig,
  type GateOutcome,
  type GateResult,
  type L1Verdict,
  type L2Verdict,
  type L3Verdict,
  type LensName,
  type LensRunner,
  type ObjectivePoster,
  type RetroCandidate,
  type RetroConfig,
  type RunOptions,
  type RunResult,
} from './daily-retro-config.js'

export {
  type DetectOptions,
  type DetectResult,
  buildWindow,
  detectCandidates,
  scanTranscript,
} from './daily-retro-scan.js'

export {
  type TuneResult,
  anthropicLensRunner,
  buildObjectivePayload,
  effectiveThreshold,
  filterBoardContext,
  boardContextIds,
  groundDuplicateVerdict,
  localhostPoster,
  postObjective,
  runReviewGate,
  selfExclusionIds,
  tunePrecision,
  LENS_TOOLS,
  LENS_PROMPTS,
} from './daily-retro-gate.js'

// ── The run ──────────────────────────────────────────────────────────────────

function yesterdayUtc(): string {
  return new Date(Date.now() - 24 * 3600 * 1000).toISOString().slice(0, 10)
}

/** Recent board titles + learnings handed to L2 as its novelty corpus. */
function buildBoardContext(db: Database): string {
  try {
    const objs = db
      .prepare(
        `SELECT id, title, status FROM objectives
          WHERE project = ? AND created_at > datetime('now','-30 days')
          ORDER BY created_at DESC LIMIT 200`,
      )
      .all(DSR_PROJECT) as Array<{ id: number; title: string; status: string }>
    const learnings = db
      .prepare(`SELECT content FROM objective_learnings ORDER BY id DESC LIMIT 50`)
      .all() as Array<{ content: string }>
    return [
      'Recent objectives (id | status | title):',
      ...objs.map(o => `${o.id} | ${o.status} | ${o.title}`),
      'Known learnings:',
      ...learnings.map(l => `- ${l.content.slice(0, 200)}`),
    ].join('\n')
  } catch {
    return ''
  }
}

/**
 * One full retrospective run.
 *
 * Brake order is load-bearing and matches §C.3: kill switch → enabled flag →
 * WIP brake → watermark → detect → sanity abort → floor → ledger → rank → cost
 * ceiling → per-run cap → gate → (live only) post. Ranking happens BEFORE the
 * cost ceiling so a cost abort loses the WEAKEST candidates, never a random
 * subset (risk D.6-4).
 */
export async function runDailyRetro(opts: RunOptions = {}): Promise<RunResult> {
  const db = opts.db ?? getDb()
  const env = opts.env ?? process.env
  const day = opts.day ?? yesterdayUtc()
  const cfg = loadConfig(db, env)
  const dryRun = opts.dryRun === true
  const notes: string[] = []

  const base: RunResult = {
    run_id: null,
    mode: 'shadow',
    target_day: day,
    skipped: null,
    sessions_scanned: 0,
    raw_signals: 0,
    above_floor: 0,
    lens_killed: 0,
    created: 0,
    held: 0,
    routed_corrections: 0,
    dropped_by_cap: 0,
    unclassified_followups: 0,
    cost_usd: 0,
    candidates: [],
    notes,
  }

  // Brake 0 — instant disarm, checked before anything else, including enabled.
  if (isRetroKilled(db, env)) {
    console.log('[retro] killed — no-op')
    return { ...base, skipped: 'killed' }
  }
  // The dry-run CLI is the artefact Operator reviews at cutover, so it must run
  // even while dsr_enabled=0 — it writes nothing either way.
  if (!dryRun && !isRetroEnabled(db, env)) {
    console.log('[retro] disabled — no-op')
    return { ...base, skipped: 'disabled' }
  }

  let mode: 'shadow' | 'live' = opts.mode ?? (isRetroLive(db, env) ? 'live' : 'shadow')
  if (dryRun) mode = 'shadow'
  if (mode === 'live' && cfg.parentObjectiveId == null) {
    // Fail-closed: no parent id ⇒ no swimlane ⇒ orphan cards. Fall back to shadow.
    console.warn('[retro] live requested but dsr_parent_objective_id is unset — falling back to SHADOW')
    notes.push('live_refused_no_parent')
    mode = 'shadow'
  }
  base.mode = mode

  // Brake 1 — board load. Unclosed retro objectives must drain first.
  const openRetro = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM objectives
          WHERE project = ? AND origin = ? AND status IN (${OPEN_STATUSES.map(() => '?').join(',')})`,
      )
      .get(DSR_PROJECT, DSR_ORIGIN, ...OPEN_STATUSES) as { n: number }
  ).n
  if (openRetro >= cfg.wipCap) {
    console.warn(`[retro] WIP brake — ${openRetro} open retro objectives >= cap ${cfg.wipCap}; skipping run`)
    return { ...base, skipped: `wip_cap:${openRetro}>=${cfg.wipCap}` }
  }

  // Watermark: only sessions newer than the last successful run's watermark.
  const lastWatermark =
    opts.since !== undefined
      ? opts.since
      : ((db.prepare(`SELECT watermark_at FROM dsr_runs WHERE ended_at IS NOT NULL ORDER BY id DESC LIMIT 1`).get() as
          | { watermark_at: string | null }
          | undefined)?.watermark_at ?? null)

  let runId: number | null = null
  if (!dryRun) {
    runId = db
      .prepare(`INSERT INTO dsr_runs (mode, target_day, watermark_at) VALUES (?, ?, ?)`)
      .run(mode, day, lastWatermark).lastInsertRowid as number
  }
  base.run_id = runId

  // Grade past predictions BEFORE detecting new ones, so this run's floor uses
  // the freshest tuned thresholds.
  if (cfg.tunerEnabled && !dryRun) {
    try {
      const t = tunePrecision(db)
      if (t.adjustments.length) notes.push(`tuner: ${t.adjustments.map(a => `${a.signal_type} ${a.from}->${a.to}`).join(', ')}`)
    } catch (err) {
      console.warn(`[retro] tuner failed (non-fatal): ${err instanceof Error ? err.message : err}`)
    }
  }

  const det = await detectCandidates({
    db,
    env,
    day,
    since: lastWatermark,
    transcriptDir: opts.transcriptDir,
    config: cfg,
  })
  base.sessions_scanned = det.sessions_scanned
  base.raw_signals = det.raw_signals
  base.unclassified_followups = det.unclassified_followups

  // Brake 2 — sanity. A raw-candidate explosion is a detector regression, not
  // a bad day; abort loudly rather than carpet-bomb the board.
  if (det.raw_signals > cfg.sanityMax) {
    const msg = `sanity abort: ${det.raw_signals} raw signals > ${cfg.sanityMax}`
    console.error(`[retro] ${msg}`)
    if (runId != null) {
      db.prepare(`UPDATE dsr_runs SET ended_at = datetime('now'), sessions_scanned = ?, raw_signals = ?, unclassified_followups = ?, notes = ? WHERE id = ?`)
        .run(det.sessions_scanned, det.raw_signals, det.unclassified_followups, msg, runId)
    }
    return { ...base, skipped: msg }
  }

  // Floor: global floor OR the signal's tuned threshold, whichever is higher.
  const aboveFloor = det.candidates.filter(c => c.confidence >= effectiveThreshold(db, c.signal_type, cfg.minConfidence))

  // Ledger: a fingerprint EVER proposed is never re-proposed. Held candidates
  // are absent from the ledger by construction, so they do resurface.
  const ledgerHas = db.prepare('SELECT 1 FROM dsr_fingerprints WHERE fingerprint = ?')
  const fresh = aboveFloor.filter(c => !ledgerHas.get(c.fingerprint))
  base.above_floor = fresh.length
  if (aboveFloor.length !== fresh.length) {
    notes.push(`ledger_skipped:${aboveFloor.length - fresh.length}`)
  }

  // Rank BEFORE capping and BEFORE spending, so both the cost ceiling and the
  // per-run cap shed the weakest candidates.
  fresh.sort((a, b) => b.confidence - a.confidence || b.recurrence - a.recurrence)

  const cap = Math.max(0, Math.floor(opts.max ?? cfg.maxObjectives))
  const lensRunner = opts.lensRunner ?? anthropicLensRunner
  const boardContext = buildBoardContext(db)
  const poster = opts.poster ?? localhostPoster

  const insertCandidate = db.prepare(
    `INSERT INTO dsr_candidates
       (run_id, fingerprint, signal_type, confidence, recurrence, source_objective_id,
        source_session_id, transcript_path, excerpt, lens_l1, lens_l2, lens_l3, verdict)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  )
  const ledger = db.prepare(
    `INSERT INTO dsr_fingerprints (fingerprint, signal_type, first_seen_run, disposition)
     VALUES (?,?,?,?)
     ON CONFLICT(fingerprint) DO UPDATE SET
       times_seen = times_seen + 1, last_seen_at = datetime('now'), disposition = excluded.disposition`,
  )

  let cost = 0
  let promoted = 0

  for (const c of fresh) {
    // Cost ceiling — checked BEFORE dispatching each lens batch. Every drop is
    // logged; silent truncation is the failure mode this design refuses.
    if (cost >= cfg.maxCostUsd) {
      console.warn(`[retro] cost ceiling $${cfg.maxCostUsd} reached — ${fresh.length - base.candidates.length} candidate(s) not judged`)
      notes.push(`cost_ceiling_truncated:${fresh.length - base.candidates.length}`)
      break
    }
    // Per-run cap on PROMOTIONS. A cap-dropped candidate is recorded with
    // verdict='dropped_cap' and deliberately NOT ledgered, so it resurfaces.
    if (promoted >= cap) {
      base.dropped_by_cap++
      if (!dryRun && runId != null) {
        insertCandidate.run(runId, c.fingerprint, c.signal_type, c.confidence, c.recurrence,
          c.source_objective_id, c.source_session_id, c.transcript_path, c.excerpt, null, null, null, 'dropped_cap')
      }
      base.candidates.push({ ...c, verdict: 'dropped_cap' })
      console.log(`[retro] cap ${cap} reached — dropped (not ledgered, will resurface): ${c.excerpt.slice(0, 80)}`)
      continue
    }

    const gate = await runReviewGate(c, { db, lensRunner, boardContext })
    cost += gate.cost_usd

    let candidateId: number | null = null
    if (!dryRun && runId != null) {
      candidateId = insertCandidate.run(
        runId, c.fingerprint, c.signal_type, c.confidence, c.recurrence,
        c.source_objective_id, c.source_session_id, c.transcript_path, c.excerpt,
        gate.l1 ? JSON.stringify({ ...gate.l1, l1_prime: gate.l1prime }) : null,
        gate.l2 ? JSON.stringify(gate.l2) : null,
        gate.l3 ? JSON.stringify(gate.l3) : null,
        gate.outcome,
      ).lastInsertRowid as number
    }

    if (gate.outcome === 'killed') {
      base.lens_killed++
      if (!dryRun) ledger.run(c.fingerprint, c.signal_type, runId, 'killed')
      base.candidates.push({ ...c, verdict: 'killed', gate })
      continue
    }
    if (gate.outcome === 'held') {
      base.held++
      // NOT ledgered — a held candidate must resurface with recurrence bumped.
      base.candidates.push({ ...c, verdict: 'held', gate })
      continue
    }
    if (gate.outcome === 'routed_correction') {
      base.routed_corrections++
      if (!dryRun) {
        ledger.run(c.fingerprint, c.signal_type, runId, 'routed_correction')
        // L3 says the remedy is a skill/prompt/memory edit — write it to the
        // already-wired session_corrections surface so it compounds into the
        // NEXT spawn's context (context-builder.ts) without a board slot.
        if (c.source_objective_id != null) {
          try {
            recordCorrection({
              objectiveId: c.source_objective_id,
              label: `[retro] ${gate.l1?.one_line_statement || c.excerpt.slice(0, 160)} — remedy: ${gate.l3?.remedy}`,
            })
          } catch (err) {
            console.warn(`[retro] recordCorrection failed: ${err instanceof Error ? err.message : err}`)
          }
        }
      }
      base.candidates.push({ ...c, verdict: 'routed_correction', gate })
      continue
    }

    // Promoted.
    promoted++
    const payload = buildObjectivePayload(c, gate, { runId, candidateId, day, parentId: cfg.parentObjectiveId })
    const posted = await postObjective(c, gate, {
      mode,
      runId,
      candidateId,
      day,
      parentId: cfg.parentObjectiveId,
      poster,
    })
    if (!dryRun) ledger.run(c.fingerprint, c.signal_type, runId, 'promoted')
    if (posted && candidateId != null) {
      db.prepare('UPDATE dsr_candidates SET created_objective_id = ? WHERE id = ?').run(posted.id, candidateId)
    }
    if (posted) base.created++
    base.candidates.push({ ...c, verdict: 'promoted', gate, would_create: payload })
  }

  base.cost_usd = cost
  const watermark = det.newest_ended_at ?? lastWatermark
  if (!dryRun && runId != null) {
    db.prepare(
      `UPDATE dsr_runs SET ended_at = datetime('now'), sessions_scanned = ?, raw_signals = ?, above_floor = ?,
         lens_killed = ?, created = ?, held = ?, dropped_by_cap = ?, unclassified_followups = ?,
         cost_usd = ?, watermark_at = ?, notes = ? WHERE id = ?`,
    ).run(
      base.sessions_scanned, base.raw_signals, base.above_floor, base.lens_killed, base.created,
      base.held, base.dropped_by_cap, base.unclassified_followups, base.cost_usd, watermark,
      notes.length ? notes.join('; ') : null, runId,
    )
  }

  console.log(
    `[retro] ${mode} run ${runId ?? 'dry'} day=${day}: scanned=${base.sessions_scanned} raw=${base.raw_signals} ` +
      `above_floor=${base.above_floor} killed=${base.lens_killed} held=${base.held} ` +
      `routed=${base.routed_corrections} created=${base.created} dropped_cap=${base.dropped_by_cap} ` +
      `unclassified_followups=${base.unclassified_followups} cost=$${cost.toFixed(3)}`,
  )
  return base
}
