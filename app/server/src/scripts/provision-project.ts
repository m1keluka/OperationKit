#!/usr/bin/env tsx
/**
 * Provision a project checkout and map it in a workspace so resolveWorkdir can
 * spawn project-linked cards for it (obj 900326). Idempotent.
 *
 *   # read-only verification (writes nothing; exit 0 only when resolvable + clean):
 *   docker exec command-center tsx /app/server/src/scripts/provision-project.ts \
 *     --check example example-website your-org/example-website [--path /abs/path]
 *
 *   # clone (only if the path is missing, atomically) + register + verify:
 *   docker exec command-center tsx /app/server/src/scripts/provision-project.ts \
 *     example example-website your-org/example-website [--branch main] [--path /abs/path] [--user <id>]
 *
 * Clone credential: the SAME server-side resolver ensureWorktree's fetch uses
 * (`resolveGitFetchToken`): the `--user`'s linked GitHub connection when the
 * connector guard allows server use → the workspace's GitHub integration token →
 * the process env. The token reaches only the git child's env via the static
 * credential-helper script. Nothing is minted, copied, or written to disk, and no
 * `gh auth login` is needed. Only the credential SOURCE kind is printed.
 *
 * An existing checkout is never pulled, reset, stashed, switched or chowned;
 * a dirty / wrong-origin / wrong-branch / foreign one is refused. Prints JSON.
 */
import { initDb, getDb } from '../db/index.js'
import { createWorkspaceRepo } from '../services/workspace-repos.js'
import { ensureRepoCredentialHelper, resolveGitFetchToken } from '../services/repo-git-auth.js'
import {
  inspectProject,
  provisionProject,
  validateProvisionOpts,
  ProvisionError,
  type CloneCredential,
  type ProvisionDeps,
  type ProvisionOpts,
} from '../services/project-provision.js'

const argv = process.argv.slice(2)
const VALUE_FLAGS = ['--branch', '--path', '--user']
const check = argv.includes('--check')
const flag = (n: string): string | undefined => {
  const i = argv.indexOf(n)
  return i >= 0 ? argv[i + 1] : undefined
}
const positional = argv.filter((a, i) => !a.startsWith('--') && !VALUE_FLAGS.includes(argv[i - 1]))
const [workspace, name, github] = positional
if (!workspace || !name || !github) {
  console.error('usage: provision-project [--check] <workspace> <name> <owner/repo> [--branch main] [--path /abs] [--user <id>]')
  process.exit(2)
}
const userArg = flag('--user')
const userId = userArg === undefined ? null : Number(userArg)
if (userId !== null && !(Number.isInteger(userId) && userId > 0)) {
  console.error(`invalid --user "${userArg}" (expected a Command Center user id)`)
  process.exit(2)
}
const opts: ProvisionOpts = { workspace, name, github, branch: flag('--branch'), repoPath: flag('--path') }
const invalid = validateProvisionOpts(opts)
if (invalid) {
  console.error(invalid)
  process.exit(2)
}

/** Stored connection first (user → workspace integration), then the process env. Value never printed. */
function credential(): CloneCredential {
  const subject = { workspace, created_by: userId, assigned_user_id: userId }
  const stored = resolveGitFetchToken(subject, {})
  if (stored) return { token: stored, source: 'stored-connection' }
  const env = resolveGitFetchToken({ workspace: '' }, process.env)
  return env ? { token: env, source: 'server-env' } : { token: null, source: 'none' }
}

initDb()
const deps: ProvisionDeps = {
  findRepoRow: (ws, n) =>
    getDb().prepare('SELECT id, repo_path FROM workspace_repos WHERE workspace = ? AND name = ? ORDER BY id LIMIT 1')
      .get(ws, n) as { id: number; repo_path: string | null } | undefined,
  insertRepoRow: r => { createWorkspaceRepo(r) },
  credentialHelper: (p, run) => { ensureRepoCredentialHelper(p, run) },
  credential,
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
  const code = err instanceof ProvisionError ? err.code : 'error'
  console.error(JSON.stringify({ mode: check ? 'check' : 'provision', ok: false, error: code, message: (err as Error).message }, null, 2))
  process.exit(1)
}
