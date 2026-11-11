import { getDb } from '../db/index.js'
import type { WorkspaceRepo } from '@operationkit/shared'

interface WorkspaceRepoRow {
  id: number
  workspace: string
  name: string
  description: string | null
  github: string | null
  repo_path: string | null
  stack: string
  docs_path: string
  docs_enabled: number
  created_at: string
}

function parseStack(value: string | null): string[] {
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter(v => typeof v === 'string') : []
  } catch {
    return []
  }
}

function rowToRepo(row: WorkspaceRepoRow): WorkspaceRepo {
  return {
    id: row.id,
    workspace: row.workspace,
    name: row.name,
    description: row.description,
    github: row.github,
    repo_path: row.repo_path,
    stack: parseStack(row.stack),
    docs_path: row.docs_path || 'docs/product',
    docs_enabled: Number(row.docs_enabled) !== 0,
    created_at: row.created_at,
  }
}

export function listWorkspaceRepos(workspace: string): WorkspaceRepo[] {
  const rows = getDb()
    .prepare('SELECT * FROM workspace_repos WHERE workspace = ? ORDER BY name')
    .all(workspace) as WorkspaceRepoRow[]
  return rows.map(rowToRepo)
}

export function getWorkspaceRepo(id: number): WorkspaceRepo | undefined {
  const row = getDb()
    .prepare('SELECT * FROM workspace_repos WHERE id = ?')
    .get(id) as WorkspaceRepoRow | undefined
  return row ? rowToRepo(row) : undefined
}

export interface CreateRepoInput {
  workspace: string
  name: string
  description?: string | null
  github?: string | null
  repo_path?: string | null
  stack?: string[]
  docs_path?: string | null
  docs_enabled?: boolean
}

export function createWorkspaceRepo(input: CreateRepoInput): WorkspaceRepo {
  const docsPath = (input.docs_path || 'docs/product').trim() || 'docs/product'
  const docsEnabled = input.docs_enabled === false ? 0 : 1
  const result = getDb()
    .prepare(
      `INSERT INTO workspace_repos (workspace, name, description, github, repo_path, stack, docs_path, docs_enabled)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.workspace,
      input.name,
      input.description ?? null,
      input.github ?? null,
      input.repo_path ?? null,
      JSON.stringify(input.stack ?? []),
      docsPath,
      docsEnabled,
    )
  const created = getWorkspaceRepo(Number(result.lastInsertRowid))
  if (!created) throw new Error('Repo insert returned no row')
  return created
}

export function listLivingDocsRepos(): WorkspaceRepo[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM workspace_repos
       WHERE docs_enabled = 1 AND repo_path IS NOT NULL AND TRIM(repo_path) != ''
       ORDER BY workspace, name`,
    )
    .all() as WorkspaceRepoRow[]
  return rows.map(rowToRepo)
}

export function updateWorkspaceRepo(
  id: number,
  workspace: string,
  patch: { docs_enabled?: boolean; docs_path?: string; repo_path?: string | null },
): WorkspaceRepo | undefined {
  const current = getWorkspaceRepo(id)
  if (!current || current.workspace !== workspace) return undefined
  const docsEnabled = patch.docs_enabled === undefined ? (current.docs_enabled ? 1 : 0) : patch.docs_enabled ? 1 : 0
  const docsPath = patch.docs_path !== undefined
    ? (patch.docs_path.trim() || 'docs/product')
    : current.docs_path
  const repoPath = patch.repo_path !== undefined ? (patch.repo_path?.trim() || null) : current.repo_path
  getDb()
    .prepare(
      'UPDATE workspace_repos SET docs_enabled = ?, docs_path = ?, repo_path = ? WHERE id = ? AND workspace = ?',
    )
    .run(docsEnabled, docsPath, repoPath, id, workspace)
  return getWorkspaceRepo(id)
}

export function deleteWorkspaceRepo(id: number, workspace: string): boolean {
  const result = getDb()
    .prepare('DELETE FROM workspace_repos WHERE id = ? AND workspace = ?')
    .run(id, workspace)
  return result.changes > 0
}
