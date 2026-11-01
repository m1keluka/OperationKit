import path from 'path'
import { getWorkspace, getWorkspaceSlugs } from '../workspaces.js'
import { DATA_KB_DIR, defaultWorkspaceKbDir, knowledgeBaseRoot } from '../../lib/knowledge-base-root.js'

export { DATA_KB_DIR, knowledgeBaseRoot }

/**
 * Where a workspace's knowledge base lives on disk (obj 719936). It is a folder
 * INSIDE the one knowledge base (obj 720348, `knowledgeBaseRoot()`). First match wins:
 *   1. the workspace row's `vault_path`;
 *   2. `<vault>/workspaces/<slug>` when a vault exists (or SECOND_BRAIN_DIR /
 *      SECOND_BRAIN_ROOT is set) — the subtree the vault index, search boost
 *      and decision capture already use;
 *   3. `/app/data/knowledge-base/<slug>` — a fresh client install has no vault
 *      mounted, and anything outside /app/data would vanish on a rebuild.
 * Only the slug comes from the request, and it is validated here.
 */
export function workspaceKbRoot(workspace: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(workspace)) throw new Error(`invalid workspace slug: ${workspace}`)
  let vault: string | null | undefined
  try { vault = getWorkspace(workspace)?.vault_path } catch { vault = null }
  if (vault) return path.resolve(vault)
  return defaultWorkspaceKbDir(workspace, env)
}

/** Every workspace's knowledge folder, for callers that need the whole set. */
export function allWorkspaceKbRoots(env: NodeJS.ProcessEnv = process.env): { workspace: string; dir: string }[] {
  const out: { workspace: string; dir: string }[] = []
  for (const slug of getWorkspaceSlugs()) {
    try { out.push({ workspace: slug, dir: workspaceKbRoot(slug, env) }) } catch { /* bad slug */ }
  }
  return out
}
