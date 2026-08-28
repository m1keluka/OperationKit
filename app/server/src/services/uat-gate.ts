// ── Adversarial UAT acceptance gate (Rec #3 of the obj-2319 Kitchen-Loop roadmap) ──
//
// THE GAP THIS CLOSES. Today the review gate only *reads the diff*; it never RUNS
// the artifact. The Kitchen Loop's proof case (Roy 2026, KL-2/KL-7) is a service
// that ships 38 green unit tests yet fails every real job — exactly the failure a
// compile+test floor (Rec #1) cannot see. This gate ACTUALLY EXECUTES the artifact
// against a worker-authored, runnable SEALED TEST CARD and grades by EXACT exit
// codes, then mechanically proves the evaluator did not cheat.
//
// FOUR-VERDICT TAXONOMY:
//   • PASS            — every card step's actual exit code matched its expected code.
//   • PRODUCT_FAIL    — a step's exit code did NOT match (the artifact is broken even
//                       though it may compile + have green author tests).
//   • UAT_SPEC_FAIL   — the card itself is invalid (manual-edit commands like
//                       vim / sed -i / cat >, unresolved <placeholders>, or no
//                       negative test). LOGGED, NON-blocking — a bad card must not
//                       gate work; it is the worker's signal to write a real card.
//   • EVAL_CHEAT_FAIL — after evaluation, a `git diff` of the isolated worktree shows
//                       the evaluator session TOUCHED a product file (e.g. weakened a
//                       test, stubbed a fix). Mechanical; OVERRIDES the product verdict;
//                       flagged for a human.
//
// HOW IT STAYS HONEST (KL design): the blind evaluator session is the *vehicle* that
// runs the card in an isolated worktree with an information wall (ONLY the card — no
// diff, no ticket — mandate = DISCONFIRM). But the VERDICT is re-derived DETERMINISTICALLY
// from the captured exit codes and the git diff, never from the LLM's say-so — so a
// hallucinating or cheating evaluator cannot manufacture a PASS.
//
// HARD SAFETY (this code runs the platform that runs every objective):
//   1. Feature flag — OFF by default (env CC_UAT_GATE_ENABLED or a `uat_gate_enabled`
//      settings row). OFF ⇒ no-op, behaviour identical to today.
//   2. Per-project opt-in — even when the flag is on, the gate only runs for a project
//      with an explicit `uat_gate_config:<project>` row (mirrors the deterministic floor).
//   3. SHADOW MODE by default — even when active, the gate RECORDS its verdict and does
//      NOT block any transition until `uat_gate_blocking` is explicitly set. Shadow first,
//      enforce later (the floor's discipline).
//   4. Kill switch — env CC_UAT_GATE_KILLED or a `uat_gate_killed` row disarms everything,
//      everywhere, with one settings write and no code edit.
//   5. The blind-evaluator spawn is fully INJECTABLE and best-effort: a spawn failure is
//      swallowed (the deterministic verdict still stands), and tests never spawn tmux.
//
// REUSE: the card steps execute through the deterministic floor's command-runner
// (CommandRunner / execRunner) — the same battle-tested exec+truncate path as the floor.

import { execSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import type { Database } from 'better-sqlite3'
import {
  execRunner,
  DEFAULT_TIMEOUT_MS,
  isCommandCenterTarget,
  type CommandRunner,
  type FloorCommandResult,
} from './deterministic-floor.js'
import type { Canary } from './canary-harness.js'
import { pickAccount } from './account-router.js'
import { spawnInTmux } from './session-manager.js'

// ── Verdict taxonomy ──────────────────────────────────────────────────────────
export type UatVerdict = 'PASS' | 'PRODUCT_FAIL' | 'UAT_SPEC_FAIL' | 'EVAL_CHEAT_FAIL'

// ── Sealed test card ──────────────────────────────────────────────────────────
/**
 * One runnable assertion in the card. `command` is run verbatim in the isolated
 * worktree; the step PASSES iff its process exit code equals `expectedExit`.
 * A `negative` step (or any step whose expectedExit ≠ 0) is a disconfirming test
 * — it proves the suite can actually FAIL, which is what makes a green run meaningful.
 */
export interface SealedCardStep {
  command: string
  /** EXACT expected process exit code. The artifact is executed and graded against this. */
  expectedExit: number
  /** Marks a disconfirming/negative test (a step asserted to fail). */
  negative?: boolean
  description?: string
}

export interface SealedCard {
  /** The objective this card proves (bookkeeping; never shown to the blind evaluator). */
  objectiveId?: number
  /** Ordered runnable assertions. EVERY step is executed (unlike the floor, which stops early). */
  steps: SealedCardStep[]
  /** Optional subdir within the worktree the card runs in. */
  cwdSubdir?: string
}

// ── Card validator (deterministic; reuses no LLM judgment) ─────────────────────
// A card must be a runnable spec, not a set of manual edits. These patterns catch
// the "card that secretly edits the product" anti-pattern the Kitchen Loop warns of.
const FORBIDDEN_CARD_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /\b(vi|vim|nvim|nano|emacs)\b/i, label: 'interactive editor' },
  { re: /\bsed\b[^|;]*(\s-i\b|--in-place)/i, label: 'sed in-place edit' },
  { re: /\bcat\b\s*>>?/i, label: 'cat redirect (file write)' },
  { re: /\b(tee|patch)\b/i, label: 'file write/patch' },
  // Unresolved angle-bracket placeholder, e.g. <path>, <your-id>. Does NOT match
  // shell redirection (`< file` has a space; `>file` uses `>`).
  { re: /<[A-Za-z][A-Za-z0-9_. -]*>/, label: 'unresolved <placeholder>' },
]

export interface CardValidation {
  ok: boolean
  reason?: string
}

/**
 * Reject a card that is not a clean runnable spec. A failure here → UAT_SPEC_FAIL
 * (logged, NON-blocking). Pure + deterministic so it is unit-testable and cannot
 * itself become a flaky gate.
 */
export function validateCard(card: SealedCard | null | undefined): CardValidation {
  if (!card || !Array.isArray(card.steps) || card.steps.length === 0) {
    return { ok: false, reason: 'card has no steps' }
  }
  let negatives = 0
  for (const s of card.steps) {
    if (!s || typeof s.command !== 'string' || s.command.trim() === '') {
      return { ok: false, reason: 'a step is missing a command' }
    }
    if (typeof s.expectedExit !== 'number' || !Number.isInteger(s.expectedExit)) {
      return { ok: false, reason: `step "${s.command}" is missing an integer expectedExit` }
    }
    for (const p of FORBIDDEN_CARD_PATTERNS) {
      if (p.re.test(s.command)) {
        return { ok: false, reason: `forbidden ${p.label} in step: \`${s.command}\`` }
      }
    }
    if (s.negative === true || s.expectedExit !== 0) negatives++
  }
  if (negatives < 1) {
    return { ok: false, reason: 'card needs ≥1 negative test (a step expected to fail, i.e. negative:true or expectedExit≠0)' }
  }
  return { ok: true }
}

// ── Per-step evidence (persisted into the criteria_results slot) ───────────────
export interface UatStepEvidence {
  command: string
  expectedExit: number
  /** null when the process never produced an exit code (spawn/infra failure). */
  actualExit: number | null
  negative: boolean
  /** actualExit === expectedExit. */
  passed: boolean
  /** Combined, truncated stdout+stderr. */
  output: string
  durationMs: number
  /** Set when the step failed for an INFRASTRUCTURE reason (still counts as not-passed). */
  infraError?: string
}

export interface CardRunResult {
  verdict: 'PASS' | 'PRODUCT_FAIL'
  steps: UatStepEvidence[]
}

/**
 * EXECUTE the artifact: run every card step in `cwd` and grade by EXACT exit codes.
 * Unlike the floor (which short-circuits on the first red), the UAT card runs ALL
 * steps so the evidence is complete. Any step whose actual exit ≠ expected → PRODUCT_FAIL.
 * Injectable runner so the decision logic is unit-testable without spawning processes.
 */
export function runCard(card: SealedCard, cwd: string, runner: CommandRunner = execRunner): CardRunResult {
  const steps: UatStepEvidence[] = []
  let verdict: 'PASS' | 'PRODUCT_FAIL' = 'PASS'
  const timeoutMs = DEFAULT_TIMEOUT_MS
  for (const s of card.steps) {
    let r: FloorCommandResult
    try {
      r = runner(s.command, cwd, timeoutMs)
    } catch (err) {
      r = { command: s.command, exitCode: null, output: String(err), durationMs: 0, infraError: 'runner-threw' }
    }
    const passed = r.exitCode === s.expectedExit
    if (!passed) verdict = 'PRODUCT_FAIL'
    steps.push({
      command: s.command,
      expectedExit: s.expectedExit,
      actualExit: r.exitCode,
      negative: s.negative === true || s.expectedExit !== 0,
      passed,
      output: r.output,
      durationMs: r.durationMs,
      infraError: r.infraError,
    })
  }
  return { verdict, steps }
}

// ── Mechanical anti-cheat ──────────────────────────────────────────────────────
export interface CheatCheck {
  cheated: boolean
  /** Worktree-relative paths the evaluator changed (excluding the evidence dir). */
  changedPaths: string[]
}

/**
 * Parse `git status --porcelain` output. ANY tracked-or-untracked change the
 * evaluator left behind is a cheat (the evaluator must ONLY run read-only checks +
 * tests; it must never touch a product file). The gate's own evidence dir, if any,
 * is excluded. Pure so it is unit-testable from a captured status string.
 */
export function detectCheat(gitStatusPorcelain: string, evidenceDir?: string): CheatCheck {
  const changed = gitStatusPorcelain
    .split('\n')
    .map(l => l.replace(/\r$/, ''))
    .filter(l => l.trim().length > 0)
    // porcelain line = 2 status chars + space + path (rename shows "old -> new").
    .map(l => {
      const p = l.slice(3).trim()
      const arrow = p.indexOf(' -> ')
      return arrow >= 0 ? p.slice(arrow + 4).trim() : p
    })
    .map(p => p.replace(/^"(.*)"$/, '$1'))
    .filter(p => p.length > 0)
    .filter(p => !evidenceDir || !(p === evidenceDir || p.startsWith(evidenceDir.replace(/\/?$/, '/'))))
  return { cheated: changed.length > 0, changedPaths: changed }
}

/** Real git-status reader for a worktree (best-effort). */
export function defaultGitStatus(worktreeDir: string): string {
  try {
    return execSync(`git -C ${JSON.stringify(worktreeDir)} status --porcelain`, {
      timeout: 30_000,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch {
    return '' // unreadable status → treat as no detectable change (fail-safe; gate is shadow anyway)
  }
}

// ── criteria_results shaping (the slot prompt-builder.ts:382 consumes) ──────────
export interface CriterionResult {
  id: string
  criterion: string
  status: 'pass' | 'fail'
  severity: 'critical' | 'major' | 'minor'
  repro: string
  expected: string
  actual: string
}

function stepCriteria(steps: UatStepEvidence[]): CriterionResult[] {
  return steps.map((s, i) => ({
    id: `uat-step-${i + 1}`,
    criterion: s.command,
    status: s.passed ? 'pass' : 'fail',
    severity: s.passed ? 'minor' : 'critical',
    repro: s.command,
    expected: `exit ${s.expectedExit}`,
    actual: s.infraError ? `infra-error(${s.infraError}); exit ${s.actualExit}` : `exit ${s.actualExit}`,
  }))
}

// ── Blind evaluator spawn (information wall + isolated worktree + Opus default) ──
//
// Builds a prompt containing ONLY the sealed card — NO diff, NO ticket, NO objective
// text — with mandate = DISCONFIRM. This kept entirely inside uat-gate.ts so we make
// ZERO edits to session-manager.ts (Rec #5 also touches that file; minimising the
// edit surface guarantees no merge conflict).
export function buildBlindEvaluatorPrompt(card: SealedCard): string {
  const stepLines = card.steps
    .map((s, i) => `${i + 1}. \`${s.command}\`  → expect exit code ${s.expectedExit}${s.negative || s.expectedExit !== 0 ? '  (NEGATIVE test — it is asserted to FAIL)' : ''}`)
    .join('\n')
  return [
    '# Adversarial UAT — Blind Execution',
    '',
    'You are a fresh, independent evaluator. Your mandate is to **DISCONFIRM**: assume the',
    'artifact is broken and try to prove it. You have been given ONLY the sealed test card',
    'below — deliberately NO diff, NO ticket, NO objective description (an information wall).',
    '',
    '## Rules (a violation is itself a failure)',
    '- Run EACH command EXACTLY as written, in order, in this worktree.',
    '- Record the ACTUAL exit code of each command.',
    '- You may ONLY run the commands and read output. You must NOT edit, create, or delete',
    '  ANY product file, test, or config to make a step pass — doing so is detected mechanically',
    '  by a post-run `git diff` and is an automatic EVAL_CHEAT_FAIL.',
    '- A step PASSES iff its actual exit code equals its expected exit code.',
    '',
    '## Sealed test card',
    stepLines,
    '',
    'Report, per step: the command, expected exit, actual exit, and PASS/FAIL. Then give an',
    'overall verdict: PASS only if every step matched; otherwise PRODUCT_FAIL.',
  ].join('\n')
}

export interface BlindSpawnContext {
  card: SealedCard
  worktreeDir: string
  /** Default model for the evaluator — Opus (Mike all-Opus rule). */
  model?: string
}

export type BlindSpawnFn = (ctx: BlindSpawnContext) => string | null

/**
 * Default blind-evaluator spawn: picks an account and launches a fresh Claude
 * session in the isolated worktree via the existing tmux/pickAccount path, given
 * only the card. Best-effort: returns null (and never throws) if no account is
 * available or the spawn fails — the deterministic verdict still stands. Dynamic
 * imports keep this off the hot module-load path and avoid editing session-manager.
 *
 * NOTE: in SHADOW mode the live session is observational only — the verdict is
 * re-derived deterministically from exit codes + git diff regardless of what the
 * session reports. The spawn exists so the information-wall evaluation runs for
 * real once the gate moves out of shadow.
 */
export const defaultBlindSpawn: BlindSpawnFn = (ctx) => {
  try {
    const account = pickAccount()
    if (!account) {
      console.warn('[uat-gate] no account available for blind evaluator; skipping live spawn (verdict stands deterministically)')
      return null
    }
    const sessionId = `cc-uat-eval-${ctx.card.objectiveId ?? 'x'}-${Date.now()}`
    const sessionsDir = path.join(account.homeDir, '.cc-uat-sessions')
    const jsonlPath = path.join(sessionsDir, `${sessionId}.jsonl`)
    const logPath = path.join(sessionsDir, `${sessionId}.log`)
    try {
      fs.mkdirSync(sessionsDir, { recursive: true })
    } catch {
      /* mkdir best-effort */
    }
    const env: Record<string, string> = {
      HOME: account.homeDir,
      USER: 'ccuser',
      TERM: 'dumb',
      PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
    }
    spawnInTmux({
      sessionId,
      homeDir: account.homeDir,
      workdir: ctx.worktreeDir,
      prompt: buildBlindEvaluatorPrompt(ctx.card),
      jsonlPath,
      logPath,
      env,
      effort: 'low',
      model: ctx.model ?? 'claude-opus-4-8',
      worktreeRoot: ctx.worktreeDir,
    })
    return sessionId
  } catch (err) {
    console.warn('[uat-gate] blind evaluator spawn failed (verdict stands deterministically):', (err as Error).message)
    return null
  }
}

// ── The gate (deterministic orchestration) ─────────────────────────────────────
export interface UatGateResult {
  verdict: UatVerdict
  reason: string
  steps: UatStepEvidence[]
  cheatPaths: string[]
  evaluatorSessionId: string | null
  /** criteria_results-shaped evidence (the slot prompt-builder.ts:382 consumes). */
  criteriaResults: CriterionResult[]
}

export interface RunUatGateDeps {
  card: SealedCard
  worktreeDir: string
  /** Executes card steps (default execRunner). */
  runner?: CommandRunner
  /** Returns the worktree's `git status --porcelain` AFTER evaluation. */
  gitStatus?: () => string
  /** Spawns the blind evaluator session (default real spawn). Best-effort. */
  spawn?: BlindSpawnFn
  /** Skip the live spawn entirely (e.g. pure deterministic shadow run). Default false. */
  noSpawn?: boolean
  /** Worktree-relative evidence dir excluded from the anti-cheat diff. */
  evidenceDir?: string
  model?: string
}

/**
 * Run the full gate: validate card → (spawn blind evaluator) → execute card →
 * mechanical anti-cheat → 4-verdict result. Pure orchestration over injected IO,
 * so the whole decision is unit-testable without tmux or a real git repo.
 *
 * Ordering rationale: a card-spec failure short-circuits BEFORE any spawn/exec
 * (don't run a malformed card). The anti-cheat OVERRIDES the product verdict —
 * a cheating evaluator that made a broken artifact "pass" must surface as a cheat,
 * not a pass.
 */
export function runUatGate(deps: RunUatGateDeps): UatGateResult {
  const { card, worktreeDir } = deps

  // 1. Card validity (UAT_SPEC_FAIL — logged, non-blocking).
  const v = validateCard(card)
  if (!v.ok) {
    return {
      verdict: 'UAT_SPEC_FAIL',
      reason: v.reason || 'invalid card',
      steps: [],
      cheatPaths: [],
      evaluatorSessionId: null,
      criteriaResults: [
        {
          id: 'uat-card-spec',
          criterion: 'sealed test card is a clean runnable spec',
          status: 'fail',
          severity: 'major',
          repro: 'validateCard(card)',
          expected: 'valid card (no manual-edit commands, no placeholders, ≥1 negative test)',
          actual: v.reason || 'invalid card',
        },
      ],
    }
  }

  // 2. Blind evaluator spawn (information wall). Best-effort, observational in shadow.
  let evaluatorSessionId: string | null = null
  if (!deps.noSpawn) {
    try {
      evaluatorSessionId = (deps.spawn ?? defaultBlindSpawn)({ card, worktreeDir, model: deps.model })
    } catch {
      evaluatorSessionId = null
    }
  }

  // 3. EXECUTE the artifact against the card.
  const runCwd = card.cwdSubdir ? path.join(worktreeDir, card.cwdSubdir) : worktreeDir
  const run = runCard(card, runCwd, deps.runner)

  // 4. Mechanical anti-cheat — OVERRIDES the product verdict.
  let cheat: CheatCheck = { cheated: false, changedPaths: [] }
  try {
    const status = (deps.gitStatus ?? (() => defaultGitStatus(worktreeDir)))()
    cheat = detectCheat(status, deps.evidenceDir)
  } catch {
    cheat = { cheated: false, changedPaths: [] }
  }

  if (cheat.cheated) {
    return {
      verdict: 'EVAL_CHEAT_FAIL',
      reason: `evaluator modified ${cheat.changedPaths.length} product file(s): ${cheat.changedPaths.join(', ')}`,
      steps: run.steps,
      cheatPaths: cheat.changedPaths,
      evaluatorSessionId,
      criteriaResults: [
        ...stepCriteria(run.steps),
        {
          id: 'uat-anticheat',
          criterion: 'evaluator left the worktree unmodified (no product-file edits)',
          status: 'fail',
          severity: 'critical',
          repro: 'git status --porcelain (post-eval)',
          expected: 'clean worktree',
          actual: `changed: ${cheat.changedPaths.join(', ')}`,
        },
      ],
    }
  }

  return {
    verdict: run.verdict,
    reason: run.verdict === 'PASS' ? 'all card steps matched expected exit codes' : 'one or more card steps did not match expected exit codes',
    steps: run.steps,
    cheatPaths: [],
    evaluatorSessionId,
    criteriaResults: stepCriteria(run.steps),
  }
}

// ── Build a valid sealed card from a known-bad canary (regression proof) ────────
/**
 * Adapt a Tier-1 canary fixture into a VALID sealed card so it can be fed through
 * the UAT gate as a regression proof. The canary's own commands become positive
 * steps (claimed to exit 0 by a worker who believed the artifact was correct);
 * a deterministic negative control (`node -e "process.exit(1)"`) satisfies the
 * card-validator's ≥1-negative-test rule WITHOUT changing what the canary exercises.
 * When the (broken) canary command exits non-zero, the gate returns PRODUCT_FAIL.
 */
export function cardFromCanary(canary: Canary): SealedCard {
  return {
    objectiveId: undefined,
    steps: [
      ...canary.commands.map(command => ({ command, expectedExit: 0 })),
      // Negative control: asserts the harness can observe a failing step. Independent
      // of the canary's broken code, so it never masks the real PRODUCT_FAIL signal.
      { command: 'node -e "process.exit(1)"', expectedExit: 1, negative: true, description: 'negative control' },
    ],
  }
}

// ── Feature flag / kill switch / per-project opt-in / shadow mode ───────────────
function boolEnv(v: string | undefined): boolean {
  const s = (v || '').toLowerCase()
  return s === '1' || s === 'true' || s === 'yes' || s === 'on'
}

function settingTrue(db: Database, key: string): boolean {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value?: string } | undefined
    return row?.value === '1' || row?.value === 'true'
  } catch {
    return false
  }
}

/** True iff the gate is globally enabled (env OR settings). OFF by default. */
export function isUatGateEnabled(db: Database, env: NodeJS.ProcessEnv = process.env): boolean {
  if (boolEnv(env.CC_UAT_GATE_ENABLED)) return true
  return settingTrue(db, 'uat_gate_enabled')
}

/** Hard kill switch — disarms everything everywhere regardless of any opt-in. */
export function isUatGateKilled(db: Database, env: NodeJS.ProcessEnv = process.env): boolean {
  if (boolEnv(env.CC_UAT_GATE_KILLED)) return true
  return settingTrue(db, 'uat_gate_killed')
}

/** True iff `project` has its own `uat_gate_config:<project>` opt-in row (presence check). */
export function hasProjectUatOptIn(db: Database, project: string | null): boolean {
  if (!project) return false
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(`uat_gate_config:${project}`) as { value?: string } | undefined
    return typeof row?.value === 'string' && row.value.trim().length > 0
  } catch {
    return false
  }
}

/**
 * The gate is active for `project` iff it is not globally killed AND (the global
 * flag is on OR this project opted in). Mirrors isFloorActiveForProject so a single
 * pilot can arm the gate via one DB row without flipping the global default.
 */
export function isUatGateActiveForProject(db: Database, project: string | null, env: NodeJS.ProcessEnv = process.env): boolean {
  if (isUatGateKilled(db, env)) return false
  return isUatGateEnabled(db, env) || hasProjectUatOptIn(db, project)
}

/**
 * SHADOW MODE by default (returns true). The gate only ENFORCES (can block a
 * transition) when `uat_gate_blocking` is explicitly set via env or settings.
 * Until then it records its verdict and never blocks — shadow first, enforce later.
 */
export function isUatGateShadowMode(db: Database, env: NodeJS.ProcessEnv = process.env): boolean {
  if (boolEnv(env.CC_UAT_GATE_BLOCKING)) return false
  if (settingTrue(db, 'uat_gate_blocking')) return false
  return true
}

// ── Stage-C review enforcement (obj 700316; kitchen_loop_review_enforce) ────────
//
// A SECOND, scoped lever — independent of `uat_gate_blocking` — that flips the
// cheat-check (UAT PRODUCT_FAIL / EVAL_CHEAT_FAIL) from log-only (shadow) to an
// actual BLOCK, but ONLY for the command-center-infra pilot. Sibling worker CW1
// seeds the `kitchen_loop_review_enforce` flag row OFF in db/index.ts; this module
// only READS it. With the flag OFF, shadow/enforce is governed SOLELY by
// uat_gate_blocking exactly as before — byte-for-byte identical. The scope guard
// (isCommandCenterTarget) guarantees no other workspace is ever flipped to blocking.

/** True iff the `kitchen_loop_review_enforce` flag is ON (env OR settings). OFF by default. */
export function isReviewEnforceEnabled(db: Database, env: NodeJS.ProcessEnv = process.env): boolean {
  if (boolEnv(env.CC_KITCHEN_LOOP_REVIEW_ENFORCE)) return true
  return settingTrue(db, 'kitchen_loop_review_enforce')
}

/**
 * Review enforcement is active for a target iff the flag is ON **and** the target is
 * the command-center-infra pilot. The scope guard lives here so every caller that
 * consults this predicate is automatically blast-radius-safe: a non-pilot project
 * can never be flipped out of shadow by this flag, even when it is ON.
 */
export function isReviewEnforceActiveForTarget(
  db: Database,
  project: string | null,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return isReviewEnforceEnabled(db, env) && isCommandCenterTarget(project)
}

// ── Persistence (objective_uat_runs; criteria_results column = the consumed slot) ──
export interface UatObjectiveRef {
  id: number | null
  project: string | null
  workspace: string
  session_id?: string | null
}

/**
 * Persist one UAT run. The `criteria_results` column holds the SAME JSON shape the
 * AI-review pipeline stores in objective_reviews.criteria_results (consumed by
 * prompt-builder.ts:382), so a failing UAT run feeds the worker the exact failing
 * steps on its next iteration. Dedicated table (not objective_reviews, whose verdict
 * CHECK is pass/fail/blocked) so shadow runs never perturb the live review row /
 * transitions. Best-effort: a write failure is logged, never thrown.
 */
export function recordUatRun(
  db: Database,
  objective: UatObjectiveRef,
  result: UatGateResult,
  shadow: boolean,
  source: 'objective' | 'canary' = 'objective',
): number | null {
  try {
    const res = db
      .prepare(
        `INSERT INTO objective_uat_runs
           (objective_id, source, verdict, shadow, card_json, criteria_results, evidence_json, cheat_paths, workspace, session_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        objective.id ?? null,
        source,
        result.verdict,
        shadow ? 1 : 0,
        JSON.stringify({ steps: result.steps.map(s => ({ command: s.command, expectedExit: s.expectedExit })) }),
        JSON.stringify(result.criteriaResults),
        JSON.stringify({ reason: result.reason, steps: result.steps, evaluatorSessionId: result.evaluatorSessionId }),
        result.cheatPaths.length ? JSON.stringify(result.cheatPaths) : null,
        objective.workspace,
        objective.session_id ?? null,
      )
    return Number(res.lastInsertRowid)
  } catch (err) {
    console.error(`[uat-gate] failed to record uat run for obj ${objective.id}:`, err)
    return null
  }
}

/** Emit a UAT milestone / alarm to activity_log. EVAL_CHEAT_FAIL is flagged as an error. */
export function logUatMilestone(db: Database, objective: UatObjectiveRef, result: UatGateResult): void {
  const isAlarm = result.verdict === 'EVAL_CHEAT_FAIL'
  const eventType = isAlarm ? 'error' : 'milestone'
  const title = `UAT gate: ${result.verdict}`
  const detail = isAlarm
    ? `🚨 ${result.verdict} — ${result.reason}`
    : `${result.verdict} — ${result.reason}`
  try {
    db.prepare(
      `INSERT INTO activity_log (project, workspace, objective_id, session_id, event_type, title, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(objective.project || 'command-center-infra', objective.workspace, objective.id, objective.session_id ?? null, eventType, title, detail)
  } catch (err) {
    console.error(`[uat-gate] failed to log milestone for obj ${objective.id}:`, err)
  }
}

// ── Flag-guarded entry (mirrors evaluateFloorGate) ─────────────────────────────
export type UatGateDecision =
  | { action: 'skip'; reason: 'killed' | 'not-active' }
  | { action: 'record'; result: UatGateResult; runId: number | null } // shadow: recorded, NOT blocking
  | { action: 'proceed'; result: UatGateResult; runId: number | null } // enforce mode, verdict PASS/UAT_SPEC_FAIL
  | { action: 'block'; result: UatGateResult; runId: number | null }   // enforce mode, PRODUCT_FAIL/EVAL_CHEAT_FAIL

/**
 * Flag-guarded, shadow-aware entry point. Activation is checked here; on an active
 * project it runs the gate, persists the verdict, and returns a decision:
 *   • SHADOW (default)         → always `record` (never blocks), whatever the verdict.
 *   • ENFORCE + PASS/SPEC_FAIL → `proceed` (UAT_SPEC_FAIL is non-blocking by design).
 *   • ENFORCE + PRODUCT/CHEAT  → `block`.
 * The CALLER performs any status mutation; this function never mutates objective state.
 */
export function evaluateUatGate(
  db: Database,
  objective: UatObjectiveRef,
  deps: RunUatGateDeps,
  env: NodeJS.ProcessEnv = process.env,
): UatGateDecision {
  if (isUatGateKilled(db, env)) return { action: 'skip', reason: 'killed' }
  if (!isUatGateActiveForProject(db, objective.project, env)) return { action: 'skip', reason: 'not-active' }

  // Stage-C (obj 700316): kitchen_loop_review_enforce flips the command-center-infra
  // pilot OUT of shadow into ENFORCE (cheat-check actually blocks). The scope guard
  // is inside isReviewEnforceActiveForTarget, so this can NEVER un-shadow any other
  // workspace. With the flag OFF the value is identical to isUatGateShadowMode alone.
  const shadow =
    isUatGateShadowMode(db, env) && !isReviewEnforceActiveForTarget(db, objective.project, env)
  const result = runUatGate(deps)
  const runId = recordUatRun(db, objective, result, shadow)
  logUatMilestone(db, objective, result)

  if (shadow) return { action: 'record', result, runId }

  if (result.verdict === 'PRODUCT_FAIL' || result.verdict === 'EVAL_CHEAT_FAIL') {
    return { action: 'block', result, runId }
  }
  // PASS or UAT_SPEC_FAIL (a bad card must NOT block work — it is a worker signal).
  return { action: 'proceed', result, runId }
}
