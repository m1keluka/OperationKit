/**
 * PR-health sweep and act-path — extracted from pr-health-watchdog.ts (behavior frozen).
 */
import type { Database } from 'better-sqlite3'
import {
  type ExecFn,
  type PrSummary,
  type RedCheck,
  type ActionKind,
  type PrHealth,
  type SweepResult,
  isWatchdogEnabled,
  watchdogRepos,
  maxActionsPerSweep,
  actionQueueOrder,
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
  gatingChecks,
  type RequiredGate,
  type OwnerState,
} from './pr-health-decisions.js'
import {
  OWNER_STALE_MINUTES,
  resolveOwner,
  attemptsSpent,
  eventPathEngagement,
  minutesSince,
  NOT_ENGAGED_NO_ROW,
} from './pr-health-owner.js'

// ── Required-context resolution (the ruleset) ───────────────────────────────────

/** How long a resolved gate is reused. A sweep runs every 10 min and rulesets change
 *  roughly never, so this keeps us to ~1 ruleset call per repo per hour. */
const RULESET_TTL_MS = 60 * 60 * 1000
/** Failures are cached far more briefly — a transient 500 must not blind the watchdog
 *  for an hour, but a hard outage must not turn every sweep into N retries either. */
const RULESET_ERROR_TTL_MS = 2 * 60 * 1000

const rulesetCache = new Map<string, { at: number; value: RequiredGate }>()

/** Test seam — the cache is module-level, so suites must be able to clear it. */
export function resetRulesetCache(): void {
  rulesetCache.clear()
}

/**
 * Resolve the required-context gate for one (repo, baseBranch), cached in-process.
 *
 * FAIL-SAFE CONTRACT: any error resolves to `state: 'unknown'`, and every downstream
 * consumer treats 'unknown' as "assume every red check could be blocking". A ruleset
 * outage must never silently reclassify a genuine required failure as advisory paint and
 * stop the watchdog escalating it — that would be a worse bug than the one this feature
 * fixes, because it fails SILENTLY.
 */
export async function resolveRequiredGate(
  exec: ExecFn,
  repo: string,
  baseBranch: string,
  now: Date = new Date(),
): Promise<RequiredGate> {
  if (!baseBranch) {
    return { state: 'unknown', contexts: [], error: 'PR has no base branch' }
  }
  const key = gateKey(repo, baseBranch)
  const hit = rulesetCache.get(key)
  if (hit) {
    const ttl = hit.value.state === 'unknown' ? RULESET_ERROR_TTL_MS : RULESET_TTL_MS
    if (now.getTime() - hit.at < ttl) return hit.value
  }

  let value: RequiredGate
  try {
    const out = await exec('gh', [
      'api',
      `repos/${repo}/rules/branches/${encodeURIComponent(baseBranch)}`,
    ])
    value = parseRequiredContexts(out)
  } catch (err) {
    value = { state: 'unknown', contexts: [], error: (err as Error).message }
  }
  rulesetCache.set(key, { at: now.getTime(), value })
  return value
}

// ── Sweep ───────────────────────────────────────────────────────────────────────

export interface WatchdogDeps {
  db: Database
  exec: ExecFn
  /** Same signature as session-manager.sendFollowUp. Only called on the act-path. */
  sendFollowUp?: (sessionId: string, message: string, objective: unknown) => string
  /** Escalation sink — the notifier. Only called on the act-path. */
  notify?: (args: { severity: string; title: string; message: string; dedup_key?: string; url?: string }) => void
  env?: NodeJS.ProcessEnv
  now?: () => Date
  /** Force report-only even when the flag is on. The route always passes true. */
  dryRun?: boolean
}

const PR_FIELDS =
  'number,title,isDraft,headRefOid,headRefName,baseRefName,mergeStateStatus,createdAt,author,statusCheckRollup'

async function listOpenPrs(exec: ExecFn, repo: string, limit: number): Promise<PrSummary[]> {
  const out = await exec('gh', [
    'pr', 'list', '--repo', repo, '--state', 'open', '--limit', String(limit), '--json', PR_FIELDS,
  ])
  const parsed = JSON.parse(out || '[]')
  return Array.isArray(parsed) ? (parsed as PrSummary[]) : []
}

/**
 * Compute health for every open PR across the configured repos. PURE OBSERVATION —
 * this function issues only read-only `gh pr list` calls and never writes. It is what
 * the Operator-facing surface renders, and it runs identically whether the act-path flag is
 * on or off.
 */
export async function sweepHealth(deps: WatchdogDeps): Promise<SweepResult> {
  const env = deps.env || process.env
  const now = (deps.now || (() => new Date()))()
  const repos = watchdogRepos(deps.db, env)
  const limit = maxPrsPerRepo(env)
  const errors: { repo: string; message: string }[] = []
  const prs: PrHealth[] = []
  const gates: Record<string, RequiredGate> = {}

  for (const repo of repos) {
    let list: PrSummary[]
    try {
      list = await listOpenPrs(deps.exec, repo, limit)
    } catch (err) {
      errors.push({ repo, message: (err as Error).message })
      continue
    }

    for (const pr of list) {
      const { red, pending, success } = summariseRollup(pr.statusCheckRollup)
      const kind = failureKindOf(red, pending)
      const branch = pr.headRefName || ''
      // Keyed on the BASE branch, not on `main`: most example PRs target `redesign`, whose
      // gate is a different (in fact empty) list. Cached, so this is ~1 call per repo/hour.
      const baseBranch = pr.baseRefName || ''
      const gate = await resolveRequiredGate(deps.exec, repo, baseBranch, now)
      gates[gateKey(repo, baseBranch)] = gate
      const { required: requiredRed, advisory: advisoryRed } = splitRedChecks(red, gate)
      const requiredKind = failureKindOf(requiredRed, pending)
      const mergeStateStatus = pr.mergeStateStatus || null
      const { objectiveId, status, owner, reason } = resolveOwner(deps.db, repo, pr.number, branch, now)
      const headSha = pr.headRefOid || ''
      // The event path acting RECENTLY on this commit, on behalf of an objective that is
      // still live, is proof of an engaged owner even when the PR's own objective row
      // looks stale. Expired engagement falls back to resolveOwner's verdict rather than
      // overriding it — that fallback is the whole convergence fix (obj 704784).
      const engagement = headSha
        ? eventPathEngagement(deps.db, repo, pr.number, headSha, now, OWNER_STALE_MINUTES, env)
        : NOT_ENGAGED_NO_ROW
      const effOwner: OwnerState = engagement.engaged ? 'owned-active' : owner
      const ownerReason = engagement.engaged
        ? engagement.reason
        : engagement.rowAgeMinutes === null
          ? reason
          // Keep BOTH facts on the surface: why the stale remediation row stopped
          // counting, and what the objective row itself says.
          : `${engagement.reason}; ${reason}`
      const redSince = redSinceOf(red)

      prs.push({
        repo,
        number: pr.number,
        title: pr.title || '',
        url: `https://github.com/${repo}/pull/${pr.number}`,
        author: pr.author?.login || 'unknown',
        authorIsBot: !!pr.author?.is_bot || /\[bot\]$|^dependabot$/i.test(pr.author?.login || ''),
        headSha,
        branch,
        baseBranch,
        mergeStateStatus,
        isDraft: !!pr.isDraft,
        classification: classify(kind, effOwner, pending, { state: gate.state, requiredKind }),
        failureKind: kind,
        requiredGateState: gate.state,
        requiredContexts: gate.contexts,
        requiredRedChecks: requiredRed,
        advisoryRedChecks: advisoryRed,
        requiredFailureKind: requiredKind,
        mergeableNow: computeMergeableNow({
          gate,
          requiredRed,
          mergeStateStatus,
          isDraft: !!pr.isDraft,
        }),
        owner: effOwner,
        objectiveId,
        objectiveStatus: status,
        ownerReason,
        attemptsSpent: attemptsSpent(deps.db, repo, pr.number),
        redChecks: red,
        pendingCount: pending,
        successCount: success,
        redSince,
        redForMinutes: minutesSince(redSince, now),
        action: 'none',
        actionDetail: null,
        deferred: false,
        wouldOnly: true,
      })
    }
  }

  return {
    ranAt: now.toISOString(),
    enabled: isWatchdogEnabled(deps.db, env),
    dryRun: deps.dryRun !== false,
    repos,
    prsScanned: prs.length,
    errors,
    prs,
    gates,
  }
}

/**
 * Decide the single bounded action for one PR. Pure — no I/O, no writes — so the whole
 * decision table is unit-testable and the act-path below is a thin executor.
 *
 * Order of guards matters and encodes the safety posture:
 *   draft/green/pending → nothing to do
 *   owner engaged       → the event path or a live worker owns it; NEVER double-drive
 *   inside grace        → give the webhook its chance first
 *   attempt cap         → this PR has burned its budget; a human owns it now
 */
/**
 * Claim the right to act on (repo, pr, headSha, reason) exactly once, ever.
 *
 * The claim is an INSERT OR IGNORE into the SHARED external_check_remediations table
 * under a namespaced check_name. `changes === 0` means a previous sweep already claimed
 * this exact tuple → we are a repeat sweep and must not act again. This is the whole
 * idempotency story; there is no second bookkeeping scheme to keep in sync.
 */
export function claimAction(
  db: Database,
  repo: string,
  prNumber: number,
  headSha: string,
  reason: ActionKind,
  objectiveId: number | null,
): boolean {
  try {
    const info = db
      .prepare(
        `INSERT OR IGNORE INTO external_check_remediations
           (objective_id, repo, pr_number, check_name, head_sha, attempt)
         VALUES (?, ?, ?, ?, ?, 0)`,
      )
      .run(objectiveId ?? 0, repo, prNumber, `watchdog:${reason}`, headSha)
    return info.changes > 0
  } catch {
    return false
  }
}

/**
 * Full reconcile pass: observe, decide, and (only if armed) act.
 *
 * DARK BY DEFAULT. With settings.pr_health_watchdog_enabled unset, or with dryRun, every
 * decided action is logged as "WOULD act", no claim row is written, and nothing is
 * posted to GitHub or to a session. The returned report is identical either way, which
 * is what makes the dry-run a truthful preview rather than a different code path.
 */
export async function runWatchdogOnce(deps: WatchdogDeps): Promise<SweepResult> {
  const env = deps.env || process.env
  const report = await sweepHealth(deps)
  // Fail-safe and CONSISTENT WITH THE REPORT: sweepHealth publishes `dryRun: deps.dryRun
  // !== false`, so anything but an explicit `false` must observe only. The old test
  // (`!== true`) let `dryRun: undefined` act while the very same report said "dry-run".
  const armed = report.enabled && deps.dryRun === false
  const cap = maxActionsPerSweep(env)
  const now = (deps.now || (() => new Date()))()
  let acted = 0

  // PASS 1 — decide for EVERY PR. Decisions are per-PR and independent, so they must not
  // depend on the cap or on the order the budget happens to be spent in. This also means
  // `report.prs` keeps its enumeration order for the JSON surface and the digest; only
  // the order the BUDGET is spent in changes below.
  const details = new Map<PrHealth, string>()
  const candidates: PrHealth[] = []
  for (const h of report.prs) {
    const { action, detail } = decideAction(h, env)
    h.action = action
    h.actionDetail = detail
    h.wouldOnly = true
    h.deferred = false
    details.set(h, detail)

    if (action === 'rerun-cancelled' || action === 'refire-remediation' || action === 'escalate') {
      candidates.push(h)
    }
  }

  // PASS 2 — spend the cap in FAIRNESS order, not enumeration order. Without this the
  // same head-of-list PRs won the budget every sweep forever; see actionQueueOrder.
  const queue = actionQueueOrder(candidates, now, env)

  for (let i = 0; i < queue.length; i++) {
    const h = queue[i]
    const action = h.action
    const detail = details.get(h) as string

    if (acted >= cap) {
      // Budget spent. Keep the DECIDED action visible and flag the deferral separately —
      // the surface's whole job is to tell Operator what the watchdog intends, and
      // overwriting that with 'skip-cap' would hide it behind a bookkeeping detail.
      // The queue position is included because "deferred" on its own used to imply
      // "next sweep", which was false while the order was fixed.
      h.deferred = true
      h.actionDetail =
        `${detail} — deferred, sweep cap ${cap} reached; queued ${i + 1}/${queue.length}, ` +
        `served within ${Math.ceil(queue.length / cap)} sweep(s)`
      continue
    }

    if (!armed) {
      console.log(
        `[pr-health-watchdog] WOULD ${action} on ${h.repo}#${h.number} (${h.classification}) — ${detail}`,
      )
      acted++
      continue
    }

    // Armed. Claim first — if another sweep already claimed this tuple, stand down
    // BEFORE doing anything observable.
    if (!claimAction(deps.db, h.repo, h.number, h.headSha, action, h.objectiveId)) {
      h.action = 'skip-duplicate'
      h.actionDetail = 'already acted on this (repo, pr, sha, reason)'
      continue
    }

    acted++
    h.wouldOnly = false
    try {
      await performAction(deps, h, action, detail)
    } catch (err) {
      h.actionDetail = `${detail} — action failed: ${(err as Error).message}`
      console.error(`[pr-health-watchdog] action ${action} failed on ${h.repo}#${h.number}:`, err)
    }
  }

  return report
}

/** The only place this service touches the outside world. Never merges. */
async function performAction(
  deps: WatchdogDeps,
  h: PrHealth,
  action: ActionKind,
  detail: string,
): Promise<void> {
  if (action === 'rerun-cancelled') {
    // Re-run the distinct workflow runs behind the cancelled jobs. Bounded to 2 runs so
    // one pathological PR cannot spray re-runs across a repo's Actions quota.
    const runIds = distinctRunIds(gatingChecks(h)).slice(0, 2)
    for (const id of runIds) {
      await deps.exec('gh', ['run', 'rerun', id, '--repo', h.repo])
    }
    console.log(`[pr-health-watchdog] re-ran ${runIds.length} cancelled run(s) on ${h.repo}#${h.number}`)
    return
  }

  if (action === 'refire-remediation') {
    const names = gatingChecks(h).filter(c => c.kind === 'failed').map(c => c.name).join(', ')
    const msg =
      `PR-health watchdog: ${h.repo}#${h.number} has been red for ${h.redForMinutes ?? '?'} minutes ` +
      `with no active owner. Failing REQUIRED checks: ${names}. ${h.url}\n` +
      `Please drive this PR's checks to green. Do not merge.`
    const sid = lastSessionFor(deps.db, h.objectiveId)
    if (sid && deps.sendFollowUp) {
      deps.sendFollowUp(sid, msg, { id: h.objectiveId })
      console.log(`[pr-health-watchdog] re-fired remediation on objective ${h.objectiveId} (${h.repo}#${h.number})`)
    } else {
      escalate(deps, h, `${detail} (no session to nudge)`)
    }
    return
  }

  if (action === 'escalate') escalate(deps, h, detail)
}

function escalate(deps: WatchdogDeps, h: PrHealth, detail: string): void {
  const names = h.redChecks.map(c => `${c.name}${c.kind === 'cancelled' ? ' (cancelled)' : ''}`).join(', ')
  deps.notify?.({
    severity: 'high',
    title: `Red PR with no owner: ${h.repo}#${h.number}`,
    message: `${h.title}\n\nClassification: ${h.classification}\nRed checks: ${names}\n${detail}`,
    dedup_key: `pr-health:${h.repo}:${h.number}:${h.headSha}`,
    url: h.url,
  })
  console.log(`[pr-health-watchdog] escalated ${h.repo}#${h.number} — ${detail}`)
}

/** GitHub Actions run ids live in the job detailsUrl: /actions/runs/<id>/job/<id>. */
export function distinctRunIds(checks: RedCheck[]): string[] {
  const ids = new Set<string>()
  for (const c of checks) {
    if (c.kind !== 'cancelled' || !c.url) continue
    const m = c.url.match(/\/actions\/runs\/(\d+)/)
    if (m) ids.add(m[1])
  }
  return [...ids]
}

function lastSessionFor(db: Database, objectiveId: number | null): string | null {
  if (!objectiveId) return null
  try {
    const row = db.prepare('SELECT session_id FROM objectives WHERE id = ?').get(objectiveId) as
      | { session_id?: string }
      | undefined
    return row?.session_id || null
  } catch {
    return null
  }
}

