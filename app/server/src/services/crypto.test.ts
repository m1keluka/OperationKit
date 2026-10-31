import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { randomBytes } from 'crypto'

// obj-716719: rows encrypted under the host key file must still decrypt when
// the server's primary key comes from the (different) secrets-store env value.
const fileKey = randomBytes(32).toString('base64')
const envKey = randomBytes(32).toString('base64')
let fileContents: string | null = fileKey

vi.mock('fs', async (orig) => {
  const actual = await orig<typeof import('fs')>()
  return {
    ...actual,
    readFileSync: (p: string, enc?: BufferEncoding) => {
      if (p === '/home/operator/projects/.test-cred-encryption-key') {
        if (fileContents == null) throw new Error('ENOENT')
        return fileContents
      }
      return actual.readFileSync(p, enc)
    },
  }
})

async function load(env: string | undefined) {
  vi.resetModules()
  if (env === undefined) delete process.env.TEST_CRED_ENCRYPTION_KEY
  else process.env.TEST_CRED_ENCRYPTION_KEY = env
  return import('./crypto.js')
}

describe('crypto dual-key decrypt', () => {
  const saved = process.env.TEST_CRED_ENCRYPTION_KEY
  beforeEach(() => { fileContents = fileKey })
  afterEach(() => {
    if (saved === undefined) delete process.env.TEST_CRED_ENCRYPTION_KEY
    else process.env.TEST_CRED_ENCRYPTION_KEY = saved
  })

  it('decrypts a file-key payload when the primary key is the env key', async () => {
    const fileOnly = await load(undefined)
    const payload = fileOnly.encryptField('refresh-token-abc')
    const envPrimary = await load(envKey)
    expect(envPrimary.decryptField(payload)).toBe('refresh-token-abc')
  })

  it('decrypts an env-key payload when the primary key is the file key', async () => {
    const envPrimary = await load(envKey)
    const payload = envPrimary.encryptField('ghp_xyz')
    // A process without the env var resolves the file key as primary; the
    // env var is then set later (e.g. secrets-store hydrate after first use).
    const fileOnly = await load(undefined)
    fileOnly.encryptField('warm the primary cache')
    process.env.TEST_CRED_ENCRYPTION_KEY = envKey
    expect(fileOnly.decryptField(payload)).toBe('ghp_xyz')
  })

  it('still rejects a payload under an unknown key', async () => {
    const other = await load(randomBytes(32).toString('base64'))
    const payload = other.encryptField('secret')
    fileContents = fileKey
    const envPrimary = await load(envKey)
    expect(() => envPrimary.decryptField(payload)).toThrow()
  })

  it('encrypts with the primary key only', async () => {
    const envPrimary = await load(envKey)
    const payload = envPrimary.encryptField('x')
    fileContents = null
    const envOnly = await load(envKey)
    expect(envOnly.decryptField(payload)).toBe('x')
  })
})
