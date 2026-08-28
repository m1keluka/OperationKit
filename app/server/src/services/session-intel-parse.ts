/**
 * Deterministic JSONL parser for session intel (Phase A, $0) —
 * extracted from session-intel.ts (behavior frozen).
 *
 * No LLM, no DB writes. The extraction queue stays on the facade/pipeline.
 */
import fs from 'fs'
import { easternDayKey } from '../lib/eastern-day.js'

export interface DeterministicIntel {
  filesCreated: string[]
  filesModified: string[]
  commandsRun: number
  toolCalls: number
  errors: string[]
  exitCode: number | null
  totalTokens: number
  totalCost: number
  startedAt: string
  endedAt: string
  durationMs: number
  skillsUsed: string[]
  /** Persona slugs read via `agents/<slug>.md` (routing-table persona adoption). */
  agentsInvoked: string[]
  /** Sub-agent worker types spawned via the `Agent`/`Task` tool. */
  subagentsSpawned: string[]
  modelUsage: Record<string, { tokens: number; cost_usd: number }>
  /** Per-(Eastern day, model) cost/token split; sums reconcile to totalCost. */
  dailyUsage: Array<{ day: string; model: string; cost_usd: number; tokens: number }>
  /**
   * True when the session's TERMINAL `result` event is a Claude API 429
   * (account usage limit / "session limit" / monthly spend limit / transient
   * server rate-limit). Such a transcript is TRUNCATED — the summarizer must
   * NOT be asked to infer a content outcome from it, or it fabricates a
   * "deliverable missing / produced no output" reason. See known-gotchas.md
   * ("session_intel fabricates … when a session is 429-TRUNCATED").
   */
  truncatedByUsageLimit: boolean
}

// ── Deterministic Parser (Phase A — $0 cost) ──

export async function extractDeterministic(jsonlPath: string): Promise<DeterministicIntel> {
  const filesCreated = new Set<string>()
  const filesModified = new Set<string>()
  const skillsUsed = new Set<string>()
  const agentsInvoked = new Set<string>()
  const subagentsSpawned = new Set<string>()
  const errors: string[] = []
  let commandsRun = 0
  let toolCalls = 0
  let exitCode: number | null = null
  let totalTokens = 0
  let totalCost = 0
  let startedAt = ''
  let endedAt = ''
  let durationMs = 0
  let lastTs = ''
  // Set/cleared on every `result` event so the FINAL value reflects the
  // terminal turn only — a transient 429 mid-run that later recovered to a
  // clean result must NOT flag the session as truncated.
  let truncatedByUsageLimit = false
  const modelUsage: Record<string, { tokens: number; cost_usd: number }> = {}
  // Per-turn cost/tokens bucketed by the Eastern day of the turn's timestamp.
  const daily = new Map<string, { cost_usd: number; tokens: number }>()
  const bumpDaily = (day: string, model: string, cost: number, tokens: number) => {
    const k = `${day}|${model}`
    const a = daily.get(k) ?? { cost_usd: 0, tokens: 0 }
    a.cost_usd += cost; a.tokens += tokens; daily.set(k, a)
  }

  let content: string
  try {
    content = fs.readFileSync(jsonlPath, 'utf-8')
  } catch {
    return {
      filesCreated: [], filesModified: [], commandsRun: 0, toolCalls: 0,
      errors: ['Failed to read JSONL file'], exitCode: null,
      totalTokens: 0, totalCost: 0, startedAt: '', endedAt: '',
      durationMs: 0, skillsUsed: [], agentsInvoked: [], subagentsSpawned: [],
      modelUsage: {}, dailyUsage: [], truncatedByUsageLimit: false,
    }
  }

  const lines = content.trim().split('\n')

  // Large transcripts run to tens of MB (up to ~55MB / 100k+ lines). Parsing one
  // synchronously stalls the single-threaded event loop for seconds and blackholes
  // HTTP (2026-08-13). Yield to the loop every YIELD_LINES so pending I/O — new
  // HTTP connections included — is serviced between batches.
  const YIELD_LINES = 5000
  let lineNo = 0
  for (const line of lines) {
    if (++lineNo % YIELD_LINES === 0) await new Promise<void>((resolve) => setImmediate(resolve))
    const trimmed = line.trim()
    if (!trimmed) continue

    let event: Record<string, unknown>
    try {
      event = JSON.parse(trimmed)
    } catch {
      continue
    }

    // Track timestamps
    const ts = (event.timestamp as string) || ''
    if (ts && !startedAt) startedAt = ts
    if (ts) { endedAt = ts; lastTs = ts }

    // Parse assistant messages for tool_use blocks
    if (event.type === 'assistant' && event.message) {
      const msg = event.message as { content?: Array<Record<string, unknown>> }
      if (msg.content) {
        for (const block of msg.content) {
          if (block.type === 'tool_use') {
            toolCalls++
            const name = block.name as string
            const input = (block.input || {}) as Record<string, unknown>

            switch (name) {
              case 'Write':
                if (input.file_path) filesCreated.add(input.file_path as string)
                break
              case 'Edit':
                if (input.file_path) filesModified.add(input.file_path as string)
                break
              case 'Bash':
                commandsRun++
                break
              case 'Read': {
                // Detect skill + persona usage from Read calls. Skills are
                // `skills/<x>/SKILL.md`; personas are adopted via the routing
                // table by reading `agents/<slug>.md`.
                const fp = input.file_path as string
                if (fp) {
                  const skillMatch = fp.match(/skills\/([^/]+)\/SKILL\.md/)
                  if (skillMatch) skillsUsed.add(skillMatch[1])
                  const agentMatch = fp.match(/\/agents\/([^/]+)\.md$/)
                  if (agentMatch) agentsInvoked.add(agentMatch[1])
                }
                break
              }
              case 'Task':
              case 'Agent': {
                // Sub-agent spawn. `subagent_type` is the worker kind
                // (Explore, general-purpose, qa-reviewer, …); default unset
                // spawns to 'general-purpose' to match the harness default.
                const t = (input.subagent_type as string) || 'general-purpose'
                if (t) subagentsSpawned.add(t)
                break
              }
            }
          }
        }
      }
    }

    // Collect errors
    if (event.type === 'error') {
      const text = (event.text || event.error || '') as string
      if (text) errors.push(text.slice(0, 500))
    }

    // Sum across all `result` events. Stream-json emits one per agent turn,
    // each carrying that turn's own usage/cost — they are NOT cumulative.
    if (event.type === 'result') {
      exitCode = event.subtype === 'error' ? 1 : 0

      // A Claude API 429 kills the run mid-stream and hands the summarizer a
      // TRUNCATED transcript. Detect it here so downstream can short-circuit
      // instead of inventing a content reason. Assigned (not OR-ed) each
      // result event so only the TERMINAL turn's status survives.
      const resultText = String((event.result as string) ?? (event.error as string) ?? '')
      truncatedByUsageLimit =
        event.api_error_status === 429 ||
        /hit your (session|usage) limit|monthly spend limit|resets \d/i.test(resultText)

      const usage = (event.usage as Record<string, unknown> | undefined) || {}
      const turnTokens =
        ((usage.input_tokens as number) || 0) +
        ((usage.output_tokens as number) || 0) +
        ((usage.cache_read_input_tokens as number) || 0) +
        ((usage.cache_creation_input_tokens as number) || 0)
      const turnCost = (event.total_cost_usd as number) || 0
      totalTokens += turnTokens
      totalCost += turnCost
      durationMs = (event.duration_ms as number) || 0

      // Attribute this turn to the Eastern day of the most recent timestamped
      // event (result events carry no timestamp; user/followup/prompt do).
      const day = easternDayKey(lastTs || startedAt || new Date())

      // Per-model breakdown — same per-turn semantics as usage/total_cost_usd.
      const mu = event.modelUsage as Record<string, Record<string, unknown>> | undefined
      if (mu && Object.keys(mu).length > 0) {
        for (const [model, u] of Object.entries(mu)) {
          const mTokens =
            ((u.inputTokens as number) || 0) +
            ((u.outputTokens as number) || 0) +
            ((u.cacheReadInputTokens as number) || 0) +
            ((u.cacheCreationInputTokens as number) || 0)
          const mCost = (u.costUSD as number) || 0
          const agg = modelUsage[model] ?? { tokens: 0, cost_usd: 0 }
          agg.tokens += mTokens
          agg.cost_usd += mCost
          modelUsage[model] = agg
          bumpDaily(day, model, mCost, mTokens)
        }
      } else {
        // No per-model breakdown on this turn — bucket the total so daily sums
        // still reconcile to total_cost_usd.
        bumpDaily(day, 'unknown', turnCost, turnTokens)
      }
    }

    // Codex engine: one `turn.completed` per turn carrying per-turn usage.
    // cached_input_tokens / reasoning_output_tokens are subsets of input/output
    // — don't double-count. Cost stays 0 (ChatGPT subscription, not API billing).
    if (event.type === 'turn.completed' && event.usage) {
      const usage = event.usage as Record<string, unknown>
      const turnTokens =
        ((usage.input_tokens as number) || 0) +
        ((usage.output_tokens as number) || 0)
      totalTokens += turnTokens
      const agg = modelUsage['codex'] ?? { tokens: 0, cost_usd: 0 }
      agg.tokens += turnTokens
      modelUsage['codex'] = agg
      bumpDaily(easternDayKey(lastTs || startedAt || new Date()), 'codex', 0, turnTokens)
      exitCode = 0
    }
  }

  // Remove files that were created then edited (they're just created)
  for (const f of filesCreated) {
    filesModified.delete(f)
  }

  // Calculate duration from timestamps if not in result
  if (!durationMs && startedAt && endedAt) {
    durationMs = new Date(endedAt).getTime() - new Date(startedAt).getTime()
  }

  // result.usage only covers the main thread — subagent/sidechain usage is
  // excluded (verified ~2.4x undercount). modelUsage is authoritative.
  const modelTokens = Object.values(modelUsage).reduce((s, m) => s + m.tokens, 0)
  if (modelTokens > 0) totalTokens = modelTokens

  return {
    filesCreated: Array.from(filesCreated),
    filesModified: Array.from(filesModified),
    commandsRun,
    toolCalls,
    errors: errors.slice(0, 20), // cap at 20 errors
    exitCode,
    totalTokens,
    totalCost,
    startedAt,
    endedAt,
    durationMs,
    skillsUsed: Array.from(skillsUsed),
    agentsInvoked: Array.from(agentsInvoked),
    subagentsSpawned: Array.from(subagentsSpawned),
    modelUsage,
    dailyUsage: [...daily.entries()].map(([k, v]) => {
      const sp = k.indexOf('|')
      return { day: k.slice(0, sp), model: k.slice(sp + 1), cost_usd: v.cost_usd, tokens: v.tokens }
    }),
    truncatedByUsageLimit,
  }
}

