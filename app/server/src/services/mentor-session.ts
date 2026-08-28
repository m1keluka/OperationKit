import { spawn, type ChildProcess } from 'child_process'
import fs from 'fs'
import path from 'path'
import {
  pickAccount,
  recordSessionStart,
  recordSessionEnd,
  recordRateLimit,
  isRateLimitMessage,
  parseResetTime,
} from './account-router.js'
import { getDb } from '../db/index.js'
import { buildSessionContext, callHaikuSummarizer } from './mentor-context.js'
import { getUserWorkspaces } from '../middleware/workspace.js'
import { resolveAssistantConfig } from './assistant-config.js'
import {
  getForUser as getGoogleConnectionForUser,
  writeIsolatedGoogleCredsDir,
  writeEmptyGoogleCredsDir,
} from './user-google-connections.js'
import type { AssistantConfig, AutonomyConfig } from '@command-center/shared'
import { HUMAN_VOICE } from '../lib/human-voice.js'

// Mentor sessions are subprocess-per-thread. They share the same `claude --input-format
// stream-json --output-format stream-json` pattern as board sessions, but:
// - No objective metadata, no tasks, no state poller, no auto-stop.
// - Working dir is /home/operator/ai-workspace/mentor-workspace/. The persona +
//   read/write rules live in CLAUDE.md there. We host the dir under ai-workspace
//   (vs. the original /home/operator/mentor-workspace) because that path is already
//   bind-mounted into the container and ccuser-writable; a top-level
//   /home/operator/mentor-workspace would need a separate mount + host-side mkdir.
// - Account is sticky per thread: once a thread picks an account, it stays there
//   across re-spawns (set on the mentor_threads row).

const MENTOR_WORKDIR = '/home/operator/ai-workspace/mentor-workspace'
const TRANSCRIPT_DIR = '/home/operator/transcripts'
const ACCOUNT_HOME_BASE = '/home/ccuser'

// ── Jarvis profile (objective 341) ─────────────────────────────────────────
// A mentor thread owned by Mike (the admin Telegram owner) is upgraded to the
// "Jarvis profile": persona = /home/operator/ai-workspace/agents/assistant.md,
// google-workspace MCP injected at spawn, §5 confirmation gating active, and
// pending confirmations stored PER THREAD. Non-Mike/member threads keep the
// existing mentor-workspace behavior unchanged.
const ASSISTANT_AGENT_PATH = '/home/operator/ai-workspace/agents/assistant.md'
// Per-thread pending-confirmation + global loop files (override assistant.md's
// hardcoded single loops.md path for pending; loops stay global/shared).
const ASSISTANT_THREADS_DIR = '/home/operator/assistant/threads'
const ASSISTANT_LOOPS_PATH = '/home/operator/assistant/loops.md'

function mentorOwnerUsername(): string {
  return process.env.MENTOR_TELEGRAM_OWNER_USERNAME || 'mike'
}

interface ActiveMentorSession {
  threadId: number
  sessionId: string
  process: ChildProcess
  jsonlPath: string
  logPath: string
  accountId: string
  startedAt: number
  stdin: NodeJS.WritableStream | null
  stopping: boolean
}

const activeSessions = new Map<number, ActiveMentorSession>()

function generateSessionId(threadId: number): string {
  return `mentor-${threadId}-${Date.now()}`
}

function homeDirForAccount(accountId: string): string {
  return `${ACCOUNT_HOME_BASE}-${accountId}`
}

/**
 * Does this thread belong to the admin Telegram owner ("mike")? Only such
 * threads get the Jarvis profile (persona + Google MCP + §5 gating). The owner
 * username is env-overridable (MENTOR_TELEGRAM_OWNER_USERNAME, default "mike").
 *
 * Resolves `created_by` → users.username and compares to the configured owner.
 * Returns false on any miss (legacy NULL created_by, unknown user, db error) so
 * the Jarvis profile is fail-closed — members never get Mike's inbox.
 */
export function isMikeThread(createdBy: number | null): boolean {
  if (!createdBy) return false
  try {
    const row = getDb()
      .prepare('SELECT username FROM users WHERE id = ?')
      .get(createdBy) as { username: string } | undefined
    return !!row && row.username === mentorOwnerUsername()
  } catch (err) {
    console.warn(`[mentor-session] isMikeThread(${createdBy}) lookup failed:`, (err as Error).message)
    return false
  }
}

/**
 * Build a per-session MCP config exposing the canonical `google-workspace`
 * server (Gmail / Calendar / Drive / Docs / Sheets / Slides), ported from
 * example-assistant src/claude-session.ts (~118-145).
 *
 * Per-home ~/.claude/mcp.json files DRIFT (other tooling rewrites them), so we
 * build the config at spawn time: start from the account home's mcp.json if
 * present, ALWAYS delete the stale `google-gmail` / `google-workspace` entries,
 * then inject the canonical full-suite server.
 *
 * If GOOGLE_OAUTH_CLIENT_ID/SECRET are unset we log a LOUD warning (silently
 * omitting Google is a documented trap), but STILL write the entry as long as
 * the shared credential token dir exists — the embedded client creds in the
 * stored token can drive refresh without the .env client.
 *
 * Returns the shape `{ mcpServers }` for JSON.stringify, plus a flag so the
 * caller can decide whether to pass `--mcp-config` at all.
 */
export function buildGoogleMcpConfig(homeDir: string, cfg?: AssistantConfig | null): { mcpServers: Record<string, unknown>; hasGoogle: boolean } {
  let mcpServers: Record<string, unknown> = {}
  const homeMcpPath = path.join(homeDir, '.claude', 'mcp.json')
  try {
    mcpServers = JSON.parse(fs.readFileSync(homeMcpPath, 'utf8')).mcpServers ?? {}
  } catch {
    mcpServers = {}
  }
  delete mcpServers['google-gmail']
  delete mcpServers['google-workspace']

  // Per-user Google identity. Wire Google ONLY when this user enabled the
  // connector AND we can name THEIR account. Never default to mike@ — that is
  // how Ava's Jarvis sent as Mike (shared credential dir + hardcoded identity).
  if (!cfg || !cfg.enabledConnectors.includes('google-workspace')) {
    return { mcpServers, hasGoogle: false }
  }
  let connEmail: string | null = null
  try {
    connEmail = cfg.userId ? (getGoogleConnectionForUser(cfg.userId)?.google_email ?? null) : null
  } catch { /* tests / no DB — fall through to the connector binding */ }
  const googleEmail = connEmail || cfg.connectorBindings?.['google-workspace']?.identity || null
  if (!googleEmail) {
    return { mcpServers, hasGoogle: false }
  }

  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET

  if (!clientId || !clientSecret) {
    console.warn(
      '[mentor-session] GOOGLE_OAUTH_CLIENT_ID/SECRET unset — Jarvis Google Workspace MCP ' +
      'will run on the stored token only (refresh uses the credential-embedded client). ' +
      'Provision these in Doppler to enable new-auth flows.'
    )
  }

  const isolatedDir = cfg.userId ? writeIsolatedGoogleCredsDir(cfg.userId) : null
  const credsDir = isolatedDir || writeEmptyGoogleCredsDir(`mentor-${cfg.userId || 'anon'}`)

  mcpServers['google-workspace'] = {
    command: `${homeDir}/.local/bin/uvx`,
    args: ['workspace-mcp', '--tools', 'gmail', 'calendar', 'drive', 'docs', 'sheets', 'slides', '--tool-tier', 'extended'],
    env: {
      ...(clientId ? { GOOGLE_OAUTH_CLIENT_ID: clientId } : {}),
      ...(clientSecret ? { GOOGLE_OAUTH_CLIENT_SECRET: clientSecret } : {}),
      WORKSPACE_MCP_CREDENTIALS_DIR: credsDir,
      USER_GOOGLE_EMAIL: googleEmail,
    },
  }

  return { mcpServers, hasGoogle: true }
}

/**
 * Write the per-session MCP config to a temp file readable by the ccuser
 * subprocess. Returns the path, or null if there is nothing to inject.
 */
function writeMcpConfigFile(sessionId: string, homeDir: string, cfg?: AssistantConfig | null): string | null {
  const { mcpServers, hasGoogle } = buildGoogleMcpConfig(homeDir, cfg)
  if (!hasGoogle && Object.keys(mcpServers).length === 0) return null
  const mcpTmpFile = path.join('/tmp', `mentor-mcp-${sessionId}.json`)
  try {
    fs.writeFileSync(mcpTmpFile, JSON.stringify({ mcpServers }))
    fs.chmodSync(mcpTmpFile, 0o644)
  } catch (err) {
    console.warn(`[mentor-session] Failed to write MCP config for ${sessionId}:`, (err as Error).message)
    return null
  }
  return mcpTmpFile
}

/**
 * The Jarvis-profile persona + capability + gating directive injected into the
 * initial prompt for Mike-owned threads. Uses absolute /home/operator/... paths
 * (HOME is a ccuser home, so `~` won't resolve to /home/mike).
 *
 * Persona supersedes the mentor-workspace CLAUDE.md / chief-of-staff persona.
 * Pending confirmations are overridden to PER THREAD; loops stay GLOBAL.
 */
export function buildJarvisDirective(threadId: number): string {
  const pendingPath = `${ASSISTANT_THREADS_DIR}/${threadId}/pending.md`
  return [
    'JARVIS PROFILE — this session is Jarvis, Mike\'s personal admin assistant.',
    '',
    `Read ${ASSISTANT_AGENT_PATH} NOW as your complete operating manual. It is your`,
    'persona, capability map, and rules. It SUPERSEDES the mentor-workspace CLAUDE.md',
    'and any chief-of-staff persona — when they conflict, assistant.md wins.',
    '',
    'Capabilities (assistant.md documents these in full):',
    '- Google Workspace (Gmail/Calendar/Drive/Docs/Sheets/Slides) via the',
    '  `google-workspace` MCP server, already wired into this session. Always pass',
    '  user_google_email: "dev@example.com"; never start an OAuth flow.',
    '- The Command Center board internal API at http://localhost:3002/api/internal/...',
    '  (briefing, objectives read, objective create — create is confirmation-gated).',
    '- Vault retrieval over /home/operator/second-brain (active.md → index.md → kb_search).',
    '',
    'CONFIRMATION GATING (assistant.md §5 — hard rule): actions that leave the',
    'machine are two-step. Gated: sending email; calendar create/modify WITH',
    'attendees; POSTing board objectives; Drive share/permission change/delete;',
    'deleting any Google content; anything messaging a human or changing a shared',
    'system. Not gated: reads, Gmail drafts, vault writes, loops, board reads,',
    'Mike-only Docs/Sheets/Slides. Protocol: Propose → Persist the pending action →',
    'Resolve the MOST RECENT pending on an affirmative (then delete it) → Cancel on',
    'a negation. The persisted entry IS the gate state.',
    '',
    'OVERRIDE — pending-confirmation location (supersedes assistant.md\'s single',
    `loops.md path): write/read this thread's pending confirmations at`,
    `${pendingPath} (this directory has been created for you). Open Loops and Closed`,
    `Loops remain GLOBAL/shared across all of Mike's threads in ${ASSISTANT_LOOPS_PATH}.`,
  ].join('\n')
}

/**
 * Render the confirmation-gating block from a per-user autonomy policy (obj
 * 701700). The gated / not-gated ACTION SETS and the two-step protocol are
 * preserved from the legacy §5 rule for `confirm_external` (the owner's level),
 * so the owner's gating behavior is unchanged; the other levels are the generic
 * variants the config now allows. No user-specific identity is baked in here.
 */
export function renderAutonomyPolicy(autonomy: AutonomyConfig): string {
  switch (autonomy.level) {
    case 'read_only':
      return [
        'CONFIRMATION GATING — READ-ONLY: this assistant may not take side-effecting',
        'actions. It can read, retrieve, and draft in-chat only; it must never send,',
        'post, write, delete, or change any external or shared system.',
      ].join('\n')
    case 'confirm_all':
      return [
        'CONFIRMATION GATING — every side-effecting action is two-step confirmed:',
        'sending, posting, writing, deleting, or changing any shared system. Only pure',
        'reads and in-chat drafts run freely. Protocol: Propose → Persist the pending',
        'action → Resolve the MOST RECENT pending on an affirmative (then delete it) →',
        'Cancel on a negation. The persisted entry IS the gate state.',
      ].join('\n')
    case 'autonomous':
      return [
        'CONFIRMATION GATING — AUTONOMOUS: no confirmation step is required. The',
        'assistant may act directly. Use judgment; avoid irreversible actions (deleting',
        'content, mass sends) without clear intent.',
      ].join('\n')
    case 'confirm_external':
    default:
      return [
        'CONFIRMATION GATING (§5 — hard rule): actions that leave the',
        'machine are two-step. Gated: sending email; calendar create/modify WITH',
        'attendees; POSTing board objectives; Drive share/permission change/delete;',
        'deleting any Google content; anything messaging a human or changing a shared',
        'system. Not gated: reads, Gmail drafts, vault writes, loops, board reads,',
        'your own Docs/Sheets/Slides. Protocol: Propose → Persist the pending action →',
        'Resolve the MOST RECENT pending on an affirmative (then delete it) → Cancel on',
        'a negation. The persisted entry IS the gate state.',
      ].join('\n')
  }
}

/**
 * Render the per-thread pending-confirmation location block (obj 701700).
 * Generic infrastructure wording: per-thread pending.md + a GLOBAL/shared loops
 * file. The mechanism and paths are unchanged from the legacy directive.
 */
export function renderPendingLocation(threadId: number): string {
  const pendingPath = `${ASSISTANT_THREADS_DIR}/${threadId}/pending.md`
  return [
    'OVERRIDE — pending-confirmation location: write/read this thread\'s pending',
    `confirmations at ${pendingPath} (this directory has been created for you).`,
    `Open Loops and Closed Loops remain GLOBAL/shared across your threads in ${ASSISTANT_LOOPS_PATH}.`,
  ].join('\n')
}

/**
 * Config-driven persona + gating + pending directive (obj 701700). This is the
 * generic replacement for buildJarvisDirective: name/tagline/manual come from
 * `cfg.persona` (DATA), the gating block from `cfg.autonomy` (policy), and the
 * pending location from the thread. Nothing here is user-specific — the owner's
 * seeded config reproduces today's Jarvis directive's rule-bearing content
 * (persona name, assistant.md pointer, gated-action set, email, paths).
 *
 * The block layout matches buildInitialPrompt's <persona> wrapper: a header
 * line, then the persona systemPrompt, then the gating policy, then the pending
 * location, separated by blank lines.
 */
export function buildAssistantDirective(cfg: AssistantConfig, threadId: number): string {
  const name = cfg.persona.displayName
  const header = `${name.toUpperCase()} PROFILE — this session is ${name}${
    cfg.persona.tagline ? `, ${cfg.persona.tagline}` : ''
  }.`
  const blocks = [
    header,
    cfg.persona.systemPrompt,
    HUMAN_VOICE,
    renderAutonomyPolicy(cfg.autonomy),
    renderPendingLocation(threadId),
  ]
  return blocks.filter(b => b && b.trim()).join('\n\n')
}

/**
 * Ensure the per-thread pending-confirmation directory exists AND is writable by
 * the ccuser that the mentor session runs as. The server runs as root, so a
 * plain mkdir leaves a root-owned 0755 dir the ccuser session cannot write its
 * pending.md into (breaks confirmation-gating persistence). chmod 0777 the leaf
 * + the threads parent so the ccuser spawn can write the gate state.
 */
function ensureThreadPendingDir(threadId: number): void {
  const dir = `${ASSISTANT_THREADS_DIR}/${threadId}`
  try {
    fs.mkdirSync(dir, { recursive: true })
    // mkdir mode is masked by umask; force the bits explicitly.
    try { fs.chmodSync(ASSISTANT_THREADS_DIR, 0o777) } catch {}
    fs.chmodSync(dir, 0o777)
  } catch (err) {
    console.warn(`[mentor-session] Failed to create/chmod pending dir for thread ${threadId}:`, (err as Error).message)
  }
}

/**
 * Resolve which account this thread should run on.
 *  - If the thread already has account_id set AND that account is currently
 *    available, reuse it (sticky).
 *  - Otherwise pick the best available via the router and persist the choice.
 *  - Returns null if no account is available right now.
 */
function resolveAccount(threadId: number, persistedAccountId: string | null): { id: string; homeDir: string } | null {
  if (persistedAccountId) {
    const homeDir = homeDirForAccount(persistedAccountId)
    // Cheap availability check: only verify the home dir + creds exist. Rate-limit
    // recovery happens on the next router-side `pickAccount`, not here — stickiness
    // outranks load-balancing for mentor threads.
    if (fs.existsSync(path.join(homeDir, '.claude', '.credentials.json'))) {
      return { id: persistedAccountId, homeDir }
    }
    console.warn(`[mentor-session] Thread ${threadId} sticky account ${persistedAccountId} unavailable; falling back to router`)
  }

  const account = pickAccount()
  if (!account) return null
  return { id: account.id, homeDir: account.homeDir }
}

function persistAccountId(threadId: number, accountId: string): void {
  getDb()
    .prepare('UPDATE mentor_threads SET account_id = ? WHERE id = ?')
    .run(accountId, threadId)
}

interface MentorIdentity {
  username: string
  role: 'admin' | 'member'
  userWorkspaces: string[]
  profilePathAbs: string | null
  workspaceSlug: string
  workspaceContextPathAbs: string | null
  agentOverlayPathAbs: string | null
}

/**
 * Resolve the human + workspace this thread runs on behalf of. Mirrors the
 * board-session pattern in session-manager.ts so mentor threads pick up the
 * same user-profile + workspace-overlay injections.
 *
 * Returns null when created_by is unset (legacy rows pre-multi-user).
 *
 * File paths are checked for existence here so the prompt only references
 * files that actually exist on disk — overlays are opt-in by the operator.
 */
function resolveMentorIdentity(threadId: number, workspaceSlug: string, createdBy: number | null): MentorIdentity | null {
  if (!createdBy) return null
  try {
    const db = getDb()
    const row = db
      .prepare("SELECT username, role FROM users WHERE id = ?")
      .get(createdBy) as { username: string; role: 'admin' | 'member' } | undefined
    if (!row) return null
    const wsRows = db
      .prepare("SELECT workspace FROM user_workspaces WHERE user_id = ?")
      .all(createdBy) as { workspace: string }[]
    const profileAbs = `/home/operator/ai-workspace/users/${row.username}/profile.md`
    const wsContextAbs = `/home/operator/ai-workspace/workspaces/${workspaceSlug}/context.md`
    const overlayAbs = `/home/operator/ai-workspace/workspaces/${workspaceSlug}/agent-profiles/chief-of-staff.md`
    return {
      username: row.username,
      role: row.role,
      userWorkspaces: wsRows.map(r => r.workspace),
      profilePathAbs: fs.existsSync(profileAbs) ? profileAbs : null,
      workspaceSlug,
      workspaceContextPathAbs: fs.existsSync(wsContextAbs) ? wsContextAbs : null,
      agentOverlayPathAbs: fs.existsSync(overlayAbs) ? overlayAbs : null,
    }
  } catch (err) {
    console.warn(`[mentor-session] resolveMentorIdentity(thread=${threadId}, user=${createdBy}) failed:`, (err as Error).message)
    return null
  }
}

function buildIdentityBlock(identity: MentorIdentity | null): string {
  if (!identity) return ''
  const lines: string[] = []
  lines.push(`User: you are talking with ${identity.username} (${identity.role}, workspaces: ${identity.userWorkspaces.join(', ') || 'none'}).`)
  if (identity.profilePathAbs) {
    lines.push(`Read ${identity.profilePathAbs} for this user's preferences (tone, defaults, areas owned, escalation rules).`)
  }
  lines.push('')
  lines.push(`Workspace: ${identity.workspaceSlug}`)
  if (identity.workspaceContextPathAbs) {
    lines.push(`Read ${identity.workspaceContextPathAbs} for business context.`)
  }
  if (identity.agentOverlayPathAbs) {
    lines.push(`Read ${identity.agentOverlayPathAbs} for ${identity.workspaceSlug}-specific overlay on Jarvis (priorities, conventions, integrations).`)
  }
  return lines.join('\n')
}

function persistSessionStart(threadId: number, sessionId: string): void {
  getDb()
    .prepare("UPDATE mentor_threads SET session_id = ?, last_active_at = datetime('now'), updated_at = datetime('now'), last_message_role = 'user' WHERE id = ?")
    .run(sessionId, threadId)
}

function persistSessionEnd(threadId: number): void {
  getDb()
    .prepare("UPDATE mentor_threads SET session_id = NULL, last_active_at = datetime('now'), last_message_role = 'assistant' WHERE id = ?")
    .run(threadId)
}

const MAX_HISTORY_CHARS = 14000
const COMPACTION_THRESHOLD = 30
const COMPACTION_TAIL_TURNS = 15

type ConversationTurn = { role: 'user' | 'assistant'; text: string }

function extractMentorTurns(threadId: number): ConversationTurn[] {
  try {
    const files = fs.readdirSync(TRANSCRIPT_DIR)
      .filter(f => f.startsWith(`mentor-${threadId}-`) && f.endsWith('.jsonl'))
      .sort()
    const turns: ConversationTurn[] = []
    for (const file of files) {
      const content = fs.readFileSync(path.join(TRANSCRIPT_DIR, file), 'utf-8')
      for (const line of content.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
          const event = JSON.parse(trimmed)
          if ((event.type === 'prompt' || event.type === 'followup') && event.text) {
            turns.push({ role: 'user', text: event.text })
          } else if (event.type === 'assistant' && event.message?.content) {
            const text = (event.message.content as Array<{ type: string; text?: string }>)
              .filter(b => b.type === 'text' && b.text)
              .map(b => b.text!)
              .join('')
            if (text) turns.push({ role: 'assistant', text })
          }
        } catch {}
      }
    }
    return turns
  } catch {
    return []
  }
}

function formatMentorTurns(turns: ConversationTurn[]): string {
  return turns.map(t => (t.role === 'user' ? `[Mike]: ${t.text}` : `[Jarvis]: ${t.text}`)).join('\n\n')
}

function buildConversationHistory(threadId: number): string {
  const turns = extractMentorTurns(threadId)
  if (turns.length === 0) return ''

  if (turns.length >= COMPACTION_THRESHOLD) {
    try {
      const row = getDb()
        .prepare('SELECT content FROM mentor_summaries WHERE thread_id = ? ORDER BY updated_at DESC LIMIT 1')
        .get(threadId) as { content: string } | undefined
      if (row?.content) {
        const tail = turns.slice(-COMPACTION_TAIL_TURNS)
        const tailText = formatMentorTurns(tail)
        const summarizedCount = turns.length - COMPACTION_TAIL_TURNS
        return `[Conversation summary — ${summarizedCount} earlier turns]\n${row.content}\n\n[Recent conversation]\n${tailText}`
      }
    } catch {}
    // No summary yet — fall back to tail-truncation until the next session end generates one
  }

  let history = formatMentorTurns(turns)
  if (history.length > MAX_HISTORY_CHARS) {
    history = '…[earlier conversation truncated]\n\n' + history.slice(history.length - MAX_HISTORY_CHARS)
  }
  return history
}

async function refreshMentorSummary(threadId: number): Promise<void> {
  const turns = extractMentorTurns(threadId)
  if (turns.length < COMPACTION_THRESHOLD) return

  const turnsToSummarize = turns.slice(0, turns.length - COMPACTION_TAIL_TURNS)
  const conversationText = formatMentorTurns(turnsToSummarize)

  const prompt = `You are summarizing a conversation between Mike and Jarvis (an AI assistant) for context injection into future sessions.

Produce a 300-500 word summary covering:
- Key decisions made
- Topics discussed
- Open questions or pending items
- Preferences or patterns established
- Important context for continuing the conversation

Write in third person (e.g. "Mike asked about X", "Jarvis suggested Y"). Be factual and dense — this summary replaces the full early conversation.

Conversation to summarize:
${conversationText}`

  const summary = await callHaikuSummarizer(prompt)
  if (!summary) return

  try {
    const db = getDb()
    const existing = db
      .prepare('SELECT id FROM mentor_summaries WHERE thread_id = ?')
      .get(threadId) as { id: number } | undefined
    if (existing) {
      db.prepare("UPDATE mentor_summaries SET content = ?, updated_at = datetime('now') WHERE thread_id = ?")
        .run(summary, threadId)
    } else {
      db.prepare('INSERT INTO mentor_summaries (thread_id, content) VALUES (?, ?)').run(threadId, summary)
    }
    console.log(`[mentor-session] Compaction summary refreshed for thread ${threadId} (${turns.length} turns)`)
  } catch (err) {
    console.warn(`[mentor-session] Failed to store compaction summary for thread ${threadId}:`, err)
  }
}

function buildInitialPrompt(firstMessage: string, identityBlock: string, sessionContext: string, priorHistory: string, jarvisDirective = ''): string {
  let result = ''
  // Persona directive goes FIRST so it frames everything that follows. For
  // Mike-owned (Jarvis) threads this supersedes the mentor-workspace CLAUDE.md.
  if (jarvisDirective.trim()) result += `<persona>\n${jarvisDirective}\n</persona>\n\n`
  if (identityBlock.trim()) result += `<identity>\n${identityBlock}\n</identity>\n\n`
  if (sessionContext.trim()) result += `<session_context>\n${sessionContext}\n</session_context>\n\n`
  if (priorHistory.trim()) result += `<prior_conversation>\n${priorHistory}\n</prior_conversation>\n\n`
  return result + firstMessage
}

function checkStreamForRateLimit(data: Buffer, accountId: string): void {
  const text = data.toString()
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const event = JSON.parse(trimmed)
      if (event.type === 'rate_limit_event' || event.type === 'rate_limit') {
        const info = event.rate_limit_info || event
        if (info.status && String(info.status).startsWith('allowed')) continue
        const resetTime = info.resetsAt ? new Date(info.resetsAt * 1000) : (event.reset_at ? new Date(event.reset_at) : undefined)
        recordRateLimit(accountId, resetTime, JSON.stringify(event).slice(0, 500))
        return
      }
      if (event.type === 'error' || (event.type === 'result' && event.subtype === 'error')) {
        const errorText = event.error || event.result || event.text || ''
        if (isRateLimitMessage(errorText)) {
          const resetTime = parseResetTime(errorText)
          recordRateLimit(accountId, resetTime || undefined, errorText)
        }
      }
    } catch {}
  }
}

/** Exported for tests. Quotes interpolations and unsets provider API keys so
 *  mentor/Jarvis uses the account OAuth token instead of the server's
 *  ANTHROPIC_API_KEY (same contract as the board tmux wrapper). */
export function buildMentorBashCommand(homeDir: string, mcpConfigPath: string | null): string {
  const mcpFlag = mcpConfigPath ? ` --mcp-config ${JSON.stringify(mcpConfigPath)}` : ''
  return [
    'unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN OPENAI_API_KEY GEMINI_API_KEY GOOGLE_API_KEY',
    `export HOME=${JSON.stringify(homeDir)}`,
    `cd ${JSON.stringify(MENTOR_WORKDIR)} || exit 1`,
    `claude --print --input-format stream-json --output-format stream-json --include-partial-messages --verbose --dangerously-skip-permissions --max-budget-usd 25${mcpFlag}`,
  ].join('\n')
}

function spawnMentorProcess(threadId: number, accountId: string, homeDir: string, jsonlPath: string, logPath: string, mcpConfigPath: string | null): ChildProcess {
  // Base spawn is unchanged for non-Jarvis threads. Jarvis (Mike) threads add
  // `--mcp-config <tmpfile>` so the google-workspace server is available.
  const proc = spawn('runuser', ['-u', 'ccuser', '--', 'bash', '-c',
    buildMentorBashCommand(homeDir, mcpConfigPath),
  ], {
    env: {
      ...process.env,
      HOME: homeDir,
      USER: 'ccuser',
      TERM: 'dumb',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  proc.stdout?.on('data', (data: Buffer) => {
    const text = data.toString()
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      fs.appendFileSync(jsonlPath, trimmed + '\n')
    }
    checkStreamForRateLimit(data, accountId)
  })

  proc.stderr?.on('data', (data: Buffer) => {
    const text = data.toString()
    fs.appendFileSync(logPath, `[stderr] ${text}\n`)

    // Suppress stderr noise emitted by SIGTERM/shell teardown — those show up
    // as red error boxes in the UI even though the user explicitly stopped.
    const session = activeSessions.get(threadId)
    if (!session?.stopping) {
      const errorEvent = JSON.stringify({ type: 'error', text: text.trim(), timestamp: new Date().toISOString() })
      fs.appendFileSync(jsonlPath, errorEvent + '\n')
    }

    if (isRateLimitMessage(text)) {
      const resetTime = parseResetTime(text)
      recordRateLimit(accountId, resetTime || undefined, text.trim())
    }
  })

  return proc
}

/**
 * Start a mentor session for a thread. Idempotent — if the thread already has
 * an active process, returns its session id without spawning a new one.
 *
 * `firstMessage` is the user's first turn for the thread. For brand-new threads
 * it becomes the initial prompt sent over stdin.
 */
export function startMentorSession(threadId: number, firstMessage: string): string {
  const existing = activeSessions.get(threadId)
  if (existing && !existing.process.killed) {
    // Already running — caller should use sendMentorMessage instead. Fall through
    // to send the message anyway so the caller doesn't need to branch.
    sendMentorMessage(threadId, firstMessage)
    return existing.sessionId
  }

  const row = getDb()
    .prepare('SELECT account_id, workspace, created_by FROM mentor_threads WHERE id = ?')
    .get(threadId) as { account_id: string | null; workspace: string | null; created_by: number | null } | undefined
  if (!row) throw new Error(`mentor thread ${threadId} not found`)

  const account = resolveAccount(threadId, row.account_id)
  if (!account) throw new Error('All Claude accounts are exhausted. Try again later.')

  const sessionId = generateSessionId(threadId)
  const jsonlPath = path.join(TRANSCRIPT_DIR, `${sessionId}.jsonl`)
  const logPath = path.join(TRANSCRIPT_DIR, `${sessionId}.log`)
  fs.mkdirSync(TRANSCRIPT_DIR, { recursive: true })

  // Load prior history BEFORE creating the new JSONL so the disk scan doesn't
  // find the new file and double-count the current message.
  let priorHistory = ''
  try {
    priorHistory = buildConversationHistory(threadId)
  } catch (err) {
    console.warn(`[mentor-session] Failed to load prior conversation history: ${err instanceof Error ? err.message : err}`)
  }

  fs.writeFileSync(logPath, `=== Mentor session ${sessionId} ===\nThread: ${threadId}\nStarted: ${new Date().toISOString()}\nAccount: ${account.id}\n${'='.repeat(50)}\n\n`)

  // First event: a `prompt` marker so the UI shows what kicked the session off.
  const promptEvent = JSON.stringify({ type: 'prompt', text: firstMessage, title: 'Mentor thread', timestamp: new Date().toISOString() })
  fs.writeFileSync(jsonlPath, promptEvent + '\n')

  recordSessionStart(account.id, sessionId)
  persistAccountId(threadId, account.id)

  // Assistant profile: threads whose creator has an enabled per-user config get
  // that config's connectors (e.g. google-workspace MCP) injected at spawn.
  // Build the per-session MCP config from the account home's mcp.json, then wire
  // the user's enabled connectors.
  // obj 701700: resolve the thread creator's per-user assistant config instead
  // of the single-tenant isMikeThread() gate. The assistant profile (persona +
  // MCP + gating) applies whenever the user has an ENABLED config. Legacy
  // threads with no creator resolve null → bare mentor behavior (fail-closed,
  // exactly like the old isMike === false path). The owner's seeded config
  // reproduces today's Jarvis behavior through this generic path.
  const assistantCfg = resolveAssistantConfig(row.created_by, row.workspace || 'example')
  const hasAssistant = !!assistantCfg && assistantCfg.enabled
  let mcpConfigPath: string | null = null
  if (hasAssistant) {
    ensureThreadPendingDir(threadId)
    mcpConfigPath = writeMcpConfigFile(sessionId, account.homeDir, assistantCfg)
  }

  const proc = spawnMentorProcess(threadId, account.id, account.homeDir, jsonlPath, logPath, mcpConfigPath)

  proc.on('exit', (code) => {
    fs.appendFileSync(logPath, `\n${'='.repeat(50)}\nSession ended with code ${code} at ${new Date().toISOString()}\n`)
    if (mcpConfigPath) { try { fs.unlinkSync(mcpConfigPath) } catch {} }
    recordSessionEnd(account.id, sessionId, 0, 0)
    activeSessions.delete(threadId)
    persistSessionEnd(threadId)
    refreshMentorSummary(threadId).catch(err =>
      console.warn(`[mentor-session] Compaction refresh failed for thread ${threadId}:`, err)
    )
  })

  const session: ActiveMentorSession = {
    threadId,
    sessionId,
    process: proc,
    jsonlPath,
    logPath,
    accountId: account.id,
    startedAt: Date.now(),
    stdin: proc.stdin || null,
    stopping: false,
  }
  activeSessions.set(threadId, session)
  persistSessionStart(threadId, sessionId)

  // Resolve the human + workspace this thread belongs to. Injects the same
  // identity + workspace overlay block that board sessions get (Phase 1/3).
  const identity = resolveMentorIdentity(threadId, row.workspace || 'example', row.created_by)
  const identityBlock = buildIdentityBlock(identity)

  // Phase 6: scope vault context to the thread owner's workspace memberships.
  // Admin sees everything (null); members only see their workspaces. Falls
  // back to scoping by the thread's workspace if created_by is NULL (legacy
  // threads pre-multi-user — better than admin-everything).
  let allowedWorkspaces: string[] | null = null
  if (row.created_by) {
    try {
      const userRow = getDb()
        .prepare("SELECT role FROM users WHERE id = ?")
        .get(row.created_by) as { role: 'admin' | 'member' } | undefined
      if (userRow?.role !== 'admin') {
        allowedWorkspaces = getUserWorkspaces(row.created_by).map(m => m.workspace)
      }
    } catch (err) {
      console.warn(`[mentor-session] Failed to resolve memberships for thread ${threadId}: ${err instanceof Error ? err.message : err}`)
      allowedWorkspaces = [row.workspace || 'example']
    }
  } else {
    allowedWorkspaces = [row.workspace || 'example']
  }

  // Build a fresh state snapshot for this subprocess. Failure to read any
  // input file is non-fatal — the mentor can still grep on demand.
  let sessionContext = ''
  try {
    sessionContext = buildSessionContext({ allowedWorkspaces })
  } catch (err) {
    console.warn(`[mentor-session] Failed to build session context: ${err instanceof Error ? err.message : err}`)
  }

  // Send the initial message via stdin. Threads whose creator has an enabled
  // assistant config get their persona/gating/pending directive prepended
  // (web-tab AND bridge-created), built from that config.
  const jarvisDirective = hasAssistant && assistantCfg ? buildAssistantDirective(assistantCfg, threadId) : ''
  const stdinMessage = JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: buildInitialPrompt(firstMessage, identityBlock, sessionContext, priorHistory, jarvisDirective) }] },
  }) + '\n'
  proc.stdin?.write(stdinMessage)

  console.log(`[mentor-session] Started thread ${threadId} as ${sessionId} on account ${account.id}`)
  return sessionId
}

/**
 * Send a follow-up to an active mentor session. If the process is dead (or
 * was never started), this transparently calls startMentorSession with the
 * message as the first turn — meaning the caller can just call
 * sendMentorMessage and it Just Works.
 */
export function sendMentorMessage(threadId: number, message: string): string {
  const session = activeSessions.get(threadId)

  if (session && session.process && !session.process.killed && session.stdin) {
    try {
      process.kill(session.process.pid!, 0)
      const followupEvent = JSON.stringify({ type: 'followup', text: message, timestamp: new Date().toISOString() })
      fs.appendFileSync(session.jsonlPath, followupEvent + '\n')
      const stdinMessage = JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: message }] },
      }) + '\n'
      session.stdin.write(stdinMessage)
      getDb()
        .prepare("UPDATE mentor_threads SET last_active_at = datetime('now'), updated_at = datetime('now'), last_message_role = 'user' WHERE id = ?")
        .run(threadId)
      return session.sessionId
    } catch {
      // Process died — fall through and respawn.
      console.log(`[mentor-session] Process dead for thread ${threadId}; respawning`)
      activeSessions.delete(threadId)
    }
  }

  // No live process — start a fresh session with the message as the first turn.
  // The new session ID will be different; the prior JSONL stays on disk and is
  // still readable, but the active log path moves.
  return startMentorSession(threadId, message)
}

export function stopMentorSession(threadId: number): void {
  const session = activeSessions.get(threadId)
  if (!session) {
    persistSessionEnd(threadId)
    return
  }
  session.stopping = true
  try { (session.stdin as NodeJS.WritableStream & { end?: () => void } | null)?.end?.() } catch {}
  try { session.process.kill('SIGTERM') } catch {}
  setTimeout(() => {
    try { session.process.kill('SIGKILL') } catch {}
  }, 3000)
  recordSessionEnd(session.accountId, session.sessionId, 0, 0)
  activeSessions.delete(threadId)
  persistSessionEnd(threadId)
}

export function getMentorSessionState(threadId: number): 'idle' | 'working' | 'review' {
  const session = activeSessions.get(threadId)
  if (!session) return 'idle'
  try {
    process.kill(session.process.pid!, 0)
  } catch {
    activeSessions.delete(threadId)
    return 'idle'
  }
  // Same trick as objective sessions: walk the JSONL backwards looking for a
  // result event. If anything came after the last result, a new turn is in flight.
  try {
    const content = fs.readFileSync(session.jsonlPath, 'utf-8')
    const lines = content.trim().split('\n')
    let lastResultIndex = -1
    let lastEventIndex = -1
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim()
      if (!trimmed) continue
      try {
        const event = JSON.parse(trimmed)
        if (event.type === 'result') lastResultIndex = i
        if (event.type) lastEventIndex = i
      } catch {}
    }
    if (lastResultIndex >= 0 && lastResultIndex >= lastEventIndex) return 'review'
    if (lastResultIndex >= 0 && lastEventIndex > lastResultIndex) return 'working'
  } catch {}
  return 'working'
}

/**
 * Resolve which JSONL log to read for a thread's transcript:
 * - If a session is currently active, use its live log path.
 * - Otherwise fall back to the most recent transcript on disk for this thread.
 * Returns null if the thread has never been run.
 */
export function getMentorJsonlPath(threadId: number): string | null {
  const session = activeSessions.get(threadId)
  if (session) return session.jsonlPath

  const row = getDb()
    .prepare('SELECT session_id FROM mentor_threads WHERE id = ?')
    .get(threadId) as { session_id: string | null } | undefined
  if (!row?.session_id) {
    // Look on disk for the most recent transcript matching this thread.
    try {
      const files = fs.readdirSync(TRANSCRIPT_DIR)
        .filter(f => f.startsWith(`mentor-${threadId}-`) && f.endsWith('.jsonl'))
        .sort()
      if (files.length === 0) return null
      return path.join(TRANSCRIPT_DIR, files[files.length - 1])
    } catch {
      return null
    }
  }
  return path.join(TRANSCRIPT_DIR, `${row.session_id}.jsonl`)
}

export function isMentorSessionActive(threadId: number): boolean {
  const session = activeSessions.get(threadId)
  if (!session) return false
  try {
    process.kill(session.process.pid!, 0)
    return true
  } catch {
    activeSessions.delete(threadId)
    return false
  }
}
