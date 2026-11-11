// Resolve "which files did this objective's work actually touch?" — the input the
// per-PR UI gate keys on (obj 1453 → this module).
//
// Why this exists
// ---------------
// `rubricForChangedFiles()` / `buildVisionRubricBlock()` strip the auto-appended
// `ds-*` / `qa-*` browser criteria when a PR touches no frontend file, because those
// criteria are baked in per-PROJECT (any objective in a registered frontend repo gets
// them) and are unsatisfiable on a backend-only change — there is no screen to render.
//
// Both callers sourced the file list from `session_intel`, and `isBackendOnlyChange()`
// deliberately reads an EMPTY list as "unknown ⇒ do not strip" so a genuine UI PR can
// never dodge the gate by having no intel. Correct default, wrong single source:
// `session_intel.files_created/files_modified` is written by the ASYNCHRONOUS extraction
// pipeline after a session ends, so it is legitimately empty while a session is live,
// before extraction runs, and forever if extraction failed. Every one of those cases
// fails OPEN into "grade the browser rubric anyway", which is how pure-backend workers
// end up told to measure WCAG contrast on a Python API client and hard-fail a review on
// criteria their deliverable cannot contain.
//
// The PR diff is ground truth for the same question, is always available once a PR
// exists, and cannot be empty for a non-empty PR. So: try intel, fall back to the diff.
// The safe default is preserved — if BOTH are unavailable we still return [] and the
// full rubric still applies.
//
// Repo scoping is NOT optional here
// ---------------------------------
// `objectives.pr_number` is not repo-scoped (obj 704718: three live cross-repo
// collisions), and assuming `HARNESS_REPO` for every objective is a known footgun
// (obj 1955: ~57 doomed `gh` calls per sweep). We therefore resolve the repo through
// {@link repoForObjective}, which derives it from `pr_url` / the `objective_prs` log,
// and do nothing at all when the repo cannot be positively established.

import { execFile } from 'node:child_process'
import type { Database } from 'better-sqlite3'
import { repoForObjective } from './objective-prs.js'
import { parsePrNumberFromUrl } from './pr-url.js'

/** Injectable `gh` runner, so the resolver unit-tests without shelling out.
 *  Structurally identical to `pr-linkage.GhExec` and interchangeable with it. */
export type GhExec = (args: string[]) => Promise<string>

/**
 * Production `gh` runner. The server runs as root with no auth in gh's default config
 * dir, so every server-side `gh` call must set `GH_CONFIG_DIR=/etc/gh` where the host's
 * `hosts.yml` is mounted — otherwise this fails with "not logged into any GitHub hosts"
 * and the fallback silently never works.
 *
 * `ghExecEnv` is imported DYNAMICALLY, matching `pr-health-watchdog.ts`'s precedent: it
 * lets a route reach the one canonical implementation without importing the poller at
 * module-load time (a route → state-poller static edge would pull the whole polling
 * module into request-path load order).
 */
export const realGhExec: GhExec = async (args: string[]): Promise<string> => {
  const { ghExecEnv } = await import('./state-poller.js')
  return new Promise<string>((resolve, reject) => {
    execFile(
      'gh',
      args,
      { timeout: 15000, maxBuffer: 8 * 1024 * 1024, env: ghExecEnv() },
      (err, stdout) => {
        if (err) reject(err)
        else resolve(stdout.trim())
      },
    )
  })
}

/** Where a resolved file list came from. `none` ⇒ caller keeps the safe default. */
export type FilesTouchedSource = 'session_intel' | 'pr_diff' | 'none'

export interface FilesTouchedResult {
  files: string[]
  source: FilesTouchedSource
}

/** The objective fields this module reads. Structural so tests can pass literals. */
export interface FilesTouchedObjective {
  id?: number | null
  session_id?: string | null
  pr_url?: string | null
  pr_number?: number | null
  project?: string | null
}

/**
 * Union of `files_created` and `files_modified` for a session, or [] if the row is
 * missing / unparseable. Exported for unit testing.
 */
export function filesFromSessionIntel(
  db: Database | null,
  sessionId: string | null | undefined,
): string[] {
  if (!db || !sessionId) return []
  try {
    const intel = db
      .prepare('SELECT files_created, files_modified FROM session_intel WHERE session_id = ?')
      .get(sessionId) as { files_created: string; files_modified: string } | undefined
    if (!intel) return []
    const created = JSON.parse(intel.files_created || '[]') as string[]
    const modified = JSON.parse(intel.files_modified || '[]') as string[]
    return [...new Set([...created, ...modified])]
  } catch {
    // Missing table / bad JSON ⇒ no evidence, same as no row.
    return []
  }
}

/**
 * Filenames in a PR's diff via `gh api .../pulls/<n>/files`.
 *
 * `--paginate` matters: the endpoint pages at 30 and caps at 300 files, and a truncated
 * list is worse than no list — dropping the one `.tsx` file out of 300 would flip a UI
 * PR to "backend-only" and silently strip the gate it was supposed to face.
 *
 * Rejects are the caller's cue to fall back to the safe default, not to guess.
 * Exported for unit testing.
 */
export async function filesFromPrDiff(
  ghExec: GhExec,
  repo: string,
  prNumber: number,
): Promise<string[]> {
  const out = await ghExec([
    'api',
    `repos/${repo}/pulls/${prNumber}/files`,
    '--paginate',
    '--jq',
    '.[].filename',
  ])
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
}

/**
 * The files this objective touched, preferring `session_intel` and falling back to the
 * PR diff. Never throws: any failure degrades to `{files: [], source: 'none'}`, which
 * callers treat as "unknown ⇒ apply the full rubric".
 *
 * Deliberately NOT cached. The only caller-visible cost is one bounded `gh` call on the
 * relatively rare path where intel is empty, and a cache would go stale in the dangerous
 * direction: a worker that pushes a late frontend commit would keep being graded against
 * a cached backend-only file list, i.e. the gate it should now face gets skipped.
 */
export async function resolveFilesTouched(
  db: Database | null,
  objective: FilesTouchedObjective,
  deps: { ghExec?: GhExec } = {},
): Promise<FilesTouchedResult> {
  const fromIntel = filesFromSessionIntel(db, objective.session_id)
  if (fromIntel.length > 0) return { files: fromIntel, source: 'session_intel' }

  const ghExec = deps.ghExec
  if (!ghExec) return { files: [], source: 'none' }

  // Repo must be positively established — never assume the harness repo (obj 1955).
  const repo = repoForObjective(db, objective)
  const prNumber = objective.pr_number ?? parsePrNumberFromUrl(objective.pr_url)
  if (!repo || !prNumber) return { files: [], source: 'none' }

  try {
    const files = await filesFromPrDiff(ghExec, repo, prNumber)
    if (files.length === 0) return { files: [], source: 'none' }
    return { files, source: 'pr_diff' }
  } catch (err) {
    console.warn(
      `[files-touched] obj ${objective.id ?? '?'}: PR-diff fallback failed for ` +
        `${repo}#${prNumber} (${(err as Error).message}); keeping the full rubric`,
    )
    return { files: [], source: 'none' }
  }
}
