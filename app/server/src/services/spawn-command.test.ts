import { describe, it, expect } from 'vitest'
import { buildClaudeCommand } from './session-manager.js'

// ST3 — runaway caps on the spawn command. The per-spawn `--max-budget-usd`
// dollar ceiling resets on every respawn, so a turn cap + per-response token
// ceiling are the hard backstops against a single runaway spawn. These tests
// lock that the caps are emitted on the `claude` command.
describe('buildClaudeCommand — runaway caps (ST3)', () => {
  const base = { engine: 'claude', budget: 50, effortLevel: 'medium' }

  it('emits --max-turns, --max-budget-usd, and an inline token-cap env', () => {
    const cmd = buildClaudeCommand({ ...base, maxTurns: 150, maxOutputTokens: 32000 })
    expect(cmd).toContain('--max-budget-usd 50')
    expect(cmd).toContain('--max-turns 150')
    expect(cmd).toContain('CLAUDE_CODE_MAX_OUTPUT_TOKENS=32000')
    // token-cap env must prefix the claude invocation (on the command itself)
    expect(cmd).toMatch(/^CLAUDE_CODE_MAX_OUTPUT_TOKENS=32000 claude/)
  })

  it('still carries the existing print/stream/permission flags + fallback', () => {
    const cmd = buildClaudeCommand({ ...base, maxTurns: 100, maxOutputTokens: 16000 })
    expect(cmd).toContain('--print')
    expect(cmd).toContain('--output-format stream-json')
    expect(cmd).toContain('--dangerously-skip-permissions')
    expect(cmd).toContain('--fallback-model claude-sonnet-4-6')
    expect(cmd).not.toContain('--fallback-model claude-opus-4-8')
  })

  it('omits a cap whose configured value is <= 0 (escape hatch, never breaks spawn)', () => {
    const cmd = buildClaudeCommand({ ...base, maxTurns: 0, maxOutputTokens: 0 })
    expect(cmd).not.toContain('--max-turns')
    expect(cmd).not.toContain('CLAUDE_CODE_MAX_OUTPUT_TOKENS')
    // the dollar ceiling is unconditional and still present
    expect(cmd).toContain('--max-budget-usd 50')
  })

  it('passes through --model and --resume when supplied', () => {
    const cmd = buildClaudeCommand({ ...base, maxTurns: 150, maxOutputTokens: 32000, model: 'claude-opus-4-8', resumeSessionId: 'abc-123' })
    expect(cmd).toContain('--model "claude-opus-4-8"')
    expect(cmd).toContain('--resume "abc-123"')
    expect(cmd).toContain('--fallback-model claude-sonnet-4-6')
  })

  it('omits --fallback-model when the requested model already is the fallback', () => {
    const cmd = buildClaudeCommand({ ...base, maxTurns: 150, maxOutputTokens: 32000, model: 'claude-sonnet-4-6' })
    expect(cmd).not.toContain('--fallback-model')
  })

  it('JSON-quotes --model so a crafted id cannot break the bash wrapper', () => {
    const cmd = buildClaudeCommand({ ...base, maxTurns: 150, maxOutputTokens: 32000, model: 'x"; rm -rf / #' })
    expect(cmd).toContain('--model "x\\"; rm -rf / #"')
    expect(cmd).not.toMatch(/--model x"; rm/)
  })

  it('emits a grok CLI line with streaming-json, always-approve, and no Opus fallback', () => {
    const cmd = buildClaudeCommand({ engine: 'grok', budget: 50, effortLevel: 'medium', model: 'grok-4.6', maxTurns: 150 })
    expect(cmd.startsWith('grok ')).toBe(true)
    expect(cmd).toContain('--output-format streaming-json')
    expect(cmd).toContain('--always-approve')
    expect(cmd).toContain('--model "grok-4.6"')
    expect(cmd).toContain('--max-turns 150')
    expect(cmd).not.toContain('--fallback-model')
    expect(cmd).not.toContain('claude')
  })

  it('leaves the Codex engine untouched (no claude turn/token caps grafted on)', () => {
    const cmd = buildClaudeCommand({ engine: 'codex', budget: 50, effortLevel: 'medium', maxTurns: 150, maxOutputTokens: 32000 })
    expect(cmd.startsWith('codex ')).toBe(true)
    expect(cmd).not.toContain('--max-turns')
    expect(cmd).not.toContain('CLAUDE_CODE_MAX_OUTPUT_TOKENS')
    expect(cmd).not.toContain('--max-budget-usd')
  })
})
