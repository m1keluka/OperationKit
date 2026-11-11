/**
 * jail-home — lifecycle of the per-session jail HOME, and of the secrets
 * written into it. (obj 900038)
 *
 * ## What was wrong
 *
 * `spawnInTmux` created `/tmp/cc-jail-homes/<sessionId>/` and then ran
 * `chmod 0777` on it and on its `.cc/` subdir, because the control plane and
 * the jail uid are different users and 0777 was the quick way to let the jail
 * read its wrapper. Inside that world-readable directory live:
 *
 *   - `<sid>.env` — the docker `--env-file`: EVERY injected secret, plaintext.
 *   - `<sid>.sh`  — the wrapper, whose `export KEY="value"` lines are the same
 *                   secrets again.
 *
 * Nothing deleted them. The wrapper `rm`s its own prompt + script on a clean
 * exit, but an early death (see jail-workspace.ts — `cd /workspace || exit 1`)
 * never reaches that line, and the `.env` was never removed at all. So a
 * long-lived host accumulated one world-readable plaintext credential dump per
 * dead session.
 *
 * ## What this module does
 *
 * 1. {@link createJailHome} makes the HOME and its `.cc/` **0700, owned by the
 *    jail uid**. No 0777 anywhere.
 * 2. {@link dropEnvFile} deletes the `--env-file` immediately after `docker run`
 *    returns. The daemon reads an env-file once, at container-create time, and
 *    bakes the values into the container config — so the file has no reason to
 *    outlive the `docker run` call by even a second.
 * 3. {@link scrubJailSecrets} removes the wrapper script and env file on session
 *    end, including an early death, while PRESERVING the transcripts.
 * 4. {@link cleanupJailHome} materialises the transcripts (the canonical paths
 *    are symlinks INTO this directory — see `linkTranscript`) and then removes
 *    the HOME entirely.
 * 5. {@link sweepOrphanJailHomes} deletes jail homes with no live session,
 *    older than N minutes, so a crashed control plane cannot leave them forever.
 *
 * Deletion is best-effort by design: a cleanup failure must never block a
 * session from ending. Every failure is logged.
 */
import fs from 'node:fs'
import path from 'node:path'
import { applyJailOwnership } from './jail-workspace.js'

/**
 * Host root for per-session jail HOME binds (SESSION_ISOLATION=docker only).
 * One dir per session, mounted at /home/jailuser inside its own jail.
 *
 * Canonical home of this constant: `session-tmux.ts` re-exports it for the
 * existing importers.
 */
export const JAIL_HOME_ROOT = process.env.CC_JAIL_HOME_ROOT || '/tmp/cc-jail-homes'

/** Minutes after which a jail home with no live session is swept. */
export const ORPHAN_JAIL_HOME_MAX_AGE_MIN = Number(process.env.CC_JAIL_HOME_MAX_AGE_MIN || 120)

const SAFE_SESSION_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/

export function isSafeSessionId(sessionId: string): boolean {
  return SAFE_SESSION_NAME.test(sessionId)
}

export interface JailHomePaths {
  home: string
  scriptDir: string
  envFile: string
  scriptFile: string
  promptFile: string
  jsonl: string
  log: string
}

/** Every host-side path belonging to one jailed session. Pure. */
export function jailHomePaths(sessionId: string, root: string = JAIL_HOME_ROOT): JailHomePaths {
  if (!isSafeSessionId(sessionId)) {
    throw new Error(`jail-home: unsafe session id ${JSON.stringify(sessionId)}`)
  }
  const home = path.join(root, sessionId)
  const scriptDir = path.join(home, '.cc')
  return {
    home,
    scriptDir,
    envFile: path.join(scriptDir, `${sessionId}.env`),
    scriptFile: path.join(scriptDir, `${sessionId}.sh`),
    promptFile: path.join(scriptDir, `${sessionId}.prompt.txt`),
    jsonl: path.join(scriptDir, `${sessionId}.jsonl`),
    log: path.join(scriptDir, `${sessionId}.log`),
  }
}

/**
 * The files inside a jail home that contain plaintext credentials. Transcripts
 * are NOT in this list — they are the card's evidence and are redacted on the
 * way in (`transcript-redact-filter.ts`).
 */
export function secretFiles(sessionId: string, root: string = JAIL_HOME_ROOT): string[] {
  const p = jailHomePaths(sessionId, root)
  return [p.envFile, p.scriptFile, p.promptFile]
}

/**
 * Create the jail HOME and its `.cc/` at 0700 owned by the jail uid.
 * Replaces the old `mkdir + chmod 0777` pair.
 */
export function createJailHome(sessionId: string, root: string = JAIL_HOME_ROOT): JailHomePaths {
  const p = jailHomePaths(sessionId, root)
  fs.mkdirSync(root, { recursive: true, mode: 0o711 })
  fs.mkdirSync(p.scriptDir, { recursive: true, mode: 0o700 })
  applyJailOwnership(p.home, 'dir')
  applyJailOwnership(p.scriptDir, 'dir')
  return p
}

/** Best-effort unlink that never throws. Returns true when the file is gone. */
export function removeFile(file: string): boolean {
  try {
    fs.rmSync(file, { force: true })
    return true
  } catch (err) {
    console.warn(`[jail-home] could not remove ${file}:`, (err as Error).message)
    return false
  }
}

/**
 * Delete the docker `--env-file` as soon as `docker run` has returned.
 *
 * Safe because `--env-file` is consumed once, synchronously, by the daemon
 * during container create; the running container reads its env from its own
 * config, never from this path. Keeping the file around bought nothing and was
 * the single largest plaintext-secret exposure on the host.
 */
export function dropEnvFile(envFilePath: string | undefined): boolean {
  if (!envFilePath) return false
  return removeFile(envFilePath)
}

/**
 * Remove every plaintext-credential file for a session, keeping transcripts.
 * Idempotent, and safe to call on a session that was never jailed.
 */
export function scrubJailSecrets(sessionId: string, root: string = JAIL_HOME_ROOT): string[] {
  if (!isSafeSessionId(sessionId)) return []
  const removed: string[] = []
  for (const f of secretFiles(sessionId, root)) {
    let exists = false
    try { exists = fs.existsSync(f) } catch { exists = false }
    if (!exists) continue
    if (removeFile(f)) removed.push(f)
  }
  if (removed.length) {
    console.log(`[jail-home] scrubbed ${removed.length} credential file(s) for session ${sessionId}`)
  }
  return removed
}

/**
 * Replace a canonical transcript symlink with a real copy of its target, so the
 * jail home can be deleted without taking the card's transcript with it.
 * A canonical path that is already a real file is left untouched.
 */
export function materializeTranscript(canonicalPath: string): boolean {
  try {
    const st = fs.lstatSync(canonicalPath, { throwIfNoEntry: false } as { throwIfNoEntry: false })
    if (!st || !st.isSymbolicLink()) return false
    const target = fs.realpathSync(canonicalPath)
    const bytes = fs.readFileSync(target)
    fs.rmSync(canonicalPath, { force: true })
    fs.writeFileSync(canonicalPath, bytes, { mode: 0o640 })
    return true
  } catch (err) {
    console.warn(`[jail-home] could not materialise transcript ${canonicalPath}:`, (err as Error).message)
    return false
  }
}

export interface CleanupJailHomeOpts {
  /** Canonical transcript paths that may be symlinks into this home. */
  transcriptPaths?: string[]
  root?: string
  /** Scrub secrets but keep the HOME (used when something still reads it). */
  keepHome?: boolean
}

/**
 * Full end-of-session cleanup: materialise transcripts, scrub the credential
 * files, then remove the HOME. Never throws.
 */
export function cleanupJailHome(sessionId: string, opts: CleanupJailHomeOpts = {}): boolean {
  const root = opts.root ?? JAIL_HOME_ROOT
  if (!isSafeSessionId(sessionId)) return false
  const { home } = jailHomePaths(sessionId, root)
  let exists = false
  try { exists = fs.existsSync(home) } catch { return false }
  if (!exists) return false

  for (const p of opts.transcriptPaths ?? []) materializeTranscript(p)
  scrubJailSecrets(sessionId, root)
  if (opts.keepHome) return true
  try {
    fs.rmSync(home, { recursive: true, force: true })
    console.log(`[jail-home] removed jail home for session ${sessionId}`)
    return true
  } catch (err) {
    console.warn(`[jail-home] could not remove jail home ${home}:`, (err as Error).message)
    return false
  }
}

export interface SweepResult {
  scanned: number
  removed: string[]
  skippedLive: string[]
}

/**
 * Remove jail homes that belong to no live session and are older than
 * `maxAgeMin`. A control plane that was SIGKILLed mid-session never runs
 * `cleanupJailHome`, so without this a crash leaves a plaintext env file on
 * disk indefinitely.
 *
 * `liveSessionIds` is passed in rather than read from the registry so the
 * sweeper stays pure enough to unit-test; the poller supplies the real set.
 */
export function sweepOrphanJailHomes(opts: {
  liveSessionIds: Iterable<string>
  maxAgeMin?: number
  root?: string
  now?: number
  /** obj 900372 — canonical transcript dir whose symlinks point INTO a jail home. */
  transcriptDir?: string
} ): SweepResult {
  const root = opts.root ?? JAIL_HOME_ROOT
  const maxAgeMs = (opts.maxAgeMin ?? ORPHAN_JAIL_HOME_MAX_AGE_MIN) * 60_000
  const now = opts.now ?? Date.now()
  const live = new Set(opts.liveSessionIds)
  const out: SweepResult = { scanned: 0, removed: [], skippedLive: [] }

  let entries: string[]
  try {
    entries = fs.readdirSync(root)
  } catch {
    return out // root does not exist on a tmux-mode host — nothing to sweep
  }
  for (const name of entries) {
    if (!isSafeSessionId(name)) continue
    out.scanned++
    if (live.has(name)) { out.skippedLive.push(name); continue }
    const dir = path.join(root, name)
    let mtime: number
    try {
      const st = fs.statSync(dir)
      if (!st.isDirectory()) continue
      mtime = st.mtimeMs
    } catch { continue }
    if (now - mtime < maxAgeMs) continue
    // obj 900372 — the canonical TRANSCRIPT_DIR entries are symlinks into this
    // home. A session whose death the control plane never observed (it was
    // spawned before a restart) reaches here with its transcript still a
    // symlink; removing the home without materialising it erased the card's
    // whole timeline (#900371: empty timeline, session_count 0).
    if (opts.transcriptDir) {
      for (const ext of ['jsonl', 'log']) materializeTranscript(path.join(opts.transcriptDir, `${name}.${ext}`))
    }
    // Scrub first: if the recursive remove fails (a file the control plane does
    // not own), the credentials are still gone.
    scrubJailSecrets(name, root)
    try {
      fs.rmSync(dir, { recursive: true, force: true })
      out.removed.push(name)
    } catch (err) {
      console.warn(`[jail-home] sweep could not remove ${dir}:`, (err as Error).message)
    }
  }
  if (out.removed.length) {
    console.log(`[jail-home] sweep removed ${out.removed.length} orphaned jail home(s): ${out.removed.join(', ')}`)
  }
  return out
}

// ── Throttled sweep entry point (poll loop) ──

let lastSweepAt = 0
/** Floor between sweeps. The poll loop ticks every 3s; scanning /tmp that often
 *  would be pure syscall noise for a condition that changes on the order of hours. */
export const SWEEP_INTERVAL_MS = Number(process.env.CC_JAIL_HOME_SWEEP_MS || 10 * 60_000)

/**
 * Called from the poll loop's hygiene pass. No-ops unless jail mode is on and
 * SWEEP_INTERVAL_MS has elapsed. Never throws.
 */
export function sweepOrphanJailHomesThrottled(opts: {
  enabled: boolean
  liveSessionIds: Iterable<string>
  now?: number
  transcriptDir?: string
}): SweepResult | null {
  if (!opts.enabled) return null
  const now = opts.now ?? Date.now()
  if (now - lastSweepAt < SWEEP_INTERVAL_MS) return null
  lastSweepAt = now
  try {
    return sweepOrphanJailHomes({ liveSessionIds: opts.liveSessionIds, now, transcriptDir: opts.transcriptDir })
  } catch (err) {
    console.warn('[jail-home] orphan sweep failed:', (err as Error).message)
    return null
  }
}

/** Test-only: forget the throttle so the next call sweeps. */
export function __resetJailHomeSweepThrottleForTests(): void {
  lastSweepAt = 0
}
