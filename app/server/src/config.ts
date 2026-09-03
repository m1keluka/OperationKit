/**
 * Centralized configuration — all paths, constants, and env-backed settings.
 * Import from here instead of hardcoding paths across the codebase.
 */

// ── Base Directories ──
export const PROJECTS_DIR = process.env.PROJECTS_DIR || '/home/operator/projects'
export const AI_WORKSPACE_DIR = process.env.AI_WORKSPACE_DIR || '/home/operator/ai-workspace'

// ── Live (served) checkout (obj-1150 drift guard) ──
// The running server reads its source from this bind-mounted checkout. Uncommitted
// edits here are "live but unbacked" — one `git reset` from silent deletion and
// invisible on origin/main. The drift guard (services/drift-guard.ts) watches it.
export const CC_REPO_DIR = process.env.CC_REPO_DIR || `${PROJECTS_DIR}/command-center-infra`
// Paths (repo-relative) that are bind-mounted and actually served by the running
// process. Dirtiness here = live-but-unbacked production. Untracked/dirty files
// OUTSIDE these prefixes (e.g. scripts/*.mjs scratch files) are harmless and MUST
// NOT trip the guard.
export const CC_SERVED_PATHS = ['app/server/src', 'app/client/src', 'app/shared', 'app/client/dist']
export const SECOND_BRAIN_DIR = process.env.SECOND_BRAIN_DIR || '/home/operator/second-brain'
export const TRANSCRIPT_DIR = process.env.TRANSCRIPT_DIR || '/home/operator/transcripts'
export const ASSISTANT_DIR = process.env.ASSISTANT_DIR || '/home/operator/assistant'
export const HOME_DIR = process.env.USER_HOME || '/home/mike'

// ── Derived Paths ──
export const AGENTS_DIR = `${AI_WORKSPACE_DIR}/agents`
export const SKILLS_DIR = `${AI_WORKSPACE_DIR}/skills`
export const WORKSPACES_JSON = `${AI_WORKSPACE_DIR}/workspaces.json`
export const MENTOR_WORKDIR = `${AI_WORKSPACE_DIR}/mentor-workspace`
export const MINION_DIR = `${AI_WORKSPACE_DIR}/scripts/minions`
export const SKILLS_REGISTRY = `${SKILLS_DIR}/registry.json`
export const VAULT_ROOT = SECOND_BRAIN_DIR
export const DOPPLER_TOKEN_PATH = `${PROJECTS_DIR}/.doppler-admin-token`
// accept-new: record the host key on first connect, reject later MITM.
// IdentitiesOnly: never offer extra keys from the agent / default files.
export const GIT_SSH_COMMAND = `ssh -i ${HOME_DIR}/.ssh/id_ed25519 -o StrictHostKeyChecking=accept-new -o IdentitiesOnly=yes`

// ── Account Router ──
export const ACCOUNT_STATE_FILE = `${TRANSCRIPT_DIR}/account-router-state.json`
export const RATE_LIMIT_LOG = `${TRANSCRIPT_DIR}/rate-limit-history.jsonl`

// ── Session Defaults ──
export const MAX_BUDGET_NORMAL = 50
export const MAX_BUDGET_HIGH = 75
export const MAX_BUDGET_ULTRACODE = 100

// ── Runaway Caps (ST3) ──
// Per-spawn turn cap on the worker's `claude` command. The per-spawn dollar
// ceiling (`--max-budget-usd`) resets every respawn, so an unbounded multi-turn
// agent could loop forever within one spawn; a turn cap is the hard backstop.
// Generous default so healthy long sessions are not truncated. Set <=0 to omit.
//
// Interaction with MAX_TURNS_AUTO_CONTINUE: when a PRODUCTIVE session hits this
// cap the CLI exits with a `error_max_turns` result. Rather than stranding it in
// `review` for a manual Resume, the poller auto-continues the SAME session
// (claude --resume) up to MAX_TURNS_AUTO_CONTINUE times (see below). Each resume
// gets a fresh SPAWN_MAX_TURNS budget, so a genuine runaway keeps re-hitting the
// cap and is stopped once the auto-continue bound is exhausted. The cumulative
// cost/token ceilings (AI_REVIEW_BUDGET_CEILING_USD / SPAWN_MAX_OUTPUT_TOKENS)
// and the idle/wall-clock watchdog (below) bound true runaways independently of
// this turn cap, so auto-continue can never loop unbounded.
export const SPAWN_MAX_TURNS = parseInt(process.env.SPAWN_MAX_TURNS || '150', 10)
// Max number of times a single session is auto-continued after hitting
// SPAWN_MAX_TURNS while still productive. A healthy session that merely ran out
// of turns resumes (claude --resume) instead of dumping to manual review; a
// genuine runaway re-hits the cap each resume and, once this bound is reached,
// falls through to normal review routing. Tracked per-objective in memory
// (cleared on restart and on any non-turns death). Set to 0 to DISABLE
// auto-continue entirely (every max_turns death routes straight to review).
// Bounded deliberately small — the cost/token ceilings and the idle/wall-clock
// watchdog are the broader runaway backstops; this only smooths over the common
// case of a long-but-healthy session clipping the per-spawn turn budget.
export const MAX_TURNS_AUTO_CONTINUE = parseInt(process.env.MAX_TURNS_AUTO_CONTINUE || '3', 10)
// Per-response output-token ceiling, applied via the `CLAUDE_CODE_MAX_OUTPUT_TOKENS`
// env the CLI honours (there is no session-total token CLI flag). Bounds a single
// runaway response. Set <=0 to omit.
export const SPAWN_MAX_OUTPUT_TOKENS = parseInt(process.env.SPAWN_MAX_OUTPUT_TOKENS || '32000', 10)

// ── Session spawn-env scoping (obj-2202 / onboarding gate B1–B4) ──
// These flags scope which secrets/capabilities a spawned session's env carries,
// keyed by spawn tier (admin vs member). They ALL default to OFF, where OFF means
// "exact current behavior" — every session gets the broadcast Doppler admin token
// and the org Supabase token, identically. Flipping a flag ON is a Mike-gated,
// irreversible cutover step (provision scoped tokens FIRST, then flip, then rotate
// the broadcast admin token) — see app/server/SPAWN-ENV-SCOPING-CUTOVER.md. Do NOT
// enable these in a committed default or env file: turning them on before a scoped
// service token is provisioned would hand member sessions an empty DOPPLER_TOKEN.
function envFlag(name: string): boolean {
  const v = (process.env[name] || '').trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'yes' || v === 'on'
}
/** Same as envFlag, but unset ⇒ ON. Explicit 0/false/off rolls back. */
function envFlagDefaultOn(name: string): boolean {
  const v = (process.env[name] || '').trim().toLowerCase()
  if (!v) return true
  if (v === '0' || v === 'false' || v === 'no' || v === 'off') return false
  return envFlag(name)
}
const spawnEnvFlag = envFlag
// gate B1: when ON, member-spawned sessions get a read-only, project-scoped Doppler
// token (resolved by the objective's workspace/project) instead of the personal
// admin token; admin-spawned sessions are unaffected. OFF ⇒ admin token everywhere.
export const USE_SCOPED_DOPPLER_TOKENS = spawnEnvFlag('USE_SCOPED_DOPPLER_TOKENS')
// gate B4: when ON, the org-wide SUPABASE_ACCESS_TOKEN is withheld from
// member-spawned sessions; admin-spawned sessions are unaffected. OFF ⇒ current
// behavior (token injected into every session).
export const SCOPE_SUPABASE_ACCESS_TOKEN = spawnEnvFlag('SCOPE_SUPABASE_ACCESS_TOKEN')

// Native secrets store injection. ON by default (Doppler retired). Set
// USE_SCOPED_SECRETS=0 to skip injecting store keys into spawn env (rollback).
// Sessions get env vars from the store; they do not get a DOPPLER_TOKEN.
export const USE_SCOPED_SECRETS = envFlagDefaultOn('USE_SCOPED_SECRETS')

// ── Watchdog (ST3) ──
// A worker whose JSONL has been idle (no new events) for longer than this is
// force-routed to `review` — closes the indefinite-hang path. MUST be larger
// than the soft idle ALERT threshold (30 min) so we alert long before we act.
export const WATCHDOG_IDLE_FORCE_MS = parseInt(process.env.WATCHDOG_IDLE_FORCE_MS || `${90 * 60 * 1000}`, 10)
// Absolute wall-clock budget for a single worker spawn. Beyond this the worker
// is force-routed to `review` regardless of activity. Generous (8h) by default.
export const WATCHDOG_WALLCLOCK_MS = parseInt(process.env.WATCHDOG_WALLCLOCK_MS || `${8 * 60 * 60 * 1000}`, 10)
// ── Delegator liveness backstop ──
// A delegate_mode objective is EXEMPT from the watchdog (`&& !delegate_mode`)
// and the orphan sweep (`delegate_mode = 0`), so a delegator wedged in `working`
// with no live session and a reconcile signature already 'spent' (a
// coalesced/missed wake, a crashed nudge-spawn, session_id nulled by the
// failed-resume drop, or 0 children) has NO time-based recovery net and can sit
// in `working` forever. `sweepWedgedDelegators` closes that gap: once a delegator
// has been wedged (no live session) longer than this, it is nudged — bypassing
// the durable spent-signature gate reconcile is subject to — or, if it has no
// actionable work, force-routed to `review` so a human can pick it up. Generous
// (30 min) so a healthy delegator legitimately parked waiting on long-running
// workers is not disturbed. This backstop is TIME-throttled, never signature-gated.
export const DELEGATOR_BACKSTOP_MS = parseInt(process.env.DELEGATOR_BACKSTOP_MS || `${30 * 60 * 1000}`, 10)
// ── Session Mining (dream-cycle → lesson promotion) ──
// A failure signal (blocker/error/failed-session) is promoted to a durable
// lesson only when it recurs across at least this many DISTINCT objectives —
// keeps one-off failures out of the platform-wide context. Conservative default.
export const SESSION_MINING_MIN_RECURRENCE = parseInt(process.env.SESSION_MINING_MIN_RECURRENCE || '3', 10)
// Only mine signals from the last N days so stale failure modes age out.
export const SESSION_MINING_LOOKBACK_DAYS = parseInt(process.env.SESSION_MINING_LOOKBACK_DAYS || '30', 10)
// Sentinel session_id under which mined lessons are stored in objective_learnings,
// so the miner can replace its own rows idempotently and context-builder can read them back.
export const SESSION_MINING_SENTINEL = 'session-mining'
// Cap how many mined lessons get surfaced into a single spawn context.
export const SESSION_MINING_MAX_SURFACED = parseInt(process.env.SESSION_MINING_MAX_SURFACED || '5', 10)

// ── Tree-first session context (P1-2 of the graph-setup proposal, gap G8) ──
// When ON, `services/context-builder.ts` orders the "Active Blockers Across
// System" and "Recently Modified Files" sections TREE-FIRST — same objective →
// siblings (same parent_id) → parent → children → same workspace → platform-wide
// — with the global tier filling only the remaining slots of the existing LIMIT.
// OFF (the committed default) means the original queries run VERBATIM and the
// assembled context is byte-identical to today.
//
// It is deliberately default-OFF and deliberately a FLAG rather than a straight
// cutover: this is the one recommendation in the proposal whose sign is
// uncertain. Cross-tree serendipity ("some unrelated session just touched the
// file you are about to edit") is a real benefit of the current global ordering,
// and demoting it below the tree could cost more than the sibling context it
// buys. Ship both orderings, measure, then decide.
//
// Read LAZILY (a function, not a module-load constant) so the ordering can be
// flipped for a single deploy — and asserted both ways in one test process.
export function contextTreeFirstEnabled(): boolean {
  return envFlag('CONTEXT_TREE_FIRST')
}

// ── Server ──
export const SERVER_PORT = parseInt(process.env.PORT || '3002', 10)
export const CORS_ORIGINS = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',')
  : ['https://cc.example.com', 'http://localhost:5173', 'http://localhost:3002']
