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
 * Key material (Sprint 6b / D2, obj 900540): resolved by the KEK provider
 * registry in `secrets-kek.ts` — a host file outside every session mount by
 * default (`SECRETS_KEK_FILE`, default `/run/secrets/operationkit-secrets-kek`),
 * with `SECRETS_MASTER_KEY` (env) and the old operator host file as legacy
 * fallbacks so existing installs keep starting.
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
import { selectKekProvider } from './secrets-kek.js'

const ALGO = 'aes-256-gcm'
const IV_BYTES = 12

let cachedKey: Buffer | null = null

/**
 * Resolves and caches the 32-byte key through the KEK provider registry
 * (services/secrets-kek.ts, decision D2): the host file outside every session
 * mount by default, the legacy `SECRETS_MASTER_KEY` env var / operator file as
 * compatibility fallbacks. Throws with an actionable message if no provider can
 * supply exactly 32 bytes — fail-loud so encrypted-at-rest never silently
 * degrades to plaintext.
 */
function getKey(): Buffer {
  if (cachedKey) return cachedKey
  cachedKey = selectKekProvider(process.env).load(process.env)
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
