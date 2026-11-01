/**
 * Follow-up and reopen — extracted from session-manager.ts (behavior frozen).
 * sendFollowUp respawns via tmux (--resume when possible). reopenObjective
 * resumes a done objective's last thread. Shared spawn helpers stay in the facade.
 *
 * Imports startSession / ensureUser / etc. from the facade. Circular ESM is
 * runtime-safe: these functions run after module init (same pattern as session-death).
 */
import fs from 'fs'
import { redactForStorage } from './secret-redaction.js'
import path from 'path'
import type { MessageSender, Objective } from '@operationkit/shared'
import { stampForSession, systemSender } from '../lib/message-provenance.js'
import { VERIFIED_SENDER_FLAG, readSettingFlag } from '../lib/session-trust.js'
import { getDb } from '../db/index.js'
import {
  recordSessionStart,
  enqueueSession,
  getAccountForSession,
  getRouterStatus,
  chooseFollowUpAccount,
  getAccountById,
  seatCount,
  type AccountSlot,
} from './account-router.js'
import { TRANSCRIPT_DIR } from '../config.js'
import { assembleFlattenedFollowUpPrompt, buildPrompt, resolveWorkdir, buildObjectiveHistory } from './prompt-builder.js'
import { acquireBranchLease } from './branch-lease.js'
import { acquireSessionLeasesForSpawn } from './session-lease.js'
import { claimObjectiveSession } from './objective-session-claim.js'
import { logSessionStart, takeStartReason } from './session-start-reasons.js'
import {
  FRESH_SEEDED_REASON,
  assembleSeededFollowUpPrompt,
  buildSeededSummary,
  decideResumeCap,
  describeCapDetail,
  markChainReset,
  measureChain,
  postResetSessionId,
  resolveResumeCapConfig,
  type ResumeCapDecision,
} from './resume-cap.js'
import { logActivity } from '../routes/feed.js'
import { isSessionActive } from './session-control.js'
import { deriveBranchName, deriveWorktreeBranchName } from './branch-scope.js'
import { spawnInTmux } from './session-tmux.js'
import { extractClaudeSessionId } from './session-jsonl.js'
import { getModelEngine } from './model-registry.js'
import { buildSpawnEnv } from './session-spawn-env.js'
import { seatKind } from './seat-pool.js'
import { recordSessionSeat, seatSignIn } from './seat-assign.js'
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
export function recordFollowUpInJsonl(sessionId: string, message: string, jsonlPath?: string, sender?: MessageSender): void {
  const file = jsonlPath || path.join(TRANSCRIPT_DIR, `${sessionId}.jsonl`)
  // obj 715532: a credential pasted into the chat is stored as [REDACTED:<NAME>].
  // obj 718944: `sender` is the server-derived provenance, never parsed from text.
  const followupEvent = JSON.stringify({
    type: 'followup',
    text: redactForStorage(message).text,
    timestamp: new Date().toISOString(),
    ...(sender ? { sender } : {}),
  })
  fs.appendFileSync(file, followupEvent + '\n')
  try { fs.chmodSync(file, 0o666) } catch {}
}

const WORKER_SESSION_ID = /^cc-\d+-\d+$/

/**
 * obj 718944 — the text a session actually receives for a follow-up. With
 * settings.verified_sender_stamps on: server stamp on line 1, body neutralised;
 * a caller that passed no sender reads as SYSTEM, never as the owner. Off: the
 * message unchanged.
 */
export function followUpSessionText(message: string, sender?: MessageSender): string {
  return readSettingFlag(VERIFIED_SENDER_FLAG)
    ? stampForSession(sender ?? systemSender('Command Center (unattributed)'), message)
    : message
}

export function sendFollowUp(
  sessionId: string,
  message: string,
  objective: Objective,
  opts?: { skipJsonl?: boolean; sender?: MessageSender },
): string {
  const session = activeSessions.get(sessionId)
  // obj 718944: what the SESSION reads. With verified_sender_stamps on, every
  // follow-up carries the server stamp on line 1 (unattributed callers read as
  // SYSTEM, never as the owner); the jsonl keeps the raw body + `sender`.
  const sessionText = followUpSessionText(message, opts?.sender)

  // If the process is still alive and has stdin, send via bidirectional stream-json
  if (session?.stdin && session.process && !session.process.killed) {
    try {
      // Check if process is actually alive
      process.kill(session.process.pid!, 0)

      // Log the follow-up
      fs.appendFileSync(session.logPath, `\n\n--- Follow-up (via stdin): ${message.slice(0, 200)} ---\n\n`)
      if (!opts?.skipJsonl) recordFollowUpInJsonl(sessionId, message, session.jsonlPath, opts?.sender)

      // Send via stdin — same process, same context, true multi-turn
      const stdinMessage = JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: sessionText }] },
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

  // obj 715699 — one live session per card. The respawn path used to take no lease,
  // so a follow-up addressed to an older worker session id while a NEWER session of
  // the same card was live spawned a second worker (and the predecessor reaper then
  // killed the live one, losing its work). Claim the card's identity lease; if
  // another session of this card is live, ATTACH: redirect the follow-up to it.
  // Worker-shaped ids only (`cc-<id>-<ts>`) — planners, reviewers and arena variants
  // are separate session kinds and never hold the identity lease.
  if (WORKER_SESSION_ID.test(sessionId)) {
    const claim = claimObjectiveSession(getDb(), objective.id, sessionId, isSessionActive)
    if (claim.outcome === 'attach') {
      console.warn(`[session-claim][attach] Follow-up for ${sessionId} redirected to live session ${claim.sessionId} (objective ${objective.id}).`)
      logSessionStart(getDb(), { objectiveId: objective.id, sessionId: claim.sessionId, kind: 'attach' })
      return sendFollowUp(claim.sessionId, message, { ...objective, session_id: claim.sessionId }, opts)
    }
  }

  // ── Native resume lookup ──
  // Prefer `claude --resume <claude_session_id>` over rebuilding context from
  // flattened objective history. The CLI transcript lives in the owning
  // account's HOME, so resume must be pinned to that account; when it's
  // unavailable (or no claude_session_id was ever captured) we fall back to
  // the legacy history-flattening respawn below.
  const engine = getModelEngine(objective.model)
  let runtimeRow: { claude_session_id: string | null; account_id: string | null } | undefined
  try {
    runtimeRow = getDb()
      .prepare('SELECT claude_session_id, account_id FROM session_runtime WHERE session_id = ?')
      .get(sessionId) as { claude_session_id: string | null; account_id: string | null } | undefined
  } catch {}
  // For codex sessions this resolves the thread_id (from `thread.started`).
  // obj 64 — after a capped fresh start, only the conversation begun AFTER the
  // chain-reset marker is resumable; never fall back to the over-cap one.
  const postReset = postResetSessionId(jsonlPath)
  const claudeSessionId =
    postReset !== undefined ? postReset : runtimeRow?.claude_session_id || extractClaudeSessionId(jsonlPath)

  // obj 64 (Part A) — resumed-session history cap. When this worker's current
  // session chain is over its token / round budget, do NOT replay the transcript:
  // start a fresh conversation seeded with a deterministic DB summary instead.
  // Worker sessions only (planners/reviewers/arena are short-lived kinds).
  let capDecision: ResumeCapDecision | null = null
  if (WORKER_SESSION_ID.test(sessionId)) {
    try {
      const capDb = getDb()
      capDecision = decideResumeCap(measureChain(capDb, sessionId, jsonlPath), resolveResumeCapConfig(capDb))
    } catch (err) {
      console.warn(`[resume-cap] measurement failed for ${sessionId} (resuming normally):`, (err as Error).message)
    }
  }
  const historyCapped = !!capDecision?.capped
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
  if (!opts?.skipJsonl) recordFollowUpInJsonl(sessionId, message, jsonlPath, opts?.sender)
  try { fs.chmodSync(logPath, 0o666) } catch {}

  // Seat pool v2: stay on the session's seat while it is healthy; re-pick on
  // the same engine when it is now parked / disabled / out of credits /
  // cooling down. A follow-up never crosses engines (the resumable CLI
  // transcript is engine-specific); with no healthy seat it queues.
  const existingAccount = session?.accountId ? getAccountForSession(sessionId) : null
  let accountId: string | null = existingAccount?.id || session?.accountId || runtimeRow?.account_id || null
  let seat: AccountSlot | null = null

  // Resume pinning: the CLI transcript only exists in the original seat's
  // HOME, so resume requires that exact seat to be available.
  let resumeSessionId: string | undefined
  if (claudeSessionId && historyCapped) {
    console.log(`[resume-cap] Follow-up ${sessionId}: chain over cap (${describeCapDetail(capDecision!)}) — fresh seeded session instead of --resume ${claudeSessionId}`)
  } else if (claudeSessionId) {
    const pinnedId = runtimeRow?.account_id || accountId
    const pinned = pinnedId ? getAccountById(pinnedId) : null
    const pinnedAvailable = !!pinned && seatKind(pinned) === engine &&
      !!getRouterStatus().accounts.find(a => a.id === pinned.id)?.available
    if (!pinned || !pinnedAvailable) {
      console.log(`[session-manager] Follow-up ${sessionId}: resume seat ${pinnedId || 'unknown'} unavailable — falling back to history-flattening respawn`)
    } else if (engine === 'claude' && !claudeConversationExists(pinned.homeDir, claudeSessionId, workdir)) {
      // No resumable transcript for this workdir: either the CLI never
      // persisted it (e.g. instant 429 exit) or it lives under a different
      // cwd's project dir than the one we'll launch from. Either way resuming
      // would die with "No conversation found".
      console.log(`[session-manager] Follow-up ${sessionId}: claude session ${claudeSessionId} has no resumable transcript for ${workdir} in seat ${pinned.id} — falling back to history-flattening respawn`)
    } else {
      resumeSessionId = claudeSessionId
      seat = pinned
      recordSessionStart(pinned.id, sessionId)
      console.log(`[session-manager] Follow-up ${sessionId} resuming ${engine} session ${claudeSessionId} on seat ${pinned.id}`)
    }
  }

  if (!seat) {
    const choice = chooseFollowUpAccount(accountId, undefined, engine)
    if (!choice.account) {
      if (engine !== 'claude' && seatCount(engine) === 0) {
        throw new Error(`No ${engine === 'codex' ? 'Codex' : 'Grok'} seat is connected. Add one in Settings → Seats.`)
      }
      console.log(`[session-manager] No healthy ${engine} seat for follow-up ${sessionId} (original ${accountId || 'none'}), enqueueing`)
      enqueueSession(objective.id)
      return sessionId
    }
    if (choice.rerouted) {
      console.log(`[session-manager] Seat ${accountId} is ${choice.parkedReason ? `parked (${choice.parkedReason})` : 'unavailable'} for follow-up ${sessionId}, re-picked ${choice.account.id}`)
    }
    if (choice.account.id !== accountId || choice.rerouted) recordSessionStart(choice.account.id, sessionId)
    seat = choice.account
  }
  accountId = seat.id
  const homeDir = seat.homeDir
  const signIn = seatSignIn(seat)
  recordSessionSeat(sessionId, seat.id)

  // Resume passes ONLY the follow-up text — the CLI restores prior context
  // natively. The flattened-history prompt is the no-claude_session_id fallback.
  // Flatten must NOT re-append buildContext: buildPrompt already includes it,
  // and extractObjectiveTurns skips the original spawn-prompt event so the
  // reconstructed basePrompt is not doubled inside <prior_conversation>.
  let prompt = sessionText
  if (!resumeSessionId) {
    const basePrompt = isPlannerSession ? buildPlannerPrompt(objective) : buildPrompt(objective)
    if (historyCapped && capDecision) {
      // obj 64 — fresh session seeded from DB fields only (no transcript replay,
      // no summarizer model call). The marker resets the chain's token count.
      prompt = assembleSeededFollowUpPrompt(basePrompt, buildSeededSummary(getDb(), objective), sessionText, capDecision)
    } else {
      const priorHistory = buildObjectiveHistory(objective.id)
      prompt = assembleFlattenedFollowUpPrompt(basePrompt, priorHistory, sessionText)
    }
  }
  if (historyCapped && capDecision) {
    try { markChainReset(jsonlPath, capDecision) } catch (err) {
      console.warn(`[resume-cap] could not write chain-reset marker for ${sessionId}:`, (err as Error).message)
    }
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
    objectiveId: objective.id,
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
    seatEnv: signIn.env,
    seatMount: signIn.mount,
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
  if (historyCapped && capDecision) {
    // The wake source's own attribution (ai_review_fail, follow_up, …) is folded
    // into the detail so the card still shows WHY it woke, plus that it was capped.
    const wake = takeStartReason(objective.id)
    const detail = describeCapDetail(capDecision, wake.reason)
    logSessionStart(getDb(), {
      objectiveId: objective.id,
      sessionId,
      kind: 'spawn',
      reason: { reason: FRESH_SEEDED_REASON, actor: wake.actor || 'resume-cap', detail },
    })
    try {
      logActivity({
        project: objective.project || objective.workspace || 'example',
        workspace: objective.workspace,
        objective_id: objective.id,
        session_id: sessionId,
        event_type: 'decision',
        title: `#${objective.id} restarted fresh (history cap)`,
        detail,
        metadata: { kind: 'resume_capped', trigger: capDecision.trigger, ...capDecision.usage, cap_tokens: capDecision.config.tokens, cap_rounds: capDecision.config.rounds },
      })
    } catch {}
  } else {
    logSessionStart(getDb(), { objectiveId: objective.id, sessionId, kind: 'resume' })
  }

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
