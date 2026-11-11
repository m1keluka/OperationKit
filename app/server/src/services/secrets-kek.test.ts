/**
 * D2 (obj 900540) — KEK from a host file outside session mounts, pluggable providers.
 * Test keys are fixed fake bytes, never a real key.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  DEFAULT_KEK_FILE,
  LEGACY_KEK_FILE,
  isUnderSessionVisibleRoot,
  kekStatus,
  listKekProviders,
  registerKekProvider,
  selectKekProvider,
} from './secrets-kek.js'
import { encryptSecret, decryptSecret, __resetKeyCacheForTests } from './secrets-crypto.js'

const KEY_A = Buffer.alloc(32, 3).toString('base64')
const SAVED = { ...process.env }
let dir: string

function writeKek(content: string, mode = 0o400): string {
  const f = path.join(dir, `kek-${Math.random().toString(36).slice(2)}`)
  fs.writeFileSync(f, content + '\n', { mode })
  fs.chmodSync(f, mode)
  return f
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-kek-'))
  delete process.env.SECRETS_MASTER_KEY
  delete process.env.SECRETS_KEK_FILE
  delete process.env.SECRETS_KEK_PROVIDER
  delete process.env.SESSION_VISIBLE_ROOTS
  __resetKeyCacheForTests()
})
afterEach(() => {
  process.env = { ...SAVED }
  __resetKeyCacheForTests()
})

describe('provider selection', () => {
  it('defaults to a host file at /run/secrets, outside every session mount', () => {
    expect(DEFAULT_KEK_FILE).toBe('/run/secrets/operationkit-secrets-kek')
    expect(isUnderSessionVisibleRoot(DEFAULT_KEK_FILE)).toBe(false)
    expect(isUnderSessionVisibleRoot(LEGACY_KEK_FILE)).toBe(true)
    expect(isUnderSessionVisibleRoot('/tmp/x')).toBe(true)
    expect(isUnderSessionVisibleRoot('/tmpfoo/x')).toBe(false)
  })
  it('host file beats the legacy env var when both exist', () => {
    process.env.SECRETS_MASTER_KEY = Buffer.alloc(32, 9).toString('base64')
    process.env.SECRETS_KEK_FILE = writeKek(KEY_A)
    expect(selectKekProvider().id).toBe('host-file')
  })
  it('falls back to the env var on an install that has not re-run the installer', () => {
    process.env.SECRETS_KEK_FILE = path.join(dir, 'absent')
    process.env.SECRETS_MASTER_KEY = KEY_A
    expect(selectKekProvider().id).toBe('env')
  })
  it('a pinned provider is used without fallback; an unknown one throws', () => {
    process.env.SECRETS_MASTER_KEY = KEY_A
    process.env.SECRETS_KEK_PROVIDER = 'host-file'
    process.env.SECRETS_KEK_FILE = path.join(dir, 'absent')
    expect(() => selectKekProvider().load(process.env)).toThrow(/cannot be read/)
    process.env.SECRETS_KEK_PROVIDER = 'kms-nope'
    expect(() => selectKekProvider()).toThrow(/not a known provider/)
  })
  it('no key anywhere fails loud (never plaintext)', () => {
    process.env.SECRETS_KEK_FILE = path.join(dir, 'absent')
    // The legacy operator file may exist on a real host; this test is about a clean box.
    if (!fs.existsSync(LEGACY_KEK_FILE)) {
      expect(() => encryptSecret('x')).toThrow(/No secrets KEK found/)
    }
  })
})

describe('host-file provider', () => {
  it('encrypts/decrypts with the file key, and the same key via the legacy env decrypts it (no re-encryption needed)', () => {
    process.env.SECRETS_KEK_FILE = writeKek(KEY_A)
    const ct = encryptSecret('fake-value')
    expect(decryptSecret(ct)).toBe('fake-value')
    delete process.env.SECRETS_KEK_FILE
    process.env.SECRETS_KEK_FILE = path.join(dir, 'absent')
    process.env.SECRETS_MASTER_KEY = KEY_A
    __resetKeyCacheForTests()
    expect(decryptSecret(ct)).toBe('fake-value')
  })
  it('refuses a file group/other can read', () => {
    process.env.SECRETS_KEK_FILE = writeKek(KEY_A, 0o644)
    expect(() => encryptSecret('x')).toThrow(/readable by group\/other/)
  })
  it('refuses a wrong-length or non-base64 key', () => {
    process.env.SECRETS_KEK_FILE = writeKek(Buffer.alloc(16, 1).toString('base64'))
    expect(() => encryptSecret('x')).toThrow(/32 bytes/)
    __resetKeyCacheForTests()
    process.env.SECRETS_KEK_FILE = writeKek('!!!not base64!!!')
    expect(() => encryptSecret('x')).toThrow(/not valid base64/)
  })
})

describe('kekStatus', () => {
  it('reports location only, flags legacy env and session-visible paths, never key material', () => {
    process.env.SECRETS_KEK_FILE = path.join(dir, 'absent')
    process.env.SECRETS_MASTER_KEY = KEY_A
    let s = kekStatus()
    expect(s).toMatchObject({ ok: true, provider: 'env', legacy: true, location: 'env:SECRETS_MASTER_KEY' })
    expect(s.warnings.join(' ')).toMatch(/legacy/)
    expect(JSON.stringify(s)).not.toContain(KEY_A)

    process.env.SECRETS_KEK_FILE = writeKek(KEY_A) // under /tmp = session-visible
    s = kekStatus()
    expect(s).toMatchObject({ provider: 'host-file', sessionVisible: true, legacy: false })
    expect(JSON.stringify(s)).not.toContain(KEY_A)
  })
  it('a file outside the session roots is clean', () => {
    process.env.SECRETS_KEK_FILE = writeKek(KEY_A)
    // Pretend /tmp is not session-visible by checking the helper with an explicit root list.
    expect(isUnderSessionVisibleRoot('/run/secrets/operationkit-secrets-kek', { SESSION_VISIBLE_ROOTS: '/srv/sessions' })).toBe(false)
    expect(isUnderSessionVisibleRoot('/srv/sessions/k', { SESSION_VISIBLE_ROOTS: '/srv/sessions' })).toBe(true)
  })
  it('reports an error instead of throwing when nothing is configured', () => {
    process.env.SECRETS_KEK_PROVIDER = 'env'
    expect(kekStatus()).toMatchObject({ ok: false, provider: 'env' })
    process.env.SECRETS_KEK_PROVIDER = 'bogus'
    expect(kekStatus()).toMatchObject({ ok: false, provider: null })
  })
})

describe('extension point (KMS / 1Password later)', () => {
  it('a registered provider can be pinned and round-trips; built-ins cannot be replaced', () => {
    registerKekProvider({
      id: 'test-kms',
      available: () => true,
      load: () => Buffer.alloc(32, 77),
      describe: () => 'kms:arn:fake',
    })
    expect(listKekProviders()).toContain('test-kms')
    process.env.SECRETS_KEK_PROVIDER = 'test-kms'
    expect(decryptSecret(encryptSecret('fake'))).toBe('fake')
    expect(kekStatus().location).toBe('kms:arn:fake')
    expect(() => registerKekProvider({ id: 'host-file', available: () => true, load: () => Buffer.alloc(32), describe: () => 'x' })).toThrow(/built in/)
  })
})
