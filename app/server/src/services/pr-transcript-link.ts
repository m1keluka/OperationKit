// Session-end PR linkage from the worker's own transcript (obj 712954).
//
// `discoverAndBackfillPR` (pr-linkage.ts) only runs for `create_pr` cards with a
// NULL pr_number, and only searches this repo by derived branch. Two live cards
// fell through every arm of it:
//   - obj 712937 (example-project, create_pr = 0) opened PR 717 and the card never
//     got a pr_url/pr_number/branch_name;
//   - obj 712923 kept pointing at its merged round-1 PR 715 after the worker
//     opened round-2 PR 716, because "already linked" short-circuits.
//
// The transcript is the one place that knows which PR the worker actually
// opened, in whatever repo: the stdout of its `gh pr create` Bash call and the
// CLI's `code_change_published` event. `extractPrCandidates` reads those (pure),
// `decidePrLink` picks one against the card's current link (pure), and
// `relinkPrFromTranscript` confirms state with `gh pr view` and writes through the
// same columns + objective_prs log as /pr-created, plus an audit row.

import type { Database } from 'better-sqlite3'
import type { Objective } from '@operationkit/shared'
import type { GhExec } from './pr-linkage.js'
import { upsertObjectivePR, parseRepoFromPrUrl } from './objective-prs.js'
import { logObjectiveAudit } from './objective-audit.js'

export interface PrCandidate {
  url: string
  repo: string
  number: number
  source: 'gh-pr-create' | 'code-change'
}

export type PrState = 'OPEN' | 'MERGED' | 'CLOSED'

export interface PrInfo {
  state: PrState | null
  headRefName: string | null
  title: string | null
}

const PR_URL_RE = /https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/(\d+)/g

function prUrlsIn(text: string): Array<{ url: string; repo: string; number: number }> {
  const out: Array<{ url: string; repo: string; number: number }> = []
  for (const m of text.matchAll(PR_URL_RE)) {
    const number = parseInt(m[2], 10)
    if (Number.isInteger(number) && number > 0) {
      out.push({ url: `https://github.com/${m[1]}/pull/${number}`, repo: m[1], number })
    }
  }
  return out
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map(c => (c && typeof (c as { text?: unknown }).text === 'string' ? (c as { text: string }).text : ''))
      .join('\n')
  }
  return ''
}

/**
 * Pure: PRs this transcript created or published, oldest → newest, deduped by
 * URL (a re-mention moves the PR to its latest position). Sources:
 *   - the tool_result of a Bash call whose command runs `gh pr create`
 *     (the URL `gh` prints is the ground truth — no ownership guess needed);
 *   - `system/code_change_published` events (provider github, `/pull/<n>` url).
 * Malformed lines are skipped.
 */
export function extractPrCandidates(lines: string[]): PrCandidate[] {
  const prCreateToolIds = new Set<string>()
  const ordered: PrCandidate[] = []
  const push = (c: PrCandidate) => {
    const i = ordered.findIndex(o => o.url === c.url)
    if (i >= 0) {
      // Keep the stronger source if the same PR was seen both ways.
      if (ordered[i].source === 'gh-pr-create') c = { ...c, source: 'gh-pr-create' }
      ordered.splice(i, 1)
    }
    ordered.push(c)
  }
  if (!Array.isArray(lines)) return ordered
  for (const raw of lines) {
    const trimmed = typeof raw === 'string' ? raw.trim() : ''
    if (!trimmed) continue
    let e: Record<string, unknown>
    try {
      const parsed = JSON.parse(trimmed)
      if (!parsed || typeof parsed !== 'object') continue
      e = parsed as Record<string, unknown>
    } catch {
      continue
    }
    const content = (e.message as { content?: unknown } | undefined)?.content
    if (e.type === 'assistant' && Array.isArray(content)) {
      for (const b of content as Array<Record<string, unknown>>) {
        if (b?.type !== 'tool_use' || b.name !== 'Bash' || typeof b.id !== 'string') continue
        const cmd = (b.input as { command?: unknown } | undefined)?.command
        if (typeof cmd === 'string' && /\bgh\s+pr\s+create\b/.test(cmd)) prCreateToolIds.add(b.id)
      }
    } else if (e.type === 'user' && Array.isArray(content)) {
      for (const b of content as Array<Record<string, unknown>>) {
        if (b?.type !== 'tool_result' || typeof b.tool_use_id !== 'string') continue
        if (!prCreateToolIds.has(b.tool_use_id) || b.is_error === true) continue
        const urls = prUrlsIn(textOf(b.content))
        // `gh pr create` prints the new PR's URL last.
        if (urls.length > 0) push({ ...urls[urls.length - 1], source: 'gh-pr-create' })
      }
    } else if (e.type === 'system' && e.subtype === 'code_change_published' && typeof e.url === 'string') {
      if (e.provider !== undefined && e.provider !== 'github') continue
      const urls = prUrlsIn(e.url)
      if (urls.length > 0) push({ ...urls[0], source: 'code-change' })
    }
  }
  return ordered
}

/** True when a head branch or title names this objective (`obj712937`, `obj-712954`, `ws-712923`). */
export function namesObjective(objectiveId: number, ...texts: Array<string | null | undefined>): boolean {
  const re = new RegExp(`(?:obj[-_]?|ws-)${objectiveId}(?!\\d)`, 'i')
  return texts.some(t => typeof t === 'string' && re.test(t))
}

export type PrLinkDecision =
  | { action: 'link'; candidate: PrCandidate; reason: 'unlinked' | 'relink-newer' }
  | { action: 'skip'; reason: string }

/**
 * Pure: which PR (if any) should the card point at after this session?
 *
 * - Unlinked card → the newest candidate that is not CLOSED-unmerged (unknown
 *   state is fine for a `gh pr create` URL — gh printed it, it exists).
 * - Linked card → relink ONLY when the current PR is MERGED/CLOSED and a newer
 *   candidate (different repo, or a higher number in the same repo) is OPEN or
 *   MERGED. An OPEN current link is never replaced; an unknown current state is
 *   never guessed at.
 * - `code-change` candidates (not created by this transcript) must name the
 *   objective in their head branch or title before they can be linked.
 */
export function decidePrLink(input: {
  objectiveId: number
  current: { pr_number: number | null; pr_url: string | null }
  currentState: PrState | null
  candidates: PrCandidate[]
  info: (c: PrCandidate) => PrInfo | null
}): PrLinkDecision {
  const { objectiveId, current, currentState, candidates, info } = input
  if (candidates.length === 0) return { action: 'skip', reason: 'no-candidates' }
  const currentRepo = parseRepoFromPrUrl(current.pr_url)

  const eligible = (c: PrCandidate, allowUnknown: boolean): boolean => {
    const i = info(c)
    if (c.source === 'code-change' && !namesObjective(objectiveId, i?.headRefName, i?.title)) return false
    if (!i || !i.state) return allowUnknown && c.source === 'gh-pr-create'
    return i.state !== 'CLOSED'
  }

  const newestFirst = [...candidates].reverse()

  if (current.pr_number == null && !current.pr_url) {
    const pick = newestFirst.find(c => eligible(c, true))
    return pick ? { action: 'link', candidate: pick, reason: 'unlinked' } : { action: 'skip', reason: 'no-eligible-candidate' }
  }

  const isCurrent = (c: PrCandidate) =>
    c.url === current.pr_url ||
    (c.number === current.pr_number && (currentRepo == null || currentRepo === c.repo))
  if (isCurrent(newestFirst[0])) return { action: 'skip', reason: 'already-linked' }
  if (currentState !== 'MERGED' && currentState !== 'CLOSED') {
    return { action: 'skip', reason: currentState === 'OPEN' ? 'current-open' : 'current-state-unknown' }
  }
  const pick = newestFirst.find(c =>
    !isCurrent(c) &&
    (currentRepo == null || c.repo !== currentRepo || current.pr_number == null || c.number > current.pr_number) &&
    eligible(c, false),
  )
  return pick ? { action: 'link', candidate: pick, reason: 'relink-newer' } : { action: 'skip', reason: 'no-newer-candidate' }
}

async function ghPrInfo(gh: GhExec, repo: string, number: number): Promise<PrInfo | null> {
  try {
    const raw = await gh(['pr', 'view', String(number), '--repo', repo, '--json', 'state,headRefName,title'])
    const j = JSON.parse(raw || '{}') as { state?: string; headRefName?: string; title?: string }
    const state = j.state === 'OPEN' || j.state === 'MERGED' || j.state === 'CLOSED' ? j.state : null
    return { state, headRefName: j.headRefName ?? null, title: j.title ?? null }
  } catch {
    return null
  }
}

export interface TranscriptLinkResult {
  linked: boolean
  reason: string
  pr_number?: number
  pr_url?: string
  branch?: string | null
}

/**
 * Session-end orchestrator: parse the transcript, look up PR state via `gh`
 * (bounded: the newest candidate + the current link), and write the link.
 * Never throws; every failure is a `reason`.
 */
export async function relinkPrFromTranscript(
  db: Database,
  objective: Objective,
  lines: string[],
  gh: GhExec,
): Promise<TranscriptLinkResult> {
  const candidates = extractPrCandidates(lines)
  if (candidates.length === 0) return { linked: false, reason: 'no-candidates' }

  const currentRepo = parseRepoFromPrUrl(objective.pr_url)
  const currentNumber = objective.pr_number ?? null
  const newest = candidates[candidates.length - 1]
  if (
    newest.url === objective.pr_url ||
    (currentNumber === newest.number && (currentRepo == null || currentRepo === newest.repo))
  ) {
    return { linked: false, reason: 'already-linked' }
  }

  // At most two gh calls per session end (this runs inside the poll tick): the
  // newest candidate, and the current link's state when there is one.
  const infos = new Map<string, PrInfo | null>()
  infos.set(newest.url, await ghPrInfo(gh, newest.repo, newest.number))
  let currentState: PrState | null = null
  if (currentNumber != null && currentRepo) {
    currentState = (await ghPrInfo(gh, currentRepo, currentNumber))?.state ?? null
  }

  const decision = decidePrLink({
    objectiveId: objective.id,
    current: { pr_number: currentNumber, pr_url: objective.pr_url ?? null },
    currentState,
    candidates,
    info: c => infos.get(c.url) ?? null,
  })
  if (decision.action === 'skip') return { linked: false, reason: decision.reason }

  const c = decision.candidate
  const branch = infos.get(c.url)?.headRefName ?? null
  try {
    db.prepare(
      "UPDATE objectives SET pr_url = ?, pr_number = ?, branch_name = COALESCE(?, branch_name), updated_at = datetime('now') WHERE id = ?",
    ).run(c.url, c.number, branch, objective.id)
    upsertObjectivePR({ objective_id: objective.id, pr_number: c.number, pr_url: c.url, branch_name: branch, repo: c.repo })
    logObjectiveAudit(db, {
      objectiveId: objective.id,
      eventType: 'pr_link',
      actor: 'state-poller',
      pathway: `session-end-transcript-${decision.reason}: ${objective.pr_url ?? 'none'} -> ${c.url}`,
      sessionId: objective.session_id ?? null,
      titleSnapshot: objective.title,
      workspace: objective.workspace,
    })
  } catch (err) {
    console.warn(`[pr-linkage] transcript link write failed for obj ${objective.id}:`, (err as Error).message)
    return { linked: false, reason: 'write-error' }
  }
  console.log(`[pr-linkage] obj ${objective.id}: ${decision.reason} → ${c.url} (from transcript ${c.source})`)
  return { linked: true, reason: decision.reason, pr_number: c.number, pr_url: c.url, branch }
}
