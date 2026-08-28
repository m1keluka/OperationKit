import { describe, it, expect, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { getSessionOutput, evictOutputCache } from './stream-parser.js'

// These tests drive the FULL incremental parse path (getSessionOutput reads only
// new bytes and appends to a cached SessionMessage[]), which is where the
// typewriter-coalescing and toolUseId-pairing logic actually lives. We write a
// throwaway JSONL to a temp dir and point getSessionOutput at it via the
// jsonlPathOverride argument, then evict its cache between cases.

const FIXTURE = path.join(__dirname, '__fixtures__', 'partial-messages-sample.jsonl')

let tmpFiles: string[] = []

function writeJsonl(lines: object[]): { sessionId: string; jsonlPath: string } {
  const sessionId = `test-${process.pid}-${Math.random().toString(36).slice(2)}`
  const jsonlPath = path.join(os.tmpdir(), `cc-partial-${sessionId}.jsonl`)
  fs.writeFileSync(jsonlPath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  tmpFiles.push(jsonlPath)
  return { sessionId, jsonlPath }
}

/** Append more lines to an existing file (simulates the incremental poll). */
function appendJsonl(jsonlPath: string, lines: object[]): void {
  fs.appendFileSync(jsonlPath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
}

// Event-shape helpers matching Claude Code 2.1.175 --include-partial-messages.
const messageStart = () => ({ type: 'stream_event', event: { type: 'message_start', message: { content: [] } } })
const textBlockStart = (index = 0) => ({ type: 'stream_event', event: { type: 'content_block_start', index, content_block: { type: 'text', text: '' } } })
const textDelta = (text: string, index = 0) => ({ type: 'stream_event', event: { type: 'content_block_delta', index, delta: { type: 'text_delta', text } } })
const inputJsonDelta = (partial: string, index = 0) => ({ type: 'stream_event', event: { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: partial } } })
const blockStop = (index = 0) => ({ type: 'stream_event', event: { type: 'content_block_stop', index } })
const messageStop = () => ({ type: 'stream_event', event: { type: 'message_stop' } })
const finalAssistant = (content: object[]) => ({ type: 'assistant', message: { role: 'assistant', content } })
const userToolResult = (toolUseId: string, text: string) => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: text }] } })
const resultEvent = () => ({ type: 'result', subtype: 'success', is_error: false, result: 'done', total_cost_usd: 0.01, duration_ms: 100 })

afterEach(() => {
  for (const f of tmpFiles) {
    try { fs.unlinkSync(f) } catch {}
  }
  tmpFiles = []
})

describe('stream-parser partial-messages (Enhancement A: typewriter streaming)', () => {
  it('coalesces text deltas into ONE assistant message, deduped against the final complete event', () => {
    const { sessionId, jsonlPath } = writeJsonl([
      messageStart(),
      textBlockStart(),
      textDelta('Hel'),
      textDelta('lo'),
      textDelta(' world'),
      blockStop(),
      finalAssistant([{ type: 'text', text: 'Hello world' }]),
      resultEvent(),
    ])
    const out = getSessionOutput(sessionId, jsonlPath)
    evictOutputCache(sessionId)

    const assistants = out.filter((m) => m.type === 'assistant')
    expect(assistants).toHaveLength(1)
    expect(assistants[0].text).toBe('Hello world')
    expect(assistants[0].streaming).toBe(false)
  })

  it('shows a live, mid-stream assistant message with streaming===true before the final event arrives', () => {
    const { sessionId, jsonlPath } = writeJsonl([
      messageStart(),
      textBlockStart(),
      textDelta('Hel'),
      textDelta('lo'),
    ])
    const out = getSessionOutput(sessionId, jsonlPath)
    evictOutputCache(sessionId)

    const assistants = out.filter((m) => m.type === 'assistant')
    expect(assistants).toHaveLength(1)
    expect(assistants[0].text).toBe('Hello')
    expect(assistants[0].streaming).toBe(true)
  })

  it('finalizes a mid-stream message across INCREMENTAL reads (streaming state on the accumulator)', () => {
    const { sessionId, jsonlPath } = writeJsonl([
      messageStart(),
      textBlockStart(),
      textDelta('Hel'),
    ])
    // First poll: mid-stream.
    let out = getSessionOutput(sessionId, jsonlPath)
    expect(out.filter((m) => m.type === 'assistant')[0].streaming).toBe(true)
    expect(out.filter((m) => m.type === 'assistant')[0].text).toBe('Hel')

    // Second poll: more deltas + the final complete assistant event arrive.
    appendJsonl(jsonlPath, [textDelta('lo world'), blockStop(), finalAssistant([{ type: 'text', text: 'Hello world' }]), resultEvent()])
    out = getSessionOutput(sessionId, jsonlPath)
    evictOutputCache(sessionId)

    const assistants = out.filter((m) => m.type === 'assistant')
    expect(assistants).toHaveLength(1)
    expect(assistants[0].text).toBe('Hello world')
    expect(assistants[0].streaming).toBe(false)
  })

  it('ignores input_json_delta (tool input) — only prose streams', () => {
    const { sessionId, jsonlPath } = writeJsonl([
      messageStart(),
      textBlockStart(0),
      textDelta('Running a command'),
      blockStop(0),
      // A tool_use block streams input as input_json_delta — must NOT coalesce.
      { type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_X', name: 'Bash', input: {} } } },
      inputJsonDelta('{"command":"ls"}', 1),
      blockStop(1),
      messageStop(),
      finalAssistant([
        { type: 'text', text: 'Running a command' },
        { type: 'tool_use', id: 'toolu_X', name: 'Bash', input: { command: 'ls' } },
      ]),
    ])
    const out = getSessionOutput(sessionId, jsonlPath)
    evictOutputCache(sessionId)

    const assistants = out.filter((m) => m.type === 'assistant')
    expect(assistants).toHaveLength(1)
    expect(assistants[0].text).toBe('Running a command')
    const tools = out.filter((m) => m.type === 'tool')
    expect(tools).toHaveLength(1)
    expect(tools[0].toolUseId).toBe('toolu_X')
  })
})

describe('stream-parser toolUseId pairing (Enhancement B: parallel tool calls)', () => {
  it('pairs each tool_use with its OWN result by id, even when results arrive in REVERSE order', () => {
    const { sessionId, jsonlPath } = writeJsonl([
      finalAssistant([
        { type: 'tool_use', id: 'toolu_A', name: 'Bash', input: { command: 'echo A' } },
        { type: 'tool_use', id: 'toolu_B', name: 'Bash', input: { command: 'echo B' } },
      ]),
      // Results arrive B then A (interleaved/parallel).
      userToolResult('toolu_B', 'result-B'),
      userToolResult('toolu_A', 'result-A'),
      resultEvent(),
    ])
    const out = getSessionOutput(sessionId, jsonlPath)
    evictOutputCache(sessionId)

    const tools = out.filter((m) => m.type === 'tool')
    expect(tools).toHaveLength(2)
    const a = tools.find((t) => t.toolUseId === 'toolu_A')!
    const b = tools.find((t) => t.toolUseId === 'toolu_B')!
    expect(a.toolResult).toBe('result-A')
    expect(b.toolResult).toBe('result-B')
  })
})

describe('stream-parser legacy back-compat (no stream_event lines)', () => {
  it('parses old-shape JSONL identically: assistant text present, tool paired by position', () => {
    const { sessionId, jsonlPath } = writeJsonl([
      finalAssistant([{ type: 'text', text: 'Legacy hello' }]),
      finalAssistant([{ type: 'tool_use', id: 'toolu_L', name: 'Read', input: { file_path: '/x' } }]),
      userToolResult('toolu_L', 'legacy-result'),
      resultEvent(),
    ])
    const out = getSessionOutput(sessionId, jsonlPath)
    evictOutputCache(sessionId)

    const assistants = out.filter((m) => m.type === 'assistant')
    expect(assistants).toHaveLength(1)
    expect(assistants[0].text).toBe('Legacy hello')
    // No streaming flag ever set on a legacy transcript.
    expect(assistants.every((m) => m.streaming === undefined || m.streaming === false)).toBe(true)

    const tools = out.filter((m) => m.type === 'tool')
    expect(tools).toHaveLength(1)
    expect(tools[0].toolResult).toBe('legacy-result')
  })

  it('legacy tool_result with NO tool_use_id still attaches via the backward-adjacency fallback', () => {
    const { sessionId, jsonlPath } = writeJsonl([
      finalAssistant([{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }]),
      // Old-style result with no tool_use_id.
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'old-result' }] } },
    ])
    const out = getSessionOutput(sessionId, jsonlPath)
    evictOutputCache(sessionId)

    const tools = out.filter((m) => m.type === 'tool')
    expect(tools).toHaveLength(1)
    expect(tools[0].toolResult).toBe('old-result')
  })
})

describe('stream-parser real fixture (__fixtures__/partial-messages-sample.jsonl)', () => {
  it('parses the live-captured 11-line sample to exactly one "Hello" assistant message (no dupes)', () => {
    const sessionId = `fixture-${process.pid}-${Math.random().toString(36).slice(2)}`
    const out = getSessionOutput(sessionId, FIXTURE)
    evictOutputCache(sessionId)

    const assistants = out.filter((m) => m.type === 'assistant')
    expect(assistants).toHaveLength(1)
    expect(assistants[0].text).toBe('Hello')
    expect(assistants[0].streaming).toBe(false)

    // The result event should still be present and correctly typed.
    expect(out.some((m) => m.type === 'result')).toBe(true)
  })
})
