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
const { buildAssistantDirective, buildGoogleMcpConfig } = await import('./mentor-session.js')
const { AGENTS_DIR } = await import('../config.js')

// The owner seed is OPT-IN (obj 709956): it fires only when the operator points
// ASSISTANT_AGENT_SLUG at a row that exists in the agent registry. A blank-slate
// install sets neither, so nothing persona-specific is seeded there — that path
// is covered by assistant-persona.test.ts.
const PERSONA_SLUG = 'ops-assistant'
const OWNER_EMAIL = 'owner@example.com'
process.env.ASSISTANT_AGENT_SLUG = PERSONA_SLUG
process.env.MENTOR_TELEGRAM_OWNER_USERNAME = 'owner'
process.env.ASSISTANT_OWNER_GOOGLE_EMAIL = OWNER_EMAIL
process.env.ASSISTANT_DISPLAY_NAME = 'Assistant'
process.env.ASSISTANT_TAGLINE = "The operator's personal admin assistant"

let ownerId: number
let aliceId: number

beforeAll(() => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
  const db = getDb()
  // Insert the owner AND the registry row for the configured persona BEFORE
  // re-running initDb, so the idempotent, opt-in owner seed fires.
  db.prepare("INSERT OR IGNORE INTO agents (slug, label, kind, assignable, workdir_kind) VALUES (?, 'Ops Assistant', 'routing-only', 1, 'workspace')").run(PERSONA_SLUG)
  const m = db.prepare("INSERT INTO users (username, password_hash, role) VALUES ('owner', '', 'admin')").run()
  ownerId = m.lastInsertRowid as number
  const a = db.prepare("INSERT INTO users (username, password_hash, role) VALUES ('alice', '', 'member')").run()
  aliceId = a.lastInsertRowid as number
  // Re-run init: proves idempotency AND seeds the owner config now that the owner exists.
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
  it('returns null for a missing user id (fail-closed, the legacy fail-closed owner check)', () => {
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

describe('generalized spawn — a non-owner gets a directive using THEIR displayName', () => {
  it('a default (non-owner) directive uses the configured displayName, not "Assistant"', () => {
    const cfg = resolveAssistantConfig(aliceId, 'example')!
    const d = buildAssistantDirective(cfg, 99)
    expect(d.startsWith('ASSISTANT PROFILE — this session is Assistant.')).toBe(true)
    expect(d).not.toContain('JARVIS')
    // pending location is per-thread + global loops, driven by the generic path.
    expect(d).toContain('/threads/99/pending.md')
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

describe('opt-in owner seed — persona resolved from the agent registry', () => {
  const THREAD = 42
  const MANUAL = `${AGENTS_DIR}/${PERSONA_SLUG}.md`

  // Rule-bearing invariants the config-driven directive must carry. They are now
  // DATA on the seeded row (derived from the registry) rather than string
  // literals compiled into mentor-session.ts.
  const INVARIANTS = [
    // manual pointer — derived from the registry slug + AGENTS_DIR, not hardcoded
    MANUAL,
    // connector identity — from ASSISTANT_OWNER_GOOGLE_EMAIL, not hardcoded
    `user_google_email: "${OWNER_EMAIL}"`,
    // capability map
    'The Command Center board internal API at http://localhost:3002/api/internal/',
    // confirmation-gating rules: the gated-action set (identical text)
    'machine are two-step. Gated: sending email; calendar create/modify WITH\nattendees; POSTing board objectives; Drive share/permission change/delete;\ndeleting any Google content; anything messaging a human or changing a shared\nsystem.',
    // the two-step protocol
    'Propose → Persist the pending action →\nResolve the MOST RECENT pending on an affirmative (then delete it) → Cancel on\na negation. The persisted entry IS the gate state.',
  ]

  it('seeds the owner config with a manual path derived from the registry row', () => {
    const cfg = resolveAssistantConfig(ownerId, 'example')
    expect(cfg).not.toBeNull()
    expect(cfg!.persona.displayName).toBe('Assistant')
    expect(cfg!.enabled).toBe(true)
    expect(cfg!.autonomy.level).toBe('confirm_external')
    expect(cfg!.persona.manualSource?.locator).toBe(MANUAL)
    expect(cfg!.connectorBindings?.['google-workspace']?.identity).toBe(OWNER_EMAIL)
  })

  it('no hardcoded persona slug or persona path survives in the seeded row', () => {
    const cfg = resolveAssistantConfig(ownerId, 'example')!
    const blob = JSON.stringify(cfg)
    expect(blob).not.toContain('agents/assistant.md')
    expect(blob).not.toContain('mike@')
  })

  it('buildAssistantDirective renders persona, gating and per-thread pending from the config', () => {
    const cfg = resolveAssistantConfig(ownerId, 'example')!
    const generated = buildAssistantDirective(cfg, THREAD)

    // 1. Persona header line comes from the config (name + tagline).
    expect(generated.split('\n')[0]).toContain('Assistant')

    // 2. Every rule-bearing invariant is carried over.
    for (const inv of INVARIANTS) {
      expect(generated, `generated must contain invariant: ${inv.slice(0, 40)}`).toContain(inv)
    }

    // 3. Per-thread pending + global loops paths preserved.
    expect(generated).toContain(`/threads/${THREAD}/pending.md`)
    expect(generated).toContain('/loops.md')
    expect(generated.toUpperCase()).toContain('GLOBAL')

    // 4. Confirmation semantics present.
    expect(generated.toLowerCase()).toContain('confirmation')
    expect(generated.toLowerCase()).toContain('two-step')

    // 5. Human-voice block is in the live directive.
    expect(generated).toContain('## Talking to the human')
    expect(generated).toContain('Anything you can do with an API, Playwright, Google, GitHub, or the filesystem')
  })

  it('the owner keeps the seeded Google identity in the MCP config', () => {
    const cfg = resolveAssistantConfig(ownerId, 'example')!
    const ORIG_ID = process.env.GOOGLE_OAUTH_CLIENT_ID
    const ORIG_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET
    process.env.GOOGLE_OAUTH_CLIENT_ID = 'cid'
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'csec'
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-owner-'))
    try {
      const { mcpServers, hasGoogle } = buildGoogleMcpConfig(homeDir, cfg)
      expect(hasGoogle).toBe(true)
      const gw = mcpServers['google-workspace'] as { env: Record<string, string> }
      expect(gw.env.USER_GOOGLE_EMAIL).toBe(OWNER_EMAIL)
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true })
      if (ORIG_ID === undefined) delete process.env.GOOGLE_OAUTH_CLIENT_ID; else process.env.GOOGLE_OAUTH_CLIENT_ID = ORIG_ID
      if (ORIG_SECRET === undefined) delete process.env.GOOGLE_OAUTH_CLIENT_SECRET; else process.env.GOOGLE_OAUTH_CLIENT_SECRET = ORIG_SECRET
    }
  })
})
