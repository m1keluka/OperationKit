/**
 * Resumed-session history cap (obj 64, Part A).
 *
 * Every respawn of a dead worker (`sendFollowUp`) used to `claude --resume` the
 * card's full CLI transcript. Each resume replays the whole context, so a long
 * card pays for its entire history again on every round: one card (#719249 on the
 * old server) ran 56 resumed sessions at ~157M tokens each — ~$1,580 of
 * API-equivalent excess in one week.
 *
 * Once the card's CURRENT session chain is over budget — cumulative tokens since
 * the chain started ≥ `tokens`, OR resumes since the chain started ≥ `rounds`,
 * whichever comes first — the respawn does NOT resume. It starts a FRESH CLI
 * conversation seeded with a compact, deterministic summary built from DB fields
 * only (no model call): goal, state, open TODOs, branch/PR, last review findings,
 * last session summary, child-task rows. The start is recorded in
 * `session_starts` with reason `fresh_seeded_after_cap` and shown on the card.
 *
 * Chain boundaries:
 *   - a brand-new session id (startSession) is a new chain by construction —
 *     rounds are counted per session id;
 *   - a seeded fresh start appends a `{"type":"chain_reset"}` marker to the
 *     session jsonl (tokens are only summed AFTER the last marker) and logs a
 *     `fresh_seeded_after_cap` start row (rounds are only counted AFTER it).
 *
 * Config (env wins over setting, setting wins over default):
 *   CC_RESUME_CAP_TOKENS  / settings.resume_cap_tokens   default 40,000,000
 *   CC_RESUME_CAP_ROUNDS  / settings.resume_cap_rounds   default 12
 *   CC_RESUME_CAP_ENABLED / settings.resume_cap_enabled  default '1' ('0' = off)
 * A value of 0 for tokens or rounds disables that one trigger.
 */
import fs from 'fs'
import type { Database } from 'better-sqlite3'
import type { Objective } from '@operationkit/shared'
import { sumResultEventsFromContent } from './session-usage.js'

export const FRESH_SEEDED_REASON = 'fresh_seeded_after_cap'
export const CHAIN_RESET_EVENT_TYPE = 'chain_reset'

export const DEFAULT_RESUME_CAP_TOKENS = 40_000_000
export const DEFAULT_RESUME_CAP_ROUNDS = 12

export interface ResumeCapConfig {
  enabled: boolean
  /** Cumulative chain tokens at/above which the next respawn is fresh-seeded. 0 = trigger off. */
  tokens: number
  /** Resumes in the chain at/above which the next respawn is fresh-seeded. 0 = trigger off. */
  rounds: number
}

function readSetting(db: Database | null, key: string): string | null {
  if (!db) return null
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
    return row?.value ?? null
  } catch {
    return null
  }
}

function nonNegInt(raw: string | null | undefined): number | null {
  if (raw == null || String(raw).trim() === '') return null
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null
}

export function resolveResumeCapConfig(db: Database | null, env: NodeJS.ProcessEnv = process.env): ResumeCapConfig {
  const enabledRaw = env.CC_RESUME_CAP_ENABLED ?? readSetting(db, 'resume_cap_enabled')
  const enabled = enabledRaw == null ? true : !['0', 'false', 'off', 'no'].includes(String(enabledRaw).trim().toLowerCase())
  const tokens =
    nonNegInt(env.CC_RESUME_CAP_TOKENS) ?? nonNegInt(readSetting(db, 'resume_cap_tokens')) ?? DEFAULT_RESUME_CAP_TOKENS
  const rounds =
    nonNegInt(env.CC_RESUME_CAP_ROUNDS) ?? nonNegInt(readSetting(db, 'resume_cap_rounds')) ?? DEFAULT_RESUME_CAP_ROUNDS
  return { enabled, tokens, rounds }
}

export interface ChainUsage {
  /** Tokens (input + output + cache read + cache creation) since the chain started. */
  tokens: number
  /** Resumes of this session id since the chain started. */
  rounds: number
}

export interface ResumeCapDecision {
  capped: boolean
  trigger: 'tokens' | 'rounds' | null
  usage: ChainUsage
  config: ResumeCapConfig
}

/** Pure threshold check. Boundary: AT the threshold counts as over (`>=`). */
export function decideResumeCap(usage: ChainUsage, config: ResumeCapConfig): ResumeCapDecision {
  if (!config.enabled) return { capped: false, trigger: null, usage, config }
  if (config.tokens > 0 && usage.tokens >= config.tokens) return { capped: true, trigger: 'tokens', usage, config }
  if (config.rounds > 0 && usage.rounds >= config.rounds) return { capped: true, trigger: 'rounds', usage, config }
  return { capped: false, trigger: null, usage, config }
}

/** Tokens in a session jsonl AFTER the last chain_reset marker. */
export function chainTokensFromContent(content: string): number {
  const marker = `"type":"${CHAIN_RESET_EVENT_TYPE}"`
  const idx = content.lastIndexOf(marker)
  const tail = idx === -1 ? content : content.slice(content.indexOf('\n', idx) + 1 || content.length)
  return sumResultEventsFromContent(tail).tokens
}

export function chainTokens(jsonlPath: string): number {
  try {
    return chainTokensFromContent(fs.readFileSync(jsonlPath, 'utf-8'))
  } catch {
    return 0
  }
}

/** Resumes of `sessionId` recorded after its last fresh-seeded start. */
export function chainRounds(db: Database, sessionId: string): number {
  try {
    const reset = db
      .prepare('SELECT MAX(id) AS id FROM session_starts WHERE session_id = ? AND reason = ?')
      .get(sessionId, FRESH_SEEDED_REASON) as { id: number | null } | undefined
    const row = db
      .prepare("SELECT COUNT(*) AS n FROM session_starts WHERE session_id = ? AND kind = 'resume' AND id > ?")
      .get(sessionId, reset?.id ?? 0) as { n: number }
    return row.n
  } catch {
    return 0
  }
}

export function measureChain(db: Database, sessionId: string, jsonlPath: string): ChainUsage {
  return { tokens: chainTokens(jsonlPath), rounds: chainRounds(db, sessionId) }
}

/** Append the chain-reset marker so the next measurement starts from zero tokens. */
export function markChainReset(jsonlPath: string, decision: ResumeCapDecision, now = new Date()): void {
  const event = {
    type: CHAIN_RESET_EVENT_TYPE,
    reason: FRESH_SEEDED_REASON,
    trigger: decision.trigger,
    prior_tokens: decision.usage.tokens,
    prior_rounds: decision.usage.rounds,
    timestamp: now.toISOString(),
  }
  fs.appendFileSync(jsonlPath, JSON.stringify(event) + '\n')
}

export function describeCapDetail(d: ResumeCapDecision, priorReason?: string | null): string {
  const t = `${(d.usage.tokens / 1e6).toFixed(1)}M tokens (cap ${(d.config.tokens / 1e6).toFixed(1)}M)`
  const r = `${d.usage.rounds} resumes (cap ${d.config.rounds})`
  return `trigger=${d.trigger}; ${t}; ${r}` + (priorReason && priorReason !== 'unattributed' ? `; wake=${priorReason}` : '')
}

// ── Deterministic seeded summary ───────────────────────────────────────────

const FIELD_CAP = 4000
const MAX_TASK_ROWS = 25

function clip(text: string | null | undefined, cap = FIELD_CAP): string {
  const s = (text ?? '').trim()
  if (s.length <= cap) return s
  return s.slice(0, cap) + `\n…[truncated ${s.length - cap} chars]`
}

interface SummaryRow {
  id: number
  title: string
  status: string
  description: string | null
  completion_goal: string | null
  last_session_summary: string | null
  ai_review_verdict: string | null
  ai_review_findings: string | null
  pr_url: string | null
  branch_name: string | null
  needs_secret?: string | null
}

const OPEN_TASK_STATUSES = new Set(['planning', 'queue', 'working', 'ai_review', 'review', 'blocked'])

/**
 * Build the compact seed for a fresh session. Pure function of DB state: the same
 * rows always produce the same text (ordering is by id, no timestamps of "now").
 */
export function buildSeededSummary(db: Database, objective: Pick<Objective, 'id'>): string {
  const row = db
    .prepare('SELECT * FROM objectives WHERE id = ?')
    .get(objective.id) as SummaryRow | undefined
  if (!row) return ''

  const children = db
    .prepare('SELECT id, title, status FROM objectives WHERE parent_id = ? AND deleted_at IS NULL ORDER BY id LIMIT ?')
    .all(row.id, MAX_TASK_ROWS) as Array<{ id: number; title: string; status: string }>
  let prs: Array<{ pr_url: string | null; branch_name: string | null; state: string }> = []
  try {
    prs = db
      .prepare('SELECT pr_url, branch_name, state FROM objective_prs WHERE objective_id = ? ORDER BY id')
      .all(row.id) as typeof prs
  } catch {}

  const out: string[] = []
  out.push(`## Card goal\n\n#${row.id} — ${row.title}`)
  if (row.description?.trim()) out.push(`### Description\n\n${clip(row.description)}`)
  if (row.completion_goal?.trim()) out.push(`### Completion goal\n\n${clip(row.completion_goal)}`)

  out.push(`## Current state\n\nStatus: ${row.status}`)

  const todos: string[] = []
  for (const c of children) if (OPEN_TASK_STATUSES.has(c.status)) todos.push(`- child #${c.id} [${c.status}] ${c.title}`)
  if (row.ai_review_verdict && row.ai_review_verdict !== 'pass') {
    todos.push(`- address the last AI review (verdict: ${row.ai_review_verdict}) — findings below`)
  }
  if (row.needs_secret && row.needs_secret !== '[]') {
    try {
      const items = JSON.parse(row.needs_secret) as Array<{ name?: string }>
      for (const s of items) if (s?.name) todos.push(`- waiting on secret ${s.name}`)
    } catch {}
  }
  if (!row.pr_url && prs.length === 0) todos.push('- no PR recorded yet for this card')
  out.push(`## Open TODOs\n\n${todos.length ? todos.join('\n') : '- none recorded in the DB — re-check the branch and your objective memory'}`)

  const git: string[] = []
  if (row.branch_name) git.push(`Branch: ${row.branch_name}`)
  if (row.pr_url) git.push(`PR: ${row.pr_url}`)
  for (const p of prs) {
    if (p.pr_url && p.pr_url === row.pr_url) continue
    git.push(`PR: ${p.pr_url ?? '(no url)'} (${p.state}${p.branch_name ? `, ${p.branch_name}` : ''})`)
  }
  out.push(`## Branch / PR\n\n${git.length ? git.join('\n') : 'none recorded'}`)

  if (row.ai_review_verdict || row.ai_review_findings) {
    out.push(
      `## Last review findings\n\nVerdict: ${row.ai_review_verdict ?? 'n/a'}` +
        (row.ai_review_findings?.trim() ? `\n\n${clip(row.ai_review_findings)}` : ''),
    )
  }
  if (row.last_session_summary?.trim()) out.push(`## Last session summary\n\n${clip(row.last_session_summary)}`)

  if (children.length) {
    out.push(`## Task rows (child cards)\n\n${children.map((c) => `- #${c.id} [${c.status}] ${c.title}`).join('\n')}`)
  }
  return out.join('\n\n')
}

/** Prompt for a fresh, seeded respawn: base prompt + compact seed + the follow-up. */
export function assembleSeededFollowUpPrompt(basePrompt: string, seed: string, message: string, d: ResumeCapDecision): string {
  const why =
    d.trigger === 'tokens'
      ? `its accumulated context reached ${(d.usage.tokens / 1e6).toFixed(1)}M tokens (cap ${(d.config.tokens / 1e6).toFixed(1)}M)`
      : `it had been resumed ${d.usage.rounds} times (cap ${d.config.rounds})`
  return (
    basePrompt +
    '\n\n## Fresh session — prior history capped\n\n' +
    `This card's previous session was NOT resumed because ${why}. You are starting a fresh session. ` +
    'The summary below is built from the card record; the full transcript is not replayed. ' +
    'Re-read your objective memory and the branch state (git log / git status) before continuing.\n\n' +
    '<card_summary>\n' +
    seed +
    '\n</card_summary>' +
    '\n\n## Follow-up Instruction\n\n' +
    message
  )
}

/**
 * Claude/Codex session id recorded AFTER the last chain-reset marker.
 *   undefined → the jsonl has no marker: caller uses its normal lookup.
 *   null      → a marker exists but no init followed it (the fresh process never
 *               got going): there is NOTHING small to resume, so the caller must
 *               not fall back to the old, over-cap conversation id.
 */
export function postResetSessionId(jsonlPath: string): string | null | undefined {
  let content: string
  try {
    content = fs.readFileSync(jsonlPath, 'utf-8')
  } catch {
    return undefined
  }
  const idx = content.lastIndexOf(`"type":"${CHAIN_RESET_EVENT_TYPE}"`)
  if (idx === -1) return undefined
  let found: string | null = null
  for (const line of content.slice(idx).split('\n')) {
    if (!line.includes('"init"') && !line.includes('thread.started')) continue
    try {
      const ev = JSON.parse(line.trim())
      if (ev.type === 'system' && ev.subtype === 'init' && typeof ev.session_id === 'string' && ev.session_id) found = ev.session_id
      else if (ev.type === 'thread.started' && typeof ev.thread_id === 'string' && ev.thread_id) found = ev.thread_id
    } catch {}
  }
  return found
}
