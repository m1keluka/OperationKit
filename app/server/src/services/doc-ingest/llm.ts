import { spawn } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { pickAccount, type AccountSlot } from '../account-router.js'
import { BackendError, buildClaudeArgs, buildClaudeEnv, runClaudeTurn } from '../llm-gateway/claude-cli-backend.js'

/**
 * The one AI call document ingest makes (obj 719936).
 *
 * A pure LLM turn: no tools, no MCP, no files. Only extracted text goes out,
 * and only to the AI provider this install was set up with. Which credential
 * is used, first match wins:
 *
 *   1. SESSION_JAIL_CLAUDE_OAUTH_TOKEN — the one Claude sign-in a client
 *      install is given (install/claude-login.sh). Runs `claude -p` with it.
 *   2. SESSION_JAIL_ANTHROPIC_API_KEY  — pay-per-use Anthropic API key.
 *   3. The account pool (account-router), the same isolated runner the LLM
 *      gateway uses. `DOC_INGEST_SLOTS` (comma list) picks the slots; default
 *      is every slot except 'a', matching the gateway.
 *
 * DOC_INGEST_MODEL overrides the model (default claude-sonnet-5).
 */
export type LlmCall = (systemPrompt: string, prompt: string) => Promise<string>

export const DEFAULT_INGEST_MODEL = 'claude-sonnet-5'

export function slotFilter(env: NodeJS.ProcessEnv = process.env): (a: AccountSlot) => boolean {
  const raw = (env.DOC_INGEST_SLOTS ?? '').trim()
  // Same default as the LLM gateway: every rotation slot except the owner's personal 'a'.
  if (!raw) return a => a.id !== 'a'
  const allow = new Set(raw.split(',').map(s => s.trim()).filter(Boolean))
  return a => allow.has(a.id)
}

export type CredentialSource = 'oauth-token' | 'api-key' | 'account-pool'

export function credentialSource(env: NodeJS.ProcessEnv = process.env): CredentialSource {
  if ((env.SESSION_JAIL_CLAUDE_OAUTH_TOKEN ?? '').trim()) return 'oauth-token'
  if ((env.SESSION_JAIL_ANTHROPIC_API_KEY ?? '').trim()) return 'api-key'
  return 'account-pool'
}

function timeoutFor(env: NodeJS.ProcessEnv): number {
  return Number(env.DOC_INGEST_TIMEOUT_MS) > 0 ? Number(env.DOC_INGEST_TIMEOUT_MS) : 600_000
}

/** `claude -p` signed in with a long-lived token, in a throwaway HOME. */
function runWithToken(token: string, model: string, systemPrompt: string, prompt: string, env: NodeJS.ProcessEnv): Promise<string> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-ingest-home-'))
  const args = buildClaudeArgs(model, systemPrompt)
    .filter(a => a !== '--include-partial-messages' && a !== '--verbose')
    .map(a => (a === 'stream-json' ? 'json' : a))
  const childEnv = { ...buildClaudeEnv(home, env), CLAUDE_CODE_OAUTH_TOKEN: token }
  return new Promise((resolve, reject) => {
    const proc = spawn('claude', args, { cwd: home, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    const done = (fn: () => void) => { clearTimeout(timer); fs.rmSync(home, { recursive: true, force: true }); fn() }
    const timer = setTimeout(() => { proc.kill('SIGTERM'); done(() => reject(new Error('the AI took too long to answer'))) }, timeoutFor(env))
    proc.stdout.on('data', d => { out += d })
    proc.stderr.on('data', d => { err += d })
    proc.on('error', e => done(() => reject(e)))
    proc.on('close', code => done(() => {
      try {
        const r = JSON.parse(out) as { result?: string; is_error?: boolean }
        if (r.is_error || typeof r.result !== 'string') return reject(new Error(r.result || 'the AI returned an error'))
        resolve(r.result)
      } catch {
        reject(new Error(`claude exited ${code}: ${(err || out).trim().slice(0, 300)}`))
      }
    }))
    proc.stdin.end(prompt)
  })
}

/** Anthropic Messages API with the install's own key. */
async function runWithApiKey(key: string, model: string, systemPrompt: string, prompt: string, env: NodeJS.ProcessEnv, fetchImpl: typeof fetch): Promise<string> {
  const res = await fetchImpl('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model, max_tokens: 16000, system: systemPrompt, messages: [{ role: 'user', content: prompt }] }),
    signal: AbortSignal.timeout(timeoutFor(env)),
  })
  const body = await res.json().catch(() => ({})) as { content?: Array<{ type: string; text?: string }>; error?: { message?: string } }
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${body.error?.message ?? 'request failed'}`)
  return (body.content ?? []).filter(c => c.type === 'text').map(c => c.text ?? '').join('')
}

async function runWithPool(model: string, systemPrompt: string, prompt: string, env: NodeJS.ProcessEnv, run: typeof runClaudeTurn, pick: typeof pickAccount): Promise<string> {
  const allowed = slotFilter(env)
  const tried = new Set<string>()
  let last: Error | null = null
  for (let attempt = 0; attempt < 3; attempt++) {
    const account = pick(a => allowed(a) && !tried.has(a.id))
    if (!account) break
    tried.add(account.id)
    try {
      return (await run(account, { model, systemPrompt, prompt }, timeoutFor(env))).text
    } catch (err) {
      last = err instanceof Error ? err : new Error(String(err))
      if (!(err instanceof BackendError) || (err.kind !== 'rate_limit' && err.kind !== 'auth')) break
    }
  }
  throw last ?? new Error('No AI account is connected. Connect a Claude account in Settings, then try again.')
}

export function createIngestLlm(opts: { env?: NodeJS.ProcessEnv; run?: typeof runClaudeTurn; pick?: typeof pickAccount; fetchImpl?: typeof fetch } = {}): LlmCall {
  return async (systemPrompt, prompt) => {
    const env = opts.env ?? process.env
    const model = (env.DOC_INGEST_MODEL ?? '').trim() || DEFAULT_INGEST_MODEL
    try {
      switch (credentialSource(env)) {
        case 'oauth-token': return await runWithToken(env.SESSION_JAIL_CLAUDE_OAUTH_TOKEN!.trim(), model, systemPrompt, prompt, env)
        case 'api-key': return await runWithApiKey(env.SESSION_JAIL_ANTHROPIC_API_KEY!.trim(), model, systemPrompt, prompt, env, opts.fetchImpl ?? fetch)
        default: return await runWithPool(model, systemPrompt, prompt, env, opts.run ?? runClaudeTurn, opts.pick ?? pickAccount)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(msg.startsWith('No AI account') ? msg : `The AI could not be reached: ${msg}`)
    }
  }
}
