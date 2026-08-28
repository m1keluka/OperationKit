/**
 * Follow-up and reopen — extracted from session-manager.ts (behavior frozen).
 * sendFollowUp respawns via tmux (--resume when possible). reopenObjective
 * resumes a done objective's last thread. Shared spawn helpers stay in the facade.
 *
 * Imports startSession / ensureUser / etc. from the facade. Circular ESM is
 * runtime-safe: these functions run after module init (same pattern as session-death).
 */
import fs from 'fs'
import path from 'path'
import type { Objective } from '@command-center/shared'
import { getDb } from '../db/index.js'
import {
  pickAccount,
  recordSessionStart,
  enqueueSession,
  getAccountForSession,
  getRouterStatus,
} from './account-router.js'
import { TRANSCRIPT_DIR } from '../config.js'
import { assembleFlattenedFollowUpPrompt, buildPrompt, resolveWorkdir, buildObjectiveHistory } from './prompt-builder.js'
import { acquireBranchLease } from './branch-lease.js'
import { acquireSessionLeasesForSpawn } from './session-lease.js'
import { deriveBranchName, deriveWorktreeBranchName } from './branch-scope.js'
import { spawnInTmux } from './session-tmux.js'
import { extractClaudeSessionId } from './session-jsonl.js'
import { getModelEngine } from './model-registry.js'
import { buildSpawnEnv } from './session-spawn-env.js'
import { codexAuthAvailable, CODEX_ACCOUNT_ID, CODEX_HOME_DIR, grokAuthAvailable, GROK_ACCOUNT_ID, GROK_HOME_DIR } from './session-spawn-command.js'
import { buildPlannerPrompt } from './session-planner-prompt.js'
import {
  type ActiveSession,
  activeSessions,
  registerActiveSession,
} from './session-registry.js'
import {
  computeIsolation,
  ensureWorktree,
  ensureWorktreeHookAssets,
} from './session-worktree.js'
import {
  startSession,
  ensureUser,
  ensureObjectiveMemoryDir,
  reapPredecessorSessions,
  emitSessionLeaseConflictWarning,
  BranchLeaseConflictError,
  SessionLeaseConflictError,
} from './session-manager.js'

function transcriptCwd(jsonlPath: string): string | null {
  try {
    const content = fs.readFileSync(jsonlPath, 'utf-8')
    for (const line of content.split('\n')) {
      if (!line.includes('"cwd"')) continue
      try {
        const cwd = (JSON.parse(line) as { cwd?: unknown }).cwd
        if (typeof cwd === 'string' && cwd) return cwd
      } catch {}
    }
  } catch {}
  return null
}

/**
 * Check whether a resumable Claude CLI conversation exists for `workdir`.
 *
 * Two failure modes this guards against, both of which make `claude --resume`
 * die with "No conversation found" and kill the session in ~0ms:
 *
 *  1. A spawn that 429s immediately still emits a system/init event with a
 *     fresh session_id, but the CLI never persists that conversation — so the
 *     transcript file doesn't exist anywhere.
 *
 *  2. `claude --resume` is **cwd-scoped**: it only finds a session when the CLI
 *     is launched from the same cwd the transcript was recorded under (the
 *     transcript lives in ~/.claude/projects/<encoded-cwd>/). A follow-up whose
 *     resolved workdir has drifted from the cwd of the original run (e.g. the
 *     objective's project subdir was created mid-rebuild, so resolveWorkdir now
 *     returns a deeper path than earlier sessions used) would resume from the
 *     wrong project dir and fail — even though the transcript exists under a
 *     *different* project dir. Matching on the recorded cwd (encoder-agnostic)
 *     mirrors the CLI's lookup exactly.
 *
 * Either miss routes the follow-up to the history-flattening respawn path,
 * which re-establishes context from objective history in the correct workdir.
 */
function claudeConversationExists(homeDir: string, claudeSessionId: string, workdir: string): boolean {
  try {
    const projectsDir = path.join(homeDir, '.claude', 'projects')
    for (const dir of fs.readdirSync(projectsDir)) {
      const file = path.join(projectsDir, dir, `${claudeSessionId}.jsonl`)
      if (!fs.existsSync(file)) continue
      // Resume is cwd-scoped — the transcript must belong to the workdir we'll
      // launch from, or `--resume` won't see it. If the transcript records no
      // cwd, stay conservative and fall back rather than risk a hard failure.
      if (transcriptCwd(file) === workdir) return true
    }
  } catch {}
  return false
}

/** Persist a follow-up into the session jsonl so the thread can show it immediately. */
export function recordFollowUpInJsonl(sessionId: string, message: string, jsonlPath?: string): void {
  const file = jsonlPath || path.join(TRANSCRIPT_DIR, `${sessionId}.jsonl`)
  const followupEvent = JSON.stringify({ type: 'followup', text: message, timestamp: new Date().toISOString() })
  fs.appendFileSync(file, followupEvent + '\n')
  try { fs.chmodSync(file, 0o666) } catch {}
}

export function sendFollowUp(
  sessionId: string,
  message: string,
  objective: Objective,
  opts?: { skipJsonl?: boolean },
): string {
  const session = activeSessions.get(sessionId)

  // If the process is still alive and has stdin, send via bidirectional stream-json
  if (session?.stdin && session.process && !session.process.killed) {
    try {
      // Check if process is actually alive
      process.kill(session.process.pid!, 0)

      // Log the follow-up
      fs.appendFileSync(session.logPath, `\n\n--- Follow-up (via stdin): ${message.slice(0, 200)} ---\n\n`)
      if (!opts?.skipJsonl) recordFollowUpInJsonl(sessionId, message, session.jsonlPath)

      // Send via stdin — same process, same context, true multi-turn
      const stdinMessage = JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: message }] },
      }) + '\n'
      session.stdin.write(stdinMessage)

      console.log(`[session-manager] Follow-up sent via stdin to session ${sessionId}`)
      return sessionId
    } catch {
      // Process died — fall through to spawn new one
      console.log(`[session-manager] Process dead for ${sessionId}, spawning new session`)
    }
  }

  // Process is dead — start a fresh session with the follow-up as the prompt.
  // Planner sessions (cc-plan-*) MUST re-spawn with the planner prompt, NOT the
  // executor prompt — otherwise clicking Approve on a terminated planner would
  // silently spawn an executor in the planner's slot and start writing code.
  const logPath = session?.logPath || path.join(TRANSCRIPT_DIR, `${sessionId}.log`)
  const jsonlPath = session?.jsonlPath || path.join(TRANSCRIPT_DIR, `${sessionId}.jsonl`)
  const isPlannerSession = sessionId.startsWith('cc-plan-')

  // ── Native resume lookup ──
  // Prefer `claude --resume <claude_session_id>` over rebuilding context from
  // flattened objective history. The CLI transcript lives in the owning
  // account's HOME, so resume must be pinned to that account; when it's
  // unavailable (or no claude_session_id was ever captured) we fall back to
  // the legacy history-flattening respawn below.
  const engine = getModelEngine(objective.model)
  const isCodex = engine === 'codex'
  const isGrok = engine === 'grok'
  let runtimeRow: { claude_session_id: string | null; account_id: string | null } | undefined
  try {
    runtimeRow = getDb()
      .prepare('SELECT claude_session_id, account_id FROM session_runtime WHERE session_id = ?')
      .get(sessionId) as { claude_session_id: string | null; account_id: string | null } | undefined
  } catch {}
  // For codex sessions this resolves the thread_id (from `thread.started`).
  const claudeSessionId = runtimeRow?.claude_session_id || extractClaudeSessionId(jsonlPath)
  // Resolved up front: the resume guard needs it to confirm the transcript
  // belongs to the cwd we'll actually launch from (claude --resume is
  // cwd-scoped). Also reused as the spawn workdir below.
  // obj 1059 — for isolated sessions the original turn ran INSIDE the worktree,
  // so the resume MUST relaunch from that same worktree (else --resume can't find
  // the cwd-scoped transcript). ensureWorktree is idempotent → reuses it.
  const followUpIsolation = computeIsolation(objective, sessionId)
  let workdir = resolveWorkdir(objective)
  let hookSettingsPath: string | undefined
  let worktreeRoot: string | undefined
  if (followUpIsolation) {
    const wtBranch = deriveWorktreeBranchName(objective)
    const wtPath = wtBranch ? ensureWorktree(objective, wtBranch) : null
    if (wtPath) {
      workdir = wtPath
      worktreeRoot = wtPath
      hookSettingsPath = ensureWorktreeHookAssets()
    } else {
      // obj 1451 — fail closed (see startSession). Never relaunch a follow-up
      // unguarded in the live checkout when isolation was required.
      throw new Error(
        `[session-manager] Follow-up ${sessionId} (objective ${objective.id}): worktree isolation REQUIRED (project "${objective.project}") but ensureWorktree failed for "${followUpIsolation.projectDir}" (branch "${wtBranch || '(none)'}"). Refusing to relaunch UNGUARDED in the live checkout — fail-closed (obj 1451).`,
      )
    }
  }

  fs.appendFileSync(logPath, `\n\n--- Follow-up (new process): ${message.slice(0, 200)} ---\n\n`)
  if (!opts?.skipJsonl) recordFollowUpInJsonl(sessionId, message, jsonlPath)
  try { fs.chmodSync(logPath, 0o666) } catch {}

  // Pick account — try to reuse existing, but rotate if it's rate-limited.
  // Codex sessions are pinned to the dedicated codex home and never rotate.
  const existingAccount = session?.accountId ? getAccountForSession(sessionId) : null
  let accountId = isGrok ? GROK_ACCOUNT_ID : isCodex ? CODEX_ACCOUNT_ID : (existingAccount?.id || session?.accountId || null)
  let homeDir = isGrok ? GROK_HOME_DIR : isCodex ? CODEX_HOME_DIR : (existingAccount?.homeDir || '/home/ccuser-a')

  // Resume pinning: the claude transcript only exists in the original
  // account's HOME, so resume requires that exact account to be available.
  let resumeSessionId: string | undefined
  if (claudeSessionId && isGrok) {
    if (grokAuthAvailable()) {
      resumeSessionId = claudeSessionId
      console.log(`[session-manager] Follow-up ${sessionId} resuming grok session ${claudeSessionId}`)
    } else {
      console.log(`[session-manager] Follow-up ${sessionId}: grok auth missing — falling back to history-flattening respawn`)
    }
  } else if (claudeSessionId && isCodex) {
    // Codex isn't in the account router — no pinning/availability check needed.
    // The thread transcript lives in the dedicated codex HOME, which is always
    // the spawn target for codex sessions.
    if (codexAuthAvailable()) {
      resumeSessionId = claudeSessionId
      console.log(`[session-manager] Follow-up ${sessionId} resuming codex thread ${claudeSessionId}`)
    } else {
      console.log(`[session-manager] Follow-up ${sessionId}: codex auth missing — falling back to history-flattening respawn`)
    }
  } else if (claudeSessionId) {
    const pinnedId = runtimeRow?.account_id || accountId
    const pinned = pinnedId ? getRouterStatus().accounts.find(a => a.id === pinnedId) : undefined
    if (!pinned?.available) {
      console.log(`[session-manager] Follow-up ${sessionId}: resume account ${pinnedId || 'unknown'} unavailable — falling back to history-flattening respawn`)
    } else if (!claudeConversationExists(pinned.homeDir, claudeSessionId, workdir)) {
      // No resumable transcript for this workdir: either the CLI never
      // persisted it (e.g. instant 429 exit) or it lives under a different
      // cwd's project dir than the one we'll launch from. Either way resuming
      // would die with "No conversation found".
      console.log(`[session-manager] Follow-up ${sessionId}: claude session ${claudeSessionId} has no resumable transcript for ${workdir} in ${pinned.homeDir} — falling back to history-flattening respawn`)
    } else {
      resumeSessionId = claudeSessionId
      accountId = pinned.id
      homeDir = pinned.homeDir
      recordSessionStart(pinned.id, sessionId)
      console.log(`[session-manager] Follow-up ${sessionId} resuming claude session ${claudeSessionId} on account ${pinned.id}`)
    }
  }

  if (!resumeSessionId) {
    // Grok / Codex are pinned engines — never rotate onto a Claude OAuth slot.
    if (isGrok) {
      if (!grokAuthAvailable()) {
        throw new Error(`Grok SuperGrok is not connected. Open System Dashboard → Grok → Connect and sign in with your grok.com subscription.`)
      }
    } else if (isCodex) {
      if (!codexAuthAvailable()) {
        throw new Error(`Codex auth missing: ${CODEX_HOME_DIR}/.codex/auth.json not found.`)
      }
    } else if (accountId) {
      // Check if existing account is rate-limited — if so, pick a fresh one
      const status = getRouterStatus()
      const acct = status.accounts.find(a => a.id === accountId)
      if (acct && !acct.available) {
        console.log(`[session-manager] Account ${accountId} is rate-limited for follow-up ${sessionId}, rotating`)
        const fresh = pickAccount()
        if (fresh) {
          accountId = fresh.id
          homeDir = fresh.homeDir
          recordSessionStart(fresh.id, sessionId)
        } else {
          console.log(`[session-manager] All accounts exhausted for follow-up ${sessionId}, enqueueing`)
          enqueueSession(objective.id)
          return sessionId
        }
      }
    }

    if (!isGrok && !isCodex && !accountId) {
      const account = pickAccount()
      if (account) {
        accountId = account.id
        homeDir = account.homeDir
        recordSessionStart(account.id, sessionId)
      }
    }
  }

  // Resume passes ONLY the follow-up text — the CLI restores prior context
  // natively. The flattened-history prompt is the no-claude_session_id fallback.
  // Flatten must NOT re-append buildContext: buildPrompt already includes it,
  // and extractObjectiveTurns skips the original spawn-prompt event so the
  // reconstructed basePrompt is not doubled inside <prior_conversation>.
  let prompt = message
  if (!resumeSessionId) {
    const priorHistory = buildObjectiveHistory(objective.id)
    const basePrompt = isPlannerSession ? buildPlannerPrompt(objective) : buildPrompt(objective)
    prompt = assembleFlattenedFollowUpPrompt(basePrompt, priorHistory, message)
  }

  ensureUser()
  ensureObjectiveMemoryDir(objective.id)

  // obj 1114 — reap any OTHER live worker tmux for this objective before the
  // respawn. A cross-account auto-resume / drain can spawn a continuation under
  // a NEW session id while the original tmux is still alive (different id, so
  // spawnInTmux's same-name kill misses it). Excludes `sessionId` (the one we're
  // resuming in place). Kill-once, then spawn.
  reapPredecessorSessions(objective.id, sessionId)

  // Spawn in tmux — session survives server restarts
  const tmuxName = spawnInTmux({
    sessionId,
    homeDir,
    workdir,
    prompt,
    jsonlPath,
    logPath,
    resumeSessionId,
    effort: objective.effort || 'normal',
    model: objective.model || undefined,
    settingsPath: hookSettingsPath,
    worktreeRoot,
    env: buildSpawnEnv({ objective, homeDir, sessionKind: 'followup' }),
  })

  const newSession: ActiveSession = {
    logPath,
    jsonlPath,
    startedAt: Date.now(),
    accountId,
    objective,
    tmuxName,
    requestedModel: objective.model || undefined,
  }
  registerActiveSession(sessionId, newSession)

  return sessionId
}

// ── Re-Open (objective 359) ──
// "Re-Open" replaces the old "Re-queue" action on done objectives. Re-queue sent
// done → queue, which on the next Start spawned a FRESH session from zero. Re-Open
// instead resumes the objective's most recent thread in place — picking up exactly
// where it left off when Done was clicked.
const REOPEN_NUDGE =
  'RE-OPENED: this objective was marked Done but has been reopened because the work is not ' +
  'actually complete. Resume from exactly where you left off — re-read your previous final ' +
  'state and continue. If you believe the work genuinely was complete, state what remains ' +
  'unclear and proceed to finish it.'

/**
 * Re-open a `done` objective by resuming its most recent session rather than
 * starting over. `objective.session_id` is nulled when an objective is marked
 * done, so the prior session id is recovered from `session_intel`. The thread is
 * reactivated via `sendFollowUp` (native `claude --resume` when a
 * claude_session_id was captured, history-flattening respawn otherwise). Returns
 * the session id the caller should persist on the objective. Falls back to a
 * fresh `startSession` only when no prior session exists.
 */
export async function reopenObjective(objective: Objective): Promise<string> {
  const db = getDb()
  const prior = db
    .prepare(
      'SELECT session_id FROM session_intel WHERE objective_id = ? ORDER BY started_at DESC LIMIT 1'
    )
    .get(objective.id) as { session_id: string } | undefined

  if (!prior?.session_id) {
    // No prior thread to resume — behave like a fresh start.
    return startSession(objective)
  }

  const sessionId = prior.session_id

  // Branch-lease guard on the RESUME path too (obj 994). The done-PATCH released
  // this objective's lease, so reopening must re-acquire before respawning —
  // otherwise a concurrent wake (duplicate reopen, drain) double-spawns on the
  // same branch, the exact race the lease exists to close. (The no-prior branch
  // above already routes through startSession, which acquires.)
  const branchName = deriveBranchName(objective)
  if (branchName) {
    const lease = acquireBranchLease(db, branchName, objective.id, sessionId)
    if (lease.status === 'conflict') {
      const msg = `Branch '${branchName}' is owned by objective ${lease.holder.objective_id} (session ${lease.holder.session_id}). Refusing to reopen objective ${objective.id}.`
      console.warn(`[branch-lease][conflict] ${msg}`)
      throw new BranchLeaseConflictError(msg, branchName, lease.holder.objective_id)
    }
    if (lease.status === 'reattached' && lease.holder.session_id && lease.holder.session_id !== sessionId) {
      console.warn(`[branch-lease][reattach] Objective ${objective.id} was already revived on '${branchName}' as ${lease.holder.session_id}; not respawning a duplicate.`)
      return lease.holder.session_id
    }
  } else {
    // Non-PR reopen (obj 1075). done released the identity leases, so reopening
    // must re-acquire before respawning — otherwise a concurrent wake double-spawns
    // the same taskworker, the exact race the lease closes.
    const idLease = acquireSessionLeasesForSpawn(db, objective, sessionId)
    if (idLease.status === 'conflict') {
      const msg = `Identity '${idLease.leaseKey}' is owned by objective ${idLease.holder.objective_id} (session ${idLease.holder.session_id}). Refusing to reopen objective ${objective.id}.`
      console.warn(`[session-lease][conflict] ${msg}`)
      emitSessionLeaseConflictWarning(objective, sessionId, idLease.holder)
      throw new SessionLeaseConflictError(msg, idLease.leaseKey, idLease.holder.objective_id)
    }
    if (idLease.status === 'reattached' && idLease.holder.session_id && idLease.holder.session_id !== sessionId) {
      console.warn(`[session-lease][reattach] Objective ${objective.id} was already revived as ${idLease.holder.session_id} (${idLease.leaseKey}); not respawning a duplicate.`)
      return idLease.holder.session_id
    }
  }

  // It was marked success on done; it's active again, so clear that outcome.
  db.prepare(
    "UPDATE session_intel SET outcome = NULL WHERE session_id = ? AND outcome = 'success'"
  ).run(sessionId)

  // Resume the thread in place. sendFollowUp respawns tmux (with --resume when a
  // claude_session_id exists) and registers the session in activeSessions.
  sendFollowUp(sessionId, REOPEN_NUDGE, { ...objective, session_id: sessionId })
  return sessionId
}
