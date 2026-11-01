import fs from 'fs'
import path from 'path'

/** Fallback KB home on installs with no vault: /app/data is persisted on every install. */
export const DATA_KB_DIR = '/app/data/knowledge-base'
const DEFAULT_VAULT_DIR = '/home/operator/second-brain'

/**
 * The ONE knowledge base on this install (obj 720348). The Knowledge base page,
 * search, the knowledge MCP tools and every import resolve to this folder; no
 * caller picks a "source". First match wins:
 *   1. SECOND_BRAIN_ROOT / SECOND_BRAIN_DIR set explicitly;
 *   2. the vault at its default path when it exists on this host;
 *   3. /app/data/knowledge-base (DOC_INGEST_KB_DIR overrides) — a fresh install
 *      has no vault mounted, and anything outside /app/data vanishes on rebuild.
 * Evaluated per call so tests and env changes are honoured.
 */
export function knowledgeBaseRoot(env: NodeJS.ProcessEnv = process.env, vaultOnHost = fs.existsSync(DEFAULT_VAULT_DIR)): string {
  const vault = env.SECOND_BRAIN_ROOT || env.SECOND_BRAIN_DIR
  if (vault) return path.resolve(vault)
  if (vaultOnHost) return DEFAULT_VAULT_DIR
  return path.resolve(env.DOC_INGEST_KB_DIR || DATA_KB_DIR)
}

/**
 * A vault keeps each workspace under `workspaces/<slug>`; the /app/data
 * fallback keeps it directly under `<slug>` (the layout installs already have
 * on disk, so it is not moved).
 */
export function isVaultLayout(env: NodeJS.ProcessEnv = process.env, vaultOnHost = fs.existsSync(DEFAULT_VAULT_DIR)): boolean {
  return !!(env.SECOND_BRAIN_ROOT || env.SECOND_BRAIN_DIR) || vaultOnHost
}

/** Default folder for one workspace inside the knowledge base (no row override). */
export function defaultWorkspaceKbDir(workspace: string, env: NodeJS.ProcessEnv = process.env, vaultOnHost = fs.existsSync(DEFAULT_VAULT_DIR)): string {
  const root = knowledgeBaseRoot(env, vaultOnHost)
  return isVaultLayout(env, vaultOnHost) ? path.join(root, 'workspaces', workspace) : path.join(root, workspace)
}

/** Is `file` inside `workspace`'s folder of the knowledge base (either layout)? */
export function inWorkspaceFolder(file: string, workspace: string, root: string = knowledgeBaseRoot()): boolean {
  if (file.includes(`/workspaces/${workspace}/`)) return true
  return file.startsWith(path.join(root, workspace) + path.sep)
}
