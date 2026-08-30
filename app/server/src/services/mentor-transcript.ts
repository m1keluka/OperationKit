import fs from 'fs'
import type { SessionMessage } from '@operationkit/shared'

// Shared JSONL transcript parsing for mentor/Assistant threads. Extracted from
// routes/mentor.ts so both the JWT-gated web route and the service-token bridge
// (routes/internal.ts) parse transcripts identically — same SessionMessage[]
// shape the web UI consumes. The web route imports readJsonl from here; the
// bridge does too. No behavior change vs. the original in-file implementation.

interface RawJsonlEvent {
  type?: string
  text?: string
  title?: string
  subtype?: string
  result?: string
  error?: string
  is_error?: boolean
  errors?: string[]
  cwd?: string
  total_cost_usd?: number
  duration_ms?: number
  timestamp?: string
  message?: {
    content?: Array<{
      type: string
      text?: string
      name?: string
      input?: Record<string, unknown>
      content?: unknown
    }>
  }
}

function summarizeToolInput(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case 'Bash':
      return String(input.command || '').slice(0, 200)
    case 'Read':
    case 'Write':
    case 'Edit':
      return String(input.file_path || '')
    case 'Glob':
      return String(input.pattern || '')
    case 'Grep':
      return `${input.pattern || ''} ${input.path || ''}`.trim()
    default:
      for (const v of Object.values(input)) {
        if (typeof v === 'string' && v.length > 0) return v.slice(0, 150)
      }
      return JSON.stringify(input).slice(0, 150)
  }
}

function parseLine(line: string, fallbackTimestamp: string): SessionMessage[] {
  let event: RawJsonlEvent
  try {
    event = JSON.parse(line) as RawJsonlEvent
  } catch {
    return []
  }

  const timestamp = event.timestamp || fallbackTimestamp
  const out: SessionMessage[] = []

  if (event.type === 'prompt') {
    out.push({ type: 'followup', text: event.text || event.title || 'Thread started', timestamp })
  } else if (event.type === 'followup') {
    out.push({ type: 'followup', text: event.text || '', timestamp })
  } else if (event.type === 'system') {
    const subtype = event.subtype || ''
    const skipSubtypes = ['task_progress', 'task_started', 'task_notification', 'task_completed', 'rate_limit_info']
    if (!skipSubtypes.includes(subtype)) {
      out.push({
        type: 'system',
        text: subtype === 'init' ? `Session started in ${event.cwd || 'unknown dir'}` : (subtype || 'system'),
        timestamp,
      })
    }
  } else if (event.type === 'assistant' && event.message?.content) {
    for (const block of event.message.content) {
      if (block.type === 'text' && block.text) {
        out.push({ type: 'assistant', text: block.text, timestamp })
      } else if (block.type === 'tool_use') {
        out.push({
          type: 'tool',
          toolName: block.name,
          toolInput: summarizeToolInput(block.name || '', block.input || {}),
          timestamp,
        })
      }
    }
  } else if (event.type === 'user' && event.message?.content) {
    for (const block of event.message.content) {
      if (block.type === 'tool_result') {
        const content = block.content
        const resultText = Array.isArray(content)
          ? content.map((c: { text?: string }) => c.text || '').join('\n')
          : typeof content === 'string'
            ? content
            : ''
        if (resultText) {
          out.push({ type: 'user', toolResult: resultText.slice(0, 20000), timestamp })
        }
      }
    }
  } else if (event.type === 'result') {
    // Same error-shape handling as stream-parser.ts: subtype "error*" or
    // is_error=true (429 exits report subtype "success"), message may live
    // in an `errors` array.
    const isErr = event.is_error === true || (typeof event.subtype === 'string' && event.subtype.startsWith('error'))
    const errorsText = Array.isArray(event.errors) ? event.errors.filter(Boolean).join('; ') : ''
    out.push({
      type: isErr ? 'error' : 'result',
      text: event.result || event.error || errorsText || (isErr ? 'Session ended with error' : 'Session completed'),
      cost: event.total_cost_usd,
      duration: event.duration_ms,
      timestamp,
    })
  } else if (event.type === 'error') {
    out.push({ type: 'error', text: event.text || event.error || 'Error', timestamp })
  }

  return out
}

export function readJsonl(jsonlPath: string): SessionMessage[] {
  try {
    if (!fs.existsSync(jsonlPath)) return []
    const content = fs.readFileSync(jsonlPath, 'utf-8')
    if (!content.trim()) return []

    const lines = content.split('\n')
    const messages: SessionMessage[] = []
    const fallback = new Date().toISOString()
    // Claude emits a `system init` event at the start of every turn in
    // stream-json input mode. Showing all of them clutters the UI with one
    // "Session started in …" badge per follow-up — keep the first, drop the rest.
    let sessionStartedSeen = false

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      const parsed = parseLine(trimmed, fallback)
      for (const msg of parsed) {
        if (msg.type === 'system' && msg.text?.startsWith('Session started')) {
          if (sessionStartedSeen) continue
          sessionStartedSeen = true
        }
        // Tool results attach to the most recent unattached tool call so the
        // collapsible UI can render them side-by-side.
        if (msg.type === 'user' && msg.toolResult) {
          for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i].type === 'tool' && !messages[i].toolResult) {
              messages[i].toolResult = msg.toolResult
              break
            }
          }
        } else {
          messages.push(msg)
        }
      }
    }
    return messages
  } catch {
    return []
  }
}
