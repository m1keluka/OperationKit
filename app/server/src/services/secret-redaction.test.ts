/**
 * Secret redaction + persistence scrubbing (obj 715532).
 * Known values (store + env + .env files), every pattern family, .env
 * names-only, and the db.prepare write scrubber (activity_log, objectives).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const TMP_DB = path.join(os.tmpdir(), `cc-redact-${process.pid}-${Date.now()}.db`)
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-redact-'))
const ENV_FILE = path.join(TMP_DIR, '.env.production')
process.env.DB_PATH = TMP_DB
process.env.SECRETS_MASTER_KEY = Buffer.alloc(32, 9).toString('base64')
process.env.CC_REDACT_ENV_FILES = ENV_FILE
process.env.TEST_REDACT_SERVICE_TOKEN = 'envtok_9f8e7d6c5b4a39281706'
fs.writeFileSync(ENV_FILE, [
  '# prod',
  'STRIPE_SECRET_KEY="filesecret_AbCdEf123456789"',
  'PUBLIC_URL=https://example.com',
  'export DATABASE_URL=postgres://app:dbpass_abc12345@db.internal:5432/app',
].join('\n'))

const { initDb, getDb } = await import('../db/index.js')
const { setSecret, deleteSecret } = await import('./secrets-store.js')
const R = await import('./secret-redaction.js')

const STORE_VALUE = 'sbp_storevalue_0123456789abcdef'

beforeAll(() => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
  setSecret({ scope: { scopeType: 'global' }, key: 'SUPABASE_SERVICE_ROLE', value: STORE_VALUE })
  setSecret({ scope: { scopeType: 'workspace', workspace: 'example' }, key: 'EXAMPLE_ONLY_KEY', value: 'example-ws-secret-value-77' })
})

afterAll(() => {
  try { getDb().close() } catch {}
  for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(`${TMP_DB}${s}`) } catch {} }
  fs.rmSync(TMP_DIR, { recursive: true, force: true })
})

beforeEach(() => R.clearRegisteredSecretsForTests())

describe('known values', () => {
  it('replaces store values (every scope) with [REDACTED:<NAME>]', () => {
    const r = R.redactKnownValues(`key=${STORE_VALUE} and example-ws-secret-value-77`)
    expect(r.text).toBe('key=[REDACTED:SUPABASE_SERVICE_ROLE] and [REDACTED:EXAMPLE_ONLY_KEY]')
    expect(r.count).toBe(2)
  })

  it('replaces secret-looking process env values and configured .env file values', () => {
    const r = R.redactKnownValues('a envtok_9f8e7d6c5b4a39281706 b filesecret_AbCdEf123456789 c')
    expect(r.text).toBe('a [REDACTED:TEST_REDACT_SERVICE_TOKEN] b [REDACTED:STRIPE_SECRET_KEY] c')
  })

  it('does not treat non-secret env values (urls, short values) as secrets', () => {
    expect(R.redactKnownValues('see https://example.com now').count).toBe(0)
    expect(R.knownSecretNames()).not.toContain('PUBLIC_URL')
  })

  it('a store write invalidates the registry immediately', () => {
    setSecret({ scope: { scopeType: 'global' }, key: 'ROTATED_KEY', value: 'rotated-value-123456' })
    expect(R.redactKnownValues('x rotated-value-123456').text).toBe('x [REDACTED:ROTATED_KEY]')
    deleteSecret({ scopeType: 'global' }, 'ROTATED_KEY')
    expect(R.redactKnownValues('x rotated-value-123456').count).toBe(0)
  })

  it('matches the JSON-escaped form of values with quotes/newlines', () => {
    R.registerKnownSecret('PEMISH', 'line1\nline2"quoted"')
    const json = JSON.stringify({ t: 'v=line1\nline2"quoted"' })
    expect(R.redactKnownValues(json).text).toBe('{"t":"v=[REDACTED:PEMISH]"}')
  })

  it('ignores values shorter than MIN_SECRET_LEN', () => {
    R.registerKnownSecret('SHORT', 'abc')
    expect(R.redactKnownValues('abc abc abc abc').count).toBe(0)
  })

  it('names() exposes names only, never values', () => {
    const names = R.knownSecretNames()
    expect(names).toContain('SUPABASE_SERVICE_ROLE')
    expect(JSON.stringify(names)).not.toContain(STORE_VALUE)
  })
})

describe('pattern families', () => {
  const cases: Array<[string, string, string]> = [
    ['openai', 'k sk-proj-ABCDEFGHIJKLMNOPQRSTUVWX12 end', '[REDACTED:OPENAI_KEY]'],
    ['anthropic', 'k sk-ant-api03-abcdefghijklmnop1234 end', '[REDACTED:ANTHROPIC_KEY]'],
    ['cc_live', 'Authorization cc_live_abcdefghijklmnopqrstuvwxyz012345', '[REDACTED:CC_API_KEY]'],
    ['github classic', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789', '[REDACTED:GITHUB_TOKEN]'],
    ['github fine-grained', 'github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz', '[REDACTED:GITHUB_TOKEN]'],
    ['slack', 'xoxb-1234567890-abcdefghijkl', '[REDACTED:SLACK_TOKEN]'],
    ['aws', 'AKIAIOSFODNN7EXAMPLE', '[REDACTED:AWS_ACCESS_KEY]'],
    ['google', 'AIzaSyA1234567890abcdefghijklmnopqrstuv', '[REDACTED:GOOGLE_API_KEY]'],
    ['stripe', 'sk_live_abcdefghijklmnop1234', '[REDACTED:STRIPE_KEY]'],
    ['supabase sb_secret', 'sb_secret_abcdefghijklmnop1234', '[REDACTED:SUPABASE_KEY]'],
    ['jwt / supabase service role', 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.abcdefghijklmnop', '[REDACTED:JWT]'],
  ]
  it.each(cases)('%s', (_name, input, marker) => {
    const r = R.redactText(input)
    expect(r.text).toContain(marker)
    expect(r.count).toBeGreaterThan(0)
  })

  it('private key blocks', () => {
    const pem = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjE\nAAAA\n-----END OPENSSH PRIVATE KEY-----'
    const r = R.redactText(`before\n${pem}\nafter`)
    expect(r.text).toBe('before\n[REDACTED:PRIVATE_KEY]\nafter')
  })

  it('Bearer headers (token-shaped only, not prose)', () => {
    expect(R.redactText('Authorization: Bearer abc123def456ghi789jkl').text).toBe('Authorization: Bearer [REDACTED:BEARER]')
    expect(R.redactText('use Bearer authentication here').count).toBe(0)
  })

  it('password= / secret= / token= assignments (yaml, env, json, url query)', () => {
    expect(R.redactText('password=hunter2hunter2').text).toBe('password=[REDACTED:ASSIGNMENT]')
    expect(R.redactText('  client_secret: "abcd-efgh-1234"').text).toBe('  client_secret: "[REDACTED:ASSIGNMENT]"')
    expect(R.redactText('{"api_key": "zzzz9999yyyy"}').text).toBe('{"api_key": "[REDACTED:ASSIGNMENT]"}')
    expect(R.redactText('GET /cb?token=abcdef123456&x=1').text).toBe('GET /cb?token=[REDACTED:ASSIGNMENT]&x=1')
  })

  it('leaves references and counters alone', () => {
    expect(R.redactText('password: ${POSTGRES_PASSWORD}').count).toBe(0)
    expect(R.redactText('"input_tokens": 1234').count).toBe(0)
  })

  it('connection strings with credentials keep user/host, drop the password', () => {
    expect(R.redactText('postgres://user:s3cretpass@db.example.com:5432/x').text)
      .toBe('postgres://user:[REDACTED:CONN_PASSWORD]@db.example.com:5432/x')
    expect(R.redactText('redis://default:abcDEF123@cache:6379').text).toBe('redis://default:[REDACTED:CONN_PASSWORD]@cache:6379')
  })

  it('redactForStorage uses only high-confidence shapes', () => {
    expect(R.redactForStorage('password=hunter2hunter2').count).toBe(0)
    expect(R.redactForStorage('ghp_abcdefghijklmnopqrstuvwxyz0123456789').count).toBe(1)
  })
})

describe('.env files', () => {
  it('serves KEY=[REDACTED]; names visible, values never', () => {
    const r = R.redactEnvFile('# comment\nFOO=bar\nexport TOKEN="abc def"\nEMPTY=\n\nNOT AN ASSIGNMENT')
    expect(r.text).toBe('# comment\nFOO=[REDACTED]\nexport TOKEN=[REDACTED]\nEMPTY=\n\nNOT AN ASSIGNMENT')
    expect(r.count).toBe(2)
  })
})

describe('worker prompts', () => {
  it('redacts known values and tells the worker to use the env var by name', () => {
    const out = R.redactPromptForWorker(`Use ${STORE_VALUE} to call the API`)
    expect(out).not.toContain(STORE_VALUE)
    expect(out).toContain('[REDACTED:SUPABASE_SERVICE_ROLE]')
    expect(out).toContain('use it by reference')
  })
  it('leaves clean prompts byte-identical', () => {
    expect(R.redactPromptForWorker('nothing here')).toBe('nothing here')
  })
})

describe('DB write scrubber (transcript/thread/summary/activity persistence)', () => {
  it('a known value echoed into a session summary is stored as [REDACTED:NAME]', () => {
    const db = getDb()
    const id = Number(db.prepare(`INSERT INTO objectives (title, workspace, agent_context) VALUES ('t', 'example', 'cto')`).run().lastInsertRowid)
    db.prepare(`UPDATE objectives SET last_session_summary = ? WHERE id = ?`).run(`I used ${STORE_VALUE} to query`, id)
    const row = db.prepare('SELECT last_session_summary FROM objectives WHERE id = ?').get(id) as { last_session_summary: string }
    expect(row.last_session_summary).toBe('I used [REDACTED:SUPABASE_SERVICE_ROLE] to query')
  })

  it('activity_log rows (positional and JSON metadata) are scrubbed', () => {
    const db = getDb()
    db.prepare(`INSERT INTO activity_log (project, workspace, event_type, title, detail, metadata) VALUES ('p', 'example', 'milestone', 't', ?, ?)`)
      .run(`leaked ${STORE_VALUE}`, JSON.stringify({ k: STORE_VALUE, gh: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789' }))
    const row = db.prepare(`SELECT detail, metadata FROM activity_log ORDER BY id DESC LIMIT 1`).get() as { detail: string; metadata: string }
    expect(row.detail).toBe('leaked [REDACTED:SUPABASE_SERVICE_ROLE]')
    expect(JSON.parse(row.metadata)).toEqual({ k: '[REDACTED:SUPABASE_SERVICE_ROLE]', gh: '[REDACTED:GITHUB_TOKEN]' })
  })

  it('named parameters are scrubbed too', () => {
    const db = getDb()
    const id = Number(db.prepare(`INSERT INTO objectives (title, workspace, agent_context, description) VALUES (@t, 'example', 'cto', @d)`)
      .run({ t: 'named', d: `key: ${STORE_VALUE}` }).lastInsertRowid)
    const row = db.prepare('SELECT description FROM objectives WHERE id = ?').get(id) as { description: string }
    expect(row.description).toBe('key: [REDACTED:SUPABASE_SERVICE_ROLE]')
  })

  it('reads and writes to unscrubbed tables are untouched', () => {
    const db = getDb()
    db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('redact_probe', ?)`).run(STORE_VALUE)
    const row = db.prepare(`SELECT value FROM settings WHERE key = 'redact_probe'`).get() as { value: string }
    expect(row.value).toBe(STORE_VALUE)
    expect(db.prepare('SELECT ? AS v').pluck().get(STORE_VALUE)).toBe(STORE_VALUE)
  })

  it('isScrubbedWrite recognises INSERT/UPDATE/REPLACE on scrubbed tables only', async () => {
    const { isScrubbedWrite } = await import('../db/write-scrubber.js')
    expect(isScrubbedWrite('INSERT INTO activity_log (a) VALUES (?)')).toBe(true)
    expect(isScrubbedWrite('  UPDATE objectives SET x = ?')).toBe(true)
    expect(isScrubbedWrite('INSERT OR IGNORE INTO session_events(x) VALUES (?)')).toBe(true)
    expect(isScrubbedWrite('SELECT * FROM objectives')).toBe(false)
    expect(isScrubbedWrite('INSERT INTO objectives_archive (a) VALUES (?)')).toBe(false)
    expect(isScrubbedWrite('UPDATE settings SET value = ?')).toBe(false)
  })
})
