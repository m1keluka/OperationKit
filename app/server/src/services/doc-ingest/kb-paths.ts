import fs from 'fs'
import path from 'path'
import { SECOND_BRAIN_DIR } from '../../config.js'
import { getWorkspace } from '../workspaces.js'

/** Fallback KB home on installs with no vault: /app/data is persisted on every install. */
export const DATA_KB_DIR = '/app/data/knowledge-base'

/**
 * Where a workspace's knowledge base lives on disk (obj 719936). First match wins:
 *   1. the workspace row's `vault_path`;
 *   2. `<SECOND_BRAIN_DIR>/workspaces/<slug>` when that vault exists (or
 *      SECOND_BRAIN_DIR is set explicitly) — the subtree the vault index,
 *      search boost and decision capture already use;
 *   3. `/app/data/knowledge-base/<slug>` — a fresh client install has no vault
 *      mounted, and anything outside /app/data would vanish on a rebuild.
 * Only the slug comes from the request, and it is validated here.
 */
export function workspaceKbRoot(workspace: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(workspace)) throw new Error(`invalid workspace slug: ${workspace}`)
  let vault: string | null | undefined
  try { vault = getWorkspace(workspace)?.vault_path } catch { vault = null }
  if (vault) return path.resolve(vault)
  if (env.SECOND_BRAIN_DIR || fs.existsSync(SECOND_BRAIN_DIR)) return path.resolve(SECOND_BRAIN_DIR, 'workspaces', workspace)
  return path.resolve(env.DOC_INGEST_KB_DIR || DATA_KB_DIR, workspace)
}
