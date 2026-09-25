/**
 * PostHog Self-Driving PR discovery (W2 / obj 712024).
 *
 * Discovers OPEN pull requests authored by `posthog[bot]` across every repo
 * in CC's workspace_repos registry (rows with a non-null `github` field) and
 * persists them idempotently as dev_items with source_system='posthog-bot'.
 *
 * Idempotency: the existing partial unique index uq_dev_items_source on
 * dev_items(source_system, source_id) WHERE source_id IS NOT NULL means
 * INSERT OR IGNORE is a clean no-op on a re-run.
 *
 * The `gh` runner is injected so the pure discovery logic is fully unit-testable
 * without shelling out — same pattern as pr-linkage.ts.
 */
import type { Database } from 'better-sqlite3'

export const POSTHOG_BOT_LOGIN = 'posthog[bot]'

/** Same injected gh runner type used by pr-linkage.ts. */
export type GhExec = (args: string[]) => Promise<string>

export interface PosthogBotPr {
  repo: string
  workspace: string
  number: number
  title: string
  url: string
  headRef: string
  createdAt: string
}

export interface PosthogBotDiscoverResult {
  repos_scanned: string[]
  prs_found: number
  prs_persisted: number
  errors: Array<{ repo: string; message: string }>
}

interface RepoRow {
  workspace: string
  github: string
}

/** Read all workspace_repos rows that have a non-null `github` column. */
export function reposForDiscovery(db: Database): RepoRow[] {
  try {
    return db
      .prepare("SELECT workspace, github FROM workspace_repos WHERE github IS NOT NULL AND github != ''")
      .all() as RepoRow[]
  } catch {
    return []
  }
}

/** Call `gh pr list` for one repo and return open PRs authored by posthog[bot]. */
export async function fetchPosthogBotPrs(
  gh: GhExec,
  repo: string,
  workspace: string,
): Promise<PosthogBotPr[]> {
  const raw = await gh([
    'pr', 'list',
    '--repo', repo,
    '--author', POSTHOG_BOT_LOGIN,
    '--state', 'open',
    '--json', 'number,title,url,headRefName,createdAt',
  ])
  let parsed: Array<{
    number?: number
    title?: string
    url?: string
    headRefName?: string
    createdAt?: string
  }>
  try {
    parsed = JSON.parse(raw || '[]')
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  return parsed
    .filter(p => typeof p.number === 'number' && typeof p.url === 'string')
    .map(p => ({
      repo,
      workspace,
      number: p.number as number,
      title: typeof p.title === 'string' ? p.title : `PostHog Self-Driving PR #${p.number}`,
      url: p.url as string,
      headRef: typeof p.headRefName === 'string' ? p.headRefName : '',
      createdAt: typeof p.createdAt === 'string' ? p.createdAt : new Date().toISOString(),
    }))
}

/**
 * Persist one PR as a dev_item. Returns true if a new row was inserted (first
 * time we've seen this URL), false if it was already present (idempotent no-op).
 *
 * Uses the existing partial unique index uq_dev_items_source — no separate
 * idempotency table needed.
 */
export function persistPosthogBotPr(db: Database, pr: PosthogBotPr): boolean {
  const description =
    `PostHog Self-Driving PR #${pr.number} on ${pr.repo}\n\n` +
    `${pr.url}\n\n` +
    `Branch: \`${pr.headRef}\`\n` +
    `Opened: ${pr.createdAt}`
  try {
    const info = db
      .prepare(
        `INSERT OR IGNORE INTO dev_items
           (workspace, type, title, description, status, area,
            submitted_via, source_system, source_id)
         VALUES (?, 'feature', ?, ?, 'new', 'posthog-self-driving',
                 'import', 'posthog-bot', ?)`,
      )
      .run(pr.workspace, pr.title, description, pr.url)
    return info.changes > 0
  } catch (err) {
    console.warn(`[posthog-bot-prs] failed to persist PR ${pr.url}:`, (err as Error).message)
    return false
  }
}

/**
 * Full discovery sweep: enumerate all known repos, fetch open posthog[bot]
 * PRs from GitHub, persist new ones. Never throws — per-repo errors are
 * collected and returned so one inaccessible repo never breaks the sweep.
 */
export async function discoverPosthogBotPrs(
  db: Database,
  gh: GhExec,
): Promise<PosthogBotDiscoverResult> {
  const repos = reposForDiscovery(db)
  const reposScanned: string[] = []
  let prsFound = 0
  let prsPersisted = 0
  const errors: Array<{ repo: string; message: string }> = []

  for (const row of repos) {
    const repoName = row.github.trim()
    if (!repoName) continue
    reposScanned.push(repoName)

    let prs: PosthogBotPr[]
    try {
      prs = await fetchPosthogBotPrs(gh, repoName, row.workspace)
    } catch (err) {
      errors.push({ repo: repoName, message: (err as Error).message })
      continue
    }

    prsFound += prs.length
    for (const pr of prs) {
      if (persistPosthogBotPr(db, pr)) prsPersisted++
    }
  }

  if (reposScanned.length > 0 || errors.length > 0) {
    console.log(
      `[posthog-bot-prs] scanned ${reposScanned.length} repo(s), found ${prsFound} open PR(s), persisted ${prsPersisted} new`,
      errors.length > 0 ? `(${errors.length} error(s))` : '',
    )
  }

  return { repos_scanned: reposScanned, prs_found: prsFound, prs_persisted: prsPersisted, errors }
}
