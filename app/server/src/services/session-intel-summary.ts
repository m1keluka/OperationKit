/**
 * Session-intel LLM summary (Phase B) —
 * extracted from session-intel.ts (behavior frozen).
 *
 * No JSONL parse, no DB writes. extractDeterministic stays in
 * session-intel-parse.ts; processExtraction stays in session-intel-pipeline.ts.
 */
import type { Objective } from '@operationkit/shared'
import type { DeterministicIntel } from './session-intel-parse.js'

export interface LLMSummary {
  summary: string
  decisions: { decision: string; rationale: string }[]
  blockers: { description: string; severity: 'critical' | 'moderate' | 'minor' }[]
  follow_ups: { task: string; priority: 'high' | 'medium' | 'low'; context: string }[]
  outcome: 'success' | 'partial' | 'failed' | 'blocked'
}

// ── LLM Summary (Phase B — async, ~$0.01/session) ──

// Ollama endpoint — runs on the VPS host, accessible from inside the container
// via the Docker bridge network. Falls back to Anthropic API if Ollama is unreachable.
// Ollama runs on the VPS host. Container reaches it via docker0 bridge (172.17.0.1).
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://172.17.0.1:11434'
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:7b'

// Anthropic tool-use schema that FORCES a structurally-valid summary object. The
// API returns tool inputs as already-parsed JSON, so the brittle text→JSON.parse
// step (which produced "Unterminated string" / "Expected property name" errors)
// is eliminated on the primary path.
const SUMMARY_TOOL = {
  name: 'record_session_summary',
  description: 'Record the structured summary of the Claude Code session.',
  input_schema: {
    type: 'object',
    properties: {
      summary: { type: 'string', description: '2-3 sentence summary of what was accomplished' },
      decisions: {
        type: 'array',
        description: 'Architectural or design decisions made',
        items: { type: 'object', properties: { decision: { type: 'string' }, rationale: { type: 'string' } }, required: ['decision', 'rationale'] },
      },
      blockers: {
        type: 'array',
        items: { type: 'object', properties: { description: { type: 'string' }, severity: { type: 'string', enum: ['critical', 'moderate', 'minor'] } }, required: ['description', 'severity'] },
      },
      follow_ups: {
        type: 'array',
        items: { type: 'object', properties: { task: { type: 'string' }, priority: { type: 'string', enum: ['high', 'medium', 'low'] }, context: { type: 'string' } }, required: ['task', 'priority', 'context'] },
      },
      outcome: { type: 'string', enum: ['success', 'partial', 'failed', 'blocked'] },
    },
    required: ['summary', 'decisions', 'blockers', 'follow_ups', 'outcome'],
  },
} as const

const OUTCOMES = ['success', 'partial', 'failed', 'blocked'] as const
const SEVERITIES = ['critical', 'moderate', 'minor'] as const
const PRIORITIES = ['high', 'medium', 'low'] as const

function oneOf<T extends string>(allowed: readonly T[], v: unknown, fallback: T): T {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback
}

// Best-effort JSON extraction for the Ollama / text-fallback path: strips code
// fences, isolates the outermost {...}, drops trailing commas, then parses.
function parseLooseJson(raw: string): unknown | null {
  if (!raw) return null
  let s = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
  const start = s.indexOf('{')
  const end = s.lastIndexOf('}')
  if (start === -1 || end === -1 || end < start) return null
  s = s.slice(start, end + 1).replace(/,(\s*[}\]])/g, '$1')
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}

// Validate + coerce an arbitrary parsed object into a well-formed LLMSummary.
// Tolerant by design: missing or malformed fields default instead of throwing,
// so a partial model response still produces usable intel rather than being
// discarded. Returns null only when there isn't even a usable summary string.
export function coerceSummary(obj: unknown, isReview = false, isDelegator = false): LLMSummary | null {
  if (!obj || typeof obj !== 'object') return null
  const o = obj as Record<string, unknown>
  const str = (v: unknown): string => (typeof v === 'string' ? v : '')
  const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])

  const decisions = arr(o.decisions)
    .map(d => { const r = (d || {}) as Record<string, unknown>; return { decision: str(r.decision), rationale: str(r.rationale) } })
    .filter(d => d.decision)
  const blockers = arr(o.blockers)
    .map(b => { const r = (b || {}) as Record<string, unknown>; return { description: str(r.description), severity: oneOf(SEVERITIES, r.severity, 'moderate') } })
    .filter(b => b.description)
  const follow_ups = arr(o.follow_ups)
    .map(f => { const r = (f || {}) as Record<string, unknown>; return { task: str(r.task), priority: oneOf(PRIORITIES, r.priority, 'medium'), context: str(r.context) } })
    .filter(f => f.task)

  const summary = str(o.summary)
  if (!summary) return null
  const defaultOutcome = isReview || isDelegator ? 'success' : 'partial'
  return { summary, decisions, blockers, follow_ups, outcome: oneOf(OUTCOMES, o.outcome, defaultOutcome) }
}

// Build the LLM summarization prompt. Exported (pure, no I/O) so the
// verdict-grounding behavior can be regression-tested without a model call:
// for a review session the caller passes the authoritative
// `objective_reviews.verdict`, and the prompt must pin the summary to it so a
// FAILED review can never be narrated as a success (and vice-versa). See
// session-intel-verdict.test.ts.
export function buildSummaryPrompt(
  intel: DeterministicIntel,
  objective: Objective,
  isReview: boolean,
  reviewVerdict?: 'pass' | 'fail' | 'blocked' | null,
  isDelegator = false
): string {
  return `You are summarizing a Claude Code session. Given the structured data below, produce a JSON object with these fields:
- summary: 2-3 sentence summary of what was accomplished
- decisions: array of {decision, rationale} for any architectural or design decisions made
- blockers: array of {description, severity} where severity is "critical", "moderate", or "minor"
- follow_ups: array of {task, priority, context} where priority is "high", "medium", or "low"
- outcome: one of "success", "partial", "failed", "blocked"
${isReview ? `
IMPORTANT: This is an AI-REVIEW session. Its only job is to read the deliverable and
render a verdict — it is EXPECTED to create/modify zero files. Do NOT infer "work not
done", "no files created", "audit not started", or "needs access to <system>" blockers
from empty file lists or from the objective's description. Report a blocker ONLY if the
reviewer's own output explicitly states one. If the verdict is pass, blockers must be [].
Likewise set "outcome": a review session that rendered a verdict SUCCEEDED at its job —
use "outcome":"success" whenever the reviewer produced a verdict (pass OR fail), because
the review task itself completed. Only use "partial"/"blocked" if the reviewer ITSELF
reports it could not finish reviewing (e.g. hit a usage cap). The "summary" must describe
what the review concluded — NEVER say the underlying work "was not completed", "did not
execute", or cite "0 files created" as if a deliverable were missing; that is expected.
${reviewVerdict ? `
THE REVIEWER'S AUTHORITATIVE VERDICT FOR THIS SESSION WAS: "${reviewVerdict}".
Your "summary" MUST be consistent with this verdict and state it explicitly:
- verdict "fail": say the deliverable DID NOT meet the acceptance criteria and summarize
  WHY (per the reviewer's findings). Do NOT describe the underlying work as accomplished,
  provisioned, implemented, or verified-complete — a fail means it was not.
- verdict "pass": say the deliverable MET the criteria.
- verdict "blocked": say the review could not be completed and why.
Still set "outcome":"success" (the review JOB completed regardless of pass/fail), but the
summary text must never contradict the verdict above. This verdict is ground truth; if the
session digest seems to disagree, the verdict wins.
` : ''}
` : ''}
${isDelegator ? `
IMPORTANT: This is a DELEGATOR session (the objective runs in delegate_mode). Its job is to
decompose work and spawn/steer worker objectives — NOT to write app code itself. It is
EXPECTED to create/modify zero files beyond its own NOTES.md and to spawn workers via curl.
Do NOT invent "not built", "no files created", "UI mockup not created", "implementation not
begun", or "awaiting developer" blockers from an empty file list or from the objective's
description. Report a blocker ONLY if the delegator's own output explicitly states one
(e.g. an unanswered decision it is waiting on Operator for). Likewise set "outcome": use
"outcome":"success" whenever the delegator advanced its plan — spawned or iterated a worker,
recorded the registry, or handed off. Only use "partial"/"blocked" if the delegator ITSELF
reports it could not proceed. The "summary" must describe what the delegator ORCHESTRATED —
never say the underlying work "was not built" or cite "0 files created" as a missing
deliverable; that is expected for this session type.
` : ''}
Session data:
- Objective: ${objective.title}
- Description: ${objective.description}
- Files created: ${intel.filesCreated.join(', ') || 'none'}
- Files modified: ${intel.filesModified.join(', ') || 'none'}
- Commands run: ${intel.commandsRun}
- Tool calls: ${intel.toolCalls}
- Errors (${intel.errors.length}): ${intel.errors.slice(0, 5).join('; ') || 'none'}
- Exit code: ${intel.exitCode}
- Duration: ${Math.round(intel.durationMs / 1000)}s
- Skills used: ${intel.skillsUsed.join(', ') || 'none'}
- Agent personas invoked: ${intel.agentsInvoked.join(', ') || 'none'}
- Sub-agents spawned: ${intel.subagentsSpawned.join(', ') || 'none'}

Respond with ONLY valid JSON, no markdown fences.`
}

export async function generateSummary(
  intel: DeterministicIntel,
  objective: Objective,
  isReview: boolean,
  reviewVerdict?: 'pass' | 'fail' | 'blocked' | null,
  isDelegator = false
): Promise<LLMSummary | null> {
  const prompt = buildSummaryPrompt(intel, objective, isReview, reviewVerdict, isDelegator)

  // Try Ollama first (free, local)
  try {
    const res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        messages: [{ role: 'user', content: prompt }],
        stream: false,
        format: 'json', // constrain the model to emit a JSON object
        options: { temperature: 0, num_predict: 2048 },
      }),
      signal: AbortSignal.timeout(60000), // local model can be slower
    })

    if (res.ok) {
      const data = await res.json() as { message?: { content?: string } }
      const content = data.message?.content?.trim()
      if (content) {
        const parsed = coerceSummary(parseLooseJson(content), isReview, isDelegator)
        if (parsed) {
          console.log(`[session-intel] Summary via Ollama (${OLLAMA_MODEL})`)
          return parsed
        }
        console.warn('[session-intel] Ollama summary unparseable — falling back to Anthropic')
      }
    } else {
      console.warn(`[session-intel] Ollama returned ${res.status} — falling back to Anthropic`)
    }
  } catch (err) {
    console.warn(`[session-intel] Ollama unreachable — falling back to Anthropic: ${err instanceof Error ? err.message : err}`)
  }

  // Fallback: Anthropic API
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    console.error('[session-intel] No LLM available (Ollama down + no ANTHROPIC_API_KEY)')
    return null
  }

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 2048, // was 1000 — too small; truncated JSON mid-string
        temperature: 0,
        tools: [SUMMARY_TOOL],
        tool_choice: { type: 'tool', name: 'record_session_summary' },
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: AbortSignal.timeout(30000),
    })

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      console.error(`[session-intel] Anthropic API returned ${res.status}: ${body.slice(0, 300)}`)
      return null
    }

    const data = await res.json() as {
      content?: Array<{ type: string; text?: string; name?: string; input?: unknown }>
    }
    // Forced tool_use: the API returns the tool input as already-parsed JSON, so
    // there is no string parse to fail on. Fall back to text extraction only if
    // the tool block is somehow absent.
    const toolBlock = data.content?.find(b => b.type === 'tool_use' && b.name === 'record_session_summary')
    if (toolBlock?.input) {
      const parsed = coerceSummary(toolBlock.input, isReview, isDelegator)
      if (parsed) {
        console.log('[session-intel] Summary via Anthropic (Haiku, tool-use)')
        return parsed
      }
    }
    const text = data.content?.find(b => b.type === 'text')?.text
    const fallback = coerceSummary(parseLooseJson(text || ''), isReview, isDelegator)
    if (!fallback) {
      console.error('[session-intel] Anthropic summary unparseable (no valid tool_use or text JSON)')
      return null
    }
    return fallback
  } catch (err) {
    console.error('[session-intel] LLM summary failed:', err)
    return null
  }
}

