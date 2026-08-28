/**
 * Shared runtime types: WebSocket messages, session intel, activity feed,
 * assistant config — extracted from types.ts (behavior frozen).
 *
 * `@command-center/shared` still resolves to types.ts, which re-exports this.
 */
import type { Objective, ObjectiveStatus, SessionMessage } from './types-core.js'
import type { Alert } from './types-surfaces.js'

// ── WebSocket Messages ──

export type ServerMessage =
  | { type: 'objective_updated'; payload: Objective }
  | { type: 'objective_deleted'; payload: { id: number; workspace?: string } }
  | { type: 'terminal_output'; payload: { session_id: string; data: string } }
  | { type: 'state_change'; payload: { objective_id: number; status: ObjectiveStatus } }
  | { type: 'session_intel_ready'; payload: { objective_id: number; intel: SessionIntel } }
  | { type: 'session_stuck'; payload: { objective_id: number; session_id: string; reason: string } }
  | { type: 'activity'; payload: ActivityEvent }
  | { type: 'alert'; payload: Alert }
  | { type: 'alert_acked'; payload: { id: number } }
  | { type: 'error'; payload: { message: string } }

export type ClientMessage =
  | { type: 'terminal_input'; payload: { session_id: string; data: string } }
  | { type: 'subscribe_terminal'; payload: { session_id: string } }
  | { type: 'unsubscribe_terminal'; payload: { session_id: string } }
  // Tells the WS server which workspace this socket is currently viewing so the
  // server can scope admin broadcasts to that workspace (view-leak fix, obj 1001).
  // `workspace: 'all'` (or never sending it) restores the see-everything default.
  | { type: 'set_view_scope'; workspace: string }

// ── Session Messages ──
// SessionMessage lives in types-core.ts (shared with mentor types).

// ── Thread Timeline (collapsed session view) ──

// Collapsed/visible segments of a session thread, computed from SessionMessage[].
export type ThreadSegment =
  | { type: 'summary';  index: number; text: string; cost?: number; duration?: number; timestamp: string }
  | { type: 'question'; index: number; text: string; timestamp: string }   // trailing agent msg in an unfinished turn (question/feedback/status)
  | { type: 'divider';  index: number; text: string; timestamp: string }   // a followup message: child-complete nudge OR user message
  | { type: 'error';    index: number; text: string; timestamp: string }
  | { type: 'actions';  startIndex: number; endIndex: number; count: number; toolCount: number } // collapsed gap [startIndex,endIndex)
export interface ThreadTimeline { total: number; status: string; session_id: string; segments: ThreadSegment[] }
// Tiny short-circuit body returned by ?view=timeline&known=<count> when the
// session has not grown since the client's last poll — avoids re-shipping the
// full segment list every 2s.
export interface ThreadTimelineUnchanged { unchanged: true; total: number; status: string; session_id: string }

// ── Session Intelligence ──

export interface SessionIntel {
  id: number
  objective_id: number
  session_id: string
  account_id: string | null
  started_at: string
  ended_at: string
  duration_ms: number
  total_tokens: number
  total_cost_usd: number
  files_created: string[]
  files_modified: string[]
  commands_run: number
  tool_calls: number
  errors: string[]
  exit_code: number | null
  summary: string | null
  decisions: SessionDecision[]
  blockers: SessionBlocker[]
  follow_ups: SessionFollowUp[]
  skills_used: string[]
  /** Persona slugs invoked during the session — detected from `Read` calls to
   *  `~/ai-workspace/agents/<slug>.md` (routing-table persona adoption). Distinct
   *  from `agent_context` (the primary persona). obj-2387. */
  agents_invoked: string[]
  /** Sub-agent worker types spawned via the `Agent`/`Task` tool (e.g. `Explore`,
   *  `general-purpose`, `qa-reviewer`). obj-2387. */
  subagents_spawned: string[]
  model_usage: Record<string, { tokens: number; cost_usd: number }>
  outcome: 'success' | 'partial' | 'failed' | 'blocked' | null
  extraction_status: 'pending' | 'parsed' | 'summarized' | 'failed'
  created_at: string
}

export interface SessionDecision {
  decision: string
  rationale: string
}

export interface SessionBlocker {
  description: string
  severity: 'critical' | 'moderate' | 'minor'
}

export interface SessionFollowUp {
  task: string
  priority: 'high' | 'medium' | 'low'
  context: string
}

export interface SessionEvent {
  id: number
  session_id: string
  objective_id: number
  event_type: 'decision' | 'blocker' | 'follow_up' | 'error' | 'milestone'
  description: string
  metadata: Record<string, unknown> | null
  created_at: string
}

export interface SessionContext {
  objective_history: SessionBrief[]
  related_decisions: SessionDecision[]
  active_blockers: SessionBlocker[]
  recent_file_ops: { file_path: string; operation: string; session_id: string; objective_title: string }[]
}

export interface SessionBrief {
  session_id: string
  objective_title: string
  agent_context: string
  summary: string | null
  outcome: string | null
  decisions: SessionDecision[]
  follow_ups: SessionFollowUp[]
  ended_at: string
}

// ── Activity Feed ──

export type ActivityEventType =
  | 'session_start' | 'session_end'
  | 'progress' | 'decision' | 'blocker' | 'file_change' | 'milestone' | 'error'

export interface ActivityEvent {
  id: number
  project: string
  workspace: string
  objective_id: number | null
  session_id: string | null
  event_type: ActivityEventType
  title: string
  detail: string | null
  metadata: Record<string, unknown> | null
  created_at: string
}

// ── Generate-Goal Drafter (objective-creation modal) ──

// Request to POST /api/objectives/goal/draft. The drafter turns a rough title
// (+ optional description) into a concise completion goal. If it needs more
// signal it returns clarifying questions; the client answers them and calls
// again with `answers[]`. `skipQuestions` forces a goal on the first call.
export interface GoalDraftRequest {
  title: string
  description?: string
  answers?: { question: string; answer: string }[]
  skipQuestions?: boolean
}

export interface GoalQuestion {
  id: string
  question: string
  options: string[]
}

// Discriminated by `mode`: either a finished goal or a set of clarifying questions.
export type GoalDraftResponse =
  | { mode: 'goal'; goal: string }
  | { mode: 'questions'; questions: GoalQuestion[] }

// ── Status Transition Rules ──

// Legacy untyped transition table. Kept for backward compat with callers that
// don't know the objective's type. Prefer `isTransitionAllowed` from
// `./workflow` when the type is known — it gates the new planning / AI-review
// states correctly.
// Per-user GitHub token (obj-2200 / W1). The masked, API-safe summary of a
// user's linked GitHub PAT. The raw token NEVER appears in this shape — only
// the resolved identity + last-4 fingerprint. `null` from the API means the
// user has not linked a token yet.
export type GithubTokenType = 'pat_fine' | 'pat_classic' | 'app'
export interface UserGithubTokenSummary {
  github_login: string
  github_email: string
  github_user_id: number | null
  token_last4: string
  scopes: string | null
  token_type: GithubTokenType
  created_at: string
  last_validated_at: string | null
}

// Per-user Google Workspace connection (obj-706070). The masked, API-safe view
// of a user's OAuth connection. NO token material of any kind appears in this
// shape — not the refresh token, not the access token, not a last-4 (an OAuth
// refresh token has no user-recognisable suffix, so a fingerprint would leak
// entropy for zero UX value). `null` from the API means "not connected".
export interface UserGoogleConnectionSummary {
  google_email: string
  /** Space-separated granted scopes, straight from Google's token response. */
  scopes: string
  /** OAuth client the connection was granted to (provenance, not a secret). */
  client_id: string
  connected_at: string
  last_refreshed_at: string | null
  /** Last refresh failure message, if the stored refresh token has gone bad. */
  last_error: string | null
}

/** Response of POST /api/user/google/connect — the consent URL to send the user to. */
export interface GoogleConnectStartResponse {
  auth_url: string
}

// ── Personal Assistant config (obj 701700, Phase 1) ─────────────────────────
// Per-(user, workspace) contract that replaces the hardcoded single-user
// ("Mike"/Jarvis) assistant in services/mentor-session.ts with a config-driven,
// multi-tenant one. Mirrors the design kit's config-schema.ts (obj 1786). The
// frontend has its own DTO and does not import this; the server owns it.

/** How much the assistant may do without a human confirmation step. */
export type AutonomyLevel =
  | 'read_only'        // no side-effecting actions at all
  | 'confirm_all'      // every side-effecting action is two-step confirmed
  | 'confirm_external' // only actions that leave the machine are gated (today's behavior)
  | 'autonomous'       // no confirmation gate (advanced/opt-in)

/** Stable id of a capability (bare kebab, e.g. 'send-email'). */
export type CapabilityId = string
/** Stable id of a connector/integration (bare kebab, e.g. 'google-workspace'). */
export type ConnectorId = string

export type KnowledgeSourceKind = 'product_docs' | 'vault' | 'file' | 'url'

export interface KnowledgeSourceRef {
  id: string
  kind: KnowledgeSourceKind
  /** Location interpreted per `kind`. A per-user VALUE — never a baked type. */
  locator: string
  label?: string
  /** If true the assistant may write back to this source. */
  writable?: boolean
}

export interface PersonaConfig {
  /** User-facing name of the assistant (e.g. "Jarvis", "Ada"). Required. */
  displayName: string
  /** One-line role description, used as a short system-prompt preamble. */
  tagline?: string | null
  /** The operating-manual prompt body: persona, tone, rules. */
  systemPrompt: string
  /** Optional pointer to an external persona/manual doc resolved at spawn. */
  manualSource?: KnowledgeSourceRef | null
}

export interface AutonomyConfig {
  level: AutonomyLevel
  /** Per-capability overrides keyed by CapabilityId. */
  overrides?: Record<CapabilityId, AutonomyLevel> | null
}

/**
 * Opaque per-user connector credential binding. Holds only a per-user account
 * `identity` (e.g. an email — replaces the hardcoded USER_GOOGLE_EMAIL) and a
 * `credentialRef` POINTER (env key / secrets path) — never the secret itself.
 */
export interface ConnectorBinding {
  identity: string
  credentialRef: string
  settings?: Record<string, unknown> | null
}

export interface AssistantConfig {
  /** Owning user (FK users.id). */
  userId: number
  /** Workspace scope (same domain as mentor_threads.workspace). */
  workspace: string
  persona: PersonaConfig
  /** Model the session spawns with. Absent ⇒ harness default at spawn. */
  model?: string | null
  autonomy: AutonomyConfig
  enabledCapabilities: CapabilityId[]
  enabledConnectors: ConnectorId[]
  /** Per-connector identity + credential POINTERS (never secrets). */
  connectorBindings?: Record<ConnectorId, ConnectorBinding> | null
  knowledgeSources: KnowledgeSourceRef[]
  /** Soft-disable without deleting config. */
  enabled: boolean
  createdAt: string
  updatedAt: string
}

/** Partial patch body for PUT /api/assistant/config (server merges onto existing). */
export type AssistantConfigPatch = Partial<
  Pick<
    AssistantConfig,
    | 'persona'
    | 'model'
    | 'autonomy'
    | 'enabledCapabilities'
    | 'enabledConnectors'
    | 'connectorBindings'
    | 'knowledgeSources'
    | 'enabled'
  >
>

// AI Review stage transitions (2026-06-06):
//   queue → working → ai_review → (pass → review | fail → working) → done
// With a hard iteration cap (3) the state-poller force-routes ai_review →
// review on cap-hit. `review` is the human review gate (consolidated from
// the prior `human_review` status on 2026-06-08).
// `cancelled` (obj 700595) is reachable from every non-terminal state as a
// soft-retire, and (like `done`) can be reopened to `queue` by hand.
export const VALID_TRANSITIONS: Record<ObjectiveStatus, ObjectiveStatus[]> = {
  planning: ['queue', 'working', 'done', 'cancelled'],
  queue: ['working', 'done', 'cancelled'],
  working: ['ai_review', 'review', 'done', 'cancelled'],
  ai_review: ['review', 'working', 'done', 'cancelled'],
  review: ['working', 'done', 'cancelled'],
  done: ['queue'],
  cancelled: ['queue'],
}

