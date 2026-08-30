// Server-side PR auto-linkage + self-healing harness status (obj 2352).
//
// Root cause (obj 2335 / PR #147): the `main` ruleset requires the status check
// `harness/test-agent`, which has NO CI producer — it is posted ONLY by the
// server's `postHarnessStatus` when an objective PASSES ai_review, and that post
// returns early unless the objective row carries a resolvable PR (pr_number, or a
// pr_url it can parse). When the worker never successfully calls
// `POST /api/internal/pr-created`, pr_number stays NULL, the gate never posts, and
// the PR is stranded with its merge button disabled.
//
// Two complementary, additive, idempotent fixes live here. Both are pure decision
// logic over an injected `GhExec` so they unit-test without shelling out; the
// real `gh` runner and the poller wiring live in state-poller.ts.
//
//   Part 1 — discoverAndBackfillPR: for an objective with a server-derived branch
//            (deriveBranchName / branch_leases / objectives.branch_name) but NULL
//            pr_number, ask GitHub for the PR whose head matches the branch and
//            backfill pr_url+pr_number reusing the SAME write path as /pr-created.
//
//   Part 2 — selfHealHarnessStatus: for a review/done objective with a genuine
//            PASS verdict whose PR head SHA lacks `harness/test-agent`, (re)post
//            success via the existing postHarnessStatus mechanism. Never flips a
//            FAIL verdict to success; never double-posts when the status is present.

import type { Database } from 'better-sqlite3'
import type { Objective } from '@operationkit/shared'
import { deriveBranchName } from './branch-scope.js'
import {
  upsertObjectivePR,
  classifyObjectiveRepo,
  REPO_SCOPE_SQL,
  repoScopeParams,
} from './objective-prs.js'
import { parsePrNumberFromUrl } from './pr-url.js'

/** Default target repo for `gh` calls — overridable for tests/alternate deploys. */
export const PR_LINKAGE_REPO = process.env.HARNESS_REPO || 'your-org/command-center-infra'

/** The gating commit-status context this whole subsystem exists to keep alive. */
export const HARNESS_CONTEXT = 'harness/test-agent'

/**
 * Injected `gh` runner: receives the argv AFTER `gh` (e.g. `['pr','list',...]` or
 * `['api', ...]`), resolves trimmed stdout, rejects on non-zero exit/timeout. The
 * real implementation (state-poller.ts) shells `gh` with GH_CONFIG_DIR=/etc/gh and
 * a bounded timeout; tests pass a fake.
 */
export type GhExec = (args: string[]) => Promise<string>

/** Posts `harness/test-agent=success` for a resolved PR. In production this is
 *  state-poller's existing `postHarnessStatus` (retrying + idempotent). Injected so
 *  the self-heal decision can be unit-tested without the gh/network mechanism. */
export type PostHarnessSuccess = (objective: Objective, prNumber: number) => void

export interface DiscoverResult {
  linked: boolean
  pr_number?: number
  pr_url?: string | null
  branch?: string
  reason: string
}

export interface SelfHealResult {
  posted: boolean
  reason: string
  pr_number?: number
  sha?: string
}

// ── Kill switch ──────────────────────────────────────────────────────────────
/**
 * Belt-and-suspenders global OFF for BOTH sweeps. The feature is safe/idempotent
 * so it defaults ON, but command-center self-hosts — one settings write
 * (`pr_autolink_killed=1`) or the env `CC_PR_AUTOLINK_KILLED` must be able to
 * instantly disarm the auto-link + self-heal sweeps without a code edit. Fail-safe:
 * an unreadable settings table reports "not killed" so the safety net keeps running.
 */
export function isPrAutolinkKilled(db: Database, env: NodeJS.ProcessEnv = process.env): boolean {
  const envKill = (env.CC_PR_AUTOLINK_KILLED || '').toLowerCase()
  if (envKill === '1' || envKill === 'true' || envKill === 'yes' || envKill === 'on') return true
  try {
    const row = db
      .prepare("SELECT value FROM settings WHERE key = 'pr_autolink_killed'")
      .get() as { value?: string } | undefined
    return row?.value === '1' || row?.value === 'true'
  } catch {
    return false
  }
}

/**
 * Resolve the branch this objective owns WITHOUT trusting the worker's self-report.
 * Prefers the deterministic {@link deriveBranchName} (which already honours an
 * explicit objectives.branch_name), then falls back to a live/most-recent
 * `branch_leases` row keyed by objective_id (obj 994). Returns null when nothing
 * pins a branch.
 */
export function resolveBranchForObjective(db: Database, objective: Objective): string | null {
  const derived = deriveBranchName(objective)
  if (derived) return derived
  try {
    const row = db
      .prepare(
        `SELECT branch_name FROM branch_leases
          WHERE objective_id = ?
          ORDER BY (released_at IS NULL) DESC, heartbeat_at DESC
          LIMIT 1`,
      )
      .get(objective.id) as { branch_name?: string } | undefined
    const b = row?.branch_name?.trim()
    return b || null
  } catch {
    return null
  }
}

/**
 * Cadence for the age-unbounded earned-status backstop (obj 704718). The sweep that
 * calls it runs on every 3s poll tick; this slice deliberately does not.
 */
export const EARNED_STATUS_BACKSTOP_INTERVAL_MS = 10 * 60 * 1000

/**
 * Part 2b — objectives that ALREADY EARNED `harness/test-agent` but sit outside the
 * poller's `-2 days` discovery window (obj 704718).
 *
 * THE TRAP. `harness/test-agent` is a commit status attached to a head SHA, and the
 * `harness-gate-main` ruleset sets `strict_required_status_checks_policy`, so a PR
 * must ALSO be up to date with main — and updating the branch to clear `BEHIND` moves
 * the head SHA, dropping the status. The recent-window query then never re-posts it if
 * the owning objective is older than two days. Live example: cc-infra PR #243 is green
 * on head `891a8f50` and blocked only by `BEHIND`; owning obj 704214 was last updated
 * 2026-08-03. Updating the branch would make the PR permanently unmergeable — by the
 * act of making it mergeable.
 *
 * The window is a bound on DISCOVERING new work. It must not gate RE-POSTING a verdict
 * that was already earned, so this query drops the age gate. It stays cheap because:
 *   (a) it is REPO-SCOPED IN SQL — also the Defect-2 fix at this call site. Of 211
 *       pass-verdict review/done objectives only 35 are in the harness repo; without
 *       the scope the other 176 each burn a doomed `gh api` call against the wrong
 *       repo. (The `other-repo` guard inside {@link selfHealHarnessStatus} only helps
 *       AFTER the row has been loaded and iterated — obj 1955's footgun.)
 *   (b) `LIMIT 50`.
 *   (c) the caller throttles it to {@link EARNED_STATUS_BACKSTOP_INTERVAL_MS}.
 *
 * Never throws — a query failure returns [] and the recent-window path is unaffected.
 */
export function selectAgedEarnedStatusTargets(db: Database, repo: string = PR_LINKAGE_REPO): Objective[] {
  try {
    return db
      .prepare(
        `SELECT o.* FROM objectives o
          WHERE o.status IN ('review','done') AND o.ai_review_verdict = 'pass'
            AND (o.pr_number IS NOT NULL OR o.pr_url IS NOT NULL)
            AND o.updated_at <= datetime('now','-2 days')
            AND ${REPO_SCOPE_SQL}
          ORDER BY o.updated_at DESC
          LIMIT 50`,
      )
      .all(...repoScopeParams(repo)) as Objective[]
  } catch (err) {
    console.error('[pr-linkage] earned-status backstop query failed:', (err as Error).message)
    return []
  }
}

/**
 * Part 1 — discover a worker's PR from its server-derived branch and backfill
 * pr_url+pr_number onto the objective, reusing the /pr-created write path (the
 * `UPDATE objectives ...` + {@link upsertObjectivePR}). Idempotent (no-ops once
 * pr_number is set), failure-swallowing (any gh/parse error returns a reason, never
 * throws), and bounded by the caller's gh timeout. Safe to call from both the
 * session-end transition and the poller sweep.
 */
export async function discoverAndBackfillPR(
  db: Database,
  objective: Objective,
  gh: GhExec,
): Promise<DiscoverResult> {
  if (objective.pr_number != null) return { linked: false, reason: 'already-linked' }

  // obj 704718 — this only ever searches PR_LINKAGE_REPO, so it must not backfill a
  // cc-infra pr_number onto an objective that demonstrably belongs to another repo.
  // Branch names are templated (`cc/obj-<id>-<slug>`) and objectives across repos share
  // the template, so a `--head` match is not proof of ownership; combined with an
  // un-scoped `pr_number` that is how one repo's PR ends up attributed to another's
  // objective. An objective with NO resolvable repo is still allowed through — that is
  // the normal state of a fresh worker whose PR has not been recorded yet, and it is
  // precisely what this function exists to resolve.
  if (classifyObjectiveRepo(db, objective, PR_LINKAGE_REPO) === 'other') {
    return { linked: false, reason: 'other-repo' }
  }

  const branch = resolveBranchForObjective(db, objective)
  if (!branch) return { linked: false, reason: 'no-branch' }

  let raw: string
  try {
    raw = await gh([
      'pr', 'list',
      '--repo', PR_LINKAGE_REPO,
      '--head', branch,
      '--state', 'all',
      '--json', 'number,url,headRefName',
    ])
  } catch (err) {
    console.warn(`[pr-linkage] gh pr list failed for obj ${objective.id} (${branch}):`, (err as Error).message)
    return { linked: false, reason: 'gh-error', branch }
  }

  let arr: Array<{ number?: number; url?: string; headRefName?: string }>
  try {
    arr = JSON.parse(raw || '[]')
  } catch {
    return { linked: false, reason: 'parse-error', branch }
  }
  if (!Array.isArray(arr) || arr.length === 0) return { linked: false, reason: 'no-pr', branch }

  // Prefer an exact head-ref match; fall back to the first row (a `--head` query is
  // already scoped to this branch, so any returned row is for it).
  const match = arr.find(p => p.headRefName === branch) ?? arr[0]
  if (!match?.number) return { linked: false, reason: 'no-number', branch }

  const prUrl = match.url || null
  try {
    // Same "latest pointer" write the /pr-created route performs.
    db.prepare(
      "UPDATE objectives SET branch_name = ?, pr_url = ?, pr_number = ?, updated_at = datetime('now') WHERE id = ?",
    ).run(branch, prUrl, match.number, objective.id)
    // Same per-objective PR-log append the /pr-created route performs.
    upsertObjectivePR({
      objective_id: objective.id,
      pr_number: match.number,
      pr_url: prUrl,
      branch_name: branch,
      // obj 704718 — tag the log row with the repo we actually searched. Without this
      // the row's repo is only inferred from pr_url, so a PR listing that returns no
      // `url` leaves a repo-less row, and `pr_number` alone cannot disambiguate it.
      repo: PR_LINKAGE_REPO,
    })
  } catch (err) {
    console.warn(`[pr-linkage] backfill write failed for obj ${objective.id}:`, (err as Error).message)
    return { linked: false, reason: 'write-error', branch }
  }

  console.log(`[pr-linkage] backfilled PR #${match.number} for obj ${objective.id} from branch ${branch}`)
  return { linked: true, pr_number: match.number, pr_url: prUrl, branch, reason: 'linked' }
}

/**
 * True iff the objective's review outcome is a GENUINE pass — the gate that stops
 * the self-heal from ever converting a FAIL/blocked into a success. Requires the
 * objective-level `ai_review_verdict === 'pass'` AND (when a per-iteration review
 * row exists) the latest row's verdict is `pass` with no unresolved critical+fail
 * criterion. Fail-safe: an unreadable reviews table trusts the objective verdict
 * (which was already asserted `pass` above).
 */
export function latestVerdictIsPass(db: Database, objective: Objective): boolean {
  if (objective.ai_review_verdict !== 'pass') return false
  try {
    const row = db
      .prepare(
        'SELECT verdict, criteria_results FROM objective_reviews WHERE objective_id = ? ORDER BY iteration DESC LIMIT 1',
      )
      .get(objective.id) as { verdict?: string; criteria_results?: string } | undefined
    if (!row) return true // no per-iteration row, but objective verdict is pass
    if (row.verdict && row.verdict !== 'pass') return false
    try {
      const parsed = JSON.parse(row.criteria_results || '[]') as Array<{ severity?: string; status?: string }>
      if (Array.isArray(parsed) && parsed.some(c => c.severity === 'critical' && c.status === 'fail')) {
        return false
      }
    } catch {
      /* malformed criteria JSON → don't block on it; verdict already pass */
    }
    return true
  } catch {
    return true
  }
}

/**
 * Part 2 — self-healing harness status. For a `review`/`done` objective whose
 * review genuinely PASSED and that has a resolvable PR, check whether the PR head
 * SHA already carries `harness/test-agent`; if ABSENT, (re)post success via the
 * injected {@link PostHarnessSuccess}. POSTing the same context overwrites, so this
 * is safe to re-run every sweep. Never posts for a non-pass verdict (the
 * `latestVerdictIsPass` gate), so it can never flip a FAIL into success. Returns a
 * structured reason; never throws.
 */
export async function selfHealHarnessStatus(
  db: Database,
  objective: Objective,
  gh: GhExec,
  postHarnessSuccess: PostHarnessSuccess,
): Promise<SelfHealResult> {
  if (objective.status !== 'review' && objective.status !== 'done') {
    return { posted: false, reason: 'wrong-status' }
  }
  if (!latestVerdictIsPass(db, objective)) return { posted: false, reason: 'not-pass' }

  // Scope to the harness repo. This subsystem posts `harness/test-agent` ONLY on
  // PR_LINKAGE_REPO. An objective whose PR lives in a DIFFERENT repo (example / example2 /
  // example-project — they gate on their own native CI checks, never harness/test-agent)
  // must be skipped here: otherwise every sweep fires a doomed `gh api repos/<harness>/
  // pulls/<n>` against the wrong repo (404), spamming the log and burning the server's
  // GitHub API rate limit. Observed live: 57 of 88 review/done objectives were
  // cross-repo → ~57 failing calls per sweep (obj 1955 — global-HARNESS_REPO footgun).
  //
  // obj 704718 — this used to read ONLY `pr_url` and, when that was null, fall through
  // and ASSUME the harness repo. `pr_number` is not repo-scoped (three live collisions
  // with cc-infra numbers: obj 2040→example3#202, 702028→example-project#245,
  // 701986→example-project#241, all `pass`), so an objective with a null pr_url and a
  // colliding pr_number would resolve to a cc-infra PR it has nothing to do with — and
  // this function's next act is to POST a green required status onto it. Now the repo
  // must be positively established (pr_url → objective_prs.repo → project hint); an
  // unresolvable repo is `unknown-repo` and we do nothing. "Could not tell" must never
  // be spelled "mine" on the write path to a merge gate.
  const prRepo = classifyObjectiveRepo(db, objective, PR_LINKAGE_REPO)
  if (prRepo === 'other') return { posted: false, reason: 'other-repo' }
  if (prRepo === 'unknown') return { posted: false, reason: 'unknown-repo' }

  const prNumber = objective.pr_number ?? parsePrNumberFromUrl(objective.pr_url)
  if (!prNumber) return { posted: false, reason: 'no-pr' }

  let sha: string
  try {
    sha = (await gh(['api', `repos/${PR_LINKAGE_REPO}/pulls/${prNumber}`, '--jq', '.head.sha'])).trim()
  } catch (err) {
    console.warn(`[pr-linkage] self-heal head-sha read failed for PR #${prNumber} (obj ${objective.id}):`, (err as Error).message)
    return { posted: false, reason: 'gh-error-sha', pr_number: prNumber }
  }
  if (!sha) return { posted: false, reason: 'no-sha', pr_number: prNumber }

  // PRESENCE IS NOT ENOUGH — READ THE STATE.
  //
  // A review that ends 'blocked'/'fail' posts harness/test-agent=FAILURE. The original
  // check here only asked whether the context EXISTED, so once a failure was on the head
  // SHA the self-heal stood down forever ('already-present') even after the objective
  // went on to earn a genuine PASS. The PR was then permanently unmergeable and needed a
  // hand-posted success to break out — exactly what stranded PR #250 (obj 704734).
  //
  // /statuses returns newest-first, so the FIRST entry for a context is the live one;
  // later entries are superseded history and must be ignored.
  let latestState: string | null = null
  try {
    const out = await gh([
      'api', `repos/${PR_LINKAGE_REPO}/commits/${sha}/statuses`,
      '--jq', '.[] | "\\(.context)\\t\\(.state)"',
    ])
    for (const line of out.split('\n')) {
      const [context, state] = line.split('\t').map(s => (s || '').trim())
      if (context !== HARNESS_CONTEXT) continue
      latestState = (state || '').toLowerCase()
      break // newest-first: first hit for this context wins
    }
  } catch (err) {
    console.warn(`[pr-linkage] self-heal statuses read failed for PR #${prNumber} (obj ${objective.id}):`, (err as Error).message)
    return { posted: false, reason: 'gh-error-statuses', pr_number: prNumber, sha }
  }

  if (latestState !== null && latestState !== 'failure' && latestState !== 'error') {
    // success (or a pending post already in flight) — nothing to heal.
    return { posted: false, reason: 'already-present', pr_number: prNumber, sha }
  }

  if (latestState === 'failure' || latestState === 'error') {
    // Present but RED on an objective that has since earned a pass. Note this branch is
    // downstream of the latestVerdictIsPass gate above, so a non-pass verdict can never
    // reach it — the heal can only ever ratify a verdict the reviewer already gave.
    // POSTing the same context overwrites, so this converges in one sweep.
    postHarnessSuccess(objective, prNumber)
    console.log(`[pr-linkage] self-heal re-posted ${HARNESS_CONTEXT}=success over a ${latestState} for PR #${prNumber} (obj ${objective.id})`)
    return { posted: true, reason: 'healed-failure', pr_number: prNumber, sha }
  }

  // Absent on a genuinely-passed PR → (re)post the earned success. This is the
  // backstop that un-strands a PR whose single-shot post was dropped.
  postHarnessSuccess(objective, prNumber)
  console.log(`[pr-linkage] self-heal posted ${HARNESS_CONTEXT}=success for PR #${prNumber} (obj ${objective.id})`)
  return { posted: true, reason: 'posted', pr_number: prNumber, sha }
}
