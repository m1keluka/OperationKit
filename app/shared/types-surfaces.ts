/**
 * Shared platform types: corrections, changelog, secrets, mentor, alerts,
 * workspaces, API request/response — extracted from types.ts (behavior frozen).
 *
 * `@operationkit/shared` still resolves to types.ts, which re-exports this.
 */
import type {
  AgentContext,
  EffortLevel,
  ModelChoice,
  ObjectiveCategory,
  ObjectiveStatus,
  ObjectiveType,
  SessionMessage,
  User,
} from './types-core.js'

// ── Human Corrections (ST5 mistake-labeling surface) ──

/**
 * A human-submitted correction: "this session got X wrong." Each active row is
 * injected as a high-priority gotcha into the next spawn's context for the same
 * objective (and sibling objectives of the same agent role in the workspace).
 */
export interface Correction {
  id: number
  objective_id: number
  session_id: string | null
  workspace: string | null
  agent_context: string | null
  label: string
  created_by: number | null
  active: boolean
  created_at: string
}

export interface CreateCorrectionRequest {
  label: string
}

// ── Stakeholder changelog (obj 937) ──

/**
 * Stakeholder-facing brief the AI reviewer produces as part of the PR audit —
 * the reviewer already drives the feature in a browser and captures screenshots,
 * so it is positioned to explain what shipped in plain English. Emitted in the
 * reviewer's `<feature_brief>` block and parsed by the state poller.
 */
export interface FeatureBrief {
  /** One-line plain-English headline a non-technical stakeholder understands. */
  headline: string
  /** 1–3 sentence plain-English description of what the feature does for users. */
  description: string
  /** How-it-works overview: the flow / what happens behind the scenes, in plain terms. */
  overview: string
  /** Whether this change is worth showing stakeholders (false for pure refactors/chores). */
  audience_worthy: boolean
}

export type ChangelogCategory = 'feature' | 'fix' | 'improvement' | 'infra'
export type ChangelogStatus = 'published' | 'draft' | 'skipped'

/**
 * One normalized "What's Shipping" entry — a merged, stakeholder-worthy PR. Fed
 * by the org-level GitHub webhook (collector), enriched from objective_reviews
 * when the PR was audited by this harness, translated into non-jargon copy.
 */
export interface ChangelogEntry {
  id: number
  repo: string
  pr_number: number
  pr_url: string
  merge_commit_sha: string | null
  platform: string
  author: string | null
  merged_at: string
  category: ChangelogCategory
  status: ChangelogStatus
  title_eng: string
  headline: string
  body_stakeholder: string
  overview: string
  feature_brief: string
  screenshots: string[]
  objective_id: number | null
  created_at: string
  updated_at: string
}

// ── Test Credentials ──

/**
 * Test credential set surfaced through the Settings UI and consumed by the
 * AI Reviewer at session spawn time. `fields` is decrypted on the wire (the
 * SQLite column is AES-256-GCM encrypted at rest via services/crypto.ts).
 */
export interface TestCredential {
  slug: string
  workspace: string
  project: string | null
  label: string
  login_url: string
  /** Plaintext key→value pairs. Server decrypts on read; client never sees
   *  the encrypted form. */
  fields: Record<string, string>
  notes: string | null
  created_by: number | null
  created_at: string
  updated_at: string
}

/** Body for POST /api/test-credentials. Fields are plaintext on the wire and
 *  encrypted server-side before persistence. */
export interface CreateTestCredentialRequest {
  slug: string
  workspace: string
  project?: string | null
  label: string
  login_url: string
  fields: Record<string, string>
  notes?: string | null
}

/** Body for PUT /api/test-credentials/:slug. All fields optional — only
 *  provided keys are updated. `fields`, when present, fully replaces the
 *  encrypted blob. */
export interface UpdateTestCredentialRequest {
  workspace?: string
  project?: string | null
  label?: string
  login_url?: string
  fields?: Record<string, string>
  notes?: string | null
}

// ── Native scoped secrets store (obj-2353) ──
//
// Wire contract for the secrets-store surfaces. These mirror the service-layer
// types in server/src/services/secrets-store.ts EXACTLY. The decrypted value
// NEVER appears in any of these shapes — `SecretSummary` is metadata only, so
// "raw never returned after write" is guaranteed by the type itself.

export type SecretScopeType = 'global' | 'workspace' | 'user' | 'workspace_user'

/** Metadata-only view of a stored secret. NEVER carries the value. */
export interface SecretSummary {
  id: number
  scopeType: SecretScopeType
  workspace: string | null
  userId: number | null
  key: string
  version: number
  createdBy: number | null
  updatedBy: number | null
  createdAt: string
  updatedAt: string
}

/** One entry in a secret's version history (metadata only). */
export interface SecretVersionSummary {
  version: number
  changedBy: number | null
  changedAt: string
}

/** Body for POST /api/secrets — create-or-update a secret at a scope. The
 *  plaintext `value` is sent once over TLS and encrypted server-side; it is
 *  never echoed back (the response is a `SecretSummary`). */
export interface SetSecretRequest {
  scopeType: SecretScopeType
  workspace?: string | null
  userId?: number | null
  key: string
  value: string
}

/** Body for POST /api/secrets/rollback — re-apply a prior version as a new one. */
export interface RollbackSecretRequest {
  scopeType: SecretScopeType
  workspace?: string | null
  userId?: number | null
  key: string
  toVersion: number
}

/** Body for POST /api/secrets/move — re-scope an existing secret WITHOUT
 *  re-entering its value. The server re-parents the row (same ciphertext, same
 *  version history); the plaintext is never decrypted, sent, or returned. */
export interface MoveSecretRequest {
  scopeType: SecretScopeType
  workspace?: string | null
  userId?: number | null
  key: string
  to: {
    scopeType: SecretScopeType
    workspace?: string | null
    userId?: number | null
  }
}

/** GET /api/secrets/principals — the organizations and users the caller may
 *  target when choosing a scope. Powers the admin scope pickers so the UI never
 *  has to ask for a raw numeric user id. Members receive only themselves and
 *  their own organizations; admins receive everything. */
export interface SecretPrincipals {
  /** `workspace` slugs, surfaced in the UI under the label "Organization". */
  organizations: { slug: string; name: string }[]
  users: { id: number; username: string }[]
  /** True when the caller may address the `global` (Command-Center-wide) scope. */
  canUseGlobal: boolean
}

/** A row from GET /api/secrets/access-log (global admin only). */
export interface SecretAccessLogEntry {
  actorUserId: number | null
  action: string
  scope: string
  key: string
  at: string
}

// ── Scoped agent/skill assignment (obj-2388) ────────────────────────────────
// Reuses the obj-2353/1731 credential scope model (global/workspace/user) and
// ADDS `project` as a new scope target, so an agent OR a skill can be assigned
// to a user / org(=workspace) / project the same way a credential is scoped.
// Semantics generalize Phase-7 `default_agent_pool`: if a resource_type has any
// assignment scoped to a session's workspace or project, availability is
// RESTRICTED to the resolved union (global baseline + matching workspace +
// matching project + matching user); otherwise it is unrestricted (legacy
// allow-any). See services/resource-assignments.ts for resolution.

/** What kind of resource an assignment governs. */
export type ResourceType = 'agent' | 'skill'

/** Scope target for an assignment. `workspace` is the org tier (post-rebrand);
 *  `project` is the new finer tier added by obj-2388. */
export type ResourceScopeType = 'global' | 'workspace' | 'user' | 'project'

/** A stored agent/skill→scope assignment (metadata only; no secrets). */
export interface ResourceAssignment {
  id: number
  resourceType: ResourceType
  resourceId: string // agent name (e.g. 'cmo') or skill name (e.g. 'campaign-audit')
  scopeType: ResourceScopeType
  workspace: string | null
  project: string | null
  userId: number | null
  createdBy: number | null
  createdAt: string
}

/** Body for POST /api/resource-assignments — create-or-ignore an assignment. */
export interface SetResourceAssignmentRequest {
  resourceType: ResourceType
  resourceId: string
  scopeType: ResourceScopeType
  workspace?: string | null
  project?: string | null
  userId?: number | null
}

/** Result of resolving which resources are available to a session context. */
export interface ResolvedResourceAvailability {
  resourceType: ResourceType
  restricted: boolean // false = legacy allow-any (no scoping for this context)
  allowed: string[] // resource_ids available when restricted
}

export interface PlanningMessage {
  id: number
  objective_id: number
  session_id: string | null
  role: 'user' | 'assistant' | 'system'
  content: string
  metadata: Record<string, unknown> | null
  created_at: string
}

// ── Mentor Chat ──

export type MentorSessionState = 'idle' | 'working' | 'review'

export interface ThreadFolder {
  id: number
  title: string
  workspace: string
  created_at: string
  updated_at: string
}

export interface MentorThread {
  id: number
  title: string
  tags: string[]
  pinned: boolean
  archived: boolean
  done: boolean
  folder_id: number | null
  account_id: string | null
  session_id: string | null
  last_active_at: string | null
  last_message_role: 'user' | 'assistant' | null
  workspace: string
  created_by: number | null
  created_at: string
  updated_at: string
}

export interface MentorSummary {
  id: number
  thread_id: number
  content: string
  created_at: string
  updated_at: string
}

export interface CreateMentorThreadRequest {
  title?: string
  tags?: string[]
  workspace?: string
}

export interface UpdateMentorThreadRequest {
  title?: string
  tags?: string[]
  pinned?: boolean
  archived?: boolean
  done?: boolean
  folder_id?: number | null
  workspace?: string
}

export interface PostMentorMessageRequest {
  content: string
  filePaths?: string[]
}

export interface MentorUploadResponse {
  files: Array<{ originalName: string; path: string; size: number; mimetype: string }>
}

export interface MentorThreadOutput {
  thread: MentorThread
  state: MentorSessionState
  messages: SessionMessage[]
}

export interface PostMentorMessageResponse {
  thread: MentorThread
  session_id: string | null
}

// ── Alerts ──

export type AlertSeverity = 'normal' | 'high' | 'emergency'

export interface Alert {
  id: number
  severity: AlertSeverity
  source: string
  title: string
  message: string
  dedup_key: string | null
  url: string | null
  email_sent_at: string | null
  acked_at: string | null
  acked_by: string | null
  created_at: string
}

/** Body for POST /api/alerts (bearer-token ingest from cron / external scripts). */
export interface IngestAlertRequest {
  severity: AlertSeverity
  source: string
  title: string
  message: string
  dedup_key?: string
  url?: string
}

// ── Workspace Config ──

export interface WorkspaceProject {
  name: string
  description: string
  path: string
  github: string | null
  stack: string[]
}

export interface WorkspaceConfig {
  name: string
  description: string
  context: string
  knowledge: {
    qmd_collection: string
    qmd_filter?: string
    indexes: string[]
  }
  projects: WorkspaceProject[]
}

export interface WorkspacesConfig {
  workspaces: Record<string, WorkspaceConfig>
}

// A repo/project attached to a workspace and persisted in the SQLite
// `workspace_repos` table (admin-managed via the Config page). Distinct from
// the legacy read-only `WorkspaceProject` entries that come from workspaces.json.
export interface WorkspaceRepo {
  id: number
  workspace: string
  name: string
  description: string | null
  github: string | null
  repo_path: string | null
  stack: string[]
  /** Folder inside the checkout that holds living product docs. */
  docs_path: string
  /** When true, the daily docs-breathe Job may open a PR here. */
  docs_enabled: boolean
  created_at: string
}

// ── Workspace integrations (GitHub org + PostHog, connected per workspace) ──

export type IntegrationKind = 'github' | 'posthog'
export type IntegrationStatus = 'connected' | 'error' | 'disconnected'

/**
 * Masked, API-safe view of a workspace integration. Raw secrets (PATs,
 * project/personal API keys) live ONLY in the server DB and are NEVER included
 * here — only a last-4 fingerprint for display. Returned by
 * GET /admin/workspaces/:slug/integrations.
 */
export interface WorkspaceIntegration {
  workspace: string
  kind: IntegrationKind
  status: IntegrationStatus
  error: string | null
  // github
  org: string | null
  token_last4: string | null
  repo_count: number | null
  // posthog
  host: string | null
  project_api_key_last4: string | null
  personal_api_key_last4: string | null
  created_at: string
  updated_at: string
}

/** A repo on a connected GitHub org, surfaced so the UI can pick one to attach. */
export interface GithubOrgRepo {
  name: string
  full_name: string
  private: boolean
  language: string | null
}

/** Body for POST /admin/workspaces/:slug/integrations/github. */
export interface ConnectGithubRequest {
  org: string
  token: string
}

/** Body for POST /admin/workspaces/:slug/integrations/posthog. */
export interface ConnectPosthogRequest {
  host: string
  project_api_key: string
  personal_api_key?: string | null
}

// ── API Request/Response ──

export interface LoginRequest {
  username: string
  password: string
}

export interface LoginResponse {
  user: User
}

/** POST /api/auth/token — JSON Bearer for agents (no cookie). */
export interface TokenResponse {
  token: string
  token_type: 'Bearer'
  expires_in: number
  user: User
}

/** GET /api/auth/api-key — whether Settings has minted a key. Never the secret. */
export interface ApiKeySummary {
  configured: boolean
  last4: string | null
  created_at: string | null
}

/** POST /api/auth/api-key — plaintext shown once. */
export interface ApiKeyIssued {
  token: string
  last4: string
  created_at: string
}

export interface CreateObjectiveRequest {
  title: string
  description: string
  /** OPTIONAL since obj 708817 — the human create form no longer collects an
   *  agent. When absent the server resolves the workspace's primary pool agent
   *  (`default_agent_pool[0]`, else 'general'). Callers that DO send it keep
   *  their exact previous behaviour. */
  agent_context?: AgentContext
  workspace?: string
  project?: string | null
  /** Board-Project association: id of a Project row in the same workspace.
   *  When set with a parent_id, the parent's project_id is inherited if this
   *  is omitted. Rejected with 400 if the project belongs to a different workspace. */
  project_id?: number | null
  category?: ObjectiveCategory
  parent_id?: number | null
  assigned_user_id?: number | null
  assigned_user_ids?: number[]
  create_pr?: boolean
  delegate_mode?: boolean
  completion_goal?: string | null
  workflow_hint?: string | null
  effort?: EffortLevel
  model?: ModelChoice
  type?: ObjectiveType
  skip_ai_review?: boolean
  /** Associate a manual objective with a Strategy (obj 2386). Accepts the id of
   *  an is_strategy=1 objective; invalid/dangling ids degrade to inherited/null.
   *  Lets a hand-created objective (even parent_id IS NULL) show its strategy. */
  strategy_id?: number | null
  /** Explicit Strategy marker (obj 2835). A Strategy is the intentional top tier
   *  and must be opted into at creation — it is NEVER inferred from
   *  delegate_mode/parent_id. Defaults to false (is_strategy=0). */
  is_strategy?: boolean
}

export interface UpdateObjectiveRequest {
  title?: string
  description?: string
  agent_context?: AgentContext
  workspace?: string
  project?: string | null
  /** Board-Project association update. null = detach from current project.
   *  Rejected with 400 if the project belongs to a different workspace. */
  project_id?: number | null
  category?: ObjectiveCategory
  parent_id?: number | null
  assigned_user_id?: number | null
  assigned_user_ids?: number[]
  create_pr?: boolean
  delegate_mode?: boolean
  completion_goal?: string | null
  workflow_hint?: string | null
  effort?: EffortLevel
  model?: ModelChoice
  type?: ObjectiveType
  /** Per-objective opt-out from the AI Review stage. */
  skip_ai_review?: boolean
  /** Pointer into `test_credentials.slug`; null detaches any current
   *  selection so the reviewer falls back to workspace+project lookup. */
  test_cred_slug?: string | null
  /** Associate/re-associate this objective with a Strategy (obj 2386), or null
   *  to detach. Validated against is_strategy=1; invalid ids degrade to detach. */
  strategy_id?: number | null
  /** Explicit Strategy marker (obj 2835). Only changes the stored marker when
   *  supplied; NEVER re-derived from delegate_mode/parent_id on update. */
  is_strategy?: boolean
}

export interface StatusChangeRequest {
  status: ObjectiveStatus
}

export interface ApiError {
  error: string
}

