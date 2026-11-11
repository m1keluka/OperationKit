/**
 * D4 (obj 900540) — allowlisted session env with a logging migration mode.
 * Fake secret names and values only.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import os from 'os'
import path from 'path'
import type { Objective } from '@operationkit/shared'
import { clearSecretAuditLogForTests } from '../__fixtures__/secret-audit-log.js'

process.env.CC_VERIFIED_SENDER_STAMPS = '0'
process.env.CC_SESSION_KB_ACCESS = '0'
process.env.SECRETS_MASTER_KEY = Buffer.alloc(32, 17).toString('base64')
process.env.DB_PATH = path.join(os.tmpdir(), `cc-d4-env-policy-${process.pid}-${Date.now()}.db`)
delete process.env.CC_SECRETS_SESSION_ENV_MODE

const { initDb, getDb } = await import('../db/index.js')
const store = await import('./secrets-store.js')
const policy = await import('./secret-env-policy.js')
const { buildSpawnEnv } = await import('./session-spawn-env.js')
const { buildSecretsInventoryBlock } = await import('./session-trust-prompt.js')
const cli = await import('../scripts/secrets-env-allowlist.js')

function obj(over: Partial<Objective> = {}): Objective {
  return { id: 77, workspace: 'acme', project: 'demo', created_by: 7, agent_context: 'cto', ...over } as Objective
}

function seed(): void {
  const g = { scopeType: 'global' as const }
  store.setSecret({ scope: g, key: 'FAKE_STRIPE_KEY', value: 'fake-v1', actorUserId: 1 })
  store.setSecret({ scope: g, key: 'FAKE_MAPS_KEY', value: 'fake-v2', actorUserId: 1 })
  store.setSecret({ scope: { scopeType: 'workspace', workspace: 'acme' }, key: 'FAKE_CRM_TOKEN', value: 'fake-v3', actorUserId: 1 })
}

/** One Claude stream-json assistant line with a Bash tool call. */
function toolUse(command: string): string {
  return JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command } }] } })
}

beforeAll(() => initDb())
beforeEach(() => {
  const db = getDb()
  clearSecretAuditLogForTests(db)
  db.exec(`DELETE FROM secret_versions; DELETE FROM secrets; DELETE FROM users; DELETE FROM secret_env_allowlist;
           DELETE FROM secret_env_usage; DELETE FROM settings WHERE key = 'secrets_session_env_mode';
           DELETE FROM resource_assignments; DELETE FROM objectives WHERE id = 77;`)
  db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (1, 'admin', 'x', 'admin'), (7, 'eva', 'x', 'member')`).run()
})
afterEach(() => {
  delete process.env.CC_SECRETS_SESSION_ENV_MODE
})

describe('mode', () => {
  it('a missing row reads as migration (every existing install)', () => {
    expect(policy.getSessionEnvMode()).toBe('migration')
  })
  it('env CC_SECRETS_SESSION_ENV_MODE wins over the row; junk is ignored', () => {
    policy.setSessionEnvMode('migration', 1)
    process.env.CC_SECRETS_SESSION_ENV_MODE = 'enforce'
    expect(policy.getSessionEnvMode()).toBe('enforce')
    process.env.CC_SECRETS_SESSION_ENV_MODE = 'yolo'
    expect(policy.getSessionEnvMode()).toBe('migration')
  })
  it('switching is audited as env_policy with the before/after', () => {
    policy.setSessionEnvMode('enforce', 1, 'cli')
    const e = store.queryAccessLog({ action: 'env_policy' }).entries[0]!
    expect(e).toMatchObject({ actorUserId: 1, key: '*', source: 'cli', detail: 'mode:migration->enforce' })
  })
  it('fresh install (empty store, no row) → enforce; existing install with secrets → stays migration', () => {
    expect(policy.initSessionEnvModeForFreshInstall()).toBe('enforce')
    getDb().exec(`DELETE FROM settings WHERE key = 'secrets_session_env_mode'`)
    seed()
    expect(policy.initSessionEnvModeForFreshInstall()).toBe('migration')
    expect(getDb().prepare(`SELECT 1 FROM settings WHERE key = 'secrets_session_env_mode'`).get()).toBeUndefined()
  })
  it('an explicit row is never overwritten by a re-run', () => {
    policy.setSessionEnvMode('migration', 1)
    expect(policy.initSessionEnvModeForFreshInstall()).toBe('migration')
  })
})

describe('buildSpawnEnv', () => {
  it('migration mode injects today\'s full set', () => {
    seed()
    const env = buildSpawnEnv({ objective: obj(), homeDir: '/h', sessionKind: 'worker' })
    expect(env.FAKE_STRIPE_KEY).toBe('fake-v1')
    expect(env.FAKE_MAPS_KEY).toBe('fake-v2')
    expect(env.FAKE_CRM_TOKEN).toBe('fake-v3')
  })
  it('enforce mode injects only names allowlisted for the agent, the * baseline, or an available skill', () => {
    seed()
    policy.setSessionEnvMode('enforce', 1)
    policy.addAllowlistEntry('agent', 'cto', 'FAKE_STRIPE_KEY', 1)
    let env = buildSpawnEnv({ objective: obj(), homeDir: '/h', sessionKind: 'worker' })
    expect(env.FAKE_STRIPE_KEY).toBe('fake-v1')
    expect(env.FAKE_MAPS_KEY).toBeUndefined()
    expect(env.FAKE_CRM_TOKEN).toBeUndefined()
    // another agent does not get the cto list
    env = buildSpawnEnv({ objective: obj({ agent_context: 'cmo' as Objective['agent_context'] }), homeDir: '/h', sessionKind: 'worker' })
    expect(env.FAKE_STRIPE_KEY).toBeUndefined()
    // baseline
    policy.addAllowlistEntry('agent', '*', 'FAKE_MAPS_KEY', 1)
    env = buildSpawnEnv({ objective: obj({ agent_context: 'cmo' as Objective['agent_context'] }), homeDir: '/h', sessionKind: 'worker' })
    expect(env.FAKE_MAPS_KEY).toBe('fake-v2')
    // skill: unrestricted workspace → every skill list applies
    policy.addAllowlistEntry('skill', 'crm-sync', 'FAKE_CRM_TOKEN', 1)
    env = buildSpawnEnv({ objective: obj({ agent_context: 'cmo' as Objective['agent_context'] }), homeDir: '/h', sessionKind: 'worker' })
    expect(env.FAKE_CRM_TOKEN).toBe('fake-v3')
    // restrict the workspace to another skill → crm-sync no longer available → withheld
    getDb().prepare(`INSERT INTO resource_assignments (resource_type, resource_id, scope_type, workspace) VALUES ('skill', 'other', 'workspace', 'acme')`).run()
    env = buildSpawnEnv({ objective: obj({ agent_context: 'cmo' as Objective['agent_context'] }), homeDir: '/h', sessionKind: 'worker' })
    expect(env.FAKE_CRM_TOKEN).toBeUndefined()
  })
  it('a withheld key is never decrypted into an inject audit row nor stamped last-used', () => {
    seed()
    policy.setSessionEnvMode('enforce', 1)
    policy.addAllowlistEntry('agent', 'cto', 'FAKE_STRIPE_KEY', 1)
    buildSpawnEnv({ objective: obj(), homeDir: '/h', sessionKind: 'worker' })
    const injected = store.queryAccessLog({ action: 'inject' }).entries.map(e => e.key)
    expect(injected).toEqual(['FAKE_STRIPE_KEY'])
    const maps = store.listSecrets().find(s => s.key === 'FAKE_MAPS_KEY')!
    expect(maps.lastUsedAt).toBeNull()
  })
})

describe('prompt inventory', () => {
  it('enforce mode lists only allowlisted names and says the rest are not in env', () => {
    seed()
    policy.setSessionEnvMode('enforce', 1)
    policy.addAllowlistEntry('agent', 'cto', 'FAKE_STRIPE_KEY', 1)
    const text = buildSecretsInventoryBlock(obj()).join('\n')
    expect(text).toContain('`FAKE_STRIPE_KEY`')
    expect(text).not.toContain('`FAKE_MAPS_KEY`')
    expect(text).toMatch(/2 more workspace secrets are NOT in your environment/)
  })
  it('migration mode lists every name, unchanged', () => {
    seed()
    const text = buildSecretsInventoryBlock(obj()).join('\n')
    expect(text).toContain('`FAKE_MAPS_KEY`')
    expect(text).not.toMatch(/NOT in your environment/)
  })
})

describe('findEnvReferences', () => {
  const cands = new Set(['FAKE_STRIPE_KEY', 'FAKE_MAPS_KEY', 'FAKE_CRM_TOKEN'])
  it('counts env reads in tool_use inputs across shell, node, python and ruby', () => {
    const t = [
      toolUse('curl -H "Authorization: Bearer $FAKE_STRIPE_KEY" https://example.test'),
      toolUse('echo ${FAKE_STRIPE_KEY:0:0}'),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: '/w/a.js', content: 'const k = process.env.FAKE_MAPS_KEY; os.environ["FAKE_CRM_TOKEN"]' } }] } }),
    ].join('\n')
    const c = policy.findEnvReferences(t, cands)
    expect(Object.fromEntries(c)).toEqual({ FAKE_STRIPE_KEY: 2, FAKE_MAPS_KEY: 1, FAKE_CRM_TOKEN: 1 })
  })
  it('ignores tool OUTPUT, plain prose mentions, broker placeholders and non-candidates', () => {
    const t = [
      JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: 'export FAKE_STRIPE_KEY=$FAKE_STRIPE_KEY' }] } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'I will use $FAKE_MAPS_KEY' }] } }),
      toolUse('echo FAKE_CRM_TOKEN is listed; curl -d "{{secret:FAKE_CRM_TOKEN}}"; echo $HOME $OTHER'),
    ].join('\n')
    expect(policy.findEnvReferences(t, cands).size).toBe(0)
  })
})

describe('migration log + review', () => {
  function seedObjective(): void {
    getDb().prepare(
      `INSERT INTO objectives (id, title, status, workspace, project, agent_context, created_by) VALUES (77, 't', 'working', 'acme', 'demo', 'cto', 7)`,
    ).run()
  }
  it('logs non-allowlisted names a session referenced (names + counts, no values); rescans are idempotent', () => {
    seed()
    seedObjective()
    policy.addAllowlistEntry('agent', 'cto', 'FAKE_STRIPE_KEY', 1)
    const t = [toolUse('curl -H "X: $FAKE_STRIPE_KEY $FAKE_MAPS_KEY"'), toolUse('node -e "process.env.FAKE_MAPS_KEY"')].join('\n')
    expect(policy.recordSessionEnvUsageFromTranscript(77, 'sess-a', t)).toBe(1)
    expect(policy.recordSessionEnvUsageFromTranscript(77, 'sess-a', t)).toBe(1)
    const rows = getDb().prepare('SELECT * FROM secret_env_usage').all() as { key: string; uses: number; mode: string; agent: string; workspace: string }[]
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ key: 'FAKE_MAPS_KEY', uses: 2, mode: 'migration', agent: 'cto', workspace: 'acme' })
    expect(JSON.stringify(rows)).not.toContain('fake-v')
  })
  it('enforce mode records references to withheld names as mode=enforce', () => {
    seed()
    seedObjective()
    policy.setSessionEnvMode('enforce', 1)
    policy.recordSessionEnvUsageFromTranscript(77, 'sess-b', toolUse('echo $FAKE_CRM_TOKEN'))
    const r = policy.envUsageReport()
    expect(r.rows[0]).toMatchObject({ agent: 'cto', key: 'FAKE_CRM_TOKEN', sessions: 1, withheldSessions: 1 })
  })
  it('report aggregates per agent and suggests; CLI apply is a dry run until --yes, then mode enforce', () => {
    seed()
    seedObjective()
    for (const s of ['s1', 's2']) policy.recordSessionEnvUsageFromTranscript(77, s, toolUse('curl -u "$FAKE_MAPS_KEY:" x'))
    policy.recordSessionEnvUsageFromTranscript(77, 's3', toolUse('echo $FAKE_CRM_TOKEN'))
    const r = policy.envUsageReport({ minSessions: 2 })
    expect(r.suggestions).toEqual({ cto: ['FAKE_MAPS_KEY'] })

    const lines: string[] = []
    expect(cli.run(['apply'], l => lines.push(l))).toBe(0)
    expect(lines.join('\n')).toContain('[dry-run] would allow agent cto: FAKE_MAPS_KEY')
    expect(policy.listAllowlist()).toHaveLength(0)
    cli.run(['apply', '--yes'], l => lines.push(l))
    expect(policy.listAllowlist().map(e => `${e.subject}:${e.key}`)).toEqual(['cto:FAKE_MAPS_KEY'])
    cli.run(['mode', 'enforce'], l => lines.push(l))
    expect(policy.getSessionEnvMode()).toBe('enforce')
    expect(store.queryAccessLog({ action: 'env_policy' }).entries.every(e => e.source === 'cli')).toBe(true)
  })
  it('rejects bad subjects and names', () => {
    expect(() => policy.addAllowlistEntry('agent', '../x', 'K', 1)).toThrow()
    expect(() => policy.addAllowlistEntry('agent', 'cto', 'BAD-NAME', 1)).toThrow()
    expect(() => policy.addAllowlistEntry('skill', '*', 'K', 1)).toThrow()
  })
})
