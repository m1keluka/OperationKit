import { describe, it, expect } from 'vitest'
import path from 'path'
import { buildClaudeCommand, codexConfigHome } from './session-spawn-command.js'

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
    expect(cmd).toContain('--fallback-model claude-sonnet-5')
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
    expect(cmd).toContain('--fallback-model claude-sonnet-5')
  })

  it('omits --fallback-model when the requested model already is the fallback', () => {
    const cmd = buildClaudeCommand({ ...base, maxTurns: 150, maxOutputTokens: 32000, model: 'claude-sonnet-5' })
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

// W4 — MCP adapter: Grok --rules and Codex --profile flags
describe('buildClaudeCommand — Grok --rules and Codex --profile (W4)', () => {
  // Regression: Claude spawn must be byte-stable when new opts are absent
  it('[regression] claude spawn is byte-identical when grokRulesPath/codexProfileName absent', () => {
    const base = { engine: 'claude', budget: 50, effortLevel: 'medium', maxTurns: 100, maxOutputTokens: 16000 }
    const withoutNew = buildClaudeCommand(base)
    const withUndefined = buildClaudeCommand({ ...base, grokRulesPath: undefined, codexProfileName: undefined })
    expect(withoutNew).toBe(withUndefined)
    // Still emits --mcp-config when path provided
    const withMcp = buildClaudeCommand({ ...base, mcpConfigPath: '/tmp/foo.json' })
    expect(withMcp).toContain('--mcp-config "/tmp/foo.json"')
    expect(withMcp).not.toContain('--rules')
    expect(withMcp).not.toContain('--profile')
  })

  it('grok emits --rules when grokRulesPath is provided', () => {
    const cmd = buildClaudeCommand({
      engine: 'grok', budget: 50, effortLevel: 'medium', model: 'grok-4.6', maxTurns: 150,
      grokRulesPath: '/tmp/cc-scripts/sess-abc.grok-rules.md',
    })
    expect(cmd).toContain('--rules "/tmp/cc-scripts/sess-abc.grok-rules.md"')
    // Must not get --mcp-config (that's Claude-only)
    expect(cmd).not.toContain('--mcp-config')
  })

  it('grok omits --rules when grokRulesPath is absent', () => {
    const cmd = buildClaudeCommand({ engine: 'grok', budget: 50, effortLevel: 'medium', maxTurns: 100 })
    expect(cmd).not.toContain('--rules')
  })

  it('grok JSON-quotes --rules path so a crafted path cannot break the bash wrapper', () => {
    const cmd = buildClaudeCommand({
      engine: 'grok', budget: 50, effortLevel: 'medium',
      grokRulesPath: '/tmp/cc-scripts/x"; rm -rf / #',
    })
    expect(cmd).toContain('--rules "/tmp/cc-scripts/x\\"; rm -rf / #"')
    expect(cmd).not.toMatch(/--rules \/tmp\/cc-scripts\/x"; rm/)
  })

  it('codex emits --profile when codexProfileName is provided', () => {
    const cmd = buildClaudeCommand({
      engine: 'codex', budget: 50, effortLevel: 'medium',
      codexProfileName: 'sess-xyz789',
    })
    expect(cmd).toContain('--profile "sess-xyz789"')
    // Must not get --mcp-config (that's Claude-only)
    expect(cmd).not.toContain('--mcp-config')
    // Must NOT have --ignore-user-config (base config must be preserved)
    expect(cmd).not.toContain('--ignore-user-config')
  })

  it('codex omits --profile when codexProfileName is absent', () => {
    const cmd = buildClaudeCommand({ engine: 'codex', budget: 50, effortLevel: 'medium' })
    expect(cmd).not.toContain('--profile')
  })

  it('codex with --profile still carries dangerously-bypass, skip-git-repo-check, and -c effort', () => {
    const cmd = buildClaudeCommand({
      engine: 'codex', budget: 50, effortLevel: 'high',
      codexProfileName: 'sess-withprofile',
    })
    expect(cmd).toContain('--dangerously-bypass-approvals-and-sandbox')
    expect(cmd).toContain('--skip-git-repo-check')
    expect(cmd).toContain('-c model_reasoning_effort="high"')
    expect(cmd).toContain('--profile "sess-withprofile"')
  })

  it('claude with mcpConfigPath does not emit --profile or --rules (Claude-only path unchanged)', () => {
    const cmd = buildClaudeCommand({
      engine: 'claude', budget: 50, effortLevel: 'medium', maxTurns: 100, maxOutputTokens: 16000,
      mcpConfigPath: '/tmp/session.mcp.json',
      codexProfileName: 'ignored',
      grokRulesPath: '/tmp/ignored.md',
    })
    expect(cmd).toContain('--mcp-config "/tmp/session.mcp.json"')
    expect(cmd).not.toContain('--profile')
    expect(cmd).not.toContain('--rules')
  })
})

// W4b — Codex overlay path regression.
// The call site in session-tmux.ts must pass codexConfigHome(CODEX_HOME_DIR), not
// CODEX_HOME_DIR directly.  Codex --profile loads $CODEX_HOME/<name>.config.toml
// where $CODEX_HOME defaults to ~/.codex (= <unixHome>/.codex), so the dir passed
// to writeCodexMcpProfile must be <unixHome>/.codex — one level deeper than unix HOME.
describe('codexConfigHome — overlay path contract (W4b)', () => {
  it('returns <unixHome>/.codex, not <unixHome>', () => {
    const unixHome = '/home/ccuser-codex'
    const result = codexConfigHome(unixHome)
    expect(result).toBe(path.join(unixHome, '.codex'))
    // Confirm it is NOT the unix home itself (the pre-fix call site bug)
    expect(result).not.toBe(unixHome)
  })

  it('profile file therefore lands at <unixHome>/.codex/<sessionId>.config.toml', () => {
    const unixHome = '/home/ccuser-codex'
    const sessionId = 'sess-abc123'
    const profilePath = path.join(codexConfigHome(unixHome), `${sessionId}.config.toml`)
    // Correct: inside .codex/
    expect(profilePath).toBe('/home/ccuser-codex/.codex/sess-abc123.config.toml')
    // Wrong (pre-fix): directly under unix home
    expect(profilePath).not.toBe('/home/ccuser-codex/sess-abc123.config.toml')
  })
})
