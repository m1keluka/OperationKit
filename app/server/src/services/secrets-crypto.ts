/**
 * AES-256-GCM helpers for the native scoped secrets store (obj-2353 / W1).
 *
 * This is the secrets-store sibling of `services/crypto.ts`. It is a SEPARATE
 * module on purpose: the secrets store holds production credentials (the Doppler
 * replacement), so its key is a DEDICATED master key — `SECRETS_MASTER_KEY` —
 * kept fully isolated from `TEST_CRED_ENCRYPTION_KEY` (the AI-review test-cred
 * key). Separate keys mean a leak/rotation of one blast radius never touches the
 * other, and each is independently testable.
 *
 * Key material:
 * - The 32-byte key is read from `process.env.SECRETS_MASTER_KEY` (base64).
 * - Host-file fallback: `/home/operator/projects/.secrets-master-key` (mode 600),
 *   mirroring the test-cred-key + doppler-token-file pattern, so the same image
 *   works whether or not a compose-level secret injector is active.
 * - FAIL-LOUD: missing / non-base64 / wrong-length key throws on first use. The
 *   secrets store must NEVER silently degrade to plaintext.
 * - The key is cached after first successful decode; restart after rotating.
 *
 * On-disk format for a single value (identical wire format to crypto.ts so the
 * representation is familiar and auditable):
 *   base64(iv) "." base64(authTag) "." base64(ciphertext)
 * - iv: 12-byte random nonce (GCM standard length).
 * - authTag: 16 bytes (default GCM tag length); AES-GCM rejects on tamper.
 * - ciphertext: same length as plaintext (GCM is a stream cipher).
 *
 * CATASTROPHIC-LOSS NOTE: losing this key loses every secret in the store;
 * leaking key + DB is full compromise. Operational handling (600 host file,
 * off-box encrypted backup, rotation runbook, access logging) is owned by the
 * service layer + cutover runbook — see the obj-2353 PRD §7/§9.
 *
 * Threat model: protects secrets at rest against a DB-only leak (someone
 * snapshots `command-center.db` off the host). It does NOT protect against a
 * runtime compromise — anyone with code-exec on the server can also read the env
 * var / host file.
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from 'crypto'
import { readFileSync } from 'fs'

const ALGO = 'aes-256-gcm'
const IV_BYTES = 12
const KEY_BYTES = 32
const KEY_FILE = '/home/operator/projects/.secrets-master-key'

let cachedKey: Buffer | null = null

/**
 * Resolves and caches the 32-byte AES-256-GCM secrets master key from
 * `process.env.SECRETS_MASTER_KEY` (base64), falling back to the host file
 * `/home/operator/projects/.secrets-master-key`. Throws with an actionable message
 * if missing or not exactly 32 bytes — fail-loud so encrypted-at-rest never
 * silently degrades to plaintext.
 */
function getKey(): Buffer {
  if (cachedKey) return cachedKey
  let raw = process.env.SECRETS_MASTER_KEY
  if (!raw || raw.length === 0) {
    // Host-file fallback — DEDICATED file, separate from .test-cred-encryption-key.
    // Path is outside the repo so it never ships in builds.
    try {
      const fromFile = readFileSync(KEY_FILE, 'utf8').trim()
      if (fromFile.length > 0) raw = fromFile
    } catch {}
  }
  if (!raw || raw.length === 0) {
    throw new Error(
      'SECRETS_MASTER_KEY is not set. Add a 32-byte base64-encoded key to the ' +
      'server environment OR write it to ' + KEY_FILE + ' (mode 600), then ' +
      'restart. This key is DEDICATED to the secrets store and MUST be distinct ' +
      'from TEST_CRED_ENCRYPTION_KEY. Generate one with: ' +
      'node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"'
    )
  }
  let buf: Buffer
  try {
    buf = Buffer.from(raw, 'base64')
  } catch {
    throw new Error('SECRETS_MASTER_KEY is not valid base64.')
  }
  if (buf.length !== KEY_BYTES) {
    throw new Error(
      `SECRETS_MASTER_KEY must decode to exactly ${KEY_BYTES} bytes ` +
      `(got ${buf.length}). Regenerate with crypto.randomBytes(32).toString('base64').`
    )
  }
  cachedKey = buf
  return cachedKey
}

/**
 * Encrypts a single UTF-8 secret value with AES-256-GCM under the secrets
 * master key.
 *
 * @returns `base64(iv).base64(authTag).base64(ciphertext)` — a single string
 *   safe to store in a SQLite TEXT column.
 */
export function encryptSecret(plaintext: string): string {
  const key = getKey()
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGO, key, iv)
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${iv.toString('base64')}.${tag.toString('base64')}.${ct.toString('base64')}`
}

/**
 * Decrypts a payload produced by `encryptSecret`.
 *
 * Throws if the payload is malformed, the IV/tag have wrong length, or the GCM
 * auth tag fails to verify (tamper / wrong key). Callers must let the error
 * bubble — silent fallback to empty string would mask key-rotation bugs and
 * could leak an empty secret into a session env.
 */
export function decryptSecret(payload: string): string {
  const key = getKey()
  const parts = payload.split('.')
  if (parts.length !== 3) {
    throw new Error('decryptSecret: expected 3 base64 segments separated by ".", got ' + parts.length)
  }
  const [ivB64, tagB64, ctB64] = parts
  const iv = Buffer.from(ivB64, 'base64')
  const tag = Buffer.from(tagB64, 'base64')
  const ct = Buffer.from(ctB64, 'base64')
  if (iv.length !== IV_BYTES) {
    throw new Error(`decryptSecret: IV must be ${IV_BYTES} bytes (got ${iv.length})`)
  }
  if (tag.length !== 16) {
    throw new Error(`decryptSecret: auth tag must be 16 bytes (got ${tag.length})`)
  }
  const decipher = createDecipheriv(ALGO, key, iv)
  decipher.setAuthTag(tag)
  const pt = Buffer.concat([decipher.update(ct), decipher.final()])
  return pt.toString('utf8')
}

/** Test-only: drop the cached key so a test can swap `SECRETS_MASTER_KEY`. */
export function __resetKeyCacheForTests(): void {
  cachedKey = null
}
