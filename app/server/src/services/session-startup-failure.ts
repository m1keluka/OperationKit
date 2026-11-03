/**
 * session-startup-failure — make a session that dies BEFORE the agent starts
 * say so, loudly, on the card. (obj 900038)
 *
 * ## What was silent
 *
 * The spawn wrapper's layout was:
 *
 *     cd <workdir> || exit 1
 *     echo "[wrapper] Starting at $(date)" >> <log>
 *     claude … >> <jsonl>
 *
 * `cd` ran BEFORE the first log write. When the bind source at `/workspace` was
 * un-enterable (jail-workspace.ts: a no-project card mounting the 0750 operator
 * home) the wrapper exited 1 having written exactly nothing. The card's jsonl
 * was empty, its log was empty, and the poller's only reading of that was
 * "ended with 0 tool calls" — which `classifyNoOpSpawn` treats as a no-op spawn
 * and RE-SPAWNS, up to MAX_NOOP_RESPAWNS, each attempt dying the same way in
 * ~5s. Six cards (#900029-#900032, #900035, #900036) looked merely lazy.
 *
 * ## The two halves
 *
 * 1. **In the wrapper** ({@link buildWorkdirGuard}): log FIRST, then `cd` inside
 *    an `if`. On failure write a human line to the log, a machine-readable
 *    `type:"error"` event to the jsonl, and exit {@link STARTUP_FAILURE_EXIT}.
 *    Both files live in the jail's own `.cc` dir, which always exists and is
 *    always writable by the jail uid — so this cannot itself fail silently.
 * 2. **In the server** ({@link detectStartupFailure}): recognise that event (or
 *    the bare log marker) on session death and surface exit code + stderr tail.
 *    `classifyNoOpSpawn` then returns `startup-failed`, which BLOCKS rather than
 *    re-spawning: re-running an identical broken spawn cannot succeed, and the
 *    retry loop is what turned one misconfiguration into dozens of dead cards.
 */

/** sysexits.h EX_CONFIG — "something was unconfigured", not a generic failure. */
export const STARTUP_FAILURE_EXIT = 78

/** Grep-able marker the wrapper writes to the log before exiting. */
export const STARTUP_FAILURE_MARKER = '[wrapper] STARTUP-FAILURE'

/** `subtype` of the jsonl event the wrapper emits. */
export const STARTUP_FAILURE_SUBTYPE = 'startup_failure'

export interface StartupFailure {
  /** Machine-readable cause, e.g. `workdir_unreachable`. */
  reason: string
  /** Process exit code, when known. */
  exitCode: number | null
  /** Last stderr/log lines — the actual `cd: Permission denied`, verbatim. */
  stderrTail: string
  /** The directory the wrapper could not enter, when the cause is a workdir. */
  workdir?: string
}

/**
 * Bash emitted into the wrapper in place of the bare `cd … || exit 1`.
 *
 * Deliberately a pure builder so the exact shell text is unit-testable without
 * spawning anything, in the same spirit as `buildJailRunArgv`.
 *
 * `jq` is not assumed to exist inside the jail image, so the jsonl event is
 * assembled with `printf` from already-JSON-quoted literals the caller passes.
 */
export function buildWorkdirGuard(opts: {
  /** Container-side workdir, ALREADY JSON.stringify'd by the caller. */
  workdirGuest: string
  /** Container-side log path, ALREADY JSON.stringify'd. */
  logGuest: string
  /** Container-side jsonl path, ALREADY JSON.stringify'd. */
  jsonlGuest: string
  sessionId: string
}): string {
  const { workdirGuest, logGuest, jsonlGuest, sessionId } = opts
  // The event is built with printf %s so the workdir — which may contain
  // characters that are special to the shell — is substituted by bash from a
  // variable rather than spliced into the format string.
  return `
# obj 900038: log BEFORE cd. The old unguarded cd ran before any logging, so an
# un-enterable /workspace produced a completely silent 5-second death.
CC_WORKDIR=${workdirGuest}
echo "[wrapper] Starting at $(date -u +%Y-%m-%dT%H:%M:%SZ) (workdir=$CC_WORKDIR)" >> ${logGuest}
if ! cd "$CC_WORKDIR" 2>> ${logGuest}; then
  CC_WD_DIAG="$(ls -ld "$CC_WORKDIR" 2>&1 | head -1; id 2>&1)"
  echo "${STARTUP_FAILURE_MARKER} cannot enter workdir $CC_WORKDIR" >> ${logGuest}
  echo "[wrapper] diagnostic: $CC_WD_DIAG" >> ${logGuest}
  printf '{"type":"error","subtype":"${STARTUP_FAILURE_SUBTYPE}","is_error":true,"session_id":"${sessionId}","exit_code":${STARTUP_FAILURE_EXIT},"reason":"workdir_unreachable","workdir":"%s","error":"startup failed: cannot enter workdir %s — %s"}\\n' \\
    "$CC_WORKDIR" "$CC_WORKDIR" "$(printf '%s' "$CC_WD_DIAG" | tr -d '"\\\\' | tr '\\n' ' ')" >> ${jsonlGuest}
  exit ${STARTUP_FAILURE_EXIT}
fi
echo "[wrapper] Entered $CC_WORKDIR" >> ${logGuest}`
}

/** Last `n` non-empty lines of a text blob, trimmed to `max` chars. */
export function tailLines(text: string, n = 8, max = 1200): string {
  const lines = (text || '').split('\n').map(l => l.trimEnd()).filter(l => l.trim())
  const tail = lines.slice(-n).join('\n')
  return tail.length > max ? tail.slice(-max) : tail
}

/**
 * Did this session die before the agent ever ran?
 *
 * Checks, in order of confidence:
 *   1. the structured `type:"error" subtype:"startup_failure"` jsonl event;
 *   2. the `[wrapper] STARTUP-FAILURE` log marker (jsonl lost/truncated);
 *   3. the ORIGINAL silent shape — a transcript with no events at all AND a log
 *      that never reached `[wrapper] Starting`. A session spawned from a wrapper
 *      that predates this change still reports as a startup failure instead of
 *      a no-op, so the respawn loop is broken on already-running hosts too.
 *
 * Returns null when the session started normally.
 */
export function detectStartupFailure(input: {
  jsonlLines: string[]
  logText: string
}): StartupFailure | null {
  const { jsonlLines, logText } = input

  for (const line of jsonlLines) {
    if (!line.includes(STARTUP_FAILURE_SUBTYPE)) continue
    try {
      const e = JSON.parse(line) as {
        type?: string; subtype?: string; exit_code?: number
        reason?: string; workdir?: string; error?: string
      }
      if (e.type === 'error' && e.subtype === STARTUP_FAILURE_SUBTYPE) {
        return {
          reason: e.reason || 'startup_failure',
          exitCode: typeof e.exit_code === 'number' ? e.exit_code : STARTUP_FAILURE_EXIT,
          stderrTail: tailLines(logText) || (e.error ?? ''),
          workdir: e.workdir,
        }
      }
    } catch { /* not JSON — fall through to the marker check */ }
  }

  if (logText.includes(STARTUP_FAILURE_MARKER)) {
    return {
      reason: 'workdir_unreachable',
      exitCode: STARTUP_FAILURE_EXIT,
      stderrTail: tailLines(logText),
    }
  }

  // Legacy silent shape: nothing in the transcript and the wrapper never
  // announced itself. An empty log with a non-empty transcript is a normal
  // (quiet) run and must NOT match.
  const hasEvents = jsonlLines.some(l => l.trim())
  const wrapperStarted = /\[wrapper\] Starting/.test(logText)
  if (!hasEvents && !wrapperStarted) {
    return {
      reason: 'wrapper_never_started',
      exitCode: null,
      stderrTail: tailLines(logText) || '(wrapper produced no output at all)',
    }
  }
  return null
}

/** One-line card summary: what failed, the exit code, and the stderr tail. */
export function describeStartupFailure(f: StartupFailure): string {
  const code = f.exitCode == null ? 'unknown' : String(f.exitCode)
  const where = f.workdir ? ` (workdir ${f.workdir})` : ''
  const tail = f.stderrTail ? `\n--- stderr tail ---\n${f.stderrTail}` : ''
  return `Session failed to start: ${f.reason}${where}. Wrapper exit code ${code}.${tail}`
}
