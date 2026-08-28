// Centralized API client with auth, error handling, and typed responses
const BASE = '/api'

class ApiError extends Error {
  constructor(public status: number, public body: unknown, message: string) {
    super(message)
  }
}

async function request<T>(path: string, options?: RequestInit & { timeoutMs?: number }): Promise<T> {
  const { timeoutMs, ...init } = options ?? {}
  const ctrl = timeoutMs ? new AbortController() : null
  const timer = timeoutMs ? setTimeout(() => ctrl!.abort(), timeoutMs) : null
  let res: Response
  try {
    res = await fetch(`${BASE}${path}`, {
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...init.headers },
      ...init,
      signal: ctrl?.signal ?? init.signal,
    })
  } catch (err) {
    if (ctrl?.signal.aborted) {
      throw new ApiError(0, null, 'Request timed out — message not sent')
    }
    throw err
  } finally {
    if (timer) clearTimeout(timer)
  }
  if (!res.ok) {
    const body = await res.json().catch(() => null)
    throw new ApiError(res.status, body, body?.error || `Request failed: ${res.status}`)
  }
  if (res.status === 204) return undefined as T
  return res.json()
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown, opts?: { timeoutMs?: number }) =>
    request<T>(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined, timeoutMs: opts?.timeoutMs }),
  put: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PUT', body: body ? JSON.stringify(body) : undefined }),
  patch: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PATCH', body: body ? JSON.stringify(body) : undefined }),
  del: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
}

// ── Objective search (obj 702389) ───────────────────────────────────────────
// Consumes the server-side search endpoints (obj 702388). Both are RBAC-scoped
// and span ALL statuses (incl. done/cancelled) so the Done backlog is findable.
import type { ObjectiveStatus } from '@command-center/shared'

// GET /api/objectives/search result row (keyword + fuzzy).
export interface ObjectiveSearchResult {
  id: number
  title: string | null
  status: ObjectiveStatus
  workspace: string
  agent_context: string | null
  updated_at: string
  score: number
  snippet: string
}

// POST /api/objectives/search/ai result row (Haiku-ranked, per-result reason).
export interface ObjectiveAiSearchResult {
  id: number
  title: string | null
  status: ObjectiveStatus
  workspace: string
  reason: string
}

// Keyword/fuzzy search. `workspace` may be a slug or 'all'.
export function searchObjectives(
  q: string,
  workspace?: string,
  limit?: number,
): Promise<{ results: ObjectiveSearchResult[] }> {
  const params = new URLSearchParams({ q })
  if (workspace) params.set('workspace', workspace)
  if (limit) params.set('limit', String(limit))
  return api.get<{ results: ObjectiveSearchResult[] }>(`/objectives/search?${params.toString()}`)
}

// Natural-language AI search. Throws ApiError(502) when AI search is unavailable
// (e.g. ANTHROPIC_API_KEY unset) — callers surface a graceful message.
export function searchObjectivesAi(
  q: string,
  workspace?: string,
): Promise<{ results: ObjectiveAiSearchResult[] }> {
  return api.post<{ results: ObjectiveAiSearchResult[] }>('/objectives/search/ai', { q, workspace })
}

export { ApiError }
