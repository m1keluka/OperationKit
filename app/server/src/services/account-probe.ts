/**
 * Subscription-only liveness probe for a Claude account slot. Shared by the
 * admin "Recheck" button and the periodic slot health check (obj 717767).
 *
 * Runs ONE tiny non-interactive turn as the slot's ccuser HOME on the cheapest
 * model, with no tools and no MCP servers, and classifies the reply:
 * served / rate-limited / auth failure (401, 403 org-disabled) / inconclusive.
 *
 * CRITICAL: it must never use the metered API key. The server process has
 * ANTHROPIC_API_KEY in its env; if it leaks into the probe, `claude` bills the
 * key and returns a healthy reply even when the slot's SUBSCRIPTION credential
 * is dead or its org disabled — a false pass that masks the exact failure we
 * are probing for. The keys are removed from the spawn env AND unset in the
 * shell, so only the slot's OAuth credential can authenticate.
 */
import { spawn } from 'child_process'
import { isRateLimitMessage, isAuthFailureMessage } from './account-router.js'

export interface ProbeResult {
  ok: boolean
  rateLimited: boolean
  authFailure: boolean
  output: string
}

/** `seatEnv` = a pasted-token seat's sign-in env (CLAUDE_CODE_OAUTH_TOKEN); absent = the HOME's login files. */
export type ProbeFn = (homeDir: string, seatEnv?: Record<string, string>) => Promise<ProbeResult>

/** Every env var that could make `claude` authenticate with something other than the slot's OAuth. */
export const PROBE_STRIPPED_ENV = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
] as const

const PROBE_TIMEOUT_MS = 45_000

/** Pure: the spawn env for a probe — the server env minus every non-subscription credential. */
export function buildProbeEnv(base: NodeJS.ProcessEnv, seatEnv?: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, TERM: 'dumb' }
  for (const key of PROBE_STRIPPED_ENV) delete env[key]
  // A pasted-token seat signs in with its own subscription token only. The
  // value travels in the child env, never on the command line (ps-visible).
  if (seatEnv?.CLAUDE_CODE_OAUTH_TOKEN) env.CLAUDE_CODE_OAUTH_TOKEN = seatEnv.CLAUDE_CODE_OAUTH_TOKEN
  return env
}

/**
 * Pure: the bash script the probe runs as ccuser. Minimal footprint: haiku, no
 * tools, no MCP, no slash commands, no saved session, one turn — a few tokens
 * of subscription usage, never API spend.
 */
export function buildProbeScript(homeDir: string, keepSeatToken = false): string {
  const unset = keepSeatToken ? PROBE_STRIPPED_ENV.filter(k => k !== 'CLAUDE_CODE_OAUTH_TOKEN') : PROBE_STRIPPED_ENV
  return (
    `unset ${unset.join(' ')}; ` +
    `export HOME=${JSON.stringify(homeDir)} TERM=dumb; ` +
    `exec claude -p 'Reply with the single word: ok' --model haiku --tools '' --strict-mcp-config ` +
    `--disable-slash-commands --no-session-persistence --max-turns 1`
  )
}

/** Pure: classify a finished probe from its exit code and combined output. */
export function classifyProbe(code: number | null, output: string): ProbeResult {
  const rateLimited = isRateLimitMessage(output)
  const authFailure = isAuthFailureMessage(output)
  // Serving iff a clean exit that isn't secretly a rate-limit/auth message.
  const ok = code === 0 && !rateLimited && !authFailure
  return { ok, rateLimited, authFailure, output }
}

/**
 * Run the probe. Uses spawn (not execSync) so it never blocks the event loop,
 * with a hard kill on timeout. A timeout / spawn error is inconclusive.
 */
export function probeAccount(homeDir: string, seatEnv?: Record<string, string>): Promise<ProbeResult> {
  const keepSeatToken = !!seatEnv?.CLAUDE_CODE_OAUTH_TOKEN
  return new Promise((resolve) => {
    let out = ''
    let settled = false
    const child = spawn(
      'runuser',
      ['-u', 'ccuser', '--', 'bash', '-c', buildProbeScript(homeDir, keepSeatToken)],
      { cwd: homeDir, env: buildProbeEnv(process.env, seatEnv) },
    )
    const done = (result: ProbeResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch {}
      done({ ok: false, rateLimited: false, authFailure: false, output: out || `probe timed out after ${PROBE_TIMEOUT_MS / 1000}s` })
    }, PROBE_TIMEOUT_MS)
    child.stdout?.on('data', (d) => { out += d.toString() })
    child.stderr?.on('data', (d) => { out += d.toString() })
    child.on('error', (err) => {
      done({ ok: false, rateLimited: false, authFailure: false, output: `spawn error: ${err.message}` })
    })
    child.on('close', (code) => done(classifyProbe(code, out)))
  })
}
