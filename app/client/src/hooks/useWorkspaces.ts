import { useEffect, useState } from 'react'
import type { WorkspaceRecord } from '@operationkit/shared'

interface UseWorkspacesResult {
  workspaces: WorkspaceRecord[]
  slugs: string[]
  loading: boolean
  refresh: () => Promise<void>
  labelOf: (slug: string) => string
  shortOf: (slug: string) => string
  badgeOf: (slug: string) => string | null
  agentPoolOf: (slug: string) => string[]
}

const SPECIAL_LABELS: Record<string, { label: string; short: string }> = {
  all: { label: 'All Organizations', short: 'All' },
}

let cache: WorkspaceRecord[] | null = null
let inflight: Promise<WorkspaceRecord[]> | null = null

async function fetchWorkspaces(): Promise<WorkspaceRecord[]> {
  if (cache) return cache
  if (inflight) return inflight
  inflight = fetch('/api/workspaces', { credentials: 'include' })
    .then(r => (r.ok ? r.json() : []))
    .then((data: WorkspaceRecord[]) => {
      cache = Array.isArray(data) ? data : []
      return cache
    })
    .catch(() => {
      cache = []
      return cache
    })
    .finally(() => {
      inflight = null
    })
  return inflight
}

export function invalidateWorkspacesCache(): void {
  cache = null
}

/**
 * Returns the list of workspaces visible to the current user, plus label/badge
 * helpers. Cached process-wide so successive components don't refetch.
 */
export function useWorkspaces(): UseWorkspacesResult {
  const [workspaces, setWorkspaces] = useState<WorkspaceRecord[]>(cache ?? [])
  const [loading, setLoading] = useState<boolean>(cache === null)

  useEffect(() => {
    let cancelled = false
    fetchWorkspaces().then(ws => {
      if (cancelled) return
      setWorkspaces(ws)
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [])

  async function refresh() {
    cache = null
    setLoading(true)
    const fresh = await fetchWorkspaces()
    setWorkspaces(fresh)
    setLoading(false)
  }

  function labelOf(slug: string): string {
    if (SPECIAL_LABELS[slug]) return SPECIAL_LABELS[slug].label
    const ws = workspaces.find(w => w.slug === slug)
    return ws?.name ?? slug
  }
  function shortOf(slug: string): string {
    if (SPECIAL_LABELS[slug]) return SPECIAL_LABELS[slug].short
    const ws = workspaces.find(w => w.slug === slug)
    return ws?.short_label ?? ws?.name ?? slug
  }
  function badgeOf(slug: string): string | null {
    const ws = workspaces.find(w => w.slug === slug)
    return ws?.badge_color ?? null
  }
  function agentPoolOf(slug: string): string[] {
    const ws = workspaces.find(w => w.slug === slug)
    return ws?.default_agent_pool ?? []
  }

  return {
    workspaces,
    slugs: workspaces.map(w => w.slug),
    loading,
    refresh,
    labelOf,
    shortOf,
    badgeOf,
    agentPoolOf,
  }
}
