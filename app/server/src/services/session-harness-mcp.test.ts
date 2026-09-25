import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { writeGrokMcpConfig, writeCodexMcpProfile, writeGrokVocabShim } from './session-harness-mcp.js'

// Helpers shared across tests
let tmpDir: string

function mkTmp() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-mcp-test-'))
}

function cleanTmp() {
  fs.rmSync(tmpDir, { recursive: true, force: true })
}

function writeMcpJson(servers: Record<string, unknown>) {
  const p = path.join(tmpDir, 'mcp.json')
  fs.writeFileSync(p, JSON.stringify({ mcpServers: servers }))
  return p
}

describe('writeGrokMcpConfig', () => {
  beforeEach(mkTmp)
  afterEach(cleanTmp)

  it('returns undefined when mcpConfigPath is undefined', () => {
    const result = writeGrokMcpConfig(tmpDir, undefined)
    expect(result).toBeUndefined()
    expect(fs.existsSync(path.join(tmpDir, '.grok', 'config.toml'))).toBe(false)
  })

  it('returns undefined when mcpConfigPath has no mcpServers', () => {
    const p = path.join(tmpDir, 'empty.json')
    fs.writeFileSync(p, JSON.stringify({ mcpServers: {} }))
    const result = writeGrokMcpConfig(tmpDir, p)
    expect(result).toBeUndefined()
  })

  it('writes .grok/config.toml with [mcp_servers.<name>] entries and returns the path', () => {
    const mcpPath = writeMcpJson({
      playwright: {
        command: 'npx',
        args: ['-y', '@playwright/mcp@latest', '--headless', '--no-sandbox'],
      },
    })
    const result = writeGrokMcpConfig(tmpDir, mcpPath)
    expect(result).toBe(path.join(tmpDir, '.grok', 'config.toml'))
    const content = fs.readFileSync(result!, 'utf8')
    expect(content).toContain('[mcp_servers.playwright]')
    expect(content).toContain('command = "npx"')
    expect(content).toContain('"@playwright/mcp@latest"')
    expect(content).toContain('enabled = true')
    // must NOT use singular 'mcp_server' (unknown-field in grok)
    expect(content).not.toMatch(/^\[mcp_server\./m)
  })

  it('writes env block under [mcp_servers.<name>.env] for servers with env', () => {
    const mcpPath = writeMcpJson({
      'google-workspace': {
        command: 'uvx',
        args: ['workspace-mcp', '--tools', 'gmail', 'drive'],
        env: {
          USER_GOOGLE_EMAIL: 'test@example.com',
          WORKSPACE_MCP_CREDENTIALS_DIR: '/tmp/creds',
        },
      },
    })
    const result = writeGrokMcpConfig(tmpDir, mcpPath)
    expect(result).toBeTruthy()
    const content = fs.readFileSync(result!, 'utf8')
    expect(content).toContain('[mcp_servers.google-workspace]')
    expect(content).toContain('[mcp_servers.google-workspace.env]')
    expect(content).toContain('USER_GOOGLE_EMAIL = "test@example.com"')
    expect(content).toContain('WORKSPACE_MCP_CREDENTIALS_DIR = "/tmp/creds"')
  })

  it('writes multiple servers in one config file', () => {
    const mcpPath = writeMcpJson({
      playwright: { command: 'npx', args: ['-y', '@playwright/mcp@latest'] },
      'google-workspace': { command: 'uvx', args: ['workspace-mcp'] },
    })
    const result = writeGrokMcpConfig(tmpDir, mcpPath)
    const content = fs.readFileSync(result!, 'utf8')
    expect(content).toContain('[mcp_servers.playwright]')
    expect(content).toContain('[mcp_servers.google-workspace]')
  })

  it('creates the .grok directory if it does not exist', () => {
    const workdir = path.join(tmpDir, 'fresh-worktree')
    fs.mkdirSync(workdir)
    const mcpPath = writeMcpJson({ playwright: { command: 'npx', args: [] } })
    writeGrokMcpConfig(workdir, mcpPath)
    expect(fs.existsSync(path.join(workdir, '.grok', 'config.toml'))).toBe(true)
  })
})

describe('writeCodexMcpProfile', () => {
  beforeEach(mkTmp)
  afterEach(cleanTmp)

  it('returns undefined when mcpConfigPath is undefined', () => {
    const result = writeCodexMcpProfile(tmpDir, 'test-session', undefined)
    expect(result).toBeUndefined()
  })

  it('returns undefined when mcpConfigPath has no servers', () => {
    const p = path.join(tmpDir, 'empty.json')
    fs.writeFileSync(p, JSON.stringify({ mcpServers: {} }))
    const result = writeCodexMcpProfile(tmpDir, 'test-session', p)
    expect(result).toBeUndefined()
  })

  it('writes <profileName>.config.toml and returns the profile name', () => {
    const mcpPath = writeMcpJson({
      'google-workspace': {
        command: 'uvx',
        args: ['workspace-mcp', '--tools', 'gmail'],
        env: { USER_GOOGLE_EMAIL: 'user@example.com' },
      },
    })
    const result = writeCodexMcpProfile(tmpDir, 'sess-abc123', mcpPath)
    expect(result).toBe('sess-abc123')
    const profilePath = path.join(tmpDir, 'sess-abc123.config.toml')
    expect(fs.existsSync(profilePath)).toBe(true)
    const content = fs.readFileSync(profilePath, 'utf8')
    expect(content).toContain('[mcp_servers.google-workspace]')
    expect(content).toContain('command = "uvx"')
    expect(content).toContain('enabled = true')
    expect(content).toContain('[mcp_servers.google-workspace.env]')
    expect(content).toContain('USER_GOOGLE_EMAIL = "user@example.com"')
  })

  it('does NOT include --ignore-user-config semantics (profile is additive)', () => {
    // The profile file itself only contains the session's servers —
    // the --profile flag layers it on top of the base config. Verify
    // the file does not contain base-config servers that would
    // duplicate or override the ambient ~/.codex/config.toml.
    const mcpPath = writeMcpJson({
      'google-workspace': { command: 'uvx', args: ['workspace-mcp'] },
    })
    writeCodexMcpProfile(tmpDir, 'sess-additive', mcpPath)
    const content = fs.readFileSync(path.join(tmpDir, 'sess-additive.config.toml'), 'utf8')
    // Only the session server, not a full replacement of the base config
    expect(content).toContain('[mcp_servers.google-workspace]')
    expect(content).not.toContain('[mcp_servers.playwright]')
    expect(content).not.toContain('[mcp_servers.n8n-mcp]')
  })
})

describe('writeGrokVocabShim', () => {
  beforeEach(mkTmp)
  afterEach(cleanTmp)

  it('writes a rules file and returns its path', () => {
    const result = writeGrokVocabShim(tmpDir, 'test-sess')
    expect(result).toBe(path.join(tmpDir, 'test-sess.grok-rules.md'))
    expect(fs.existsSync(result!)).toBe(true)
  })

  it('shim content maps mcp__google-workspace__* and mcp__playwright__* to MCP server names', () => {
    const result = writeGrokVocabShim(tmpDir, 'test-sess')
    const content = fs.readFileSync(result!, 'utf8')
    expect(content).toContain('google-workspace')
    expect(content).toContain('playwright')
    expect(content).toContain('mcp__google-workspace__*')
    expect(content).toContain('mcp__playwright__*')
  })

  it('shim content maps Claude Bash tool to shell equivalent', () => {
    const result = writeGrokVocabShim(tmpDir, 'test-sess')
    const content = fs.readFileSync(result!, 'utf8')
    expect(content).toContain('Bash')
  })
})
