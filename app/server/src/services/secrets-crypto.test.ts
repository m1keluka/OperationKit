import { describe, it, expect, beforeEach } from 'vitest'

// A valid 32-byte key must be present BEFORE first use. Set it here; individual
// tests that exercise key resolution reset the cache + swap the env themselves.
const VALID_KEY = Buffer.alloc(32, 9).toString('base64')
process.env.SECRETS_MASTER_KEY = VALID_KEY

const { encryptSecret, decryptSecret, __resetKeyCacheForTests } = await import('./secrets-crypto.js')

beforeEach(() => {
  process.env.SECRETS_MASTER_KEY = VALID_KEY
  __resetKeyCacheForTests()
})

describe('secrets-crypto AES-256-GCM', () => {
  it('round-trips a value', () => {
    const pt = 'sk-live-abcdef1234567890'
    expect(decryptSecret(encryptSecret(pt))).toBe(pt)
  })

  it('round-trips unicode + empty string', () => {
    expect(decryptSecret(encryptSecret(''))).toBe('')
    expect(decryptSecret(encryptSecret('på$$wörd—🔐'))).toBe('på$$wörd—🔐')
  })

  it('uses a fresh IV per call — same plaintext yields different ciphertext', () => {
    const a = encryptSecret('same')
    const b = encryptSecret('same')
    expect(a).not.toBe(b)
    expect(decryptSecret(a)).toBe('same')
    expect(decryptSecret(b)).toBe('same')
  })

  it('emits the iv.tag.ct base64 wire format (3 segments)', () => {
    expect(encryptSecret('x').split('.')).toHaveLength(3)
  })

  it('rejects a tampered ciphertext (GCM auth tag)', () => {
    const enc = encryptSecret('secret-value')
    const [iv, tag, ct] = enc.split('.')
    // Flip a byte in the ciphertext segment.
    const corruptCt = Buffer.from(ct, 'base64')
    corruptCt[0] ^= 0xff
    const tampered = `${iv}.${tag}.${corruptCt.toString('base64')}`
    expect(() => decryptSecret(tampered)).toThrow()
  })

  it('FAIL-LOUD: wrong-length key throws on use (never silently degrades)', () => {
    process.env.SECRETS_MASTER_KEY = Buffer.alloc(16, 1).toString('base64') // 16, not 32
    __resetKeyCacheForTests()
    expect(() => encryptSecret('x')).toThrow(/32 bytes/)
  })

  it('FAIL-LOUD: non-base64 key throws', () => {
    process.env.SECRETS_MASTER_KEY = '!!!not base64!!!='
    __resetKeyCacheForTests()
    // Buffer.from is lenient, so this decodes to the wrong length → 32-byte guard.
    expect(() => encryptSecret('x')).toThrow()
  })

  it('is keyed by SECRETS_MASTER_KEY — a different key cannot decrypt', () => {
    const enc = encryptSecret('locked')
    process.env.SECRETS_MASTER_KEY = Buffer.alloc(32, 42).toString('base64')
    __resetKeyCacheForTests()
    expect(() => decryptSecret(enc)).toThrow()
  })

  it('does not read TEST_CRED_ENCRYPTION_KEY (dedicated key isolation)', () => {
    // Set a DIFFERENT test-cred key; secrets-crypto must ignore it entirely.
    process.env.TEST_CRED_ENCRYPTION_KEY = Buffer.alloc(32, 200).toString('base64')
    process.env.SECRETS_MASTER_KEY = VALID_KEY
    __resetKeyCacheForTests()
    const enc = encryptSecret('isolated')
    expect(decryptSecret(enc)).toBe('isolated')
  })
})
