import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

// extractObjectiveTurns reads TRANSCRIPT_DIR at import time via config.ts.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-history-leak-'))
process.env.TRANSCRIPT_DIR = TMP
process.env.DB_PATH = path.join(TMP, 'db.sqlite')

const { initDb } = await import('../db/index.js')
const {
  assembleFlattenedFollowUpPrompt,
  buildObjectiveHistory,
  extractObjectiveTurns,
} = await import('./prompt-builder-history.js')

const OBJ_ID = 707001

function writeJsonl(name: string, events: unknown[]): void {
  fs.writeFileSync(
    path.join(TMP, name),
    events.map((e) => JSON.stringify(e)).join('\n') + '\n',
  )
}

beforeAll(() => {
  initDb()
  writeJsonl(`cc-${OBJ_ID}-1.jsonl`, [
    {
      type: 'prompt',
      text: 'SPAWN_PROMPT_MARKER You are the cto agent. ## Session Context (auto-assembled)\nHuge orchestrator dump.',
      title: 'token leak fixture',
      timestamp: '2026-08-23T00:00:00.000Z',
    },
    {
      type: 'followup',
      text: 'FOLLOWUP_MARKER please continue from the last file',
      timestamp: '2026-08-23T00:01:00.000Z',
    },
    {
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'ASSISTANT_MARKER I edited src/foo.ts' }] },
    },
    {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Edit' }] },
    },
  ])
})

afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true })
})

describe('extractObjectiveTurns — skip spawn-prompt events', () => {
  it('keeps follow-ups and assistant text, drops the orchestrator spawn prompt', () => {
    const turns = extractObjectiveTurns(OBJ_ID)
    const blob = turns.map((t) => t.text).join('\n')
    expect(blob).toContain('FOLLOWUP_MARKER')
    expect(blob).toContain('ASSISTANT_MARKER')
    expect(blob).not.toContain('SPAWN_PROMPT_MARKER')
    expect(turns.some((t) => t.role === 'user')).toBe(true)
    expect(turns.some((t) => t.role === 'assistant')).toBe(true)
  })

  it('buildObjectiveHistory does not re-inject the spawn prompt into flatten history', () => {
    const history = buildObjectiveHistory(OBJ_ID)
    expect(history).toContain('FOLLOWUP_MARKER')
    expect(history).toContain('ASSISTANT_MARKER')
    expect(history).not.toContain('SPAWN_PROMPT_MARKER')
    expect(history).not.toContain('## Session Context (auto-assembled)')
  })
})

describe('assembleFlattenedFollowUpPrompt — no second context append', () => {
  it('concatenates basePrompt + history + follow-up and does not add its own Session Context block', () => {
    const base = 'You are the cto agent.\n\n## Session Context (auto-assembled)\n- prior session summary'
    const history = '[Instruction]: FOLLOWUP_MARKER please continue\n\n[Agent]: ASSISTANT_MARKER I edited src/foo.ts'
    const message = 'AUTO-RESUME: continue on a fresh account.'
    const prompt = assembleFlattenedFollowUpPrompt(base, history, message)

    expect(prompt.startsWith(base)).toBe(true)
    expect(prompt).toContain('<prior_conversation>')
    expect(prompt).toContain(history)
    expect(prompt).toContain('## Follow-up Instruction')
    expect(prompt).toContain(message)
    expect(prompt).not.toContain('SPAWN_PROMPT_MARKER')
    // Context lives in basePrompt exactly once — flatten must not append a second copy.
    expect(prompt.split('## Session Context (auto-assembled)').length - 1).toBe(1)
  })

  it('omits the prior-conversation wrapper when history is empty', () => {
    const prompt = assembleFlattenedFollowUpPrompt('BASE', '', 'do the thing')
    expect(prompt).toBe('BASE\n\n## Follow-up Instruction\n\ndo the thing')
    expect(prompt).not.toContain('<prior_conversation>')
  })
})
