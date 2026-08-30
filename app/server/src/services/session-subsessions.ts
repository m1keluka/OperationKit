/**
 * Planner and reviewer session spawn — extracted from session-manager.ts (behavior frozen).
 * Prompts already live in session-planner-prompt / session-reviewer-prompt.
 * stopPlannerSession delegates to stopSession in session-control.
 */
import fs from 'fs'
import path from 'path'
import type { Objective } from '@operationkit/shared'
import { getDb } from '../db/index.js'
import { resolveFilesTouched, realGhExec } from './files-touched.js'
import { pickAccount, recordSessionStart } from './account-router.js'
import { TRANSCRIPT_DIR } from '../config.js'
import { getEffectiveGateMode, isBackendOnlyChange } from './design-context.js'
import { resolveWorkdir } from './prompt-builder.js'
import { spawnInTmux } from './session-tmux.js'
import { getPlannerModelId, getReviewerModelId } from './model-registry.js'
import { buildSpawnEnv } from './session-spawn-env.js'
import { buildPlannerPrompt } from './session-planner-prompt.js'
import {
  buildReviewerPrompt,
  writeReviewerPlaywrightMcpConfig,
  isDelegatorWorkerObjective,
} from './session-reviewer-prompt.js'
import { registerActiveSession } from './session-registry.js'
import { ensureUser } from './session-manager.js'
import { stopSession } from './session-control.js'

// ── Planner sub-sessions ─────────────────────────────────────────────────────
// A planner is a read-only Claude Code session whose job is to draft an
// implementation plan via Q&A with the user. It loads the cc-planner skill and
// has its Edit/Write/Bash side-effects suppressed by the skill's own rules
// (we don't currently enforce tool-allowlists at the spawn layer; the skill
// instructions are the contract). Output JSONL is parsed the same way as any
// other session, and the planning endpoints read it via getSessionOutput.

function generatePlannerSessionId(objective: Objective): string {
  return `cc-plan-${objective.id}-${Date.now()}`
}

function generateReviewerSessionId(objective: Objective): string {
  return `cc-review-${objective.id}-${Date.now()}`
}

export async function spawnPlannerSession(objective: Objective): Promise<string> {
  const sessionId = generatePlannerSessionId(objective)
  // Planner runs in the agent's default workdir; it only needs read access.
  const workdir = resolveWorkdir(objective)
  const prompt = buildPlannerPrompt(objective)
  const logPath = path.join(TRANSCRIPT_DIR, `${sessionId}.log`)
  const jsonlPath = path.join(TRANSCRIPT_DIR, `${sessionId}.jsonl`)

  fs.mkdirSync(TRANSCRIPT_DIR, { recursive: true })

  const account = pickAccount()
  if (!account) {
    throw new Error('All Claude accounts exhausted — cannot start planner')
  }
  console.log(`[session-manager] Planner ${sessionId} -> account ${account.id} (${account.label}), workdir=${workdir}`)

  fs.writeFileSync(logPath, `=== Planner ${sessionId} ===\nObjective: ${objective.title}\nMode: planning\n${'='.repeat(50)}\n\n`)
  fs.chmodSync(logPath, 0o666)
  const promptEvent = JSON.stringify({ type: 'prompt', text: prompt, title: `Plan: ${objective.title}`, timestamp: new Date().toISOString() })
  fs.writeFileSync(jsonlPath, promptEvent + '\n')
  fs.chmodSync(jsonlPath, 0o666)

  ensureUser()
  recordSessionStart(account.id, sessionId)

  const tmuxName = spawnInTmux({
    sessionId,
    homeDir: account.homeDir,
    workdir,
    prompt,
    jsonlPath,
    logPath,
    // Spec quality determines the whole downstream run — planners always get
    // the strong model at high effort regardless of the objective's tier.
    effort: 'high',
    model: getPlannerModelId(),
    env: buildSpawnEnv({ objective, homeDir: account.homeDir, sessionKind: 'planner' }),
  })

  registerActiveSession(sessionId, {
    logPath,
    jsonlPath,
    startedAt: Date.now(),
    accountId: account.id,
    objective,
    tmuxName,
    requestedModel: getPlannerModelId(),
  })

  return sessionId
}

export async function stopPlannerSession(sessionId: string): Promise<void> {
  return stopSession(sessionId)
}

// ── Reviewer sub-sessions ────────────────────────────────────────────────────
// A reviewer is a Claude Code session that audits a completed worker session
// against the approved plan (when present) and emits <verdict>pass|fail|blocked</verdict>
// plus <findings>…</findings>. The state-poller detects the reviewer's death,
// extracts the verdict, and transitions the objective accordingly.

export async function spawnReviewerSession(objective: Objective): Promise<string> {
  const sessionId = generateReviewerSessionId(objective)
  const workdir = resolveWorkdir(objective)

  // Pull files touched for accurate review scope, and to decide whether the injected
  // ds-*/qa-* vision rubric applies at all (buildVisionRubricBlock skips it on a
  // backend-only change). session_intel is preferred; the PR diff is the fallback when
  // intel is empty, which it routinely is here — this runs at reviewer-SPAWN time, often
  // before the worker session's async extraction has written any file list. Sourcing only
  // from intel meant the rubric injected on backend-only PRs purely because extraction
  // hadn't caught up (obj 705254). Never throws; [] ⇒ unchanged prior behaviour.
  const { files: filesTouched, source: filesTouchedSource } = await resolveFilesTouched(
    getDb(),
    objective,
    { ghExec: realGhExec },
  )
  if (filesTouchedSource === 'pr_diff') {
    console.log(
      `[session-manager] reviewer: obj ${objective.id} file list came from the PR diff ` +
      `(${filesTouched.length} files) — session_intel was empty`,
    )
  }

  // ── Test credentials (optional) ──
  // Fetch direct from the DB (rather than the internal HTTP route) so spawn
  // doesn't depend on the server being able to call itself. If the slug is
  // set but no row matches, log a warning and continue without creds — the
  // reviewer can still do API-only / doc review.
  let testCredFields: Record<string, string> = {}
  let testCredLoginUrl = ''
  let testCredSlug: string | null = null
  if (objective.test_cred_slug) {
    try {
      const row = getDb()
        .prepare('SELECT slug, login_url, fields_encrypted FROM test_credentials WHERE slug = ?')
        .get(objective.test_cred_slug) as { slug: string; login_url: string; fields_encrypted: string } | undefined
      if (!row) {
        console.warn(`[session-manager] Reviewer: test_cred_slug='${objective.test_cred_slug}' not found — continuing without creds`)
      } else {
        const { decryptCredentialFields } = await import('./crypto.js')
        testCredFields = decryptCredentialFields(row.fields_encrypted)
        testCredLoginUrl = row.login_url
        testCredSlug = row.slug
      }
    } catch (err) {
      console.warn(`[session-manager] Reviewer: failed to load test creds for slug='${objective.test_cred_slug}':`, (err as Error).message)
    }
  }

  const credForPrompt = testCredSlug
    ? { slug: testCredSlug, loginUrl: testCredLoginUrl, fieldNames: Object.keys(testCredFields) }
    : null

  // ── UI/UX vision gate (Wave C) ──
  // gateMode 'off' (default) ⇒ rubric dormant + no Playwright config ⇒ reviewer
  // prompt and spawn command byte-identical to the Wave A foundation. The EFFECTIVE
  // mode applies the file-backed config + per-platform allowlist for this objective's
  // project (env UI_GATE_MODE fallback, default 'off'); a project outside a non-empty
  // allowlist resolves to 'off' ⇒ no rubric, no Playwright config for it.
  const gateMode = getEffectiveGateMode(objective.project)
  const isDelegatorWorker = isDelegatorWorkerObjective(objective)

  const prompt = buildReviewerPrompt(objective, filesTouched, credForPrompt, isDelegatorWorker, gateMode)
  const logPath = path.join(TRANSCRIPT_DIR, `${sessionId}.log`)
  const jsonlPath = path.join(TRANSCRIPT_DIR, `${sessionId}.jsonl`)
  fs.mkdirSync(TRANSCRIPT_DIR, { recursive: true })

  const account = pickAccount()
  if (!account) throw new Error('All Claude accounts exhausted — cannot start reviewer')
  console.log(`[session-manager] Reviewer ${sessionId} -> account ${account.id} (${account.label}), workdir=${workdir}, files=${filesTouched.length}, testCreds=${testCredSlug || 'none'}`)

  fs.writeFileSync(logPath, `=== Reviewer ${sessionId} ===\nObjective: ${objective.title}\nMode: ai_review\n${'='.repeat(50)}\n\n`)
  fs.chmodSync(logPath, 0o666)
  const promptEvent = JSON.stringify({ type: 'prompt', text: prompt, title: `Review: ${objective.title}`, timestamp: new Date().toISOString() })
  fs.writeFileSync(jsonlPath, promptEvent + '\n')
  fs.chmodSync(jsonlPath, 0o666)

  ensureUser()
  recordSessionStart(account.id, sessionId)

  // Inject test cred fields as TESTCRED_<UPPER> env vars so the reviewer can
  // reference them without ever materializing the values into its prompt.
  const credEnv: Record<string, string> = {}
  if (testCredSlug) {
    credEnv.TESTCRED_LOGIN_URL = testCredLoginUrl
    for (const [k, v] of Object.entries(testCredFields)) {
      const envName = `TESTCRED_${k.toUpperCase().replace(/[^A-Z0-9_]/g, '_')}`
      credEnv[envName] = v
    }
  }

  // Playwright is for driving a UI. Backend-only PRs already get a "no screen"
  // notice in the prompt; attaching the MCP anyway made the reviewer hunt a
  // browser for ~3 minutes (and often cap out). Empty filesTouched is NOT
  // treated as backend-only, so we still attach when we don't know.
  // UI PRs and a non-off vision gate still get Playwright.
  const attachPlaywright =
    !isBackendOnlyChange(filesTouched) && !!(objective.pr_number || gateMode !== 'off')
  const mcpConfigPath = attachPlaywright
    ? writeReviewerPlaywrightMcpConfig(sessionId, account.homeDir) ?? undefined
    : undefined

  const reviewerModel = getReviewerModelId()
  const tmuxName = spawnInTmux({
    sessionId,
    homeDir: account.homeDir,
    workdir,
    prompt,
    jsonlPath,
    logPath,
    effort: 'low',  // Fresh-context verification doesn't need deep effort — cheap tier.
    model: reviewerModel,
    mcpConfigPath,
    // Reviewer keeps the per-objective TESTCRED_* spread AFTER the consolidated base
    // env (unchanged order) — those are objective-scoped, orthogonal to secret tiering.
    env: { ...buildSpawnEnv({ objective, homeDir: account.homeDir, sessionKind: 'reviewer' }), ...credEnv },
  })

  registerActiveSession(sessionId, {
    logPath,
    jsonlPath,
    startedAt: Date.now(),
    accountId: account.id,
    objective,
    tmuxName,
    requestedModel: reviewerModel,
  })

  return sessionId
}
