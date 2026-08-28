import { describe, it, expect, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { extractDeterministic } from './session-intel-parse.js'

// obj-2387: the deterministic parser must surface, per session, (a) the skills
// invoked (Read of skills/<x>/SKILL.md), (b) the agent personas adopted via the
// routing table (Read of agents/<slug>.md), and (c) the sub-agent worker types
// spawned via the Agent/Task tool. These back the SessionViewer activity strip.

const tmpFiles: string[] = []
function writeJsonl(events: object[]): string {
  const p = path.join(os.tmpdir(), `cc-agents-${process.pid}-${tmpFiles.length}.jsonl`)
  fs.writeFileSync(p, events.map(e => JSON.stringify(e)).join('\n'))
  tmpFiles.push(p)
  return p
}
function assistantToolUse(blocks: object[]): object {
  return { type: 'assistant', timestamp: '2026-06-28T12:00:00.000Z', message: { content: blocks } }
}
afterAll(() => { for (const f of tmpFiles) { try { fs.unlinkSync(f) } catch {} } })

describe('session-intel agent/skill/sub-agent extraction', () => {
  it('detects skills, persona reads, and spawned sub-agents', async () => {
    const p = writeJsonl([
      assistantToolUse([
        { type: 'tool_use', name: 'Read', input: { file_path: '/home/operator/ai-workspace/skills/deep-research/SKILL.md' } },
        { type: 'tool_use', name: 'Read', input: { file_path: '/home/operator/ai-workspace/agents/cfo.md' } },
        { type: 'tool_use', name: 'Read', input: { file_path: '/home/operator/ai-workspace/agents/data-sourcing.md' } },
        { type: 'tool_use', name: 'Agent', input: { subagent_type: 'Explore', prompt: 'look around' } },
        { type: 'tool_use', name: 'Task', input: { subagent_type: 'qa-reviewer' } },
      ]),
    ])
    const intel = await extractDeterministic(p)
    expect(intel.skillsUsed).toContain('deep-research')
    expect(intel.agentsInvoked.sort()).toEqual(['cfo', 'data-sourcing'])
    expect(intel.subagentsSpawned.sort()).toEqual(['Explore', 'qa-reviewer'])
  })

  it('deduplicates and defaults an unset subagent_type to general-purpose', async () => {
    const p = writeJsonl([
      assistantToolUse([
        { type: 'tool_use', name: 'Read', input: { file_path: '/x/agents/cto.md' } },
        { type: 'tool_use', name: 'Read', input: { file_path: '/y/agents/cto.md' } },
        { type: 'tool_use', name: 'Agent', input: { prompt: 'no type given' } },
      ]),
    ])
    const intel = await extractDeterministic(p)
    expect(intel.agentsInvoked).toEqual(['cto'])
    expect(intel.subagentsSpawned).toEqual(['general-purpose'])
  })

  it('returns empty arrays when no skills/agents/sub-agents are present', async () => {
    const p = writeJsonl([
      assistantToolUse([
        { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
        { type: 'tool_use', name: 'Read', input: { file_path: '/home/operator/notes.md' } },
      ]),
    ])
    const intel = await extractDeterministic(p)
    expect(intel.agentsInvoked).toEqual([])
    expect(intel.subagentsSpawned).toEqual([])
    expect(intel.skillsUsed).toEqual([])
  })
})
