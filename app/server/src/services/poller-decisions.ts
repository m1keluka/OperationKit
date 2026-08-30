/**
 * Pure poller decision functions — extracted from state-poller.ts (behavior frozen).
 * No DB, no tmux, no timers. The poll loop in state-poller.ts calls these.
 */
import { isClearDeadSessionEnabled } from './objective-audit.js'
import type { MergeLane } from './merge-lane.js'
import type {
  Objective,
  ObjectiveStatus,
  ObjectiveType,
  AcceptanceCriterion,
  AcceptanceCriterionResult,
} from '@operationkit/shared'

export const MAX_NOOP_RESPAWNS = 2

export interface NoOpDecision {
  /** true when the session produced 0 tool calls AND 0 file changes. */
  isNoOp: boolean
  /** 'none' = real session (route normally); 'respawn' = no-op under the cap,
   *  re-spawn the worker; 'block' = no-op with the re-spawn budget exhausted;
   *  'skip-reviewer' = ran (has tool calls) but produced no files and died in
   *  under SHORT_SESSION_SKIP_REVIEWER_MS — send to human review, do not spend
   *  a second Claude process grading an empty tree. */
  action: 'none' | 'respawn' | 'block' | 'skip-reviewer'
  /** 1-based attempt number to record when action === 'respawn'. */
  attempt?: number
}

/** Sub-35s sessions with zero file changes (the 706967/707614 shape). */
export const SHORT_SESSION_SKIP_REVIEWER_MS = 35_000

/**
 * Pure no-op-spawn classifier (objective 840). Extracted from pollActiveSessions
 * so the branch is unit-testable without a live DB/tmux. Given the deterministic
 * session-intel counts (NOT the async-summary fields) and how many times we have
 * already re-spawned this objective, decide what to do:
 *   - not a no-op            → 'none'  (genuine deliverable; route normally)
 *   - no-op, under the cap   → 'respawn'
 *   - no-op, cap exhausted   → 'block'
 * A no-op is the exact signal the intel pipeline already uses to skip the LLM
 * summary: 0 tool calls AND 0 files created AND 0 files modified.
 */
/**
 * FIX A (obj 700415) — the pure branch the poller's dead-session handler consults
 * to kill the MODE-1 re-park churn. Unit-testable without a live DB/tmux.
 *   - 'skip-noop'       → already review + session_id already null: emit NOTHING
 *                         (no updated_at bump, no broadcast).
 *   - 'clear-session'   → already review + a stale dead session_id: re-park in
 *                         place AND clear session_id so the row leaves the poll
 *                         select set (`session_id IS NOT NULL`) after one pass.
 *   - 'route-to-review' → working→review transition (or flag OFF): unchanged
 *                         legacy behavior (session_id retained).
 * Gated by CC_POLL_CLEAR_DEAD_SESSION (default ON).
 */
export type DeadReparkAction = 'skip-noop' | 'clear-session' | 'route-to-review'
export function decideDeadSessionRepark(
  obj: Pick<Objective, 'status' | 'session_id'>,
  clearEnabled: boolean = isClearDeadSessionEnabled(),
): DeadReparkAction {
  if (clearEnabled && obj.status === 'review') {
    return obj.session_id == null ? 'skip-noop' : 'clear-session'
  }
  return 'route-to-review'
}

export function classifyNoOpSpawn(
  intel: { toolCalls: number; filesCreated: number; filesModified: number; durationMs?: number },
  priorAttempts: number,
  maxRespawns: number = MAX_NOOP_RESPAWNS
): NoOpDecision {
  const isNoOp = intel.toolCalls === 0 && intel.filesCreated === 0 && intel.filesModified === 0
  if (isNoOp) {
    if (priorAttempts < maxRespawns) return { isNoOp: true, action: 'respawn', attempt: priorAttempts + 1 }
    return { isNoOp: true, action: 'block' }
  }
  // Ran, but produced no files and died almost immediately — the backstop
  // metronome shape (reads, zero writes, <35s). Do not spawn a reviewer.
  const durationMs = intel.durationMs
  if (
    intel.filesCreated === 0 &&
    intel.filesModified === 0 &&
    typeof durationMs === 'number' &&
    durationMs > 0 &&
    durationMs < SHORT_SESSION_SKIP_REVIEWER_MS
  ) {
    return { isNoOp: false, action: 'skip-reviewer' }
  }
  return { isNoOp: false, action: 'none' }
}

/**
 * Type-aware routing for a worker session that just ended cleanly
 * (working→review). Pure + exported so the decision is unit-testable without a
 * live DB/tmux (à la {@link classifyNoOpSpawn}).
 *
 * The pre-fix logic keyed ONLY on `type` (project/bug → ai_review, task →
 * review) and ignored `create_pr` entirely. That stranded every top-level
 * `create_pr` *task*: it opens a real PR but routed straight to the human
 * `review` gate, so the adversarial reviewer never spawned and the
 * `harness/test-agent` commit status (posted only from the reviewer path —
 * {@link postHarnessStatus}) was never set. Branch protection REQUIRES that
 * status, so the PR sat at "no checks reported" forever and the harness loop
 * could never go green end-to-end without hand-driving it (obj 1234; the obj
 * 841/1159 dogfood failures).
 *
 * Fix: a `create_pr` objective routes through ai_review regardless of type
 * UNLESS the merge lane is `green`. Green skips the tmux reviewer: the poller
 * posts `harness/test-agent` itself and CI is the merge gate. Yellow/Red keep
 * the reviewer (UI PRs, unknown files, money/auth, projects, delegators).
 * `skip_ai_review` is still the operator opt-out. When `lane` is omitted the
 * table is byte-identical to the pre-lane logic (create_pr → ai_review).
 */
export function resolveWorkerEndStatus(input: {
  type: ObjectiveType
  delegateMode: boolean
  createPr: boolean
  skipAi: boolean
  hasDelegatorParent: boolean
  isRoutine?: boolean
  /** Risk lane. `green` skips the tmux reviewer (CI is the gate). */
  lane?: MergeLane
}): ObjectiveStatus {
  const { type, delegateMode, createPr, skipAi, hasDelegatorParent, isRoutine, lane } = input
  if (delegateMode) {
    // A delegator that reaches here has all workers done. Its deliverable is the
    // orchestration + synthesis, which goes straight to the human gate —
    // adversarial AI review of a coordinator adds no value.
    return 'review'
  }
  if (lane === 'green') {
    // Low-risk: skip the tmux reviewer. Do NOT auto-complete — only a human or
    // the authenticated Agent API may write `done` on a top-level card
    // (obj 708538: outreach kept bouncing to done on every session end).
    // Routines still auto-done so they don't fill max_queue_depth.
    if (isRoutine && type === 'task') return 'done'
    return 'review'
  }
  if (createPr && !skipAi) {
    // Yellow/Red (and omitted lane): reviewer posts harness/test-agent.
    // Green already returned above — poller posts harness on that path.
    return 'ai_review'
  }
  if (type === 'task' && !skipAi && hasDelegatorParent) {
    // Delegator worker → independent adversarial review BEFORE the delegator
    // accepts it. Graded against the delegator-supplied acceptance_criteria.
    return 'ai_review'
  }
  if (type === 'task') {
    // Routine-spawned tasks (recurring "jobs") auto-complete to `done` — they
    // must NOT strand in `review`, because every routine has max_queue_depth and
    // a stranded review card permanently fills its slot, silently killing the
    // schedule (obj 1970: all 7 routines stopped firing ~Jun 21 this way). This
    // mirrors mustRouteToHumanReview's routine carve-out (lib/human-tracked.ts),
    // which the Jun 21 human-review-gate refactor applied to the done-PATCH guard
    // but missed here in the poller's routing. job_disposition still lanes flagged
    // jobs on the Jobs board after auto-done, so nothing is lost.
    if (isRoutine) return 'done'
    return 'review' // human-tracked tasks land in `review` for the human to mark done
  }
  if (skipAi) {
    // Opt-out: project lands in review, bug lands in done.
    return type === 'project' ? 'review' : 'done'
  }
  return 'ai_review' // projects and bugs
}

export type DelegatorBackstopAction = 'nudge' | 'route-review' | 'none'

/**
 * Pure decision: should a wedged delegator be recovered, and how?
 * - live working session → 'none' (a live delegator is fine, never disturb it).
 * - age below threshold → 'none' (don't race a just-parked/just-spawned delegator).
 * - otherwise, if there is actionable work (any child in queue/review, or all
 *   children done) → 'nudge' (revive it to spawn/synthesize; bypasses the spent-sig gate).
 * - otherwise (no children, or children exist but none actionable and not all-done)
 *   with no live session → 'route-review' (make it visible + resumable to a human).
 */
export function delegatorBackstopDecision(input: {
  hasLiveSession: boolean
  ageMs: number
  kids: { id: number; status: string }[]
  thresholdMs: number
}): { recover: boolean; action: DelegatorBackstopAction; why: string } {
  const { hasLiveSession, ageMs, kids, thresholdMs } = input
  if (hasLiveSession) return { recover: false, action: 'none', why: 'live working session' }
  if (ageMs < thresholdMs) {
    return { recover: false, action: 'none', why: `wedged ${Math.round(ageMs / 60000)}min < threshold ${Math.round(thresholdMs / 60000)}min` }
  }
  const actionable = kids.filter(k => k.status === 'queue' || k.status === 'review').length
  const allDone = kids.length > 0 && kids.every(k => k.status === 'done')
  if (actionable > 0 || allDone) {
    const why = allDone
      ? 'all workers done — synthesize (nudge past spent signature)'
      : `${actionable} worker(s) queue/review (nudge past spent signature)`
    return { recover: true, action: 'nudge', why }
  }
  // No live session and nothing actionable to nudge for: either zero children,
  // or children that are all in a non-actionable, non-terminal mix. Force-route
  // to review exactly like the orphan sweep so a human can pick it up.
  const why = kids.length === 0
    ? 'no children and no live session — force-route to review'
    : 'no actionable children and no live session — force-route to review'
  return { recover: true, action: 'route-review', why }
}

export function extractTag(text: string, tag: string): string | null {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'i')
  const m = text.match(re)
  return m ? m[1].trim() : null
}

/** Parse the `<feature_brief>` block (obj 937): the reviewer emits a JSON object
 * describing the shipped feature in plain stakeholder English. Returns the raw
 * JSON string if it parses to an object, else '' (empty → no brief stored).
 * Exported for unit testing. */
export function extractFeatureBriefTag(text: string): string {
  const raw = extractTag(text, 'feature_brief')
  if (!raw) return ''
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return JSON.stringify(parsed)
  } catch { /* fall through to default */ }
  return ''
}

/** Parse the `<screenshots>` block (obj 937): a NEWLINE-separated list of absolute
 * screenshot paths the reviewer reused from its Playwright captures. Splits on
 * newlines, trims, drops empties. Exported for unit testing. */
export function extractScreenshotsTag(text: string): string[] {
  const raw = extractTag(text, 'screenshots')
  if (!raw) return []
  return raw
    .split('\n')
    .map(s => s.trim())
    .filter(Boolean)
}

/** Parse a `<tag>` whose body is a JSON array; default to '[]' on any failure.
 * Exported for unit testing of the PR-gated test-agent structured-output parser. */
export function extractJsonArrayTag(text: string, tag: string): string {
  const raw = extractTag(text, tag)
  if (!raw) return '[]'
  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) return JSON.stringify(parsed)
  } catch { /* fall through to default */ }
  return '[]'
}

/** Tolerant matcher for a single findings line. Allows a leading bullet, mixed
 *  case, and SKIP/SKIPPED. Captures status, criterion id, and trailing evidence. */
const CRITERION_LINE_RE = /^\s*[-*]?\s*\[\s*(PASS|FAIL|SKIP|SKIPPED)\s*\]\s*([^:\]]+?)\s*:\s*(.*)$/i

/** Match filesystem paths / filenames ending in a screenshot image extension. */
const SCREENSHOT_PATH_RE = /(?:~?\/|\.\/)?[\w./-]+\.(?:png|jpe?g|gif|webp)/gi

export function extractScreenshotPaths(text: string | null | undefined): string[] {
  if (!text) return []
  const out = new Set<string>()
  for (const m of text.matchAll(SCREENSHOT_PATH_RE)) out.add(m[0])
  return [...out]
}

/** Coerce the objective's acceptance_criteria (JSON string on the raw row, or an
 *  already-parsed array) into a typed array. Returns [] on anything unparseable. */
export function parseAcceptanceCriteria(raw: unknown): AcceptanceCriterion[] {
  if (!raw) return []
  let val: unknown = raw
  if (typeof raw === 'string') {
    try { val = JSON.parse(raw) } catch { return [] }
  }
  return Array.isArray(val) ? (val as AcceptanceCriterion[]) : []
}

/**
 * Parse the reviewer's <findings> block into per-criterion results aligned to the
 * locked rubric. Each parsed line becomes one result; a per-line screenshot path
 * (if the evidence references an image) is attached. If no lines parse but a
 * rubric exists, we persist one `skipped` entry per criterion so the row carries
 * the real rubric shape rather than a blind empty array.
 */
export function parseCriteriaResults(
  findings: string | null | undefined,
  acceptanceCriteria: AcceptanceCriterion[]
): AcceptanceCriterionResult[] {
  const results: AcceptanceCriterionResult[] = []
  if (findings) {
    for (const line of findings.split('\n')) {
      const m = line.match(CRITERION_LINE_RE)
      if (!m) continue
      const statusRaw = m[1].toUpperCase()
      const status: AcceptanceCriterionResult['status'] =
        statusRaw === 'PASS' ? 'pass' : statusRaw === 'FAIL' ? 'fail' : 'skipped'
      const evidence = m[3].trim()
      const shots = extractScreenshotPaths(evidence)
      results.push({
        criterion_id: m[2].trim(),
        status,
        evidence,
        screenshot_path: shots[0] ?? null,
      })
    }
  }
  if (results.length === 0 && acceptanceCriteria.length > 0) {
    for (const c of acceptanceCriteria) {
      results.push({ criterion_id: c.id, status: 'skipped', evidence: '', screenshot_path: null })
    }
  }
  return results
}

// Bounce cap after a FAIL. Last 7d in prod: 350 first-pass passes vs 9 third-round
// passes (and 12 third-round fails). A third bounce is mostly token burn; escalate.
export const AI_REVIEW_ITERATION_CAP = 2

/**
 * Effort tier → CUMULATIVE per-objective spend ceiling (USD), enforced across
 * ALL respawns of an objective (the per-spawn `--max-budget-usd` resets every
 * respawn, so without a cumulative ceiling a multi-turn objective can burn
 * N × budget unbounded — ST3 / audit W3). Env-overridable; generous defaults.
 */
export const AI_REVIEW_BUDGET_CEILING_USD: Record<string, number> = {
  normal: parseFloat(process.env.OBJECTIVE_CEILING_NORMAL_USD || '75'),
  high: parseFloat(process.env.OBJECTIVE_CEILING_HIGH_USD || '150'),
  ultracode: parseFloat(process.env.OBJECTIVE_CEILING_ULTRACODE_USD || '300'),
}

export function budgetCeilingForEffort(effort: string | null | undefined): number {
  return AI_REVIEW_BUDGET_CEILING_USD[effort || 'normal'] ?? AI_REVIEW_BUDGET_CEILING_USD.normal
}

export type CapOutReason = 'iteration-cap' | 'budget' | 'no-progress'

/**
 * Pure decision for whether a failed AI review should bounce back to the worker
 * for another iteration, or stop and escalate (cap-out). Stops when ANY of:
 *   (a) iteration cap reached (backstop),
 *   (b) CUMULATIVE objective spend ≥ the effort-derived ceiling (the gap ST3
 *       closes — `--max-budget-usd` resets per spawn, this does not),
 *   (c) the reviewer's findings repeat verbatim (no-progress — another bounce
 *       just burns budget).
 * Extracted as a pure function so the cap-out logic is unit-testable. (ST3)
 */
export function decideRespawnAction(input: {
  iteration: number
  iterationCap: number
  spend: number
  ceiling: number
  findings: string | null
  prevFindings: string | null
  failedCriteriaIds?: string[]      // current round's status==='fail' criterion ids
  prevFailedCriteriaIds?: string[]  // previous round's status==='fail' criterion ids
}): { action: 'bounce' } | { action: 'cap'; reason: CapOutReason } {
  const {
    iteration, iterationCap, spend, ceiling, findings, prevFindings,
    failedCriteriaIds, prevFailedCriteriaIds,
  } = input
  if (iteration >= iterationCap) return { action: 'cap', reason: 'iteration-cap' }
  if (ceiling > 0 && spend >= ceiling) return { action: 'cap', reason: 'budget' }
  // No-progress by CRITERIA (preferred). When a structured failing-criterion set is
  // available for BOTH rounds and NO criterion that failed last round flipped to pass
  // this round, the worker resolved nothing the reviewer flagged — another bounce just
  // re-confirms the same verdict. (Every prior-failing id still failing ⇒ set unchanged
  // or grown ⇒ no fail→pass flip.) This is the live no-progress key; the verbatim-
  // markdown check below almost never fires because the reviewer rephrases evidence
  // every round, so non-converging reviews otherwise bounce to the iteration cap.
  if (
    failedCriteriaIds && failedCriteriaIds.length > 0 &&
    prevFailedCriteriaIds && prevFailedCriteriaIds.length > 0
  ) {
    const current = new Set(failedCriteriaIds)
    const noneFlippedToPass = prevFailedCriteriaIds.every((id) => current.has(id))
    if (noneFlippedToPass) return { action: 'cap', reason: 'no-progress' }
  }
  // Fallback: verbatim findings match (legacy guard; kept as a backstop for reviews
  // that emit no parseable criteria_results on either side).
  const a = (findings || '').trim()
  const b = (prevFindings || '').trim()
  if (a.length > 0 && a === b) return { action: 'cap', reason: 'no-progress' }
  return { action: 'bounce' }
}

/**
 * Extract the set of FAILING criterion ids from a stored/derived criteria_results
 * JSON string. Robust to both shapes the column can hold: the PR-harness
 * `<criteria_results>` emit (`id`) and the QW4 rubric-aligned parse (`criterion_id`).
 * Returns [] on null/parse-error/non-array — so a missing or malformed row degrades
 * to "no set available" (the verbatim fallback then governs), never a false cap.
 */
export function failingCriterionIds(criteriaResultsJson: string | null | undefined): string[] {
  if (!criteriaResultsJson) return []
  try {
    const parsed = JSON.parse(criteriaResultsJson) as Array<{
      id?: string; criterion_id?: string; status?: string
    }>
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((c) => c && c.status === 'fail')
      .map((c) => c.criterion_id ?? c.id ?? '')
      .filter((id) => id.length > 0)
  } catch {
    return []
  }
}

export type WatchdogReason = 'idle' | 'wall-clock'

/**
 * Pure decision: should a worker be force-routed off `working`? Force-routes
 * when JSONL has been idle beyond `idleForceMs`, OR wall-clock since spawn has
 * exceeded `wallClockLimitMs`. A limit <= 0 disables that arm. Pure so it is
 * unit-testable without the filesystem.
 */
export function watchdogDecision(input: {
  idleMs: number
  wallClockMs: number
  idleForceMs: number
  wallClockLimitMs: number
}): { forceRoute: boolean; reason: WatchdogReason | null } {
  const { idleMs, wallClockMs, idleForceMs, wallClockLimitMs } = input
  if (wallClockLimitMs > 0 && wallClockMs >= wallClockLimitMs) return { forceRoute: true, reason: 'wall-clock' }
  if (idleForceMs > 0 && idleMs >= idleForceMs) return { forceRoute: true, reason: 'idle' }
  return { forceRoute: false, reason: null }
}
