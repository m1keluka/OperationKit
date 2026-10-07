import { spawn } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  pickAccount,
  recordRateLimit,
  recordAuthFailure,
  isRateLimitMessage,
  isAuthFailureMessage,
  parseResetTime,
  type AccountSlot,
} from '../account-router.js'

// ── Claude Code CLI backend for the LLM gateway ──
//
// One gateway request = one headless `claude -p` turn on a pool account's
// HOME. It is a PURE LLM call: every built-in tool is disabled (`--tools ""`),
// no MCP servers (`--strict-mcp-config` with none given), no user/project
// settings or hooks (`--setting-sources ""`), no skills, no session written to
// disk, the default Claude Code system prompt replaced, and the cwd is an
// empty scratch dir. The process env is built from scratch (PATH/HOME/USER
// only) so no server secret — and no ANTHROPIC_API_KEY — reaches it; the CLI
// authenticates with the slot's own OAuth credential like a board session.

export interface BackendUsage {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
}

export interface BackendRequest {
  model: string
  systemPrompt: string
  prompt: string
  signal?: AbortSignal
  /** Called for each streamed text delta, in order. */
  onText?: (delta: string) => void
}

export interface BackendResult {
  text: string
  usage: BackendUsage
  stopReason: string | null
  slot: string
  costUsd: number
  ttftMs: number | null
  attempts: number
}

export type LlmBackend = (req: BackendRequest) => Promise<BackendResult>

export type BackendErrorKind = 'no_account' | 'rate_limit' | 'auth' | 'timeout' | 'aborted' | 'cli_error'

export class BackendError extends Error {
  constructor(
    readonly kind: BackendErrorKind,
    message: string,
    readonly slot?: string,
    /** True once any text was handed to onText — the request can't be retried. */
    readonly emitted = false,
  ) {
    super(message)
  }
}

/** Slots the gateway may use. Default: every rotation slot except 'a' (Mike's personal account). */
export function gatewaySlotFilter(env: NodeJS.ProcessEnv = process.env): (a: AccountSlot) => boolean {
  const raw = (env.LLM_GATEWAY_SLOTS ?? '').trim()
  if (!raw) return a => a.id !== 'a'
  const allow = new Set(raw.split(',').map(s => s.trim()).filter(Boolean))
  return a => allow.has(a.id)
}

const EMPTY_CWD = path.join(os.tmpdir(), 'cc-llm-gateway-empty')

function ensureEmptyCwd(): string {
  try {
    fs.mkdirSync(EMPTY_CWD, { recursive: true, mode: 0o755 })
    fs.chmodSync(EMPTY_CWD, 0o755)
  } catch {
    /* best effort; spawn will surface a real problem */
  }
  return EMPTY_CWD
}

/** Exported for tests: the exact CLI argv for a gateway turn. */
export function buildClaudeArgs(model: string, systemPrompt: string): string[] {
  return [
    '-p',
    '--model', model,
    '--tools', '',
    '--strict-mcp-config',
    '--setting-sources', '',
    '--disable-slash-commands',
    '--no-session-persistence',
    '--system-prompt', systemPrompt,
    '--output-format', 'stream-json',
    '--include-partial-messages',
    '--verbose',
    '--max-budget-usd', '5',
  ]
}

/** Exported for tests: the scrubbed env a gateway turn runs with. */
export function buildClaudeEnv(homeDir: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  // Same CLI board sessions run (session-tmux.ts): the hand-installed, newer
  // Claude Code in CC_CLI_BIN_DIR wins over the image's /usr/local/bin one,
  // which is too old for the newest models. Empty string disables the prepend.
  const cliBinDir = base.CC_CLI_BIN_DIR ?? '/app/data/cli/node_modules/.bin'
  const basePath = base.PATH ?? '/usr/local/bin:/usr/bin:/bin'
  return {
    PATH: cliBinDir ? `${cliBinDir}:${basePath}` : basePath,
    HOME: homeDir,
    USER: 'ccuser',
    TERM: 'dumb',
    LANG: base.LANG ?? 'C.UTF-8',
    // Keep the CLI from phoning home for non-essential work on every call.
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_AUTOUPDATER: '1',
  }
}

/**
 * Exported for tests. The server runs as root in the container and the slot
 * credentials belong to ccuser, so we hop users with runuser — which RESETS
 * HOME to ccuser's passwd home. HOME must therefore be re-set after the hop
 * (via `env`), or the CLI never finds the slot's .claude/.credentials.json and
 * answers "Not logged in". (mentor-session does the same with `export HOME`.)
 */
export function buildSpawnCommand(env: NodeJS.ProcessEnv, args: string[], asRoot: boolean): [string, string[]] {
  if (!asRoot) return ['claude', args]
  // PATH too: login.defs ALWAYS_SET_PATH can make runuser reset it, which would
  // lose the CC_CLI_BIN_DIR prepend and fall back to the image's older CLI.
  return ['runuser', ['-u', 'ccuser', '--', 'env', `HOME=${env.HOME}`, `PATH=${env.PATH}`, 'claude', ...args]]
}

interface StreamState {
  text: string
  sawDelta: boolean
  /** Full assistant text blocks, used only if no partial deltas arrived. */
  fallbackText: string
  usage: BackendUsage | null
  stopReason: string | null
  costUsd: number
  resultError: string | null
  rateLimited: { reset?: Date; raw: string } | null
  authFailed: string | null
  ttftMs: number | null
}

/** Exported for tests: apply one stream-json line to the turn state. */
export function applyStreamLine(line: string, st: StreamState, startedAt: number, onText?: (d: string) => void): void {
  let ev: any
  try {
    ev = JSON.parse(line)
  } catch {
    return
  }
  if (ev.type === 'stream_event') {
    const e = ev.event
    if (e?.type === 'content_block_delta' && e.delta?.type === 'text_delta' && typeof e.delta.text === 'string') {
      if (st.ttftMs === null) st.ttftMs = Date.now() - startedAt
      st.sawDelta = true
      st.text += e.delta.text
      onText?.(e.delta.text)
    } else if (e?.type === 'message_delta' && e.delta?.stop_reason) {
      st.stopReason = e.delta.stop_reason
    }
    return
  }
  if (ev.type === 'rate_limit_event' || ev.type === 'rate_limit') {
    const info = ev.rate_limit_info || ev
    if (info.status && String(info.status).startsWith('allowed')) return
    st.rateLimited = {
      reset: info.resetsAt ? new Date(info.resetsAt * 1000) : undefined,
      raw: JSON.stringify(ev).slice(0, 500),
    }
    return
  }
  if (ev.type === 'assistant' && !st.sawDelta && Array.isArray(ev.message?.content)) {
    // No partial deltas. Real model output always streams deltas with
    // --include-partial-messages; a delta-less assistant message is the CLI's
    // own synthetic error text ("Not logged in", "API Error: 400 …"), so hold
    // it back and only release it once the result proves the turn succeeded.
    for (const block of ev.message.content) {
      if (block?.type === 'text' && typeof block.text === 'string') st.fallbackText += block.text
    }
    return
  }
  if (ev.type === 'result') {
    if (!st.sawDelta && st.fallbackText && !ev.is_error) {
      if (st.ttftMs === null) st.ttftMs = Date.now() - startedAt
      st.text += st.fallbackText
      onText?.(st.fallbackText)
    }
    const u = ev.usage || {}
    const prompt = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0)
    const completion = u.output_tokens || 0
    st.usage = { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion }
    st.costUsd = typeof ev.total_cost_usd === 'number' ? ev.total_cost_usd : 0
    if (ev.stop_reason) st.stopReason = ev.stop_reason
    if (ev.is_error || (typeof ev.subtype === 'string' && ev.subtype.startsWith('error'))) {
      const msg = String(ev.result ?? ev.error ?? ev.subtype ?? 'error')
      st.resultError = msg
      if (ev.api_error_status === 401 || isAuthFailureMessage(msg)) st.authFailed = msg
      else if (isRateLimitMessage(msg)) st.rateLimited = { reset: parseResetTime(msg) ?? undefined, raw: msg.slice(0, 500) }
    }
  }
}

function newState(): StreamState {
  return { text: '', sawDelta: false, fallbackText: '', usage: null, stopReason: null, costUsd: 0, resultError: null, rateLimited: null, authFailed: null, ttftMs: null }
}

/** Run one turn on a specific account. */
export function runClaudeTurn(account: AccountSlot, req: BackendRequest, timeoutMs: number): Promise<Omit<BackendResult, 'attempts'>> {
  const startedAt = Date.now()
  const args = buildClaudeArgs(req.model, req.systemPrompt)
  const env = buildClaudeEnv(account.homeDir)
  const asRoot = typeof process.getuid === 'function' && process.getuid() === 0
  const [cmd, argv] = buildSpawnCommand(env, args, asRoot)

  return new Promise((resolve, reject) => {
    const st = newState()
    let stderr = ''
    let settled = false
    let emitted = false
    const proc = spawn(cmd, argv as string[], { cwd: ensureEmptyCwd(), env, stdio: ['pipe', 'pipe', 'pipe'] })

    const fail = (err: BackendError) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      req.signal?.removeEventListener('abort', onAbort)
      try { proc.kill('SIGTERM') } catch { /* already gone */ }
      reject(err)
    }
    const timer = setTimeout(() => fail(new BackendError('timeout', `claude turn exceeded ${timeoutMs}ms`, account.id, emitted)), timeoutMs)
    const onAbort = () => fail(new BackendError('aborted', 'client disconnected', account.id, emitted))
    if (req.signal?.aborted) return onAbort()
    req.signal?.addEventListener('abort', onAbort)

    let lineBuf = ''
    proc.stdout.on('data', (chunk: Buffer) => {
      lineBuf += chunk.toString()
      let nl: number
      while ((nl = lineBuf.indexOf('\n')) >= 0) {
        const line = lineBuf.slice(0, nl).trim()
        lineBuf = lineBuf.slice(nl + 1)
        if (line) applyStreamLine(line, st, startedAt, d => {
          emitted = true
          if (!settled) req.onText?.(d)
        })
      }
    })
    proc.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 4000) stderr += chunk.toString()
    })
    proc.on('error', err => fail(new BackendError('cli_error', `spawn failed: ${err.message}`, account.id, emitted)))
    proc.on('close', code => {
      if (lineBuf.trim()) applyStreamLine(lineBuf.trim(), st, startedAt, d => { emitted = true; if (!settled) req.onText?.(d) })
      if (settled) return
      if (st.authFailed || (!st.usage && isAuthFailureMessage(stderr))) {
        recordAuthFailure(account.id, (st.authFailed ?? stderr).slice(0, 500))
        return fail(new BackendError('auth', 'account credential rejected', account.id, emitted))
      }
      if (st.rateLimited || (!st.usage && isRateLimitMessage(stderr))) {
        const rl = st.rateLimited ?? { reset: parseResetTime(stderr) ?? undefined, raw: stderr.slice(0, 500) }
        recordRateLimit(account.id, rl.reset, rl.raw)
        // A rate_limit_event can arrive alongside a successful answer (warning tier);
        // only fail the request when no answer came back.
        if (!st.usage || st.resultError) return fail(new BackendError('rate_limit', 'account rate-limited', account.id, emitted))
      }
      if (st.resultError || code !== 0 || !st.usage) {
        return fail(new BackendError('cli_error', `claude exited ${code}: ${(st.resultError ?? stderr).slice(0, 300)}`, account.id, emitted))
      }
      settled = true
      clearTimeout(timer)
      req.signal?.removeEventListener('abort', onAbort)
      resolve({ text: st.text, usage: st.usage, stopReason: st.stopReason, slot: account.id, costUsd: st.costUsd, ttftMs: st.ttftMs })
    })

    proc.stdin.end(req.prompt)
  })
}

export interface ClaudeCliBackendOptions {
  env?: NodeJS.ProcessEnv
  pick?: (filter: (a: AccountSlot) => boolean) => AccountSlot | null
  run?: typeof runClaudeTurn
}

/**
 * Account-pool backend: pick an allowed slot, run the turn, and on a
 * rate-limit/auth failure that happened before any text was streamed, rotate
 * to another allowed slot (max 3 attempts).
 */
export function createClaudeCliBackend(opts: ClaudeCliBackendOptions = {}): LlmBackend {
  const pick = opts.pick ?? pickAccount
  const run = opts.run ?? runClaudeTurn
  return async req => {
    const env = opts.env ?? process.env
    const allowed = gatewaySlotFilter(env)
    const timeoutMs = Number(env.LLM_GATEWAY_TIMEOUT_MS) > 0 ? Number(env.LLM_GATEWAY_TIMEOUT_MS) : 300_000
    const tried = new Set<string>()
    let lastErr: BackendError | null = null
    for (let attempt = 1; attempt <= 3; attempt++) {
      const account = pick(a => allowed(a) && !tried.has(a.id))
      if (!account) break
      tried.add(account.id)
      try {
        const r = await run(account, req, timeoutMs)
        return { ...r, attempts: attempt }
      } catch (err) {
        const be = err instanceof BackendError ? err : new BackendError('cli_error', String(err), account.id)
        lastErr = be
        if (be.emitted || (be.kind !== 'rate_limit' && be.kind !== 'auth')) throw be
      }
    }
    throw lastErr ?? new BackendError('no_account', 'no allowed Claude account is available')
  }
}
