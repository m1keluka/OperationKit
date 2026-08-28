import { useCallback, useEffect, useState } from 'react'

// Enriched routine definition as returned by GET /api/admin/routines.
// Workspace/title/cadence/next_run_at are derived server-side (workspace lives
// in the routine's objective_template, not a column).
export interface RoutineSummary {
  id: number
  name: string
  cron_expr: string
  cadence: string
  enabled: boolean
  max_queue_depth: number
  last_run_at: string | null
  next_run_at: string | null
  created_at: string
  title: string
  workspace: string
  agent_context: string
  project: string | null
  category: string
  pending: number
  // obj 2384 — the owning Strategy (a delegate_mode objective), null when the
  // routine is standalone.
  strategy_objective_id: number | null
  strategy_title: string | null
}

/** A delegator objective that can own/steer Jobs (GET /api/admin/strategies). */
export interface StrategyOption {
  id: number
  title: string
  workspace: string
  status: string
  depth: number | null
}

/** Payload for authoring a strategy-owned recurring Job (POST /strategy-jobs). */
export interface StrategyJobInput {
  strategy_objective_id?: number
  strategy_title?: string
  strategy_description?: string
  workspace: string
  job_title: string
  job_prompt: string
  agent_context?: string
  cadence: 'daily' | 'weekdays' | 'weekly' | 'monthly' | 'hourly'
  hour?: number
  minute?: number
  day_of_week?: number
  day_of_month?: number
  enabled?: boolean
}

interface UseRoutinesResult {
  routines: RoutineSummary[]
  routinesEnabled: boolean
  strategies: StrategyOption[]
  loading: boolean
  error: string | null
  refresh: () => Promise<void>
  runNow: (id: number) => Promise<{ ok: boolean; reason?: string; objective_id?: number }>
  createStrategyJob: (input: StrategyJobInput) => Promise<{ ok: boolean; error?: string }>
}

/**
 * Fetches the scheduled-routine definitions for the Jobs tab (admin-only).
 * Read-mostly; refresh() re-pulls so next-run / last-run stay current and
 * run-now results reflect immediately.
 */
export function useRoutines(): UseRoutinesResult {
  const [routines, setRoutines] = useState<RoutineSummary[]>([])
  const [routinesEnabled, setRoutinesEnabled] = useState(true)
  const [strategies, setStrategies] = useState<StrategyOption[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const [rRoutines, rStrategies] = await Promise.all([
        fetch('/api/admin/routines', { credentials: 'include' }),
        fetch('/api/admin/strategies', { credentials: 'include' }),
      ])
      if (!rRoutines.ok) throw new Error(`HTTP ${rRoutines.status}`)
      const data = await rRoutines.json() as { routines_enabled: boolean; routines: RoutineSummary[] }
      setRoutines(Array.isArray(data.routines) ? data.routines : [])
      setRoutinesEnabled(!!data.routines_enabled)
      // Strategy list is best-effort — the routines table renders without it.
      if (rStrategies.ok) {
        const sdata = await rStrategies.json() as { strategies: StrategyOption[] }
        setStrategies(Array.isArray(sdata.strategies) ? sdata.strategies : [])
      }
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load routines')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const runNow = useCallback(async (id: number) => {
    const r = await fetch(`/api/admin/routines/${id}/run-now`, {
      method: 'POST',
      credentials: 'include',
    })
    const body = await r.json().catch(() => ({})) as { ok?: boolean; reason?: string; error?: string; objective_id?: number }
    // run-now returns 201 ok / 409 guard-blocked / 4xx-5xx error. Re-pull so the
    // pending count + next-run reflect the new run.
    void refresh()
    return { ok: r.status === 201 && body.ok !== false, reason: body.reason || body.error, objective_id: body.objective_id }
  }, [refresh])

  const createStrategyJob = useCallback(async (input: StrategyJobInput) => {
    try {
      const r = await fetch('/api/admin/strategy-jobs', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      })
      const body = await r.json().catch(() => ({})) as { error?: string }
      void refresh()
      return { ok: r.status === 201, error: body.error }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : 'Failed to create strategy job' }
    }
  }, [refresh])

  return { routines, routinesEnabled, strategies, loading, error, refresh, runNow, createStrategyJob }
}
