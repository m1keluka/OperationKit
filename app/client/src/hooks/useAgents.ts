import { useEffect, useState } from 'react'
import type { AgentRow } from '@operationkit/shared'
import { setAgentRegistryMeta } from '../components/design/primitives'

/**
 * The agent roster, fetched from the DB-backed registry (GET /api/agents).
 * Replaces the deleted AGENT_CONTEXTS / AGENT_META module constants.
 *
 * Cached process-wide so successive components don't refetch, and seeded with a
 * bundled default roster so a slow or failed fetch never renders an empty agent
 * picker (audit risk #5) — `loading` lets callers show a skeleton, but the list
 * is never empty enough to make an objective uncreatable.
 */
const FALLBACK_AGENTS: AgentRow[] = [
  { slug: 'cto', label: 'CTO', kind: 'executive', assignable: true, prompt_file: null, workdir_kind: 'projects', workdir_path: null, mono: 'CT', badge_hex: '#6F9AD8', badge_tw: 'bg-agent-cto', archived: false, sort_order: 1 },
  { slug: 'cmo', label: 'CMO', kind: 'executive', assignable: true, prompt_file: null, workdir_kind: 'workspace', workdir_path: null, mono: 'CM', badge_hex: '#D389B0', badge_tw: 'bg-agent-cmo', archived: false, sort_order: 2 },
  { slug: 'coo', label: 'COO', kind: 'executive', assignable: true, prompt_file: null, workdir_kind: 'workspace', workdir_path: null, mono: 'CO', badge_hex: '#6FB58C', badge_tw: 'bg-agent-coo', archived: false, sort_order: 3 },
  { slug: 'cfo', label: 'CFO', kind: 'executive', assignable: true, prompt_file: null, workdir_kind: 'workspace', workdir_path: null, mono: 'CF', badge_hex: '#D6A24E', badge_tw: 'bg-agent-cfo', archived: false, sort_order: 4 },
  { slug: 'general', label: 'General', kind: 'executive', assignable: true, prompt_file: null, workdir_kind: 'home', workdir_path: null, mono: 'GN', badge_hex: '#8C8A92', badge_tw: 'bg-agent-general', archived: false, sort_order: 5 },
]

interface UseAgentsResult {
  agents: AgentRow[]
  /** Slugs a user may assign an objective to. */
  slugs: string[]
  loading: boolean
  refresh: () => Promise<void>
  labelOf: (slug: string) => string
  kindOf: (slug: string) => AgentRow['kind']
}

let cache: AgentRow[] | null = null
let inflight: Promise<AgentRow[]> | null = null

async function fetchAgents(): Promise<AgentRow[]> {
  if (cache) return cache
  if (inflight) return inflight
  inflight = fetch('/api/agents', { credentials: 'include' })
    .then(r => (r.ok ? r.json() : null))
    .then((data: AgentRow[] | null) => {
      // A failed or empty response falls back to the bundled defaults rather
      // than an empty dropdown.
      cache = Array.isArray(data) && data.length ? data : FALLBACK_AGENTS
      setAgentRegistryMeta(cache)
      return cache
    })
    .catch(() => {
      cache = FALLBACK_AGENTS
      setAgentRegistryMeta(cache)
      return cache
    })
    .finally(() => {
      inflight = null
    })
  return inflight
}

export function invalidateAgentsCache(): void {
  cache = null
}

export function useAgents(): UseAgentsResult {
  const [agents, setAgents] = useState<AgentRow[]>(cache ?? FALLBACK_AGENTS)
  const [loading, setLoading] = useState<boolean>(cache === null)

  useEffect(() => {
    let cancelled = false
    fetchAgents().then(rows => {
      if (cancelled) return
      setAgents(rows)
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [])

  async function refresh() {
    cache = null
    setLoading(true)
    const fresh = await fetchAgents()
    setAgents(fresh)
    setLoading(false)
  }

  const assignable = agents.filter(a => a.assignable && !a.archived)

  return {
    agents,
    slugs: assignable.map(a => a.slug),
    loading,
    refresh,
    labelOf: (slug: string) => agents.find(a => a.slug === slug)?.label ?? slug,
    kindOf: (slug: string) => agents.find(a => a.slug === slug)?.kind ?? 'routing-only',
  }
}
