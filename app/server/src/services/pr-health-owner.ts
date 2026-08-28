/**
 * PR-health owner resolution and event-path engagement — extracted from
 * pr-health-watchdog.ts (behavior frozen).
 */
import type { Database } from 'better-sqlite3'
import type { OwnerState } from './pr-health-decisions.js'

/** SQLite `datetime('now')` writes `YYYY-MM-DD HH:MM:SS` with no zone. It is UTC — say
 *  so explicitly, or Date.parse reads it as local time and every age is off by the
 *  host's offset. */
function sqliteToIso(ts: string | null | undefined): string | null {
  if (!ts) return null
  return /[TZ+]/.test(ts) ? ts : ts.replace(' ', 'T') + 'Z'
}

export function minutesSince(iso: string | null, now: Date): number | null {
  if (!iso) return null
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return null
  return Math.floor((now.getTime() - t) / 60000)
}

// ── Ownership resolution (read-only against objectives) ─────────────────────────

/** How long an objective may sit untouched before it stops counting as an active owner.
 *  One constant so resolveOwner and eventPathEngagement cannot drift apart. */
export const OWNER_STALE_MINUTES = 120

interface ObjectiveRow {
  id: number
  status: string
  pr_url: string | null
  pr_number: number | null
  branch_name: string | null
  updated_at: string | null
  terminal_by_human: number | null
}

/**
 * Find the objective that owns (repo, prNumber, branch), if any.
 *
 * Matching is pr_url-first ON PURPOSE: pr_number alone collides across repos
 * (example3 #239 and example #239 are different PRs), and this service is the first thing
 * in the codebase to sweep several repos at once, so a pr_number-only match would
 * cheerfully attribute one repo's PR to another repo's objective. branch_name is the
 * fallback for objectives whose pr_url was never backfilled.
 *
 * Deliberately NOT importing resolveObjective from external-remediation.ts: that
 * function is keyed on a webhook ClassifiedCheck and is under concurrent edit by
 * another worker. A 20-line local query is the smaller coupling.
 */
/**
 * Recover the objective id that a Command Center branch name carries.
 *
 * WHY THIS EXISTS (obj 704787). `objectives` has ONE `pr_url` and ONE `branch_name`
 * column, so an objective can only ever point at a SINGLE PR. Every second PR from the
 * same objective is therefore structurally unownable, even though its owner obviously
 * exists. That is not hypothetical — live on 2026-08-06, example3#563 resolved to
 * obj 703394 while its sibling example3#564 (branch `cc/obj-703394-w2-confirm-popup`)
 * resolved to "no objective references this PR". Same objective, two branches, one
 * column. Cross-repo fan-outs (example#239 + example-project#180, both `sec/phase1-hygiene`)
 * and main+redesign port pairs (example#480/#481) fail the same way.
 *
 * The branch name already carries the answer, so read it. Recognised shapes, all live:
 *   cc/obj-703394-…  cc/obj704093-…  fix/704650-…  cto/704656-…  feature/701061-…
 * A 6-digit run of digits is required: shorter numbers collide with version bumps in
 * dependabot branches (`…/next-16.2.10`), which must stay unowned — no objective ever
 * opened them.
 */
export function objectiveIdFromBranch(branch: string): number | null {
  if (!branch || /^dependabot\//i.test(branch)) return null
  const m = /(?:^|[/_-])obj-?(\d{6,})(?:$|[/_-])/i.exec(branch) || /(?:^|[/_-])(\d{6,})(?:$|[/_-])/.exec(branch)
  if (!m) return null
  const id = parseInt(m[1], 10)
  return Number.isInteger(id) && id > 0 ? id : null
}

export function resolveOwner(
  db: Database,
  repo: string,
  prNumber: number,
  branch: string,
  now: Date,
  staleMinutes = OWNER_STALE_MINUTES,
): { objectiveId: number | null; status: string | null; owner: OwnerState; reason: string } {
  let row: ObjectiveRow | undefined
  let viaBranchId = false
  try {
    row = db
      .prepare(
        `SELECT id, status, pr_url, pr_number, branch_name, updated_at, terminal_by_human
           FROM objectives
          WHERE deleted_at IS NULL AND pr_url LIKE ?
          ORDER BY id DESC LIMIT 1`,
      )
      .get(`%/${repo}/pull/${prNumber}`) as ObjectiveRow | undefined

    if (!row && branch) {
      row = db
        .prepare(
          `SELECT id, status, pr_url, pr_number, branch_name, updated_at, terminal_by_human
             FROM objectives
            WHERE deleted_at IS NULL AND branch_name = ?
            ORDER BY id DESC LIMIT 1`,
        )
        .get(branch) as ObjectiveRow | undefined
    }

    // Last resort: the branch names its own objective. See objectiveIdFromBranch — this
    // is what rescues sibling PRs that lost the race for the single `pr_url` column.
    const branchObjId = row ? null : objectiveIdFromBranch(branch)
    if (branchObjId !== null) {
      row = db
        .prepare(
          `SELECT id, status, pr_url, pr_number, branch_name, updated_at, terminal_by_human
             FROM objectives
            WHERE deleted_at IS NULL AND id = ?`,
        )
        .get(branchObjId) as ObjectiveRow | undefined
      viaBranchId = !!row
    }
  } catch {
    return { objectiveId: null, status: null, owner: 'unowned', reason: 'objective lookup failed' }
  }

  if (!row) return { objectiveId: null, status: null, owner: 'unowned', reason: 'no objective references this PR' }

  // Surface the weaker provenance: this owner was inferred from the branch name, not
  // from an objective that actually records this PR. Mike should still see the link,
  // but should know nothing wrote it down.
  const via = viaBranchId ? ' [linked via branch name, not pr_url]' : ''

  // A human who explicitly ended the objective outranks any automation. Treat it as
  // actively owned so the watchdog leaves it alone entirely.
  if (row.terminal_by_human) {
    return { objectiveId: row.id, status: row.status, owner: 'owned-active', reason: `ended by a human — hands off${via}` }
  }

  const idleMin = minutesSince(sqliteToIso(row.updated_at), now)
  const live = isLiveObjectiveStatus(row.status)
  const fresh = idleMin !== null && idleMin < staleMinutes
  if (live && fresh) {
    return { objectiveId: row.id, status: row.status, owner: 'owned-active', reason: `objective is ${row.status}, active ${idleMin}m ago${via}` }
  }
  return {
    objectiveId: row.id,
    status: row.status,
    owner: 'owned-stale',
    reason: (live ? `objective is ${row.status} but idle ${idleMin}m` : `objective is ${row.status}`) + via,
  }
}

/** Rows already spent on this PR by EITHER loop. This is the shared attempt budget. */
export function attemptsSpent(db: Database, repo: string, prNumber: number): number {
  try {
    const r = db
      .prepare(
        'SELECT COUNT(*) AS n FROM external_check_remediations WHERE repo = ? AND pr_number = ?',
      )
      .get(repo, prNumber) as { n: number } | undefined
    return r?.n || 0
  } catch {
    return 0
  }
}

/**
 * How long a single event-path remediation row keeps implying "a worker is on it".
 *
 * A remediation row is a record that the event path ACTED, not that anyone is STILL
 * acting, and nothing ever deletes one. Without a ceiling the row is an immortal
 * do-not-disturb sign. The window is the plausible upper bound on one remediation
 * round-trip (nudge → worker wakes → pushes → checks re-run); past it, either the
 * worker converged (and the PR is green, so we never get here) or it did not.
 */
export function engagedFreshnessMinutes(env: NodeJS.ProcessEnv = process.env): number {
  const n = parseInt(env.PR_HEALTH_WATCHDOG_ENGAGED_MINUTES || '', 10)
  return Number.isInteger(n) && n > 0 ? n : 60
}

/** The one definition of "an objective is still plausibly working". Shared by
 *  resolveOwner and the engagement cross-check so the two can never disagree about
 *  which statuses count as live. */
export function isLiveObjectiveStatus(status: string | null | undefined): boolean {
  return status === 'working' || status === 'review'
}

/** Why we did (or did not) treat the event path as engaged. Reported verbatim on the
 *  Mike-facing surface as `ownerReason`, so a skip is always self-explaining. */
export interface Engagement {
  engaged: boolean
  reason: string
  /** Age of the newest non-watchdog remediation row on this commit, in minutes. */
  rowAgeMinutes: number | null
  /** The objective that wrote that row (may differ from the PR's own objective). */
  rowObjectiveId: number | null
  rowObjectiveStatus: string | null
}

export const NOT_ENGAGED_NO_ROW: Engagement = {
  engaged: false,
  reason: 'no event-path remediation on this commit',
  rowAgeMinutes: null,
  rowObjectiveId: null,
  rowObjectiveStatus: null,
}

/**
 * Does the EVENT path still have a LIVE owner on this exact commit?
 *
 * The anti-double-drive interlock: external-remediation.ts writes a row keyed on the
 * real check name for every failure it remediates, so a non-`watchdog:` row on this
 * head_sha is evidence a worker was nudged about this code. We stand down for that
 * worker — but only while it is plausibly still working.
 *
 * THE BUG THIS FIXES (obj 704784). The original test was "does any such row exist",
 * and nothing ever clears or expires a row. So the first time the event path touched a
 * PR, the watchdog deferred to that owner FOREVER — including long after the owning
 * objective went `done`. Measured on the live board 2026-08-06: seven red PRs
 * (example3 #678/#677/#676/#675/#674/#668, example #475) all reported
 * `owner: owned-active, action: skip-owner-engaged` off rows 99–402 minutes old whose
 * objectives were `done` (704687, 704694, 704693, 704677) or idle 142–304m in `review`.
 * resolveOwner() had correctly called every one of them `owned-stale`; the engagement
 * override overwrote that verdict. The reconciler whose entire purpose is to catch
 * "the owning objective finished and nobody is watching" was defeated by exactly that
 * case.
 *
 * So engagement now has to survive THREE tests, any one of which can expire it:
 *   1. a non-watchdog row exists on this commit  (unchanged — the original test)
 *   2. the objective that wrote it is still live (not done/cancelled, not idle past
 *      `staleMinutes`) — a finished owner is not an owner
 *   3. the row itself is newer than `engagedFreshnessMinutes` — a live-but-silent
 *      owner still eventually releases the PR
 *
 * `terminal_by_human` remains an absolute override in the other direction: a human who
 * explicitly ended the objective outranks all of this and the watchdog keeps its hands
 * off regardless of age.
 */
export function eventPathEngagement(
  db: Database,
  repo: string,
  prNumber: number,
  headSha: string,
  now: Date,
  staleMinutes = OWNER_STALE_MINUTES,
  env: NodeJS.ProcessEnv = process.env,
): Engagement {
  let row:
    | { created_at: string; objective_id: number; status: string | null; updated_at: string | null; terminal_by_human: number | null }
    | undefined
  try {
    // Newest row wins: a worker that acted twice on this commit is as live as its most
    // recent action, and an old row must not drag a fresh one back into expiry.
    row = db
      .prepare(
        `SELECT r.created_at        AS created_at,
                r.objective_id      AS objective_id,
                o.status            AS status,
                o.updated_at        AS updated_at,
                o.terminal_by_human AS terminal_by_human
           FROM external_check_remediations r
           LEFT JOIN objectives o ON o.id = r.objective_id AND o.deleted_at IS NULL
          WHERE r.repo = ? AND r.pr_number = ? AND r.head_sha = ?
            AND r.check_name NOT LIKE 'watchdog:%'
          ORDER BY r.created_at DESC, r.id DESC
          LIMIT 1`,
      )
      .get(repo, prNumber, headSha) as typeof row
  } catch {
    // A query failure must not manufacture an owner out of nothing — fail toward the
    // reconciler doing its job, since every downstream action is itself capped.
    return { ...NOT_ENGAGED_NO_ROW, reason: 'engagement lookup failed' }
  }

  if (!row) return NOT_ENGAGED_NO_ROW

  const rowAge = minutesSince(sqliteToIso(row.created_at), now)
  const base = {
    rowAgeMinutes: rowAge,
    rowObjectiveId: row.objective_id ?? null,
    rowObjectiveStatus: row.status ?? null,
  }
  const ageText = rowAge === null ? 'unknown age' : `${rowAge}m ago`

  if (row.terminal_by_human) {
    return { ...base, engaged: true, reason: `objective ${row.objective_id} was ended by a human — hands off` }
  }

  if (!row.status) {
    return { ...base, engaged: false, reason: `remediation row (${ageText}) has no live objective row` }
  }

  if (!isLiveObjectiveStatus(row.status)) {
    return {
      ...base,
      engaged: false,
      reason: `external-remediation acted ${ageText} but objective ${row.objective_id} is ${row.status} — owner finished`,
    }
  }

  const idle = minutesSince(sqliteToIso(row.updated_at), now)
  if (idle !== null && idle >= staleMinutes) {
    return {
      ...base,
      engaged: false,
      reason: `objective ${row.objective_id} is ${row.status} but idle ${idle}m — owner went quiet`,
    }
  }

  const freshness = engagedFreshnessMinutes(env)
  if (rowAge !== null && rowAge >= freshness) {
    return {
      ...base,
      engaged: false,
      reason: `last external-remediation was ${ageText} > freshness ${freshness}m — engagement expired`,
    }
  }

  return {
    ...base,
    engaged: true,
    reason: `external-remediation acted ${ageText}; objective ${row.objective_id} is ${row.status}`,
  }
}

/** Back-compatible boolean form of {@link eventPathEngagement}. */
export function eventPathEngaged(
  db: Database,
  repo: string,
  prNumber: number,
  headSha: string,
  now: Date = new Date(),
  staleMinutes = OWNER_STALE_MINUTES,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return eventPathEngagement(db, repo, prNumber, headSha, now, staleMinutes, env).engaged
}

