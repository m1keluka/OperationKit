/**
 * Secrets-store key-encryption key (KEK) providers — Sprint 6b, decision D2 (obj 900540).
 *
 * Operator's decision (2026-11-10): "host file default, KMS/1Password optional". The
 * KEK lives in a HOST FILE that is outside every session-visible mount; the
 * installer creates it with tight permissions and the backup covers it. Cloud
 * KMS and a 1Password-held KEK are allowed LATER through this interface — they
 * are deliberately NOT built now.
 *
 * Which key is "the KEK"? The 32-byte AES-256-GCM key that `secrets-crypto.ts`
 * encrypts every stored value with. Envelope encryption (per-secret DEKs wrapped
 * by this key) is a later, separate phase; when it lands this module is still
 * the only place that knows where the wrapping key comes from.
 *
 * ── Providers ───────────────────────────────────────────────────────────────
 *   host-file  (DEFAULT) reads `SECRETS_KEK_FILE`, default
 *              `/run/secrets/operationkit-secrets-kek` (a compose file-secret,
 *              read-only, root-owned 0400). Refuses a file that group/other can
 *              read: a KEK anyone on the box can read is not a KEK.
 *   env        `SECRETS_MASTER_KEY` (base64). The pre-6b mechanism, kept so an
 *              install that has not re-run the installer keeps starting. Status
 *              reports it as `legacy`.
 *   legacy-file `/home/operator/projects/.secrets-master-key` — the original operator
 *              host path, which IS inside the session-visible projects mount.
 *              Read only as a last resort, flagged session-visible in status.
 *
 * Selection: `SECRETS_KEK_PROVIDER=<id>` pins one provider (no fallback). Unset =
 * auto: host-file if its file exists, else env, else legacy-file. Auto keeps
 * every existing install starting with zero changes; `kekStatus()` and the boot
 * log say loudly when the key is coming from a legacy location.
 *
 * ── Extension point (D2 KMS / 1Password, D3) ────────────────────────────────
 * A new KEK source is one object implementing `KekProvider` passed to
 * `registerKekProvider()` before the first encrypt/decrypt. Rules for whoever
 * builds one:
 *   - `load()` returns exactly 32 bytes or throws. Never fall back silently.
 *   - Never log, return or persist key material anywhere but the Buffer.
 *   - `describe()` returns a location label (an ARN, an `op://` path, a file
 *     path) — never the key.
 *   - A remote provider (KMS unwrap, `op read`) runs once at first use; the key
 *     is cached in process memory by secrets-crypto.ts. Boot fails loud if the
 *     remote is unreachable, exactly like a missing file does today.
 * Per-workspace 1Password VALUE references (`op://` instead of ciphertext, D3)
 * are a different seam — see docs/proposals/SECRETS-PROPOSAL.md §8.
 */
import { readFileSync, statSync } from 'fs'
import path from 'path'

export const KEK_BYTES = 32
export const DEFAULT_KEK_FILE = '/run/secrets/operationkit-secrets-kek'
/** Pre-6b operator path. Inside the session-visible projects mount — legacy only. */
export const LEGACY_KEK_FILE = '/home/operator/projects/.secrets-master-key'

export interface KekProvider {
  /** Stable id, used by SECRETS_KEK_PROVIDER and shown in status. */
  id: string
  /** True when this provider has something to load right now (file exists, env set…). */
  available(env: NodeJS.ProcessEnv): boolean
  /** Return the 32-byte key. Throw with an actionable message on any problem. */
  load(env: NodeJS.ProcessEnv): Buffer
  /** Where the key comes from, for status/logs. NEVER key material. */
  describe(env: NodeJS.ProcessEnv): string
  /** Legacy = kept for compatibility; status recommends moving off it. */
  legacy?: boolean
}

export function decodeKek(raw: string, label: string): Buffer {
  const trimmed = raw.trim()
  if (!trimmed) throw new Error(`${label} is empty.`)
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed)) throw new Error(`${label} is not valid base64.`)
  const buf = Buffer.from(trimmed, 'base64')
  if (buf.length !== KEK_BYTES) {
    throw new Error(
      `${label} must decode to exactly ${KEK_BYTES} bytes (got ${buf.length}). ` +
        `Regenerate with: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`,
    )
  }
  return buf
}

function kekFilePath(env: NodeJS.ProcessEnv): string {
  return env.SECRETS_KEK_FILE?.trim() || DEFAULT_KEK_FILE
}

/** Mode bits a KEK file must not carry: any group/other permission. */
export const KEK_FILE_FORBIDDEN_MODE = 0o077

export function assertKekFileMode(file: string): void {
  const st = statSync(file)
  if (!st.isFile()) throw new Error(`SECRETS_KEK_FILE ${file} is not a regular file.`)
  if ((st.mode & KEK_FILE_FORBIDDEN_MODE) !== 0) {
    throw new Error(
      `SECRETS_KEK_FILE ${file} is readable by group/other (mode ${(st.mode & 0o777).toString(8)}). ` +
        `Run: chmod 400 ${file}`,
    )
  }
}

export const hostFileProvider: KekProvider = {
  id: 'host-file',
  available: env => {
    try {
      return statSync(kekFilePath(env)).isFile()
    } catch {
      return false
    }
  },
  load: env => {
    const file = kekFilePath(env)
    let raw: string
    try {
      raw = readFileSync(file, 'utf8')
    } catch (err) {
      throw new Error(
        `The secrets KEK file ${file} cannot be read (${(err as NodeJS.ErrnoException).code ?? 'error'}). ` +
          'Re-run the installer (it creates it), or set SECRETS_KEK_FILE.',
      )
    }
    assertKekFileMode(file)
    return decodeKek(raw, `SECRETS_KEK_FILE ${file}`)
  },
  describe: env => kekFilePath(env),
}

export const envProvider: KekProvider = {
  id: 'env',
  legacy: true,
  available: env => !!env.SECRETS_MASTER_KEY,
  load: env => {
    if (!env.SECRETS_MASTER_KEY) throw new Error('SECRETS_MASTER_KEY is not set.')
    return decodeKek(env.SECRETS_MASTER_KEY, 'SECRETS_MASTER_KEY')
  },
  describe: () => 'env:SECRETS_MASTER_KEY',
}

export const legacyFileProvider: KekProvider = {
  id: 'legacy-file',
  legacy: true,
  available: () => {
    try {
      return statSync(LEGACY_KEK_FILE).isFile()
    } catch {
      return false
    }
  },
  load: () => decodeKek(readFileSync(LEGACY_KEK_FILE, 'utf8'), LEGACY_KEK_FILE),
  describe: () => LEGACY_KEK_FILE,
}

const BUILTIN: KekProvider[] = [hostFileProvider, envProvider, legacyFileProvider]
const registry = new Map<string, KekProvider>(BUILTIN.map(p => [p.id, p]))
/** Auto-selection order. Registered (non-builtin) providers are never auto-selected. */
const AUTO_ORDER = ['host-file', 'env', 'legacy-file']

/** Add a KEK source (cloud KMS, 1Password…). Must run before the first encrypt/decrypt. */
export function registerKekProvider(p: KekProvider): void {
  if (registry.has(p.id) && BUILTIN.some(b => b.id === p.id)) {
    throw new Error(`KEK provider id '${p.id}' is built in and cannot be replaced.`)
  }
  registry.set(p.id, p)
}

export function listKekProviders(): string[] {
  return [...registry.keys()]
}

/** Pick the provider for this process. Throws when none can supply a key. */
export function selectKekProvider(env: NodeJS.ProcessEnv = process.env): KekProvider {
  const pinned = env.SECRETS_KEK_PROVIDER?.trim()
  if (pinned) {
    const p = registry.get(pinned)
    if (!p) throw new Error(`SECRETS_KEK_PROVIDER='${pinned}' is not a known provider (${listKekProviders().join(', ')}).`)
    return p
  }
  for (const id of AUTO_ORDER) {
    const p = registry.get(id)!
    if (p.available(env)) return p
  }
  throw new Error(
    'No secrets KEK found. Expected a 32-byte base64 key in the host file ' +
      `${kekFilePath(env)} (mode 400, created by the installer), or SECRETS_KEK_FILE pointing at one. ` +
      'Legacy installs may still set SECRETS_MASTER_KEY. The key MUST be distinct from TEST_CRED_ENCRYPTION_KEY. ' +
      `Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`,
  )
}

/**
 * Roots a session can see. A KEK under any of them is readable by an agent,
 * which is threat T2 in the proposal. `SESSION_VISIBLE_ROOTS` (colon-separated)
 * adds install-specific ones.
 */
export function sessionVisibleRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const roots = ['/tmp', '/app/data', '/home', '/workspace']
  for (const extra of (env.SESSION_VISIBLE_ROOTS || '').split(':')) {
    if (extra.trim()) roots.push(extra.trim())
  }
  return roots
}

export function isUnderSessionVisibleRoot(file: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const abs = path.resolve(file)
  return sessionVisibleRoots(env).some(root => {
    const r = path.resolve(root)
    return abs === r || abs.startsWith(r.endsWith(path.sep) ? r : r + path.sep)
  })
}

export interface KekStatus {
  provider: string | null
  /** Location label — a path or `env:NAME`. Never key material. */
  location: string | null
  legacy: boolean
  /** True when the key sits somewhere a session can read (a session-visible path). */
  sessionVisible: boolean
  ok: boolean
  warnings: string[]
  error: string | null
}

/** Where the KEK comes from and whether that is safe. Never loads or returns the key. */
export function kekStatus(env: NodeJS.ProcessEnv = process.env): KekStatus {
  let p: KekProvider
  try {
    p = selectKekProvider(env)
  } catch (err) {
    return { provider: null, location: null, legacy: false, sessionVisible: false, ok: false, warnings: [], error: (err as Error).message }
  }
  const location = p.describe(env)
  if (!p.available(env)) {
    return { provider: p.id, location, legacy: !!p.legacy, sessionVisible: false, ok: false, warnings: [], error: `KEK provider '${p.id}' has no key at ${location}.` }
  }
  const warnings: string[] = []
  const isPath = location.startsWith('/')
  const sessionVisible = isPath && isUnderSessionVisibleRoot(location, env)
  if (sessionVisible) warnings.push(`The KEK file ${location} is under a session-visible folder. Move it outside every session mount (docs/security.md → "Encryption key").`)
  if (p.id === 'env') warnings.push('The KEK comes from the SECRETS_MASTER_KEY environment variable (legacy). Re-run the installer to move it into a host file.')
  if (p.id === 'host-file') {
    try {
      assertKekFileMode(location)
    } catch (err) {
      warnings.push((err as Error).message)
    }
  }
  return { provider: p.id, location, legacy: !!p.legacy, sessionVisible, ok: true, warnings, error: null }
}
