import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

// Real SQLite — the Assistant-profile owner gate (isMikeThread) resolves
// created_by → users.username. The MCP-config builder + directive are pure
// (file + env), so we exercise them directly.

const TMP_DB = path.join(os.tmpdir(), `cc-mentor-session-test-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB

const { initDb, getDb } = await import('../db/index.js')
const { isMikeThread, buildGoogleMcpConfig, buildAssistantDirective } = await import('./mentor-session.js')
const { defaultAssistantConfig } = await import('./assistant-config.js')

let mikeId: number
let memberId: number

beforeAll(() => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
  const db = getDb()
  const m = db.prepare("INSERT INTO users (username, password_hash, role) VALUES ('mike', '', 'admin')").run()
  mikeId = m.lastInsertRowid as number
  const u = db.prepare("INSERT INTO users (username, password_hash, role) VALUES ('alice', '', 'member')").run()
  memberId = u.lastInsertRowid as number
})

afterAll(() => {
  try { getDb().close() } catch {}
  for (const suffix of ['', '-wal', '-shm']) {
    const f = `${TMP_DB}${suffix}`
    if (fs.existsSync(f)) fs.unlinkSync(f)
  }
})

describe('isMikeThread — Assistant profile owner gate', () => {
  const ORIG = process.env.MENTOR_TELEGRAM_OWNER_USERNAME
  afterEach(() => {
    if (ORIG === undefined) delete process.env.MENTOR_TELEGRAM_OWNER_USERNAME
    else process.env.MENTOR_TELEGRAM_OWNER_USERNAME = ORIG
  })

  it('returns true for the admin owner (default username "mike")', () => {
    delete process.env.MENTOR_TELEGRAM_OWNER_USERNAME
    expect(isMikeThread(mikeId)).toBe(true)
  })

  it('returns false for a non-owner member', () => {
    delete process.env.MENTOR_TELEGRAM_OWNER_USERNAME
    expect(isMikeThread(memberId)).toBe(false)
  })

  it('returns false for null created_by (legacy threads — fail closed)', () => {
    expect(isMikeThread(null)).toBe(false)
  })

  it('returns false for an unknown user id', () => {
    expect(isMikeThread(999999)).toBe(false)
  })

  it('honors MENTOR_TELEGRAM_OWNER_USERNAME override', () => {
    process.env.MENTOR_TELEGRAM_OWNER_USERNAME = 'alice'
    expect(isMikeThread(memberId)).toBe(true)
    expect(isMikeThread(mikeId)).toBe(false)
  })
})

describe('buildGoogleMcpConfig — MCP config builder shape', () => {
  let homeDir: string
  const ORIG_ID = process.env.GOOGLE_OAUTH_CLIENT_ID
  const ORIG_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET

  beforeEach(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-home-'))
  })
  afterEach(() => {
    fs.rmSync(homeDir, { recursive: true, force: true })
    if (ORIG_ID === undefined) delete process.env.GOOGLE_OAUTH_CLIENT_ID
    else process.env.GOOGLE_OAUTH_CLIENT_ID = ORIG_ID
    if (ORIG_SECRET === undefined) delete process.env.GOOGLE_OAUTH_CLIENT_SECRET
    else process.env.GOOGLE_OAUTH_CLIENT_SECRET = ORIG_SECRET
  })

  const googleCfg = {
    userId: 1,
    workspace: 'example',
    enabledConnectors: ['google-workspace'],
    connectorBindings: { 'google-workspace': { identity: 'dev@example.com', credentialRef: 'env:GOOGLE_CREDENTIALS_DIR' } },
    enabled: true,
  } as unknown as import('@operationkit/shared').AssistantConfig

  it('injects google-workspace for THAT user, never the shared multi-account folder', () => {
    process.env.GOOGLE_OAUTH_CLIENT_ID = 'cid-123'
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'csecret-456'
    const { mcpServers, hasGoogle } = buildGoogleMcpConfig(homeDir, googleCfg)
    expect(hasGoogle).toBe(true)
    const gw = mcpServers['google-workspace'] as { command: string; args: string[]; env: Record<string, string> }
    expect(gw.command).toBe(`${homeDir}/.local/bin/uvx`)
    expect(gw.args).toEqual(['workspace-mcp', '--tools', 'gmail', 'calendar', 'drive', 'docs', 'sheets', 'slides', '--tool-tier', 'extended'])
    expect(gw.env.GOOGLE_OAUTH_CLIENT_ID).toBe('cid-123')
    expect(gw.env.GOOGLE_OAUTH_CLIENT_SECRET).toBe('csecret-456')
    expect(gw.env.USER_GOOGLE_EMAIL).toBe('dev@example.com')
    expect(gw.env.WORKSPACE_MCP_CREDENTIALS_DIR).not.toBe('/home/operator/assistant/google-credentials')
    expect(gw.env.WORKSPACE_MCP_CREDENTIALS_DIR).toContain('google-creds')
  })

  it('deletes stale google-gmail / google-workspace entries from the home mcp.json, keeps others', () => {
    process.env.GOOGLE_OAUTH_CLIENT_ID = 'cid'
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'csec'
    fs.mkdirSync(path.join(homeDir, '.claude'), { recursive: true })
    fs.writeFileSync(path.join(homeDir, '.claude', 'mcp.json'), JSON.stringify({
      mcpServers: {
        'google-gmail': { command: 'stale' },
        'google-workspace': { command: 'stale-drive-mcp' },
        'some-other': { command: 'keepme' },
      },
    }))
    const { mcpServers, hasGoogle } = buildGoogleMcpConfig(homeDir, googleCfg)
    expect(hasGoogle).toBe(true)
    expect(mcpServers['some-other']).toEqual({ command: 'keepme' })
    expect((mcpServers['google-workspace'] as { command: string }).command).toBe(`${homeDir}/.local/bin/uvx`)
    expect(mcpServers['google-gmail']).toBeUndefined()
  })

  it('with no per-user config, does not fall back to mike@ or the shared credential dir', () => {
    process.env.GOOGLE_OAUTH_CLIENT_ID = 'cid'
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'csec'
    const { mcpServers, hasGoogle } = buildGoogleMcpConfig(homeDir)
    expect(hasGoogle).toBe(false)
    expect(mcpServers['google-workspace']).toBeUndefined()
  })
})

// The hardcoded Assistant directive (a literal `assistant` slug + a literal
// `<ai-workspace>/agents/assistant.md` path compiled into this module) was
// deleted in obj 709956, Phase 4. The directive is now built entirely from the
// caller's assistant_configs row, so these tests drive the generic builder with
// a config whose persona data stands in for what used to be string literals.
describe('buildAssistantDirective — persona + gating + per-thread pending', () => {
  const MANUAL = '/srv/personas/ops-assistant.md'
  const cfgWithManual = () => {
    const cfg = defaultAssistantConfig(1, 'default')
    cfg.persona.displayName = 'Assistant'
    cfg.persona.systemPrompt = [
      `Read ${MANUAL} NOW as your complete operating manual. It SUPERSEDES the`,
      'mentor-workspace CLAUDE.md and any other persona.',
      '- The Command Center board internal API at http://localhost:3002/api/internal/...',
      '- Vault retrieval over /srv/vault (active.md → index.md → kb_search).',
    ].join('\n')
    return cfg
  }

  it('carries the operating-manual pointer from config DATA, not a compiled-in path', () => {
    const d = buildAssistantDirective(cfgWithManual(), 42)
    expect(d).toContain(MANUAL)
    expect(d.toLowerCase()).toContain('supersede')
    // the deleted hardcode must not reappear
    expect(d).not.toContain('agents/assistant.md')
  })

  it('pins pending confirmations PER THREAD and loops GLOBAL', () => {
    const d = buildAssistantDirective(cfgWithManual(), 42)
    expect(d).toContain('/threads/42/pending.md')
    expect(d).toContain('/loops.md')
    expect(d.toUpperCase()).toContain('GLOBAL')
  })

  it('points at the CC internal API and vault retrieval', () => {
    const d = buildAssistantDirective(cfgWithManual(), 7)
    expect(d).toContain('http://localhost:3002/api/internal/')
    expect(d).toContain('/srv/vault')
  })

  it('states the confirmation-gating contract', () => {
    const d = buildAssistantDirective(cfgWithManual(), 1)
    expect(d.toLowerCase()).toContain('confirmation')
    expect(d.toLowerCase()).toContain('two-step')
  })
})
