import { execSync } from 'child_process'
import fs from 'fs'
import { TRANSCRIPT_DIR } from '../config.js'
import { getDb } from '../db/index.js'

// Re-export moved functions so existing consumers don't break
export { buildPrompt, resolveWorkdir, refreshObjectiveSummary } from './prompt-builder.js'
export { getSessionOutput, getSessionOutputAfter, evictOutputCache, getSessionJsonlPath } from './stream-parser.js'
export {
  extractFinalUsage,
  sumResultEventsFromContent,
  extractUsageFromResultEvent,
  TRANSCRIPT_LIST_TTL_MS,
  listTranscriptJsonl,
  __resetTranscriptListCache,
  computeObjectiveSpend,
  extractUsageForSessionId,
} from './session-usage.js'
export {
  type SpawnSessionKind,
  type SpawnSecurityPolicy,
  spawnSecurityPolicy,
  resolveSpawnTier,
  resolveActingUserId,
  SAFE_FALLBACK_GIT_IDENTITY,
  userGitIdentityEnv,
  userGoogleCredentialEnv,
  buildSpawnEnv,
} from './session-spawn-env.js'
export {
  buildClaudeCommand,
  codexAuthAvailable,
} from './session-spawn-command.js'
export { buildPlannerPrompt } from './session-planner-prompt.js'
export {
  buildReviewerPrompt,
  writeReviewerPlaywrightMcpConfig,
} from './session-reviewer-prompt.js'
export { spawnInTmux } from './session-tmux.js'
export {
  readJsonlTail,
  extractClaudeSessionId,
} from './session-jsonl.js'
export {
  type SessionDeathResult,
  handleSessionDeath,
  isMaxTurnsResultEvent,
  detectTurnsExhausted,
  decideTurnsContinue,
} from './session-death.js'
export {
  type WorktreeIsolation,
  computeIsolation,
  isPrivateWorktreeGitDir,
  isGitRepo,
  WORKTREE_GUARD_SCRIPT,
} from './session-worktree.js'
export { sendFollowUp, reopenObjective, recordFollowUpInJsonl } from './session-followup.js'
export { spawnPlannerSession, stopPlannerSession, spawnReviewerSession } from './session-subsessions.js'
export {
  startSession,
  BranchLeaseConflictError,
  SessionLeaseConflictError,
  emitSessionLeaseConflictWarning,
} from './session-start.js'
export {
  type AutoResumeOutcome,
  type OverloadOutcome,
  type TurnsOutcome,
  autoResumeOnLimit,
  isOverloadRetryPending,
  autoResumeOnOverload,
  autoResumeOnTurns,
} from './session-auto-resume.js'
export { scanStreamTelemetry } from './session-telemetry.js'
export {
  queueFollowUp,
  interruptSession,
  stopSession,
  getSessionStartedAt,
  getSessionState,
  listSessions,
  isSessionActive,
} from './session-control.js'
export { getAccountRouterStatus, setQueueDrainCallback } from './session-account-status.js'

// Ensure non-root user exists for Claude Code (it blocks --dangerously-skip-permissions as root)
let userSetup = false
export function ensureUser() {
  if (userSetup) return
  // The server process runs git as root, but the project repos under
  // /home/operator/projects are owned by admin. Without this, every `git -C
  // <projectDir>` that ensureWorktree runs as root is rejected with
  // "fatal: detected dubious ownership", ensureWorktree throws, and worktree
  // isolation FAILS OPEN (the session spawns in the live checkout — the exact
  // hazard obj-1059 closes). Set globally + best-effort so it is in place
  // before any spawn, independent of the rest of user setup succeeding.
  try { execSync(`git config --global --add safe.directory '*'`, { timeout: 5000 }) } catch {}
  try {
    execSync('id ccuser 2>/dev/null || useradd -m -s /bin/bash ccuser', { timeout: 5000 })
    // Give ccuser access to project dirs and transcripts
    execSync(`mkdir -p ${TRANSCRIPT_DIR} && chmod -R a+rw ${TRANSCRIPT_DIR} 2>/dev/null`, { timeout: 5000 })
    // Ensure account home dirs are accessible
    execSync('for d in /home/ccuser-a /home/ccuser-b /home/ccuser-c /home/ccuser-d /home/ccuser-e /home/ccuser-codex /app/data/cc-accounts/*; do [ -d "$d" ] && chown -R ccuser:ccuser "$d" 2>/dev/null; done', { timeout: 5000 })

    // Grant ccuser access to /var/run/docker.sock by adding it to a group that
    // matches the host socket's GID. Docker on the host exposes the socket as
    // root:docker (host gid != container gid), so we detect at runtime rather
    // than baking a fixed gid into the Dockerfile.
    try {
      const sockStat = fs.statSync('/var/run/docker.sock')
      const sockGid = sockStat.gid
      execSync(
        `getent group ${sockGid} >/dev/null 2>&1 || groupadd -g ${sockGid} dockerhost`,
        { timeout: 5000 }
      )
      execSync(
        `gn=$(getent group ${sockGid} | cut -d: -f1) && id -nG ccuser | tr ' ' '\\n' | grep -qx "$gn" || usermod -aG "$gn" ccuser`,
        { timeout: 5000, shell: '/bin/bash' }
      )
    } catch (err) {
      console.warn('[session-manager] docker socket access setup skipped:', (err as Error).message)
    }

    userSetup = true
  } catch {}
}

// Per-objective persistent memory dir — sessions read/write NOTES.md here so
// follow-ups and respawns inherit durable state without prompt flattening.
export function ensureObjectiveMemoryDir(objectiveId: number): void {
  const dir = `/home/operator/ai-workspace/objective-memory/${objectiveId}`
  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.chmodSync(dir, 0o777)
  } catch (err) {
    console.warn(`[session-manager] Failed to ensure objective memory dir ${dir}:`, (err as Error).message)
  }
}

/**
 * PURE selector for the predecessor-reaper (obj 1114). Given the live tmux
 * session names, return the ones to kill before spawning/respawning a worker
 * session for `objectiveId`, EXCLUDING `keepSessionId` (the session about to run).
 *
 * Why this exists: obj-994's branch lease rebinds/reclaims the lease to the NEW
 * session on a cross-account auto-resume but NEVER reaped the predecessor process.
 * An orphan holding no lease row (released, or written under a different account)
 * is invisible to the lease check, yet its tmux keeps running and clobbers the
 * SAME worktree — the exact double-spawn that hit obj-1059 live (two sessions
 * writing /tmp/cc-worktree-1059). So the sweep is lease-INDEPENDENT: it matches
 * by the tmux name shape directly.
 *
 * Matching is the exact worker-session shape `cc-<objId>-<digits>` produced by
 * `generateSessionId` (`cc-${id}-${Date.now()}`). This deliberately:
 *  - EXCLUDES `cc-plan-<id>-*` / `cc-review-<id>-*` (different prefix), so a
 *    concurrent planner/reviewer for the same objective is never touched.
 *  - EXCLUDES arena cohort variants `cc-<objId>-<ts>-arena-<key>` (trailing
 *    non-digits fail `[0-9]+$`), so a legitimate arena fan-out is never reaped.
 *  - EXCLUDES sibling objectives whose id merely shares a digit prefix
 *    (e.g. `cc-10591-...` does not match `^cc-1059-[0-9]+$`).
 * The invariant being enforced: at most ONE live worker session per objective
 * (arena is the only legitimate multi-session case and is excluded above).
 */
export function selectPredecessorsToReap(
  objectiveId: number,
  keepSessionId: string,
  sessionNames: string[],
): string[] {
  const workerRe = new RegExp(`^cc-${objectiveId}-[0-9]+$`)
  return sessionNames.filter((name) => name !== keepSessionId && workerRe.test(name))
}

/**
 * Reap any pre-existing live worker tmux session(s) for `objectiveId` except
 * `keepSessionId`, BEFORE spawning a continuation (obj 1114). Closes the
 * cross-account auto-resume double-spawn gap: see `selectPredecessorsToReap`.
 *
 * Lease-independent and kill-once (no fight loop): enumerate `tmux ls`, select
 * predecessors by name shape, kill each once. Best-effort — a missing tmux
 * server or an already-dead session is a no-op. obj-994 lease semantics are
 * preserved because callers reap ONLY when about to spawn: the same-objective
 * reattach path returns the live session WITHOUT spawning, so it never reaches
 * here (one session survives, not zero).
 */
export function reapPredecessorSessions(objectiveId: number, keepSessionId: string): void {
  let sessionNames: string[]
  try {
    const out = execSync(`tmux ls -F '#{session_name}' 2>/dev/null`, { timeout: 5000 }).toString()
    sessionNames = out.split('\n').map((s) => s.trim()).filter(Boolean)
  } catch {
    return // no tmux server / no sessions → nothing to reap
  }
  for (const name of selectPredecessorsToReap(objectiveId, keepSessionId, sessionNames)) {
    try {
      execSync(`tmux kill-session -t ${JSON.stringify(name)} 2>/dev/null`, { timeout: 5000 })
      console.warn(
        `[session-reaper] obj ${objectiveId}: killed predecessor tmux '${name}' before spawning '${keepSessionId}' ` +
        `(cross-account double-spawn guard, obj 1114)`,
      )
    } catch { /* already gone — fine */ }
  }
}

/** Worker tmux name: `cc-<objectiveId>-<digits>`. Excludes planner/reviewer/arena. */
const ORPHAN_WORKER_TMUX_RE = /^cc-\d+-\d+$/

/**
 * Pure selector: worker tmux sessions that are NOT a currently live session_id.
 * A live session is one attached to a working/ai_review/planning objective.
 * Reviewer (`cc-review-*`) and planner (`cc-plan-*`) names never match the
 * worker regex, so they are preserved. Arena variants (`-arena-`) also fail
 * the regex.
 */
export function selectOrphanWorkerSessions(
  sessionNames: string[],
  liveSessionIds: Iterable<string>,
): string[] {
  const live = new Set(liveSessionIds)
  return sessionNames.filter((name) => ORPHAN_WORKER_TMUX_RE.test(name) && !live.has(name))
}

/**
 * Periodic sweep: kill worker tmux sessions whose lease/objective has moved on.
 * The spawn-time reaper only fires when a NEW session starts, so two workers
 * can run in parallel until the next spawn (prod: 5 overlaps / 48h). This
 * closes that window on every poller tick.
 */
export function sweepOrphanWorkerTmux(): void {
  let sessionNames: string[]
  try {
    const out = execSync(`tmux ls -F '#{session_name}' 2>/dev/null`, { timeout: 5000 }).toString()
    sessionNames = out.split('\n').map((s) => s.trim()).filter(Boolean)
  } catch {
    return
  }
  if (sessionNames.length === 0) return

  let live: string[] = []
  try {
    const rows = getDb()
      .prepare(
        `SELECT session_id AS id FROM objectives
          WHERE status IN ('working', 'ai_review', 'planning') AND session_id IS NOT NULL
         UNION
         SELECT ai_review_session_id AS id FROM objectives
          WHERE status = 'ai_review' AND ai_review_session_id IS NOT NULL`,
      )
      .all() as { id: string }[]
    live = rows.map((r) => r.id).filter(Boolean)
  } catch {
    return
  }

  for (const name of selectOrphanWorkerSessions(sessionNames, live)) {
    try {
      execSync(`tmux kill-session -t ${JSON.stringify(name)} 2>/dev/null`, { timeout: 5000 })
      console.warn(`[session-reaper] killed orphan worker tmux '${name}' (not a live working/ai_review session_id)`)
    } catch { /* already gone */ }
  }
}
