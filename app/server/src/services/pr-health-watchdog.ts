/**
 * PR-health watchdog (obj 704700) — the RECONCILER that sits under the event-driven
 * auto-remediation loop in external-remediation.ts.
 *
 * WHY THIS EXISTS
 * ---------------
 * external-remediation.ts is EVENT-DRIVEN: a GitHub webhook arrives, it classifies the
 * failure, finds the owning objective, and nudges the worker. That is the fast path and
 * it works. But an event-driven loop has no notion of STEADY STATE — it only ever knows
 * about failures it was told about. Every one of these leaves a PR red forever with
 * nobody watching:
 *   - the webhook was never delivered (or was delivered while the server was down)
 *   - the event classified as non-actionable, so nothing was spawned
 *   - the owning objective is done-past-grace, so resolveObjective() declined
 *   - the PR has no objective at all (dependabot), so there was never an owner
 *   - the job was CANCELLED at a concurrency gate, which is not a `failure` conclusion
 *     and is therefore invisible to the event path, yet still renders the PR red
 *
 * This service closes that gap by RECONCILING rather than reacting: on a bounded
 * interval it enumerates every open PR across the tracked repos, computes each PR's true
 * health from the check rollup, cross-references who (if anyone) is currently on it, and
 * for anything red-and-unowned past a grace period takes exactly ONE bounded action.
 *
 * REQUIRED vs ADVISORY (obj 704763) — READ THIS BEFORE TOUCHING THE CLASSIFIER
 * ---------------------------------------------------------------------------
 * The first build had no concept of a required status check: every red square in the
 * rollup counted as a merge blocker. That was measurably wrong. On 2026-08-06 20:15:20 it
 * wrote a real `watchdog:escalate` row against EXAMPLE2/example3-platform#564, whose only red
 * check was `Verify migrations applied to prod` — a context that is NOT in that repo's
 * ruleset and therefore blocks nothing. A human was paged for paint, and the headline red
 * count (19-22) counted PRs that were mergeable that afternoon.
 *
 * So the watchdog now reads the truth from GitHub instead of inferring it. Per PR it
 * fetches `repos/{owner}/{repo}/rules/branches/{BASE BRANCH}` — the base branch, NOT
 * `main`, because most your-org/example-platform PRs target `redesign`, whose gate is a
 * completely different (in fact empty) list — caches the answer for an hour, and splits
 * `redChecks` into `requiredRedChecks` and `advisoryRedChecks`. Only the required side can
 * produce an action.
 *
 * THREE STATES, AND THE EMPTY LIST IS NOT "GREEN". `requiredGateState` is
 * enforced / no-ruleset / unknown (see RequiredGateState for the full contract). The one
 * worth spelling out here is `no-ruleset`: GitHub returns a literal `[]` for example's
 * `redesign` branch, meaning nothing is configured to gate it. That is NOT a statement
 * that the PR's checks passed — no check was ever asked to vouch for it. The digest says
 * "no required checks configured … this is NOT 'checks verified green'" in those words,
 * and mergeableNow defers entirely to GitHub's own mergeStateStatus rather than inferring
 * anything from the empty list.
 *
 * FAIL-SAFE. If the ruleset API errors, state is `unknown` and EVERY red check is treated
 * as required — i.e. the exact pre-704763 behaviour. Degrading the other way (assume
 * nothing is required, stop escalating) would be a silent, worse bug: a GitHub outage
 * would quietly switch the watchdog off.
 *
 * NON-GOALS / HARD LIMITS
 *   - Never merges anything. There is no merge call in this file.
 *   - Never touches `harness/*` check contexts (the harness gates its own PRs).
 *   - Never writes outside external_check_remediations.
 *   - Ships DARK: the act-path is gated on settings.pr_health_watchdog_enabled, read at
 *     CALL TIME so flipping it arms/disarms with no restart. With the flag off the sweep
 *     still computes and returns the full health report (that is what feeds the
 *     Operator-facing surface) but every action degrades to a logged "WOULD act".
 *
 * NO DOUBLE-DRIVING
 * -----------------
 * We deliberately SHARE external_check_remediations with external-remediation.ts rather
 * than inventing a parallel table, because a parallel table cannot see the event path's
 * work and the two loops would drive the same PR at once. Two consequences:
 *   1. Before acting we check for a RECENT row on (repo, pr_number, head_sha) written on
 *      behalf of a STILL-LIVE objective. Such a row means the event path is currently
 *      driving this exact commit → the PR has a live owner → skip. A row whose objective
 *      has since finished, or which is older than the freshness window, has expired and
 *      no longer confers ownership — see eventPathEngagement (obj 704784).
 *   2. When we do act we insert with a namespaced check_name `watchdog:<reason>`, so the
 *      existing UNIQUE(repo, pr_number, check_name, head_sha) makes our own actions
 *      idempotent across sweeps without colliding with real check names.
 *
 * Split: classify/gate in pr-health-decisions.ts, owner in pr-health-owner.ts,
 * sweep/act in pr-health-sweep.ts, digest in pr-health-digest.ts. This file is
 * the timer + re-export facade.
 */

import type { Database } from 'better-sqlite3'
import { type ExecFn, isWatchdogEnabled, watchdogDryRun } from './pr-health-decisions.js'
import {
  type WatchdogDeps,
  runWatchdogOnce,
} from './pr-health-sweep.js'

export {
  type ExecFn,
  type RollupEntry,
  type PrSummary,
  type RedCheck,
  type FailureKind,
  type RequiredGateState,
  type RequiredGate,
  type OwnerState,
  type Classification,
  type ActionKind,
  type PrHealth,
  type SweepResult,
  isHarnessCheck,
  isEnvironmentalCheck,
  isWatchdogEnabled,
  watchdogDryRun,
  watchdogRepos,
  graceMinutes,
  maxActionsPerSweep,
  rotationMinutes,
  actionQueueOrder,
  maxAttemptsPerPr,
  maxPrsPerRepo,
  gateKey,
  parseRequiredContexts,
  splitRedChecks,
  computeMergeableNow,
  summariseRollup,
  failureKindOf,
  classify,
  redSinceOf,
  decideAction,
} from './pr-health-decisions.js'

export {
  OWNER_STALE_MINUTES,
  objectiveIdFromBranch,
  resolveOwner,
  attemptsSpent,
  engagedFreshnessMinutes,
  isLiveObjectiveStatus,
  type Engagement,
  eventPathEngagement,
  eventPathEngaged,
} from './pr-health-owner.js'

export {
  type WatchdogDeps,
  resetRulesetCache,
  resolveRequiredGate,
  sweepHealth,
  claimAction,
  runWatchdogOnce,
  distinctRunIds,
} from './pr-health-sweep.js'

export { renderDigest } from './pr-health-digest.js'

// ── Scheduler ───────────────────────────────────────────────────────────────────

const TICK_MS = 10 * 60 * 1000

let tickTimer: NodeJS.Timeout | null = null

/**
 * Arm the sweep timer. The timer itself is harmless: the flag is checked INSIDE the
 * tick, so with pr_health_watchdog_enabled unset every tick is a no-op that does not
 * even shell out to `gh`. Set PR_HEALTH_WATCHDOG_DISABLED=true to not arm at all.
 */
export function startPrHealthWatchdog(deps?: Partial<WatchdogDeps>): void {
  if (process.env.PR_HEALTH_WATCHDOG_DISABLED === 'true') {
    console.log('[pr-health-watchdog] disabled via PR_HEALTH_WATCHDOG_DISABLED=true')
    return
  }
  if (tickTimer) return
  tickTimer = setInterval(() => {
    void tickOnce(deps)
  }, TICK_MS)
  if (typeof tickTimer.unref === 'function') tickTimer.unref()
  console.log(
    '[pr-health-watchdog] started — 10-min sweep (INERT until pr_health_watchdog_enabled=1, ' +
    'then DRY-RUN until pr_health_watchdog_dry_run=0)',
  )
}

export function stopPrHealthWatchdog(): void {
  if (tickTimer) clearInterval(tickTimer)
  tickTimer = null
}

async function tickOnce(overrides?: Partial<WatchdogDeps>): Promise<void> {
  try {
    const { getDb } = await import('../db/index.js')
    const db = overrides?.db || getDb()
    // Cheap gate — skip the gh calls entirely while dark.
    if (!isWatchdogEnabled(db)) return
    const deps = await buildDefaultDeps(db, overrides)
    const report = await runWatchdogOnce(deps)
    if (report.dryRun) {
      console.log('[pr-health-watchdog] DRY-RUN sweep — set settings.pr_health_watchdog_dry_run=\'0\' to act')
    }
    const acted = report.prs.filter(p => !p.wouldOnly && p.action !== 'none').length
    const red = report.prs.filter(p => p.classification !== 'green' && p.classification !== 'pending').length
    console.log(`[pr-health-watchdog] sweep complete — ${report.prsScanned} PRs, ${red} red, ${acted} action(s)`)
  } catch (err) {
    console.error('[pr-health-watchdog] sweep failed:', (err as Error).message)
  }
}

/** Default wiring. Kept out of the pure core so tests never reach real GitHub. */
export async function buildDefaultDeps(
  db: Database,
  overrides?: Partial<WatchdogDeps>,
): Promise<WatchdogDeps> {
  const { execFile } = await import('child_process')
  const { promisify } = await import('util')
  // The server process runs as root and its `gh` has NO auth in the default env — every
  // `gh pr list` here comes back "please run: gh auth login" and the whole sweep degrades
  // to prsScanned:0 with an errors[] per repo. Sessions authenticate via
  // GH_CONFIG_DIR=/etc/gh; state-poller/external-remediation/ci-feedback-bridge all route
  // their gh calls through that same env. Reuse state-poller's exported ghExecEnv rather
  // than adding a 4th private copy. Imported dynamically (not statically) so the pure core
  // of this module stays free of state-poller's heavy import graph.
  const { ghExecEnv } = await import('./state-poller.js')
  const pExecFile = promisify(execFile)
  const exec: ExecFn = async (file, args) => {
    const { stdout } = await pExecFile(file, args, {
      maxBuffer: 20 * 1024 * 1024,
      timeout: 120_000,
      env: ghExecEnv(),
    })
    return stdout
  }
  let notify: WatchdogDeps['notify']
  let sendFollowUp: WatchdogDeps['sendFollowUp']
  try {
    const n = await import('./notifier.js')
    notify = (a) => { void (n as { notify: (x: unknown) => unknown }).notify(a) }
  } catch { /* notifier optional — escalation degrades to a log line */ }
  try {
    const sm = await import('./session-manager.js')
    const fn = (sm as unknown as { sendFollowUp?: (s: string, m: string, o: never) => string }).sendFollowUp
    if (fn) sendFollowUp = (s, m, o) => fn(s, m, o as never)
  } catch { /* optional */ }

  // Resolved here, not in the caller, so BOTH entry points get it: the scheduled tick
  // (no overrides → the settings row decides) and the read-only route (passes an explicit
  // `dryRun: true`, which still wins because overrides spread last).
  return { db, exec, notify, sendFollowUp, dryRun: watchdogDryRun(db), ...overrides }
}
