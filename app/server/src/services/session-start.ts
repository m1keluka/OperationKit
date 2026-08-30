/**
 * Worker session start — extracted from session-manager.ts (behavior frozen).
 * startSession + design-arena fan-out. Lease conflict errors stay on the facade.
 */
import fs from 'fs'
import path from 'path'
import type { Objective } from '@operationkit/shared'
import { getDb } from '../db/index.js'
import { pickAccount, recordSessionStart, enqueueSession, getAccountById } from './account-router.js'
import { TRANSCRIPT_DIR } from '../config.js'
import { shouldRunArena, buildVariantSpecs, DEFAULT_ARENA_N, writeRankingArtifact } from './design-arena.js'
import { registerArenaCohort } from './arena-lifecycle.js'
import { buildPrompt, resolveWorkdir } from './prompt-builder.js'
import { acquireBranchLease } from './branch-lease.js'
import { acquireSessionLeasesForSpawn, type SessionLeaseHolder } from './session-lease.js'
import { deriveBranchName, deriveWorktreeBranchName } from './branch-scope.js'
import { spawnInTmux } from './session-tmux.js'
import { getModelEngine } from './model-registry.js'
import { buildSpawnEnv } from './session-spawn-env.js'
import { codexAuthAvailable, CODEX_ACCOUNT_ID, CODEX_HOME_DIR, grokAuthAvailable, GROK_ACCOUNT_ID, GROK_HOME_DIR } from './session-spawn-command.js'
import { writeReviewerPlaywrightMcpConfig } from './session-reviewer-prompt.js'
import { type ActiveSession, registerActiveSession } from './session-registry.js'
import { computeIsolation, ensureWorktree, ensureWorktreeHookAssets } from './session-worktree.js'
import {
  ensureUser,
  ensureObjectiveMemoryDir,
  reapPredecessorSessions,
} from './session-manager.js'

function generateSessionId(objective: Objective): string {
  return `cc-${objective.id}-${Date.now()}`
}


/**
 * Thrown by startSession when a live branch lease is held by a DIFFERENT objective.
 * HTTP callers map this to 409; the objective's status is left untouched so the
 * legitimate owner is never disrupted (obj 994 fail-safe dedup).
 */
export class BranchLeaseConflictError extends Error {
  constructor(message: string, public readonly branchName: string, public readonly ownerObjectiveId: number) {
    super(message)
    this.name = 'BranchLeaseConflictError'
  }
}

/**
 * Thrown by startSession/reopenObjective when a NON-PR objective's cross-card
 * identity lease is held live by a DIFFERENT (duplicate) objective. The branch-lease
 * analogue for taskworker sessions (obj 1075). HTTP callers map this to 409; the
 * refused objective's status is left untouched and the live owner is never disrupted.
 */
export class SessionLeaseConflictError extends Error {
  constructor(message: string, public readonly leaseKey: string, public readonly ownerObjectiveId: number) {
    super(message)
    this.name = 'SessionLeaseConflictError'
  }
}

/**
 * Surface a non-PR duplicate-spawn refusal as a `type:'warning'` board event on the
 * REFUSED objective (obj 1075, acceptance #4). We deliberately use a session_events
 * 'warning' row — NOT a session_intel blocker — because blockers leak cross-objective
 * via context-builder.ts (learned in obj 994), whereas a warning stays local to this
 * objective's events feed. The existing live owner is never written to or disturbed.
 */
export function emitSessionLeaseConflictWarning(objective: Objective, sessionId: string, holder: SessionLeaseHolder): void {
  try {
    getDb()
      .prepare(
        `INSERT INTO session_events (session_id, objective_id, event_type, description, metadata, created_at)
         VALUES (?, ?, 'warning', ?, ?, datetime('now'))`,
      )
      .run(
        sessionId,
        objective.id,
        `Duplicate-spawn suppressed: objective ${objective.id} ("${objective.title}") refused because objective ${holder.objective_id} (session ${holder.session_id}) is already live on the same identity. Existing work untouched.`,
        JSON.stringify({
          kind: 'session_lease_conflict',
          refused_objective_id: objective.id,
          owner_objective_id: holder.objective_id,
          owner_session_id: holder.session_id,
        }),
      )
  } catch (err) {
    console.error(`[session-lease] Failed to record conflict warning for obj ${objective.id}:`, err)
  }
}

export async function startSession(objective: Objective): Promise<string> {
  // Design Arena (obj 594) — DORMANT BY DEFAULT. `shouldRunArena` is false unless the
  // `.ui-gate.json` `arena` block is enabled AND the objective is arena-eligible, so
  // with the arena off this guard is a no-op and everything below is byte-identical to
  // the pre-arena spawn path. The arena fans out N archetype-seeded generators instead
  // of one worker; the winner re-enters the EXISTING ai_review path unchanged.
  if (shouldRunArena(objective)) {
    return startArenaSession(objective)
  }

  const sessionId = generateSessionId(objective)

  // Branch-ownership lease (obj 994) — the fail-safe dedup. For PR-building
  // objectives, claim the branch BEFORE any side effect (account slot, files,
  // tmux). Outcomes:
  //  - conflict   → a DIFFERENT objective is live on this branch. Refuse to
  //                 spawn (throw); the caller leaves status untouched so the
  //                 legitimate owner keeps running and this row is never stranded.
  //  - reattached → THIS objective already holds a live lease (auto-resume /
  //                 drain / duplicate-wake race). Rebind to the running session
  //                 instead of spawning a duplicate.
  //  - acquired   → free / reclaimed-stale. Proceed to spawn.
  const branchName = deriveBranchName(objective)
  if (branchName) {
    const lease = acquireBranchLease(getDb(), branchName, objective.id, sessionId)
    if (lease.status === 'conflict') {
      const msg = `Branch '${branchName}' is owned by objective ${lease.holder.objective_id} (session ${lease.holder.session_id}). Refusing to spawn a duplicate for objective ${objective.id}.`
      console.warn(`[branch-lease][conflict] ${msg}`)
      throw new BranchLeaseConflictError(msg, branchName, lease.holder.objective_id)
    }
    if (lease.status === 'reattached' && lease.holder.session_id) {
      console.warn(`[branch-lease][reattach] Objective ${objective.id} already has a live session ${lease.holder.session_id} on '${branchName}'; rebinding instead of spawning a duplicate.`)
      return lease.holder.session_id
    }
  } else {
    // Non-PR (taskworker) objective — no branch, so branch-lease above can't cover
    // it. These are the MOST COMMON sessions and edit the shared main checkout
    // directly. Dedup on the identity every objective has (obj 1075). Same three
    // fail-safe outcomes as the branch lease:
    //  - conflict   → a DIFFERENT (duplicate) card is live on this parent+title.
    //                 Refuse to spawn; warn on the board; leave the owner untouched.
    //  - reattached → THIS objective already holds a live lease (drain re-spawn,
    //                 child-complete double/triple re-fire, auto-resume race).
    //                 Rebind to the running session instead of double-spawning.
    //  - acquired   → free / reclaimed-stale. Proceed to spawn.
    const idLease = acquireSessionLeasesForSpawn(getDb(), objective, sessionId)
    if (idLease.status === 'conflict') {
      const msg = `Identity '${idLease.leaseKey}' is owned by objective ${idLease.holder.objective_id} (session ${idLease.holder.session_id}). Refusing to spawn a duplicate for objective ${objective.id}.`
      console.warn(`[session-lease][conflict] ${msg}`)
      emitSessionLeaseConflictWarning(objective, sessionId, idLease.holder)
      throw new SessionLeaseConflictError(msg, idLease.leaseKey, idLease.holder.objective_id)
    }
    if (idLease.status === 'reattached' && idLease.holder.session_id) {
      console.warn(`[session-lease][reattach] Objective ${objective.id} already has a live session ${idLease.holder.session_id} (${idLease.leaseKey}); rebinding instead of spawning a duplicate.`)
      return idLease.holder.session_id
    }
  }

  // obj 1059 — isolate EVERY project-scoped session into its own worktree so it
  // can never edit the live checkout. Create the worktree server-side BEFORE
  // spawn and launch the session INSIDE it, so the live tree is never the cwd.
  // The PreToolUse guard (settingsPath) is the hard pre-write block. obj 1451:
  // if worktree creation fails for an isolated (project-linked) session we FAIL
  // CLOSED — throw to abort the spawn rather than fall back to the live workdir
  // unguarded. The throw precedes any status mutation (the route/poller only set
  // status='working' AFTER startSession returns), so the row is never stranded;
  // the operator sees the error instead of a silent unguarded run in the live tree.
  const isolation = computeIsolation(objective, sessionId)
  let workdir = resolveWorkdir(objective)
  let hookSettingsPath: string | undefined
  let worktreeRoot: string | undefined
  if (isolation) {
    const wtBranch = deriveWorktreeBranchName(objective)
    const wtPath = wtBranch ? ensureWorktree(objective, wtBranch) : null
    if (wtPath) {
      workdir = wtPath
      worktreeRoot = wtPath
      hookSettingsPath = ensureWorktreeHookAssets()
    } else {
      throw new Error(
        `[session-manager] Objective ${objective.id}: worktree isolation REQUIRED (project "${objective.project}") but ensureWorktree failed for "${isolation.projectDir}" (branch "${wtBranch || '(none)'}"). Refusing to spawn UNGUARDED in the live checkout — fail-closed (obj 1451). Verify the resolved workdir is a git repo and the branch can be created.`,
      )
    }
  }
  const prompt = buildPrompt(objective)
  const logPath = path.join(TRANSCRIPT_DIR, `${sessionId}.log`)
  const jsonlPath = path.join(TRANSCRIPT_DIR, `${sessionId}.jsonl`)

  fs.mkdirSync(TRANSCRIPT_DIR, { recursive: true })

  // Codex objectives bypass Claude account rotation entirely — they run on the
  // ChatGPT subscription and can proceed even when every Claude slot is limited.
  const engine = getModelEngine(objective.model)
  const isCodex = engine === 'codex'
  const isGrok = engine === 'grok'
  let accountId: string
  let homeDir: string
  let accountLabel: string
  if (isCodex) {
    if (!codexAuthAvailable()) {
      throw new Error(`Codex auth missing: ${CODEX_HOME_DIR}/.codex/auth.json not found. Run codex login on a machine with a browser and copy auth.json to the host dir /home/operator/.ccuser-codex/.codex/`)
    }
    accountId = CODEX_ACCOUNT_ID
    homeDir = CODEX_HOME_DIR
    accountLabel = 'Codex (ChatGPT sub)'
  } else if (isGrok) {
    try {
      fs.mkdirSync(GROK_HOME_DIR, { recursive: true })
      fs.chmodSync(GROK_HOME_DIR, 0o777)
    } catch { /* spawn env still works if XAI_API_KEY is set */ }
    if (!grokAuthAvailable()) {
      throw new Error(`Grok SuperGrok is not connected. Open System Dashboard → Grok → Connect and sign in with your grok.com subscription (writes ${GROK_HOME_DIR}/.grok/auth.json).`)
    }
    accountId = GROK_ACCOUNT_ID
    homeDir = GROK_HOME_DIR
    const grokSlot = getAccountById(GROK_ACCOUNT_ID)
    accountLabel = grokSlot?.customLabel || grokSlot?.label || 'Grok (xAI)'
  } else {
    // Pick the best available account via rotation
    const account = pickAccount()
    if (!account) {
      enqueueSession(objective.id)
      const msg = `All Claude accounts exhausted. Objective ${objective.id} queued for auto-retry.`
      console.log(`[session-manager] ${msg}`)
      throw new Error(msg)
    }
    accountId = account.id
    homeDir = account.homeDir
    accountLabel = account.label
  }
  console.log(`[session-manager] Session ${sessionId} -> account ${accountId} (${accountLabel}), HOME=${homeDir}, mode=tmux`)

  // Create log file with header — chmod 666 so ccuser can append from tmux
  fs.writeFileSync(logPath, `=== Session ${sessionId} ===\nObjective: ${objective.title}\nStarted: ${new Date().toISOString()}\nAgent: ${objective.agent_context}\nAccount: ${accountId} (${accountLabel})\nMode: tmux stream-json\n${'='.repeat(50)}\n\n`)
  fs.chmodSync(logPath, 0o666)
  // Write initial prompt as the first message so it shows in the chat UI
  const promptEvent = JSON.stringify({ type: 'prompt', text: prompt, title: objective.title, timestamp: new Date().toISOString() })
  fs.writeFileSync(jsonlPath, promptEvent + '\n')
  fs.chmodSync(jsonlPath, 0o666)

  ensureUser()
  ensureObjectiveMemoryDir(objective.id)
  recordSessionStart(accountId, sessionId)

  // obj 1114 — reap any predecessor worker tmux for THIS objective before spawning
  // the continuation. The branch lease above rebinds/reclaims to the new session
  // but does not kill an orphan predecessor (no lease row, or a reclaimed-stale
  // lease) that is still alive and writing the same worktree — the live obj-1059
  // double-spawn. Kill-once, then spawn.
  reapPredecessorSessions(objective.id, sessionId)

  // Spawn in tmux — session survives server restarts
  const tmuxName = spawnInTmux({
    sessionId,
    homeDir,
    workdir,
    prompt,
    jsonlPath,
    logPath,
    effort: objective.effort || 'normal',
    model: objective.model || undefined,
    settingsPath: hookSettingsPath,
    worktreeRoot,
    env: buildSpawnEnv({ objective, homeDir, sessionKind: 'worker' }),
  })

  const session: ActiveSession = {
    logPath,
    jsonlPath,
    startedAt: Date.now(),
    accountId,
    objective,
    tmuxName,
    requestedModel: objective.model || undefined,
  }
  registerActiveSession(sessionId, session)

  // Record the tmux handle on the lease for observability (the guard itself only
  // needs objective_id + heartbeat).
  if (branchName) {
    try {
      getDb().prepare("UPDATE branch_leases SET tmux_name = ? WHERE branch_name = ? AND objective_id = ?")
        .run(tmuxName, branchName, objective.id)
    } catch { /* non-fatal */ }
  }

  return sessionId
}

/**
 * Design Arena cohort spawn (obj 594) — reached ONLY from `startSession` when
 * `shouldRunArena(objective)` is true (arena enabled in `.ui-gate.json` AND the
 * objective is arena-eligible). Fans out N archetype-seeded generators instead of one
 * worker: each generator gets the FULL standard worker prompt (`buildPrompt`, so the
 * worktree/vault/QA scaffolding is identical) PLUS a distinct layout-archetype seed
 * (`buildVariantSpecs`, which reuses `buildDesignContextBlock` verbatim). The
 * generators are independent contexts (no shared draft) so the diversity is real.
 *
 * After the cohort builds, the render-and-rank → pairwise-tiebreak → promote-winner
 * pipeline (design-arena.ts `runArena`) selects the winner, whose output re-enters the
 * EXISTING ai_review path unchanged. A cohort manifest is written so that evaluation
 * step can locate the variants. Returns the FIRST variant's session id as the
 * objective's primary session handle.
 *
 * NOTE: this is the additive, dormant spawn-side of the arena. With the flag off this
 * function is never called and the spawn path is byte-identical.
 */
async function startArenaSession(objective: Objective): Promise<string> {
  const specs = buildVariantSpecs(objective, DEFAULT_ARENA_N)
  const workdir = resolveWorkdir(objective)
  const basePrompt = buildPrompt(objective)
  fs.mkdirSync(TRANSCRIPT_DIR, { recursive: true })
  ensureUser()
  ensureObjectiveMemoryDir(objective.id)

  const cohort: Array<{ archetypeKey: string; archetypeName: string; sessionId: string; tmuxName: string }> = []
  let primarySessionId: string | null = null

  for (const spec of specs) {
    const account = pickAccount()
    if (!account) {
      // Out of accounts mid-fan-out: stop spawning further variants but keep whatever
      // cohort we have. The arena ranks survivors; a thinner cohort still works.
      console.log(`[session-manager] Arena #${objective.id}: accounts exhausted after ${cohort.length} variant(s)`)
      break
    }
    const sessionId = `${generateSessionId(objective)}-arena-${spec.archetypeKey}`
    const logPath = path.join(TRANSCRIPT_DIR, `${sessionId}.log`)
    const jsonlPath = path.join(TRANSCRIPT_DIR, `${sessionId}.jsonl`)
    const prompt = `${basePrompt}\n\n${spec.prompt}`

    fs.writeFileSync(logPath, `=== Arena variant ${sessionId} (${spec.archetypeName}) ===\nObjective: ${objective.title}\nStarted: ${new Date().toISOString()}\n${'='.repeat(50)}\n\n`)
    fs.chmodSync(logPath, 0o666)
    const promptEvent = JSON.stringify({ type: 'prompt', text: prompt, title: `${objective.title} — ${spec.archetypeName}`, timestamp: new Date().toISOString() })
    fs.writeFileSync(jsonlPath, promptEvent + '\n')
    fs.chmodSync(jsonlPath, 0o666)
    recordSessionStart(account.id, sessionId)

    // Register Playwright MCP for each variant (REUSE the shipped reviewer helper) so the
    // generator can render itself at 1440px + 390px and emit the <scorecard> the arena
    // ranker consumes — the same browser registration the ai_review gate uses. Best-effort:
    // a null config just means the variant falls back to ambient MCP registration.
    const mcpConfigPath = writeReviewerPlaywrightMcpConfig(sessionId, account.homeDir) ?? undefined

    const tmuxName = spawnInTmux({
      sessionId,
      homeDir: account.homeDir,
      workdir,
      prompt,
      jsonlPath,
      logPath,
      effort: objective.effort || 'normal',
      model: objective.model || undefined,
      mcpConfigPath,
      env: buildSpawnEnv({ objective, homeDir: account.homeDir, sessionKind: 'arena' }),
    })

    registerActiveSession(sessionId, {
      logPath,
      jsonlPath,
      startedAt: Date.now(),
      accountId: account.id,
      objective,
      tmuxName,
      requestedModel: objective.model || undefined,
    })
    cohort.push({ archetypeKey: spec.archetypeKey, archetypeName: spec.archetypeName, sessionId, tmuxName })
    if (!primarySessionId) primarySessionId = sessionId
    console.log(`[session-manager] Arena #${objective.id}: spawned variant '${spec.archetypeKey}' -> ${sessionId} (account ${account.id})`)
  }

  if (!primarySessionId) {
    // No variant could be spawned (all accounts exhausted). Fall back to the normal
    // single-worker path so the objective is not stranded.
    console.log(`[session-manager] Arena #${objective.id}: no variants spawned, falling back to single worker`)
    enqueueSession(objective.id)
    throw new Error(`Arena #${objective.id}: all Claude accounts exhausted; queued for retry.`)
  }

  // Register the cohort so the state-poller can render-and-rank → promote the winner
  // once every variant session finishes (arena-lifecycle.ts). In-memory + a durable
  // manifest beside the objective memory for forensics.
  registerArenaCohort(objective.id, cohort.map((c) => ({ archetypeKey: c.archetypeKey, archetypeName: c.archetypeName, sessionId: c.sessionId })))
  writeRankingArtifact(`/home/operator/ai-workspace/objective-memory/${objective.id}`, {
    arena: `obj-${objective.id}-cohort`,
    objective: objective.title,
    project: objective.project,
    spawnedAt: new Date().toISOString(),
    cohort,
  })

  return primarySessionId
}
