// Scratch-server guard (obj 900547).
//
// Incident: #900543 died twice on 2026-11-11 (05:11:00 and 05:18:39 UTC) seconds
// after the worker booted a throwaway copy of Command Center inside its own jail
// for screenshots (`npx tsx src/index.ts`, PORT=3902 then 3912, temp DB). That
// copy ran the FULL host boot path, including the state poller. Its first tick
// (3s) runs `sweepOrphanWorkerTmux()`, which lists `tmux ls` and kills every
// `cc-<id>-<digits>` session that is not a live session_id in ITS database. In a
// jail, `tmux ls` lists exactly one session — the worker's own
// (`cc-900543-1794373470759`), and the scratch server's temp DB has no such
// objective — so the scratch server killed the session that started it. The jail's
// PID-1 loop (`while tmux has-session …`) then exited, the CLI never wrote a
// `result` event, and the card landed in review with 0 tokens.
//
// Two independent layers stop that:
//   1. `detectScratchInstance()` — index.ts starts NONE of the host daemons
//      (poller, reapers, schedulers, watchdogs, queue drain, bridges, sweeps) when
//      this process is a scratch/dev copy. HTTP + WebSocket still serve, so a
//      screenshot server keeps working.
//   2. `protectedTmuxSessions()` — even on a real host, a tmux reaper never kills
//      the tmux session the current process itself runs inside.
//
// The detection is deliberately NEGATIVE-marker based (any marker → scratch), with
// `CC_HOST_INSTANCE=1` as the explicit override: the real host's entrypoint sets no
// new env (adding one would need a session-killing compose rebuild), and the
// incident server ran under `env -i` with a fresh HOME, so env markers alone are
// not enough — the process-ancestry check (a `claude` CLI or a worker tmux pane
// above us) catches it regardless of env.
import fs from 'fs'
import { execSync } from 'child_process'

export interface ScratchVerdict {
  scratch: boolean
  reason: string | null
}

export interface ScratchProbe {
  env: NodeJS.ProcessEnv
  cwd: string
  moduleUrl: string
  /** Command lines of this process's ancestors (parent first). */
  ancestorCmdlines: string[]
  /** `tmux display-message -p '#{session_name}'` when $TMUX is set. */
  tmuxSessionName?: string | null
}

const TRUE_RE = /^(1|true|yes|on)$/i

/** Paths that only exist for a session: jail HOME, harness worktrees. */
export function looksLikeSessionPath(p: string): boolean {
  return /(?:^|\/)(?:cc-wt-|cc-worktree-)/.test(p) || /(?:^|\/)home\/jailuser(?:\/|$)/.test(p)
}

/** An ancestor is a Claude/Codex CLI or a worker tmux wrapper. */
export function isSessionAncestor(cmdline: string): boolean {
  const argv0 = cmdline.split(/\s+/)[0] ?? ''
  const base = argv0.split('/').pop() ?? ''
  if (base === 'claude' || base === 'codex') return true
  // The worker's tmux wrapper script: `bash /home/<x>/.cc/cc-<id>-<digits>.sh`
  if (/\/cc-\d+-\d+\.sh(?:\s|$)/.test(cmdline)) return true
  // `tmux new-session -d -s cc-<id>-<digits> …`
  if (/\btmux\b.*\s-s\s+cc-\d+-\d+(?:\s|$)/.test(cmdline)) return true
  return false
}

/** Pure decision. Exported for tests. */
export function decideScratch(p: ScratchProbe): ScratchVerdict {
  const e = p.env
  if (TRUE_RE.test(e.CC_HOST_INSTANCE ?? '')) return { scratch: false, reason: null }
  if (TRUE_RE.test(e.CC_SCRATCH_SERVER ?? '') || TRUE_RE.test(e.OK_SCRATCH ?? '')) {
    return { scratch: true, reason: 'CC_SCRATCH_SERVER/OK_SCRATCH set' }
  }
  if (e.NODE_ENV === 'test' || e.VITEST) return { scratch: true, reason: 'NODE_ENV=test' }
  for (const k of ['CC_OBJECTIVE_ID', 'CC_SESSION_TOKEN', 'CC_WORKTREE_ROOT']) {
    if (e[k]) return { scratch: true, reason: `${k} set (inherited a worker session env)` }
  }
  if (e.TMUX && /^cc-\d+-\d+$/.test(p.tmuxSessionName ?? '')) {
    return { scratch: true, reason: 'running inside a worker tmux session' }
  }
  if (looksLikeSessionPath(p.cwd)) return { scratch: true, reason: `cwd ${p.cwd} is a session path` }
  let modulePath = p.moduleUrl
  try { modulePath = new URL(p.moduleUrl).pathname } catch { /* plain path */ }
  if (looksLikeSessionPath(modulePath)) return { scratch: true, reason: `code runs from session path ${modulePath}` }
  const anc = p.ancestorCmdlines.find(isSessionAncestor)
  if (anc) return { scratch: true, reason: `started by a session process (${anc.slice(0, 80)})` }
  return { scratch: false, reason: null }
}

function currentTmuxSessionName(): string | null {
  // $TMUX is "<socket>,<server pid>,<session index>" — it does not carry the name,
  // so ask tmux. Best effort: a missing tmux just means "unknown".
  try {
    return execSync(`tmux display-message -p '#{session_name}' 2>/dev/null`, { timeout: 2000 }).toString().trim() || null
  } catch {
    return null
  }
}

/** Linux /proc ancestry. Returns [{pid, cmdline}] parent-first, bounded. */
export function readAncestors(startPid: number = process.pid, procRoot = '/proc'): Array<{ pid: number; cmdline: string }> {
  const out: Array<{ pid: number; cmdline: string }> = []
  let pid = startPid
  for (let i = 0; i < 64; i++) {
    let ppid: number
    try {
      const stat = fs.readFileSync(`${procRoot}/${pid}/stat`, 'utf8')
      // Field 4 after the parenthesised comm (which can contain spaces).
      const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
      ppid = Number(rest[1])
    } catch {
      break
    }
    if (!ppid || ppid === pid) break
    let cmdline = ''
    try { cmdline = fs.readFileSync(`${procRoot}/${ppid}/cmdline`, 'utf8').split('\0').filter(Boolean).join(' ') } catch { /* gone */ }
    out.push({ pid: ppid, cmdline })
    if (ppid === 1) break
    pid = ppid
  }
  return out
}

let cached: ScratchVerdict | null = null

/** Memoised verdict for THIS process. */
export function detectScratchInstance(moduleUrl = ''): ScratchVerdict {
  if (cached) return cached
  cached = decideScratch({
    env: process.env,
    cwd: process.cwd(),
    moduleUrl,
    ancestorCmdlines: readAncestors().map(a => a.cmdline),
    tmuxSessionName: process.env.TMUX ? currentTmuxSessionName() : null,
  })
  return cached
}

/** Test-only. */
export function __resetScratchCache(): void { cached = null }

/**
 * Pure: names of tmux sessions whose pane process is this process or one of its
 * ancestors — i.e. the session we are running inside. A reaper must never kill
 * these: doing so kills the process doing the reaping and everything above it.
 */
export function selectSelfTmuxSessions(panes: Array<{ session: string; panePid: number }>, selfPids: Iterable<number>): Set<string> {
  const pids = new Set(selfPids)
  const out = new Set<string>()
  for (const p of panes) if (pids.has(p.panePid)) out.add(p.session)
  return out
}

/** The tmux sessions containing this process (empty on any error). */
export function protectedTmuxSessions(): Set<string> {
  try {
    const raw = execSync(`tmux list-panes -a -F '#{session_name} #{pane_pid}' 2>/dev/null`, { timeout: 5000 }).toString()
    const panes = raw.split('\n').map(l => l.trim()).filter(Boolean).map(l => {
      const sp = l.lastIndexOf(' ')
      return { session: l.slice(0, sp), panePid: Number(l.slice(sp + 1)) }
    })
    const self = [process.pid, ...readAncestors().map(a => a.pid)]
    return selectSelfTmuxSessions(panes, self)
  } catch {
    return new Set()
  }
}
