/**
 * Branch + scope derivation and bleed-detection — the single source of truth for
 * "which branch does this objective own" and "is this session drifting outside
 * its declared scope" (obj 994 guardrails).
 *
 * Pure functions only (no DB, no fs) so they are exhaustively unit-testable and
 * safe to import from both prompt-builder (spawn-time) and the runtime detector
 * (state-poller). The branch derivation MUST stay byte-identical to the worktree
 * branch the spawn prompt tells the session to create, or the lease and the
 * session will disagree.
 */
import type { Objective } from '@operationkit/shared'

/** Slugify a title the same way the git-workflow prompt block does. */
export function slugifyTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 40)
    .replace(/-$/, '')
}

/**
 * The branch an objective owns, or null when the objective does not build a
 * branch (non-PR objectives / tasks edit the main checkout directly by design
 * and therefore take no branch lease — preserving existing behavior exactly).
 *
 * Prefer a persisted `branch_name` (set by the pr-created webhook once the PR
 * exists) so a respawn after the PR is opened agrees with the live branch;
 * fall back to the deterministic derivation used at first spawn.
 */
export function deriveBranchName(objective: Pick<Objective, 'id' | 'title' | 'project' | 'create_pr' | 'branch_name'>): string | null {
  if (objective.branch_name && objective.branch_name.trim()) return objective.branch_name.trim()
  if (!objective.create_pr || !objective.project) return null
  return `cc/obj-${objective.id}-${slugifyTitle(objective.title)}`
}

/**
 * The branch an objective's *worktree* lives on (obj 1059). Unlike
 * {@link deriveBranchName} — which is PR-gated and feeds the obj-994 branch
 * lease — this is derived for EVERY project-scoped session, including non-PR
 * task workers, because ALL project-editing sessions are now isolated into a
 * per-objective worktree (never the live checkout). `create_pr` no longer
 * governs *whether* files are isolated, only how the branch integrates (PR vs
 * merge-back). Returns null only when there is no project to scope to.
 *
 * Intentionally separate from deriveBranchName so the lease's spawn semantics
 * stay byte-identical for non-PR sessions (they take no lease).
 */
export function deriveWorktreeBranchName(objective: Pick<Objective, 'id' | 'title' | 'project' | 'create_pr' | 'branch_name'>): string | null {
  if (objective.branch_name && objective.branch_name.trim()) return objective.branch_name.trim()
  if (!objective.project) return null
  return `cc/obj-${objective.id}-${slugifyTitle(objective.title)}`
}

const BRANCH_CHARS = '[A-Za-z0-9._\\/-]+'

/**
 * The objective id embedded in a branch name (`cc/obj-<id>-…`, `cto/<id>-…`,
 * `fix/<id>-…`, `ci/<id>-…`), or null when the branch carries no id. Used to
 * recognise a session's OWN second branch (same id, different slug) so it is
 * not misclassified as a foreign-objective scope-split.
 */
function objectiveIdOf(branch: string): string | null {
  const m = branch.match(/(?:^|[/-])(\d{6,})(?:[/-]|$)/)
  return m ? m[1] : null
}

/** Integration bases — referencing these is never foreign-objective scope-bleed. */
const INTEGRATION_BASES = new Set(['main', 'master', 'redesign'])

/**
 * Inspect a Bash command string for git operations that create or push a branch
 * OTHER than the one this objective owns — the signature of branch scope-bleed
 * (e.g. obj 841's session pushing `obj-loops-kanban`). Returns the offending
 * branch name, or null when nothing in the command leaves the owned branch.
 *
 * Conservative by design: only flags explicit branch-creating / branch-pushing
 * forms so ordinary `git add` / `git commit` / `git push` (current branch) on the
 * owned branch never trip it.
 */
export function detectBranchBleed(command: string, ownedBranch: string): string | null {
  if (!command) return null
  const owned = ownedBranch.trim()
  const candidates: string[] = []

  // git checkout -b / -B NAME   |   git switch -c / -C NAME
  const createRe = new RegExp(`git\\s+(?:checkout|switch)\\s+(?:-[A-Za-z]+\\s+)*-(?:b|B|c|C)\\s+(${BRANCH_CHARS})`, 'g')
  // gh pr create --head NAME  (PR off an explicit head branch)
  const ghHeadRe = new RegExp(`gh\\s+pr\\s+create\\b[^\\n]*?--head[ =](${BRANCH_CHARS})`, 'g')
  // git push <remote> NAME  /  git push -u <remote> NAME  (explicit branch refspec)
  // The remote token must NOT start with '-'. Because BRANCH_CHARS contains '-', an
  // unanchored remote slot swallows a flag (`-q`, `--force-with-lease`) and the capture
  // then grabs the `2` from a `2>&1` redirect — flagging a bogus "foreign branch '2'" on
  // a refspec-less push of the session's OWN branch (obj 704417/704512/704556). The
  // trailing (?!>) rejects a captured redirect target too (`git push origin 2>&1`).
  const REMOTE_CHARS = '[A-Za-z0-9._/][A-Za-z0-9._\\/-]*'
  const pushRe = new RegExp(`git\\s+push\\s+(?:-[A-Za-z-]+\\s+)*${REMOTE_CHARS}\\s+(${BRANCH_CHARS})(?![>])`, 'g')

  for (const re of [createRe, ghHeadRe, pushRe]) {
    let m: RegExpExecArray | null
    while ((m = re.exec(command)) !== null) {
      const raw = m[1]
      // Strip a leading remote:  origin/feature → feature ; HEAD:refs/heads/x → x
      const name = raw.replace(/^[^:]+:/, '').replace(/^refs\/heads\//, '')
      candidates.push(name)
    }
  }

  const ownedId = objectiveIdOf(owned)
  for (const name of candidates) {
    if (!name) continue
    if (name === 'HEAD' || name === '@') continue
    // A captured token starting with '-' is a git FLAG (`--delete`, `--force`,
    // `-d`), never a branch. BRANCH_CHARS contains '-', so the push regex's
    // name slot swallows the flag on `git push origin --delete <branch>` and
    // reports a "foreign branch" literally named `--delete` (obj 705532).
    if (name.startsWith('-')) continue
    if (name === owned) continue
    // Integration base ref (main / origin/main / redesign): a base-ref op
    // (db-apply push off origin/main, `-B main origin/main` reset) is not a
    // foreign-objective takeover. Direct-to-main is a separate guard's job.
    const bare = name.replace(/^[^/]+\//, '') // origin/main -> main
    if (INTEGRATION_BASES.has(name) || INTEGRATION_BASES.has(bare)) continue
    // A branch embedding the SAME objective id as the owned branch is this
    // objective's own second branch (hotfix / delta / convergence lane), not a
    // scope-split. A DIFFERENT embedded id (or none) still gets flagged.
    const candId = objectiveIdOf(name)
    if (ownedId && candId && candId === ownedId) continue
    return name
  }
  return null
}

/**
 * True when an edited absolute path lands inside SOME project under `projectsRoot`
 * that is NOT the objective's owned project dir and NOT its worktree — i.e. the
 * session is editing a different project entirely (project scope-bleed). Edits
 * inside the owned project but outside the worktree are a separate worktree
 * violation, handled elsewhere, so they are intentionally NOT flagged here.
 */
export function detectProjectBleed(
  absPath: string,
  ownedProjectDir: string,
  worktreePath: string,
  projectsRoot: string,
): boolean {
  if (!absPath || !absPath.startsWith('/')) return false
  const under = (p: string, dir: string) => dir !== '' && (p === dir || p.startsWith(dir.replace(/\/+$/, '') + '/'))
  if (!under(absPath, projectsRoot)) return false // outside the projects tree → not our concern
  if (under(absPath, ownedProjectDir)) return false // inside the owned project (worktree violation path handles sub-cases)
  if (worktreePath && under(absPath, worktreePath)) return false
  return true
}
