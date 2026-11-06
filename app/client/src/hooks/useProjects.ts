import { useState, useEffect, useCallback, useRef } from 'react'
import type { Project } from '@operationkit/shared'
import { api } from '../lib/api'

/** Scope sentinel: every organization the caller can access (obj 900197). */
export const ALL_ORGS = '*'

/**
 * The scope a board/picker wants projects for:
 *   - `null` or `'all'` — nothing (back-compat: a caller with no org context)
 *   - `'example'`           — one organization
 *   - `['example', 'ops']`  — exactly these organizations
 *   - `ALL_ORGS`         — every organization the caller can access
 */
export type ProjectScope = string | string[] | null

/** Serialise a scope into the `?workspace=` value, or null to skip the fetch. */
export function scopeToQuery(scope: ProjectScope): string | null {
  if (scope === null || scope === 'all') return null
  if (scope === ALL_ORGS) return ALL_ORGS
  if (Array.isArray(scope)) {
    const slugs = [...new Set(scope.filter(Boolean))]
    if (slugs.length === 0) return null
    return slugs.join(',')
  }
  return scope
}

/** The single org a scope resolves to, or null when it spans zero or many. */
export function soleWorkspaceOf(scope: ProjectScope): string | null {
  if (typeof scope === 'string') return scope === 'all' || scope === ALL_ORGS ? null : scope
  if (Array.isArray(scope) && scope.length === 1) return scope[0]
  return null
}

/**
 * Projects (org subfolders) for a scope — obj 708826, widened in obj 900197.
 *
 * Thin client over the CRUD API shipped in obj 708808
 * (`app/server/src/routes/projects.ts`):
 *   GET    /api/projects?workspace=<slug>[,<slug>…]   (omit/`*` = all accessible)
 *   POST   /api/projects            { workspace, name, description?, color? }
 *   PATCH  /api/projects/:id        { name?, description?, color?, archived? }
 *   DELETE /api/projects/:id        -> { deleted, detached_objectives }
 *
 * A project belongs to exactly one organization, but the board's
 * All-Organizations view still needs every org's roster to build its filter
 * row — so a scope may span many orgs, and each returned project carries its
 * own `workspace` for labelling.
 */
export function useProjects(scope: ProjectScope) {
  const [projects, setProjects] = useState<Project[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Guards against a slow response for a previous workspace landing after the
  // user has already switched — only the newest request may write state.
  const reqId = useRef(0)

  // Arrays are fresh objects on every render, so depend on the serialised form
  // rather than the scope itself — otherwise refresh() changes identity every
  // render and the effect below loops.
  const query = scopeToQuery(scope)
  const soleWorkspace = soleWorkspaceOf(scope)
  const refresh = useCallback(async () => {
    if (query === null) {
      setProjects([])
      setLoading(false)
      return
    }
    const mine = ++reqId.current
    setLoading(true)
    try {
      const rows = await api.get<Project[]>(`/projects?workspace=${encodeURIComponent(query)}`)
      if (mine !== reqId.current) return
      setProjects(Array.isArray(rows) ? rows : [])
      setError(null)
    } catch (err) {
      if (mine !== reqId.current) return
      setProjects([])
      setError(err instanceof Error ? err.message : 'Could not load projects')
    } finally {
      if (mine === reqId.current) setLoading(false)
    }
  }, [query])

  useEffect(() => { void refresh() }, [refresh])

  // The org is explicit when the caller is in a cross-org view (the board's
  // "All Organizations" create form has its own org picker); otherwise it falls
  // back to the single org this scope resolves to.
  const createProject = useCallback(async (
    name: string,
    opts?: { workspace?: string; description?: string },
  ) => {
    const target = opts?.workspace ?? soleWorkspace
    if (!target) throw new Error('Pick an organization for this project')
    const created = await api.post<Project>('/projects', {
      workspace: target,
      name,
      ...(opts?.description ? { description: opts.description } : {}),
    })
    await refresh()
    return created
  }, [soleWorkspace, refresh])

  const renameProject = useCallback(async (id: number, name: string) => {
    const updated = await api.patch<Project>(`/projects/${id}`, { name })
    await refresh()
    return updated
  }, [refresh])

  const archiveProject = useCallback(async (id: number, archived: boolean) => {
    const updated = await api.patch<Project>(`/projects/${id}`, { archived })
    await refresh()
    return updated
  }, [refresh])

  const deleteProject = useCallback(async (id: number) => {
    const result = await api.del<{ deleted: boolean; detached_objectives: number }>(`/projects/${id}`)
    await refresh()
    return result
  }, [refresh])

  return { projects, loading, error, refresh, createProject, renameProject, archiveProject, deleteProject }
}
