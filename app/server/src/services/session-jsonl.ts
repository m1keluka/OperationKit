/**
 * Transcript JSONL helpers — extracted from session-manager.ts (behavior frozen).
 */
import fs from 'fs'

/**
 * Session-state detection (getSessionState / jsonlHasResult) only cares about
 * the most recent events, but it used to `readFileSync` + JSON.parse the WHOLE
 * transcript on every call. The state-poller calls getSessionState several times
 * per objective on every 3s tick, so that was O(fileSize) synchronous work per
 * session per tick — it froze Node's single event loop for a growing fraction of
 * every tick as transcripts grew (symptom: opening a kanban objective's thread
 * hung for many seconds because its request was queued behind the stall).
 *
 * The read window ends at EOF, so the final line is always complete; only the
 * first line may be partial, and callers scan from the end and tolerate parse
 * failures, so a clipped leading line is harmless.
 */
export function readJsonlTail(jsonlPath: string, tailBytes = 1_000_000): string {
  const fd = fs.openSync(jsonlPath, 'r')
  try {
    const size = fs.fstatSync(fd).size
    if (size === 0) return ''
    const start = Math.max(0, size - tailBytes)
    const len = size - start
    const buf = Buffer.alloc(len)
    fs.readSync(fd, buf, 0, len, start)
    return buf.toString('utf-8')
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * Extract the CLI's own resumable session id from a JSONL transcript.
 *
 * Claude: each process spawn appends a `system/init` event carrying
 * `session_id`. Codex: each spawn emits a `thread.started` event carrying
 * `thread_id` (the handle for `codex exec resume`). In both cases the LAST
 * one wins — follow-up respawns append to the same file and resume keeps the
 * same id across turns, so the latest event is always the resumable session.
 */
export function extractClaudeSessionId(jsonlPath: string): string | null {
  try {
    const content = fs.readFileSync(jsonlPath, 'utf-8')
    let found: string | null = null
    for (const line of content.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      if (!trimmed.includes('"init"') && !trimmed.includes('thread.started')) continue
      try {
        const event = JSON.parse(trimmed)
        if (event.type === 'system' && event.subtype === 'init' && typeof event.session_id === 'string' && event.session_id) {
          found = event.session_id
        } else if (event.type === 'thread.started' && typeof event.thread_id === 'string' && event.thread_id) {
          found = event.thread_id
        }
      } catch {}
    }
    return found
  } catch {
    return null
  }
}

/** Check JSONL for a result event (Claude writes these in stream-json mode) */
export function jsonlHasResult(jsonlPath: string): boolean {
  try {
    const content = readJsonlTail(jsonlPath)
    const lines = content.trim().split('\n')
    for (let i = lines.length - 1; i >= 0; i--) {
      const trimmed = lines[i].trim()
      if (!trimmed) continue
      try {
        const event = JSON.parse(trimmed)
        if (event.type === 'result') return true
      } catch {}
    }
  } catch {}
  return false
}
