import { useState, useEffect, useCallback, useRef } from 'react'
import { fetchBoardLayer, type BoardLayerPayload } from '../lib/board-layer'

/**
 * The project-scoped OperationKit layer graph (obj 712126).
 *
 * Follows the useProjects idiom: a request-id guard so a slow response for a
 * previously-selected scope can never land after the user has already switched.
 * `projectId === null` means "everything in this workspace".
 */
export function useBoardLayer(workspace: string | null, projectId: number | null) {
  const [data, setData] = useState<BoardLayerPayload | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const reqId = useRef(0)

  const refresh = useCallback(async () => {
    if (!workspace || workspace === 'all') {
      setData(null)
      setError(null)
      setLoading(false)
      return
    }
    const mine = ++reqId.current
    setLoading(true)
    try {
      const payload = await fetchBoardLayer(workspace, projectId)
      if (mine !== reqId.current) return
      // A 200 carrying an unrecognised shape must land in the error state
      // rather than throwing inside the render — the same failure mode
      // SkillGraphTab guards against after a frontend-only deploy.
      if (!payload || !Array.isArray(payload.agents) || !Array.isArray(payload.skills)) {
        throw new Error(
          'The board-layer API returned an unrecognised payload. '
          + 'If the frontend was just deployed, the server still needs a restart.',
        )
      }
      setData(payload)
      setError(null)
    } catch (err) {
      if (mine !== reqId.current) return
      setData(null)
      setError(err instanceof Error ? err.message : 'Could not load the board layer')
    } finally {
      if (mine === reqId.current) setLoading(false)
    }
  }, [workspace, projectId])

  useEffect(() => { void refresh() }, [refresh])

  return { data, loading, error, refresh }
}
