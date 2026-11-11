/**
 * Keep `<AI_WORKSPACE_DIR>/workspaces.json` in step with repos registered through
 * the admin API (obj 79). Fresh installs never had this file, so resolveWorkdir
 * failed closed for every project-linked card. Registration now upserts
 * `{ name, path }` under the workspace, creating a minimal file if needed.
 *
 * Merge-only: other workspaces, other projects and any unknown keys are
 * preserved byte-for-byte in meaning. An unparseable existing file is NEVER
 * overwritten (it may be hand-edited) — the write is skipped and logged.
 */
import fs from 'fs'
import path from 'path'
import { WORKSPACES_JSON } from '../config.js'

type Project = { name: string; path: string; [k: string]: unknown }
type WorkspaceEntry = { projects?: Project[]; [k: string]: unknown }
type WorkspacesFile = { workspaces?: Record<string, WorkspaceEntry>; [k: string]: unknown }

export const MINIMAL_WORKSPACES_JSON = '{"workspaces":{}}\n'

export type UpsertResult = 'created' | 'added' | 'updated' | 'unchanged' | 'skipped'

export function upsertWorkspacesJsonProject(
  opts: { workspace: string; name: string; repoPath: string },
  file: string = WORKSPACES_JSON,
): UpsertResult {
  const { workspace, name } = opts
  const repoPath = opts.repoPath.trim().replace(/\/+$/, '')
  if (!workspace || !name || !repoPath.startsWith('/')) return 'skipped'
  // Same hazard class as db/index.ts's production-DB refusal: a route test that
  // registers a repo must never rewrite the live registry. Tests pass `file`.
  if (file === WORKSPACES_JSON && !process.env.WORKSPACES_JSON_PATH && (process.env.VITEST || process.env.NODE_ENV === 'test')) return 'skipped'

  let data: WorkspacesFile
  let existed = true
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8')) as WorkspacesFile
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('not an object')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(`[workspaces-json] ${file} is unreadable/invalid — not overwriting it: ${(err as Error).message}`)
      return 'skipped'
    }
    existed = false
    data = { workspaces: {} }
  }

  if (!data.workspaces || typeof data.workspaces !== 'object') data.workspaces = {}
  const ws = (data.workspaces[workspace] ??= { projects: [] })
  if (!Array.isArray(ws.projects)) ws.projects = []
  const cur = ws.projects.find(p => p && p.name === name)
  let result: UpsertResult
  if (!cur) {
    ws.projects.push({ name, path: repoPath })
    result = existed ? 'added' : 'created'
  } else if (cur.path !== repoPath) {
    cur.path = repoPath
    result = 'updated'
  } else {
    return 'unchanged'
  }

  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n')
    fs.renameSync(tmp, file)
  } catch (err) {
    console.warn(`[workspaces-json] could not write ${file}: ${(err as Error).message}`)
    return 'skipped'
  }
  return result
}
