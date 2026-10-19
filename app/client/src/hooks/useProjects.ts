import { useState, useEffect, useCallback, useRef } from 'react'
import type { Project } from '@operationkit/shared'
import { api } from '../lib/api'

/**
 * Projects (org subfolders) for a single workspace — obj 708826.
 *
 * Thin client over the CRUD API shipped in obj 708808
 * (`app/server/src/routes/projects.ts`):
 *   GET    /api/projects?workspace=<slug>
 *   POST   /api/projects            { workspace, name, description?, color? }
 *   PATCH  /api/projects/:id        { name?, description?, color?, archived? }
 *   DELETE /api/projects/:id        -> { deleted, detached_objectives }
 *
 * `workspace` may be null (All Organizations / multi-select), in which case no
 * fetch happens and the list is empty — a project belongs to exactly one org,
 * so a cross-org board has nothing meaningful to filter by.
 */
export function useProjects(workspace: string | null) {
  const [projects, setProjects] = useState<Project[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Guards against a slow response for a previous workspace landing after the
  // user has already switched — only the newest request may write state.
  const reqId = useRef(0)

  const refresh = useCallback(async () => {
    if (!workspace || workspace === 'all') {
      setProjects([])
      setLoading(false)
      return
    }
    const mine = ++reqId.current
    setLoading(true)
    try {
      const rows = await api.get<Project[]>(`/projects?workspace=${encodeURIComponent(workspace)}`)
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
  }, [workspace])

  useEffect(() => { void refresh() }, [refresh])

  const createProject = useCallback(async (name: string, description?: string) => {
    const created = await api.post<Project>('/projects', {
      workspace,
      name,
      ...(description ? { description } : {}),
    })
    await refresh()
    return created
  }, [workspace, refresh])

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
