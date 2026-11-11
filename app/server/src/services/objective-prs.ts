// Per-objective PR log (obj 2300).
//
// Operator's ask: "Within each objective, I want to be able to see each PR that was
// pushed from that objective and click links from it, instead of it just being
// in chat. There can be multiple — I want a log of this."
//
// The `objective_prs` table (db/index.ts) is the full history. This module is the
// single read/write surface over it:
//   - upsertObjectivePR  — append/update a row on /api/internal/pr-created
//   - listObjectivePRs   — newest-first list for the detail drawer + API
//   - markPRStateByRepoAndNumber — freshen state from the GitHub webhook
//
// objectives.pr_url/pr_number/branch_name remain the "latest pointer" the
// remediation resolver / preview-deploy / review-spawn depend on — this module
// does NOT touch them; the caller keeps updating them as before.

import type { Database } from 'better-sqlite3'
import { getDb } from '../db/index.js'
import type { ObjectivePR, ObjectivePRState } from '@operationkit/shared'
import { parsePrNumberFromUrl } from './pr-url.js'

/** Parse `owner/name` out of a canonical GitHub PR URL, else null. Mirrors the
 *  SQL backfill so a runtime-inserted row and a backfilled row agree. */
export function parseRepoFromPrUrl(prUrl: string | null | undefined): string | null {
  if (!prUrl) return null
  const m = prUrl.match(/github\.com\/([^/]+\/[^/]+)\/pull\/\d+/)
  return m ? m[1] : null
}

/**
 * `objectives.pr_number` IS NOT REPO-SCOPED (obj 704718).
 *
 * The objectives table has no `repo` column, so a bare `WHERE pr_number = ?` matches
 * across every repo the Command Center drives. This is not hypothetical — three live
 * collisions with `your-org/operationkit` PR numbers, all with a `pass`
 * verdict, which is exactly the state that makes a reader act:
 *
 *   obj 2040    pr_number=202  →  EXAMPLE2/example3-platform#202
 *   obj 702028  pr_number=245  →  Example-Project/example-project-platform#245
 *   obj 701986  pr_number=241  →  Example-Project/example-project-platform#241
 *
 * Any reader keying on `pr_number` alone can therefore attribute one repo's PR to
 * another repo's objective — and in the harness-status path that means POSTing a
 * commit status onto a PR in a repo the objective has nothing to do with.
 *
 * {@link repoForObjective} is the single place that answers "which repo is this
 * objective's PR in?", in descending order of trustworthiness:
 *   1. `objectives.pr_url` — canonical and self-describing.
 *   2. the `objective_prs` log row for this objective — written by the same code path
 *      and carrying an explicit `repo` (preferring the row for this `pr_number`).
 * A null `db` means "no database available" (e.g. the pure prompt builder, which runs in
 * tests with no initialised DB); the log lookup is then skipped and only `pr_url` is used.
 * It returns null when neither is available. `objectives.project` is deliberately NOT
 * consulted here: it is a bare repo NAME with no owner, so it can corroborate a guess
 * but cannot name a repo. That weaker signal is used by {@link classifyObjectiveRepo}.
 */
export function repoForObjective(db: Database | null, objective: ObjectiveRepoFields): string | null {
  const fromUrl = parseRepoFromPrUrl(objective.pr_url)
  if (fromUrl) return fromUrl

  if (db && objective.id != null) {
    try {
      const row = db
        .prepare(
          `SELECT repo FROM objective_prs
            WHERE objective_id = ? AND repo IS NOT NULL
            ORDER BY (pr_number IS NOT NULL AND pr_number = ?) DESC, id DESC
            LIMIT 1`,
        )
        .get(objective.id, objective.pr_number ?? null) as { repo?: string } | undefined
      if (row?.repo) return row.repo
    } catch {
      /* table may not exist in a partial env — treat as no evidence */
    }
  }

  return null
}

interface ObjectiveRepoFields {
  id?: number | null
  pr_url?: string | null
  pr_number?: number | null
  project?: string | null
}

/**
 * Three-valued because "I could not tell" is a genuinely different answer from "no",
 * and the two callers want opposite defaults:
 *   - a WRITE to GitHub (posting the required status, building a preview URL) must
 *     only fire on `same` — an unknown repo must never be spelled "mine";
 *   - a DISCOVERY step (backfilling a PR number) must only refuse on `other` — a fresh
 *     worker legitimately has no repo evidence yet, and resolving that is its job.
 * Collapsing this into a boolean forces one of those two to be wrong.
 *
 * `project` is a bare repo name (no owner), so it participates only when there is no
 * stronger evidence: it can confirm `same` or reveal `other`, never override a pr_url.
 */
export type ObjectiveRepoVerdict = 'same' | 'other' | 'unknown'

export function classifyObjectiveRepo(
  db: Database | null,
  objective: ObjectiveRepoFields,
  repo: string,
): ObjectiveRepoVerdict {
  const resolved = repoForObjective(db, objective)
  if (resolved) return resolved === repo ? 'same' : 'other'

  const project = (objective.project || '').trim()
  if (project) return project === repo.split('/').pop() ? 'same' : 'other'

  return 'unknown'
}

/**
 * True only when the objective's PR is DEMONSTRABLY in `repo`. An unresolvable repo
 * returns false: with three live cross-repo `pr_number` collisions on record, "I could
 * not tell" must not be spelled "yes" by any caller that then writes to GitHub.
 */
export function objectiveIsForRepo(db: Database | null, objective: ObjectiveRepoFields, repo: string): boolean {
  return classifyObjectiveRepo(db, objective, repo) === 'same'
}

/**
 * A SQL fragment that keeps a repo-scoped candidate query cheap: matches objectives
 * whose `pr_url` names `repo`, whose `objective_prs` log row names `repo`, or whose
 * `project` is that repo's name segment. Parameters, in order: repo-url-LIKE, repo,
 * project-name. Use with {@link repoScopeParams}.
 */
export const REPO_SCOPE_SQL = `(
     o.pr_url LIKE ?
  OR EXISTS (SELECT 1 FROM objective_prs op
              WHERE op.objective_id = o.id AND op.pr_number = o.pr_number AND op.repo = ?)
  OR (o.pr_url IS NULL AND o.project = ?)
)`

/** Parameter tuple for {@link REPO_SCOPE_SQL}. */
export function repoScopeParams(repo: string): [string, string, string] {
  return [`%github.com/${repo}/pull/%`, repo, repo.split('/').pop() as string]
}

/** Upsert one PR into the per-objective log. No-op (returns null) when there is no
 *  resolvable PR number — a branch-only report carries no PR row. On conflict
 *  (same objective + pr_number) the existing row is updated in place, so a
 *  re-report never duplicates. `state` is preserved on update (the webhook owns
 *  state transitions); only metadata is refreshed. */
export function upsertObjectivePR(input: {
  objective_id: number
  pr_number?: number | null
  pr_url?: string | null
  branch_name?: string | null
  title?: string | null
  repo?: string | null
}): ObjectivePR | null {
  const prNumber = input.pr_number ?? parsePrNumberFromUrl(input.pr_url)
  if (!input.objective_id || !prNumber) return null
  const repo = input.repo ?? parseRepoFromPrUrl(input.pr_url)
  const db = getDb()
  db.prepare(
    `INSERT INTO objective_prs (objective_id, repo, pr_number, pr_url, branch_name, title)
     VALUES (@objective_id, @repo, @pr_number, @pr_url, @branch_name, @title)
     ON CONFLICT(objective_id, pr_number) DO UPDATE SET
       repo        = COALESCE(excluded.repo, objective_prs.repo),
       pr_url      = COALESCE(excluded.pr_url, objective_prs.pr_url),
       branch_name = COALESCE(excluded.branch_name, objective_prs.branch_name),
       title       = COALESCE(excluded.title, objective_prs.title),
       updated_at  = datetime('now')`
  ).run({
    objective_id: input.objective_id,
    repo,
    pr_number: prNumber,
    pr_url: input.pr_url || null,
    branch_name: input.branch_name || null,
    title: input.title || null,
  })
  // obj 900309 — out-of-order safety. GitHub delivers pull_request closed+merged
  // exactly once and never redelivers it, so a merge observed BEFORE this row existed
  // used to be lost permanently (the UPDATE matched nothing and the row was then born
  // "open" forever). The durable pr_terminal_states record is replayed onto the row the
  // moment it appears, which makes "row first, then merge" and "merge first, then row"
  // converge on the same final state.
  if (repo) applyTerminalStateToRow(db, repo, prNumber)
  return db
    .prepare('SELECT * FROM objective_prs WHERE objective_id = ? AND pr_number = ?')
    .get(input.objective_id, prNumber) as ObjectivePR
}

/** Replay the recorded terminal state (if any) onto this repo+number"s log rows.
 *  No-op when nothing was recorded or the row is already in that state. */
function applyTerminalStateToRow(db: Database, repo: string, prNumber: number): void {
  try {
    const known = db
      .prepare('SELECT state FROM pr_terminal_states WHERE repo = ? AND pr_number = ?')
      .get(repo, prNumber) as { state?: ObjectivePRState } | undefined
    if (!known?.state) return
    db.prepare(
      `UPDATE objective_prs SET state = ?, updated_at = datetime('now')
        WHERE repo = ? AND pr_number = ? AND state != ? AND state != 'merged'`,
    ).run(known.state, repo, prNumber, known.state)
  } catch {
    /* the table may not exist in a partial env — never fail a PR link over it */
  }
}

/** Full PR log for an objective, newest-first. */
export function listObjectivePRs(objectiveId: number): ObjectivePR[] {
  return getDb()
    .prepare('SELECT * FROM objective_prs WHERE objective_id = ? ORDER BY created_at DESC, id DESC')
    .all(objectiveId) as ObjectivePR[]
}

/**
 * The outcome of recording a PR's terminal state (obj 900309). Returned — and
 * logged — so "the webhook was accepted" and "the merge was recorded" stop being
 * the same claim. The previous code returned a bare row count that every caller
 * discarded, which is why a run of PRs (#643, #649, #651 …) could sit at `open`
 * for days after a 200-OK merged delivery with nothing anywhere saying so.
 */
export interface PRStateRecord {
  /** The state now in force for this PR (may be the pre-existing one on a replay). */
  state: ObjectivePRState
  /** objective_prs rows actually moved by this call. 0 is NORMAL when the PR has no
   *  card yet (recorded for replay) or when the state was already applied. */
  rowsUpdated: number
  /** objective_prs rows that exist for this (repo, pr_number) at all. */
  rowsMatched: number
  /** True when this call changed nothing because the PR was already in a terminal
   *  state — a redelivered or out-of-order webhook. */
  replay: boolean
  /** True when a `closed` was refused because the PR is already `merged`. */
  downgradeRefused: boolean
}

/**
 * Record what GitHub said about a PR, durably and idempotently (obj 900309).
 *
 * Three invariants, each one of which the old `UPDATE objective_prs` did not hold:
 *
 *  1. **Durable.** The verdict is written to `pr_terminal_states` keyed by
 *     (repo, pr_number) BEFORE any card row is touched, so it survives the PR
 *     having no `objective_prs` row yet. `upsertObjectivePR` replays it when the row
 *     is finally created. GitHub does not redeliver a `closed` event on its own, so a
 *     verdict that is only applied to rows-that-exist-right-now is a verdict lost.
 *  2. **Idempotent.** Re-running with the same input is a no-op that reports
 *     `replay: true`. Deliveries genuinely do repeat (GitHub's manual redelivery, the
 *     retry-storm guard's cache expiring, an operator replaying a backlog).
 *  3. **Monotonic.** `merged` is terminal. A later `closed` NEVER overwrites it —
 *     neither in the durable record nor on the rows. A merged PR that is later
 *     reported closed is a replay of an older event, not new information.
 *
 * Matching is widened to repair rows the old code could not see: a log row whose
 * `repo` is NULL (written before repo tagging, or from a PR report with no URL) but
 * whose `pr_url` names this repo is matched AND backfilled, so it participates in
 * every future (repo, pr_number) query instead of staying invisible.
 *
 * Never throws: a recording failure must not fail the webhook. It is logged at
 * `console.error` — a swallowed, unlogged failure is what made the live defect
 * undiagnosable.
 */
export function recordPRTerminalState(input: {
  repo: string
  prNumber: number
  state: ObjectivePRState
  mergedAt?: string | null
  deliveryId?: string | null
}): PRStateRecord | null {
  const { repo, prNumber, state } = input
  if (!repo || !prNumber || (state !== 'merged' && state !== 'closed')) return null
  const db = getDb()
  try {
    return db.transaction((): PRStateRecord => {
      const prior = db
        .prepare('SELECT state FROM pr_terminal_states WHERE repo = ? AND pr_number = ?')
        .get(repo, prNumber) as { state?: ObjectivePRState } | undefined

      const downgradeRefused = prior?.state === 'merged' && state === 'closed'
      const effective: ObjectivePRState = downgradeRefused ? 'merged' : state
      const replay = prior?.state === effective

      if (!replay) {
        db.prepare(
          `INSERT INTO pr_terminal_states (repo, pr_number, state, merged_at, delivery_id)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(repo, pr_number) DO UPDATE SET
             state       = excluded.state,
             merged_at   = COALESCE(excluded.merged_at, pr_terminal_states.merged_at),
             delivery_id = COALESCE(excluded.delivery_id, pr_terminal_states.delivery_id),
             observed_at = datetime('now')`,
        ).run(repo, prNumber, effective, input.mergedAt ?? null, input.deliveryId ?? null)
      }

      // Backfill a NULL repo on rows this PR's URL identifies, so they stop being
      // invisible to every repo-scoped query (including this one, next time).
      db.prepare(
        `UPDATE objective_prs SET repo = ?, updated_at = datetime('now')
          WHERE repo IS NULL AND pr_number = ? AND pr_url LIKE ?`,
      ).run(repo, prNumber, `%github.com/${repo}/pull/%`)

      const rowsMatched = (
        db
          .prepare('SELECT COUNT(*) AS n FROM objective_prs WHERE repo = ? AND pr_number = ?')
          .get(repo, prNumber) as { n: number }
      ).n

      // `state != 'merged'` is the monotonic guard at the row level too: a row already
      // merged is never moved back to closed by a replayed close.
      const rowsUpdated = db
        .prepare(
          `UPDATE objective_prs SET state = ?, updated_at = datetime('now')
            WHERE repo = ? AND pr_number = ? AND state != ? AND state != 'merged'`,
        )
        .run(effective, repo, prNumber, effective).changes

      return { state: effective, rowsUpdated, rowsMatched, replay, downgradeRefused }
    })()
  } catch (e) {
    console.error(
      `[objective-prs] FAILED to record ${state} for ${repo}#${prNumber}:`,
      (e as Error).message,
    )
    return null
  }
}

/**
 * Back-compat shim for callers that only want the row count. Prefer
 * {@link recordPRTerminalState}, which is durable, idempotent and reports WHY a
 * count was zero.
 */
export function markPRStateByRepoAndNumber(
  repo: string,
  prNumber: number,
  state: ObjectivePRState,
): number {
  return recordPRTerminalState({ repo, prNumber, state })?.rowsUpdated ?? 0
}
