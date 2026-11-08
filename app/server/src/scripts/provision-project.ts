#!/usr/bin/env tsx
/**
 * Provision a project checkout and map it in a workspace so resolveWorkdir can
 * spawn project-linked cards for it (obj 900326). Idempotent.
 *
 *   # read-only verification (writes nothing; exit 0 only when resolvable + clean):
 *   docker exec command-center tsx /app/server/src/scripts/provision-project.ts \
 *     --check example example-website your-org/example-website
 *
 *   # clone (only if the path is missing) + register + verify:
 *   docker exec command-center tsx /app/server/src/scripts/provision-project.ts \
 *     example example-website your-org/example-website [--branch main] [--path /abs/path]
 *
 * An existing checkout is never pulled, reset or switched. Prints JSON; never
 * prints credentials.
 */
import { initDb, getDb } from '../db/index.js'
import { createWorkspaceRepo } from '../services/workspace-repos.js'
import { ensureRepoCredentialHelper } from '../services/repo-git-auth.js'
import {
  inspectProject,
  provisionProject,
  validateProvisionOpts,
  type ProvisionDeps,
  type ProvisionOpts,
} from '../services/project-provision.js'

const argv = process.argv.slice(2)
const check = argv.includes('--check')
const flag = (n: string): string | undefined => {
  const i = argv.indexOf(n)
  return i >= 0 ? argv[i + 1] : undefined
}
const positional = argv.filter((a, i) => !a.startsWith('--') && !['--branch', '--path'].includes(argv[i - 1]))
const [workspace, name, github] = positional
if (!workspace || !name || !github) {
  console.error('usage: provision-project [--check] <workspace> <name> <owner/repo> [--branch main] [--path /abs]')
  process.exit(2)
}
const opts: ProvisionOpts = { workspace, name, github, branch: flag('--branch'), repoPath: flag('--path') }
const invalid = validateProvisionOpts(opts)
if (invalid) {
  console.error(invalid)
  process.exit(2)
}

initDb()
const deps: ProvisionDeps = {
  findRepoRow: (ws, n) =>
    getDb().prepare('SELECT id, repo_path FROM workspace_repos WHERE workspace = ? AND name = ? ORDER BY id LIMIT 1')
      .get(ws, n) as { id: number; repo_path: string | null } | undefined,
  insertRepoRow: r => { createWorkspaceRepo(r) },
  credentialHelper: ensureRepoCredentialHelper,
}

try {
  if (check) {
    const inspection = inspectProject(opts, deps)
    console.log(JSON.stringify({ mode: 'check', ...inspection }, null, 2))
    process.exit(inspection.ok ? 0 : 1)
  }
  const result = provisionProject(opts, deps)
  console.log(JSON.stringify({ mode: 'provision', ...result }, null, 2))
  process.exit(result.inspection.ok ? 0 : 1)
} catch (err) {
  console.error((err as Error).message)
  process.exit(1)
}
