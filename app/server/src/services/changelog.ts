// Stakeholder "What's Shipping" changelog collector + translator (obj 937).
//
// Flow: an org-level GitHub webhook fires on merged PRs → `collectFromMergedPR`
// normalizes + classifies the PR, enriches from objective_reviews when the PR
// was audited by THIS command-center, upserts a `changelog_entries` row, then
// `translateEntry` turns the engineering PR into plain-English stakeholder copy
// (preferring the reviewer's audited feature_brief; falling back to one LLM pass).

import { getDb } from '../db/index.js'
import { REPO_SCOPE_SQL, repoScopeParams } from './objective-prs.js'
import type {
  ChangelogCategory,
  ChangelogStatus,
  ChangelogEntry,
  FeatureBrief,
} from '@command-center/shared'

// ── Conventional-commit / label classification ──

const CC_CATEGORY: Record<string, { category: ChangelogCategory; worthy: boolean }> = {
  feat: { category: 'feature', worthy: true },
  fix: { category: 'fix', worthy: true },
  perf: { category: 'improvement', worthy: true },
  refactor: { category: 'improvement', worthy: false },
  chore: { category: 'infra', worthy: false },
  docs: { category: 'infra', worthy: false },
  test: { category: 'infra', worthy: false },
  build: { category: 'infra', worthy: false },
  ci: { category: 'infra', worthy: false },
  style: { category: 'infra', worthy: false },
}

/**
 * Gate a PR for the stakeholder changelog. Parses a conventional-commit prefix
 * from the title and maps it to a category + default worthiness; labels can
 * override either direction.
 */
export function classifyPR(
  title: string,
  labels: string[]
): { worthy: boolean; category: ChangelogCategory } {
  const lower = (labels || []).map((l) => String(l).toLowerCase())

  // Parse a conventional-commit prefix: `type(scope)!: subject`.
  const m = /^\s*([a-z]+)(\([^)]*\))?(!)?:/i.exec(title || '')
  const type = m ? m[1].toLowerCase() : ''
  const mapped = CC_CATEGORY[type]

  let category: ChangelogCategory = mapped ? mapped.category : 'feature'
  let worthy = mapped ? mapped.worthy : true // unknown/no-prefix → assume worthy feature

  // Label overrides (highest priority).
  const forceWorthy = lower.some(
    (l) => l === 'changelog:feature' || l === 'changelog' || l === 'stakeholder'
  )
  const forceSkip = lower.some(
    (l) => l === 'skip-changelog' || l === 'internal' || l === 'no-changelog'
  )
  // Category hint labels.
  if (lower.includes('changelog:fix')) category = 'fix'
  else if (lower.includes('changelog:improvement')) category = 'improvement'
  else if (lower.includes('changelog:infra')) category = 'infra'
  else if (lower.includes('changelog:feature')) category = 'feature'

  if (forceWorthy) worthy = true
  if (forceSkip) worthy = false

  return { worthy, category }
}

// ── Platform / brand mapping ──

const PLATFORM_MAP: Record<string, string> = {
  'your-org/command-center-infra': 'Command Center',
  'your-org/example-platform': 'Example Platform',
  'your-org/example-project-platform': 'Example Project',
}

function titleCase(s: string): string {
  return s
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

function platformForRepo(repo: string): string {
  const key = (repo || '').toLowerCase()
  if (PLATFORM_MAP[key]) return PLATFORM_MAP[key]
  if (key.includes('example2') || key.includes('example3')) return 'Example3'
  const name = (repo || '').split('/').pop() || repo || ''
  const stripped = name.replace(/-platform$/i, '').replace(/-infra$/i, '')
  return titleCase(stripped) || name
}

// ── PR body parsing ──

/**
 * Pull a "## What's shipping" markdown section out of a PR body. Tolerant of
 * casing and the apostrophe variant. Returns the section text up to the next
 * heading, trimmed of template boilerplate / checklist lines.
 */
function parseWhatsShipping(body: string): string {
  if (!body) return ''
  const lines = body.split(/\r?\n/)
  let capturing = false
  const out: string[] = []
  for (const line of lines) {
    const heading = /^#{1,6}\s+(.*)$/.exec(line)
    if (heading) {
      const text = heading[1].toLowerCase().replace(/[’']/g, "'")
      if (/what'?s shipping/.test(text)) {
        capturing = true
        continue
      }
      if (capturing) break // next heading ends the section
    }
    if (capturing) out.push(line)
  }
  return out
    .join('\n')
    .replace(/^\s*[-*]\s*\[[ xX]\].*$/gm, '') // strip checklist lines
    .replace(/<!--[\s\S]*?-->/g, '') // strip html comments
    .trim()
}

// ── Normalized merged-PR payload ──

export interface MergedPRPayload {
  repo: string
  prNumber: number
  prUrl: string
  mergeCommitSha?: string | null
  author?: string | null
  mergedAt: string
  title: string
  body?: string
  labels: string[]
}

function safeParseBrief(raw: string | null | undefined): FeatureBrief | null {
  if (!raw) return null
  try {
    const p = JSON.parse(raw) as Partial<FeatureBrief>
    if (p && typeof p === 'object' && typeof p.headline === 'string') {
      return {
        headline: String(p.headline || ''),
        description: String(p.description || ''),
        overview: String(p.overview || ''),
        audience_worthy: p.audience_worthy !== false,
      }
    }
  } catch {
    /* ignore */
  }
  return null
}

function safeParseArray(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    const p = JSON.parse(raw)
    return Array.isArray(p) ? p.filter((x) => typeof x === 'string') : []
  } catch {
    return []
  }
}

/**
 * Collect a merged PR into the changelog: classify, enrich from a linked
 * objective's latest passing review, upsert the row, then translate.
 */
export function collectFromMergedPR(payload: MergedPRPayload): {
  entryId: number
  status: ChangelogStatus
} {
  const db = getDb()
  const repo = payload.repo
  const prNumber = Number(payload.prNumber)
  const platform = platformForRepo(repo)
  const { worthy, category } = classifyPR(payload.title || '', payload.labels || [])

  // Look up a linked cc objective (audited here) by PR URL or number.
  //
  // obj 704718 — the `pr_number = ?` arm used to be UNSCOPED. `objectives` has no repo
  // column, and PR numbers collide across the repos the Command Center drives (obj 2040
  // is example3#202, 702028 is example-project#245, 701986 is example-project#241 — all
  // colliding with cc-infra numbers). `ORDER BY id DESC` then hands a merged PR in one
  // repo the newest objective carrying that number in ANY repo, and this function goes
  // on to publish THAT objective's feature brief and review screenshots as the
  // changelog entry for a PR it never touched. The number arm is now repo-scoped;
  // the pr_url arm was always exact and is unchanged.
  let objectiveId: number | null = null
  try {
    const obj = db
      .prepare(
        `SELECT o.id FROM objectives o
         WHERE (o.pr_url = ? AND o.pr_url IS NOT NULL AND o.pr_url != '')
            OR (o.pr_number = ? AND o.pr_number IS NOT NULL AND ${REPO_SCOPE_SQL})
         ORDER BY o.id DESC LIMIT 1`
      )
      .get(payload.prUrl || '', prNumber, ...repoScopeParams(repo)) as { id?: number } | undefined
    if (obj && typeof obj.id === 'number') objectiveId = obj.id
  } catch {
    /* objectives table may lack pr_url/pr_number in some envs */
  }

  // Pull the latest passing review brief + screenshots for that objective.
  let featureBriefRaw = ''
  let screenshots: string[] = []
  if (objectiveId != null) {
    try {
      const rev = db
        .prepare(
          `SELECT feature_brief, screenshot_paths FROM objective_reviews
           WHERE objective_id = ? AND verdict = 'pass'
           ORDER BY iteration DESC LIMIT 1`
        )
        .get(objectiveId) as
        | { feature_brief?: string; screenshot_paths?: string }
        | undefined
      if (rev) {
        featureBriefRaw = rev.feature_brief || ''
        screenshots = safeParseArray(rev.screenshot_paths)
      }
    } catch {
      /* ignore */
    }
  }

  const status: ChangelogStatus = worthy ? 'draft' : 'skipped'

  const upsert = db.prepare(
    `INSERT INTO changelog_entries
       (repo, pr_number, pr_url, merge_commit_sha, platform, author, merged_at,
        category, status, title_eng, feature_brief, screenshots, objective_id,
        created_at, updated_at)
     VALUES
       (@repo, @pr_number, @pr_url, @merge_commit_sha, @platform, @author, @merged_at,
        @category, @status, @title_eng, @feature_brief, @screenshots, @objective_id,
        datetime('now'), datetime('now'))
     ON CONFLICT(repo, pr_number) DO UPDATE SET
        pr_url = excluded.pr_url,
        merge_commit_sha = excluded.merge_commit_sha,
        platform = excluded.platform,
        author = excluded.author,
        merged_at = excluded.merged_at,
        category = excluded.category,
        status = CASE WHEN excluded.status = 'skipped' THEN 'skipped' ELSE changelog_entries.status END,
        title_eng = excluded.title_eng,
        feature_brief = CASE WHEN excluded.feature_brief != '' THEN excluded.feature_brief ELSE changelog_entries.feature_brief END,
        screenshots = CASE WHEN excluded.screenshots != '[]' THEN excluded.screenshots ELSE changelog_entries.screenshots END,
        objective_id = COALESCE(excluded.objective_id, changelog_entries.objective_id),
        updated_at = datetime('now')`
  )

  upsert.run({
    repo,
    pr_number: prNumber,
    pr_url: payload.prUrl || '',
    merge_commit_sha: payload.mergeCommitSha || null,
    platform,
    author: payload.author || null,
    merged_at: payload.mergedAt || new Date().toISOString(),
    category,
    status,
    title_eng: payload.title || '',
    feature_brief: featureBriefRaw,
    screenshots: JSON.stringify(screenshots),
    objective_id: objectiveId,
  })

  const row = db
    .prepare(`SELECT id FROM changelog_entries WHERE repo = ? AND pr_number = ?`)
    .get(repo, prNumber) as { id: number }
  const entryId = row.id

  // Stash the parsed "What's shipping" body as an LLM fallback source. We store
  // it in body_stakeholder only if there's no audited brief and translate hasn't
  // run yet; translateEntry will overwrite as appropriate.
  const whatsShipping = parseWhatsShipping(payload.body || '')

  if (!worthy) {
    // Skipped: no translation needed, but keep a minimal title for debugging.
    db.prepare(
      `UPDATE changelog_entries SET headline = COALESCE(NULLIF(headline,''), ?), updated_at = datetime('now') WHERE id = ?`
    ).run(payload.title || '', entryId)
    return { entryId, status: 'skipped' }
  }

  const finalStatus = translateEntry(entryId, whatsShipping)
  return { entryId, status: finalStatus }
}

// ── Translation (audited brief preferred, else one LLM pass) ──

interface EntryRow {
  id: number
  title_eng: string
  category: ChangelogCategory
  feature_brief: string
  body_stakeholder: string
  status: ChangelogStatus
}

/**
 * Turn a collected entry into stakeholder copy. Prefers the reviewer's audited
 * feature_brief (no LLM). Falls back to one LLM pass over the PR title + the
 * parsed "What's shipping" body. Never throws; degrades to 'draft' on failure.
 */
export function translateEntry(entryId: number, whatsShippingHint?: string): ChangelogStatus {
  const db = getDb()
  const entry = db
    .prepare(
      `SELECT id, title_eng, category, feature_brief, body_stakeholder, status
       FROM changelog_entries WHERE id = ?`
    )
    .get(entryId) as EntryRow | undefined
  if (!entry) return 'draft'

  // Path 1: audited feature_brief present → use it directly, no LLM.
  const brief = safeParseBrief(entry.feature_brief)
  if (brief) {
    const status: ChangelogStatus = brief.audience_worthy === false ? 'skipped' : 'published'
    db.prepare(
      `UPDATE changelog_entries
       SET headline = ?, body_stakeholder = ?, overview = ?, status = ?, updated_at = datetime('now')
       WHERE id = ?`
    ).run(brief.headline, brief.description, brief.overview, status, entryId)
    return status
  }

  // Path 2: LLM translation pass.
  const whatsShipping =
    whatsShippingHint != null && whatsShippingHint !== ''
      ? whatsShippingHint
      : entry.body_stakeholder || ''

  // Synchronously fire the LLM via a blocking deasync-free approach is not
  // possible with fetch; translateEntry is declared sync per the contract, so
  // we run the LLM best-effort and apply a graceful fallback when unavailable.
  // We kick off the async translation but also write an immediate minimal
  // fallback so the row is never left empty. The async result, when it lands,
  // overwrites with richer copy.
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    db.prepare(
      `UPDATE changelog_entries
       SET headline = COALESCE(NULLIF(headline,''), ?), body_stakeholder = COALESCE(NULLIF(body_stakeholder,''), ?), status = 'draft', updated_at = datetime('now')
       WHERE id = ?`
    ).run(entry.title_eng, whatsShipping, entryId)
    return 'draft'
  }

  // Write a minimal fallback synchronously, then asynchronously enrich.
  db.prepare(
    `UPDATE changelog_entries
     SET headline = COALESCE(NULLIF(headline,''), ?), body_stakeholder = COALESCE(NULLIF(body_stakeholder,''), ?), updated_at = datetime('now')
     WHERE id = ?`
  ).run(entry.title_eng, whatsShipping, entryId)

  void runLlmTranslation(entryId, entry.title_eng, entry.category, whatsShipping, apiKey)

  // Optimistically report 'draft' now; the async pass will flip it to
  // published/skipped when it completes (and the next listPublished reflects it).
  return 'draft'
}

async function runLlmTranslation(
  entryId: number,
  title: string,
  category: ChangelogCategory,
  whatsShipping: string,
  apiKey: string
): Promise<void> {
  const db = getDb()
  const system = [
    'You translate engineering pull-request descriptions into a short,',
    'stakeholder-facing changelog entry. The audience is non-technical (founders,',
    'investors, customers). Use plain English — no code, file names, or jargon.',
    'Focus on what changed and who benefits.',
    'Return STRICT JSON only, no markdown fences, with exactly these keys:',
    '{"headline": string, "description": string, "overview": string, "audience_worthy": boolean}',
    '- headline: one punchy plain-English line.',
    '- description: 1-3 sentences on what shipped and the user benefit.',
    '- overview: a slightly longer "how it works" in plain terms (1-3 sentences).',
    '- audience_worthy: false ONLY for pure internal refactors/chores with no user-facing value.',
  ].join('\n')

  const userPrompt = [
    `PR title: ${title}`,
    `Category: ${category}`,
    whatsShipping ? `What's shipping (author notes):\n${whatsShipping}` : '(no author notes provided)',
    '',
    'Return the JSON now.',
  ].join('\n')

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        temperature: 0.3,
        system,
        messages: [{ role: 'user', content: userPrompt }],
      }),
      signal: AbortSignal.timeout(60_000),
    })
    if (!res.ok) {
      await res.text().catch(() => '')
      console.warn(`[changelog] LLM translate ${res.status} for entry ${entryId}`)
      return // leave as draft fallback
    }
    const data = (await res.json()) as { content?: Array<{ type: string; text?: string }> }
    const text = data.content?.find((b) => b.type === 'text')?.text?.trim() || ''
    const cleaned = text.replace(/^```json?\s*\n?/, '').replace(/\n?```$/, '').trim()
    let parsed: Partial<FeatureBrief>
    try {
      parsed = JSON.parse(cleaned) as Partial<FeatureBrief>
    } catch {
      console.warn(`[changelog] LLM non-JSON for entry ${entryId}: ${cleaned.slice(0, 200)}`)
      return
    }
    const status: ChangelogStatus = parsed.audience_worthy === false ? 'skipped' : 'published'
    db.prepare(
      `UPDATE changelog_entries
       SET headline = ?, body_stakeholder = ?, overview = ?, status = ?, updated_at = datetime('now')
       WHERE id = ?`
    ).run(
      String(parsed.headline || title),
      String(parsed.description || whatsShipping || ''),
      String(parsed.overview || ''),
      status,
      entryId
    )
  } catch (err) {
    console.warn(`[changelog] LLM translate error for entry ${entryId}:`, (err as Error).message)
    // leave draft fallback in place
  }
}

// ── Read surface ──

function rowToEntry(r: Record<string, unknown>): ChangelogEntry {
  return {
    id: r.id as number,
    repo: r.repo as string,
    pr_number: r.pr_number as number,
    pr_url: r.pr_url as string,
    merge_commit_sha: (r.merge_commit_sha as string) ?? null,
    platform: r.platform as string,
    author: (r.author as string) ?? null,
    merged_at: r.merged_at as string,
    category: r.category as ChangelogCategory,
    status: r.status as ChangelogStatus,
    title_eng: r.title_eng as string,
    headline: r.headline as string,
    body_stakeholder: r.body_stakeholder as string,
    overview: r.overview as string,
    feature_brief: r.feature_brief as string,
    screenshots: safeParseArray(r.screenshots as string),
    objective_id: (r.objective_id as number) ?? null,
    created_at: r.created_at as string,
    updated_at: r.updated_at as string,
  }
}

export function listPublished(opts?: { limit?: number; platform?: string }): ChangelogEntry[] {
  const db = getDb()
  const limit = opts?.limit && opts.limit > 0 ? Math.min(opts.limit, 500) : 100
  let rows: Record<string, unknown>[]
  if (opts?.platform) {
    rows = db
      .prepare(
        `SELECT * FROM changelog_entries WHERE status = 'published' AND platform = ?
         ORDER BY merged_at DESC LIMIT ?`
      )
      .all(opts.platform, limit) as Record<string, unknown>[]
  } else {
    rows = db
      .prepare(
        `SELECT * FROM changelog_entries WHERE status = 'published'
         ORDER BY merged_at DESC LIMIT ?`
      )
      .all(limit) as Record<string, unknown>[]
  }
  return rows.map(rowToEntry)
}

/** All entries (any status) — debug/admin surface. */
export function listAllEntries(limit = 500): ChangelogEntry[] {
  const db = getDb()
  const rows = db
    .prepare(`SELECT * FROM changelog_entries ORDER BY merged_at DESC LIMIT ?`)
    .all(Math.min(limit, 1000)) as Record<string, unknown>[]
  return rows.map(rowToEntry)
}
