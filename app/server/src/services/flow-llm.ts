/**
 * `llm` node executor (obj 900639, card B3 of docs/design/WORKFLOWS.md §3.2 / §4.4).
 *
 * One ATTEMPT of an `llm` node = up to `max_iterations` model turns (default 1,
 * cap 8) through the server-side model path (`services/llm-gateway`, the
 * `LlmBackend` contract of claude-cli-backend.ts — the engine is handed one,
 * tests hand it a stub). Each turn the model either:
 *
 *   - answers: the reply is parsed as JSON and checked against `output_schema`
 *     (lib/flow-json-schema.ts). Valid → that value is the step output.
 *     Invalid → if turns remain, the model is told exactly what was wrong and
 *     asked again; on the last turn the attempt fails with the typed, RETRYABLE
 *     error `llm_output_invalid` and the engine's normal per-node `retry`
 *     (default 3 attempts, durable backoff) takes over. When attempts run out
 *     the run fails with that same typed error.
 *   - or (only when the node lists `tools[]`) calls one of those READ-ONLY
 *     Tools: `{"tool_call": {"tool": "<slug>", "input": {…}}}`. The result is
 *     fed into the next turn. A tool call on the last turn ends the attempt with
 *     `llm_max_iterations` (retryable).
 *
 * Spend: every turn's `costUsd` is reported through `onCost` as soon as the
 * turn returns, so the engine can write it to the run ledger durably, and
 * `beforeTurn` re-checks the run budget before turns 2..N.
 *
 * Non-retryable up front: an unsupported `model`, or an `output_schema` that
 * uses keywords the checker does not implement (refused rather than
 * silently under-checked).
 */
import type { LlmNode } from '../../../shared/flow/types.js'
import type { BackendResult, LlmBackend } from './llm-gateway/claude-cli-backend.js'
import { DEFAULT_MODEL, SUPPORTED_MODELS } from './llm-gateway/translate.js'
import { extractJson, unsupportedSchemaKeywords, validateAgainstSchema, type SchemaIssue } from '../lib/flow-json-schema.js'

export const LLM_DEFAULTS = {
  maxIterations: 1,
  maxIterationsCap: 8,
  timeoutMs: 120_000,
  /** Characters of one tool result fed back into the next turn. */
  toolResultChars: 8_000,
}

/** Problem-Details-shaped error (same shape as flow-engine's FlowProblem). */
export interface LlmProblem {
  type: string
  title: string
  detail?: string
  node_id?: string
  retryable?: boolean
  [ext: string]: unknown
}

export interface LlmAttemptArgs {
  node: LlmNode
  /** `node.prompt` with its `{{ … }}` references already resolved. */
  prompt: string
  backend: LlmBackend
  signal: AbortSignal
  /** Runs one read-only Tool from `node.tools` for the tool loop. Throws on refusal/failure. */
  runTool?: (slug: string, input: unknown) => Promise<unknown>
  /** Called with each turn's cost as soon as it is known. May throw (lease lost) to stop the attempt. */
  onCost?: (usd: number) => void
  /** Called before turns 2..N; a returned problem stops the attempt (budget). */
  beforeTurn?: () => LlmProblem | null
}

export type LlmAttemptResult =
  | { ok: true; output: unknown; turns: number; costUsd: number; model: string }
  | { ok: false; error: LlmProblem; turns: number; costUsd: number; model: string | null }

/** `default` / omitted → the gateway default; otherwise must be a model the gateway serves. */
export function resolveLlmModel(model: string | undefined): string | null {
  if (!model || model === 'default') return DEFAULT_MODEL
  return (SUPPORTED_MODELS as readonly string[]).includes(model) ? model : null
}

export function llmMaxIterations(node: Pick<LlmNode, 'max_iterations'>): number {
  const n = node.max_iterations ?? LLM_DEFAULTS.maxIterations
  return Math.min(Math.max(1, Math.floor(n)), LLM_DEFAULTS.maxIterationsCap)
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const describeIssues = (issues: SchemaIssue[]) => issues.map((i) => `${i.path}: ${i.message}`).join('; ')

export function buildLlmSystemPrompt(node: LlmNode, maxTurns: number): string {
  const schema = JSON.stringify(node.output_schema)
  const tools = node.tools ?? []
  const lines = [
    `You are one step ("${node.id}") of an automated workflow. Your reply is read by a program, not a person.`,
    'Reply with ONE JSON value and nothing else: no prose, no explanation, no markdown fence.',
  ]
  if (tools.length === 0) {
    lines.push('The JSON value must satisfy this JSON Schema:', schema)
  } else {
    lines.push(
      'Reply with exactly one of these two JSON objects:',
      `  {"tool_call": {"tool": "<one of: ${tools.join(', ')}>", "input": { ... }}}  — call a read-only tool; its result comes back in the next turn`,
      '  {"output": <value>}  — your final answer',
      'The final answer <value> must satisfy this JSON Schema:',
      schema,
      `You have at most ${maxTurns} turn(s) in total; your last turn must be a final answer.`,
    )
  }
  return lines.join('\n')
}

interface TurnNote { reply: string; feedback: string }

function buildTurnPrompt(base: string, history: TurnNote[]): string {
  if (history.length === 0) return base
  const parts = [base, '', '--- Earlier turns of this step ---']
  history.forEach((h, i) => {
    parts.push(`Turn ${i + 1}, you replied:`, h.reply.slice(0, 4_000), h.feedback)
  })
  parts.push('', 'Reply now, following the same rules.')
  return parts.join('\n')
}

function backendKind(err: unknown): string {
  const k = (err as { kind?: unknown } | null)?.kind
  return typeof k === 'string' ? k : 'cli_error'
}

/** Run ONE attempt of an llm node. Never throws, except what `onCost` throws and an abort. */
export async function runLlmAttempt(args: LlmAttemptArgs): Promise<LlmAttemptResult> {
  const { node, backend, signal } = args
  const model = resolveLlmModel(node.model)
  if (!model) {
    return {
      ok: false, turns: 0, costUsd: 0, model: null,
      error: {
        type: 'llm_model_unsupported', title: `model "${node.model}" is not available for llm nodes`,
        detail: `Use "default" or one of: ${SUPPORTED_MODELS.join(', ')}`, node_id: node.id, retryable: false,
      },
    }
  }
  const unsupported = unsupportedSchemaKeywords(node.output_schema)
  if (unsupported.length) {
    return {
      ok: false, turns: 0, costUsd: 0, model,
      error: {
        type: 'llm_output_schema_unsupported', title: `output_schema of "${node.id}" uses keywords the engine cannot check: ${unsupported.join(', ')}`,
        node_id: node.id, retryable: false,
      },
    }
  }
  const maxTurns = llmMaxIterations(node)
  const tools = node.tools ?? []
  const systemPrompt = buildLlmSystemPrompt(node, maxTurns)
  const history: TurnNote[] = []
  let cost = 0
  let lastFailure: LlmProblem | null = null

  for (let turn = 1; turn <= maxTurns; turn++) {
    if (turn > 1) {
      const stop = args.beforeTurn?.()
      if (stop) return { ok: false, error: stop, turns: turn - 1, costUsd: cost, model }
    }
    let r: BackendResult
    try {
      r = await backend({ model, systemPrompt, prompt: buildTurnPrompt(args.prompt, history), signal })
    } catch (err) {
      if (signal.aborted) throw err
      return {
        ok: false, turns: turn, costUsd: cost, model,
        error: {
          type: 'llm_backend_error', title: `model call for "${node.id}" failed (${backendKind(err)})`,
          detail: err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500), node_id: node.id, retryable: true,
        },
      }
    }
    const turnCost = Number.isFinite(r.costUsd) && r.costUsd > 0 ? r.costUsd : 0
    cost += turnCost
    if (turnCost > 0) args.onCost?.(turnCost)

    const parsed = extractJson(r.text)
    let candidate: unknown
    let hasCandidate = false
    let feedback: string

    if (tools.length > 0 && isObj(parsed) && 'tool_call' in parsed) {
      const call = parsed.tool_call as { tool?: unknown; input?: unknown } | null
      const slug = isObj(call) && typeof call.tool === 'string' ? call.tool : null
      if (turn === maxTurns) {
        lastFailure = {
          type: 'llm_max_iterations', title: `"${node.id}" used all ${maxTurns} turn(s) without a final answer`,
          detail: 'The last turn was a tool call. Raise max_iterations (cap 8) or simplify the prompt.', node_id: node.id, retryable: true,
        }
        break
      }
      if (!slug || !tools.includes(slug)) {
        feedback = `That tool call was refused: "${String(slug)}" is not one of the tools you may use (${tools.join(', ')}).`
      } else if (!args.runTool) {
        feedback = `That tool call was refused: tools are not available to this step.`
      } else {
        try {
          const out = await args.runTool(slug, isObj(call) ? call.input ?? {} : {})
          const text = JSON.stringify(out ?? null) ?? 'null'
          feedback = `Tool "${slug}" returned: ${text.length > LLM_DEFAULTS.toolResultChars ? `${text.slice(0, LLM_DEFAULTS.toolResultChars)}…(truncated)` : text}`
        } catch (err) {
          if (signal.aborted) throw err
          feedback = `Tool "${slug}" failed: ${err instanceof Error ? err.message : String(err)}`
        }
      }
      history.push({ reply: r.text, feedback })
      continue
    }

    if (tools.length > 0) {
      if (isObj(parsed) && 'output' in parsed) { candidate = parsed.output; hasCandidate = true }
    } else if (parsed !== undefined) {
      candidate = parsed; hasCandidate = true
    }
    const issues: SchemaIssue[] = hasCandidate
      ? validateAgainstSchema(candidate, node.output_schema)
      : [{ path: '$', message: tools.length > 0 ? 'reply was not {"tool_call": …} or {"output": …} JSON' : 'reply is not JSON' }]
    if (issues.length === 0) return { ok: true, output: candidate, turns: turn, costUsd: cost, model }

    lastFailure = {
      type: 'llm_output_invalid',
      title: `output of "${node.id}" does not match output_schema`,
      detail: describeIssues(issues).slice(0, 1_000),
      node_id: node.id,
      retryable: true,
      issues: issues.slice(0, 10),
    }
    history.push({ reply: r.text, feedback: `That reply did not match the schema: ${describeIssues(issues)}. Correct it.` })
  }
  return { ok: false, error: lastFailure ?? { type: 'llm_output_invalid', title: `no valid output from "${node.id}"`, node_id: node.id, retryable: true }, turns: maxTurns, costUsd: cost, model }
}
