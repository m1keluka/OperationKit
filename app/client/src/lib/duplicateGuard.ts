// Duplicate-card guard (obj 64): POST /api/objectives answers 409 with
// { reason: 'duplicate_24h', existing_id, existing } when an OPEN card with the
// same normalized title exists in the workspace (created in the last 24h). The
// create form shows the existing card and offers "Create anyway" (force: true).
//
// Duck-typed on purpose (status + body), so it works with the real ApiError and
// with test doubles that mock '../lib/api'.

export interface DuplicateCard {
  id: number
  title: string
  status: string
}

export function parseDuplicateError(err: unknown): DuplicateCard | null {
  if (!err || typeof err !== 'object') return null
  const e = err as { status?: unknown; body?: unknown }
  if (e.status !== 409 || !e.body || typeof e.body !== 'object') return null
  const body = e.body as { reason?: unknown; existing_id?: unknown; existing?: { title?: unknown; status?: unknown } }
  if (body.reason !== 'duplicate_24h' || typeof body.existing_id !== 'number') return null
  return {
    id: body.existing_id,
    title: typeof body.existing?.title === 'string' ? body.existing.title : '',
    status: typeof body.existing?.status === 'string' ? body.existing.status : '',
  }
}

/** Board deep link for a card. */
export function cardHref(id: number): string {
  return `/o/${id}`
}
