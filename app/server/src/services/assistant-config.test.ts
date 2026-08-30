import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

// Real SQLite so the assistant_configs migration + owner seed + resolver are
// exercised end to end. DB_PATH must be set before importing the db module
// (the path is captured at import time).
const TMP_DB = path.join(os.tmpdir(), `cc-assistant-config-test-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB

const { initDb, getDb } = await import('../db/index.js')
const {
  resolveAssistantConfig,
  upsertAssistantConfig,
  getAssistantConfigForThread,
} = await import('./assistant-config.js')
const { buildAssistantDirective, buildLegacyAssistantDirective, buildGoogleMcpConfig } = await import('./mentor-session.js')

let ownerId: number
let aliceId: number

beforeAll(() => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
  const db = getDb()
  // Insert the owner BEFORE re-running initDb so the idempotent owner seed fires
  // (the seed looks up username === MENTOR_TELEGRAM_OWNER_USERNAME||'admin').
  const m = db.prepare("INSERT INTO users (username, password_hash, role) VALUES ('admin', '', 'admin')").run()
  ownerId = m.lastInsertRowid as number
  const a = db.prepare("INSERT INTO users (username, password_hash, role) VALUES ('alice', '', 'member')").run()
  aliceId = a.lastInsertRowid as number
  // Re-run init: proves idempotency AND seeds the owner config now that admin exists.
  initDb()
})

afterAll(() => {
  try { getDb().close() } catch {}
  for (const suffix of ['', '-wal', '-shm']) {
    const f = `${TMP_DB}${suffix}`
    if (fs.existsSync(f)) fs.unlinkSync(f)
  }
})

describe('assistant_configs migration', () => {
  it('creates the table with the expected columns and is re-run safe', () => {
    initDb() // third run — must not throw or duplicate the owner seed
    const cols = (getDb().prepare('PRAGMA table_info(assistant_configs)').all() as { name: string }[]).map(c => c.name)
    for (const c of ['user_id', 'workspace', 'display_name', 'system_prompt', 'autonomy', 'enabled_connectors', 'connector_bindings', 'enabled', 'created_at', 'updated_at']) {
      expect(cols).toContain(c)
    }
    const ownerRows = getDb().prepare('SELECT COUNT(*) AS n FROM assistant_configs WHERE user_id = ?').get(ownerId) as { n: number }
    expect(ownerRows.n).toBe(1) // seed is idempotent across re-runs
  })
})

describe('resolveAssistantConfig — create-on-read + workspace fallback', () => {
  it('returns null for a missing user id (fail-closed, like isOwnerThread(null))', () => {
    expect(resolveAssistantConfig(null, 'example')).toBeNull()
    expect(resolveAssistantConfig(undefined, 'example')).toBeNull()
  })

  it('create-on-read: a user with no row gets a persisted enabled default', () => {
    const before = getDb().prepare('SELECT COUNT(*) AS n FROM assistant_configs WHERE user_id = ?').get(aliceId) as { n: number }
    expect(before.n).toBe(0)

    const cfg = resolveAssistantConfig(aliceId, 'example')
    expect(cfg).not.toBeNull()
    expect(cfg!.userId).toBe(aliceId)
    expect(cfg!.workspace).toBe('example')
    expect(cfg!.persona.displayName).toBe('Assistant')
    expect(cfg!.enabled).toBe(true)
    expect(cfg!.autonomy.level).toBe('confirm_external')

    // Persisted (create-on-read wrote the row).
    const after = getDb().prepare('SELECT COUNT(*) AS n FROM assistant_configs WHERE user_id = ?').get(aliceId) as { n: number }
    expect(after.n).toBe(1)
  })

  it('workspace fallback: a second workspace reuses the user default identity (no new row)', () => {
    const cfg = resolveAssistantConfig(aliceId, 'example3')
    expect(cfg).not.toBeNull()
    // Falls back to alice's default identity row (workspace 'example'), NOT a new default.
    expect(cfg!.persona.displayName).toBe('Assistant')
    expect(cfg!.workspace).toBe('example')
    const rows = getDb().prepare('SELECT COUNT(*) AS n FROM assistant_configs WHERE user_id = ?').get(aliceId) as { n: number }
    expect(rows.n).toBe(1) // fallback did NOT create a example3 row
  })

  it('a per-workspace override via upsert wins over the fallback identity', () => {
    const override = upsertAssistantConfig(aliceId, 'example3', { persona: { displayName: 'Grassy', systemPrompt: 'gf' } })
    expect(override.workspace).toBe('example3')
    expect(override.persona.displayName).toBe('Grassy')
    // Now resolving example3 hits the exact override, not the example identity.
    const resolved = resolveAssistantConfig(aliceId, 'example3')
    expect(resolved!.persona.displayName).toBe('Grassy')
    // example identity is untouched.
    expect(resolveAssistantConfig(aliceId, 'example')!.persona.displayName).toBe('Assistant')
  })
})

describe('generalized spawn — non-owner gets a directive using THEIR displayName', () => {
  it('default directive uses the configured displayName and carries no owner tagline', () => {
    const cfg = resolveAssistantConfig(aliceId, 'example')!
    const d = buildAssistantDirective(cfg, 99)
    expect(d.startsWith('ASSISTANT PROFILE — this session is Assistant.')).toBe(true)
    expect(d).not.toContain('ASSISTANT PROFILE — this session is Assistant,')
    // pending location is per-thread + global loops, driven by the generic path.
    expect(d).toContain('/home/operator/assistant/threads/99/pending.md')
    expect(d.toUpperCase()).toContain('GLOBAL')
  })

  it('a renamed assistant is reflected in the directive header', () => {
    const updated = upsertAssistantConfig(aliceId, 'example', { persona: { displayName: 'Ada', tagline: 'ops copilot', systemPrompt: 'You are Ada.' } })
    const d = buildAssistantDirective(updated, 7)
    expect(d.startsWith('ADA PROFILE — this session is Ada, ops copilot.')).toBe(true)
    expect(d).toContain('You are Ada.')
  })

  it('a user with no google connector gets no Google MCP (fail-closed)', () => {
    const cfg = resolveAssistantConfig(aliceId, 'example')!
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-alice-'))
    try {
      const { hasGoogle } = buildGoogleMcpConfig(homeDir, cfg)
      expect(hasGoogle).toBe(false)
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true })
    }
  })

  it('getAssistantConfigForThread resolves from the thread creator + workspace', () => {
    const db = getDb()
    const t = db.prepare("INSERT INTO mentor_threads (title, workspace, created_by) VALUES ('t', 'example', ?)").run(aliceId)
    const threadId = t.lastInsertRowid as number
    const cfg = getAssistantConfigForThread(threadId)
    expect(cfg).not.toBeNull()
    expect(cfg!.userId).toBe(aliceId)
    // legacy thread with no creator → null (fail-closed)
    const t2 = db.prepare("INSERT INTO mentor_threads (title, workspace, created_by) VALUES ('legacy', 'example', NULL)").run()
    expect(getAssistantConfigForThread(t2.lastInsertRowid as number)).toBeNull()
  })
})

describe('admin-lossless — seeded owner config reproduces the legacy Assistant directive', () => {
  const THREAD = 42

  // Rule-bearing invariants that MUST carry over verbatim from the pre-change
  // buildLegacyAssistantDirective into the config-driven buildAssistantDirective.
  const INVARIANTS = [
    // manual pointer
    '/home/operator/ai-workspace/agents/assistant.md',
    // Google identity (email) — now sourced from persona systemPrompt data
    'user_google_email: "dev@example.com"',
    // capability map
    'The Command Center board internal API at http://localhost:3002/api/internal/',
    '/home/operator/second-brain',
    // confirmation-gating rules: the gated-action set (identical text)
    'machine are two-step. Gated: sending email; calendar create/modify WITH\nattendees; POSTing board objectives; Drive share/permission change/delete;\ndeleting any Google content; anything messaging a human or changing a shared\nsystem.',
    // the two-step protocol
    'Propose → Persist the pending action →\nResolve the MOST RECENT pending on an affirmative (then delete it) → Cancel on\na negation. The persisted entry IS the gate state.',
  ]

  it('the owner is seeded an assistant config', () => {
    const cfg = resolveAssistantConfig(ownerId, 'example')
    expect(cfg).not.toBeNull()
    expect(cfg!.persona.displayName).toBe('Assistant')
    expect(cfg!.enabled).toBe(true)
    expect(cfg!.autonomy.level).toBe('confirm_external')
    expect(cfg!.persona.manualSource?.locator).toBe('/home/operator/ai-workspace/agents/assistant.md')
    expect(cfg!.connectorBindings?.['google-workspace']?.identity).toBe('dev@example.com')
  })

  it('buildAssistantDirective(ownerConfig) is semantically equivalent to buildLegacyAssistantDirective', () => {
    const cfg = resolveAssistantConfig(ownerId, 'example')!
    const generated = buildAssistantDirective(cfg, THREAD)
    const legacy = buildLegacyAssistantDirective(THREAD)

    // 1. Persona header line is byte-identical (name + tagline).
    expect(generated.split('\n')[0]).toBe(legacy.split('\n')[0])
    expect(generated.split('\n')[0]).toBe("ASSISTANT PROFILE — this session is Assistant, the operator's personal admin assistant.")

    // 2. Every rule-bearing invariant appears in BOTH (carried over verbatim).
    for (const inv of INVARIANTS) {
      expect(legacy, `legacy must contain invariant: ${inv.slice(0, 40)}`).toContain(inv)
      expect(generated, `generated must contain invariant: ${inv.slice(0, 40)}`).toContain(inv)
    }

    // 3. Per-thread pending + global loops paths preserved.
    expect(generated).toContain(`/home/operator/assistant/threads/${THREAD}/pending.md`)
    expect(generated).toContain('/home/operator/assistant/loops.md')
    expect(generated.toUpperCase()).toContain('GLOBAL')

    // 4. Confirmation semantics present.
    expect(generated.toLowerCase()).toContain('confirmation')
    expect(generated.toLowerCase()).toContain('two-step')

    // 5. Human-voice block is in the live directive (not the legacy snapshot).
    expect(generated).toContain('## Talking to the human')
    expect(generated).toContain('Anything you can do with an API, Playwright, Google, GitHub, or the filesystem')
    expect(generated).not.toContain('Talking to Operator')
  })

  it('the owner keeps his Google identity in the MCP config', () => {
    const cfg = resolveAssistantConfig(ownerId, 'example')!
    const ORIG_ID = process.env.GOOGLE_OAUTH_CLIENT_ID
    const ORIG_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET
    process.env.GOOGLE_OAUTH_CLIENT_ID = 'cid'
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'csec'
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-admin-'))
    try {
      const { mcpServers, hasGoogle } = buildGoogleMcpConfig(homeDir, cfg)
      expect(hasGoogle).toBe(true)
      const gw = mcpServers['google-workspace'] as { env: Record<string, string> }
      expect(gw.env.USER_GOOGLE_EMAIL).toBe('dev@example.com')
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true })
      if (ORIG_ID === undefined) delete process.env.GOOGLE_OAUTH_CLIENT_ID; else process.env.GOOGLE_OAUTH_CLIENT_ID = ORIG_ID
      if (ORIG_SECRET === undefined) delete process.env.GOOGLE_OAUTH_CLIENT_SECRET; else process.env.GOOGLE_OAUTH_CLIENT_SECRET = ORIG_SECRET
    }
  })
})
