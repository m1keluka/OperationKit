/**
 * Shared core types: status/agent enums, Objective, AI review —
 * extracted from types.ts (behavior frozen).
 *
 * `@command-center/shared` still resolves to types.ts, which re-exports this.
 */
// ── Enums & Literals ──

// `review` is the human review gate, always positioned after `ai_review`. It
// also catches skip-AI opt-outs, failed-spawn fallbacks, and dead-session
// triage — distinguished on the card via the verdict pill, not via column.
// `cancelled` is a SOFT-RETIRE terminal state (obj 700595). It is distinct from
// `done`: `done` asserts the work completed; `cancelled` retires an objective
// without falsifying history (e.g. a queued child orphaned when its parent
// reached a terminal state, or a stale item retired by the hygiene sweeps). It
// is a terminal sink — nothing auto-advances out of it (a human may reopen it
// to `queue`/`working` by hand).
export type ObjectiveStatus =
  | 'planning'
  | 'queue'
  | 'working'
  | 'ai_review'
  | 'review'
  | 'done'
  | 'cancelled'
export type ObjectiveType = 'project' | 'bug' | 'task'
/**
 * Explicit objective provenance (obj 2386). Written at insert; distinguishes
 * how an objective came to exist rather than inferring it from parent_id.
 *  - 'manual'    — a human created it directly.
 *  - 'strategy'  — a delegator/Strategy decomposed it into a sub-objective.
 *  - 'routine'   — a routine spawned it (a recurring job).
 *  - 'job_reply' — spawned from a job's in-thread "create an objective" reply.
 */
export type ObjectiveOrigin = 'manual' | 'strategy' | 'routine' | 'job_reply'
/**
 * Disposition of a job (routine-spawned objective) once its run is done.
 * - `complete`     — clean run, nothing for Mike to do. Default.
 * - `needs_review` — the run has a question, or surfaced a concrete
 *                    system-improvement opportunity worth Mike's attention.
 */
export type JobDisposition = 'complete' | 'needs_review'
/**
 * Verdict emitted by the AI reviewer session for a single iteration of the
 * AI-Review stage. See `ObjectiveReview` for the per-iteration row.
 * - `pass`    — work meets the locked acceptance criteria; move to human review.
 * - `fail`    — work falls short; bounce back to worker with the report as a
 *               follow-up unless the iteration cap (3) is hit, in which case it
 *               escalates to human review.
 * - `blocked` — reviewer couldn't execute its check (e.g. preview env down);
 *               escalates to human review.
 */
export type AIReviewVerdict = 'pass' | 'fail' | 'blocked'
/**
 * Mode the reviewer self-selects based on the deliverable's testable surface.
 * - `browser` — UI deliverable; reviewer drives Playwright MCP and screenshots.
 * - `api`     — HTTP-callable deliverable; reviewer hits endpoints via curl/fetch.
 * - `doc`     — document/decision/report; reviewer verifies completeness + cites.
 * - `noop`    — research-only deliverable with no testable surface; auto-pass.
 */
export type AIReviewMode = 'browser' | 'api' | 'doc' | 'noop'
export type UserRole = 'admin' | 'member'
/**
 * Every persona file in `~/ai-workspace/agents/*.md` is now an assignable
 * `agent_context` (obj-2387, Mike's decision D7: "every agent should be
 * assignable, and also routing-only/sub-agent designated"). The union below MUST
 * stay in 1:1 sync with the persona files on disk — `AGENT_MAP`/`WORKDIR_MAP`
 * (prompt-builder.ts) are typed `Record<AgentContext, …>`, so the compiler fails
 * the build if a persona is added here without a workdir/file mapping.
 *
 * `AGENT_META` classifies each persona's INTENT (executive vs a specialist
 * normally reached via the CLAUDE.md routing table or spawned as a sub-agent).
 * All are assignable; `kind` only drives UI labeling — nothing is silently
 * missing from the picker.
 */
export type AgentContext =
  | 'cto' | 'cmo' | 'coo' | 'cfo' | 'general' | 'designer' | 'hr' | 'general-counsel'
  | 'chief-of-staff' | 'assistant' | 'campaign-auditor' | 'campaign-launcher'
  | 'data-sourcing' | 'fundraising-advisor' | 'example2-campaign-ops' | 'ma-advisor' | 'rolodex'

/** Persona intent. `executive` = a top-level role you assign an objective to
 *  directly; `routing-only` = a specialist normally invoked via the routing
 *  table or spawned as a sub-agent — still assignable, but labeled so operators
 *  understand it isn't a primary executive. */
export type AgentKind = 'executive' | 'routing-only'
export interface AgentMeta {
  /** Whether the persona can be selected as an objective's primary agent. All
   *  17 are `true` today; the field exists so a persona could be hidden later
   *  without being dropped from the union (and from `AGENT_MAP`). */
  assignable: boolean
  kind: AgentKind
  /** Short human label for the UI. */
  label: string
}
export const AGENT_META: Record<AgentContext, AgentMeta> = {
  cto: { assignable: true, kind: 'executive', label: 'CTO' },
  cmo: { assignable: true, kind: 'executive', label: 'CMO' },
  coo: { assignable: true, kind: 'executive', label: 'COO' },
  cfo: { assignable: true, kind: 'executive', label: 'CFO' },
  hr: { assignable: true, kind: 'executive', label: 'HR' },
  'general-counsel': { assignable: true, kind: 'executive', label: 'General Counsel' },
  designer: { assignable: true, kind: 'executive', label: 'Designer' },
  'chief-of-staff': { assignable: true, kind: 'executive', label: 'Chief of Staff' },
  general: { assignable: true, kind: 'executive', label: 'General' },
  assistant: { assignable: true, kind: 'routing-only', label: 'Assistant' },
  'campaign-auditor': { assignable: true, kind: 'routing-only', label: 'Campaign Auditor' },
  'campaign-launcher': { assignable: true, kind: 'routing-only', label: 'Campaign Launcher' },
  'data-sourcing': { assignable: true, kind: 'routing-only', label: 'Data Sourcing' },
  'fundraising-advisor': { assignable: true, kind: 'routing-only', label: 'Fundraising Advisor' },
  'example2-campaign-ops': { assignable: true, kind: 'routing-only', label: 'EXAMPLE2 Campaign Ops' },
  'ma-advisor': { assignable: true, kind: 'routing-only', label: 'M&A Advisor' },
  rolodex: { assignable: true, kind: 'routing-only', label: 'Rolodex' },
}
/**
 * Workspace slugs are dynamic (sourced from the `workspaces` table); this is
 * just a string. The literal value `'all'` is used by the UI as the cross-
 * workspace sentinel, not as a real slug.
 */
export type Workspace = string
export type ObjectiveCategory = 'development' | 'operations' | 'marketing' | 'finance' | 'legal' | 'general'
export type WorkflowHint = 'fan-out' | 'adversarial' | 'tournament' | 'loop-until-done' | 'classify-and-act'
export type EffortLevel = 'normal' | 'high' | 'ultracode'
// Model id is now a free string sourced from the DB-backed model registry
// (server: services/model-registry.ts, table `models`). MODEL_CHOICES /
// MODEL_LABELS below are kept only as static display fallbacks; the registry —
// surfaced via GET /api/models — is the runtime source of truth.
export type ModelChoice = string
export type ModelEngine = 'claude' | 'codex' | 'grok'

/** A model as configured in the registry. Drives the objective dropdown and the
 *  default/planner selection. */
export interface ModelRow {
  id: string
  label: string
  engine: ModelEngine
  enabled: boolean
  is_default: boolean
  is_planner: boolean
  sort_order: number
}

/** GET /api/models response: enabled models + the configured default id. */
export interface ModelsConfig {
  models: ModelRow[]
  default: string
}

export const OBJECTIVE_STATUSES: ObjectiveStatus[] = [
  'planning', 'queue', 'working', 'ai_review', 'review', 'done', 'cancelled',
]
export const OBJECTIVE_TYPES: ObjectiveType[] = ['project', 'bug', 'task']
// Order: executives first (the common assignment targets), then routing-only
// specialists. The picker can group on `AGENT_META[a].kind`.
export const AGENT_CONTEXTS: AgentContext[] = [
  'cto', 'cmo', 'coo', 'cfo', 'general', 'designer', 'hr', 'general-counsel', 'chief-of-staff',
  'assistant', 'campaign-auditor', 'campaign-launcher', 'data-sourcing',
  'fundraising-advisor', 'example2-campaign-ops', 'ma-advisor', 'rolodex',
]
export const OBJECTIVE_CATEGORIES: ObjectiveCategory[] = ['development', 'operations', 'marketing', 'finance', 'legal', 'general']
export const WORKFLOW_HINTS: WorkflowHint[] = ['fan-out', 'adversarial', 'tournament', 'loop-until-done', 'classify-and-act']
export const EFFORT_LEVELS: EffortLevel[] = ['normal', 'high', 'ultracode']
export const MODEL_CHOICES: ModelChoice[] = ['claude-opus-5', 'claude-fable-5', 'claude-opus-4-8', 'claude-sonnet-4-6', 'grok-4.6', 'codex']
export const MODEL_LABELS: Record<ModelChoice, string> = {
  'claude-opus-5': 'Opus 5',
  'claude-fable-5': 'Fable 5',
  'claude-opus-4-8': 'Opus 4.8',
  'claude-sonnet-4-6': 'Sonnet 4.6',
  'codex': 'Codex (ChatGPT sub)',
  'grok-4.6': 'Grok 4.6',
}

/**
 * Workspace record as returned by GET /api/workspaces.
 * Replaces the previous `WORKSPACES` constant — UI fetches at runtime.
 */
export interface WorkspaceRecord {
  slug: string
  name: string
  short_label: string | null
  badge_color: string | null
  vault_path: string | null
  doc_read_roots: string[]
  doc_write_roots: string[]
  default_agent_pool: string[]
  archived: boolean
  sort_order: number
  created_at: string
  updated_at: string
}
export const MAX_CONCURRENT_SESSIONS = 100

// ── Domain Models ──

export type ObjectiveVisibility = 'own' | 'all'

export interface UserWorkspace {
  workspace: string
  role: UserRole
  can_use_jarvis?: boolean
  objective_visibility?: ObjectiveVisibility
}

export interface User {
  id: number
  username: string
  role: UserRole
  workspaces?: UserWorkspace[]
  created_at: string
}

/** Row returned by GET /api/admin/workspaces/:ws/users (server side). */
export interface WorkspaceMembership {
  user_id: number
  username: string
  workspace: string
  role: UserRole
  can_use_jarvis: boolean
  objective_visibility: ObjectiveVisibility
}

/** Body for POST /api/admin/workspaces/:ws/users. */
export interface GrantWorkspaceRequest {
  user_id: number
  role?: UserRole
  can_use_jarvis?: boolean
  objective_visibility?: ObjectiveVisibility
}

/** Body for POST /api/admin/users. */
export interface CreateUserRequest {
  username: string
  password: string
  role?: UserRole
}

/** Body for POST /api/admin/users/:id/reset-password. */
export interface ResetPasswordRequest {
  password: string
}

/** One pull request opened from an objective (obj 2300). The full log lives in
 *  the `objective_prs` table; an objective may have many. `state` is freshened
 *  by the GitHub `pull_request` webhook (merged/closed). */
export type ObjectivePRState = 'open' | 'merged' | 'closed'

export interface ObjectivePR {
  id: number
  objective_id: number
  repo: string | null
  pr_number: number
  pr_url: string | null
  branch_name: string | null
  title: string | null
  state: ObjectivePRState
  created_at: string
  updated_at: string
}

// ── Projects ──

/**
 * A named sub-folder within a workspace that groups objectives.
 * DISTINCT from the `objectives.project` repo-link column.
 */
export interface Project {
  id: number
  workspace: string
  name: string
  description: string | null
  color: string | null
  sort_order: number
  archived: boolean
  /** Number of non-deleted objectives assigned to this project (server-computed). */
  objective_count?: number
  created_at: string
  updated_at: string
}

export interface Objective {
  id: number
  title: string
  description: string
  status: ObjectiveStatus
  agent_context: AgentContext
  workspace: string
  /** Repo-link: the git repo folder name under /home/operator/projects (e.g. 'command-center-infra').
   *  DISTINCT from project_id (the board Project grouping). */
  project: string | null
  /** Board-Project association: FK to projects.id. NULL = unassigned.
   *  DISTINCT from `project` (the repo-link column). */
  project_id: number | null
  category: ObjectiveCategory
  parent_id: number | null
  depth: number
  assigned_user_id: number | null
  /** Full assignee set from the objective_assignees join table (includes the
   *  primary). Populated by the server's mapObjective; optional because raw
   *  rows don't carry it. */
  assigned_user_ids?: number[]
  /** Human usernames for each id in assigned_user_ids, SAME order (primary first),
   *  resolved from users.username by the server's mapObjective (obj 700850). Ids
   *  with no matching user are dropped. Optional because raw rows don't carry it. */
  assigned_usernames?: string[]
  /** Set when this objective was spawned by a routine (routines engine).
   *  A non-null routine_id is what makes an objective a "job" (Jobs surface). */
  routine_id: number | null
  /** Jobs disposition (only meaningful when routine_id is set). 'complete'
   *  (default) or 'needs_review'. Set by the job session at end-of-run via
   *  POST /api/internal/objectives/:id/job-disposition. */
  job_disposition?: JobDisposition | null
  /** Short operator-facing reason a job flagged itself needs_review. */
  job_review_note?: string | null
  /** Backlink: when this objective was spawned from a job's in-thread reply
   *  ("create an objective for X"), this is that job's objective id. */
  source_job_id?: number | null
  created_by: number | null
  session_id: string | null
  transcript_path: string | null
  last_session_summary: string | null
  session_count: number
  total_cost_usd: number
  total_tokens: number
  has_blockers: boolean
  /** Delegator mode: when true, the owning agent orchestrates worker objectives
   *  instead of implementing directly. SQLite stores 0/1; server casts to bool. */
  delegate_mode: boolean
  /** Stored Strategy marker (obj 2383). True for the canonical top tier of the
   *  hierarchy — a persistent top-level delegator (parent_id IS NULL &&
   *  delegate_mode) that owns sub-objectives + jobs and re-wakes to decide.
   *  Written at creation; replaces inferring "strategy" from depth + delegate_mode.
   *  Kept SEPARATE from the orthogonal `type` tag. See docs/terminology-glossary.md.
   *  SQLite stores 0/1; server casts to bool. */
  is_strategy: boolean
  /** Strategy progressive-trust stage (obj 2511) on the 0–3 autonomy ladder
   *  (gating framework §2): 0 = full-gate (default, every decision parks for a
   *  human), 1 = partial-autonomy, 2 = supervised-autonomy, 3 = autonomous.
   *  Only meaningful on a strategy (is_strategy=1). What is auto-allowed vs
   *  gated at a stage is the pure `decideTrustStageAction`. Plain INTEGER —
   *  flows through mapObjective's spread unchanged (no bool cast). */
  trust_stage: number
  /** Explicit provenance (obj 2386): how this objective was created. Written at
   *  insert, NOT inferred from parent_id. 'manual' = human-created; 'strategy' =
   *  delegator-decomposed sub-objective; 'routine' = routine-spawned job;
   *  'job_reply' = spawned from a job's in-thread reply. Defaults to 'manual'. */
  origin: ObjectiveOrigin
  /** The Strategy (is_strategy=1 objective) this objective belongs to or is
   *  associated with (obj 2386). Inherited from the parent chain at insert, or
   *  set explicitly on a manual objective (even when parent_id IS NULL) so it
   *  can show its strategy. NULL = unassociated. */
  strategy_id?: number | null
  /** Durable wake-storm guard for the delegator reconcile safety net: the
   *  child-state signature the net last nudged for. Persisted so an all-done
   *  delegator parked in `review` is not spuriously re-nudged on server restart.
   *  NULL until first recorded; cleared when the delegator reaches `done`. */
  reconcile_sig?: string | null
  /** Durable no-progress circuit breaker for the delegator liveness BACKSTOP
   *  (obj 707460) — sibling of `reconcile_sig`, for the sweep that is
   *  time-throttled instead of signature-gated. `backstop_sig` is the child-state
   *  + durable-write signature seen at the last backstop wake;
   *  `backstop_noprogress` counts consecutive wakes where it did not change. */
  backstop_sig?: string | null
  backstop_noprogress?: number
  /** Human-terminal marker (obj 700415). 1 when a human ended this objective via
   *  the public surface (PATCH → done/review); 0 after an explicit human reopen.
   *  Machine reactivation pathways consult it under CC_HUMAN_TERMINAL_GUARD
   *  (default OFF → dry-run). SQLite stores 0/1; server casts to bool. */
  terminal_by_human: boolean
  /** Soft-delete tombstone (obj 700415). NULL = live; a timestamp = soft-deleted.
   *  Only written when settings.soft_delete_enabled is on; list endpoints hide
   *  non-null rows unless ?include_deleted=1. */
  deleted_at?: string | null
  create_pr: boolean
  branch_name: string | null
  pr_url: string | null
  pr_number: number | null
  /** Full per-objective PR history (obj 2300). Multiple PRs may be opened from a
   *  single objective; objectives.pr_url/pr_number above stay as the "latest"
   *  pointer, while `prs` carries the complete log. Hydrated by the read paths
   *  that embed it (objective detail / dedicated /prs endpoint); undefined on the
   *  list payloads that don't. */
  prs?: ObjectivePR[]
  /** Running count of scope-bleed warnings raised against this objective (obj 994). */
  scope_flags?: number
  completion_goal: string | null
  workflow_hint: string | null
  effort: EffortLevel
  model: ModelChoice
  /** Durable Fable→Opus fallback attribution marker (audit 2026-07-04). True when
   *  scanStreamTelemetry detected the session actually ran on the --fallback-model
   *  (Opus) despite `model` requesting another model. SQLite stores 0/1; the server
   *  casts to boolean before serializing. Drives the "ran on Opus fallback" card badge. */
  ran_on_fallback: boolean
  /** ISO timestamp of the first fallback detection, or null if never. */
  fallback_detected_at: string | null
  /** Positive transcript-derived attribution (obj 701053): comma-joined MAIN-LOOP
   *  model ids that actually ran across this objective's sessions (sub-agent /
   *  helper models excluded), e.g. 'claude-fable-5'. Null until first scan. */
  ran_model: string | null
  type: ObjectiveType
  approved_plan: string | null
  plan_approved_at: string | null
  planning_session_id: string | null
  ai_review_verdict: AIReviewVerdict | null
  ai_review_findings: string | null
  ai_review_session_id: string | null
  /** Per-objective opt-out from the AI Review stage. SQLite stores 0/1; the
   *  server casts to boolean before serializing. */
  skip_ai_review: boolean
  /** Reviewer-generated acceptance criteria, locked after iteration 1 and
   *  reused as the rubric for iterations 2–3. Stored as JSON in SQLite. */
  acceptance_criteria: AcceptanceCriterion[] | null
  /** Current worker↔reviewer cycle count. 0 = no review has run yet. Hard
   *  capped at 3 by the state poller. */
  ai_review_iteration: number
  /** Pointer into `test_credentials.slug`; null means the reviewer falls
   *  back to a workspace+project lookup at spawn time. */
  test_cred_slug: string | null
  created_at: string
  updated_at: string
  /** Denormalized last-activity timestamp (obj 700850): the most recent moment the
   *  agent side did/sent something for this objective = MAX(session_intel.ended_at),
   *  advanced forward-only when a session's intel is written. NULL when the objective
   *  has no sessions (the board falls back to updated_at). */
  last_activity_at: string | null
}

// ── AI Review Stage ──

/**
 * Reviewer-generated acceptance criterion. Locked to the objective after
 * iteration 1 so iterations 2–3 test against the same rubric.
 */
export interface AcceptanceCriterion {
  id: string
  criterion: string
  type: 'functional' | 'visual' | 'data'
  // 'static' = a deterministic, model-free check (e.g. `scripts/ui-conformance.sh`
  // on the diff). Additive; existing criteria are unaffected.
  method: 'browser' | 'api' | 'doc' | 'static'
}

/**
 * Per-criterion result emitted by the reviewer for a single iteration.
 * Stored inside `ObjectiveReview.criteria_results` (JSON column on disk).
 */
export interface AcceptanceCriterionResult {
  criterion_id: string
  status: 'pass' | 'fail' | 'skipped'
  evidence: string
  screenshot_path?: string | null
}

/**
 * One row per AI Review iteration. The state poller reads the latest row to
 * decide the next status transition. Markdown body is rendered in the
 * SessionViewer "AI Review" tab.
 */
export interface ObjectiveReview {
  id: number
  objective_id: number
  iteration: number
  reviewer_session_id: string
  mode: AIReviewMode
  verdict: AIReviewVerdict
  criteria_results: AcceptanceCriterionResult[]
  screenshot_paths: string[]
  markdown_body: string
  /** Stakeholder feature brief emitted by the reviewer (obj 937). JSON-stringified FeatureBrief. */
  feature_brief: string
  cost_usd: number
  duration_ms: number
  created_at: string
}

// ── Session Messages ──
// Lives here so mentor types (types-surfaces) and the thread timeline
// (types-runtime) can share it without a circular import.

export interface SessionMessage {
  type: 'assistant' | 'user' | 'system' | 'tool' | 'result' | 'error' | 'followup'
  text?: string
  toolName?: string
  toolInput?: string
  toolResult?: string
  cost?: number
  duration?: number
  input_tokens?: number
  timestamp: string
  // Robust tool_use ↔ tool_result pairing by real Anthropic id (fixes
  // parallel/interleaved tool calls). Present on both the `tool` message
  // (from block.id) and the `user`/toolResult message (from block.tool_use_id).
  toolUseId?: string
  // Token-by-token ("typewriter") streaming: true while an assistant message
  // is still coalescing partial text deltas; cleared/false once the final
  // complete assistant event finalizes the text.
  streaming?: boolean
}

