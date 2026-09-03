// Per-objective PR log (obj 2300).
//
// Mike's ask: "Within each objective, I want to be able to see each PR that was
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
 * collisions with `your-org/command-center-infra` PR numbers, all with a `pass`
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
  return db
    .prepare('SELECT * FROM objective_prs WHERE objective_id = ? AND pr_number = ?')
    .get(input.objective_id, prNumber) as ObjectivePR
}

/** Full PR log for an objective, newest-first. */
export function listObjectivePRs(objectiveId: number): ObjectivePR[] {
  return getDb()
    .prepare('SELECT * FROM objective_prs WHERE objective_id = ? ORDER BY created_at DESC, id DESC')
    .all(objectiveId) as ObjectivePR[]
}

/** Freshen PR state when GitHub reports a merge/close. Matches by (repo, pr_number)
 *  — the same pair used by external-remediation — and updates every matching row
 *  (the same PR could, in theory, be linked from more than one objective). Returns
 *  the number of rows touched. */
export function markPRStateByRepoAndNumber(
  repo: string,
  prNumber: number,
  state: ObjectivePRState,
): number {
  if (!repo || !prNumber) return 0
  const res = getDb()
    .prepare(
      `UPDATE objective_prs SET state = ?, updated_at = datetime('now')
       WHERE repo = ? AND pr_number = ?`
    )
    .run(state, repo, prNumber)
  return res.changes
}
