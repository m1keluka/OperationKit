import { describe, it, expect } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

// Point the session-manager's scratch dir at a private temp dir BEFORE importing it
// (the module reads CC_SCRIPT_DIR once, at load time), so this test never depends on
// a writable /tmp/cc-scripts existing on the host.
process.env.CC_SCRIPT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-scripts-test-'))

describe('writeReviewerPlaywrightMcpConfig — explicit Playwright registration for the reviewer', () => {
  it('writes a config the reviewer session loads via --mcp-config, containing the playwright server', async () => {
    const { writeReviewerPlaywrightMcpConfig } = await import('./session-manager.js')
    const cfgPath = writeReviewerPlaywrightMcpConfig('test-session-mcp', '/home/ccuser-e')
    expect(cfgPath).toBeTruthy()
    const parsed = JSON.parse(fs.readFileSync(cfgPath as string, 'utf-8'))
    // The exact shape Claude Code's --mcp-config expects.
    expect(parsed.mcpServers).toBeDefined()
    expect(parsed.mcpServers.playwright).toBeDefined()
    expect(parsed.mcpServers.playwright.command).toBe('npx')
    const args: string[] = parsed.mcpServers.playwright.args
    expect(args).toContain('@playwright/mcp@latest')
    expect(args).toContain('--headless')
    expect(args).toContain('--no-sandbox')
    // Per-account writable profile dir under THIS home (not a root-owned default).
    expect(args).toContain('/home/ccuser-e/.cache/playwright-mcp')
    // An executable-path is pinned (resolved dynamically; falls back to a known path).
    const execIdx = args.indexOf('--executable-path')
    expect(execIdx).toBeGreaterThan(-1)
    expect(args[execIdx + 1]).toMatch(/chromium-\d+\/chrome-linux64\/chrome$/)
    fs.unlinkSync(cfgPath as string)
  })
})
