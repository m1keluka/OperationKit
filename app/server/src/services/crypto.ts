/**
 * AES-256-GCM helpers for the AI-Review test-credentials store.
 *
 * Background: `test_credentials.fields_encrypted` holds a JSON map
 * `{fieldName: encryptedValue}` where each value is encrypted independently
 * so a row can be partially exposed (e.g. surface `username` to the UI but
 * keep `password` cipher-only) without re-encrypting the whole blob.
 *
 * Key material:
 * - The 32-byte key is read from `process.env.TEST_CRED_ENCRYPTION_KEY`
 *   (base64-encoded). The variable is injected via Doppler at server start;
 *   if missing or wrong-length the helpers throw on first use rather than
 *   silently no-op'ing.
 * - The key is cached after the first successful decode to avoid per-call
 *   base64 work — restart the server after rotating the secret.
 *
 * On-disk format for a single value:
 *   base64(iv) "." base64(authTag) "." base64(ciphertext)
 * - iv: 12-byte random nonce (GCM standard length).
 * - authTag: 16 bytes (default GCM tag length); AES-GCM rejects on tamper.
 * - ciphertext: same length as plaintext (GCM is a stream cipher).
 *
 * Threat model: protects test credentials at rest against a DB-only leak
 * (someone snapshots `command-center.db` off the host). It does NOT protect
 * against a runtime compromise — anyone with code-exec on the server can
 * also read the env var.
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

let cachedKey: Buffer | null = null

/**
 * Resolves and caches the 32-byte AES-256-GCM key from
 * `process.env.TEST_CRED_ENCRYPTION_KEY`. Throws with an actionable message
 * if the env var is missing or doesn't decode to exactly 32 bytes — fail-loud
 * so encrypted-at-rest never silently degrades to plaintext.
 */
function getKey(): Buffer {
  if (cachedKey) return cachedKey
  let raw = process.env.TEST_CRED_ENCRYPTION_KEY
  if (!raw || raw.length === 0) {
    // Host-file fallback — mirrors the doppler-token-file pattern in
    // session-manager. The compose-level Doppler wrapper isn't active in
    // every deployment, so reading from a 600-perm host file lets the same
    // image work either way. Path is outside the repo so it never ships in
    // builds.
    try {
      const fromFile = readFileSync('/home/operator/projects/.test-cred-encryption-key', 'utf8').trim()
      if (fromFile.length > 0) raw = fromFile
    } catch {}
  }
  if (!raw || raw.length === 0) {
    throw new Error(
      'TEST_CRED_ENCRYPTION_KEY is not set. Add a 32-byte base64-encoded key ' +
      'to Doppler (command-center / prd config) OR write it to ' +
      '/home/operator/projects/.test-cred-encryption-key (mode 600), then restart. ' +
      'Generate one with: node -e \"console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))\"'
    )
  }
  let buf: Buffer
  try {
    buf = Buffer.from(raw, 'base64')
  } catch {
    throw new Error('TEST_CRED_ENCRYPTION_KEY is not valid base64.')
  }
  if (buf.length !== KEY_BYTES) {
    throw new Error(
      `TEST_CRED_ENCRYPTION_KEY must decode to exactly ${KEY_BYTES} bytes ` +
      `(got ${buf.length}). Regenerate with crypto.randomBytes(32).toString('base64').`
    )
  }
  cachedKey = buf
  return cachedKey
}

/**
 * Encrypts a single UTF-8 plaintext string with AES-256-GCM.
 *
 * @returns `base64(iv).base64(authTag).base64(ciphertext)` — a single string
 *   safe to store in a SQLite TEXT column. The `.` separator was chosen
 *   because base64 alphabet (`A-Za-z0-9+/=`) never contains a dot, so split
 *   round-trips losslessly.
 */
export function encryptField(plaintext: string): string {
  const key = getKey()
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGO, key, iv)
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${iv.toString('base64')}.${tag.toString('base64')}.${ct.toString('base64')}`
}

/**
 * Decrypts a payload produced by `encryptField`.
 *
 * Throws if the payload is malformed, the IV/tag have wrong length, or the
 * GCM auth tag fails to verify (tamper / wrong key). Callers should let the
 * error bubble — silent fallback to empty string would mask key rotation
 * bugs.
 */
export function decryptField(payload: string): string {
  const key = getKey()
  const parts = payload.split('.')
  if (parts.length !== 3) {
    throw new Error('decryptField: expected 3 base64 segments separated by ".", got ' + parts.length)
  }
  const [ivB64, tagB64, ctB64] = parts
  const iv = Buffer.from(ivB64, 'base64')
  const tag = Buffer.from(tagB64, 'base64')
  const ct = Buffer.from(ctB64, 'base64')
  if (iv.length !== IV_BYTES) {
    throw new Error(`decryptField: IV must be ${IV_BYTES} bytes (got ${iv.length})`)
  }
  if (tag.length !== 16) {
    throw new Error(`decryptField: auth tag must be 16 bytes (got ${tag.length})`)
  }
  const decipher = createDecipheriv(ALGO, key, iv)
  decipher.setAuthTag(tag)
  const pt = Buffer.concat([decipher.update(ct), decipher.final()])
  return pt.toString('utf8')
}

/**
 * Encrypts every value of a plaintext map and serializes the result as JSON.
 *
 * Each value is encrypted with its own IV (see `encryptField`), so two
 * fields with the same plaintext (e.g. two `password` fields across rows)
 * produce different ciphertexts. The returned string is the value stored in
 * `test_credentials.fields_encrypted`.
 *
 * Keys are passed through unchanged — they're not secret (they're field
 * names like `username`, `api_token`) and stay clear so the server can
 * project a subset without decrypting siblings.
 */
export function encryptCredentialFields(fields: Record<string, string>): string {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(fields)) {
    out[k] = encryptField(v)
  }
  return JSON.stringify(out)
}

/**
 * Inverse of `encryptCredentialFields`. Returns a plaintext key→value map.
 *
 * Throws on malformed JSON or any per-value GCM auth failure — partial
 * decrypts are not returned because a half-readable credential is worse than
 * none (the UI would silently show some fields and not others).
 */
export function decryptCredentialFields(encryptedJson: string): Record<string, string> {
  const parsed = JSON.parse(encryptedJson) as Record<string, unknown>
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(parsed)) {
    if (typeof v !== 'string') {
      throw new Error(`decryptCredentialFields: value for "${k}" is not a string`)
    }
    out[k] = decryptField(v)
  }
  return out
}
