/**
 * Prompt-builder objective-history and compaction —
 * extracted from prompt-builder.ts (behavior frozen).
 *
 * No prompt assembly. buildPrompt stays on the prompt-builder.ts facade.
 */
import fs from 'fs'
import path from 'path'
import { getDb } from '../db/index.js'
import { callHaikuSummarizer } from './mentor-context.js'
import { TRANSCRIPT_DIR } from '../config.js'
import {
  COMPACTION_SESSION_SENTINEL,
  MAX_OBJECTIVE_HISTORY_CHARS,
  OBJ_COMPACTION_TAIL_TURNS,
  OBJ_COMPACTION_THRESHOLD,
  type ObjectiveTurn,
} from './prompt-builder-workdir.js'

export function extractObjectiveTurns(objectiveId: number): ObjectiveTurn[] {
  try {
    const files = fs.readdirSync(TRANSCRIPT_DIR)
      .filter(f => f.startsWith(`cc-${objectiveId}-`) && f.endsWith('.jsonl'))
      .sort()
    const turns: ObjectiveTurn[] = []
    for (const file of files) {
      const content = fs.readFileSync(path.join(TRANSCRIPT_DIR, file), 'utf-8')
      for (const line of content.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed) continue
        // Fast pre-filter: only JSON-parse lines that could contain turns.
        // Skips tool_use, tool_result, system, error events (vast majority of
        // lines in long sessions) without the cost of JSON.parse.
        //
        // Spawn-prompt events (`type: "prompt"`) are the orchestrator's
        // buildPrompt dump, written at session start. Flatten prepends a FRESH
        // buildPrompt, so keeping those events in history double-counted the
        // largest payload — worst on the account-rotate path (limit → flatten
        // onto a fresh account). Skip them here; follow-ups + assistant text
        // are the actual conversation.
        if (!trimmed.includes('"followup"') && !trimmed.includes('"assistant"')) continue
        try {
          const event = JSON.parse(trimmed)
          if (event.type === 'followup' && event.text) {
            turns.push({ role: 'user', text: event.text })
          } else if (event.type === 'assistant' && event.message?.content) {
            const text = (event.message.content as Array<{ type: string; text?: string }>)
              .filter(b => b.type === 'text' && b.text)
              .map(b => b.text!)
              .join('')
            if (text) turns.push({ role: 'assistant', text })
          }
        } catch {}
      }
    }
    return turns
  } catch {
    return []
  }
}

export function formatObjectiveTurns(turns: ObjectiveTurn[]): string {
  return turns.map(t => (t.role === 'user' ? `[Instruction]: ${t.text}` : `[Agent]: ${t.text}`)).join('\n\n')
}

/**
 * Assemble the history-flattening follow-up prompt (the path taken when
 * `claude --resume` cannot pin the original account/transcript).
 *
 * `basePrompt` is already a full `buildPrompt` / `buildPlannerPrompt`, which
 * includes `buildContext`. Do NOT append context again — that was a token leak
 * on every flatten (prod: ~104 flattens / 48h, almost all account-rotates).
 */
export function assembleFlattenedFollowUpPrompt(
  basePrompt: string,
  priorHistory: string,
  message: string,
): string {
  return (
    basePrompt
    + (priorHistory
      ? '\n\n## Prior Session Context\n\nThe following is the full conversation history from prior sessions on this objective. Continue from where it left off.\n\n<prior_conversation>\n' + priorHistory + '\n</prior_conversation>'
      : '')
    + '\n\n## Follow-up Instruction\n\n'
    + message
  )
}

/** Build full conversation history across all prior sessions for an objective */
export function buildObjectiveHistory(objectiveId: number): string {
  const turns = extractObjectiveTurns(objectiveId)
  if (turns.length === 0) return ''

  if (turns.length >= OBJ_COMPACTION_THRESHOLD) {
    try {
      const row = getDb()
        .prepare(
          `SELECT content FROM objective_learnings
           WHERE objective_id = ? AND session_id = ? AND task_id IS NULL
           ORDER BY created_at DESC LIMIT 1`
        )
        .get(objectiveId, COMPACTION_SESSION_SENTINEL) as { content: string } | undefined
      if (row?.content) {
        const tail = turns.slice(-OBJ_COMPACTION_TAIL_TURNS)
        const tailText = formatObjectiveTurns(tail)
        const summarizedCount = turns.length - OBJ_COMPACTION_TAIL_TURNS
        return `[Conversation summary — ${summarizedCount} earlier turns]\n${row.content}\n\n[Recent conversation]\n${tailText}`
      }
    } catch {}
    // No summary yet — fall back to tail-truncation until next session end generates one
  }

  let history = formatObjectiveTurns(turns)
  if (history.length > MAX_OBJECTIVE_HISTORY_CHARS) {
    history = '…[earlier conversation truncated]\n\n' + history.slice(history.length - MAX_OBJECTIVE_HISTORY_CHARS)
  }
  return history
}

export async function refreshObjectiveSummary(objectiveId: number): Promise<void> {
  const turns = extractObjectiveTurns(objectiveId)
  if (turns.length < OBJ_COMPACTION_THRESHOLD) return

  const turnsToSummarize = turns.slice(0, turns.length - OBJ_COMPACTION_TAIL_TURNS)
  const conversationText = formatObjectiveTurns(turnsToSummarize)

  const prompt = `You are summarizing a conversation between an operator (Instruction) and an AI agent (Agent) for context injection into future sessions.

Produce a 300-500 word summary covering:
- Key decisions and architectural choices made
- Work completed and work remaining
- Open questions or blockers
- Important context for continuing the objective

Write in third person. Be factual and dense — this summary replaces the full early conversation.

Conversation to summarize:
${conversationText}`

  const summary = await callHaikuSummarizer(prompt)
  if (!summary) return

  try {
    const db = getDb()
    // Remove prior compaction summary for this objective (replace pattern)
    db.prepare(
      `DELETE FROM objective_learnings WHERE objective_id = ? AND session_id = ? AND task_id IS NULL`
    ).run(objectiveId, COMPACTION_SESSION_SENTINEL)
    db.prepare(
      `INSERT INTO objective_learnings (objective_id, session_id, content, learning_type)
       VALUES (?, ?, ?, 'summary')`
    ).run(objectiveId, COMPACTION_SESSION_SENTINEL, summary)
    console.log(`[session-manager] Compaction summary refreshed for objective ${objectiveId} (${turns.length} turns)`)
  } catch (err) {
    console.warn(`[session-manager] Failed to store compaction summary for objective ${objectiveId}:`, err)
  }
}

