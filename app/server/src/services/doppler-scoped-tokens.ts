/**
 * Scoped, read-only Doppler service-token map (obj-2411 / Phase 0 of #1731).
 *
 * WHY THIS EXISTS
 * Today every spawned session receives ONE personal *admin* Doppler token
 * (`getDopplerToken()` in session-manager.ts), so any session for any project can
 * read every project's secrets. The Phase 0 remediation
 * (`app/server/SPAWN-ENV-SCOPING-CUTOVER.md`) replaces that, for member-tier
 * sessions, with ONE **read-only** Doppler *service* token scoped to exactly the
 * objective's workspace/config. This module is the provisioned MAP that the
 * `getScopedDopplerToken` seam resolves against.
 *
 * SECURITY CONTRACT
 *  - The raw service token is stored ONLY as `token_encrypted` (AES-256-GCM via
 *    services/crypto.ts — the same primitive `user_github_tokens` uses). It is
 *    decrypted server-side only at spawn, and flows straight into the child env.
 *  - Resolution FAILS CLOSED: an unknown workspace, a decrypt error, or any DB
 *    error returns '' — a member session then gets NO `DOPPLER_TOKEN`, never the
 *    admin token. We never throw out of the resolver (a spawn must not be blocked,
 *    mirroring userGitIdentityEnv's contract).
 *  - Rows are populated out-of-band by
 *    `scripts/provision-scoped-doppler-tokens.ts` (DRY-RUN by default; minting live
 *    tokens + writing live rows is an explicit, Mike-gated step). This module does
 *    not mint anything; it only stores/reads what the provisioning step supplies.
 */

import { getDb } from '../db/index.js'
import { encryptField, decryptField } from './crypto.js'

/** Default Doppler config every workspace's scoped token is minted from. */
export const DEFAULT_DOPPLER_CONFIG = 'prd'

export interface ScopedDopplerTokenSummary {
  workspace: string
  config: string
  /** Masked last-4 of the raw token. The raw token is NEVER exposed here. */
  token_last4: string
  doppler_project: string | null
  note: string | null
  created_at: string
  updated_at: string
}

export interface SetScopedDopplerTokenInput {
  workspace: string
  /** Doppler config the token was minted from; defaults to 'prd'. */
  config?: string
  /** The raw read-only Doppler service token (stored encrypted). */
  token: string
  /** Doppler project the token is scoped to (provenance only). */
  dopplerProject?: string | null
  note?: string | null
}

function last4(s: string): string {
  return s.length <= 4 ? s : s.slice(-4)
}

interface Row {
  workspace: string
  config: string
  token_encrypted: string
  token_last4: string
  doppler_project: string | null
  note: string | null
  created_at: string
  updated_at: string
}

function rowToSummary(r: Row): ScopedDopplerTokenSummary {
  return {
    workspace: r.workspace,
    config: r.config,
    token_last4: r.token_last4,
    doppler_project: r.doppler_project,
    note: r.note,
    created_at: r.created_at,
    updated_at: r.updated_at,
  }
}

/**
 * Upsert a scoped read-only Doppler token for (workspace, config). The raw token
 * is encrypted before storage. UNIQUE(workspace, config) makes a re-provision an
 * update, not a duplicate. Returns the masked summary.
 */
export function setScopedDopplerToken(input: SetScopedDopplerTokenInput): ScopedDopplerTokenSummary {
  const workspace = input.workspace.trim()
  const config = (input.config || DEFAULT_DOPPLER_CONFIG).trim()
  if (!workspace) throw new Error('setScopedDopplerToken: workspace is required')
  if (!input.token) throw new Error('setScopedDopplerToken: token is required')

  const encrypted = encryptField(input.token)
  const l4 = last4(input.token)
  getDb()
    .prepare(
      `INSERT INTO doppler_scoped_tokens
         (workspace, config, token_encrypted, token_last4, doppler_project, note, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
       ON CONFLICT(workspace, config) DO UPDATE SET
         token_encrypted = excluded.token_encrypted,
         token_last4     = excluded.token_last4,
         doppler_project = excluded.doppler_project,
         note            = excluded.note,
         updated_at      = datetime('now')`,
    )
    .run(workspace, config, encrypted, l4, input.dopplerProject ?? null, input.note ?? null)

  const saved = getDb()
    .prepare('SELECT * FROM doppler_scoped_tokens WHERE workspace = ? AND config = ?')
    .get(workspace, config) as Row | undefined
  if (!saved) throw new Error('setScopedDopplerToken: upsert returned no row')
  return rowToSummary(saved)
}

/**
 * Resolve the decrypted read-only Doppler token for a workspace. FAILS CLOSED:
 * returns '' when no row matches, the row can't be decrypted, or any DB error
 * occurs — NEVER throws. Prefers the DEFAULT_DOPPLER_CONFIG ('prd') row when a
 * workspace has tokens minted for several configs, so resolution is deterministic.
 */
export function getScopedDopplerTokenForWorkspace(
  workspace: string | null | undefined,
  config?: string,
): string {
  if (!workspace) return ''
  try {
    const db = getDb()
    let row: Row | undefined
    if (config) {
      row = db
        .prepare('SELECT * FROM doppler_scoped_tokens WHERE workspace = ? AND config = ?')
        .get(workspace, config) as Row | undefined
    } else {
      // No explicit config: prefer the 'prd' row, else any row (most recent).
      row = db
        .prepare(
          `SELECT * FROM doppler_scoped_tokens
             WHERE workspace = ?
             ORDER BY (config = ?) DESC, updated_at DESC
             LIMIT 1`,
        )
        .get(workspace, DEFAULT_DOPPLER_CONFIG) as Row | undefined
    }
    if (!row) return ''
    return decryptField(row.token_encrypted)
  } catch {
    // Fail closed — no token rather than the admin token, and never block a spawn.
    return ''
  }
}

/** Masked listing of every provisioned scoped token (for the provisioning
 *  script's status output / an admin audit surface). Raw tokens never returned. */
export function listScopedDopplerTokens(): ScopedDopplerTokenSummary[] {
  const rows = getDb()
    .prepare('SELECT * FROM doppler_scoped_tokens ORDER BY workspace, config')
    .all() as Row[]
  return rows.map(rowToSummary)
}

/** Remove a provisioned scoped token. Returns true if a row was deleted. */
export function deleteScopedDopplerToken(workspace: string, config = DEFAULT_DOPPLER_CONFIG): boolean {
  const res = getDb()
    .prepare('DELETE FROM doppler_scoped_tokens WHERE workspace = ? AND config = ?')
    .run(workspace, config)
  return res.changes > 0
}
