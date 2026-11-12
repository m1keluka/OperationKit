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

/** An image attached to the turn (obj 900157). `data` is bare base64. */
export interface BackendImage {
  media_type: string
  data: string
}

export interface BackendRequest {
  model: string
  systemPrompt: string
  prompt: string
  /**
   * Images to put in front of the prompt. Present only for the built-in agent
   * chat; the OpenAI-compatible gateway has no image path and never sets it.
   */
  images?: BackendImage[]
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

/** Priority at or above which a seat is a "reserve" seat, kept for sessions only. */
export const GATEWAY_RESERVE_PRIORITY = 10

/**
 * Seats the gateway may use. Default: every Claude seat except reserve seats
 * (priority ≥ 10 — the ones an operator marked "use last"). LLM_GATEWAY_SLOTS
 * (comma-separated seat ids) overrides.
 */
export function gatewaySlotFilter(env: NodeJS.ProcessEnv = process.env): (a: AccountSlot) => boolean {
  const raw = (env.LLM_GATEWAY_SLOTS ?? '').trim()
  if (!raw) return a => (a.priority ?? 0) < GATEWAY_RESERVE_PRIORITY
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

/**
 * Exported for tests: the exact CLI argv for a gateway turn.
 *
 * `withImages` adds `--input-format stream-json`, the only way to hand the CLI
 * an image content block (obj 900157). A text-only turn passes false and the
 * argv is unchanged from before images existed, so the gateway's hot path keeps
 * its exact behaviour.
 */
export function buildClaudeArgs(model: string, systemPrompt: string, withImages = false): string[] {
  return [
    '-p',
    ...(withImages ? ['--input-format', 'stream-json'] : []),
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
  /** The CLI found no credential at all ("Not logged in · Please run /login"). */
  notLoggedIn: string | null
  ttftMs: number | null
}

// "Not logged in · Please run /login" — the CLI started with NO credential: no
// CLAUDE_CODE_OAUTH_TOKEN in its env and no readable .credentials.json in its
// HOME. Distinct from a 401 (a credential that was presented and rejected):
// it says nothing about whether the seat's stored credential is good, so it
// must rotate to another seat but must NOT park this one (obj 900624).
const NOT_LOGGED_IN_PATTERN = /\bnot logged in\b|please run \/login/i

/** Did the CLI start without any credential? (obj 900624) */
export function isNotLoggedInMessage(text: string): boolean {
  return !!text && NOT_LOGGED_IN_PATTERN.test(text)
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
      if (isNotLoggedInMessage(msg)) st.notLoggedIn = msg
      else if (ev.api_error_status === 401 || isAuthFailureMessage(msg)) st.authFailed = msg
      else if (isRateLimitMessage(msg)) st.rateLimited = { reset: parseResetTime(msg) ?? undefined, raw: msg.slice(0, 500) }
    }
  }
}

function newState(): StreamState {
  return { text: '', sawDelta: false, fallbackText: '', usage: null, stopReason: null, costUsd: 0, resultError: null, rateLimited: null, authFailed: null, notLoggedIn: null, ttftMs: null }
}

/**
 * Exported for tests: what goes down the CLI's stdin.
 *
 * No images → the bare prompt, exactly as before. With images → one
 * stream-json user message whose content is the image blocks followed by the
 * prompt, which is what `--input-format stream-json` expects.
 */
export function buildClaudeStdin(prompt: string, images: BackendImage[]): string {
  if (images.length === 0) return prompt
  const content = [
    ...images.map(i => ({ type: 'image', source: { type: 'base64', media_type: i.media_type, data: i.data } })),
    { type: 'text', text: prompt },
  ]
  return `${JSON.stringify({ type: 'user', message: { role: 'user', content } })}\n`
}

/** Run one turn on a specific account. */
// extraEnv: a credential passed as env instead of a slot's credential file —
// e.g. CLAUDE_CODE_OAUTH_TOKEN on a client install (obj 719987, agent chat).
export function runClaudeTurn(
  account: AccountSlot,
  req: BackendRequest,
  timeoutMs: number,
  extraEnv: Record<string, string> = {},
): Promise<Omit<BackendResult, 'attempts'>> {
  const startedAt = Date.now()
  const images = req.images ?? []
  const args = buildClaudeArgs(req.model, req.systemPrompt, images.length > 0)
  const env = { ...buildClaudeEnv(account.homeDir), ...extraEnv }
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
      if (st.notLoggedIn || (!st.usage && isNotLoggedInMessage(stderr))) {
        // No credential reached the CLI. Rotate (kind 'auth') but never park:
        // the seat's stored credential was not even tried.
        return fail(new BackendError('auth', `claude found no sign-in on seat ${account.id} ("Not logged in")`, account.id, emitted))
      }
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

    proc.stdin.end(buildClaudeStdin(req.prompt, images))
  })
}

/**
 * A credential that is not a pool seat, e.g. the AGENT_CHAT_CLAUDE_OAUTH_TOKEN
 * env token. Tried before (`preferTokens`) or after (`fallbackTokens`) the pool.
 * `id` is a label for logs and errors — never the value.
 */
export interface TokenCandidate {
  id: string
  token: string
}

export interface ClaudeCliBackendOptions {
  env?: NodeJS.ProcessEnv
  pick?: (filter: (a: AccountSlot) => boolean) => AccountSlot | null
  run?: typeof runClaudeTurn
  /** Seats this backend may use. Default: gatewaySlotFilter(env). */
  slotFilter?: (a: AccountSlot) => boolean
  /**
   * The env a turn on a pool seat needs to sign in. Default seatCredentialEnv:
   * a pasted setup-token seat → CLAUDE_CODE_OAUTH_TOKEN, a CLI-login seat → {}.
   */
  credentialEnv?: (seat: AccountSlot) => Record<string, string>
  preferTokens?: TokenCandidate[]
  fallbackTokens?: TokenCandidate[]
  /** Max turns attempted across seats in one request (default 3). */
  maxAttempts?: number
  timeoutMs?: number
  /** Where per-turn HOMEs are created (tests). Default os.tmpdir(). */
  homeRoot?: string
  /** Prefix for the per-turn HOME dir name. */
  homeLabel?: string
}

/**
 * A fresh, private CLI config dir for ONE token-signed turn (obj 900624). The
 * CLI rewrites `$HOME/.claude.json` and `$HOME/.claude/` on every start, so
 * concurrent turns sharing one HOME (agent chat's old fixed
 * `/tmp/cc-agent-chat-home`) race on those files. A per-turn dir means no two
 * processes ever share one. Mode 0777 so the CLI can write it after the
 * runuser hop to ccuser; it holds no credential (the token rides in the
 * process env only) and is removed when the turn ends.
 */
export function makeTurnHome(root = os.tmpdir(), label = 'cc-claude-turn'): string {
  const dir = fs.mkdtempSync(path.join(root, `${label}-`))
  try { fs.chmodSync(dir, 0o777) } catch { /* best effort */ }
  return dir
}

function removeTurnHome(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ }
}

// seat-credentials pulls in the secrets store (and the DB). Loaded on first use
// so importing this backend stays as light as before.
let seatEnvFn: ((seat: AccountSlot) => Record<string, string>) | null = null
async function defaultSeatEnv(seat: AccountSlot): Promise<Record<string, string>> {
  if (!seatEnvFn) seatEnvFn = (await import('../seat-credentials.js')).seatCredentialEnv
  return seatEnvFn(seat)
}

function tokenSlot(t: TokenCandidate): AccountSlot {
  return {
    id: t.id, label: t.id, priority: 0, homeDir: '', sessionsToday: 0, tokensToday: 0, costToday: 0,
    lastRateLimit: null, rateLimitResetsAt: null, activeSessions: [], usageLog: [],
  }
}

/**
 * Account-pool backend: pick an allowed seat, run the turn, and on a
 * rate-limit / auth / "Not logged in" failure that happened before any text
 * was streamed, rotate to the next candidate (at most `maxAttempts` turns).
 *
 * Candidate order: preferTokens → healthy pool seats (pickAccount order) →
 * fallbackTokens. Every pool seat signs in with ITS OWN credential
 * (seatCredentialEnv) — before obj 900624 a pasted setup-token seat ran with
 * no credential at all and the CLI answered "Not logged in". A token-signed
 * turn runs in its own throwaway HOME; a CLI-login seat runs in the seat's
 * HOME, where its login files live. One token value is never tried twice in
 * a request (the legacy `sandbox` seat IS SESSION_JAIL_CLAUDE_OAUTH_TOKEN).
 */
export function createClaudeCliBackend(opts: ClaudeCliBackendOptions = {}): LlmBackend {
  const pick = opts.pick ?? pickAccount
  const run = opts.run ?? runClaudeTurn
  const credEnv = async (seat: AccountSlot) => (opts.credentialEnv ? opts.credentialEnv(seat) : defaultSeatEnv(seat))
  return async req => {
    const env = opts.env ?? process.env
    const allowed = opts.slotFilter ?? gatewaySlotFilter(env)
    const timeoutMs = opts.timeoutMs ?? (Number(env.LLM_GATEWAY_TIMEOUT_MS) > 0 ? Number(env.LLM_GATEWAY_TIMEOUT_MS) : 300_000)
    const maxAttempts = opts.maxAttempts ?? 3
    const triedSeats = new Set<string>()
    const triedTokens = new Set<string>()
    let lastErr: BackendError | null = null
    let attempts = 0

    // The result, or null when the failure is one to rotate past.
    const attempt = async (account: AccountSlot, extraEnv: Record<string, string>): Promise<BackendResult | null> => {
      const token = extraEnv.CLAUDE_CODE_OAUTH_TOKEN
      if (token) {
        if (triedTokens.has(token)) return null
        triedTokens.add(token)
      }
      attempts++
      const home = token ? makeTurnHome(opts.homeRoot, opts.homeLabel) : null
      try {
        const r = await run(home ? { ...account, homeDir: home } : account, req, timeoutMs, extraEnv)
        return { ...r, attempts }
      } catch (err) {
        const be = err instanceof BackendError ? err : new BackendError('cli_error', String(err), account.id)
        lastErr = be
        if (be.emitted || (be.kind !== 'rate_limit' && be.kind !== 'auth')) throw be
        console.warn(`[claude-cli] seat ${account.id}: ${be.kind} — rotating to the next seat`)
        return null
      } finally {
        if (home) removeTurnHome(home)
      }
    }
    const tryTokens = async (list: TokenCandidate[] | undefined): Promise<BackendResult | null> => {
      for (const t of list ?? []) {
        if (attempts >= maxAttempts) break
        if (!t.token) continue
        const r = await attempt(tokenSlot(t), { CLAUDE_CODE_OAUTH_TOKEN: t.token })
        if (r) return r
      }
      return null
    }

    const preferred = await tryTokens(opts.preferTokens)
    if (preferred) return preferred
    while (attempts < maxAttempts) {
      const account = pick(a => allowed(a) && !triedSeats.has(a.id))
      if (!account) break
      triedSeats.add(account.id)
      let extraEnv: Record<string, string>
      try {
        extraEnv = await credEnv(account)
      } catch (err) {
        // Pasted credential gone from the store: skip this seat, keep going.
        lastErr = new BackendError('auth', `seat ${account.id}: ${err instanceof Error ? err.message : String(err)}`, account.id)
        continue
      }
      // Subscription only: a seat whose sign-in is an API key (the legacy
      // sandbox seat with SESSION_JAIL_ANTHROPIC_API_KEY) would bill the API.
      if (Object.keys(extraEnv).some(k => k !== 'CLAUDE_CODE_OAUTH_TOKEN')) continue
      const r = await attempt(account, extraEnv)
      if (r) return r
    }
    const fallback = await tryTokens(opts.fallbackTokens)
    if (fallback) return fallback
    throw lastErr ?? new BackendError('no_account', 'no allowed Claude account is available')
  }
}
