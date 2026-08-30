/**
 * Git worktree isolation — extracted from session-manager.ts (behavior frozen).
 * HARD RULE: project-scoped sessions edit /tmp/cc-worktree-{id}/, never the live checkout.
 */
import { execSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import type { Objective } from '@operationkit/shared'
import { getDb } from '../db/index.js'
import { resolveWorkdir } from './prompt-builder.js'
import { deriveBranchName } from './branch-scope.js'
import { TMUX_SCRIPT_DIR } from './session-tmux.js'

export type WorktreeIsolation = { projectDir: string; worktreePath: string; sessionId: string }

/**
 * Compute worktree isolation guard for a session, or undefined if this session
 * isn't isolated. As of obj 1059, isolation applies to EVERY project-scoped
 * session — PR objectives, bugs, AND task workers. `create_pr` no longer gates
 * isolation (it only governs how the branch integrates back: own PR vs merge
 * into a parent's PR). A session with no linked project edits its agent/home
 * workdir and is not isolated.
 */
export function computeIsolation(objective: Objective, sessionId: string): WorktreeIsolation | undefined {
  if (!objective.project) return undefined
  const projectDir = resolveWorkdir(objective)
  if (!projectDir || !projectDir.startsWith('/')) return undefined
  // Only isolate when the resolved workdir is an actual project checkout under
  // the protected projects root — never when resolveWorkdir fell back to HOME or
  // an agent dir (those carry no live-checkout hazard and must stay editable).
  if (!projectDir.startsWith(PROTECTED_PROJECTS_ROOT + '/') && projectDir !== PROTECTED_PROJECTS_ROOT) {
    return undefined
  }
  return {
    projectDir: projectDir.replace(/\/+$/, ''),
    worktreePath: `/tmp/cc-worktree-${objective.id}`,
    sessionId,
  }
}

// The bind-mounted root that hosts every live project checkout. Editing anything
// under here that is NOT the session's own worktree is the obj-841 hazard.
const PROTECTED_PROJECTS_ROOT = '/home/operator/projects'

/**
 * Resolve the base ref a session's worktree should branch from. Children of a
 * PR-building parent branch off the PARENT's branch so their work converges into
 * the parent's single PR (Decision #4, obj 1059); everything else branches off
 * the latest origin/main. Falls back to HEAD when origin/main is unavailable.
 */
export function resolveWorktreeBase(objective: Objective, projectDir: string): string {
  try {
    if (objective.parent_id != null) {
      const parent = getDb()
        .prepare('SELECT id, title, project, create_pr, branch_name, parent_id FROM objectives WHERE id = ?')
        .get(objective.parent_id) as Objective | undefined
      if (parent && parent.create_pr && parent.project) {
        const parentBranch = deriveBranchName(parent)
        if (parentBranch) {
          // Use the parent branch only if it actually exists (parent spawned first).
          try {
            execSync(`git -C ${JSON.stringify(projectDir)} rev-parse --verify --quiet ${JSON.stringify(parentBranch)}`, { timeout: 5000, stdio: 'pipe' })
            return parentBranch
          } catch {
            // Parent branch not created yet — fall through to origin/main.
          }
        }
      }
    }
  } catch {}
  try {
    execSync(`git -C ${JSON.stringify(projectDir)} rev-parse --verify --quiet origin/main`, { timeout: 5000, stdio: 'pipe' })
    return 'origin/main'
  } catch {
    return 'HEAD'
  }
}

/**
 * Create (idempotently) the per-session git worktree for an isolated session.
 * The worktree is created server-side BEFORE spawn so the session's shell starts
 * INSIDE it — the live checkout is never the cwd. Returns the worktree path, or
 * null if creation failed (caller falls back to a non-isolated spawn rather than
 * blocking work entirely).
 *
 * Idempotent: reuse on resume (worktree dir already present), reuse a branch that
 * already exists (PR reopened), and self-heal a stale registration.
 */
/**
 * Whether `gitDir` is a per-worktree PRIVATE administrative gitdir (safe to
 * chown to the session user) rather than the repo's SHARED common .git dir.
 * `git worktree add` puts each worktree's index/HEAD/logs under
 * `<repo>/.git/worktrees/<name>/`; that path is private to one worktree and must
 * be writable by the ccuser session so it can commit. The shared `<repo>/.git`
 * (no `/worktrees/` segment) must NEVER be chowned — that would hand the whole
 * repository to ccuser. Pure + exported for unit testing the safety invariant.
 */
export function isPrivateWorktreeGitDir(gitDir: string | null | undefined): boolean {
  return !!gitDir && gitDir.includes('/worktrees/')
}

/**
 * Whether `dir` is the working tree of a git repository. obj 1451: ensureWorktree
 * must refuse to run `git worktree` against a non-repo (e.g. the bare projects
 * root). Cheap `.git` check first (covers both a `.git` dir and a worktree's
 * `.git` pointer file); falls back to `rev-parse` for unusual layouts.
 */
export function isGitRepo(dir: string): boolean {
  try {
    if (fs.existsSync(path.join(dir, '.git'))) return true
    return (
      execSync(`git -C ${JSON.stringify(dir)} rev-parse --is-inside-work-tree`, {
        timeout: 5000,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
        .toString()
        .trim() === 'true'
    )
  } catch {
    return false
  }
}

export function ensureWorktree(objective: Objective, branchName: string): string | null {
  // Guarantees git safe.directory is configured (root operating on admin-owned
  // repos) before any `git -C` below — independent of spawn-path call ordering.
  // ensureUser is guarded (userSetup), so this is a no-op after first run.
  try { execSync(`git config --global --add safe.directory '*'`, { timeout: 5000 }) } catch {}
  const projectDir = resolveWorkdir(objective).replace(/\/+$/, '')
  const worktreePath = `/tmp/cc-worktree-${objective.id}`
  try {
    // Already a live worktree (resume / re-spawn) — reuse as-is.
    if (fs.existsSync(path.join(worktreePath, '.git'))) {
      return worktreePath
    }
    // obj 1451 — refuse to operate on a non-repo. resolveWorkdir already fails
    // closed for a project-linked objective that maps to nothing, but if it ever
    // resolves to a directory that is not a git repository, running `git worktree`
    // here would fail and the caller would otherwise fall open into the live tree.
    // Bail with null → the caller fails closed (aborts the spawn).
    if (!isGitRepo(projectDir)) {
      console.error(
        `[session-manager] ensureWorktree: resolved workdir "${projectDir}" for objective ${objective.id} is not a git repository — refusing to create a worktree (fail-closed; no unguarded spawn).`,
      )
      return null
    }
    // Stale directory with no .git — clear it so `worktree add` can recreate.
    if (fs.existsSync(worktreePath)) {
      execSync(`rm -rf ${JSON.stringify(worktreePath)}`, { timeout: 5000 })
    }
    // Best-effort refresh only. The base ref (origin/main, or the parent branch)
    // already exists locally — deploys pull main into the checkout — and the
    // server (root) has no GitHub SSH auth, so `fetch origin` fails here. A fetch
    // failure must NOT abort isolation: that would fail open into the live
    // checkout. Refresh when we can; otherwise proceed on local refs.
    try {
      execSync(`git -C ${JSON.stringify(projectDir)} fetch origin --quiet`, { timeout: 30000, stdio: 'pipe' })
    } catch (e) {
      console.warn(`[session-manager] ensureWorktree: best-effort fetch failed for ${projectDir} (continuing on local refs): ${e instanceof Error ? e.message : e}`)
    }
    execSync(`git -C ${JSON.stringify(projectDir)} worktree prune`, { timeout: 10000, stdio: 'pipe' })
    const base = resolveWorktreeBase(objective, projectDir)
    // Does the branch already exist (PR reopened / prior spawn)? If so attach to
    // it; otherwise create it off the resolved base.
    let branchExists = false
    try {
      execSync(`git -C ${JSON.stringify(projectDir)} rev-parse --verify --quiet ${JSON.stringify(branchName)}`, { timeout: 5000, stdio: 'pipe' })
      branchExists = true
    } catch {}
    if (branchExists) {
      execSync(`git -C ${JSON.stringify(projectDir)} worktree add ${JSON.stringify(worktreePath)} ${JSON.stringify(branchName)}`, { timeout: 20000, stdio: 'pipe' })
    } else {
      execSync(`git -C ${JSON.stringify(projectDir)} worktree add -b ${JSON.stringify(branchName)} ${JSON.stringify(worktreePath)} ${JSON.stringify(base)}`, { timeout: 20000, stdio: 'pipe' })
    }
    // Hand the new worktree to ccuser so the session (which runs as ccuser via
    // `runuser -u ccuser`) can actually commit. `git worktree add` runs HERE as
    // root and creates root-owned files in THREE places the session must write,
    // all of which the original single chown missed — leaving the session with
    // `Permission denied` and a silent no-op (zero commits, no PR) that short-
    // circuits the harness loop (obj 1234):
    //   1. the working tree at worktreePath (staging),
    //   2. the private admin gitdir <project>/.git/worktrees/<name>/ — index,
    //      HEAD, logs/HEAD; every `git add`/`commit` writes index.lock here,
    //   3. the BRANCH ref + reflog in the SHARED .git: refs/heads/<branch> and
    //      logs/refs/heads/<branch>; committing on the branch appends the reflog
    //      and rewrites the ref (this is the failure obj 1234 hit even after the
    //      admin gitdir was fixed).
    // We deliberately scope (3) to refs/heads + logs/refs/heads only — NOT all of
    // .git — so objects/config stay root-owned; refs are non-sensitive and every
    // other branch's ref is already ccuser-owned, so this just matches steady
    // state. isPrivateWorktreeGitDir guards (2) from ever hitting the shared dir.
    try {
      execSync(`chown -R ccuser:ccuser ${JSON.stringify(worktreePath)} 2>/dev/null || true`, { timeout: 10000 })
      const adminGitDir = execSync(
        `git -C ${JSON.stringify(worktreePath)} rev-parse --absolute-git-dir`,
        { timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] },
      ).toString().trim()
      if (isPrivateWorktreeGitDir(adminGitDir)) {
        execSync(`chown -R ccuser:ccuser ${JSON.stringify(adminGitDir)} 2>/dev/null || true`, { timeout: 10000 })
      }
      // Shared common .git dir (its refs/heads + reflogs hold the branch the
      // session commits on). --git-common-dir resolves to the real <project>/.git
      // even from inside the worktree, whose own .git is just a pointer file.
      const commonDir = execSync(
        `git -C ${JSON.stringify(worktreePath)} rev-parse --git-common-dir`,
        { timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] },
      ).toString().trim()
      const commonAbs = commonDir && !commonDir.startsWith('/') ? path.resolve(projectDir, commonDir) : commonDir
      if (commonAbs && fs.existsSync(commonAbs)) {
        for (const sub of ['refs/heads', 'logs/refs/heads']) {
          const target = path.join(commonAbs, sub)
          if (fs.existsSync(target)) {
            execSync(`chown -R ccuser:ccuser ${JSON.stringify(target)} 2>/dev/null || true`, { timeout: 10000 })
          }
        }
      }
    } catch (e) {
      console.warn(`[session-manager] ensureWorktree: chown step failed for objective ${objective.id} (session may be unable to commit): ${e instanceof Error ? e.message : e}`)
    }
    console.log(`[session-manager] Worktree ready for objective ${objective.id}: ${worktreePath} (branch ${branchName}, base ${base})`)
    return worktreePath
  } catch (err) {
    console.error(`[session-manager] ensureWorktree FAILED for objective ${objective.id}: ${err instanceof Error ? err.message : err}`)
    return null
  }
}

// ── PreToolUse worktree guard (obj 1059) ──
// The REAL pre-write block. Server-side stream scanning is post-hoc (it sees the
// edit after it lands); a Claude-CLI PreToolUse hook denies the Edit/Write BEFORE
// the bytes hit disk — verified to fire even under --dangerously-skip-permissions.
// One shared guard script + settings file; the per-session worktree root is passed
// via the CC_WORKTREE_ROOT env var in the wrapper.
const WORKTREE_GUARD_PATH = path.join(TMUX_SCRIPT_DIR, 'worktree-guard.sh')
const WORKTREE_HOOK_SETTINGS_PATH = path.join(TMUX_SCRIPT_DIR, 'worktree-hook-settings.json')

export const WORKTREE_GUARD_SCRIPT = `#!/bin/bash
# obj 1059 — PreToolUse guard. Denies Edit/Write/MultiEdit/NotebookEdit to any
# live project checkout (CC_PROTECTED_ROOT, default /home/operator/projects) that is
# NOT inside this session's worktree (CC_WORKTREE_ROOT). Vault, NOTES, home and
# /tmp are untouched. Reads the tool call JSON on stdin; exit 2 => block (stderr
# is fed back to the model as the denial reason).
WT="\${CC_WORKTREE_ROOT:-}"
PROT="\${CC_PROTECTED_ROOT:-/home/operator/projects}"
[ -z "$WT" ] && exit 0   # not an isolated session — nothing to guard
input=$(cat)
fp=$(printf '%s' "$input" | python3 -c '
import sys, json, os
try:
    d = json.load(sys.stdin)
except Exception:
    print(""); sys.exit(0)
ti = d.get("tool_input") or {}
p = ti.get("file_path") or ti.get("notebook_path") or ""
cwd = d.get("cwd") or os.getcwd()
if p and not os.path.isabs(p):
    p = os.path.join(cwd, p)
print(os.path.abspath(p) if p else "")
' 2>/dev/null)
[ -z "$fp" ] && exit 0
wt="\${WT%/}"; prot="\${PROT%/}"
case "$fp" in
  "$wt"|"$wt"/*) exit 0 ;;
  "$prot"|"$prot"/*)
    echo "[worktree-guard] BLOCKED: $fp is in the live checkout ($prot), outside your worktree ($wt). Edit the copy under $wt instead — live-checkout edits bypass review and crash prod when the worktree is cleaned up." >&2
    exit 2 ;;
  *) exit 0 ;;
esac
`

const WORKTREE_HOOK_SETTINGS = JSON.stringify({
  hooks: {
    PreToolUse: [
      {
        matcher: 'Edit|Write|MultiEdit|NotebookEdit',
        hooks: [{ type: 'command', command: WORKTREE_GUARD_PATH }],
      },
    ],
  },
}, null, 2)

/** Write the shared guard + settings assets (idempotent). Returns the settings path. */
export function ensureWorktreeHookAssets(): string {
  fs.mkdirSync(TMUX_SCRIPT_DIR, { recursive: true })
  fs.writeFileSync(WORKTREE_GUARD_PATH, WORKTREE_GUARD_SCRIPT)
  fs.chmodSync(WORKTREE_GUARD_PATH, 0o755)
  fs.writeFileSync(WORKTREE_HOOK_SETTINGS_PATH, WORKTREE_HOOK_SETTINGS)
  fs.chmodSync(WORKTREE_HOOK_SETTINGS_PATH, 0o644)
  return WORKTREE_HOOK_SETTINGS_PATH
}

const WORKTREE_EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

/** Inspect a stream-json line for edits that violate worktree isolation. */
export function checkWorktreeViolation(line: string, jsonlPath: string, logPath: string, isolation: WorktreeIsolation, timestamp: string) {
  let event: { type?: string; message?: { content?: Array<{ type?: string; name?: string; input?: Record<string, unknown> }> } }
  try {
    event = JSON.parse(line)
  } catch {
    return
  }
  if (event.type !== 'assistant' || !Array.isArray(event.message?.content)) return

  for (const block of event.message!.content!) {
    if (block.type !== 'tool_use' || !block.name || !WORKTREE_EDIT_TOOLS.has(block.name)) continue
    const input = block.input || {}
    const rawPath = String(input.file_path || input.notebook_path || '')
    if (!rawPath) continue
    const absolute = path.isAbsolute(rawPath) ? rawPath : path.resolve(isolation.projectDir, rawPath)
    const insideProject = absolute === isolation.projectDir || absolute.startsWith(isolation.projectDir + '/')
    const insideWorktree = absolute === isolation.worktreePath || absolute.startsWith(isolation.worktreePath + '/')
    if (!insideProject || insideWorktree) continue

    const summary = `[worktree-violation] session=${isolation.sessionId} tool=${block.name} path=${absolute} (worktree=${isolation.worktreePath})`
    console.warn(summary)
    fs.appendFileSync(logPath, `[WARNING] ${summary}\n`)
    const warningEvent = JSON.stringify({
      type: 'warning',
      text: `⚠️ Worktree violation: ${block.name} targeted ${absolute}, which is in the deployed checkout. Move this edit to ${isolation.worktreePath} — edits to the main checkout bypass review and crash prod when the worktree is cleaned up.`,
      timestamp,
    })
    fs.appendFileSync(jsonlPath, warningEvent + '\n')
  }
}
