import { Router } from 'express'
import { getDb } from '../db/index.js'
import { requireAuth, requireAdmin, type AuthRequest } from '../middleware/auth.js'
import {
  type GrantWorkspaceRequest,
  type ObjectiveVisibility,
  type UserRole,
  type WorkspaceMembership,
} from '@command-center/shared'
import {
  archiveWorkspace,
  createWorkspace,
  getWorkspace,
  listWorkspaces,
  updateWorkspace,
  workspaceExists,
} from '../services/workspaces.js'
import {
  createWorkspaceRepo,
  deleteWorkspaceRepo,
  listWorkspaceRepos,
  updateWorkspaceRepo,
} from '../services/workspace-repos.js'
import {
  connectGithub,
  connectPosthog,
  deleteIntegration,
  listGithubOrgRepos,
  listIntegrations,
} from '../services/workspace-integrations.js'
import type { IntegrationKind } from '@command-center/shared'

const router = Router()
router.use(requireAuth, requireAdmin)

function isValidWorkspace(ws: unknown): ws is string {
  return typeof ws === 'string' && workspaceExists(ws)
}

// GET /api/admin/workspaces — full list including archived (admin view)
router.get('/', (_req: AuthRequest, res) => {
  res.json(listWorkspaces({ includeArchived: true }))
})

function parseStringArray(value: unknown, field: string, res: import('express').Response): string[] | null {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some(v => typeof v !== 'string')) {
    res.status(400).json({ error: `${field} must be an array of strings` })
    return null
  }
  return value as string[]
}

// POST /api/admin/workspaces — create a new workspace
router.post('/', (req: AuthRequest, res) => {
  const body = req.body as Record<string, unknown>
  const slug = typeof body.slug === 'string' ? body.slug.trim() : ''
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(slug)) {
    res.status(400).json({ error: 'slug must be 2-41 chars: lowercase alnum + hyphens' })
    return
  }
  if (!name) {
    res.status(400).json({ error: 'name required' })
    return
  }
  if (workspaceExists(slug)) {
    res.status(409).json({ error: `Workspace '${slug}' already exists` })
    return
  }
  const readRoots = parseStringArray(body.doc_read_roots, 'doc_read_roots', res)
  if (readRoots === null) return
  const writeRoots = parseStringArray(body.doc_write_roots, 'doc_write_roots', res)
  if (writeRoots === null) return
  const agentPool = parseStringArray(body.default_agent_pool, 'default_agent_pool', res)
  if (agentPool === null) return

  const ws = createWorkspace({
    slug,
    name,
    short_label: typeof body.short_label === 'string' ? body.short_label : null,
    badge_color: typeof body.badge_color === 'string' ? body.badge_color : null,
    vault_path: typeof body.vault_path === 'string' ? body.vault_path : null,
    doc_read_roots: readRoots,
    doc_write_roots: writeRoots,
    default_agent_pool: agentPool,
    sort_order: typeof body.sort_order === 'number' ? body.sort_order : 0,
  })
  res.status(201).json(ws)
})

// PATCH /api/admin/workspaces/:slug — update fields
router.patch('/:slug', (req: AuthRequest, res) => {
  const slug = String(req.params.slug)
  if (!getWorkspace(slug)) {
    res.status(404).json({ error: 'Workspace not found' })
    return
  }
  const body = req.body as Record<string, unknown>
  const patch: Parameters<typeof updateWorkspace>[1] = {}
  if (typeof body.name === 'string') patch.name = body.name.trim()
  if (body.short_label === null || typeof body.short_label === 'string') patch.short_label = body.short_label as string | null
  if (body.badge_color === null || typeof body.badge_color === 'string') patch.badge_color = body.badge_color as string | null
  if (body.vault_path === null || typeof body.vault_path === 'string') patch.vault_path = body.vault_path as string | null
  if (body.doc_read_roots !== undefined) {
    const arr = parseStringArray(body.doc_read_roots, 'doc_read_roots', res)
    if (arr === null) return
    patch.doc_read_roots = arr
  }
  if (body.doc_write_roots !== undefined) {
    const arr = parseStringArray(body.doc_write_roots, 'doc_write_roots', res)
    if (arr === null) return
    patch.doc_write_roots = arr
  }
  if (body.default_agent_pool !== undefined) {
    const arr = parseStringArray(body.default_agent_pool, 'default_agent_pool', res)
    if (arr === null) return
    patch.default_agent_pool = arr
  }
  if (typeof body.sort_order === 'number') patch.sort_order = body.sort_order
  if (typeof body.archived === 'boolean') patch.archived = body.archived
  const updated = updateWorkspace(slug, patch)
  res.json(updated)
})

// DELETE /api/admin/workspaces/:slug — soft-delete (archive)
router.delete('/:slug', (req: AuthRequest, res) => {
  const slug = String(req.params.slug)
  if (!getWorkspace(slug)) {
    res.status(404).json({ error: 'Workspace not found' })
    return
  }
  archiveWorkspace(slug)
  res.json({ ok: true, slug, archived: true })
})

// ── Workspace repos (DB-backed, admin-managed) ──

// GET /api/admin/workspaces/:slug/repos — repos attached to a workspace
router.get('/:slug/repos', (req: AuthRequest, res) => {
  const slug = String(req.params.slug)
  if (!getWorkspace(slug)) {
    res.status(404).json({ error: 'Workspace not found' })
    return
  }
  res.json(listWorkspaceRepos(slug))
})

// POST /api/admin/workspaces/:slug/repos — attach a repo/project
router.post('/:slug/repos', (req: AuthRequest, res) => {
  const slug = String(req.params.slug)
  if (!getWorkspace(slug)) {
    res.status(404).json({ error: 'Workspace not found' })
    return
  }
  const body = req.body as Record<string, unknown>
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  if (!name) {
    res.status(400).json({ error: 'name required' })
    return
  }
  const stack = parseStringArray(body.stack, 'stack', res)
  if (stack === null) return
  const github = typeof body.github === 'string' && body.github.trim() ? body.github.trim() : null
  const repo_path = typeof body.repo_path === 'string' && body.repo_path.trim() ? body.repo_path.trim() : null
  const description =
    typeof body.description === 'string' && body.description.trim() ? body.description.trim() : null
  const docs_path = typeof body.docs_path === 'string' && body.docs_path.trim() ? body.docs_path.trim() : null
  const docs_enabled = body.docs_enabled === false || body.docs_enabled === 0 ? false : true
  const repo = createWorkspaceRepo({
    workspace: slug, name, description, github, repo_path, stack, docs_path, docs_enabled,
  })
  res.status(201).json(repo)
})

router.patch('/:slug/repos/:id', (req: AuthRequest, res) => {
  const slug = String(req.params.slug)
  if (!getWorkspace(slug)) {
    res.status(404).json({ error: 'Workspace not found' })
    return
  }
  const id = parseInt(typeof req.params.id === 'string' ? req.params.id : '', 10)
  if (Number.isNaN(id)) {
    res.status(400).json({ error: 'Invalid repo id' })
    return
  }
  const body = req.body as Record<string, unknown>
  const patch: { docs_enabled?: boolean; docs_path?: string; repo_path?: string | null } = {}
  if (typeof body.docs_enabled === 'boolean') patch.docs_enabled = body.docs_enabled
  if (typeof body.docs_path === 'string') patch.docs_path = body.docs_path
  if (body.repo_path === null) patch.repo_path = null
  else if (typeof body.repo_path === 'string') patch.repo_path = body.repo_path
  const updated = updateWorkspaceRepo(id, slug, patch)
  if (!updated) {
    res.status(404).json({ error: 'Repo not found' })
    return
  }
  res.json(updated)
})

// DELETE /api/admin/workspaces/:slug/repos/:id — detach a repo
router.delete('/:slug/repos/:id', (req: AuthRequest, res) => {
  const slug = String(req.params.slug)
  if (!getWorkspace(slug)) {
    res.status(404).json({ error: 'Workspace not found' })
    return
  }
  const id = parseInt(typeof req.params.id === 'string' ? req.params.id : '', 10)
  if (Number.isNaN(id)) {
    res.status(400).json({ error: 'Invalid repo id' })
    return
  }
  if (!deleteWorkspaceRepo(id, slug)) {
    res.status(404).json({ error: 'Repo not found' })
    return
  }
  res.json({ ok: true, id })
})

// ── Workspace integrations (GitHub org + PostHog, per workspace) ──
//
// Secrets (PATs / API keys) are admin-gated (router.use above), MASKED in every
// response (services return only a last-4 fingerprint), and NEVER logged. Raw
// values live only in the workspace_integrations.config column server-side.

// GET /api/admin/workspaces/:slug/integrations — masked status for this workspace
router.get('/:slug/integrations', (req: AuthRequest, res) => {
  const slug = String(req.params.slug)
  if (!getWorkspace(slug)) {
    res.status(404).json({ error: 'Workspace not found' })
    return
  }
  res.json(listIntegrations(slug))
})

// POST /api/admin/workspaces/:slug/integrations/github — connect a GitHub org
// body: { org, token }  (PAT with repo + read:org). Validated against GitHub.
router.post('/:slug/integrations/github', async (req: AuthRequest, res) => {
  const slug = String(req.params.slug)
  if (!getWorkspace(slug)) {
    res.status(404).json({ error: 'Workspace not found' })
    return
  }
  const body = req.body as Record<string, unknown>
  const org = typeof body.org === 'string' ? body.org.trim() : ''
  const token = typeof body.token === 'string' ? body.token.trim() : ''
  if (!org || !token) {
    res.status(400).json({ error: 'org and token are required' })
    return
  }
  const result = await connectGithub(slug, org, token)
  if ('error' in result) {
    res.status(400).json({ error: result.error })
    return
  }
  res.status(201).json(result.integration)
})

// GET /api/admin/workspaces/:slug/integrations/github/repos — list org repos
// using the stored token (so the UI can pick one into REPOS & PROJECTS).
router.get('/:slug/integrations/github/repos', async (req: AuthRequest, res) => {
  const slug = String(req.params.slug)
  if (!getWorkspace(slug)) {
    res.status(404).json({ error: 'Workspace not found' })
    return
  }
  const result = await listGithubOrgRepos(slug)
  if (result === null) {
    res.status(409).json({ error: 'GitHub is not connected for this workspace' })
    return
  }
  if ('error' in result) {
    res.status(400).json({ error: result.error })
    return
  }
  res.json(result.repos)
})

// POST /api/admin/workspaces/:slug/integrations/posthog — connect a PostHog project
// body: { host, project_api_key, personal_api_key? }. Validated against PostHog.
router.post('/:slug/integrations/posthog', async (req: AuthRequest, res) => {
  const slug = String(req.params.slug)
  if (!getWorkspace(slug)) {
    res.status(404).json({ error: 'Workspace not found' })
    return
  }
  const body = req.body as Record<string, unknown>
  const host = typeof body.host === 'string' ? body.host.trim() : ''
  const projectKey = typeof body.project_api_key === 'string' ? body.project_api_key.trim() : ''
  const personalKey =
    typeof body.personal_api_key === 'string' && body.personal_api_key.trim()
      ? body.personal_api_key.trim()
      : null
  if (!host || !projectKey) {
    res.status(400).json({ error: 'host and project_api_key are required' })
    return
  }
  const result = await connectPosthog(slug, host, projectKey, personalKey)
  if ('error' in result) {
    res.status(400).json({ error: result.error })
    return
  }
  res.status(201).json(result.integration)
})

// DELETE /api/admin/workspaces/:slug/integrations/:kind — disconnect
router.delete('/:slug/integrations/:kind', (req: AuthRequest, res) => {
  const slug = String(req.params.slug)
  if (!getWorkspace(slug)) {
    res.status(404).json({ error: 'Workspace not found' })
    return
  }
  const kind = String(req.params.kind)
  if (kind !== 'github' && kind !== 'posthog') {
    res.status(400).json({ error: "kind must be 'github' or 'posthog'" })
    return
  }
  if (!deleteIntegration(slug, kind as IntegrationKind)) {
    res.status(404).json({ error: 'Integration not connected' })
    return
  }
  res.json({ ok: true, slug, kind })
})

interface MembershipRow {
  user_id: number
  username: string
  workspace: string
  role: UserRole
  can_use_jarvis: number
  objective_visibility: string
}

function rowToMembership(row: MembershipRow): WorkspaceMembership {
  return {
    user_id: row.user_id,
    username: row.username,
    workspace: row.workspace,
    role: row.role,
    can_use_jarvis: !!row.can_use_jarvis,
    objective_visibility: row.objective_visibility === 'all' ? 'all' : 'own',
  }
}

// GET /api/admin/workspaces/:workspace/users
router.get('/:workspace/users', (req: AuthRequest, res) => {
  const workspace = req.params.workspace
  if (!isValidWorkspace(workspace)) {
    res.status(400).json({ error: `Invalid workspace '${String(workspace)}'` })
    return
  }
  const db = getDb()
  const rows = db
    .prepare(
      `SELECT uw.user_id, u.username, uw.workspace, uw.role,
              uw.can_use_jarvis, uw.objective_visibility
       FROM user_workspaces uw
       JOIN users u ON u.id = uw.user_id
       WHERE uw.workspace = ?
       ORDER BY u.username`
    )
    .all(workspace) as MembershipRow[]
  res.json(rows.map(rowToMembership))
})

// POST /api/admin/workspaces/:workspace/users
// body: { user_id, role?, can_use_jarvis?, objective_visibility? }
router.post('/:workspace/users', (req: AuthRequest, res) => {
  const workspace = req.params.workspace
  if (!isValidWorkspace(workspace)) {
    res.status(400).json({ error: `Invalid workspace '${String(workspace)}'` })
    return
  }
  const body = req.body as GrantWorkspaceRequest
  const { user_id, role = 'member', can_use_jarvis, objective_visibility } = body
  if (!user_id || typeof user_id !== 'number') {
    res.status(400).json({ error: 'user_id (number) required' })
    return
  }
  if (role !== 'admin' && role !== 'member') {
    res.status(400).json({ error: "role must be 'admin' or 'member'" })
    return
  }
  let visibility: ObjectiveVisibility | undefined
  if (objective_visibility !== undefined) {
    if (objective_visibility !== 'own' && objective_visibility !== 'all') {
      res.status(400).json({ error: "objective_visibility must be 'own' or 'all'" })
      return
    }
    visibility = objective_visibility
  }
  const db = getDb()
  const userRow = db.prepare('SELECT id FROM users WHERE id = ?').get(user_id)
  if (!userRow) {
    res.status(404).json({ error: 'User not found' })
    return
  }

  // Pull existing row (if any) so we can preserve fields the caller omits.
  const existing = db
    .prepare(
      `SELECT role, can_use_jarvis, objective_visibility
       FROM user_workspaces WHERE user_id = ? AND workspace = ?`
    )
    .get(user_id, workspace) as
      | { role: UserRole; can_use_jarvis: number; objective_visibility: string }
      | undefined

  const finalRole = role
  const finalJarvis =
    can_use_jarvis !== undefined ? (can_use_jarvis ? 1 : 0) : existing ? existing.can_use_jarvis : 1
  const finalVisibility = visibility ?? (existing?.objective_visibility === 'all' ? 'all' : 'own')

  db.prepare(
    `INSERT INTO user_workspaces (user_id, workspace, role, can_use_jarvis, objective_visibility)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id, workspace) DO UPDATE SET
       role = excluded.role,
       can_use_jarvis = excluded.can_use_jarvis,
       objective_visibility = excluded.objective_visibility`
  ).run(user_id, workspace, finalRole, finalJarvis, finalVisibility)

  const username = (db.prepare('SELECT username FROM users WHERE id = ?').get(user_id) as { username: string }).username
  const membership: WorkspaceMembership = {
    user_id,
    username,
    workspace,
    role: finalRole,
    can_use_jarvis: !!finalJarvis,
    objective_visibility: finalVisibility,
  }
  res.status(201).json(membership)
})

// DELETE /api/admin/workspaces/:workspace/users/:user_id
router.delete('/:workspace/users/:user_id', (req: AuthRequest, res) => {
  const workspace = req.params.workspace
  const userIdParam = req.params.user_id
  const userId = parseInt(typeof userIdParam === 'string' ? userIdParam : '', 10)
  if (!isValidWorkspace(workspace)) {
    res.status(400).json({ error: `Invalid workspace '${String(workspace)}'` })
    return
  }
  if (Number.isNaN(userId)) {
    res.status(400).json({ error: 'Invalid user_id' })
    return
  }
  const db = getDb()
  const result = db
    .prepare('DELETE FROM user_workspaces WHERE user_id = ? AND workspace = ?')
    .run(userId, workspace)
  if (result.changes === 0) {
    res.status(404).json({ error: 'Membership not found' })
    return
  }
  res.json({ ok: true })
})

export default router
