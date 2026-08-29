/**
 * Daily Session Retrospective review gate, lenses, posting, and tuner —
 * extracted from daily-retro.ts (behavior frozen).
 *
 * No transcript scan. runDailyRetro stays on the daily-retro.ts facade.
 */
import type { Database } from 'better-sqlite3'
import { getDb } from '../db/index.js'
import { DEFAULT_MIN_CONFIDENCE } from './daily-retro.detect.js'
import {
  DSR_ORIGIN,
  DSR_PROJECT,
  type RetroCandidate,
  type L1Verdict,
  type L2Verdict,
  type L3Verdict,
  type LensName,
  type LensRunner,
  type ObjectivePoster,
  type GateOutcome,
  type GateResult,
} from './daily-retro-config.js'

// ── The multi-faceted review gate (§C.4) ─────────────────────────────────────

/**
 * D-5 fix — the ids L2 must NOT be allowed to see or cite.
 *
 * A candidate is ALWAYS "a duplicate of" the objective it was mined from, so a
 * lens that can read `source: objective <ID>` out of its own evidence header
 * returns that id as `duplicate_of` and vetoes tautologically. That killed
 * 32/32 candidates on 2026-08-07 and made `dsr_live=1` a silent no-op.
 *
 * The set is the source objective plus any objective a PRIOR retro run already
 * created FROM that same source — those are self-references too, and exact
 * re-detections are already suppressed by the fingerprint ledger.
 */
export function selfExclusionIds(candidate: RetroCandidate, db?: Database): Set<number> {
  const ids = new Set<number>()
  if (candidate.source_objective_id == null) return ids
  ids.add(candidate.source_objective_id)
  if (!db) return ids
  try {
    const rows = db
      .prepare(
        `SELECT DISTINCT created_objective_id AS id FROM dsr_candidates
          WHERE source_objective_id = ? AND created_objective_id IS NOT NULL`,
      )
      .all(candidate.source_objective_id) as Array<{ id: number }>
    for (const r of rows) ids.add(r.id)
  } catch {
    // dsr_candidates may not exist yet (first run / dry-run against a copy).
  }
  return ids
}

/**
 * Drop board-context lines whose leading id is self-referential, so L2's
 * novelty corpus contains only OTHER objectives. Lines are `id | status | title`
 * (see buildBoardContext); anything else passes through untouched.
 */
/** The objective ids L2 actually has as prior art, parsed out of its corpus. */
export function boardContextIds(boardContext: string): Set<number> {
  const ids = new Set<number>()
  for (const line of (boardContext ?? '').split('\n')) {
    const m = /^(\d+)\s*\|/.exec(line)
    if (m) ids.add(Number(m[1]))
  }
  return ids
}

/**
 * D-5b — a duplicate veto only counts if it is GROUNDED.
 * A duplicate claim must cite an objective that is (a) not self-referential
 * and (b) actually in the corpus L2 was shown. `already_fixed` is untouched.
 */
export function groundDuplicateVerdict(
  l2: L2Verdict,
  opts: { exclude: Set<number>; boardIds: Set<number> },
): L2Verdict {
  if (!l2?.duplicate) return l2
  const id = l2.duplicate_of
  let why: string | null = null
  if (id == null) {
    why = 'duplicate:true with no duplicate_of — an unnamed duplicate cannot be checked'
  } else if (opts.exclude.has(id)) {
    why = `self-match on objective ${id} — self-duplicate suppressed, a candidate is always a duplicate of its own source lineage`
  } else if (opts.boardIds.size > 0 && !opts.boardIds.has(id)) {
    why = `objective ${id} is not in the board context L2 was shown`
  }
  if (!why) return l2
  console.warn(`[retro] L2 ungrounded duplicate veto ignored: ${why}`)
  return {
    ...l2,
    duplicate: false,
    duplicate_of: null,
    evidence: `[ungrounded duplicate veto ignored: ${why}] ${l2.evidence}`,
  }
}

export function filterBoardContext(boardContext: string, exclude: Set<number>): string {
  if (exclude.size === 0 || !boardContext) return boardContext
  return boardContext
    .split('\n')
    .filter(line => {
      const m = /^(\d+)\s\|/.exec(line)
      return !(m && exclude.has(Number(m[1])))
    })
    .join('\n')
}

/**
 * Three INDEPENDENT fresh-context lenses. Each is a separate invocation that
 * sees only the candidate record and the transcript window — never the other
 * lenses' verdicts, and never the detector's confidence score (anchoring would
 * collapse three opinions into one). They run in parallel.
 *
 * Vetoes are deliberately ASYMMETRIC: a single lens can kill, but promotion
 * needs all three. A false positive on the board costs a worker session; a
 * false negative just resurfaces tomorrow.
 */
export async function runReviewGate(
  candidate: RetroCandidate,
  deps: { db?: Database; lensRunner: LensRunner; boardContext?: string; excludeIds?: Set<number> },
): Promise<GateResult> {
  const { lensRunner } = deps
  const sourceLine = `source: objective ${candidate.source_objective_id ?? 'n/a'} / session ${candidate.source_session_id ?? 'n/a'}`
  // Deliberately excludes candidate.confidence — see the anchoring note above.
  const evidenceLines = [
    `signal_type: ${candidate.signal_type}`,
    `recurrence: ${candidate.recurrence}`,
    sourceLine,
    `excerpt: ${candidate.excerpt}`,
    '--- transcript window ---',
    candidate.window,
  ]
  const evidence = evidenceLines.join('\n')

  // D-5: L1/L3 legitimately use provenance; L2 must be BLIND to it, or it
  // echoes the source id back as `duplicate_of` and vetoes everything.
  const exclude = deps.excludeIds ?? selfExclusionIds(candidate, deps.db)
  const l2Evidence = evidenceLines
    .map(l => (l === sourceLine ? 'source: (withheld — judge novelty from the board context only)' : l))
    .join('\n')
  const l2Context = `${l2Evidence}\n--- board context ---\n${filterBoardContext(deps.boardContext ?? '', exclude)}`

  let cost = 0
  const [r1, r2, r3] = await Promise.all([
    lensRunner('L1', candidate, evidence),
    lensRunner('L2', candidate, l2Context),
    lensRunner('L3', candidate, evidence),
  ])
  cost += r1.cost_usd + r2.cost_usd + r3.cost_usd
  const l1 = r1.verdict as L1Verdict
  let l2 = r2.verdict as L2Verdict
  const l3 = r3.verdict as L3Verdict

  // Belt-and-braces: a self-referential id can still leak through the excerpt
  // or transcript window, and (D-5b) L2 will otherwise veto with no citation at
  // all. Both shapes are ungrounded and are discarded rather than trusted.
  l2 = groundDuplicateVerdict(l2, { exclude, boardIds: boardContextIds(l2Context) })

  // Hard veto 1 — L1 refuted. Ledger it; never revisit.
  if (l1.refuted || !l1.is_real_defect) {
    return { outcome: 'killed', l1, l1prime: null, l2, l3, cost_usd: cost, reason: 'L1 refuted / not a real defect' }
  }
  // Hard veto 2 — L2 duplicate or already fixed.
  if (l2.duplicate || l2.already_fixed) {
    return { outcome: 'killed', l1, l1prime: null, l2, l3, cost_usd: cost, reason: 'L2 duplicate / already fixed' }
  }

  // L1′ — the split-vote path. L1 says "real" but with low conviction, so a
  // SECOND independently-framed refuter (security/repro rather than
  // correctness) has to agree. 2-of-2 required.
  let l1prime: L1Verdict | null = null
  if (l1.confidence < 0.5) {
    const rp = await lensRunner("L1'", candidate, evidence)
    cost += rp.cost_usd
    l1prime = rp.verdict as L1Verdict
    if (l1prime.refuted || !l1prime.is_real_defect) {
      // Split vote → HELD, not killed and NOT ledgered: it resurfaces next run
      // with recurrence incremented. Three consecutive holds get digested to
      // Operator as one line rather than becoming an objective.
      return { outcome: 'held', l1, l1prime, l2, l3, cost_usd: cost, reason: 'L1/L1-prime split vote' }
    }
  }

  // L3 routing — divergence routes, it does not kill.
  if (l3.remedy !== 'fix_objective' || !l3.scope_ok) {
    if (l3.remedy === 'no_action') {
      return { outcome: 'killed', l1, l1prime, l2, l3, cost_usd: cost, reason: 'L3 no_action' }
    }
    return {
      outcome: 'routed_correction',
      l1,
      l1prime,
      l2,
      l3,
      cost_usd: cost,
      reason: `L3 remedy=${l3.remedy}${l3.scope_ok ? '' : ' (scope not ok)'}`,
    }
  }

  return { outcome: 'promoted', l1, l1prime, l2, l3, cost_usd: cost, reason: 'unanimous 3/3' }
}

// ── Live lens runner (Anthropic, forced tool-use) ────────────────────────────

export const LENS_TOOLS: Record<LensName, { name: string; description: string; input_schema: Record<string, unknown> }> = {
  L1: {
    name: 'record_reality_verdict',
    description: 'Record whether the claimed defect is real, after trying to refute it.',
    input_schema: {
      type: 'object',
      // Decision-bearing booleans FIRST — forced tool-use emits fields in schema
      // order, so a max_tokens hit drops only the trailing prose (risk D.6-5).
      properties: {
        refuted: { type: 'boolean' },
        is_real_defect: { type: 'boolean' },
        one_line_statement: { type: 'string' },
        evidence_quote: { type: 'string' },
        confidence: { type: 'number' },
      },
      required: ['refuted', 'is_real_defect', 'one_line_statement', 'evidence_quote', 'confidence'],
    },
  },
  "L1'": {
    name: 'record_reality_verdict',
    description: 'Second, independently-framed refutation (security / reproducibility lens).',
    input_schema: {
      type: 'object',
      properties: {
        refuted: { type: 'boolean' },
        is_real_defect: { type: 'boolean' },
        one_line_statement: { type: 'string' },
        evidence_quote: { type: 'string' },
        confidence: { type: 'number' },
      },
      required: ['refuted', 'is_real_defect', 'one_line_statement', 'evidence_quote', 'confidence'],
    },
  },
  L2: {
    name: 'record_novelty_verdict',
    description: 'Record whether this is already fixed, already tracked, or a known accepted limitation.',
    input_schema: {
      type: 'object',
      properties: {
        duplicate: { type: 'boolean' },
        already_fixed: { type: 'boolean' },
        duplicate_of: {
          type: ['integer', 'null'],
          description: 'The board-context objective id this duplicates. Null when duplicate is false.',
        },
        evidence: { type: 'string' },
      },
      required: ['duplicate', 'already_fixed', 'duplicate_of', 'evidence'],
    },
  },
  L3: {
    name: 'record_remedy_verdict',
    description: 'Record whether a fix objective is the right remedy, or something cheaper is.',
    input_schema: {
      type: 'object',
      properties: {
        remedy: { type: 'string', enum: ['fix_objective', 'skill_edit', 'memory_note', 'prompt_edit', 'no_action'] },
        scope_ok: { type: 'boolean' },
        priority: { type: 'string', enum: ['P0', 'P1', 'P2'] },
        rationale: { type: 'string' },
      },
      required: ['remedy', 'scope_ok', 'priority', 'rationale'],
    },
  },
}

export const LENS_PROMPTS: Record<LensName, string> = {
  L1:
    'Here is a claim that a real bug or issue occurred during an AI coding session. ' +
    'Try to REFUTE it against the transcript evidence below. Default to refuted:true if uncertain. ' +
    'A defect is only real if the transcript shows the system behaved incorrectly — not merely that a ' +
    'human changed their mind, gave new instructions, or that an exploratory command failed.',
  "L1'":
    'Independent second opinion, DIFFERENT framing from a correctness review: judge this claim on ' +
    'REPRODUCIBILITY and blast radius. Would this recur for another session on another day? ' +
    'If it is a one-off environmental blip or unreproducible, set refuted:true.',
  L2:
    'Is the issue described below already fixed, already tracked as an open objective, or a known ' +
    'accepted limitation? Use ONLY the board context provided as prior art. Set duplicate:true ' +
    'if and only if you can name a SPECIFIC objective id from that board context which plainly ' +
    'covers the same defect, and put that id in duplicate_of; otherwise set duplicate:false and ' +
    'duplicate_of:null. The objective the issue was OBSERVED IN is deliberately withheld — an ' +
    'issue is not a duplicate merely because it was seen while some objective was running.',
  L3:
    'Is a FIX OBJECTIVE the right remedy for the issue below — or is this better handled as a skill ' +
    'edit, a prompt edit, a memory note, or no action at all? A fix objective is right only for a ' +
    'concrete code/config defect a worker session can close. scope_ok is false if the fix is too vague ' +
    'or too large for one session.',
}

/** Rough Haiku pricing for the cost ceiling — deliberately conservative. */
const COST_PER_LENS_CALL_USD = 0.01

/**
 * The production lens runner. Anthropic Haiku with forced tool-use, one call
 * per lens. Falls back to a REFUTING verdict on any error, so an API outage
 * fails CLOSED (nothing reaches the board) rather than open.
 */
export const anthropicLensRunner: LensRunner = async (lens, _candidate, context) => {
  const apiKey = process.env.ANTHROPIC_API_KEY
  const tool = LENS_TOOLS[lens]
  const failClosed = (): { verdict: L1Verdict | L2Verdict | L3Verdict; cost_usd: number } => {
    if (lens === 'L1' || lens === "L1'") {
      return {
        verdict: { refuted: true, is_real_defect: false, one_line_statement: '', evidence_quote: '', confidence: 0 },
        cost_usd: 0,
      }
    }
    if (lens === 'L2') return { verdict: { duplicate: true, already_fixed: false, duplicate_of: null, evidence: 'lens unavailable' }, cost_usd: 0 }
    return { verdict: { remedy: 'no_action', scope_ok: false, priority: 'P2', rationale: 'lens unavailable' }, cost_usd: 0 }
  }
  if (!apiKey) {
    console.warn(`[retro] lens ${lens}: no ANTHROPIC_API_KEY — failing closed`)
    return failClosed()
  }
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        temperature: 0,
        tools: [tool],
        tool_choice: { type: 'tool', name: tool.name },
        messages: [{ role: 'user', content: `${LENS_PROMPTS[lens]}\n\n${context}` }],
      }),
      signal: AbortSignal.timeout(45_000),
    })
    if (!res.ok) {
      console.warn(`[retro] lens ${lens}: HTTP ${res.status} — failing closed`)
      return failClosed()
    }
    const data = (await res.json()) as {
      stop_reason?: string
      content?: Array<{ type: string; name?: string; input?: unknown }>
    }
    // A max_tokens stop silently drops trailing schema fields while everything
    // before still validates — treat it as an unusable verdict (risk D.6-5).
    if (data.stop_reason === 'max_tokens') {
      console.warn(`[retro] lens ${lens}: truncated at max_tokens — failing closed`)
      return failClosed()
    }
    const block = data.content?.find(b => b.type === 'tool_use' && b.name === tool.name)
    if (!block?.input) return failClosed()
    return { verdict: block.input as L1Verdict | L2Verdict | L3Verdict, cost_usd: COST_PER_LENS_CALL_USD }
  } catch (err) {
    console.warn(`[retro] lens ${lens} failed: ${err instanceof Error ? err.message : err}`)
    return failClosed()
  }
}

// ── Objective payload + posting ──────────────────────────────────────────────

/** Build the §C.5 payload. Pure — the dry-run CLI prints exactly this. */
export function buildObjectivePayload(
  candidate: RetroCandidate,
  gate: GateResult,
  ctx: { runId: number | null; candidateId: number | null; day: string; parentId: number | null },
): Record<string, unknown> {
  const statement = (gate.l1?.one_line_statement || candidate.excerpt).replace(/\s+/g, ' ').slice(0, 80)
  const description = [
    `**Detected by:** Daily Session Retrospective, run ${ctx.runId ?? 'dry-run'}, ${ctx.day}`,
    `**Signal:** ${candidate.signal_type} (confidence ${candidate.confidence.toFixed(2)}, seen in ${candidate.recurrence} session(s))`,
    `**Source sessions:** ${candidate.source_objective_id ?? 'n/a'}/${candidate.source_session_id ?? 'n/a'}`,
    `**Transcript:** ${candidate.transcript_path ?? 'n/a'}`,
    '**Evidence:**',
    `> ${(gate.l1?.evidence_quote || candidate.excerpt).replace(/\s+/g, ' ').slice(0, 600)}`,
    `**Lens verdicts:** L1 real=${gate.l1?.is_real_defect} | L2 novel=${gate.l2 ? !gate.l2.duplicate && !gate.l2.already_fixed : 'n/a'} | L3 remedy=${gate.l3?.remedy} priority=${gate.l3?.priority}`,
    `**Fingerprint:** ${candidate.fingerprint}`,
    `<!-- dsr:${JSON.stringify({ candidate_id: ctx.candidateId, fingerprint: candidate.fingerprint, run_id: ctx.runId })} -->`,
  ].join('\n')

  const payload: Record<string, unknown> = {
    title: `[retro] ${statement}`,
    description,
    project: DSR_PROJECT,
    workspace: 'personal',
    agent_context: 'cto',
    category: 'development',
    type: 'bug',
    effort: 'small',
    origin: DSR_ORIGIN,
    acceptance_criteria: [
      { id: 'repro', criterion: `Reproduce the failure: ${statement}`, type: 'functional' },
      { id: 'fix', criterion: gate.l3?.rationale?.slice(0, 300) || 'Apply the specific fix for the detected defect', type: 'functional' },
      { id: 'regress', criterion: 'Add or extend a test that fails before the fix and passes after', type: 'functional' },
    ],
  }
  if (ctx.parentId != null) payload.parent_id = ctx.parentId
  return payload
}

/** Default poster — localhost only, and only ever reached in live mode. */
export const localhostPoster: ObjectivePoster = async payload => {
  const res = await fetch('http://localhost:3002/api/internal/objectives', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify([payload]),
    signal: AbortSignal.timeout(20_000),
  })
  if (!res.ok) {
    console.error(`[retro] objective POST failed: HTTP ${res.status}`)
    return null
  }
  const data = (await res.json()) as { created?: Array<{ id: number }> }
  const id = data.created?.[0]?.id
  return id ? { id } : null
}

/**
 * Post one promoted candidate. Refuses in shadow mode and refuses without a
 * parent objective — a live run with no `dsr_parent_objective_id` would create
 * orphan cards nobody sees, so it fails closed.
 */
export async function postObjective(
  candidate: RetroCandidate,
  gate: GateResult,
  ctx: { mode: 'shadow' | 'live'; runId: number | null; candidateId: number | null; day: string; parentId: number | null; poster: ObjectivePoster },
): Promise<{ id: number } | null> {
  const payload = buildObjectivePayload(candidate, gate, ctx)
  if (ctx.mode !== 'live') {
    console.log(`[retro] SHADOW — would create: ${payload.title as string}`)
    return null
  }
  if (ctx.parentId == null) {
    console.warn('[retro] live mode without dsr_parent_objective_id — refusing to post (fail-closed)')
    return null
  }
  return ctx.poster(payload)
}

// ── §C.6 precision tuner — deterministic, bounded, no LLM ────────────────────

export interface TuneResult {
  graded: number
  adjustments: Array<{ signal_type: string; from: number; to: number; reason: string }>
  lens_misses_recorded: number
}

/**
 * Grade past predictions and adjust each signal's threshold. Runs at the HEAD
 * of each retro run (it grades yesterday's predictions before detecting today's
 * candidates), so no extra scheduling exists. Read-only against the board.
 *
 * There is deliberately NO LLM in this loop: an automated tuner that can move
 * its own thresholds must be auditable line-by-line. Lens PROMPTS are never
 * self-edited — accumulated misses raise one human-reviewed [retro-meta]
 * objective instead.
 */
export function tunePrecision(db: Database = getDb()): TuneResult {
  const rows = db
    .prepare(
      `SELECT c.id AS candidate_id, c.signal_type, o.status, o.ai_review_verdict, o.created_at
         FROM dsr_candidates c
         JOIN objectives o ON o.id = c.created_objective_id
        WHERE c.created_objective_id IS NOT NULL
          AND o.created_at <= datetime('now','-72 hours')
          AND o.created_at >= datetime('now','-30 days')`,
    )
    .all() as Array<{ candidate_id: number; signal_type: string; status: string; ai_review_verdict: string | null; created_at: string }>

  const stats = new Map<string, { tp: number; fp: number; stale: number; misses: number[] }>()
  const staleCutoff = Date.now() - 14 * 24 * 3600 * 1000
  for (const r of rows) {
    let s = stats.get(r.signal_type)
    if (!s) {
      s = { tp: 0, fp: 0, stale: 0, misses: [] }
      stats.set(r.signal_type, s)
    }
    if (r.status === 'done' && (r.ai_review_verdict === 'pass' || r.ai_review_verdict == null)) {
      s.tp++
    } else if (r.status === 'cancelled') {
      s.fp++
      s.misses.push(r.candidate_id)
    } else if (['queue', 'review', 'working', 'ai_review', 'planning'].includes(r.status)) {
      if (Date.parse(r.created_at) < staleCutoff) s.stale++
    }
  }

  const adjustments: TuneResult['adjustments'] = []
  let missesRecorded = 0
  const upsert = db.prepare(
    `INSERT INTO dsr_signal_stats (signal_type, window_start, tp, fp, stale, precision, current_threshold, threshold_updated_at, note)
     VALUES (?, datetime('now','-30 days'), ?, ?, ?, ?, ?, datetime('now'), ?)
     ON CONFLICT(signal_type) DO UPDATE SET
       window_start = excluded.window_start, tp = excluded.tp, fp = excluded.fp,
       stale = excluded.stale, precision = excluded.precision,
       current_threshold = excluded.current_threshold,
       threshold_updated_at = excluded.threshold_updated_at, note = excluded.note`,
  )
  const insertMiss = db.prepare(
    `INSERT INTO dsr_lens_misses (lens, candidate_id, board_outcome, detail) VALUES (?, ?, ?, ?)`,
  )
  const existingMiss = db.prepare('SELECT 1 FROM dsr_lens_misses WHERE candidate_id = ? AND lens = ?')

  for (const [signal, s] of stats) {
    const n = s.tp + s.fp
    // Stale counts against precision at half weight (§C.6).
    const precision = n > 0 ? s.tp / (n + s.stale * 0.5) : null
    const prior = db.prepare('SELECT current_threshold FROM dsr_signal_stats WHERE signal_type = ?').get(signal) as
      | { current_threshold: number }
      | undefined
    let threshold = prior?.current_threshold ?? DEFAULT_MIN_CONFIDENCE
    const before = threshold
    let note = ''
    // Sample floor n>=6 prevents thrashing on 1-2 data points. One adjustment
    // per signal per run, max — the branches are mutually exclusive.
    if (precision != null && precision < 0.3 && n >= 10) {
      threshold = 1.01 // auto-disable; Operator must re-enable
      note = `auto-disabled: precision ${precision.toFixed(2)} over ${n} samples`
      console.warn(`[retro] ALERT — signal '${signal}' auto-disabled (${note})`)
    } else if (precision != null && precision < 0.5 && n >= 6) {
      threshold = Math.min(0.9, threshold + 0.05)
      note = `raised: precision ${precision.toFixed(2)}`
    } else if (precision != null && precision > 0.85 && n >= 6) {
      threshold = Math.max(0.4, threshold - 0.05)
      note = `lowered: precision ${precision.toFixed(2)}`
    }
    if (threshold !== before) adjustments.push({ signal_type: signal, from: before, to: threshold, reason: note })
    upsert.run(signal, s.tp, s.fp, s.stale, precision, threshold, note || null)

    // Every FP is a lens miss — attributed to L1 (it judged the defect real).
    for (const cid of s.misses) {
      if (existingMiss.get(cid, 'L1')) continue
      insertMiss.run('L1', cid, 'cancelled', `signal=${signal}`)
      missesRecorded++
    }
  }

  return { graded: rows.length, adjustments, lens_misses_recorded: missesRecorded }
}

/** Effective floor for a signal = MAX(global floor, tuned threshold). */
export function effectiveThreshold(db: Database, signal: string, globalFloor: number): number {
  try {
    const row = db.prepare('SELECT current_threshold FROM dsr_signal_stats WHERE signal_type = ?').get(signal) as
      | { current_threshold: number }
      | undefined
    return Math.max(globalFloor, row?.current_threshold ?? 0)
  } catch {
    return globalFloor
  }
}

