/* Tiny fetch wrapper for /api/kb-wiki/* (obj 720117). Cookie auth like the
   rest of the Knowledge base import panel; server errors are `{error: "<plain sentence>"}`. */

export async function wikiApi<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, headers, ...rest } = init
  const r = await fetch(`/api/kb-wiki${path}`, {
    credentials: 'include',
    ...rest,
    headers: json !== undefined ? { 'Content-Type': 'application/json', ...(headers ?? {}) } : headers,
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  })
  const body = await r.json().catch(() => ({}))
  if (!r.ok) {
    if (r.status === 403) throw new Error((body as { error?: string }).error ?? 'You don’t have permission to do that.')
    throw new Error((body as { error?: string }).error ?? `Something went wrong (error ${r.status}). Please try again.`)
  }
  return body as T
}

export function wsQuery(workspace: string): string {
  return `workspace=${encodeURIComponent(workspace)}`
}
