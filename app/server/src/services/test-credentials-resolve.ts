/**
 * Per-project TEST credential + testing-link resolution (obj-2391).
 *
 * This is an additive SPECIALIZATION on the existing `test_credentials` store
 * (routes/test-credentials.ts, services/crypto.ts). It adds NO new secrets
 * store and NO parallel scope engine — it reuses the same AES-256-GCM encrypted
 * `fields_encrypted` blob, the same (workspace, project) scoping columns, and
 * the same crypto module. The only new primitive is *resolution by project*:
 * given a project, return its canonical test login (decrypted) + testing link
 * (`login_url`) so a QA/Playwright run for project X can log itself in with a
 * managed, non-prod credential instead of a hardcoded prod admin.
 *
 * BOUNDARY: the underlying store owns *how a secret is stored & scoped*
 * (encryption, workspace/project columns, the localhost reviewer-inject seam).
 * THIS module owns *the per-project TEST specialization*: the slug/field
 * convention, the `is_primary` canonical-target marker, and the resolve seam.
 *
 * CONVENTION (documented in docs/testing/test-credentials.md):
 *   - slug:        `<project>-e2e`            (canonical QA login for a project)
 *   - fields:      { username, password }     (Playwright reads these)
 *   - login_url:   the testing link           (preview/test-env base URL)
 *   - is_primary:  1 marks the canonical target when a project has >1 cred
 *
 * Selection precedence when resolving a project (most → least specific):
 *   1. is_primary = 1 for the project
 *   2. slug == `<project>-e2e`
 *   3. most-recently-updated row for the project
 * When `workspace` is supplied, resolution is restricted to that workspace.
 */
import { getDb } from '../db/index.js'
import { decryptCredentialFields } from './crypto.js'

interface TestCredentialRow {
  slug: string
  workspace: string
  project: string | null
  label: string
  login_url: string
  fields_encrypted: string
  notes: string | null
  is_primary: number
  created_by: number | null
  created_at: string
  updated_at: string
}

/** A fully-resolved, DECRYPTED per-project test target. Server-only — the
 *  plaintext `fields` must go to a process env or an authorized seam, never a
 *  log or an unauthenticated body. */
export interface ResolvedTestTarget {
  slug: string
  workspace: string
  project: string | null
  label: string
  /** The per-project testing link (preview/test-env base URL). */
  testingUrl: string
  /** Decrypted login fields, e.g. { username, password }. */
  fields: Record<string, string>
  isPrimary: boolean
}

/** Masked inventory row for the registry / admin listing — never decrypted. */
export interface ProjectTestTargetSummary {
  slug: string
  workspace: string
  project: string | null
  label: string
  testingUrl: string
  isPrimary: boolean
  /** Field names only (values withheld). */
  fieldKeys: string[]
}

function fieldKeysOf(encryptedJson: string): string[] {
  try {
    return Object.keys(JSON.parse(encryptedJson) as Record<string, unknown>)
  } catch {
    return []
  }
}

/**
 * Resolve the canonical test target for a project. Returns null when the
 * project has no managed test credential (callers treat that as "no creds,
 * continue without"). Decrypts the login fields — server-only.
 */
export function resolveProjectTestTarget(opts: {
  project: string
  workspace?: string | null
}): ResolvedTestTarget | null {
  const project = (opts.project ?? '').trim()
  if (!project) return null
  const ws = opts.workspace && opts.workspace.trim() ? opts.workspace.trim() : null
  const db = getDb()

  // Pull every candidate row for the project (optionally restricted to a
  // workspace), then rank in JS so the precedence rule lives in one place.
  const rows = ws
    ? (db
        .prepare('SELECT * FROM test_credentials WHERE project = ? AND workspace = ?')
        .all(project, ws) as TestCredentialRow[])
    : (db
        .prepare('SELECT * FROM test_credentials WHERE project = ?')
        .all(project) as TestCredentialRow[])

  if (rows.length === 0) return null

  const conventionSlug = `${project}-e2e`
  const ranked = [...rows].sort((a, b) => {
    // 1. is_primary wins
    if (a.is_primary !== b.is_primary) return b.is_primary - a.is_primary
    // 2. convention slug wins
    const aConv = a.slug === conventionSlug ? 1 : 0
    const bConv = b.slug === conventionSlug ? 1 : 0
    if (aConv !== bConv) return bConv - aConv
    // 3. most-recently-updated wins
    return b.updated_at.localeCompare(a.updated_at)
  })

  const row = ranked[0]
  return {
    slug: row.slug,
    workspace: row.workspace,
    project: row.project,
    label: row.label,
    testingUrl: row.login_url,
    fields: decryptCredentialFields(row.fields_encrypted),
    isPrimary: row.is_primary === 1,
  }
}

/**
 * Masked inventory of every managed test target, newest first. Powers the
 * registry view; never decrypts. Optionally filter by workspace.
 */
export function listProjectTestTargets(workspace?: string | null): ProjectTestTargetSummary[] {
  const db = getDb()
  const ws = workspace && workspace.trim() ? workspace.trim() : null
  const rows = ws
    ? (db
        .prepare('SELECT * FROM test_credentials WHERE workspace = ? ORDER BY project, is_primary DESC, updated_at DESC')
        .all(ws) as TestCredentialRow[])
    : (db
        .prepare('SELECT * FROM test_credentials ORDER BY workspace, project, is_primary DESC, updated_at DESC')
        .all() as TestCredentialRow[])
  return rows.map(r => ({
    slug: r.slug,
    workspace: r.workspace,
    project: r.project,
    label: r.label,
    testingUrl: r.login_url,
    isPrimary: r.is_primary === 1,
    fieldKeys: fieldKeysOf(r.fields_encrypted),
  }))
}

/**
 * Mark `slug` as the canonical primary for its (workspace, project), clearing
 * any sibling primary in a single transaction so the partial-unique index can
 * never be violated. Returns false if the slug doesn't exist.
 */
export function setPrimaryTestCredential(slug: string): boolean {
  const db = getDb()
  const row = db
    .prepare('SELECT workspace, project FROM test_credentials WHERE slug = ?')
    .get(slug) as { workspace: string; project: string | null } | undefined
  if (!row) return false
  const tx = db.transaction(() => {
    // Clear sibling primaries first (NULL-safe project match), then set this one.
    db.prepare(
      `UPDATE test_credentials SET is_primary = 0, updated_at = datetime('now')
         WHERE workspace = ? AND project IS ? AND slug <> ? AND is_primary = 1`,
    ).run(row.workspace, row.project, slug)
    db.prepare(
      `UPDATE test_credentials SET is_primary = 1, updated_at = datetime('now') WHERE slug = ?`,
    ).run(slug)
  })
  tx()
  return true
}
