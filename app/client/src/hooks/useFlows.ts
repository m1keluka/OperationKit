import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  FlowApprovalDecision, FlowDetailResponse, FlowListResponse, FlowLiveEvent, FlowNodeInspectResponse, FlowRunDetailResponse,
  FlowRunSummary, FlowRunsResponse, FlowSelfTest, FlowSummary, FlowUnknownOutcomeDecision,
} from '../../../shared/flow/api'
import { subscribeServerMessages } from './useWebSocket'
import type { FlowApprovals } from '../../../shared/flow/types'

/**
 * Workflows (okflow/1) for Jobs → Workflows and the workflow rows in the Jobs
 * lanes (obj 900640, card B4). Reads GET /api/flows + GET /api/flows/runs; the
 * server enforces the workspace filter, this hook never widens it.
 */
export interface UseFlowsResult {
  flows: FlowSummary[]
  runs: FlowRunSummary[]
  /** settings.flows_enabled — the kill switch (default off). */
  flowsEnabled: boolean
  loading: boolean
  error: string | null
  refresh: () => Promise<void>
  /** POST /api/flows/:id/runs — queue a live run of the published version. */
  runNow: (flowId: number) => Promise<{ ok: boolean; reason?: string; run_id?: number }>
}

export function useFlows(): UseFlowsResult {
  const [flows, setFlows] = useState<FlowSummary[]>([])
  const [runs, setRuns] = useState<FlowRunSummary[]>([])
  const [flowsEnabled, setFlowsEnabled] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const [rf, rr] = await Promise.all([
        fetch('/api/flows', { credentials: 'include' }),
        fetch('/api/flows/runs?limit=200', { credentials: 'include' }),
      ])
      if (!rf.ok) throw new Error(`HTTP ${rf.status}`)
      const f = (await rf.json()) as FlowListResponse
      setFlows(Array.isArray(f.flows) ? f.flows : [])
      setFlowsEnabled(!!f.flows_enabled)
      if (rr.ok) {
        const r = (await rr.json()) as FlowRunsResponse
        setRuns(Array.isArray(r.runs) ? r.runs : [])
      }
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load workflows')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
    // Runs execute on the server's 2s engine tick; a light poll keeps lanes current.
    const t = setInterval(() => { void refresh() }, 15_000)
    return () => clearInterval(t)
  }, [refresh])

  const runNow = useCallback(async (flowId: number) => {
    try {
      const r = await fetch(`/api/flows/${flowId}/runs`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ payload: {} }),
      })
      const body = (await r.json().catch(() => ({}))) as { ok?: boolean; reason?: string; error?: string; run_id?: number }
      void refresh()
      return { ok: r.status === 201, reason: body.reason || body.error, run_id: body.run_id }
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : 'Run failed' }
    }
  }, [refresh])

  return { flows, runs, flowsEnabled, loading, error, refresh, runNow }
}

/** GET /api/flows/:id (definition, versions, Mermaid with last-run status, recent runs). */
export function useFlowDetail(flowId: number | null, version?: number | null) {
  const [detail, setDetail] = useState<FlowDetailResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    if (flowId == null) { setDetail(null); return }
    setLoading(true)
    try {
      const q = version != null ? `?version=${version}` : ''
      const r = await fetch(`/api/flows/${flowId}${q}`, { credentials: 'include' })
      if (!r.ok) throw new Error(r.status === 403 ? 'No access to this workflow’s workspace' : `HTTP ${r.status}`)
      setDetail((await r.json()) as FlowDetailResponse)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load workflow')
    } finally {
      setLoading(false)
    }
  }, [flowId, version])

  useEffect(() => { void load() }, [load])
  return { detail, error, loading, reload: load }
}

/** GET /api/flows/:id/runs/:runId (step rows + Mermaid overlay for that run). */
export async function fetchFlowRun(flowId: number, runId: number): Promise<FlowRunDetailResponse> {
  const r = await fetch(`/api/flows/${flowId}/runs/${runId}`, { credentials: 'include' })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return (await r.json()) as FlowRunDetailResponse
}

/** POST /api/flows/:id/test — self-test one version (B5). `dry` never calls out. */
export async function runFlowSelfTest(
  flowId: number,
  args: { version: number; mode: 'dry' | 'test' },
): Promise<{ ok: boolean; self_test?: FlowSelfTest; reason?: string }> {
  try {
    const r = await fetch(`/api/flows/${flowId}/test`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    })
    const body = (await r.json().catch(() => ({}))) as { self_test?: FlowSelfTest; reason?: string; error?: string }
    return { ok: r.ok, self_test: body.self_test, reason: body.reason || body.error }
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : 'Self-test failed to start' }
  }
}

/**
 * POST /api/flows/:id/publish — owner/admin only (cookie). `approve` must name
 * exactly the version's send/spend nodes; the server records that approval.
 */
export async function publishFlow(
  flowId: number,
  args: { version: number; approve: string[] },
): Promise<{ ok: boolean; reason?: string; error?: string; approvals?: FlowApprovals }> {
  try {
    const r = await fetch(`/api/flows/${flowId}/publish`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    })
    const body = (await r.json().catch(() => ({}))) as { reason?: string; error?: string; approvals?: FlowApprovals }
    return { ok: r.ok, reason: body.reason, error: body.error, approvals: body.approvals }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Publish failed' }
  }
}

/**
 * POST /api/flows/:id/runs/:runId/approval — Approve / Reject an approval `wait`
 * (B9, §5.4). Cookie owner/admin only; anything else is a 403 from the server.
 */
export async function answerFlowApproval(
  flowId: number,
  runId: number,
  args: { decision: FlowApprovalDecision; node_id?: string; iteration?: number; note?: string },
): Promise<{ ok: boolean; error?: string }> {
  try {
    const r = await fetch(`/api/flows/${flowId}/runs/${runId}/approval`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    })
    const body = (await r.json().catch(() => ({}))) as { error?: string; reason?: string }
    return { ok: r.ok, error: r.ok ? undefined : body.error || body.reason || `HTTP ${r.status}` }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Request failed' }
  }
}

/** POST /api/flows/:id/runs/:runId/outcome — "unknown outcome, confirm" after a crash (B9). Cookie owner/admin only. */
export async function confirmFlowOutcome(
  flowId: number,
  runId: number,
  args: { node_id: string; outcome: FlowUnknownOutcomeDecision },
): Promise<{ ok: boolean; error?: string }> {
  try {
    const r = await fetch(`/api/flows/${flowId}/runs/${runId}/outcome`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    })
    const body = (await r.json().catch(() => ({}))) as { error?: string; reason?: string }
    return { ok: r.ok, error: r.ok ? undefined : body.error || body.reason || `HTTP ${r.status}` }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Request failed' }
  }
}

/**
 * Click-to-inspect (B7): one node's config, attempts and last good run. The
 * server redacts every field at read time; the side panel shows only this.
 */
export async function fetchFlowNode(
  flowId: number,
  args: { nodeId: string; runId?: number | null; version?: number | null },
): Promise<FlowNodeInspectResponse> {
  const node = encodeURIComponent(args.nodeId)
  const url = args.runId != null
    ? `/api/flows/${flowId}/runs/${args.runId}/nodes/${node}`
    : `/api/flows/${flowId}/nodes/${node}${args.version != null ? `?version=${args.version}` : ''}`
  const r = await fetch(url, { credentials: 'include' })
  if (!r.ok) throw new Error(r.status === 403 ? 'No access to this workflow’s workspace' : `HTTP ${r.status}`)
  return (await r.json()) as FlowNodeInspectResponse
}

/**
 * Live overlay (B7): calls `onEvent` for every `flow_step` WebSocket message
 * about `flowId`, debounced so a burst (a loop writing many rows) becomes one
 * refetch. The message carries ids + status only; the caller refetches the run.
 */
export function useFlowLiveEvents(
  flowId: number | null,
  onEvent: (events: FlowLiveEvent[]) => void,
  debounceMs = 200,
): void {
  const cb = useRef(onEvent)
  cb.current = onEvent
  useEffect(() => {
    if (flowId == null) return
    let pending: FlowLiveEvent[] = []
    let timer: ReturnType<typeof setTimeout> | null = null
    const unsub = subscribeServerMessages(msg => {
      if (msg.type !== 'flow_step' || msg.payload.flow_id !== flowId) return
      pending.push(msg.payload)
      if (timer) return
      timer = setTimeout(() => {
        timer = null
        const batch = pending
        pending = []
        cb.current(batch)
      }, debounceMs)
    })
    return () => {
      unsub()
      if (timer) clearTimeout(timer)
    }
  }, [flowId, debounceMs])
}
