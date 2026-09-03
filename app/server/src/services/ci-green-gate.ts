/**
 * CI-GREEN GATE AT THE COMPLETION BOUNDARY (obj 704785).
 *
 * THE PROBLEM
 * -----------
 * A worker session ends → an AI reviewer grades the DIFF against the acceptance
 * criteria → verdict `pass` → the objective moves to `done`. Nothing in that chain
 * ever looked at whether the PR's CI was actually green. A review PASS is a judgement
 * about the code, not about the checks. So objectives closed on top of red PRs and the
 * PR became ownerless — Mike had to hunt down which objective owned each red PR and
 * message it by hand.
 *
 * THE GATE
 * --------
 * Every path that transitions an objective to `done` calls {@link runCompletionGate}
 * first. When the objective owns a PR whose REQUIRED checks are failing, completion is
 * held and the owner is handed the specific failing check names.
 *
 * WHY IT CANNOT DEADLOCK (this is the hard part)
 * ----------------------------------------------
 * A check can be impossible to satisfy for reasons no worker can move. On 2026-08-06
 * GitHub Actions was in `major_outage` and required checks were NOT BEING SCHEDULED AT
 * ALL on new commits — PR #679 carried only Vercel checks and zero Actions check runs.
 * A naive "hold until green" gate would have wedged every objective on the board
 * forever. So the gate distinguishes three worlds, and only ONE of them holds:
 *
 *   1. required check FAILED           → HOLD. This is the worker's problem. Hand back
 *                                        the failing check names.
 *   2. required check ABSENT / queued  → NOT the worker's failure. Hold only for a
 *      / cancelled-at-a-gate             BOUNDED wall-clock window, then COMPLETE and
 *                                        hand the PR to the pr-health watchdog with a
 *                                        durable record of WHY.
 *   3. ADVISORY (non-required) red     → never blocks. Not even considered.
 *
 * THE GATE MUST NOT GRADE ITS OWN OUTPUT (obj 706069)
 * ---------------------------------------------------
 * There is a fourth world the three above missed. `harness/test-agent` is required by
 * this repo's ruleset but has NO CI producer — the harness posts it, and one poster is
 * this gate's own caller (on HOLD it posts that context = failure). So one hold made the
 * required set permanently unsatisfiable: the next evaluation saw its own failure as
 * world 1 and held again, forever, and no worker push could clear it because only a
 * `done` transition posts success — which the gate was blocking. A self-referential
 * required check is not evidence about the diff, so {@link isHarnessOwnStatus} contexts
 * are excluded from the required set, the failing set, and the advisory set alike.
 *
 * Plus a hard backstop on top of all three: {@link holdCap} hold cycles per objective,
 * ever. After that it escalates to Mike instead of bouncing worker→review forever. The
 * wait clock is per-OBJECTIVE and is deliberately NOT reset when the head SHA changes —
 * otherwise a worker pushing commits in a loop would reset the bound indefinitely.
 *
 * REQUIRED vs ADVISORY IS READ FROM THE REPO, NOT GUESSED
 * -------------------------------------------------------
 * Check *names* tell you nothing about whether they gate a merge. On
 * EXAMPLE2/example3-platform only `Vitest unit suite (7 pure configs)` and
 * `Adversarial RLS suite (8th config)` are required; tsc, gitleaks, Playwright, the
 * Claude security review and every Vercel check are advisory — a hardcoded list would
 * have blocked on all of them. So the required set comes from the repo's live branch
 * ruleset (`GET /repos/{o}/{r}/rules/branches/{base}`), falling back to classic branch
 * protection. If BOTH are unreadable we do not invent a required set and we never hold;
 * we complete and record the reason (fail-open, but never fail-silent).
 *
 * FAIL-OPEN, NEVER FAIL-SILENT
 * ----------------------------
 * Any error in this module (gh down, timeout, malformed JSON) resolves to `allow` with
 * a recorded reason. A gate that can wedge the whole board on its own bug is worse than
 * no gate. Everything it lets through non-green lands in `objective_completion_gate`
 * and is surfaced on the pr-health digest, so nothing it releases is orphaned.
 *
 * NO AUTO-MERGE. This module never merges anything. Mike merges.
 *
 * Split: pure decision in ci-green-gate-decide.ts, GitHub IO in

 * ci-green-gate-github.ts, run/handback/digest in ci-green-gate-run.ts.
 * This file is the re-export facade.
 */

export {
  DEFAULT_CONFIG,
  type CiGateAction,
  type CiGateConfig,
  type CiGateDecision,
  type CiGateInput,
  type ExecFn,
  type GateMode,
  type NormalisedCheck,
  type RequiredChecks,
  type RequiredSource,
  type RollupEntry,
  buildHandback,
  evaluateCiGate,
  findCheck,
  isHarnessOwnStatus,
  loadConfig,
  normaliseRollup,
} from './ci-green-gate-decide.js'

export {
  clearRequiredChecksCache,
  defaultExec,
  fetchPrCheckState,
  fetchRequiredChecks,
  ghExecEnv,
  type PrCheckState,
} from './ci-green-gate-github.js'

export {
  applyGateHandback,
  ensureGateTable,
  getGateRow,
  listNonGreenCompletions,
  renderNonGreenCompletions,
  repoFromPrUrl,
  runCompletionGate,
  type CompletedWithRedEntry,
  type GateObjective,
  type GateResult,
  type GateRow,
  type HandbackDeps,
  type RunGateOptions,
} from './ci-green-gate-run.js'
