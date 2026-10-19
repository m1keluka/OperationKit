import fs from 'fs'
import path from 'path'
import type { SessionMessage } from '@operationkit/shared'
import { TRANSCRIPT_DIR } from '../config.js'
import { evictTimelineCache } from './thread-timeline.js'

// ── Helpers ──

/** Summarize tool input to a short string */
function summarizeToolInput(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case 'Bash':
    case 'run_terminal_command':
      return String(input.command || '').slice(0, 200)
    case 'Read':
    case 'read_file':
      return String(input.file_path || input.target_file || '')
    case 'Write':
      return String(input.file_path || '')
    case 'Edit':
      return String(input.file_path || '')
    case 'Glob':
      return String(input.pattern || '')
    case 'Grep':
      return `${input.pattern || ''} ${input.path || ''}`.trim()
    default:
      // Generic: show first string value
      for (const v of Object.values(input)) {
        if (typeof v === 'string' && v.length > 0) return v.slice(0, 150)
      }
      return JSON.stringify(input).slice(0, 150)
  }
}

/** Find the last message that is an OPEN streaming assistant message
 *  (`type:'assistant'` + `streaming===true`). Returns -1 if none. Used to
 *  coalesce token-by-token `stream_event` deltas into one live-growing message
 *  across incremental reads (the streaming state lives on the accumulator, not
 *  a local). */
function findOpenStreamingIdx(messages: SessionMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.type === 'assistant' && m.streaming === true) return i
    // A finalized assistant / tool / user / result message before any open
    // streaming one means there is no currently-open streaming message.
    if (m.type === 'assistant' && m.streaming !== true) return -1
  }
  return -1
}

/**
 * Handle an `--include-partial-messages` `stream_event` by mutating the message
 * accumulator in place (typewriter streaming). Returns true if the line was a
 * stream_event (handled here), false otherwise (caller falls through to the
 * standard per-message parser).
 *
 * Only PROSE (assistant text) is coalesced; tool input (`input_json_delta`) and
 * `thinking_delta` are intentionally ignored — tools/thinking don't stream.
 */
function handleStreamEvent(event: Record<string, unknown>, messages: SessionMessage[], timestamp: string): boolean {
  if (event.type !== 'stream_event') return false
  const inner = event.event as Record<string, unknown> | undefined
  if (!inner || typeof inner.type !== 'string') return true // stream_event, nothing to render
  const t = inner.type

  if (t === 'content_block_start') {
    const block = inner.content_block as Record<string, unknown> | undefined
    if (block?.type === 'text') {
      // Open a streaming assistant message if one isn't already open at the tail.
      if (findOpenStreamingIdx(messages) === -1) {
        messages.push({ type: 'assistant', text: '', streaming: true, timestamp })
      }
    }
    // tool_use / thinking block starts: ignore (not streamed as prose).
    return true
  }

  if (t === 'content_block_delta') {
    const delta = inner.delta as Record<string, unknown> | undefined
    if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
      let idx = findOpenStreamingIdx(messages)
      if (idx === -1) {
        // Defensive: a delta arrived with no open streaming message — open one.
        messages.push({ type: 'assistant', text: '', streaming: true, timestamp })
        idx = messages.length - 1
      }
      messages[idx].text = (messages[idx].text || '') + delta.text
    }
    // input_json_delta / thinking_delta: ignore.
    return true
  }

  // content_block_stop / message_start / message_delta / message_stop: nothing
  // to render. Leave the streamed text in place (a message may have multiple
  // blocks); finalization happens on the complete `assistant` event.
  return true
}

function grokToolOutputText(event: Record<string, unknown>): string {
  const content = event.content
  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const block of content) {
      const inner = (block as { content?: { type?: string; text?: string } | string })?.content
      if (inner && typeof inner === 'object' && typeof inner.text === 'string') parts.push(inner.text)
      else if (typeof inner === 'string') parts.push(inner)
    }
    if (parts.length) return parts.join('\n')
  }
  const raw = event.rawOutput
  if (typeof raw === 'string') return raw
  if (raw && typeof raw === 'object') {
    const file = (raw as { FileContent?: { content?: string } }).FileContent?.content
    if (typeof file === 'string') return file
    return JSON.stringify(raw)
  }
  return ''
}

/**
 * Grok CLI `--output-format streaming-json` events (`text`, `tool_call`, `end`,
 * …). Token `text` lines coalesce like Claude stream_event. Returns true when
 * the line was a Grok event (consumed even if we skip rendering it).
 */
function handleGrokCliEvent(event: Record<string, unknown>, messages: SessionMessage[], timestamp: string): boolean {
  const t = event.type
  if (t === 'thought' || t === 'available_commands' || t === 'usage') return true
  if (t === 'text' && typeof event.data === 'string') {
    let idx = findOpenStreamingIdx(messages)
    if (idx === -1) {
      messages.push({ type: 'assistant', text: '', streaming: true, timestamp })
      idx = messages.length - 1
    }
    messages[idx].text = (messages[idx].text || '') + event.data
    return true
  }
  if (t === 'tool_call') {
    const openIdx = findOpenStreamingIdx(messages)
    if (openIdx !== -1) messages[openIdx].streaming = false
    const name = String(event.toolName || event.title || 'tool')
    const input = (event.rawInput as Record<string, unknown>) || {}
    messages.push({
      type: 'tool',
      toolName: name,
      toolInput: summarizeToolInput(name, input),
      toolUseId: String(event.toolCallId || ''),
      timestamp,
    })
    return true
  }
  if (t === 'tool_call_update') {
    const id = String(event.toolCallId || '')
    const result = grokToolOutputText(event)
    if (id && result) {
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].type === 'tool' && messages[i].toolUseId === id) {
          messages[i].toolResult = result.slice(0, 20000)
          break
        }
      }
    }
    return true
  }
  if (t === 'end') {
    const openIdx = findOpenStreamingIdx(messages)
    if (openIdx !== -1) messages[openIdx].streaming = false
    const lastAssist = [...messages].reverse().find(m => m.type === 'assistant' && m.text)
    const usage = (event.usage as Record<string, unknown>) || {}
    const stop = String(event.stopReason || '')
    const isErr = /error|abort/i.test(stop) && stop !== 'end_turn'
    const cost = typeof event.total_cost_usd === 'number' ? event.total_cost_usd : undefined
    messages.push({
      type: isErr ? 'error' : 'result',
      text: lastAssist?.text || (isErr ? `Session ended (${stop})` : 'Session completed'),
      cost,
      input_tokens: (usage.input_tokens as number) || undefined,
      timestamp,
    })
    return true
  }
  return false
}

/** Parse a single stream-json line into SessionMessage(s) */
export function parseStreamJsonLine(line: string, timestamp: string): SessionMessage[] {
  try {
    const event = JSON.parse(line)
    const messages: SessionMessage[] = []

    if (event.type === 'prompt') {
      messages.push({
        type: 'followup',
        text: event.title || event.text || 'Objective started',
        timestamp,
      })
    } else if (event.type === 'system') {
      // Only render meaningful system events, skip noisy progress/task updates
      const subtype = event.subtype || ''
      const skipSubtypes = ['task_progress', 'task_started', 'task_notification', 'task_completed', 'rate_limit_info', 'api_retry']
      if (!skipSubtypes.includes(subtype)) {
        messages.push({
          type: 'system',
          text: subtype === 'init' ? `Session started in ${event.cwd || 'unknown dir'}` : (subtype || 'system'),
          timestamp,
        })
      }
    } else if (event.type === 'assistant' && event.message?.content) {
      for (const block of event.message.content) {
        if (block.type === 'text') {
          messages.push({ type: 'assistant', text: block.text, timestamp })
        } else if (block.type === 'tool_use') {
          messages.push({
            type: 'tool',
            toolName: block.name,
            toolInput: summarizeToolInput(block.name, block.input || {}),
            toolUseId: block.id,
            timestamp,
          })
        }
      }
    } else if (event.type === 'user' && event.message?.content) {
      // Tool results come back as user messages
      for (const block of event.message.content) {
        if (block.type === 'tool_result') {
          const resultText = Array.isArray(block.content)
            ? block.content.map((c: { text?: string }) => c.text || '').join('\n')
            : typeof block.content === 'string' ? block.content : ''
          // We don't emit a separate message for tool results; instead we'll
          // attach them when building the output. Store as a lightweight marker.
          if (resultText) {
            messages.push({
              type: 'user',
              toolResult: resultText.slice(0, 20000),
              toolUseId: block.tool_use_id,
              timestamp,
            })
          }
        }
      }
    } else if (event.type === 'result') {
      const usage = (event.usage as Record<string, unknown> | undefined) || {}
      // Errored results come in several shapes: subtype "error", subtype
      // "error_during_execution" (message in an `errors` array), and
      // is_error=true with subtype "success" (rate-limit 429 exits).
      const isErr = event.is_error === true || (typeof event.subtype === 'string' && event.subtype.startsWith('error'))
      const errorsText = Array.isArray(event.errors) ? event.errors.filter(Boolean).join('; ') : ''
      messages.push({
        type: isErr ? 'error' : 'result',
        text: event.result || event.error || errorsText || (isErr ? 'Session ended with error' : 'Session completed'),
        cost: event.total_cost_usd,
        duration: event.duration_ms,
        input_tokens: (usage.input_tokens as number) || undefined,
        timestamp,
      })
    }

    return messages
  } catch {
    // Not valid JSON - might be a follow-up marker or garbage
    return []
  }
}

// ── Session output cache ──
// Cache parsed messages + file byte offset so we don't re-read/re-parse the
// entire JSONL on every 2-second poll.  Only new bytes are read incrementally.
interface OutputCache {
  byteOffset: number           // how many bytes we've consumed so far
  messages: SessionMessage[]   // fully parsed messages
  lastToolIdx: number          // index of last tool msg without a result (for attachment)
}
const outputCache = new Map<string, OutputCache>()

/** Evict cache for a session (call when session is cleaned up). */
export function evictOutputCache(sessionId: string) {
  outputCache.delete(sessionId)
  // The memoized timeline is derived from this session's message array, so drop
  // it in lockstep to avoid a stale segment list if the session is re-read.
  evictTimelineCache(sessionId)
}

/**
 * Parse new JSONL lines into messages and attach tool results to preceding
 * tool messages.  Mutates `messages` array in place.
 */
function parseNewLines(lines: string[], messages: SessionMessage[], startToolIdx: number): number {
  let lastToolIdx = startToolIdx
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue

    // Check for our custom error/followup formats first
    try {
      const parsed = JSON.parse(trimmed)
      if (parsed.type === 'error' && parsed.text && parsed.timestamp) {
        messages.push({ type: 'error', text: parsed.text, timestamp: parsed.timestamp })
        continue
      }
      if (parsed.type === 'followup') {
        messages.push({ type: 'followup', text: parsed.text, timestamp: parsed.timestamp })
        continue
      }
      // Warning events (worktree violations, telemetry) — render via the error
      // style so they surface in SessionViewer without a new message type.
      if (parsed.type === 'warning' && parsed.text) {
        messages.push({ type: 'error', text: parsed.text, timestamp: parsed.timestamp || new Date().toISOString() })
        continue
      }
    } catch {}

    const now = new Date().toISOString()

    // Enhancement A: token-by-token streaming. `stream_event` lines coalesce
    // partial text deltas onto an open streaming assistant message on the
    // accumulator (state survives incremental reads). Handled here (not in the
    // pure parseStreamJsonLine) because it must mutate `messages` directly.
    try {
      const rawEvent = JSON.parse(trimmed)
      if (rawEvent?.type === 'stream_event') {
        handleStreamEvent(rawEvent, messages, now)
        continue
      }
      if (handleGrokCliEvent(rawEvent, messages, now)) continue
    } catch {}

    const parsed = parseStreamJsonLine(trimmed, now)

    // Track whether we've already consumed the open streaming message for the
    // FIRST text block of this (final) assistant event — dedupe/finalize.
    let finalizedStreaming = false

    for (const msg of parsed) {
      if (msg.type === 'user' && msg.toolResult) {
        // Attach result to its tool message. Enhancement B: prefer real
        // toolUseId pairing (fixes parallel/interleaved calls); fall back to
        // the legacy backward-adjacency scan when ids are absent.
        let attached = false
        if (msg.toolUseId) {
          for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i].type === 'tool' && messages[i].toolUseId === msg.toolUseId && !messages[i].toolResult) {
              messages[i].toolResult = msg.toolResult
              attached = true
              break
            }
          }
        }
        if (!attached) {
          for (let i = messages.length - 1; i >= lastToolIdx && i >= 0; i--) {
            if (messages[i].type === 'tool' && !messages[i].toolResult) {
              messages[i].toolResult = msg.toolResult
              break
            }
          }
        }
      } else if (msg.type === 'assistant' && msg.text !== undefined) {
        // Enhancement A dedupe: the final complete assistant event duplicates
        // the streamed text. For the FIRST text block, REPLACE the open
        // streaming message's text + finalize it (instead of pushing a dup).
        // Additional text blocks push as new (streaming:false) messages.
        // With NO open streaming message (legacy/non-partial session), behave
        // exactly as before: push the assistant text.
        const openIdx = finalizedStreaming ? -1 : findOpenStreamingIdx(messages)
        if (openIdx !== -1) {
          messages[openIdx].text = msg.text
          messages[openIdx].streaming = false
          finalizedStreaming = true
        } else {
          messages.push(msg)
        }
      } else {
        if (msg.type === 'tool') lastToolIdx = messages.length
        messages.push(msg)
      }
    }
  }
  // Safety: never leave a stuck cursor on a completed transcript. If the last
  // typed event was a `result`/`error` (session ended), clear any lingering
  // streaming flags. (Normal case: the final assistant event already cleared it.)
  const tail = messages[messages.length - 1]
  if (tail && (tail.type === 'result' || tail.type === 'error')) {
    for (const m of messages) if (m.streaming) m.streaming = false
  }
  return lastToolIdx
}

/**
 * Get all session output messages, using an incremental cache so only new
 * bytes from the JSONL file are read and parsed on each call.
 *
 * @param sessionId - The session ID to read output for
 * @param jsonlPathOverride - Optional explicit JSONL path (used when the
 *   session is still in the activeSessions map). When omitted, falls back
 *   to the default TRANSCRIPT_DIR/<sessionId>.jsonl path.
 */
/**
 * Resolve the on-disk JSONL transcript path for a session id. This is the same
 * derivation getSessionOutput uses for its default path — exported so callers
 * (e.g. the SSE stream endpoint) can fs.watch the file without duplicating the
 * path logic.
 */
export function getSessionJsonlPath(sessionId: string): string {
  return path.join(TRANSCRIPT_DIR, `${sessionId}.jsonl`)
}

export function getSessionOutput(sessionId: string, jsonlPathOverride?: string): SessionMessage[] {
  const jsonlPath = jsonlPathOverride || getSessionJsonlPath(sessionId)

  try {
    const stat = fs.statSync(jsonlPath)
    const fileSize = stat.size
    if (fileSize === 0) return []

    const cached = outputCache.get(sessionId)

    // If file hasn't grown since last read, return cached messages
    if (cached && cached.byteOffset >= fileSize) {
      return cached.messages
    }

    // Read only new bytes from where we left off
    const startOffset = cached?.byteOffset || 0
    const fd = fs.openSync(jsonlPath, 'r')
    const buf = Buffer.alloc(fileSize - startOffset)
    fs.readSync(fd, buf, 0, buf.length, startOffset)
    fs.closeSync(fd)

    let newContent = buf.toString('utf-8')

    // If we're reading incrementally, the first "line" might be a partial
    // continuation of the last line from the previous read.  For the initial
    // read (startOffset === 0) this doesn't apply.
    const messages = cached ? cached.messages : [] as SessionMessage[]
    const lastToolIdx = cached ? cached.lastToolIdx : 0

    // On incremental reads, if file didn't end with \n last time we might
    // get a partial leading line.  Since we always consume up to the last \n
    // below this is handled.

    // Only parse up to the last complete line (ending with \n).  Keep any
    // trailing partial for the next read.
    let consumedBytes = startOffset
    const lastNewline = newContent.lastIndexOf('\n')
    if (lastNewline === -1) {
      // No complete line yet — return what we have
      if (cached) return cached.messages
      outputCache.set(sessionId, { byteOffset: startOffset, messages: [], lastToolIdx: 0 })
      return []
    }

    const completeContent = newContent.slice(0, lastNewline + 1)
    consumedBytes = startOffset + Buffer.byteLength(completeContent, 'utf-8')

    const lines = completeContent.split('\n')
    const updatedToolIdx = parseNewLines(lines, messages, lastToolIdx)

    outputCache.set(sessionId, {
      byteOffset: consumedBytes,
      messages,
      lastToolIdx: updatedToolIdx,
    })

    return messages
  } catch {
    return []
  }
}

/** Return only messages after index `afterIndex` (for incremental client fetches). */
export function getSessionOutputAfter(sessionId: string, afterIndex: number, jsonlPathOverride?: string): SessionMessage[] {
  const all = getSessionOutput(sessionId, jsonlPathOverride)
  if (afterIndex >= all.length) return []
  return all.slice(afterIndex)
}

/**
 * Background pre-warm of the parse cache (obj 700585). The first open of a large
 * thread cold-parses its entire JSONL — ~2.3s for the biggest ~5MB / ~770-message
 * transcripts — a one-time-per-process cost the operator otherwise eats on click.
 * This drips getSessionOutput() over the most recently-active sessions in the
 * background so that first open is already warm (a Map hit, ~10ms).
 *
 * It is strictly additive and safe: it calls the SAME getSessionOutput() the
 * route does (never changing any response shape), one session per timer tick with
 * a gap between each so it never blocks the event loop or spikes CPU, each wrapped
 * in try/catch, and it skips any session already cached. Timers are unref'd so
 * they never hold the process open.
 */
export function prewarmSessionOutputs(
  sessionIds: string[],
  opts: { gapMs?: number; max?: number; startDelayMs?: number } = {},
): void {
  const gapMs = opts.gapMs ?? 200
  const max = opts.max ?? 50
  const startDelayMs = opts.startDelayMs ?? 5000
  const queue = sessionIds.filter(Boolean).slice(0, max)
  if (queue.length === 0) return

  let i = 0
  const step = () => {
    const id = queue[i++]
    if (id && !outputCache.has(id)) {
      try { getSessionOutput(id) } catch { /* best-effort warm; ignore */ }
    }
    if (i < queue.length) setTimeout(step, gapMs).unref()
  }
  // Delay the first tick so boot-critical work (listener, ledger backfill) runs first.
  setTimeout(step, startDelayMs).unref()
}
