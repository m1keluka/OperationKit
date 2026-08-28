/**
 * Pure PR-health classification, gate split, and action decisions — extracted
 * from pr-health-watchdog.ts (behavior frozen).
 *
 * No GitHub calls, no timers. The reconciler loop and ruleset cache stay on
 * the watchdog facade.
 */
import type { Database } from 'better-sqlite3'

// ── Types ───────────────────────────────────────────────────────────────────────

/** Same shape external-remediation.ts uses, so a caller can pass one exec for both. */
export type ExecFn = (file: string, args: string[]) => Promise<string>

/** A single entry from `gh pr view --json statusCheckRollup`. */
export interface RollupEntry {
  __typename?: string
  /** CheckRun */
  name?: string
  status?: string
  conclusion?: string
  completedAt?: string
  detailsUrl?: string
  workflowName?: string
  /** StatusContext */
  context?: string
  state?: string
  targetUrl?: string
}

export interface PrSummary {
  number: number
  title: string
  isDraft: boolean
  headRefOid: string
  headRefName: string
  /** The branch the PR merges INTO — the ruleset key. */
  baseRefName?: string
  mergeStateStatus?: string
  createdAt?: string
  author?: { login?: string; is_bot?: boolean }
  statusCheckRollup?: RollupEntry[] | null
}

/** One red check, normalised across CheckRun and StatusContext. */
export interface RedCheck {
  name: string
  /** 'failed' = a real conclusion of failure/timed_out/action_required (or status error).
   *  'cancelled' = the job was cancelled, typically at a concurrency gate — noise. */
  kind: 'failed' | 'cancelled'
  /** True when this failure cannot be fixed by pushing a commit (see ENVIRONMENTAL). */
  environmental: boolean
  completedAt: string | null
  url: string | null
}

/** What is wrong with the PR's checks, independent of who owns it. */
export type FailureKind = 'none' | 'cancellation-only' | 'environmental' | 'real-failure'

/**
 * How much we know about what actually GATES merge on this PR's base branch. Named for
 * what it asserts, because the three states mean genuinely different things and an
 * earlier build collapsed all of them into "red" (obj 704763).
 *
 *   'enforced'    — the ruleset was read and lists >=1 required status check. Only those
 *                   contexts block the merge; everything else in the rollup is paint.
 *   'no-ruleset'  — the ruleset was read successfully and gates NOTHING on this base
 *                   branch (GitHub returns `[]`, or a ruleset with no
 *                   required_status_checks rule). This is the live state of example-platform's
 *                   `redesign` branch, which is where most example PRs target.
 *                   *** THIS IS NOT "VERIFIED GREEN". *** It means no status check was
 *                   ever asked to vouch for this PR. Whether it is safe to merge is a
 *                   judgement GitHub's own mergeStateStatus makes, not one we infer from
 *                   an empty list. Rendered as "no required checks configured", never as
 *                   a pass.
 *   'unknown'     — the ruleset API errored / was unparseable. We know nothing, so we
 *                   FAIL SAFE: every red check is treated as potentially blocking and the
 *                   watchdog behaves exactly as it did before this feature existed.
 */
export type RequiredGateState = 'enforced' | 'no-ruleset' | 'unknown'

/** The resolved gate for one (repo, baseBranch). */
export interface RequiredGate {
  state: RequiredGateState
  /** Verbatim required contexts from the ruleset. Empty unless state === 'enforced'. */
  contexts: string[]
  /** Populated when state === 'unknown' — why we could not read the ruleset. */
  error: string | null
}

/** Who, if anyone, is currently on it. */
export type OwnerState =
  /** An objective owns this PR and is actively working it (or the event path just acted). */
  | 'owned-active'
  /** An objective owns it but has gone quiet / is done past the grace window. */
  | 'owned-stale'
  /** No objective references this PR at all — nobody has ever been responsible for it. */
  | 'unowned'

/** The single top-line label shown on the Mike-facing surface. Derived from the pair
 *  (failureKind, owner) by `classify()`. Precedence is documented there. */
export type Classification =
  | 'green'
  | 'pending'
  /** Red, but not on anything the base branch's ruleset requires. Pure paint. */
  | 'advisory-only'
  | 'cancellation-only'
  | 'unowned'
  | 'environmental'
  | 'real-failure'

/** The bounded action the reconciler picked. Exactly one per PR per sweep. */
export type ActionKind =
  | 'none'
  | 'skip-owner-engaged'
  | 'skip-grace'
  | 'skip-duplicate'
  | 'skip-cap'
  | 'rerun-cancelled'
  | 'refire-remediation'
  | 'escalate'

export interface PrHealth {
  repo: string
  number: number
  title: string
  url: string
  author: string
  authorIsBot: boolean
  headSha: string
  branch: string
  /** The branch this PR MERGES INTO. The ruleset is keyed on this, not on `main` —
   *  most example PRs target `redesign`, whose gate is completely different. */
  baseBranch: string
  /** GitHub's own verdict: CLEAN | UNSTABLE | BLOCKED | BEHIND | DIRTY | UNKNOWN. */
  mergeStateStatus: string | null
  isDraft: boolean
  classification: Classification
  failureKind: FailureKind
  /** How much we know about what gates this base branch. See RequiredGateState. */
  requiredGateState: RequiredGateState
  /** The verbatim required contexts read from the ruleset for `baseBranch`. */
  requiredContexts: string[]
  /** Red checks whose name IS a required context — these actually block the merge. */
  requiredRedChecks: RedCheck[]
  /** Red checks that gate nothing. Advisory paint. Never a reason to escalate. */
  advisoryRedChecks: RedCheck[]
  /** failureKindOf() over requiredRedChecks only — what is wrong with the GATE. */
  requiredFailureKind: FailureKind
  /** No required context failing AND GitHub does not report the merge blocked/conflicted
   *  AND the PR is not a draft. False whenever requiredGateState is 'unknown', because we
   *  cannot claim mergeability from a gate we failed to read. */
  mergeableNow: boolean
  owner: OwnerState
  /** Objective id that owns this PR, if one does. */
  objectiveId: number | null
  objectiveStatus: string | null
  /** WHY the owner state is what it is. Without this the digest shows baffling pairs
   *  like "obj 703394 (done, owned-active)" — true, but unreadable unless you know the
   *  objective was terminal-by-human or the event path just acted on this commit. */
  ownerReason: string | null
  /** Rows already spent in external_check_remediations for (repo, pr) — by BOTH loops. */
  attemptsSpent: number
  redChecks: RedCheck[]
  pendingCount: number
  successCount: number
  /** Oldest completion time among the red checks — when this PR went red. */
  redSince: string | null
  redForMinutes: number | null
  /** Populated by the reconcile pass; 'none' on a report-only sweep. This is always the
   *  DECIDED action, even when the sweep ran out of action budget — see `deferred`. */
  action: ActionKind
  actionDetail: string | null
  /** True when the decided action was correct but this sweep's action cap was already
   *  spent, so it rolls to the next sweep. Kept separate from `action` on purpose: an
   *  earlier build overwrote action with 'skip-cap' and the digest became a wall of
   *  "skip-cap" that told Mike nothing about what the watchdog actually intended. */
  deferred: boolean
  /** True when the action was logged but not performed (flag off or dryRun). */
  wouldOnly: boolean
}

export interface SweepResult {
  ranAt: string
  enabled: boolean
  dryRun: boolean
  repos: string[]
  prsScanned: number
  /** Repos that could not be enumerated (gh failure), so the report is partial. */
  errors: { repo: string; message: string }[]
  prs: PrHealth[]
  /** The gate resolved for each (repo, baseBranch) touched by this sweep, keyed
   *  `owner/repo@branch`. Surfaced so the digest can state WHY a PR was called advisory. */
  gates: Record<string, RequiredGate>
}

// ── Configuration (not scattered constants) ─────────────────────────────────────

/** Fallback repo list. Overridable at runtime via settings.pr_health_watchdog_repos or
 *  the PR_HEALTH_WATCHDOG_REPOS env var (comma-separated owner/repo), so adding a repo
 *  is a config change, not a code change. */
const DEFAULT_REPOS = [
  'EXAMPLE2/example3-platform',
  'your-org/example-platform',
  'Example-Project/example-project-platform',
]

/** Conclusions that mean a real failure. Mirrors external-remediation.FAIL_CONCLUSIONS
 *  intentionally — CANCELLED is NOT here; we treat it as its own (noise) kind. */
const FAIL_CONCLUSIONS = new Set(['FAILURE', 'TIMED_OUT', 'ACTION_REQUIRED'])
/** Commit-status states that mean a real failure. */
const FAIL_STATES = new Set(['FAILURE', 'ERROR'])
const PENDING_STATUSES = new Set(['QUEUED', 'IN_PROGRESS', 'WAITING', 'PENDING', 'REQUESTED'])

/**
 * Checks whose failure reflects the state of the WORLD, not the state of the branch —
 * a migration that was never applied to prod, an expired credential, a rate limit. No
 * amount of pushing commits turns these green, so re-firing remediation on them just
 * burns worker sessions. They escalate to a human instead.
 */
const ENVIRONMENTAL_PATTERNS = [
  /verify migrations applied to prod/i,
  /migrations applied to prod/i,
]

/** Contexts the harness owns. We never act on these — the harness gates its own PRs and
 *  a second driver would fight it. Matches external-remediation's harness carve-out. */
const HARNESS_PREFIX = 'harness/'

export function isHarnessCheck(name: string): boolean {
  return name.trim().toLowerCase().startsWith(HARNESS_PREFIX)
}

export function isEnvironmentalCheck(name: string): boolean {
  return ENVIRONMENTAL_PATTERNS.some(re => re.test(name))
}

function readSetting(db: Database | null, key: string): string | null {
  if (!db) return null
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined
    return row?.value ?? null
  } catch {
    return null
  }
}

function envTruthy(v: string | undefined): boolean {
  const s = (v || '').trim().toLowerCase()
  return s === '1' || s === 'true' || s === 'yes' || s === 'on'
}

/**
 * The owner switch for the whole act-path. Same two-source shape as
 * isRemediationEnabled: an explicit truthy env var wins outright, otherwise the
 * settings row. Default OFF. Read at CALL TIME so flipping it arms/disarms instantly
 * with no restart.
 */
export function isWatchdogEnabled(db: Database | null, env: NodeJS.ProcessEnv = process.env): boolean {
  if (envTruthy(env.PR_HEALTH_WATCHDOG_ENABLED)) return true
  return readSetting(db, 'pr_health_watchdog_enabled') === '1'
}

/**
 * The SECOND lock on the act-path, and the one the scheduled tick had no way to set.
 *
 * Before this existed, `buildDefaultDeps` returned no `dryRun` at all, so the scheduled
 * tick's deps carried `dryRun: undefined`. That was doubly wrong: `sweepHealth` reported
 * `dryRun: true` (its test is `!== false`) while `runWatchdogOnce` computed
 * `armed = enabled && dryRun !== true` — i.e. TRUE. The report told Mike "dry-run" while
 * the sweep was live, and there was no runtime control either way. Flipping
 * pr_health_watchdog_enabled='1' went straight to acting with no observable rehearsal.
 *
 * Now dry-run is explicit, runtime-settable, and FAIL-SAFE: dry unless someone
 * deliberately writes '0'. An env var can only ever make it safer (force dry), never
 * arm it. So the act-path needs BOTH pr_health_watchdog_enabled='1' AND
 * pr_health_watchdog_dry_run='0'; every other combination observes only.
 */
export function watchdogDryRun(db: Database | null, env: NodeJS.ProcessEnv = process.env): boolean {
  if (envTruthy(env.PR_HEALTH_WATCHDOG_DRY_RUN)) return true
  return readSetting(db, 'pr_health_watchdog_dry_run') !== '0'
}

/** Repos to sweep. settings row → env var → built-in default, first non-empty wins. */
export function watchdogRepos(db: Database | null, env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = readSetting(db, 'pr_health_watchdog_repos') || env.PR_HEALTH_WATCHDOG_REPOS || ''
  const parsed = raw
    .split(',')
    .map(s => s.trim())
    .filter(s => /^[\w.-]+\/[\w.-]+$/.test(s))
  return parsed.length > 0 ? parsed : [...DEFAULT_REPOS]
}

/** How long a PR must have been red before the watchdog is allowed to touch it. The
 *  grace exists so we never race the event path: a webhook that is merely slow gets
 *  its chance to act first. */
export function graceMinutes(env: NodeJS.ProcessEnv = process.env): number {
  const n = parseInt(env.PR_HEALTH_WATCHDOG_GRACE_MINUTES || '', 10)
  return Number.isInteger(n) && n > 0 ? n : 30
}

/** Hard ceiling on actions taken in a SINGLE sweep, across all repos. A misclassification
 *  or a repo-wide CI outage must not turn into 40 worker spawns. */
export function maxActionsPerSweep(env: NodeJS.ProcessEnv = process.env): number {
  const n = parseInt(env.PR_HEALTH_WATCHDOG_MAX_ACTIONS || '', 10)
  return Number.isInteger(n) && n > 0 ? n : 3
}

/** Length of one fairness rotation window, in minutes. Defaults to the sweep tick, so
 *  the action queue advances exactly once per sweep. See actionQueueOrder. */
export function rotationMinutes(env: NodeJS.ProcessEnv = process.env): number {
  const n = parseInt(env.PR_HEALTH_WATCHDOG_ROTATION_MINUTES || '', 10)
  return Number.isInteger(n) && n > 0 ? n : 10
}

/**
 * Order the act-path candidates so the per-sweep cap is spent FAIRLY. Pure.
 *
 * THE BUG THIS FIXES (obj 704787). The reconciler used to walk `report.prs` in
 * enumeration order — repo order, then `gh pr list` order, which is newest PR first —
 * and stopped at the cap. Enumeration order is a CONSTANT across sweeps, so the same
 * head-of-list PRs consumed the entire budget every single sweep and the tail was never
 * reached. Measured live on 2026-08-06 across five consecutive sweeps: candidates were
 * always [example3#629, #340, #338, #331, example#239], the cap of 3 always went to
 * {629, 340, 338}, and {#331, example#239} were deferred every time — byte-identical sets.
 * example#239 had been red 44,858 minutes (31 days) waiting for a turn that, structurally,
 * was never going to come. The digest even printed "(next sweep)" against it, which was
 * a promise the loop could not keep. The backlog was immortal by construction.
 *
 * THE FIX, in two parts, and NOTE THAT THE CAP ITSELF IS UNTOUCHED — it still bounds
 * blast radius to `maxActionsPerSweep` actions per sweep, which is the whole point of it:
 *
 *  1. AGEING. Sort by how long the PR has been red, descending, so the most-starved
 *     candidate is served first. This alone drains the current backlog: #239 and #340
 *     are the two oldest and go straight to the front. Redness age is monotonic, so a
 *     candidate that loses one sweep strictly improves its position in the next.
 *
 *  2. ROTATION. Ageing is not sufficient on its own: `redForMinutes` is null whenever
 *     GitHub gives no completion timestamp (live: example3#338), and those candidates
 *     would sort last forever. So the sorted queue is additionally rotated by a window
 *     index derived from the clock — offset = (window * cap) mod n. Consecutive windows
 *     serve contiguous, non-overlapping slices that advance by exactly `cap`, so the
 *     union of ceil(n / cap) consecutive windows is the whole queue. Starvation is
 *     therefore bounded: EVERY candidate is served within ceil(n / cap) sweeps, for any
 *     n and any cap >= 1.
 *
 * Deriving the window from the clock rather than from a stored cursor is deliberate:
 * GET /api/internal/pr-health calls runWatchdogOnce with dryRun and is documented as
 * strictly read-only, so the fairness state must not be a write. A pure function of
 * (candidates, now) keeps that guarantee and makes the rotation trivially testable.
 */
export function actionQueueOrder(
  candidates: PrHealth[],
  now: Date,
  env: NodeJS.ProcessEnv = process.env,
): PrHealth[] {
  const n = candidates.length
  const cap = maxActionsPerSweep(env)
  if (n <= cap) return [...candidates] // everyone is served; ordering is moot

  const sorted = [...candidates].sort(
    (a, b) =>
      (b.redForMinutes ?? -1) - (a.redForMinutes ?? -1) || // most-starved first
      a.repo.localeCompare(b.repo) ||
      a.number - b.number, // stable, and the older PR wins the tie
  )

  const windowMs = rotationMinutes(env) * 60_000
  const window = Math.floor(now.getTime() / windowMs)
  const offset = ((window * cap) % n + n) % n
  return [...sorted.slice(offset), ...sorted.slice(0, offset)]
}

/** Hard ceiling on total rows in external_check_remediations for one PR, counting BOTH
 *  loops. Past this the PR is a human problem, not a robot problem. */
export function maxAttemptsPerPr(env: NodeJS.ProcessEnv = process.env): number {
  const n = parseInt(env.PR_HEALTH_WATCHDOG_MAX_ATTEMPTS || '', 10)
  return Number.isInteger(n) && n > 0 ? n : 8
}

/** Cap on PRs enumerated per repo, so a repo with 500 open PRs cannot stall a tick. */
export function maxPrsPerRepo(env: NodeJS.ProcessEnv = process.env): number {
  const n = parseInt(env.PR_HEALTH_WATCHDOG_MAX_PRS || '', 10)
  return Number.isInteger(n) && n > 0 ? n : 60
}

export function gateKey(repo: string, baseBranch: string): string {
  return `${repo}@${baseBranch}`
}

/**
 * Parse `gh api repos/{owner}/{repo}/rules/branches/{branch}` output into a gate.
 *
 * The endpoint returns the FLATTENED, EFFECTIVE rule list for that ref across every
 * ruleset that applies to it — which is exactly what we want, because a repo can carry
 * several rulesets and only their union actually gates. We therefore union every
 * `required_status_checks` rule rather than taking the first.
 *
 * An empty array (`[]`) is a SUCCESSFUL read meaning "nothing is configured to gate this
 * branch" → 'no-ruleset'. It is deliberately NOT an error and deliberately NOT green.
 */
export function parseRequiredContexts(raw: string): RequiredGate {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw || '[]')
  } catch (err) {
    return { state: 'unknown', contexts: [], error: `unparseable ruleset response: ${(err as Error).message}` }
  }
  if (!Array.isArray(parsed)) {
    return { state: 'unknown', contexts: [], error: 'ruleset response was not an array' }
  }
  const contexts: string[] = []
  for (const rule of parsed as { type?: string; parameters?: { required_status_checks?: { context?: string }[] } }[]) {
    if (!rule || rule.type !== 'required_status_checks') continue
    for (const c of rule.parameters?.required_status_checks || []) {
      const ctx = (c?.context || '').trim()
      if (ctx && !contexts.includes(ctx)) contexts.push(ctx)
    }
  }
  return contexts.length > 0
    ? { state: 'enforced', contexts, error: null }
    : { state: 'no-ruleset', contexts: [], error: null }
}

function ctxKey(s: string): string {
  return s.trim().toLowerCase()
}

/**
 * Split red checks into the ones that actually gate the merge and the ones that are paint.
 *
 * When the gate is 'unknown' EVERY red check is reported as required. That is the
 * fail-safe: an unreadable ruleset must not downgrade a real failure to advisory.
 *
 * When the gate is 'no-ruleset' every red check is advisory, because — verifiably —
 * nothing is configured to block. See RequiredGateState: this is not a claim that the PR
 * is good, only that no status check is gating it.
 */
export function splitRedChecks(
  red: RedCheck[],
  gate: RequiredGate,
): { required: RedCheck[]; advisory: RedCheck[] } {
  if (gate.state === 'unknown') return { required: [...red], advisory: [] }
  const want = new Set(gate.contexts.map(ctxKey))
  const required: RedCheck[] = []
  const advisory: RedCheck[] = []
  for (const c of red) (want.has(ctxKey(c.name)) ? required : advisory).push(c)
  return { required, advisory }
}

/** GitHub merge states that mean "you cannot press the button right now". */
const UNMERGEABLE_STATES = new Set(['BLOCKED', 'DIRTY'])

/**
 * Can this PR be merged as it stands?
 *
 * Deliberately conservative on 'unknown': we did not read the gate, so we do not get to
 * assert mergeability. Deliberately permissive on 'no-ruleset': there we defer entirely
 * to GitHub's own `mergeStateStatus`, which is the authority on whether the button is
 * live, rather than inferring anything from the empty required list.
 */
export function computeMergeableNow(args: {
  gate: RequiredGate
  requiredRed: RedCheck[]
  mergeStateStatus: string | null
  isDraft: boolean
}): boolean {
  if (args.isDraft) return false
  if (args.gate.state === 'unknown') return false
  if (args.requiredRed.length > 0) return false
  const state = (args.mergeStateStatus || '').toUpperCase()
  if (UNMERGEABLE_STATES.has(state)) return false
  return true
}

// ── Pure classification ─────────────────────────────────────────────────────────

/**
 * Normalise a check rollup into red / pending / success buckets. Handles both
 * CheckRun (name/status/conclusion) and StatusContext (context/state) entries, which
 * carry the same information under different field names. harness/* is dropped
 * entirely — invisible to the watchdog by construction.
 */
export function summariseRollup(rollup: RollupEntry[] | null | undefined): {
  red: RedCheck[]
  pending: number
  success: number
} {
  const red: RedCheck[] = []
  let pending = 0
  let success = 0

  for (const e of rollup || []) {
    const name = (e.name ?? e.context ?? '').trim()
    if (!name || isHarnessCheck(name)) continue

    if (e.__typename === 'StatusContext' || (e.context !== undefined && e.name === undefined)) {
      // StatusContext (Vercel and other commit-status posters): only `state` is
      // meaningful — there is no `status`/`conclusion` pair.
      const state = (e.state || '').toUpperCase()
      if (FAIL_STATES.has(state)) {
        red.push({
          name,
          kind: 'failed',
          environmental: isEnvironmentalCheck(name),
          completedAt: e.completedAt || null,
          url: e.targetUrl || null,
        })
      } else if (state === 'SUCCESS') success++
      else if (PENDING_STATUSES.has(state)) pending++
      continue
    }

    // CheckRun: `status` says whether it finished, `conclusion` says how.
    const status = (e.status || '').toUpperCase()
    if (status && status !== 'COMPLETED') {
      if (PENDING_STATUSES.has(status)) pending++
      continue
    }
    const conclusion = (e.conclusion || '').toUpperCase()
    if (FAIL_CONCLUSIONS.has(conclusion)) {
      red.push({
        name,
        kind: 'failed',
        environmental: isEnvironmentalCheck(name),
        completedAt: normaliseTs(e.completedAt),
        url: e.detailsUrl || null,
      })
    } else if (conclusion === 'CANCELLED') {
      red.push({
        name,
        kind: 'cancelled',
        environmental: false,
        completedAt: normaliseTs(e.completedAt),
        url: e.detailsUrl || null,
      })
    } else if (conclusion === 'SUCCESS') success++
    else if (!conclusion) pending++
    // NEUTRAL / SKIPPED / STALE are neither red nor green — deliberately ignored.
  }

  return { red, pending, success }
}

/** GitHub renders "never completed" as the zero time; treat that as absent. */
function normaliseTs(ts: string | undefined): string | null {
  if (!ts) return null
  if (ts.startsWith('0001-01-01')) return null
  return ts
}

/** What is wrong with the checks, ignoring ownership. */
export function failureKindOf(red: RedCheck[], pending: number): FailureKind {
  const realFails = red.filter(r => r.kind === 'failed')
  if (realFails.length === 0) {
    return red.length > 0 ? 'cancellation-only' : 'none'
  }
  // Environmental only when EVERY real failure is environmental — one genuine test
  // failure alongside a migration check is still a real failure the worker must fix.
  if (realFails.every(r => r.environmental)) return 'environmental'
  void pending
  return 'real-failure'
}

/**
 * Collapse (failureKind, owner, pending) into the one label Mike reads.
 *
 * THE REQUIRED-CONTEXT GATE (obj 704763). When `gate` is supplied and its state is not
 * 'unknown', classification is computed from the checks that ACTUALLY BLOCK THE MERGE, not
 * from every red square in the rollup. Everything below happens on `gate.requiredKind`.
 * Before this, one advisory red — `Verify migrations applied to prod`, which is not in
 * example3's ruleset — was enough to label a PR ENVIRONMENTAL and escalate it to a human.
 * That produced a real escalate row on example3#564 on 2026-08-06 whose only red check
 * gated nothing.
 *
 * A PR that is red but has NO required context failing gets its own label,
 * 'advisory-only'. It is NOT relabelled 'green': the checks really are red and hiding that
 * would be its own dishonesty. It is simply not something to act on.
 *
 * `gate` omitted, or state 'unknown', reproduces the pre-704763 behaviour exactly — the
 * fail-safe.
 *
 * Precedence, and why:
 *   1. green    — nothing red at all.
 *   2. pending  — nothing red and checks still running; not a problem yet.
 *   2b. advisory-only — red, but nothing REQUIRED is red. Merge is not gated on it.
 *   3. cancellation-only — red but zero real failures. This is pure gate noise and is
 *      cheap to fix (re-run), so it is worth calling out even on an unowned PR.
 *   4. environmental — all real failures are unfixable-by-push.
 *   5. unowned  — red with real failures and NOBODY is responsible.
 *   6. real-failure  — an owned PR with a genuine failing check.
 *
 * WHY environmental OUTRANKS unowned: the two say different kinds of thing.
 * "environmental" is a claim about the REMEDY ("no commit can fix this") and it is true
 * whether or not anyone owns the PR; "unowned" is a claim about WHO TO TELL. Ordering
 * ownership first would relabel a prod-migration failure as `unowned` the moment its
 * objective was GC'd, and the reader would lose the one fact that actually decides what
 * to do with it. Verified against the live board: example3 #629 and #564 fail ONLY
 * `Verify migrations applied to prod` and have no objective row at all — they are
 * environmental first and unowned second, and the digest still prints "no owning
 * objective" on the ownership line either way, so nothing is hidden.
 */
export function classify(
  kind: FailureKind,
  owner: OwnerState,
  pending: number,
  gate?: { state: RequiredGateState; requiredKind: FailureKind },
): Classification {
  if (kind === 'none') return pending > 0 ? 'pending' : 'green'
  // Gate known → judge on the required checks only.
  const effective = gate && gate.state !== 'unknown' ? gate.requiredKind : kind
  if (effective === 'none') return 'advisory-only'
  if (effective === 'cancellation-only') return 'cancellation-only'
  if (effective === 'environmental') return 'environmental'
  if (owner === 'unowned') return 'unowned'
  return 'real-failure'
}

/** Oldest completion among red checks — the moment the PR went red. */
export function redSinceOf(red: RedCheck[]): string | null {
  const stamps = red.map(r => r.completedAt).filter((s): s is string => !!s).sort()
  return stamps[0] ?? null
}

/**
 * The red checks the watchdog is allowed to act ON. With a readable ruleset that is the
 * required subset; with an unreadable one it is every red check (fail-safe), which is
 * also exactly what `requiredRedChecks` holds in that case — but older callers and
 * hand-built PrHealth fixtures may not carry the split at all, so fall back to redChecks.
 */
export function gatingChecks(h: PrHealth): RedCheck[] {
  return h.requiredRedChecks ?? h.redChecks
}

export function decideAction(
  h: PrHealth,
  env: NodeJS.ProcessEnv = process.env,
): { action: ActionKind; detail: string } {
  if (h.isDraft) return { action: 'none', detail: 'draft' }
  if (h.classification === 'green' || h.classification === 'pending') {
    return { action: 'none', detail: h.classification }
  }
  // THE 704763 FIX. Red paint on a check the ruleset does not require gates nothing, so
  // there is nothing to remediate and nobody to wake. Escalating it was pure noise — a
  // human got paged for example3#564 whose only red was `Verify migrations applied to
  // prod`, a context absent from that repo's required list. Guarded on
  // requiredGateState !== 'unknown' so an unreadable ruleset can never route a genuine
  // required failure through this branch.
  const gateKnown = h.requiredGateState !== undefined && h.requiredGateState !== 'unknown'
  if (gateKnown && (h.requiredRedChecks?.length ?? 0) === 0 && h.redChecks.length > 0) {
    const names = (h.advisoryRedChecks ?? h.redChecks).map(c => c.name).join(', ')
    const why =
      h.requiredGateState === 'no-ruleset'
        ? `no required checks configured on base \`${h.baseBranch}\``
        : `required: ${h.requiredContexts.join(', ')}`
    return { action: 'none', detail: `advisory-only (${why}) — red but not gating: ${names}` }
  }
  if (h.owner === 'owned-active') {
    return { action: 'skip-owner-engaged', detail: `objective ${h.objectiveId} is on it` }
  }

  const grace = graceMinutes(env)
  if (h.redForMinutes !== null && h.redForMinutes < grace) {
    return { action: 'skip-grace', detail: `red ${h.redForMinutes}m < grace ${grace}m` }
  }

  if (h.attemptsSpent >= maxAttemptsPerPr(env)) {
    return { action: 'skip-cap', detail: `${h.attemptsSpent} attempts spent >= cap` }
  }

  switch (h.classification) {
    case 'advisory-only':
      // Unreachable in practice — the guard above catches it — but kept so the switch
      // stays exhaustive over Classification and a future edit cannot fall through to
      // 'unclassified'.
      return { action: 'none', detail: 'advisory-only' }
    case 'cancellation-only':
      // Zero real failures — the branch is probably fine and just lost a race at a
      // concurrency gate. Cheapest possible fix, and it costs no worker session.
      return { action: 'rerun-cancelled', detail: `${gatingChecks(h).length} cancelled job(s)` }
    case 'environmental':
      // A push cannot fix "migrations not applied to prod". Re-firing the worker would
      // burn a session to no effect, so this goes straight to a human. Note this now only
      // fires when the environmental check is a REQUIRED context — the example3 migration
      // gate is advisory and no longer reaches here.
      return { action: 'escalate', detail: `environmental: ${gatingChecks(h).map(c => c.name).join(', ')}` }
    case 'unowned':
      // Nobody has ever been responsible for this PR (typically dependabot). There is no
      // session to nudge, so the only honest action is to tell a human it exists.
      return { action: 'escalate', detail: `no owning objective (author ${h.author})` }
    case 'real-failure':
      // Owned, but the owner has gone quiet and the PR is still red past grace. This is
      // exactly the "webhook missed / objective done-past-grace" hole.
      return { action: 'refire-remediation', detail: `objective ${h.objectiveId} stale, still red` }
    default:
      return { action: 'none', detail: 'unclassified' }
  }
}

