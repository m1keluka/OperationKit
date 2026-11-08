/**
 * Hard workspace containment for knowledge-base paths (obj 900321, constraint C13).
 *
 * ## The hole this closes
 *
 * The knowledge base is ONE tree with workspaces as folders inside it. Until now
 * the only workspace wall was:
 *
 *   1. `resolveUnder()` on the `/api/docs` + `/api/files` HTTP routes — a real,
 *      realpath-based wall (obj 900204), and
 *   2. a *ranking bonus* inside retrieval (`+6` grep score, `-2.0` bm25) applied
 *      when `inWorkspaceFolder()` matched.
 *
 * (2) is not a wall. `services/context-builder.ts` calls `searchKnowledge()`
 * DIRECTLY at spawn, bypassing (1) entirely, so another workspace's note was
 * injected into a worker's prompt whenever it out-scored the card's own notes.
 * Isolation held for a *deliberate* read and leaked on the *automatic* one.
 *
 * `inWorkspaceFolder()` was itself bypassable twice over:
 *
 *   - **Nested-name spoof.** It tested `file.includes('/workspaces/<ws>/')`, a
 *     bare substring. `…/workspaces/example/notes/workspaces/operationkit/x.md`
 *     lives under `example` and read as `operationkit`.
 *   - **Symlink escape.** No realpath, so `…/workspaces/operationkit/link.md ->
 *     …/workspaces/example/secret.md` was in-scope by its lexical path while the
 *     bytes served came from another workspace.
 *
 * ## The rule now
 *
 * A path is in `workspace`'s scope only when its **realpath** is the workspace
 * root itself or sits under it with a `/` boundary. Both sides are realpath'd,
 * so a symlink that leaves the root is out of scope; containment is computed on
 * path SEGMENTS, so a nested folder of the same name cannot spoof it.
 *
 * Fails CLOSED everywhere: an unresolvable path, an unreadable root, a missing
 * or malformed workspace slug all return `false` / `[]`. A retrieval path that
 * cannot prove containment must not inject the hit.
 */
import fs from 'fs'
import path from 'path'
import { knowledgeBaseRoot } from './knowledge-base-root.js'

/** Workspace slugs are folder names. Anything else (``..``, ``/``, NUL) is refused. */
export const WORKSPACE_SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/i

export function isValidWorkspaceSlug(workspace: unknown): workspace is string {
  return typeof workspace === 'string' && WORKSPACE_SLUG.test(workspace)
}

/** realpath, or null when the path cannot be resolved. Never throws. */
export function realpathOrNull(p: string): string | null {
  if (!p || p.includes('\0')) return null
  try {
    return fs.realpathSync(path.resolve(p))
  } catch {
    return null
  }
}

/**
 * The on-disk root(s) that make up `workspace`'s slice of the knowledge base.
 *
 * Both layouts are honoured because both exist on real installs: a vault keeps
 * workspaces under `<root>/workspaces/<slug>`, the `/app/data` fallback keeps
 * them directly under `<root>/<slug>` (see `knowledge-base-root.ts`). Only roots
 * that actually resolve are returned, so a non-existent folder yields `[]` and
 * therefore an empty scope — fail closed, never "everything".
 */
export function workspaceScopeRoots(
  workspace: string,
  root: string = knowledgeBaseRoot(),
): string[] {
  if (!isValidWorkspaceSlug(workspace)) return []
  const base = realpathOrNull(root) ?? path.resolve(root)
  // BOTH layouts, unconditionally. A vault keeps workspaces under
  // `<root>/workspaces/<slug>`, the /app/data fallback directly under
  // `<root>/<slug>` (see knowledge-base-root.ts). Listing both is strictly
  // narrower than it looks — each is still one named folder of this ONE
  // workspace — and it keeps the check independent of ambient env, which a
  // security predicate should not depend on.
  const candidates = [path.join(base, 'workspaces', workspace), path.join(base, workspace)]
  const out: string[] = []
  for (const c of candidates) {
    // A root that exists is pinned to its REAL location; one that does not is
    // kept lexically, so the predicate still answers for a path that has not
    // been created yet (and answers `false` for everything outside it).
    const real = realpathOrNull(c) ?? c
    if (!out.includes(real)) out.push(real)
  }
  return out
}

/**
 * True when `candidate` is `root` or sits under it on a SEGMENT boundary.
 *
 * Each side is pinned to its realpath when it exists and resolved lexically
 * when it does not. That ordering is what matters: a candidate that EXISTS is
 * always compared at its real location, so a symlink pointing out of the root
 * is rejected; a candidate that does not exist still gets the segment-boundary
 * check, so `<root>/acme-two` never counts as `<root>/acme`.
 */
export function containedIn(candidate: string, root: string): boolean {
  if (!candidate || !root || candidate.includes('\0') || root.includes('\0')) return false
  const c = realpathOrNull(candidate) ?? path.resolve(candidate)
  const r = realpathOrNull(root) ?? path.resolve(root)
  if (c === r) return true
  const rel = path.relative(r, c)
  return rel !== '' && !rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel)
}

/**
 * The authoritative check: is `file` inside `workspace`'s knowledge-base scope?
 *
 * `extraRoots` lets a caller add roots it has already authorised for that ONE
 * workspace (e.g. a `vault_path` override row) without widening the default.
 */
export function isInWorkspaceScope(
  file: string,
  workspace: string,
  root: string = knowledgeBaseRoot(),
  extraRoots: string[] = [],
): boolean {
  if (!isValidWorkspaceSlug(workspace)) return false
  const roots = [...workspaceScopeRoots(workspace, root), ...extraRoots]
  if (roots.length === 0) return false
  return roots.some((r) => containedIn(file, r))
}

/**
 * Drop every hit that cannot be PROVEN to live in `workspace`'s scope.
 *
 * This is the function that turns the old ranking bonus into a wall: it is a
 * filter, so no score, bm25 weight or synonym expansion can promote another
 * workspace's note back into the result set.
 */
export function filterToWorkspaceScope<T extends { path: string }>(
  hits: T[],
  workspace: string | null | undefined,
  root: string = knowledgeBaseRoot(),
  extraRoots: string[] = [],
): T[] {
  if (!workspace) return hits
  if (!isValidWorkspaceSlug(workspace)) return []
  const roots = [...workspaceScopeRoots(workspace, root), ...extraRoots]
  if (roots.length === 0) return []
  return hits.filter((h) => roots.some((r) => containedIn(h.path, r)))
}
