import { describe, it, expect } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { buildPlaywrightMcpArgs } from './session-reviewer-prompt.js'
import { resolveBrowserPolicy } from '../lib/browser-policy.js'
import { PLAYWRIGHT_MCP_VERSION } from '../lib/browser-pins.js'

// Point the session-manager's scratch dir at a private temp dir BEFORE importing it
// (the module reads CC_SCRIPT_DIR once, at load time), so this test never depends on
// a writable /tmp/cc-scripts existing on the host.
process.env.CC_SCRIPT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-scripts-test-'))

/** The stock install's policy, with the install's own domain set. */
const stock = () => resolveBrowserPolicy({ OK_DOMAIN: 'ops.example.com' } as NodeJS.ProcessEnv)

describe('writeReviewerPlaywrightMcpConfig — explicit Playwright registration for the reviewer', () => {
  it('writes a config the reviewer session loads via --mcp-config, containing the playwright server', async () => {
    // The egress guard is not running in a unit test, and the writer fails
    // CLOSED when it is supposed to be. Turn it off explicitly for this case —
    // that is the documented way to accept an unguarded browser, and the shape
    // of the config is what this test is about.
    const prev = process.env.CARD_BROWSER_EGRESS_GUARD
    process.env.CARD_BROWSER_EGRESS_GUARD = 'off'
    try {
      const { writeReviewerPlaywrightMcpConfig } = await import('./session-manager.js')
      const cfgPath = writeReviewerPlaywrightMcpConfig('test-session-mcp', '/home/ccuser-e')
      expect(cfgPath).toBeTruthy()
      const parsed = JSON.parse(fs.readFileSync(cfgPath as string, 'utf-8'))
      // The exact shape Claude Code's --mcp-config expects.
      expect(parsed.mcpServers).toBeDefined()
      expect(parsed.mcpServers.playwright).toBeDefined()
      expect(parsed.mcpServers.playwright.command).toBe('npx')
      const args: string[] = parsed.mcpServers.playwright.args
      // PINNED, never `@latest` (obj 900024).
      expect(args).toContain(`@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}`)
      expect(args).not.toContain('@playwright/mcp@latest')
      expect(args).toContain('--headless')
      // The OS sandbox stays ON unless an operator explicitly disables it.
      expect(args).toContain('--sandbox')
      expect(args).not.toContain('--no-sandbox')
      // Per-account writable profile dir under THIS home (not a root-owned default).
      expect(args).toContain('/home/ccuser-e/.cache/playwright-mcp')
      // An executable-path is pinned (resolved dynamically; falls back to a known path).
      const execIdx = args.indexOf('--executable-path')
      expect(execIdx).toBeGreaterThan(-1)
      expect(args[execIdx + 1]).toMatch(/chromium-\d+\/chrome-linux64\/chrome$/)
      fs.unlinkSync(cfgPath as string)
    } finally {
      if (prev === undefined) delete process.env.CARD_BROWSER_EGRESS_GUARD
      else process.env.CARD_BROWSER_EGRESS_GUARD = prev
    }
  })

  it('FAILS CLOSED: registers no browser at all when the egress guard should be running but is not', async () => {
    const prev = process.env.CARD_BROWSER_EGRESS_GUARD
    delete process.env.CARD_BROWSER_EGRESS_GUARD   // default = guard ON
    try {
      const { writeReviewerPlaywrightMcpConfig } = await import('./session-manager.js')
      // No guard was started in this process, so the only safe answer is "no browser".
      expect(writeReviewerPlaywrightMcpConfig('test-session-failclosed', '/home/ccuser-e')).toBeNull()
    } finally {
      if (prev !== undefined) process.env.CARD_BROWSER_EGRESS_GUARD = prev
    }
  })
})

describe('buildPlaywrightMcpArgs — the launch contract', () => {
  it('passes the origin policy to Playwright as well as to the proxy', () => {
    const args = buildPlaywrightMcpArgs('/profile', '/chrome', stock(), 3099)
    const allowIdx = args.indexOf('--allowed-origins')
    expect(allowIdx).toBeGreaterThan(-1)
    expect(args[allowIdx + 1]).toContain('https://ops.example.com')
    expect(args[allowIdx + 1]).toContain('http://localhost:*')
    const blockIdx = args.indexOf('--blocked-origins')
    expect(blockIdx).toBeGreaterThan(-1)
    expect(args[blockIdx + 1]).toContain('169.254.169.254')
  })

  it('points Chromium at the loopback egress guard', () => {
    const args = buildPlaywrightMcpArgs('/profile', '/chrome', stock(), 3099)
    const i = args.indexOf('--proxy-server')
    expect(i).toBeGreaterThan(-1)
    expect(args[i + 1]).toBe('http://127.0.0.1:3099')
  })

  it('blocks service workers', () => {
    expect(buildPlaywrightMcpArgs('/profile', '/chrome', stock(), 3099)).toContain('--block-service-workers')
  })

  it('forces loopback through the proxy when loopback is NOT allowed', () => {
    const strict = resolveBrowserPolicy({ CARD_BROWSER_ALLOW_LOOPBACK: 'off' } as NodeJS.ProcessEnv)
    const args = buildPlaywrightMcpArgs('/profile', '/chrome', strict, 3099)
    const i = args.indexOf('--proxy-bypass')
    expect(i).toBeGreaterThan(-1)
    expect(args[i + 1]).toBe('<-loopback>')
  })

  it('does not set a proxy bypass in the default (loopback-allowed) case', () => {
    expect(buildPlaywrightMcpArgs('/profile', '/chrome', stock(), 3099)).not.toContain('--proxy-bypass')
  })

  it('only passes --no-sandbox when an operator explicitly disabled the sandbox', () => {
    const off = resolveBrowserPolicy({ CARD_BROWSER_SANDBOX: 'off' } as NodeJS.ProcessEnv)
    const args = buildPlaywrightMcpArgs('/profile', '/chrome', off, null)
    expect(args).toContain('--no-sandbox')
    expect(args).not.toContain('--sandbox')
  })
})
