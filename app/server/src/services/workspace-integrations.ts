import { getDb } from '../db/index.js'
import type {
  GithubOrgRepo,
  IntegrationKind,
  IntegrationStatus,
  WorkspaceIntegration,
} from '@command-center/shared'

// ── Test seam ───────────────────────────────────────────────────────────────
// Validation makes real HTTP calls to GitHub / PostHog in production. Tests
// inject a fake so persistence, masking, isolation and error paths can be
// exercised deterministically without network access.
type FetchLike = (input: string, init?: RequestInit) => Promise<Response>
let _fetch: FetchLike = (input, init) => globalThis.fetch(input, init)
export function __setFetchForTests(f: FetchLike | null): void {
  _fetch = f ?? ((input, init) => globalThis.fetch(input, init))
}

// ── Persistence ───────────────────────────────────────────────────────────--

interface IntegrationRow {
  id: number
  workspace: string
  kind: string
  config: string
  status: string
  error: string | null
  created_at: string
  updated_at: string
}

/** Non-secret display fields captured at connect time, stored alongside secrets. */
interface GithubConfig {
  org: string
  token: string
  repo_count?: number
}
interface PosthogConfig {
  host: string
  project_api_key: string
  personal_api_key?: string | null
}

function parseConfig(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw)
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** Last-4 fingerprint for display. Never returns the raw secret. */
function last4(secret: unknown): string | null {
  if (typeof secret !== 'string' || secret.length === 0) return null
  return secret.length <= 4 ? '••••' : `••••${secret.slice(-4)}`
}

/** Map a DB row to the masked, API-safe view. Raw secrets are dropped here. */
function rowToMasked(row: IntegrationRow): WorkspaceIntegration {
  const cfg = parseConfig(row.config)
  const kind = row.kind as IntegrationKind
  return {
    workspace: row.workspace,
    kind,
    status: (row.status as IntegrationStatus) || 'disconnected',
    error: row.error,
    org: kind === 'github' ? (typeof cfg.org === 'string' ? cfg.org : null) : null,
    token_last4: kind === 'github' ? last4(cfg.token) : null,
    repo_count: kind === 'github' && typeof cfg.repo_count === 'number' ? cfg.repo_count : null,
    host: kind === 'posthog' ? (typeof cfg.host === 'string' ? cfg.host : null) : null,
    project_api_key_last4: kind === 'posthog' ? last4(cfg.project_api_key) : null,
    personal_api_key_last4: kind === 'posthog' ? last4(cfg.personal_api_key) : null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

export function listIntegrations(workspace: string): WorkspaceIntegration[] {
  const rows = getDb()
    .prepare('SELECT * FROM workspace_integrations WHERE workspace = ? ORDER BY kind')
    .all(workspace) as IntegrationRow[]
  return rows.map(rowToMasked)
}

export function getMaskedIntegration(
  workspace: string,
  kind: IntegrationKind,
): WorkspaceIntegration | undefined {
  const row = getDb()
    .prepare('SELECT * FROM workspace_integrations WHERE workspace = ? AND kind = ?')
    .get(workspace, kind) as IntegrationRow | undefined
  return row ? rowToMasked(row) : undefined
}

/**
 * Raw config (INCLUDING secrets) for server-side use only — e.g. to call the
 * GitHub API with the stored token when listing org repos. NEVER send this to a
 * client; route handlers return the masked view.
 */
export function getRawConfig(
  workspace: string,
  kind: IntegrationKind,
): Record<string, unknown> | undefined {
  const row = getDb()
    .prepare('SELECT config FROM workspace_integrations WHERE workspace = ? AND kind = ?')
    .get(workspace, kind) as { config: string } | undefined
  return row ? parseConfig(row.config) : undefined
}

function upsertIntegration(
  workspace: string,
  kind: IntegrationKind,
  config: GithubConfig | PosthogConfig,
  status: IntegrationStatus,
  error: string | null,
): WorkspaceIntegration {
  getDb()
    .prepare(
      `INSERT INTO workspace_integrations (workspace, kind, config, status, error, updated_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(workspace, kind) DO UPDATE SET
         config = excluded.config,
         status = excluded.status,
         error = excluded.error,
         updated_at = datetime('now')`,
    )
    .run(workspace, kind, JSON.stringify(config), status, error)
  const saved = getMaskedIntegration(workspace, kind)
  if (!saved) throw new Error('Integration upsert returned no row')
  return saved
}

export function deleteIntegration(workspace: string, kind: IntegrationKind): boolean {
  const result = getDb()
    .prepare('DELETE FROM workspace_integrations WHERE workspace = ? AND kind = ?')
    .run(workspace, kind)
  return result.changes > 0
}

// ── GitHub ──────────────────────────────────────────────────────────────────

function ghHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'OperationKit-CommandCenter',
    'X-GitHub-Api-Version': '2022-11-28',
  }
}

export interface GithubValidation {
  ok: boolean
  repoCount?: number
  error?: string
}

/**
 * Validate a GitHub org + PAT by hitting the real GitHub API: the org must
 * resolve and the token must be able to list its repos. Returns a structured
 * error (never throws on bad creds) so the route returns a real failure, not a
 * false success.
 */
export async function validateGithub(org: string, token: string): Promise<GithubValidation> {
  const enc = encodeURIComponent(org)
  let orgRes: Response
  try {
    orgRes = await _fetch(`https://api.github.com/orgs/${enc}`, { headers: ghHeaders(token) })
  } catch {
    return { ok: false, error: 'Could not reach GitHub API' }
  }
  if (orgRes.status === 401) return { ok: false, error: 'Invalid GitHub token (401 Unauthorized)' }
  if (orgRes.status === 403) return { ok: false, error: 'Token rejected (403 — check scopes / rate limit)' }
  if (orgRes.status === 404) return { ok: false, error: `Organization '${org}' not found or token lacks access` }
  if (!orgRes.ok) return { ok: false, error: `GitHub API error (${orgRes.status})` }

  // Read the org body for a repo-count summary before re-using the response.
  const orgBody = (await orgRes.json().catch(() => null)) as
    | { public_repos?: number; total_private_repos?: number }
    | null
  let repoCount: number | undefined
  if (orgBody && typeof orgBody.public_repos === 'number') {
    repoCount = orgBody.public_repos + (typeof orgBody.total_private_repos === 'number' ? orgBody.total_private_repos : 0)
  }

  // Confirm the token can actually list the org's repos (read:org / repo scope).
  let repoRes: Response
  try {
    repoRes = await _fetch(`https://api.github.com/orgs/${enc}/repos?per_page=1`, { headers: ghHeaders(token) })
  } catch {
    return { ok: false, error: 'Could not reach GitHub API' }
  }
  if (!repoRes.ok) return { ok: false, error: `Cannot list repos for '${org}' (${repoRes.status})` }

  return { ok: true, repoCount }
}

/** Persist a validated GitHub connection (raw token stored server-side only). */
export async function connectGithub(
  workspace: string,
  org: string,
  token: string,
): Promise<{ integration: WorkspaceIntegration } | { error: string }> {
  const v = await validateGithub(org, token)
  if (!v.ok) {
    return { error: v.error || 'GitHub validation failed' }
  }
  const config: GithubConfig = { org, token, repo_count: v.repoCount }
  return { integration: upsertIntegration(workspace, 'github', config, 'connected', null) }
}

/** List the connected org's repos using the stored token. Returns null if not connected. */
export async function listGithubOrgRepos(
  workspace: string,
): Promise<{ repos: GithubOrgRepo[] } | { error: string } | null> {
  const cfg = getRawConfig(workspace, 'github')
  if (!cfg || typeof cfg.org !== 'string' || typeof cfg.token !== 'string') return null
  const enc = encodeURIComponent(cfg.org)
  let res: Response
  try {
    res = await _fetch(`https://api.github.com/orgs/${enc}/repos?per_page=100&sort=full_name`, {
      headers: ghHeaders(cfg.token),
    })
  } catch {
    return { error: 'Could not reach GitHub API' }
  }
  if (!res.ok) return { error: `GitHub API error (${res.status})` }
  const data = (await res.json().catch(() => null)) as Array<Record<string, unknown>> | null
  if (!Array.isArray(data)) return { error: 'Unexpected GitHub response' }
  const repos: GithubOrgRepo[] = data.map(r => ({
    name: typeof r.name === 'string' ? r.name : '',
    full_name: typeof r.full_name === 'string' ? r.full_name : '',
    private: !!r.private,
    language: typeof r.language === 'string' ? r.language : null,
  }))
  return { repos }
}

// ── PostHog ─────────────────────────────────────────────────────────────────

export interface PosthogValidation {
  ok: boolean
  error?: string
}

/**
 * Validate a PostHog connection via a lightweight call to the host's decide
 * endpoint with the project API key. A bad key / unreachable host returns an
 * error, not a false success.
 */
export async function validatePosthog(
  host: string,
  projectApiKey: string,
  _personalApiKey?: string | null,
): Promise<PosthogValidation> {
  const base = host.replace(/\/+$/, '')
  if (!/^https?:\/\//.test(base)) return { ok: false, error: 'Host must be an http(s) URL' }
  let res: Response
  try {
    res = await _fetch(`${base}/decide/?v=3`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: projectApiKey, distinct_id: 'operationkit-connection-check' }),
    })
  } catch {
    return { ok: false, error: 'Could not reach PostHog host' }
  }
  if (res.status === 401) return { ok: false, error: 'Invalid PostHog project API key' }
  if (!res.ok) return { ok: false, error: `PostHog API error (${res.status})` }
  // A valid decide response is a JSON object without an auth-error marker.
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null
  if (body && typeof body.type === 'string' && body.type === 'authentication_error') {
    return { ok: false, error: 'Invalid PostHog project API key' }
  }
  return { ok: true }
}

/** Persist a validated PostHog connection (raw keys stored server-side only). */
export async function connectPosthog(
  workspace: string,
  host: string,
  projectApiKey: string,
  personalApiKey?: string | null,
): Promise<{ integration: WorkspaceIntegration } | { error: string }> {
  const v = await validatePosthog(host, projectApiKey, personalApiKey)
  if (!v.ok) {
    return { error: v.error || 'PostHog validation failed' }
  }
  const config: PosthogConfig = {
    host: host.replace(/\/+$/, ''),
    project_api_key: projectApiKey,
    personal_api_key: personalApiKey || null,
  }
  return { integration: upsertIntegration(workspace, 'posthog', config, 'connected', null) }
}
