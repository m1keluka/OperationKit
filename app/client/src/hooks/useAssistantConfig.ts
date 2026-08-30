import { useCallback, useEffect, useState } from 'react'
import { api } from '../lib/api'

/**
 * Client-local DTO for the per-user assistant configuration.
 *
 * These types intentionally MIRROR the frozen `/api/assistant/config` JSON
 * contract but are declared here (not imported from `@operationkit/shared`)
 * so this frontend worktree stays tsc-clean and merge-conflict-free while a
 * parallel backend worker owns the shared package. Keep in sync with the
 * server contract by hand.
 */
export type AutonomyLevel =
  | 'read_only'
  | 'confirm_all'
  | 'confirm_external'
  | 'autonomous'

export interface AssistantPersona {
  displayName: string
  tagline: string | null
  systemPrompt: string
  manualSource: string | null
}

export interface AssistantAutonomy {
  level: AutonomyLevel
  overrides: Record<string, unknown> | null
}

export interface AssistantConfig {
  userId: number
  workspace: string
  persona: AssistantPersona
  model: string | null
  autonomy: AssistantAutonomy
  enabledCapabilities: string[]
  enabledConnectors: string[]
  enabled: boolean
  createdAt: string
  updatedAt: string
}

/**
 * A partial of the config accepted by PUT. Nested objects are merged
 * server-side, so callers may send only the fields they changed
 * (e.g. `{ persona: { displayName: 'Ada' } }`).
 */
export type AssistantConfigUpdate = {
  persona?: Partial<AssistantPersona>
  model?: string | null
  autonomy?: Partial<AssistantAutonomy>
  enabledCapabilities?: string[]
  enabledConnectors?: string[]
  enabled?: boolean
}

interface UseAssistantConfigResult {
  config: AssistantConfig | null
  loading: boolean
  error: string | null
  /** Re-fetch the caller's config from the server. */
  refresh: () => Promise<void>
  /** Persist a partial update; returns (and stores) the full updated config. */
  save: (update: AssistantConfigUpdate) => Promise<AssistantConfig>
}

/**
 * Loads and saves the caller's personal assistant config. Mirrors the
 * data-fetching pattern in `useMentorThreads` — one GET on mount, an
 * imperative save that returns the fresh row and updates local state.
 */
export function useAssistantConfig(): UseAssistantConfigResult {
  const [config, setConfig] = useState<AssistantConfig | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const data = await api.get<AssistantConfig>('/assistant/config')
      setConfig(data)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to load assistant config')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const save = useCallback(async (update: AssistantConfigUpdate): Promise<AssistantConfig> => {
    const updated = await api.put<AssistantConfig>('/assistant/config', update)
    setConfig(updated)
    setError(null)
    return updated
  }, [])

  return { config, loading, error, refresh, save }
}
