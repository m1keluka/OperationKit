// ─────────────────────────────────────────────────────────────────────────────
// Design Arena (obj 594) — best-of-N UI generation, bolted ADDITIVELY onto the
// existing spawn → build → ai_review loop.
//
// Mechanism (research 06-design-arena.md): for an arena-ELIGIBLE + arena-ENABLED UI
// objective, fan out N=3–4 generators each seeded with a DISTINCT named layout
// archetype (same content brief + same tokens, only FORM varies) → R9 static
// pre-filter (free) → render survivors at 1440+390 → grade each against the SAME
// R1–R9 vision rubric production enforces → rank → ONE pairwise comparison only to
// break a clean top-2 tie → promote the winner into the EXISTING ai_review path,
// unchanged. The arena sits BEFORE ai_review, never instead of it.
//
// DORMANCY: every entry point is gated by `shouldRunArena(objective)`, which is
// false by default (the `.ui-gate.json` `arena` block is absent/disabled). With it
// off, NOTHING here runs and the spawn path is byte-identical to today.
//
// REUSE, do not reimplement: this module imports the shipped primitives
// (buildDesignContextBlock, isUiObjective, loadGateConfig, VISION_RUBRIC). The only
// NEW things are the diversity seed, the ranker, and the orchestration glue.
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'fs'
import path from 'path'
import { execFileSync } from 'child_process'
import type { Objective } from '@command-center/shared'
import {
  buildDesignContextBlock,
  isUiObjective,
  loadGateConfig,
  VISION_RUBRIC,
} from './design-context.js'
import { PROJECTS_DIR } from '../config.js'

// ── Layout archetypes (research §2) ──────────────────────────────────────────
// The #1 failure of "generate N options" is N near-identical skins. Diversity must
// be INSTRUCTED, not hoped for: each generator gets a distinct, NAMED archetype as a
// hard constraint, forcing structurally different information hierarchies. These four
// are the prototype's proven seeds (terminal / editorial / cockpit / stacked).

export interface Archetype {
  key: string
  name: string
  /** Hard-constraint seed appended to the generator prompt. */
  seed: string
}

export const ARCHETYPES: Archetype[] = [
  {
    key: 'terminal',
    name: 'command terminal / data-dense',
    seed:
      'Layout archetype (HARD CONSTRAINT, not a suggestion): COMMAND TERMINAL / DATA-DENSE. ' +
      'A utilitarian, information-dense surface — hairline-divided rows, eyebrow caps over large ' +
      'monospace numerals, tight 4/8px grid, no decorative chrome. Maximize signal per pixel. ' +
      'Think a trading/ops terminal, not a marketing page.',
  },
  {
    key: 'editorial',
    name: 'editorial / hero-led',
    seed:
      'Layout archetype (HARD CONSTRAINT, not a suggestion): EDITORIAL / HERO-LED. ' +
      'Resolve the surface around ONE unmistakable focal point (the single most important numeral ' +
      'or message rendered large), then demote everything beneath it. Confident asymmetry, generous ' +
      'rhythm, a clear reading order top-to-bottom.',
  },
  {
    key: 'cockpit',
    name: 'KPI cockpit / left-rail app shell',
    seed:
      'Layout archetype (HARD CONSTRAINT, not a suggestion): KPI COCKPIT / LEFT-RAIL APP SHELL. ' +
      'A persistent left navigation rail + a grid of KPI tiles up top + working area below. ' +
      'An application shell, not a document. Ensure the rail/nav adapts cleanly at 390px (NO fixed ' +
      'overlay colliding with content).',
  },
  {
    key: 'stacked',
    name: 'progressive stacked / mobile-first',
    seed:
      'Layout archetype (HARD CONSTRAINT, not a suggestion): PROGRESSIVE STACKED / MOBILE-FIRST. ' +
      'Design the single-column mobile experience FIRST (header > stats > actions > detail), then ' +
      'let it breathe up to desktop WITHOUT leaving large empty side gutters. ≥44px tap targets, ' +
      'flawless at 390px.',
  },
]

/** Default fan-out width. Research §2: N=3–4 is the sweet spot; N=2 too coarse, N>5
 *  diminishing returns + linear cost. */
export const DEFAULT_ARENA_N = 4

// ── Runtime flag (reuses the #51 .ui-gate.json control-plane) ─────────────────

/**
 * Is the arena master switch ON for this project? Reads the SAME `.ui-gate.json`
 * control-plane as the gate (via `loadGateConfig`, so it shares the 5s TTL cache and
 * the live-edit-without-restart property — no second mechanism). Resolution mirrors
 * `getEffectiveGateMode`:
 *   - no `arena` block / `enabled:false`        ⇒ false (DEFAULT — dormant)
 *   - `enabled:true`, empty allowlist (global)  ⇒ true for every project
 *   - `enabled:true`, project ∈ allowlist       ⇒ true
 *   - `enabled:true`, project ∉ a non-empty list ⇒ false
 * Env fallback (`CC_ARENA_ENABLED=1|true`) applies ONLY when no arena block is present
 * in the file, so file config always wins.
 */
export function isArenaEnabled(project: string | null | undefined): boolean {
  const { arena } = loadGateConfig()
  if (!arena) {
    const env = (process.env.CC_ARENA_ENABLED || '').trim().toLowerCase()
    return env === '1' || env === 'true' || env === 'on'
  }
  if (!arena.enabled) return false
  if (arena.platforms.length === 0) return true
  return !!project && arena.platforms.includes(project)
}

// ── Eligibility (research §5) ─────────────────────────────────────────────────
// Arena mode is reserved for net-new, high-value, visually-central surfaces
// (dashboards / landing / primary detail views). Bug-fixes, copy tweaks, and
// back-office checkboxes stay single-worker — the N× cost is pointed only where
// design quality moves the needle.

export interface ArenaEligibility {
  eligible: boolean
  reason: string
}

/** Words that mark an objective as maintenance/non-net-new ⇒ NOT arena-eligible. */
const NON_NETNEW = /\b(fix|fixes|fixed|bug|hotfix|patch|typo|copy[\s-]?tweak|reword|rename|refactor|migrat|back[\s-]?office|cleanup|chore|revert|regression)\b/i
/** Words that signal a visually-central, high-value surface ⇒ inference path. */
const VISUALLY_CENTRAL = /\b(dashboard|landing|homepage|home page|hero|marketing|portal|overview|detail view|detail page|primary view|app shell|onboarding|pricing page|signup|sign[\s-]?up page)\b/i

/** Explicit per-objective arena opt-in, kept loose so callers/UI can flag it without
 *  a schema migration: an `arena:true` field, an `[arena]` marker in the title, or an
 *  acceptance criterion with `method:'arena'`. */
function hasExplicitArenaFlag(objective: Objective): boolean {
  const anyObj = objective as unknown as Record<string, unknown>
  if (anyObj.arena === true) return true
  if (typeof objective.title === 'string' && /\[arena\]/i.test(objective.title)) return true
  // acceptance_criteria can reach here as a parsed AcceptanceCriterion[] (mapped
  // rows) OR the raw JSON string stored in SQLite (the spawn/resume path passes
  // unmapped rows straight through — see session-manager `SELECT * FROM objectives`).
  // `?? []` does NOT normalize a string (a string is not null/undefined), so
  // `.some()` would throw ".some is not a function" and crash the spawn. Mirror
  // prompt-builder's obj-1180 guard: normalize to an array first (obj-1216).
  let crits: unknown = objective.acceptance_criteria
  if (typeof crits === 'string') {
    try { crits = JSON.parse(crits) } catch { crits = [] }
  }
  if (!Array.isArray(crits)) crits = []
  return (crits as Array<Record<string, unknown>>).some(
    (c) => c && (c.method === 'arena' || c.type === 'arena'),
  )
}

/** Explicit per-objective arena opt-OUT — always wins over inference. */
function hasExplicitArenaOptOut(objective: Objective): boolean {
  const anyObj = objective as unknown as Record<string, unknown>
  if (anyObj.arena === false) return true
  return typeof objective.title === 'string' && /\[no[\s-]?arena\]/i.test(objective.title)
}

/**
 * Decide whether an objective is arena-ELIGIBLE (independent of whether the arena is
 * ENABLED — `shouldRunArena` ANDs the two). An explicit flag wins; otherwise infer
 * from `isUiObjective()` + a value/visual hint, excluding maintenance work.
 */
export function isArenaEligible(objective: Objective): ArenaEligibility {
  if (hasExplicitArenaOptOut(objective)) {
    return { eligible: false, reason: 'explicit arena opt-out' }
  }
  if (!isUiObjective(objective)) {
    return { eligible: false, reason: 'not a UI objective' }
  }
  if (hasExplicitArenaFlag(objective)) {
    return { eligible: true, reason: 'explicit arena flag' }
  }
  const haystack = `${objective.title || ''} ${objective.description || ''}`
  if (NON_NETNEW.test(haystack)) {
    return { eligible: false, reason: 'maintenance/non-net-new surface (bug-fix / copy / refactor)' }
  }
  if (!VISUALLY_CENTRAL.test(haystack)) {
    return {
      eligible: false,
      reason: 'UI objective but no high-value/visually-central hint; defaults to single-worker',
    }
  }
  return { eligible: true, reason: 'inferred: UI objective on a visually-central, high-value surface' }
}

/**
 * The SINGLE gate the spawn path consults. True ⇒ run the arena instead of one
 * worker; false ⇒ behave EXACTLY as today. False by default (arena disabled), so the
 * spawn path is byte-identical when dormant.
 */
export function shouldRunArena(objective: Objective): boolean {
  return isArenaEnabled(objective.project) && isArenaEligible(objective).eligible
}

// ── Orchestrator: archetype-seeded fan-out (research §5, addition #1) ──────────

export interface VariantSpec {
  archetypeKey: string
  archetypeName: string
  /** Full generator prompt = the shipped design-context block + the archetype seed. */
  prompt: string
}

/**
 * Build N variant generator specs for an arena objective. Each REUSES the shipped
 * `buildDesignContextBlock(objective)` verbatim (same tokens, same anti-slop doctrine,
 * same self-critique mandate) and appends a DISTINCT archetype seed — so every
 * generator gets the SAME content brief + SAME tokens and only the FORM varies. The
 * generators are independent (no shared draft); the caller spawns each in its own
 * session context.
 */
export function buildVariantSpecs(objective: Objective, n: number = DEFAULT_ARENA_N): VariantSpec[] {
  const count = Math.max(2, Math.min(n, ARCHETYPES.length))
  const designBlock = buildDesignContextBlock(objective).join('\n')
  return ARCHETYPES.slice(0, count).map((arch) => ({
    archetypeKey: arch.key,
    archetypeName: arch.name,
    prompt: [
      designBlock,
      '',
      `## Design Arena — your assigned layout archetype: ${arch.name}`,
      'You are ONE of several independent generators building the SAME surface from the SAME content',
      'and the SAME design tokens. Only the FORM is yours to decide, and it is FIXED by the archetype',
      'below. Do NOT drift toward a generic centered-card grid — commit to the archetype.',
      '',
      arch.seed,
      '',
      '### Arena scorecard (REQUIRED in your final summary)',
      'You already screenshot your surface at 1440px AND 390px for the self-critique above. Using',
      'those shots, grade YOUR variant against the R1–R9 rubric and emit EXACTLY this machine-readable',
      'line so the arena ranker can score you (R1–R7 pass/warn/fail; R8/R9 PASS/FAIL):',
      '<scorecard>{"R1":"pass|warn|fail","R2":"...","R3":"...","R4":"...","R5":"...","R6":"...","R7":"...","R8":"PASS|FAIL","R9":"PASS|FAIL"}</scorecard>',
      'Be honest — the arena re-checks R9 statically and the winner still faces the independent ai_review.',
    ].join('\n'),
  }))
}

// ── Ranker: absolute R1–R9 grade → rank → tiebreak (research §3, addition #2) ──

export type DimVerdict = 'pass' | 'warn' | 'fail'
export type GateVerdict = 'PASS' | 'FAIL'

/** Per-variant scorecard — the structured grade for one variant. R1–R7 are
 *  pass/warn/fail; R8 (accessibility) and R9 (token conformance) are binary hard
 *  gates. Mirrors the prototype's `results/ranking.json` dimension shape. */
export interface VariantScorecard {
  variant: string
  file: string
  archetype?: string
  dimensions: {
    R1: DimVerdict
    R2: DimVerdict
    R3: DimVerdict
    R4: DimVerdict
    R5: DimVerdict
    R6: DimVerdict
    R7: DimVerdict
    R8: GateVerdict
    R9: GateVerdict
  }
}

export interface ScoredVariant extends VariantScorecard {
  /** Sum over R1–R7 of pass=2 / warn=1 / fail=0 (max 14). */
  score: number
  verdict: GateVerdict
  failReasons: string[]
}

const DIM_POINTS: Record<DimVerdict, number> = { pass: 2, warn: 1, fail: 0 }
const R1_R7: Array<keyof VariantScorecard['dimensions']> = ['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7']

/**
 * Score ONE variant against the rubric, applying the EXACT rules production enforces:
 * R1–R7 graded pass=2/warn=1/fail=0 (max 14); any R1–R7 FAIL ⇒ verdict FAIL; R8
 * accessibility is a HARD gate; R9 token conformance is BINARY; ≥3 warns across R1–R7
 * trips the slop-accumulation FAIL. This is a faithful superset of the single-surface
 * gate — the arena just runs it N times.
 */
export function scoreVariant(card: VariantScorecard): ScoredVariant {
  const d = card.dimensions
  let score = 0
  let warns = 0
  const failReasons: string[] = []
  for (const k of R1_R7) {
    const v = d[k] as DimVerdict
    score += DIM_POINTS[v]
    if (v === 'warn') warns++
    if (v === 'fail') failReasons.push(`${k} fail`)
  }
  if (d.R8 === 'FAIL') failReasons.push('R8 accessibility hard-gate FAIL')
  if (d.R9 === 'FAIL') failReasons.push('R9 token/primitive conformance FAIL (binary)')
  if (warns >= 3) failReasons.push(`≥3 WARNs across R1–R7 (${warns}) — slop-accumulation FAIL`)
  const verdict: GateVerdict = failReasons.length > 0 ? 'FAIL' : 'PASS'
  return { ...card, score, verdict, failReasons }
}

export interface ArenaRanking {
  /** All variants, ranked: PASS before FAIL, then score desc, then stable input order. */
  ranking: ScoredVariant[]
  /** Highest-ranked PASS variant (the provisional winner), or null if none pass. */
  winner: ScoredVariant | null
  /** True iff the top two PASS variants are tied on score — the one case that needs a
   *  single pairwise comparison to break (research §3). */
  tiebreakNeeded: boolean
  tiebreakPair?: [ScoredVariant, ScoredVariant]
}

/**
 * Grade + rank all variants. Sort PASS-before-FAIL, then by score desc, preserving
 * input order on ties (stable). The winner is the top PASS variant; a clean top-2
 * PASS tie (equal score) flags `tiebreakNeeded` so the caller runs ONE pairwise
 * comparison. Does NOT run a full pairwise tournament.
 */
export function rankVariants(cards: VariantScorecard[]): ArenaRanking {
  const scored = cards.map(scoreVariant)
  const ranking = scored
    .map((v, i) => ({ v, i }))
    .sort((a, b) => {
      const ap = a.v.verdict === 'PASS' ? 0 : 1
      const bp = b.v.verdict === 'PASS' ? 0 : 1
      if (ap !== bp) return ap - bp
      if (b.v.score !== a.v.score) return b.v.score - a.v.score
      return a.i - b.i
    })
    .map((x) => x.v)

  const passes = ranking.filter((v) => v.verdict === 'PASS')
  const winner = passes[0] ?? null
  const tiebreakNeeded = passes.length >= 2 && passes[0].score === passes[1].score
  return {
    ranking,
    winner,
    tiebreakNeeded,
    tiebreakPair: tiebreakNeeded ? [passes[0], passes[1]] : undefined,
  }
}

/**
 * Build the SINGLE pairwise tiebreak prompt (only used when `tiebreakNeeded`). Asks
 * the model the one thing the absolute rubric is weak at — fuzzy taste — between the
 * two clean top finishers. The result is logged as the tiebreak rationale.
 */
export function buildPairwiseTiebreakPrompt(
  objective: Objective,
  a: ScoredVariant,
  b: ScoredVariant,
): string {
  return [
    `Two UI variants for "${objective.title}" both scored a clean ${a.score}/14 against the R1–R9 rubric.`,
    'The absolute rubric cannot separate them. Compare them ONLY on the dimensions a rubric is weak at:',
    'visual hierarchy at a glance, brand fit, and overall taste/polish.',
    '',
    `Variant A: ${a.variant} (${a.archetype ?? '—'}) — ${a.file}`,
    `Variant B: ${b.variant} (${b.archetype ?? '—'}) — ${b.file}`,
    '',
    'Look at both rendered screenshots (1440 + 390). Answer with exactly:',
    '<winner>A|B</winner>',
    '<rationale>one or two sentences on WHY, in concrete visual terms</rationale>',
  ].join('\n')
}

// ── R9 static pre-filter (free; eliminate before any render) ──────────────────

export interface R9Result {
  pass: boolean
  output: string
}

function conformanceScriptPath(): string {
  // Resolve via PROJECTS_DIR (the codebase's path convention — no __dirname under ESM).
  // The shipped R9 linter lives in the command-center-infra checkout's scripts/ dir.
  // Overridable by UI_CONFORMANCE_SCRIPT (used by tests / alternate deployments).
  if (process.env.UI_CONFORMANCE_SCRIPT) return process.env.UI_CONFORMANCE_SCRIPT
  return path.join(PROJECTS_DIR, 'command-center-infra', 'scripts', 'ui-conformance.sh')
}

/**
 * Run the binary R9 static check (`scripts/ui-conformance.sh`) over a variant's files
 * as a FREE pre-filter — eliminate non-conformant variants for ~$0 before spending a
 * single browser render. Exit 0 ⇒ pass; any hit (exit 1) ⇒ R9 FAIL.
 */
export function runR9PreFilter(files: string[], scriptPath: string = conformanceScriptPath()): R9Result {
  if (files.length === 0) return { pass: true, output: 'no files to check' }
  try {
    const output = execFileSync('bash', [scriptPath, ...files], { encoding: 'utf-8' })
    return { pass: true, output }
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; status?: number }
    return { pass: false, output: (err.stdout || '') + (err.stderr || '') }
  }
}

// ── Variant judge (reuses VISION_RUBRIC verbatim) ─────────────────────────────

/**
 * Build the per-variant judge prompt. Grades the rendered screenshots against the
 * SAME `VISION_RUBRIC` (R1–R9) the production gate uses — imported verbatim, no drift.
 * The judge emits a structured `<scorecard>` JSON block the ranker consumes, plus the
 * familiar `<verdict>/<findings>` tags (`state-poller.ts:extractReviewerOutput` shape).
 */
export function buildVariantJudgePrompt(
  objective: Objective,
  variant: { name: string; archetype: string; screenshots: string[] },
): string {
  return [
    `# Design Arena — judge variant "${variant.name}" (${variant.archetype})`,
    `Surface: ${objective.title}`,
    '',
    'Grade the rendered screenshots (1440px + 390px) against this rubric, VERBATIM:',
    ...VISION_RUBRIC.map((r) => `  ${r}`),
    '',
    'Scoring: R1–R7 are pass/warn/fail; R8 and R9 are PASS/FAIL hard gates.',
    'R1–R7 score pass=2/warn=1/fail=0 (max 14). Any R1–R7 fail, R8 FAIL, R9 FAIL, or ≥3 warns ⇒ verdict FAIL.',
    '',
    'Screenshots:',
    ...variant.screenshots.map((s) => `  - ${s}`),
    '',
    'Emit EXACTLY:',
    '<scorecard>{"R1":"pass|warn|fail",...,"R7":"...","R8":"PASS|FAIL","R9":"PASS|FAIL"}</scorecard>',
    '<verdict>pass|fail</verdict>',
    '<findings>per-dimension evidence</findings>',
    '<mode>browser</mode>',
  ].join('\n')
}

/** Parse a judge transcript's `<scorecard>` JSON into a `VariantScorecard`. Returns
 *  null if absent/malformed (the orchestrator then treats the variant as FAIL). */
export function parseVariantScorecard(
  transcript: string,
  variant: { name: string; file: string; archetype?: string },
): VariantScorecard | null {
  const m = transcript.match(/<scorecard>([\s\S]*?)<\/scorecard>/i)
  if (!m) return null
  try {
    const raw = JSON.parse(m[1].trim()) as Record<string, string>
    const dim = (k: string): DimVerdict => {
      const v = (raw[k] || '').toLowerCase()
      return v === 'pass' || v === 'warn' || v === 'fail' ? (v as DimVerdict) : 'fail'
    }
    const gate = (k: string): GateVerdict => ((raw[k] || '').toUpperCase() === 'PASS' ? 'PASS' : 'FAIL')
    return {
      variant: variant.name,
      file: variant.file,
      archetype: variant.archetype,
      dimensions: {
        R1: dim('R1'), R2: dim('R2'), R3: dim('R3'), R4: dim('R4'),
        R5: dim('R5'), R6: dim('R6'), R7: dim('R7'),
        R8: gate('R8'), R9: gate('R9'),
      },
    }
  } catch {
    return null
  }
}

// ── Orchestration entrypoint (deps injected so it is fully unit-testable) ─────

export interface VariantBuild {
  archetypeKey: string
  archetypeName: string
  /** Files the generator produced (for the R9 pre-filter). */
  files: string[]
  /** A handle the render/judge deps understand (e.g. an entry HTML path / session id). */
  handle: string
}

export interface ArenaDeps {
  /** Spawn a generator session for a spec; resolve once it has produced its variant. */
  generate: (spec: VariantSpec, index: number) => Promise<VariantBuild>
  /** Render a built variant at 1440+390; resolve to screenshot paths. */
  render: (build: VariantBuild) => Promise<string[]>
  /** Grade a rendered variant against R1–R9; resolve to its scorecard. */
  judge: (build: VariantBuild, screenshots: string[]) => Promise<VariantScorecard | null>
  /** Override the R9 pre-filter (defaults to `runR9PreFilter`). */
  preFilter?: (files: string[]) => R9Result
  /** Run the single pairwise tiebreak; resolve to the WINNING variant name. */
  pairwise?: (a: ScoredVariant, b: ScoredVariant) => Promise<string>
}

export interface ArenaResult {
  objectiveId: number
  winner: ScoredVariant | null
  ranking: ScoredVariant[]
  tiebreak?: { pair: [string, string]; winner: string }
  r9Eliminated: string[]
}

/**
 * Run the full arena loop: fan out N archetype-seeded generators → R9 pre-filter →
 * render survivors → judge each against R1–R9 → rank → single pairwise tiebreak if a
 * clean top-2 tie → return the winner + per-variant scorecard. The deps are injected
 * so the orchestration is exercised end-to-end in unit tests with fakes, and wired to
 * the real CC session/Playwright primitives in production (`buildArenaDeps`).
 */
export async function runArena(
  objective: Objective,
  n: number,
  deps: ArenaDeps,
): Promise<ArenaResult> {
  const specs = buildVariantSpecs(objective, n)
  // Generators are independent — fan out in parallel (wall-clock ≈ one build).
  const builds = await Promise.all(specs.map((s, i) => deps.generate(s, i)))
  return evaluateArena(objective, builds, deps)
}

/**
 * Evaluate ALREADY-BUILT variants → winner. This is the production-callable half of
 * the loop: in the real pipeline the generators are spawned at spawn-time
 * (`startArenaSession`) and this runs at COHORT-COMPLETION (from the poller, via
 * `arena-lifecycle.ts`), so it does NOT re-generate. Steps: R9 pre-filter (free) →
 * render survivors → judge each against R1–R9 → rank → single pairwise tiebreak only
 * on a clean top-2 tie. `runArena` delegates here after generating.
 */
export async function evaluateArena(
  objective: Objective,
  builds: VariantBuild[],
  deps: Omit<ArenaDeps, 'generate'>,
): Promise<ArenaResult> {
  const preFilter = deps.preFilter ?? ((files: string[]) => runR9PreFilter(files))
  const r9Eliminated: string[] = []
  const survivors: VariantBuild[] = []
  for (const b of builds) {
    if (preFilter(b.files).pass) survivors.push(b)
    else r9Eliminated.push(b.archetypeName)
  }

  const cards: VariantScorecard[] = []
  for (const b of survivors) {
    const shots = await deps.render(b)
    const card = await deps.judge(b, shots)
    // A variant that fails to grade is recorded as a hard FAIL, not dropped silently.
    cards.push(
      card ?? {
        variant: b.archetypeName,
        file: b.handle,
        archetype: b.archetypeName,
        dimensions: { R1: 'fail', R2: 'fail', R3: 'fail', R4: 'fail', R5: 'fail', R6: 'fail', R7: 'fail', R8: 'FAIL', R9: 'FAIL' },
      },
    )
  }

  const ranked = rankVariants(cards)
  let tiebreak: ArenaResult['tiebreak'] | undefined
  let winner = ranked.winner
  if (ranked.tiebreakNeeded && ranked.tiebreakPair && deps.pairwise) {
    const [a, b] = ranked.tiebreakPair
    const winnerName = await deps.pairwise(a, b)
    winner = [a, b].find((v) => v.variant === winnerName) ?? a
    tiebreak = { pair: [a.variant, b.variant], winner: winner.variant }
  }

  return {
    objectiveId: objective.id,
    winner,
    ranking: ranked.ranking,
    tiebreak,
    r9Eliminated,
  }
}

/** Serialize an arena result to the prototype's `ranking.json` shape (for the artifact
 *  written alongside the winner before it enters ai_review). */
export function toRankingArtifact(objective: Objective, result: ArenaResult): Record<string, unknown> {
  return {
    arena: `obj-${objective.id}-design-arena`,
    objective: objective.title,
    project: objective.project,
    judge: 'absolute R1-R9 vision rubric (verbatim from design-context.ts VISION_RUBRIC)',
    scoring: 'R1-R7 pass=2/warn=1/fail=0 (max 14); R8 hard gate; R9 binary; >=3 warns across R1-R7 => FAIL',
    viewports: ['1440', '390'],
    r9_eliminated: result.r9Eliminated,
    tiebreak: result.tiebreak ?? null,
    ranking: result.ranking.map((v, i) => ({
      rank: i + 1,
      variant: v.variant,
      file: v.file,
      score: v.score,
      verdict: v.verdict,
      failReasons: v.failReasons,
      dimensions: v.dimensions,
    })),
    winner: result.winner?.variant ?? null,
  }
}

/** Persist the arena artifact next to the objective's memory dir (best-effort). */
export function writeRankingArtifact(dir: string, artifact: Record<string, unknown>): string | null {
  try {
    fs.mkdirSync(dir, { recursive: true })
    const p = path.join(dir, 'arena-ranking.json')
    fs.writeFileSync(p, JSON.stringify(artifact, null, 2))
    return p
  } catch {
    return null
  }
}
