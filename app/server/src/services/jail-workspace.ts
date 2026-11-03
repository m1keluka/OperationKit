/**
 * jail-workspace — choose what gets bind-mounted at `/workspace` inside a
 * session jail, and never let that be the bare operator home. (obj 900038)
 *
 * ## The bug this exists to kill
 *
 * A card with NO project resolves its workdir through `resolveAgentWorkdir`,
 * which maps an unknown slug — `general` is the common one — to `HOME_DIR`.
 * With `SESSION_ISOLATION=docker` that path was handed straight to
 * `createSessionJailSync` as the `/workspace` bind source, so the jail mounted
 * the operator's bare home. On the Example OVH install that is
 * `/opt/operationkit/state/home`, mode **0750 root:root** — the jail runs as
 * uid 1000, so it cannot even `x` into the directory.
 *
 * The wrapper script's first real statement is `cd /workspace || exit 1`, which
 * ran BEFORE its first `echo … >> log`. So the session died at exit 1 with an
 * empty transcript and an empty log: the card showed started → 0 tools, 0
 * tokens, dead in ~5s → review. Seen on #900029-#900032, #900035 and #900036.
 *
 * ## The rule
 *
 * A jail's `/workspace` is one of:
 *   1. the session's own git worktree (every project-scoped card), else
 *   2. its resolved agent workdir — but ONLY when that is neither a forbidden
 *      bare root nor a directory the jail uid cannot enter, else
 *   3. a **per-card scratch directory**, created 0700 and owned by the jail uid.
 *
 * `HOME_DIR` (and `/`, `/home`, `/root`, `/tmp`) are permanently in class (3).
 * This is deliberately NOT fixed by `chmod 755` on the operator home: making it
 * world-traversable so a sandbox can enter trades a crash for a disclosure, and
 * the jail's whole premise (PRD §6.2) is that it sees its own worktree and its
 * own HOME and nothing else.
 *
 * `PROJECTS_DIR` / `AI_WORKSPACE_DIR` are deliberately left alone: `cto` and
 * similar personas bind them today and work, and narrowing that is a separate,
 * behaviour-changing decision. The traversability check still covers them — a
 * root the jail uid cannot enter falls back to scratch instead of dying.
 */
import fs from 'node:fs'
import path from 'node:path'
import { HOME_DIR } from '../config.js'

/** Host root holding one scratch `/workspace` per card. Sibling of JAIL_HOME_ROOT. */
export const JAIL_SCRATCH_ROOT = process.env.CC_JAIL_SCRATCH_ROOT || '/tmp/cc-jail-scratch'

/** uid:gid the jail runs as — must match session-jail's `--user` (default 1000:1000). */
export const JAIL_UID = Number(process.env.SESSION_JAIL_UID || 1000)
export const JAIL_GID = Number(process.env.SESSION_JAIL_GID || 1000)

/** Resolve + strip trailing slashes so two spellings of a path compare equal. */
function norm(p: string): string {
  return path.resolve(p).replace(/\/+$/, '') || '/'
}

/**
 * Roots that must never be a `/workspace` bind source. Read from config at call
 * time so a test can move `USER_HOME` via env without a module reload.
 */
export function bareRoots(): string[] {
  return [HOME_DIR, '/', '/home', '/root', '/tmp', '/opt', '/srv']
    .filter(Boolean)
    .map(norm)
}

/** True when `dir` is one of the shared roots we refuse to bind. */
export function isBareRoot(dir: string): boolean {
  if (!dir || !dir.trim()) return true
  return bareRoots().includes(norm(dir))
}

export type StatLike = { mode: number; uid: number; gid: number }

/**
 * Can uid:gid actually `cd` into `dir`? Needs `x` on the directory via owner,
 * group or other. A directory we cannot stat is NOT traversable — fail closed
 * into scratch rather than binding something the jail chokes on.
 *
 * Only the leaf is checked. Every real bind source here is either created by us
 * or a worktree whose parents are traversable, so walking the chain would cost
 * a stat per component for a case that does not occur.
 */
export function traversableBy(
  dir: string,
  uid: number = JAIL_UID,
  gid: number = JAIL_GID,
  statSync: (p: string) => StatLike | null = (p) => {
    try { return fs.statSync(p) } catch { return null }
  },
): boolean {
  const st = statSync(dir)
  if (!st) return false
  const mode = st.mode & 0o777
  if (mode & 0o001) return true                       // other-execute
  if (st.uid === uid && (mode & 0o100)) return true   // owner-execute
  if (st.gid === gid && (mode & 0o010)) return true   // group-execute
  return false
}

export type JailWorkspaceReason =
  | 'worktree'
  | 'workdir'
  | 'scratch:no-workdir'
  | 'scratch:bare-root'
  | 'scratch:not-traversable'

export interface JailWorkspaceChoice {
  /** Host path to bind at /workspace. */
  source: string
  /** Why we chose it — logged, and asserted in the unit tests. */
  reason: JailWorkspaceReason
  /** True when `source` is a per-card scratch dir this module owns. */
  scratch: boolean
}

export interface ResolveJailWorkspaceOpts {
  objectiveId: string | number
  /** The session's git worktree, when it has one (every project-scoped card). */
  worktreeRoot?: string
  /** The agent/project workdir `resolveWorkdir` produced. */
  workdir?: string
  scratchRoot?: string
  /** Injected for tests. */
  isTraversable?: (dir: string) => boolean
}

/**
 * Decide the `/workspace` bind source. PURE — creates no directories; the
 * caller runs {@link ensureJailScratchDir} when `scratch` is true.
 */
export function resolveJailWorkspace(opts: ResolveJailWorkspaceOpts): JailWorkspaceChoice {
  const { objectiveId, worktreeRoot, workdir } = opts
  const scratchRoot = opts.scratchRoot ?? JAIL_SCRATCH_ROOT
  const isTraversable = opts.isTraversable ?? ((d: string) => traversableBy(d))
  const scratch = jailScratchPath(objectiveId, scratchRoot)

  // A real worktree always wins: per-session, writable, and the thing the card
  // is actually meant to edit.
  if (worktreeRoot && worktreeRoot.trim()) {
    return { source: norm(worktreeRoot), reason: 'worktree', scratch: false }
  }
  if (!workdir || !workdir.trim()) {
    return { source: scratch, reason: 'scratch:no-workdir', scratch: true }
  }
  if (isBareRoot(workdir)) {
    return { source: scratch, reason: 'scratch:bare-root', scratch: true }
  }
  if (!isTraversable(norm(workdir))) {
    return { source: scratch, reason: 'scratch:not-traversable', scratch: true }
  }
  return { source: norm(workdir), reason: 'workdir', scratch: false }
}

/** Per-card scratch path. The id is validated — it becomes a directory name. */
export function jailScratchPath(
  objectiveId: string | number,
  scratchRoot: string = JAIL_SCRATCH_ROOT,
): string {
  const id = String(objectiveId)
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(id)) {
    throw new Error(`jail-workspace: invalid objective id for a scratch dir: ${JSON.stringify(id)}`)
  }
  return path.join(scratchRoot, id)
}

/**
 * Create the per-card scratch dir 0700 owned by the jail uid, and return it.
 * Idempotent — a resumed card reuses the directory it already has.
 */
export function ensureJailScratchDir(
  objectiveId: string | number,
  scratchRoot: string = JAIL_SCRATCH_ROOT,
): string {
  const dir = jailScratchPath(objectiveId, scratchRoot)
  fs.mkdirSync(path.dirname(dir), { recursive: true, mode: 0o711 })
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  applyJailOwnership(dir, 'dir')
  return dir
}

/**
 * What a path is FOR, which decides how we degrade when we cannot chown.
 *
 *   'dir'            a directory the jail creates files in     -> 0700, fallback -wx + sticky
 *   'jail-read'      a file the jail reads (wrapper, prompt)   -> 0600, fallback +r for other
 *   'jail-write'     a file the jail appends to (transcripts)  -> 0600, fallback +rw for other
 */
export type JailPathKind = 'dir' | 'jail-read' | 'jail-write'

/** Mode used when the control plane IS root and can chown. The real target. */
export const JAIL_OWNED_MODE: Record<JailPathKind, number> = {
  'dir': 0o700,
  'jail-read': 0o600,
  'jail-write': 0o600,
}

/**
 * Mode used when the control plane is NOT root. It cannot hand the path to the
 * jail uid, so the jail can only reach it through the "other" bits.
 *
 * Directories degrade to `-wx` plus the sticky bit: enterable and writable by
 * the jail, but NOT listable by anything else, and a non-owner cannot unlink
 * another session's files. That is strictly tighter than the 0777 this replaced.
 *
 * Files are the honest bad case: a file the jail must read has to be readable
 * by "other", so a non-root control plane cannot fully close the wrapper-script
 * exposure. It is mitigated instead — the containing directory is not listable,
 * the env file is deleted the moment `docker run` returns, and the wrapper is
 * scrubbed on session end. {@link warnDegraded} says so once, loudly.
 */
export const JAIL_DEGRADED_MODE: Record<JailPathKind, number> = {
  'dir': 0o1733,
  'jail-read': 0o604,
  'jail-write': 0o606,
}

export interface JailOwnershipOps {
  chownSync: (p: string, uid: number, gid: number) => void
  chmodSync: (p: string, mode: number) => void
  isRoot: () => boolean
}

const realOps: JailOwnershipOps = {
  chownSync: fs.chownSync,
  chmodSync: fs.chmodSync,
  isRoot: () => typeof process.getuid === 'function' && process.getuid() === 0,
}

let warnedDegraded = false

/** Say "we could not chown" ONCE per process, not once per file. */
function warnDegraded(): void {
  if (warnedDegraded) return
  warnedDegraded = true
  console.warn(
    `[jail-workspace] control plane is not root: jail paths cannot be chowned to ` +
    `${JAIL_UID}:${JAIL_GID}, so they degrade to the tightest "other" bits that still ` +
    `let the jail work (dirs -wx+sticky, files +r). Run the control plane as root for ` +
    `full 0700 isolation of per-session credential files.`,
  )
}

/** Test-only: re-arm the once-per-process degraded warning. */
export function __resetJailOwnershipWarningForTests(): void {
  warnedDegraded = false
}

/**
 * Hand `target` to the jail uid at the right mode for its `kind`.
 * Returns true when the chown landed (i.e. full isolation was achieved).
 *
 * 0700/0600 + chown — not 0777/0666 — is the whole point of obj 900038: these
 * paths live on the shared host /tmp alongside every other session's, and they
 * hold the session's `--env-file` and wrapper script, both of which are
 * plaintext credentials. `/tmp/cc-jail-homes/<sid>` used to be `drwxrwxrwx`.
 */
export function applyJailOwnership(
  target: string,
  kind: JailPathKind = 'dir',
  ops: JailOwnershipOps = realOps,
): boolean {
  if (ops.isRoot()) {
    try {
      ops.chownSync(target, JAIL_UID, JAIL_GID)
      ops.chmodSync(target, JAIL_OWNED_MODE[kind])
      return true
    } catch (err) {
      console.warn(`[jail-workspace] chown ${target} -> ${JAIL_UID}:${JAIL_GID} failed:`, (err as Error).message)
    }
  }
  try {
    ops.chmodSync(target, JAIL_DEGRADED_MODE[kind])
  } catch (err) {
    console.warn(`[jail-workspace] chmod ${target} failed:`, (err as Error).message)
  }
  warnDegraded()
  return false
}
