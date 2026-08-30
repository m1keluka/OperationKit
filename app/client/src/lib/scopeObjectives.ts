import type { Objective, Workspace } from '@operationkit/shared'

/**
 * Authoritative render-time workspace scope gate (obj 700082).
 *
 * Returns only the objectives that belong on a board scoped to `scope`.
 * `'all'` or an empty array passes everything through. A single workspace
 * slug keeps the original filter. A multi-select array keeps objectives whose
 * workspace is in the set. Any objective outside the active scope is dropped
 * — so the board can never display another organization's cards regardless of
 * how they entered React state (WebSocket reconnect race, error-recovery
 * refetch, or stale state lingering from the previous workspace during a
 * switch). This is a pure function of its inputs, so it re-derives instantly
 * when the scope changes — no network round-trip, no race window.
 */
export function scopeObjectives(objectives: Objective[], scope: Workspace | Workspace[]): Objective[] {
  const list = Array.isArray(scope)
    ? scope.filter(w => w && w !== 'all')
    : (scope && scope !== 'all' ? [scope] : [])
  if (list.length === 0) return objectives
  if (list.length === 1) return objectives.filter(o => o.workspace === list[0])
  const allowed = new Set(list)
  return objectives.filter(o => allowed.has(o.workspace))
}
