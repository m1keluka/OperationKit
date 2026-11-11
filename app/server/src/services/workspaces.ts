import { getDb } from '../db/index.js'

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

interface WorkspaceRow {
  slug: string
  name: string
  short_label: string | null
  badge_color: string | null
  vault_path: string | null
  doc_read_roots: string
  doc_write_roots: string
  default_agent_pool: string
  archived: number
  sort_order: number
  created_at: string
  updated_at: string
}

let cache: Map<string, WorkspaceRecord> | null = null

function parseJsonArray(value: string | null): string[] {
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter(v => typeof v === 'string') : []
  } catch {
    return []
  }
}

function rowToRecord(row: WorkspaceRow): WorkspaceRecord {
  return {
    slug: row.slug,
    name: row.name,
    short_label: row.short_label,
    badge_color: row.badge_color,
    vault_path: row.vault_path,
    doc_read_roots: parseJsonArray(row.doc_read_roots),
    doc_write_roots: parseJsonArray(row.doc_write_roots),
    default_agent_pool: parseJsonArray(row.default_agent_pool),
    archived: !!row.archived,
    sort_order: row.sort_order,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

function loadCache(): Map<string, WorkspaceRecord> {
  if (cache) return cache
  const rows = getDb()
    .prepare('SELECT * FROM workspaces ORDER BY sort_order, slug')
    .all() as WorkspaceRow[]
  cache = new Map(rows.map(r => [r.slug, rowToRecord(r)]))
  return cache
}

export function invalidateWorkspacesCache(): void {
  cache = null
}

export function listWorkspaces(opts: { includeArchived?: boolean } = {}): WorkspaceRecord[] {
  const records = Array.from(loadCache().values())
  return opts.includeArchived ? records : records.filter(w => !w.archived)
}

export function getWorkspace(slug: string): WorkspaceRecord | undefined {
  return loadCache().get(slug)
}

export function workspaceExists(slug: string): boolean {
  return loadCache().has(slug)
}

export function getWorkspaceSlugs(opts: { includeArchived?: boolean } = {}): string[] {
  return listWorkspaces(opts).map(w => w.slug)
}

export function getDocRoots(slug: string): { read: string[]; write: string[] } {
  const ws = getWorkspace(slug)
  if (!ws) return { read: [], write: [] }
  return { read: ws.doc_read_roots, write: ws.doc_write_roots }
}

export interface UpsertWorkspaceInput {
  slug: string
  name: string
  short_label?: string | null
  badge_color?: string | null
  vault_path?: string | null
  doc_read_roots?: string[]
  doc_write_roots?: string[]
  default_agent_pool?: string[]
  sort_order?: number
  archived?: boolean
}

export function createWorkspace(input: UpsertWorkspaceInput): WorkspaceRecord {
  const db = getDb()
  db.prepare(
    `INSERT INTO workspaces
       (slug, name, short_label, badge_color, vault_path,
        doc_read_roots, doc_write_roots, default_agent_pool,
        sort_order, archived, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
  ).run(
    input.slug,
    input.name,
    input.short_label ?? null,
    input.badge_color ?? null,
    input.vault_path ?? null,
    JSON.stringify(input.doc_read_roots ?? []),
    JSON.stringify(input.doc_write_roots ?? []),
    JSON.stringify(input.default_agent_pool ?? []),
    input.sort_order ?? 0,
    input.archived ? 1 : 0,
  )
  invalidateWorkspacesCache()
  const ws = getWorkspace(input.slug)
  if (!ws) throw new Error('Workspace insert returned no row')
  return ws
}

export function updateWorkspace(slug: string, patch: Partial<UpsertWorkspaceInput>): WorkspaceRecord | undefined {
  const existing = getWorkspace(slug)
  if (!existing) return undefined
  const merged: WorkspaceRecord = {
    ...existing,
    name: patch.name ?? existing.name,
    short_label: patch.short_label === undefined ? existing.short_label : patch.short_label,
    badge_color: patch.badge_color === undefined ? existing.badge_color : patch.badge_color,
    vault_path: patch.vault_path === undefined ? existing.vault_path : patch.vault_path,
    doc_read_roots: patch.doc_read_roots ?? existing.doc_read_roots,
    doc_write_roots: patch.doc_write_roots ?? existing.doc_write_roots,
    default_agent_pool: patch.default_agent_pool ?? existing.default_agent_pool,
    sort_order: patch.sort_order ?? existing.sort_order,
    archived: patch.archived ?? existing.archived,
  }
  getDb().prepare(
    `UPDATE workspaces SET
       name = ?, short_label = ?, badge_color = ?, vault_path = ?,
       doc_read_roots = ?, doc_write_roots = ?, default_agent_pool = ?,
       sort_order = ?, archived = ?, updated_at = datetime('now')
     WHERE slug = ?`
  ).run(
    merged.name,
    merged.short_label,
    merged.badge_color,
    merged.vault_path,
    JSON.stringify(merged.doc_read_roots),
    JSON.stringify(merged.doc_write_roots),
    JSON.stringify(merged.default_agent_pool),
    merged.sort_order,
    merged.archived ? 1 : 0,
    slug,
  )
  invalidateWorkspacesCache()
  return getWorkspace(slug)
}

export function archiveWorkspace(slug: string): boolean {
  const result = getDb()
    .prepare("UPDATE workspaces SET archived = 1, updated_at = datetime('now') WHERE slug = ?")
    .run(slug)
  invalidateWorkspacesCache()
  return result.changes > 0
}
