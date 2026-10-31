/**
 * Worktree reaper — remove git worktrees whose card is finished.
 *
 * The DigitalOcean host hit ENOSPC repeatedly because 90-150 worktrees for
 * done/cancelled cards piled up (each a full checkout + node_modules). Only one
 * done path (PATCH /status) ever cleaned up, and it rm -rf'd regardless of
 * uncommitted work. This module is the single place that decides + removes:
 *
 *   - reapObjectiveWorktrees(id)  — hook fired when a card lands in done/cancelled
 *   - sweepFinishedWorktrees()     — periodic sweep (30 min) over every repo
 *                                    directly under PROJECTS_DIR
 *
 * Recognized worktree paths (anything else is never touched):
 *   /tmp/cc-worktree-<id>                 session isolation (obj 1059)
 *   <projects>/.cc-worktree-<id>          ad-hoc
 *   <projects>/<name>-wt-<id>[-suffix]    ad-hoc
 *
 * Safety: reap ONLY when the card status is exactly done/cancelled (re-read from
 * the DB right before removal), never the main worktree, never a locked one,
 * never with uncommitted tracked changes or commits not on any remote, never
 * while a process has its cwd inside it. Removal is `git worktree remove --force`
 * (arg arrays, no shell). Everything is best-effort and never throws to callers.
 *
 * Kill switch: CC_WORKTREE_REAPER=false. Dry run: CC_WORKTREE_REAPER_DRY_RUN=true.
 */
import { execFile } from 'child_process'
import fs from 'fs'
import path from 'path'
import type { Database } from 'better-sqlite3'
import { PROJECTS_DIR } from '../config.js'
import { getDb } from '../db/index.js'

const SWEEP_INTERVAL_MS = 30 * 60 * 1000
const FIRST_SWEEP_DELAY_MS = 2 * 60 * 1000
const KICK_COOLDOWN_MS = 10 * 60 * 1000
const GIT_TIMEOUT_MS = 30 * 1000
const REMOVE_TIMEOUT_MS = 3 * 60 * 1000

/** The only statuses that make a worktree reapable. */
export const REAPABLE_STATUSES: ReadonlySet<string> = new Set(['done', 'cancelled'])

const TMP_WORKTREE_RE = /^\/tmp\/cc-worktree-(\d+)$/

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function stripTrailingSlashes(p: string): string {
  return p.length > 1 ? p.replace(/\/+$/, '') : p
}

function toId(raw: string): number | null {
  const n = Number(raw)
  return Number.isSafeInteger(n) && n > 0 ? n : null
}

// ── Pure helpers ─────────────────────────────────────────────────────────────

/**
 * Objective id encoded in a worktree path, or null for anything we do not own
 * (main checkouts, unknown names, nested paths).
 */
export function objectiveIdFromWorktreePath(p: string, projectsDir: string = PROJECTS_DIR): number | null {
  if (!p) return null
  const clean = stripTrailingSlashes(p)
  const tmp = TMP_WORKTREE_RE.exec(clean)
  if (tmp) return toId(tmp[1])
  const root = escapeRe(stripTrailingSlashes(projectsDir))
  const dot = new RegExp(`^${root}/\\.cc-worktree-(\\d+)$`).exec(clean)
  if (dot) return toId(dot[1])
  const wt = new RegExp(`^${root}/[^/]+?-wt-(\\d+)(?:-[^/]*)?$`).exec(clean)
  if (wt) return toId(wt[1])
  return null
}

export interface WorktreeEntry {
  path: string
  head: string | null
  /** Short branch name (refs/heads/ stripped), null when detached/bare. */
  branch: string | null
  bare: boolean
  detached: boolean
  locked: boolean
  prunable: boolean
  /** First entry of `git worktree list` is always the main worktree. */
  isMain: boolean
}

/** Parse `git worktree list --porcelain`. */
export function parseWorktreePorcelain(out: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = []
  let cur: WorktreeEntry | null = null
  for (const raw of out.split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (line.startsWith('worktree ')) {
      cur = {
        path: line.slice('worktree '.length),
        head: null,
        branch: null,
        bare: false,
        detached: false,
        locked: false,
        prunable: false,
        isMain: entries.length === 0,
      }
      entries.push(cur)
      continue
    }
    if (!cur) continue
    if (line === '') { cur = null; continue }
    if (line.startsWith('HEAD ')) cur.head = line.slice(5)
    else if (line.startsWith('branch ')) cur.branch = line.slice(7).replace(/^refs\/heads\//, '')
    else if (line === 'bare') cur.bare = true
    else if (line === 'detached') cur.detached = true
    else if (line === 'locked' || line.startsWith('locked ')) cur.locked = true
    else if (line === 'prunable' || line.startsWith('prunable ')) cur.prunable = true
  }
  return entries
}

/** Card status by id; null/undefined = card missing. */
export type StatusLookup = (objectiveId: number) => string | null | undefined

export interface ReapCandidate { worktree: WorktreeEntry; objectiveId: number; status: string }
export interface ReapSkip { worktree: WorktreeEntry; objectiveId: number | null; reason: string }

/**
 * Split worktrees into reapable vs kept. Reap ONLY when the card status is
 * exactly done/cancelled; every other case (main, bare, locked, prunable,
 * unparseable path, missing card, any other status) is kept.
 */
export function selectReapable(
  worktrees: WorktreeEntry[],
  lookup: StatusLookup,
  projectsDir: string = PROJECTS_DIR,
): { reap: ReapCandidate[]; skip: ReapSkip[] } {
  const reap: ReapCandidate[] = []
  const skip: ReapSkip[] = []
  for (const wt of worktrees) {
    if (wt.isMain || wt.bare) { skip.push({ worktree: wt, objectiveId: null, reason: 'main worktree' }); continue }
    const objectiveId = objectiveIdFromWorktreePath(wt.path, projectsDir)
    if (objectiveId == null) { skip.push({ worktree: wt, objectiveId: null, reason: 'unrecognized path' }); continue }
    let status: string | null | undefined
    try { status = lookup(objectiveId) } catch { status = undefined }
    if (status == null) { skip.push({ worktree: wt, objectiveId, reason: 'card missing' }); continue }
    if (!REAPABLE_STATUSES.has(status)) { skip.push({ worktree: wt, objectiveId, reason: `status=${status}` }); continue }
    if (wt.locked) { skip.push({ worktree: wt, objectiveId, reason: 'locked' }); continue }
    // Directory already gone — `git worktree prune` handles the admin entry.
    if (wt.prunable) { skip.push({ worktree: wt, objectiveId, reason: 'prunable (dir missing)' }); continue }
    reap.push({ worktree: wt, objectiveId, status })
  }
  return { reap, skip }
}

/** Raw probe output; null means the probe itself failed (treated as unsafe). */
export interface WorktreeGitState {
  /**
   * `git status --porcelain --untracked-files=normal`. Untracked files count as
   * dirty: on a done card they may be work that was never committed. Ignored
   * files (node_modules, build output, the actual disk hogs) are not listed.
   */
  dirtyTracked: string | null
  /** `git rev-list HEAD --not --remotes` */
  unpushed: string | null
}

export type SafetyVerdict = { ok: true } | { ok: false; reason: string }

/** Pure removal gate: refuse on uncommitted (tracked or untracked) changes, unpushed commits, or a failed probe. */
export function safetyVerdict(state: WorktreeGitState): SafetyVerdict {
  if (state.dirtyTracked == null || state.unpushed == null) return { ok: false, reason: 'probe-failed' }
  const dirty = state.dirtyTracked.trim() !== ''
  const unpushed = state.unpushed.trim() !== ''
  if (dirty && unpushed) return { ok: false, reason: 'dirty+unpushed' }
  if (dirty) return { ok: false, reason: 'dirty' }
  if (unpushed) return { ok: false, reason: 'unpushed' }
  return { ok: true }
}

/** True when `p` is `root` or lives under it. */
export function isPathInside(p: string, root: string): boolean {
  const a = stripTrailingSlashes(p)
  const b = stripTrailingSlashes(root)
  return a === b || a.startsWith(b + '/')
}

export function isReaperEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.CC_WORKTREE_REAPER || '').toLowerCase() !== 'false'
}

export function isReaperDryRun(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.CC_WORKTREE_REAPER_DRY_RUN || '').toLowerCase()
  return v === 'true' || v === '1'
}

// ── Imperative layer ─────────────────────────────────────────────────────────

/** Runs git with an arg array (never a shell). Rejects on non-zero exit. */
export type GitRunner = (args: string[], timeoutMs?: number) => Promise<string>

const defaultGit: GitRunner = (args, timeoutMs = GIT_TIMEOUT_MS) =>
  new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      {
        timeout: timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
        encoding: 'utf-8',
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      },
      (err, stdout) => (err ? reject(err) : resolve(String(stdout ?? ''))),
    )
  })

/** cwd of every visible process (container /proc). Best-effort. */
function defaultProcessCwds(): string[] {
  const cwds: string[] = []
  let pids: string[] = []
  try { pids = fs.readdirSync('/proc').filter(n => /^\d+$/.test(n)) } catch { return cwds }
  for (const pid of pids) {
    try { cwds.push(fs.readlinkSync(`/proc/${pid}/cwd`)) } catch {}
  }
  return cwds
}

function dbStatusLookup(db?: Database): StatusLookup {
  return (id) => {
    const row = (db ?? getDb()).prepare('SELECT status FROM objectives WHERE id = ?').get(id) as { status: string } | undefined
    return row?.status ?? null
  }
}

export interface ReaperDeps {
  git?: GitRunner
  readStatus?: StatusLookup
  processCwds?: () => string[]
  projectsDir?: string
  dryRun?: boolean
  log?: (msg: string) => void
}

interface ResolvedDeps {
  git: GitRunner
  readStatus: StatusLookup
  processCwds: () => string[]
  projectsDir: string
  dryRun: boolean
  log: (msg: string) => void
}

function resolveDeps(deps: ReaperDeps = {}, db?: Database): ResolvedDeps {
  return {
    git: deps.git ?? defaultGit,
    readStatus: deps.readStatus ?? dbStatusLookup(db),
    processCwds: deps.processCwds ?? defaultProcessCwds,
    projectsDir: deps.projectsDir ?? PROJECTS_DIR,
    dryRun: deps.dryRun ?? isReaperDryRun(),
    log: deps.log ?? ((m) => console.log(m)),
  }
}

export type ReapOutcome = 'removed' | 'would-remove' | 'kept' | 'failed'
export interface ReapResult { path: string; objectiveId: number; outcome: ReapOutcome; reason?: string }

async function probe(git: GitRunner, args: string[]): Promise<string | null> {
  try { return await git(args) } catch { return null }
}

/** Run the gates on one candidate and remove it if they all pass. Never throws. */
async function reapOne(mainDir: string, c: ReapCandidate, d: ResolvedDeps): Promise<ReapResult> {
  const p = c.worktree.path
  const base = { path: p, objectiveId: c.objectiveId }
  try {
    const verdict = safetyVerdict({
      dirtyTracked: await probe(d.git, ['-C', p, 'status', '--porcelain', '--untracked-files=normal']),
      unpushed: await probe(d.git, ['-C', p, 'rev-list', 'HEAD', '--not', '--remotes']),
    })
    if (!verdict.ok) {
      d.log(`[worktree-reaper] kept: dirty/unpushed #${c.objectiveId} ${p} (${verdict.reason})`)
      return { ...base, outcome: 'kept', reason: verdict.reason }
    }
    if (d.processCwds().some(cwd => isPathInside(cwd, p))) {
      d.log(`[worktree-reaper] kept: in use #${c.objectiveId} ${p} (a process has its cwd inside)`)
      return { ...base, outcome: 'kept', reason: 'in-use' }
    }
    // Race with a reopen: the card may have moved back to working since selection.
    const now = d.readStatus(c.objectiveId)
    if (now == null || !REAPABLE_STATUSES.has(now)) {
      d.log(`[worktree-reaper] kept: #${c.objectiveId} ${p} status changed to ${now ?? 'missing'}`)
      return { ...base, outcome: 'kept', reason: `status=${now ?? 'missing'}` }
    }
    if (d.dryRun) {
      d.log(`[worktree-reaper] DRY RUN would remove #${c.objectiveId} (${now}) ${p}`)
      return { ...base, outcome: 'would-remove' }
    }
    await d.git(['-C', mainDir, 'worktree', 'remove', '--force', p], REMOVE_TIMEOUT_MS)
    d.log(`[worktree-reaper] removed #${c.objectiveId} (${now}) ${p}`)
    return { ...base, outcome: 'removed' }
  } catch (err) {
    d.log(`[worktree-reaper] remove failed #${c.objectiveId} ${p}: ${err instanceof Error ? err.message : err}`)
    return { ...base, outcome: 'failed', reason: err instanceof Error ? err.message : String(err) }
  }
}

async function pruneRepo(mainDir: string, d: ResolvedDeps): Promise<void> {
  if (d.dryRun) return
  try { await d.git(['-C', mainDir, 'worktree', 'prune']) } catch {}
}

/** Main checkout that owns the worktree at `p` (via --git-common-dir), or null. */
async function mainDirForWorktree(p: string, d: ResolvedDeps): Promise<string | null> {
  const out = await probe(d.git, ['-C', p, 'rev-parse', '--path-format=absolute', '--git-common-dir'])
  if (!out) return null
  const common = path.resolve(p, out.trim())
  return path.basename(common) === '.git' ? path.dirname(common) : null
}

/** Existing worktree dirs that encode this objective id. */
function candidatePathsForObjective(objectiveId: number, projectsDir: string): string[] {
  const found = new Set<string>()
  const direct = [`/tmp/cc-worktree-${objectiveId}`, path.join(projectsDir, `.cc-worktree-${objectiveId}`)]
  for (const p of direct) {
    try { if (fs.existsSync(p)) found.add(p) } catch {}
  }
  try {
    for (const name of fs.readdirSync(projectsDir)) {
      if (!name.includes(`-wt-${objectiveId}`)) continue
      const p = path.join(projectsDir, name)
      if (objectiveIdFromWorktreePath(p, projectsDir) === objectiveId) found.add(p)
    }
  } catch {}
  return [...found]
}

export interface ObjectiveReapOptions {
  db?: Database
  /** Main checkout + local branch to drop after the worktree is gone (old PATCH /status behavior). */
  projectDir?: string
  branch?: string | null
}

/**
 * Hook for a card that just landed in done/cancelled. Removes every recognized
 * worktree for the objective that passes the gates, then (optionally) deletes
 * its local branch when that branch is checked out nowhere and fully pushed.
 * Never throws.
 */
export async function reapObjectiveWorktrees(
  objectiveId: number,
  opts: ObjectiveReapOptions = {},
  deps: ReaperDeps = {},
): Promise<ReapResult[]> {
  const results: ReapResult[] = []
  if (!isReaperEnabled()) return results
  try {
    const d = resolveDeps(deps, opts.db)
    for (const p of candidatePathsForObjective(objectiveId, d.projectsDir)) {
      const mainDir = await mainDirForWorktree(p, d)
      if (!mainDir) {
        d.log(`[worktree-reaper] kept: #${objectiveId} ${p} (not a git worktree)`)
        continue
      }
      const listed = parseWorktreePorcelain(await d.git(['-C', mainDir, 'worktree', 'list', '--porcelain']))
      const entry = listed.find(w => stripTrailingSlashes(w.path) === stripTrailingSlashes(p))
      if (!entry) {
        d.log(`[worktree-reaper] kept: #${objectiveId} ${p} (not registered with ${mainDir})`)
        continue
      }
      const { reap, skip } = selectReapable([entry], d.readStatus, d.projectsDir)
      for (const s of skip) d.log(`[worktree-reaper] kept: #${objectiveId} ${p} (${s.reason})`)
      for (const c of reap) {
        const r = await reapOne(mainDir, c, d)
        results.push(r)
        if (r.outcome === 'removed') await pruneRepo(mainDir, d)
      }
    }
    if (opts.projectDir && opts.branch) await deleteBranchIfSafe(objectiveId, opts.projectDir, opts.branch, d)
  } catch (err) {
    console.warn(`[worktree-reaper] reap for #${objectiveId} failed:`, err instanceof Error ? err.message : err)
  }
  return results
}

async function deleteBranchIfSafe(objectiveId: number, projectDir: string, branch: string, d: ResolvedDeps): Promise<void> {
  // Branch names come from the DB; refuse anything that could be read as an option.
  if (!branch || branch.startsWith('-')) return
  const ref = `refs/heads/${branch}`
  if ((await probe(d.git, ['-C', projectDir, 'rev-parse', '--verify', '--quiet', ref])) == null) return
  const listed = parseWorktreePorcelain((await probe(d.git, ['-C', projectDir, 'worktree', 'list', '--porcelain'])) ?? '')
  if (listed.some(w => w.branch === branch)) {
    d.log(`[worktree-reaper] kept branch ${branch} (#${objectiveId}): still checked out in a worktree`)
    return
  }
  const unpushed = await probe(d.git, ['-C', projectDir, 'rev-list', ref, '--not', '--remotes'])
  if (unpushed == null || unpushed.trim() !== '') {
    d.log(`[worktree-reaper] kept branch ${branch} (#${objectiveId}): unpushed commits`)
    return
  }
  const now = d.readStatus(objectiveId)
  if (now == null || !REAPABLE_STATUSES.has(now)) return
  if (d.dryRun) {
    d.log(`[worktree-reaper] DRY RUN would delete branch ${branch} (#${objectiveId})`)
    return
  }
  try {
    await d.git(['-C', projectDir, 'branch', '-D', branch])
    d.log(`[worktree-reaper] deleted branch ${branch} (#${objectiveId})`)
  } catch {}
}

/**
 * Fire-and-forget wrapper used at every done/cancelled transition. Deferred so
 * the status write + response are never held up by git. No-op under vitest
 * (a test card id could collide with a real /tmp/cc-worktree-<id> on the host)
 * unless CC_WORKTREE_REAPER_IN_TESTS=true.
 */
export function scheduleObjectiveWorktreeReap(objectiveId: number, opts: ObjectiveReapOptions = {}): void {
  if (!isReaperEnabled()) return
  if (process.env.VITEST && process.env.CC_WORKTREE_REAPER_IN_TESTS !== 'true') return
  if (!Number.isSafeInteger(objectiveId) || objectiveId <= 0) return
  setImmediate(() => {
    reapObjectiveWorktrees(objectiveId, opts).catch(err =>
      console.warn(`[worktree-reaper] scheduled reap for #${objectiveId} failed:`, err instanceof Error ? err.message : err),
    )
  })
}

export interface SweepReport { repos: number; worktrees: number; results: ReapResult[] }

let sweepRunning = false

/**
 * Sweep every git repo directly under PROJECTS_DIR and reap worktrees whose
 * card is done/cancelled. Never throws; concurrent calls collapse into one.
 */
export async function sweepFinishedWorktrees(deps: ReaperDeps = {}): Promise<SweepReport> {
  const report: SweepReport = { repos: 0, worktrees: 0, results: [] }
  if (!isReaperEnabled() || sweepRunning) return report
  sweepRunning = true
  try {
    const d = resolveDeps(deps)
    let names: string[] = []
    try { names = fs.readdirSync(d.projectsDir) } catch { return report }
    for (const name of names) {
      const repo = path.join(d.projectsDir, name)
      // Main checkouts only: a linked worktree has a `.git` FILE, not a dir.
      try { if (!fs.statSync(path.join(repo, '.git')).isDirectory()) continue } catch { continue }
      let listed: WorktreeEntry[]
      try {
        listed = parseWorktreePorcelain(await d.git(['-C', repo, 'worktree', 'list', '--porcelain']))
      } catch {
        continue
      }
      report.repos++
      report.worktrees += listed.length
      const { reap } = selectReapable(listed, d.readStatus, d.projectsDir)
      let removed = 0
      for (const c of reap) {
        const r = await reapOne(repo, c, d)
        report.results.push(r)
        if (r.outcome === 'removed') removed++
      }
      if (removed > 0) await pruneRepo(repo, d)
    }
    const count = (o: ReapOutcome) => report.results.filter(r => r.outcome === o).length
    d.log(
      `[worktree-reaper] sweep${d.dryRun ? ' (dry run)' : ''}: ${report.repos} repos, ${report.worktrees} worktrees, ` +
      `removed=${count('removed')} would-remove=${count('would-remove')} kept=${count('kept')} failed=${count('failed')}`,
    )
  } catch (err) {
    console.warn('[worktree-reaper] sweep failed:', err instanceof Error ? err.message : err)
  } finally {
    sweepRunning = false
  }
  return report
}

let sweepTimer: ReturnType<typeof setInterval> | null = null
let lastKickMs = 0

/** Extra sweep on demand (e.g. low-disk alert), rate-limited. */
export function kickWorktreeSweep(reason: string): void {
  if (!isReaperEnabled()) return
  const now = Date.now()
  if (now - lastKickMs < KICK_COOLDOWN_MS) return
  lastKickMs = now
  console.log(`[worktree-reaper] sweep kicked (${reason})`)
  void sweepFinishedWorktrees()
}

export function startWorktreeReaper(): void {
  if (!isReaperEnabled()) {
    console.log('[worktree-reaper] disabled via CC_WORKTREE_REAPER=false')
    return
  }
  if (sweepTimer) return
  setTimeout(() => { void sweepFinishedWorktrees() }, FIRST_SWEEP_DELAY_MS).unref()
  sweepTimer = setInterval(() => { void sweepFinishedWorktrees() }, SWEEP_INTERVAL_MS)
  sweepTimer.unref()
  console.log(`[worktree-reaper] started (every ${SWEEP_INTERVAL_MS / 1000}s${isReaperDryRun() ? ', dry run' : ''})`)
}
