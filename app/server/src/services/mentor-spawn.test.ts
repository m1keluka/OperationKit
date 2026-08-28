import { describe, it, expect } from 'vitest'
import { buildMentorBashCommand } from './mentor-session.js'

describe('buildMentorBashCommand', () => {
  it('unsets provider API keys so Claude uses the account OAuth token', () => {
    const cmd = buildMentorBashCommand('/home/ccuser-a', null)
    expect(cmd).toContain('unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN OPENAI_API_KEY GEMINI_API_KEY GOOGLE_API_KEY')
    expect(cmd).toContain('--dangerously-skip-permissions')
    expect(cmd).toContain('--max-budget-usd 25')
  })

  it('JSON-quotes HOME, workdir, and --mcp-config', () => {
    const cmd = buildMentorBashCommand('/home/ccuser-a', '/tmp/mcp"oops.json')
    expect(cmd).toContain('export HOME="/home/ccuser-a"')
    expect(cmd).toContain('cd "/home/operator/ai-workspace/mentor-workspace"')
    expect(cmd).toContain('--mcp-config "/tmp/mcp\\"oops.json"')
    expect(cmd).not.toMatch(/--mcp-config \/tmp\/mcp"oops/)
  })

  it('omits --mcp-config when none is provided', () => {
    const cmd = buildMentorBashCommand('/home/ccuser-a', null)
    expect(cmd).not.toContain('--mcp-config')
  })
})
