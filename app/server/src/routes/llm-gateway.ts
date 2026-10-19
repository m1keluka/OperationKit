import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { Router, type Request, type Response, type NextFunction } from 'express'
import {
  SUPPORTED_MODELS,
  DEFAULT_MODEL,
  InvalidRequestError,
  ToolEnvelopeStreamer,
  parseAssistantOutput,
  translateRequest,
  validateChatRequest,
  type OAIToolCall,
} from '../services/llm-gateway/translate.js'
import { BackendError, createClaudeCliBackend, type BackendUsage, type LlmBackend } from '../services/llm-gateway/claude-cli-backend.js'

// ── OpenAI-compatible LLM gateway: /api/llm/v1 ──
//
// Lets external apps (Twenty CRM's AI, via @ai-sdk/openai-compatible) use the
// Claude Code subscription accounts CC already manages. Auth is a single
// static bearer key, TWENTY_LLM_GATEWAY_KEY (Settings → Secrets), NOT the CC
// session/JWT auth — so this router is mounted before anything that would
// demand a CC login.
//
// Env:
//   TWENTY_LLM_GATEWAY_KEY      required bearer key (unset → 503)
//   LLM_GATEWAY_ENABLED=false   kill switch → 503
//   LLM_GATEWAY_MAX_CONCURRENCY global in-flight cap (default 3) → 429 when full
//   LLM_GATEWAY_SLOTS           comma slot allowlist (default: all but 'a')
//   LLM_GATEWAY_TIMEOUT_MS      per-turn timeout (default 300000)
//   LLM_GATEWAY_LOG_FILE        JSONL request log (default /app/data/logs/llm-gateway.jsonl; '' = off)
//
// Logging: one line per request with model/slot/tokens/latency, to stdout and
// the JSONL file (server stdout is only reachable via `docker logs`). Message
// bodies, prompts and completions are never logged.

export interface LlmGatewayDeps {
  backend?: LlmBackend
  env?: NodeJS.ProcessEnv
  log?: (line: string) => void
  /** JSONL request-log path; null disables. Defaults from LLM_GATEWAY_LOG_FILE. */
  logFile?: string | null
}

const DEFAULT_LOG_FILE = '/app/data/logs/llm-gateway.jsonl'

function appendJsonl(file: string, rec: Record<string, unknown>): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(file, JSON.stringify(rec) + '\n', { mode: 0o644 })
  } catch {
    /* logging must never fail a request */
  }
}

function oaiError(res: Response, status: number, message: string, type: string, code?: string, param?: string) {
  res.status(status).json({ error: { message, type, code: code ?? null, param: param ?? null } })
}

function keysMatch(given: string, expected: string): boolean {
  const a = crypto.createHash('sha256').update(given).digest()
  const b = crypto.createHash('sha256').update(expected).digest()
  return crypto.timingSafeEqual(a, b)
}

export function createLlmGatewayRouter(deps: LlmGatewayDeps = {}): Router {
  const router = Router()
  const env = () => deps.env ?? process.env
  const backend = deps.backend ?? createClaudeCliBackend()
  const log = deps.log ?? ((line: string) => console.log(line))
  const logFile = () => {
    if (deps.logFile !== undefined) return deps.logFile
    const f = env().LLM_GATEWAY_LOG_FILE
    return f === undefined ? DEFAULT_LOG_FILE : f || null
  }
  const record = (fields: Record<string, string | number | null | undefined>) => {
    const kv = Object.entries(fields).map(([k, v]) => `${k}=${v ?? '-'}`).join(' ')
    log(`[llm-gateway] ${kv}`)
    const f = logFile()
    if (f) appendJsonl(f, { ts: new Date().toISOString(), ...fields })
  }
  let inFlight = 0

  router.use((req: Request, res: Response, next: NextFunction) => {
    const e = env()
    if (String(e.LLM_GATEWAY_ENABLED ?? '').toLowerCase() === 'false') {
      return oaiError(res, 503, 'LLM gateway is disabled', 'service_unavailable', 'gateway_disabled')
    }
    const expected = e.TWENTY_LLM_GATEWAY_KEY
    if (!expected) return oaiError(res, 503, 'LLM gateway is not configured', 'service_unavailable', 'gateway_not_configured')
    const header = req.headers.authorization ?? ''
    const m = /^Bearer\s+(.+)$/i.exec(header)
    if (!m || !keysMatch(m[1].trim(), expected)) {
      return oaiError(res, 401, 'Invalid or missing API key', 'invalid_request_error', 'invalid_api_key')
    }
    next()
  })

  const modelObj = (id: string) => ({ id, object: 'model', created: 1767225600, owned_by: 'anthropic' })

  router.get('/models', (_req, res) => {
    res.json({ object: 'list', data: SUPPORTED_MODELS.map(modelObj) })
  })

  router.get('/models/:id', (req, res) => {
    if (!(SUPPORTED_MODELS as readonly string[]).includes(req.params.id)) {
      return oaiError(res, 404, `The model '${req.params.id}' does not exist`, 'invalid_request_error', 'model_not_found', 'model')
    }
    res.json(modelObj(req.params.id))
  })

  router.post('/chat/completions', async (req: Request, res: Response) => {
    const started = Date.now()
    const id = `chatcmpl-${crypto.randomBytes(12).toString('hex')}`
    let chat
    try {
      chat = validateChatRequest(req.body)
    } catch (err) {
      const e = err as InvalidRequestError
      return oaiError(res, 400, e.message, 'invalid_request_error', undefined, e.param)
    }
    const model = chat.model || DEFAULT_MODEL
    if (!(SUPPORTED_MODELS as readonly string[]).includes(model)) {
      return oaiError(res, 400, `Unsupported model '${model}'. Use one of: ${SUPPORTED_MODELS.join(', ')}`, 'invalid_request_error', 'model_not_found', 'model')
    }

    const capRaw = Number(env().LLM_GATEWAY_MAX_CONCURRENCY)
    const cap = Number.isFinite(capRaw) && capRaw > 0 ? capRaw : 3
    if (inFlight >= cap) {
      record({ id, model, status: 429, reason: 'concurrency', in_flight: inFlight, cap })
      res.setHeader('Retry-After', '5')
      return oaiError(res, 429, `Gateway concurrency limit (${cap}) reached; retry shortly`, 'rate_limit_error', 'concurrency_limit')
    }
    inFlight++

    const stream = chat.stream === true
    const includeUsage = chat.stream_options?.include_usage === true
    const created = Math.floor(started / 1000)
    const translated = translateRequest(chat)
    const abort = new AbortController()
    res.on('close', () => {
      if (!res.writableFinished) abort.abort()
    })

    const logLine = (fields: Record<string, string | number | null | undefined>) =>
      record({ id, model, stream: String(stream), tools: translated.toolNames.length, ...fields })

    const finishReason = (calls: OAIToolCall[], stopReason: string | null) =>
      calls.length ? 'tool_calls' : stopReason === 'max_tokens' ? 'length' : 'stop'

    try {
      if (!stream) {
        const r = await backend({ model, systemPrompt: translated.systemPrompt, prompt: translated.prompt, signal: abort.signal })
        const parsed = parseAssistantOutput(r.text, translated.toolNames)
        const message: Record<string, unknown> = { role: 'assistant', content: parsed.content }
        if (parsed.toolCalls.length) message.tool_calls = parsed.toolCalls
        // The serving slot letter (never a credential) so callers can attribute a
        // response to an account without access to the server log.
        res.setHeader('X-CC-Gateway-Slot', r.slot)
        res.setHeader('X-CC-Gateway-Latency-Ms', String(Date.now() - started))
        res.json({
          id,
          object: 'chat.completion',
          created,
          model,
          system_fingerprint: `cc-slot-${r.slot}`,
          choices: [{ index: 0, message, logprobs: null, finish_reason: finishReason(parsed.toolCalls, r.stopReason) }],
          usage: r.usage,
        })
        logLine({ status: 200, slot: r.slot, attempts: r.attempts, prompt_tokens: r.usage.prompt_tokens, completion_tokens: r.usage.completion_tokens, tool_calls: parsed.toolCalls.length, ttft_ms: r.ttftMs, total_ms: Date.now() - started })
        return
      }

      // Streaming: headers go out only once the first token (or the result)
      // arrives, so a backend failure before that can still be a clean JSON error.
      const streamer = new ToolEnvelopeStreamer(translated.toolNames)
      let headersSent = false
      const send = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`)
      const chunk = (delta: Record<string, unknown>, finish: string | null = null, usage?: BackendUsage) => {
        const c: Record<string, unknown> = { id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, logprobs: null, finish_reason: finish }] }
        if (usage) c.usage = usage
        return c
      }
      const openStream = () => {
        if (headersSent) return
        headersSent = true
        res.status(200)
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
        res.setHeader('Cache-Control', 'no-cache, no-transform')
        res.setHeader('Connection', 'keep-alive')
        res.setHeader('X-Accel-Buffering', 'no')
        res.flushHeaders()
        send(chunk({ role: 'assistant', content: '' }))
      }

      let r
      try {
        r = await backend({
          model,
          systemPrompt: translated.systemPrompt,
          prompt: translated.prompt,
          signal: abort.signal,
          onText: delta => {
            openStream()
            const out = streamer.push(delta)
            if (out) send(chunk({ content: out }))
          },
        })
      } catch (err) {
        if (!headersSent) throw err
        const be = err instanceof BackendError ? err : null
        logLine({ status: 'stream_error', slot: be?.slot, error: be?.kind ?? 'unknown', total_ms: Date.now() - started })
        send({ error: { message: 'Upstream model error', type: 'server_error', code: be?.kind ?? null } })
        res.write('data: [DONE]\n\n')
        res.end()
        return
      }
      openStream()
      const tail = streamer.finish()
      if (tail.text) send(chunk({ content: tail.text }))
      tail.toolCalls.forEach((call, index) => {
        send(chunk({ tool_calls: [{ index, id: call.id, type: 'function', function: { name: call.function.name, arguments: '' } }] }))
        send(chunk({ tool_calls: [{ index, function: { arguments: call.function.arguments } }] }))
      })
      send({ ...chunk({}, finishReason(tail.toolCalls, r.stopReason), r.usage), system_fingerprint: `cc-slot-${r.slot}` })
      if (includeUsage) send({ id, object: 'chat.completion.chunk', created, model, choices: [], usage: r.usage })
      res.write('data: [DONE]\n\n')
      res.end()
      logLine({ status: 200, slot: r.slot, attempts: r.attempts, prompt_tokens: r.usage.prompt_tokens, completion_tokens: r.usage.completion_tokens, tool_calls: tail.toolCalls.length, ttft_ms: r.ttftMs, total_ms: Date.now() - started })
    } catch (err) {
      const be = err instanceof BackendError ? err : null
      logLine({ status: be?.kind === 'aborted' ? 499 : be?.kind === 'no_account' || be?.kind === 'rate_limit' ? 429 : 502, slot: be?.slot, error: be?.kind ?? 'unknown', total_ms: Date.now() - started })
      if (res.headersSent) return
      if (be?.kind === 'no_account' || be?.kind === 'rate_limit') {
        res.setHeader('Retry-After', '60')
        return oaiError(res, 429, 'All allowed Claude accounts are rate-limited or unavailable', 'rate_limit_error', be.kind)
      }
      if (be?.kind === 'timeout') return oaiError(res, 504, 'Upstream model timed out', 'server_error', 'timeout')
      return oaiError(res, 502, 'Upstream model error', 'server_error', be?.kind ?? 'upstream_error')
    } finally {
      inFlight--
    }
  })

  return router
}
