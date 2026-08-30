import type { Objective } from '@operationkit/shared'

/* ─────────────────────────────────────────────────────────
   Project filter — pure logic for the board's "open a
   subfolder inside the organization" selector (obj 708826).

   A *project* here is a row in the `projects` table, joined to
   an objective by `objectives.project_id`. It is NOT the legacy
   `objectives.project` repo-link column — see the Project /
   Repository split in ObjectiveModal.

   Kept framework-free so matching + persistence are unit-testable
   without mounting the board; the React wiring lives in
   KanbanBoard.tsx.
   ───────────────────────────────────────────────────────── */

/** Sentinel for "All projects" — the default, shows everything. */
export const ALL_PROJECTS = 'all'
/** Sentinel for the "No project" bucket (objectives with project_id === null). */
export const UNASSIGNED_PROJECT = 'none'

/** A board project selection: 'all', 'none', or a numeric project id. */
export type ProjectSelection = typeof ALL_PROJECTS | typeof UNASSIGNED_PROJECT | number

const STORAGE_PREFIX = 'cc-project-filter:'

type ProjectLike = Pick<Objective, 'project_id'>

/** True when `obj` should be visible under the given selection.
 *  'all' matches everything; 'none' matches only unassigned objectives;
 *  a number matches only objectives in that project. */
export function matchesProjectFilter(obj: ProjectLike, selection: ProjectSelection): boolean {
  if (selection === ALL_PROJECTS) return true
  if (selection === UNASSIGNED_PROJECT) return obj.project_id == null
  return obj.project_id === selection
}

/** Load the persisted selection for a workspace key, or null when nothing is
 *  stored (so the caller falls back to ALL_PROJECTS on first use). Values that
 *  aren't a known sentinel or a positive integer are treated as absent. */
export function loadProjectSelection(workspaceKey: string): ProjectSelection | null {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + workspaceKey)
    if (!raw) return null
    if (raw === ALL_PROJECTS || raw === UNASSIGNED_PROJECT) return raw
    const n = Number(raw)
    return Number.isInteger(n) && n > 0 ? n : null
  } catch {
    return null
  }
}

/** Persist the selection under the workspace key. Storing per workspace is what
 *  makes the selection RESET when the organization changes: the new workspace
 *  has its own (usually empty) slot, so the board falls back to All projects. */
export function saveProjectSelection(workspaceKey: string, selection: ProjectSelection): void {
  try {
    localStorage.setItem(STORAGE_PREFIX + workspaceKey, String(selection))
  } catch {
    /* private-mode / quota — non-fatal, the filter just won't persist */
  }
}
