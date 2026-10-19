import { describe, it, expect, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { getSessionOutput, evictOutputCache } from './stream-parser.js'
import { buildThreadTimeline } from './thread-timeline.js'

let tmpFiles: string[] = []

function writeJsonl(lines: object[]): { sessionId: string; jsonlPath: string } {
  const sessionId = `grok-test-${process.pid}-${Math.random().toString(36).slice(2)}`
  const jsonlPath = path.join(os.tmpdir(), `cc-grok-${sessionId}.jsonl`)
  fs.writeFileSync(jsonlPath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  tmpFiles.push(jsonlPath)
  return { sessionId, jsonlPath }
}

afterEach(() => {
  for (const f of tmpFiles) {
    try { fs.unlinkSync(f) } catch { /* noop */ }
  }
  tmpFiles = []
})

describe('stream-parser Grok CLI streaming-json', () => {
  it('coalesces token text, records tools, and surfaces the final answer as a result', () => {
    const { sessionId, jsonlPath } = writeJsonl([
      { type: 'followup', text: '[child-complete] workers finished', timestamp: 't0' },
      { type: 'available_commands', tools: ['read_file'] },
      { type: 'thought', data: 'hmm' },
      { type: 'text', data: 'Wave ' },
      { type: 'text', data: '2 is done.' },
      {
        type: 'tool_call',
        toolCallId: 'call-1',
        toolName: 'read_file',
        title: 'read_file',
        rawInput: { target_file: '/tmp/NOTES.md' },
      },
      {
        type: 'tool_call_update',
        toolCallId: 'call-1',
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: '# notes' } }],
        rawOutput: { type: 'ReadFile', FileContent: { content: '# notes' } },
      },
      { type: 'text', data: 'Here is the status.' },
      { type: 'end', stopReason: 'end_turn', total_cost_usd: 0.09, usage: { input_tokens: 10, output_tokens: 4 } },
    ])
    const out = getSessionOutput(sessionId, jsonlPath)
    evictOutputCache(sessionId)

    const follow = out.filter(m => m.type === 'followup')
    expect(follow).toHaveLength(1)
    const assistants = out.filter(m => m.type === 'assistant')
    expect(assistants.map(m => m.text)).toEqual(['Wave 2 is done.', 'Here is the status.'])
    expect(assistants.every(m => m.streaming === false)).toBe(true)
    const tools = out.filter(m => m.type === 'tool')
    expect(tools).toHaveLength(1)
    expect(tools[0].toolName).toBe('read_file')
    expect(tools[0].toolInput).toContain('NOTES.md')
    expect(tools[0].toolResult).toContain('# notes')
    const results = out.filter(m => m.type === 'result')
    expect(results).toHaveLength(1)
    expect(results[0].text).toBe('Here is the status.')
    expect(results[0].cost).toBe(0.09)

    const segs = buildThreadTimeline(out)
    expect(segs.some(s => s.type === 'summary' && s.text === 'Here is the status.')).toBe(true)
    expect(segs.some(s => s.type === 'divider')).toBe(true)
  })
})
