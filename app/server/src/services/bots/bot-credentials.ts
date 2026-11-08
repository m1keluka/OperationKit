/**
 * Runtime credential revocation + secret-injection policy (obj 900323, G10).
 *
 * The gap this closes (architecture report C7): a worker's authorization is
 * snapshotted at SPAWN. Secrets are resolved into the process environment once,
 * and from then on revoking a connector or a key changes nothing for a session
 * that is already running — it keeps using what it was handed until it exits.
 * There is no live check anywhere on the tool path.
 *
 * So this module provides the live check, and it is deliberately FAIL-CLOSED:
 *
 *  - `assertCredentialLive` returns `allowed: false` when the subject is
 *    revoked, AND when the ledger cannot be read at all. An unreadable ledger
 *    is an unknown authorization state, and "unknown" must not mean "yes" —
 *    that is the exact mistake that makes a revocation cosmetic.
 *  - Revocation is scoped `(scope, subject)` with `'*'` as a wildcard subject,
 *    so revoking one connector, one secret NAME, or everything a bot holds are
 *    the same operation at three granularities.
 *  - The gate is evaluated on the NEXT authorized tool call, not on a timer.
 *    The guarantee is therefore precise and modest, and is stated that way:
 *    **the next tool call after a revocation fails**. An in-flight HTTP request
 *    that already has the value is not interrupted, because nothing in this
 *    process can interrupt it.
 *
 * ## Secret-injection policy
 *
 * `assertSecretReadable` is the second half, and its default is NO. Secrets are
 * not blanket-readable by a job: a name must be on the job's explicit allowlist
 * AND not revoked. The function returns the NAME and never the value — there is
 * no code path in this module that reads a secret's plaintext, which is why it
 * cannot leak one into a log, a transcript or a thread message.
 */
import type { Database } from 'better-sqlite3'

export type CredentialScope = 'connector' | 'secret' | 'agent_key'

export interface RevocationRow {
  id: number
  scope: string
  subject: string
  reason: string | null
  revoked_at: string
  restored_at: string | null
}

export interface CredentialVerdict {
  allowed: boolean
  /** `ok` | `revoked` | `ledger_unavailable` | `not_permitted` */
  code: string
  reason: string | null
  /** The matching revocation, when there is one. */
  revocation?: RevocationRow
}

/** Revoke a credential for every job, from now on. Idempotent per (scope, subject). */
export function revokeCredential(db: Database, scope: CredentialScope, subject: string, reason?: string): RevocationRow {
  const live = findLiveRevocation(db, scope, subject)
  if (live) return live
  const info = db.prepare('INSERT INTO bot_credential_revocations (scope, subject, reason) VALUES (?, ?, ?)').run(scope, subject, reason ?? null)
  return db.prepare('SELECT * FROM bot_credential_revocations WHERE id = ?').get(Number(info.lastInsertRowid)) as RevocationRow
}

/** Lift a revocation. Recorded, not deleted — the ledger stays auditable. */
export function restoreCredential(db: Database, scope: CredentialScope, subject: string): number {
  return db
    .prepare("UPDATE bot_credential_revocations SET restored_at = datetime('now') WHERE scope = ? AND subject = ? AND restored_at IS NULL")
    .run(scope, subject).changes
}

/** The live revocation covering this subject (exact match or the `*` wildcard), or null. */
export function findLiveRevocation(db: Database, scope: CredentialScope, subject: string): RevocationRow | null {
  return (
    (db
      .prepare(
        `SELECT * FROM bot_credential_revocations
          WHERE scope = ? AND restored_at IS NULL AND (subject = ? OR subject = '*')
          ORDER BY id DESC LIMIT 1`,
      )
      .get(scope, subject) as RevocationRow | undefined) ?? null
  )
}

/**
 * The gate a tool call must pass. Fail-closed on a revoked subject and on an
 * unreadable ledger alike.
 */
export function assertCredentialLive(db: Database, scope: CredentialScope, subject: string): CredentialVerdict {
  let live: RevocationRow | null
  try {
    live = findLiveRevocation(db, scope, subject)
  } catch (err) {
    return {
      allowed: false,
      code: 'ledger_unavailable',
      reason: `Cannot read the revocation ledger (${(err as Error).message}). Failing closed: an unknown authorization state is not permission.`,
    }
  }
  if (live) {
    return {
      allowed: false,
      code: 'revoked',
      reason: `${scope} "${subject}" was revoked at ${live.revoked_at}${live.reason ? ` (${live.reason})` : ''}. The next tool call after a revocation fails; this is that call.`,
      revocation: live,
    }
  }
  return { allowed: true, code: 'ok', reason: null }
}

export interface SecretPolicy {
  /** The ONLY secret names this job may use. Empty = none. */
  allowed: string[]
}

/**
 * May this job use this secret NAME? Default no.
 *
 * The owner's own permissions remain the ceiling: a name the person cannot use
 * is not grantable by putting it on a job allowlist, which is why callers pass
 * the allowlist they derived from the owner, never a wildcard. Returns names
 * only — never a value.
 */
export function assertSecretReadable(db: Database, policy: SecretPolicy, name: string): CredentialVerdict {
  if (!policy.allowed.includes(name)) {
    return {
      allowed: false,
      code: 'not_permitted',
      reason: `Secret "${name}" is not on this job's allowlist. Secrets are not blanket-readable: a job may use only the names explicitly granted to it, and never more than its owner holds.`,
    }
  }
  return assertCredentialLive(db, 'secret', name)
}
