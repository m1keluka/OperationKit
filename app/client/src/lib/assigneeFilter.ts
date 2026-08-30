import type { Objective } from '@operationkit/shared'

/* ─────────────────────────────────────────────────────────
   Assignee filter — pure logic for the board's multi-select
   assignee filter (obj 700857). Kept framework-free so the
   matching / default / roster rules are unit-testable without
   mounting the board. The React state + localStorage wiring
   lives in KanbanBoard.tsx; these are the primitives it uses.
   ───────────────────────────────────────────────────────── */

/** Sentinel token for the "Unassigned" bucket. Wrapped in double underscores so
 *  it can't realistically collide with a real username. Selected tokens are
 *  usernames + this. */
export const UNASSIGNED_TOKEN = '__unassigned__'

const STORAGE_PREFIX = 'cc-assignee-filter:'

type AssigneeLike = Pick<Objective, 'assigned_usernames'>

/** True when `obj` should be shown given the set of selected assignee tokens:
 *  - matches if ANY of its `assigned_usernames` is selected, OR
 *  - it has no assignees and UNASSIGNED_TOKEN is selected.
 *  An empty selection matches nothing. */
export function matchesAssigneeFilter(obj: AssigneeLike, selected: ReadonlySet<string>): boolean {
  const names = obj.assigned_usernames ?? []
  if (names.length === 0) return selected.has(UNASSIGNED_TOKEN)
  return names.some(n => selected.has(n))
}

/** Distinct assignee usernames present across `objectives`, alpha-sorted.
 *  Derived from the data itself so arbitrary future users (Ava, …) appear
 *  automatically — nothing is hardcoded. */
export function assigneeRoster(objectives: ReadonlyArray<AssigneeLike>): string[] {
  const set = new Set<string>()
  for (const o of objectives) for (const n of o.assigned_usernames ?? []) set.add(n)
  return [...set].sort((a, b) => a.localeCompare(b))
}

/** Default selection = Unassigned + the current user (matched by username), so
 *  by default a user sees unassigned work plus their own, and NOT objectives
 *  assigned solely to someone else. */
export function defaultAssigneeSelection(currentUsername: string | null | undefined): string[] {
  return currentUsername ? [UNASSIGNED_TOKEN, currentUsername] : [UNASSIGNED_TOKEN]
}

/** Load a persisted per-workspace selection, or null if none is stored yet
 *  (so the caller can fall back to the default only on first use). */
export function loadAssigneeSelection(workspace: string): string[] | null {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + workspace)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : null
  } catch {
    return null
  }
}

/** Persist a per-workspace selection so the default only applies on first use. */
export function saveAssigneeSelection(workspace: string, selection: string[]): void {
  try {
    localStorage.setItem(STORAGE_PREFIX + workspace, JSON.stringify(selection))
  } catch {
    /* private-mode / quota — non-fatal, the filter just won't persist */
  }
}
