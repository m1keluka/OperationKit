/**
 * Script routines (obj 64, Part B).
 *
 * A `kind='script'` routine runs a shell command on its cron schedule with NO
 * model call. Two routines were spending AI tokens every hour only to run a
 * script and answer "ok"; a script routine costs nothing on success and only
 * escalates to an AI card when the script says something is wrong.
 *
 * This module is deliberately split into:
 *  - `decideScriptOutcome` — PURE: exit code / timeout / spawn error / output →
 *    ok | alert | failed (+ whether to escalate, whether it counts as a failure).
 *  - `defaultScriptExecutor` — spawns `bash -lc <cmd>`, enforces the timeout,
 *    captures (capped) combined stdout+stderr.
 *  - an injectable executor seam (`_setScriptExecutorForTests`) so the scheduler
 *    path is testable without spawning real processes.
 */
import { spawn } from 'child_process'
import { stripServerSigningSecrets } from '../lib/session-trust.js'

/** Server env minus the JWT signing secrets (obj 64). */
export function scriptEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...base }
  stripServerSigningSecrets(env)
  return env
}

export const DEFAULT_ALERT_MARKER = 'ALERT:'
export const DEFAULT_SCRIPT_TIMEOUT_SEC = 10 * 60
/** Combined stdout+stderr retained per run (tail kept; head dropped past this). */
export const MAX_SCRIPT_OUTPUT_BYTES = 256 * 1024
/** Bytes of output persisted on the routine row / appended to an escalation card. */
export const OUTPUT_TAIL_BYTES = 4 * 1024
/** Grace between SIGTERM and SIGKILL on timeout. */
const KILL_GRACE_MS = 5000

export interface ScriptExecResult {
  /** Process exit code; null when killed by a signal or never started. */
  exitCode: number | null
  signal?: string | null
  timedOut: boolean
  /** Set when the process could not be started at all. */
  spawnError?: string
  /** Combined stdout+stderr (tail-capped at MAX_SCRIPT_OUTPUT_BYTES). */
  output: string
  durationMs: number
}

export interface ScriptExecOptions {
  timeoutMs: number
  maxOutputBytes?: number
}

export type ScriptExecutor = (command: string, opts: ScriptExecOptions) => Promise<ScriptExecResult>

export type ScriptRunStatus = 'ok' | 'alert' | 'failed'

export interface ScriptOutcome {
  status: ScriptRunStatus
  /** Create an AI card (failed OR alert). */
  escalate: boolean
  /** Counts toward the auto-pause streak (failed only — an alert with exit 0 is not a failure). */
  isFailure: boolean
  /** Human summary, e.g. "exit 2", "timed out after 600s", "alert: ALERT: disk 91%". */
  reason: string
  /** The first alert-marker line seen, if any. */
  alertLine: string | null
}

/** The first line (trailing \r stripped) that STARTS with `marker`, or null. */
export function findAlertLine(output: string, marker: string): string | null {
  if (!marker) return null
  for (const raw of output.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    if (line.startsWith(marker)) return line
  }
  return null
}

/**
 * Pure outcome decision for one script run.
 *  - spawn error / timeout / non-zero (or signal-killed) exit → failed (escalate, counts as failure)
 *  - exit 0 with a line starting with the marker            → alert  (escalate, NOT a failure)
 *  - exit 0 otherwise                                        → ok     (no card, resets the streak)
 */
export function decideScriptOutcome(
  res: Pick<ScriptExecResult, 'exitCode' | 'timedOut' | 'spawnError' | 'output' | 'signal'>,
  opts: { alertMarker?: string | null; timeoutSec?: number } = {},
): ScriptOutcome {
  const marker = opts.alertMarker && opts.alertMarker.length > 0 ? opts.alertMarker : DEFAULT_ALERT_MARKER
  const alertLine = findAlertLine(res.output || '', marker)
  if (res.spawnError) {
    return { status: 'failed', escalate: true, isFailure: true, reason: `spawn error: ${res.spawnError}`, alertLine }
  }
  if (res.timedOut) {
    const t = opts.timeoutSec != null ? ` after ${opts.timeoutSec}s` : ''
    return { status: 'failed', escalate: true, isFailure: true, reason: `timed out${t}`, alertLine }
  }
  if (res.exitCode !== 0) {
    const reason = res.exitCode == null ? `killed by ${res.signal ?? 'signal'}` : `exit ${res.exitCode}`
    return { status: 'failed', escalate: true, isFailure: true, reason, alertLine }
  }
  if (alertLine) {
    return { status: 'alert', escalate: true, isFailure: false, reason: `alert: ${alertLine.slice(0, 200)}`, alertLine }
  }
  return { status: 'ok', escalate: false, isFailure: false, reason: 'exit 0', alertLine: null }
}

/** Last `bytes` of `s` (by UTF-16 length, close enough for a display tail). */
export function tailOf(s: string, bytes = OUTPUT_TAIL_BYTES): string {
  return s.length <= bytes ? s : s.slice(s.length - bytes)
}

/**
 * Real executor: `bash -lc <command>` in its own process group (so a timeout
 * kills the whole tree), stdin closed, stdout+stderr interleaved into one
 * tail-capped buffer. Never rejects.
 */
export const defaultScriptExecutor: ScriptExecutor = (command, opts) => {
  const started = Date.now()
  const cap = opts.maxOutputBytes ?? MAX_SCRIPT_OUTPUT_BYTES
  return new Promise<ScriptExecResult>(resolve => {
    let output = ''
    let timedOut = false
    let settled = false
    const append = (chunk: Buffer) => {
      output += chunk.toString()
      if (output.length > cap) output = output.slice(output.length - cap)
    }
    const finish = (r: Omit<ScriptExecResult, 'output' | 'durationMs' | 'timedOut'>) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (killTimer) clearTimeout(killTimer)
      resolve({ ...r, timedOut, output, durationMs: Date.now() - started })
    }

    let child: ReturnType<typeof spawn>
    try {
      child = spawn('bash', ['-lc', command], {
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
        // Operator-defined command, but it still must not be able to mint an owner
        // cookie: drop the server signing secrets, same as session spawns.
        env: scriptEnv(),
      })
    } catch (err) {
      resolve({
        exitCode: null,
        timedOut: false,
        spawnError: err instanceof Error ? err.message : String(err),
        output: '',
        durationMs: Date.now() - started,
      })
      return
    }

    const killGroup = (sig: NodeJS.Signals) => {
      try {
        if (child.pid) process.kill(-child.pid, sig)
      } catch {
        try { child.kill(sig) } catch { /* already gone */ }
      }
    }
    let killTimer: ReturnType<typeof setTimeout> | null = null
    const timer = setTimeout(() => {
      timedOut = true
      killGroup('SIGTERM')
      killTimer = setTimeout(() => killGroup('SIGKILL'), KILL_GRACE_MS)
    }, opts.timeoutMs)

    child.stdout?.on('data', append)
    child.stderr?.on('data', append)
    child.on('error', err => finish({ exitCode: null, spawnError: err.message }))
    child.on('close', (code, signal) => finish({ exitCode: code, signal }))
  })
}

let executor: ScriptExecutor = defaultScriptExecutor

export function getScriptExecutor(): ScriptExecutor {
  return executor
}

/** Test seam: swap the executor (pass null to restore the real one). */
export function _setScriptExecutorForTests(fn: ScriptExecutor | null): void {
  executor = fn ?? defaultScriptExecutor
}
