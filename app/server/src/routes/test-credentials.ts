/**
 * Test credentials API.
 *
 * The reviewer subagent uses these credentials at AI-Review time to log into
 * the deliverable's UI / API. Field values are encrypted at rest via
 * services/crypto.ts (AES-256-GCM, per-value IV); the encrypted blob lives in
 * `test_credentials.fields_encrypted` as a JSON `{name: cipher}` map.
 *
 * Authorization model:
 *   - Workspace-scoped routes require the caller to be a workspace admin in
 *     the relevant workspace (or a global admin). Global admins bypass every
 *     check. Workspace admins are identified by
 *     `user_workspaces.role = 'admin'` AND `workspace = <slug>`.
 *   - The internal route is localhost-only (no auth) and returns plaintext
 *     fields — used by `spawnReviewerSession` to inject `TESTCRED_*` env.
 *
 * Listing semantics (GET /api/test-credentials):
 *   - Returns only `fields` keys, with values masked as '***'. The encrypted
 *     blob never leaves the server.
 *   - Filtered by `?workspace=<slug>` (required for workspace admins; global
 *     admins omit it to see everything).
 *
 * Single-record read (GET /api/test-credentials/:slug) returns DECRYPTED
 * fields so an admin can copy the values into the UI for editing. This is the
 * only path that surfaces plaintext to the client and it requires the
 * cookie-bound admin role.
 */
import { Router } from 'express'
import type { Request } from 'express'
import { getDb } from '../db/index.js'
import { requireAuth, type AuthRequest } from '../middleware/auth.js'
import { requireInternalSecret } from '../middleware/internal-secret.js'
import { encryptCredentialFields, decryptCredentialFields } from '../services/crypto.js'
import {
  resolveProjectTestTarget,
  setPrimaryTestCredential,
} from '../services/test-credentials-resolve.js'
import type {
  CreateTestCredentialRequest,
  TestCredential,
  UpdateTestCredentialRequest,
} from '@command-center/shared'
import { isLocalhost } from '../lib/is-localhost.js'

interface TestCredentialRow {
  slug: string
  workspace: string
  project: string | null
  label: string
  login_url: string
  fields_encrypted: string
  notes: string | null
  created_by: number | null
  created_at: string
  updated_at: string
}

function maskFields(encryptedJson: string): Record<string, string> {
  let parsed: Record<string, unknown> = {}
  try { parsed = JSON.parse(encryptedJson) as Record<string, unknown> } catch {}
  const out: Record<string, string> = {}
  for (const k of Object.keys(parsed)) out[k] = '***'
  return out
}

function mapRow(row: TestCredentialRow, decryptFields: boolean): TestCredential {
  let fields: Record<string, string> = {}
  if (decryptFields) {
    try {
      fields = decryptCredentialFields(row.fields_encrypted)
    } catch (err) {
      console.error(`[test-credentials] decrypt failed for slug=${row.slug}:`, err)
      fields = {}
    }
  } else {
    fields = maskFields(row.fields_encrypted)
  }
  return {
    slug: row.slug,
    workspace: row.workspace,
    project: row.project,
    label: row.label,
    login_url: row.login_url,
    fields,
    notes: row.notes,
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

/** True if the caller is either a global admin or a workspace admin for `ws`. */
function isWorkspaceAdmin(userId: number, ws: string): boolean {
  const db = getDb()
  const row = db
    .prepare('SELECT role FROM user_workspaces WHERE user_id = ? AND workspace = ?')
    .get(userId, ws) as { role: string } | undefined
  return row?.role === 'admin'
}

/** Workspaces where this user has admin role — used to scope the unfiltered list. */
function adminWorkspaces(userId: number): string[] {
  const db = getDb()
  const rows = db
    .prepare("SELECT workspace FROM user_workspaces WHERE user_id = ? AND role = 'admin'")
    .all(userId) as Array<{ workspace: string }>
  return rows.map(r => r.workspace)
}

// ─── Authenticated workspace-admin routes ───────────────────────────────────

const router = Router()
router.use(requireAuth)

// GET /api/test-credentials?workspace=<slug>  (admin-scoped list, fields masked)
router.get('/', (req: AuthRequest, res) => {
  const user = req.user!
  const wsParam = (req.query.workspace as string | undefined) || undefined
  const db = getDb()

  let rows: TestCredentialRow[]
  if (user.role === 'admin') {
    // Global admin: optional workspace filter; otherwise everything.
    if (wsParam) {
      rows = db
        .prepare('SELECT * FROM test_credentials WHERE workspace = ? ORDER BY updated_at DESC')
        .all(wsParam) as TestCredentialRow[]
    } else {
      rows = db
        .prepare('SELECT * FROM test_credentials ORDER BY updated_at DESC')
        .all() as TestCredentialRow[]
    }
  } else {
    // Workspace admin: must request a specific workspace they admin.
    if (!wsParam) {
      const owned = adminWorkspaces(user.id)
      if (owned.length === 0) {
        res.json([])
        return
      }
      const placeholders = owned.map(() => '?').join(',')
      rows = db
        .prepare(
          `SELECT * FROM test_credentials WHERE workspace IN (${placeholders}) ORDER BY updated_at DESC`
        )
        .all(...owned) as TestCredentialRow[]
    } else {
      if (!isWorkspaceAdmin(user.id, wsParam)) {
        res.status(403).json({ error: `Workspace admin role required for '${wsParam}'` })
        return
      }
      rows = db
        .prepare('SELECT * FROM test_credentials WHERE workspace = ? ORDER BY updated_at DESC')
        .all(wsParam) as TestCredentialRow[]
    }
  }

  res.json(rows.map(r => mapRow(r, false)))
})

// GET /api/test-credentials/resolve?project=<p>[&workspace=<ws>] (obj-2391)
// Resolve the canonical test target (decrypted login + testing link) for a
// project. Authorized like the single-record read: global admins, or a
// workspace admin of the RESOLVED row's workspace. Returns 404 when the project
// has no managed test credential. Declared BEFORE '/:slug' so "resolve" is not
// captured as a slug.
router.get('/resolve', (req: AuthRequest, res) => {
  const user = req.user!
  const project = (req.query.project as string | undefined)?.trim()
  const workspace = (req.query.workspace as string | undefined)?.trim() || undefined
  if (!project) {
    res.status(400).json({ error: 'project query param is required' })
    return
  }
  const target = resolveProjectTestTarget({ project, workspace })
  if (!target) {
    res.status(404).json({ error: `No managed test credential for project '${project}'` })
    return
  }
  if (user.role !== 'admin' && !isWorkspaceAdmin(user.id, target.workspace)) {
    res.status(403).json({ error: `Workspace admin role required for '${target.workspace}'` })
    return
  }
  res.json(target)
})

// GET /api/test-credentials/:slug — decrypted fields
router.get('/:slug', (req: AuthRequest, res) => {
  const user = req.user!
  const db = getDb()
  const row = db
    .prepare('SELECT * FROM test_credentials WHERE slug = ?')
    .get(req.params.slug) as TestCredentialRow | undefined
  if (!row) {
    res.status(404).json({ error: 'Test credential not found' })
    return
  }
  if (user.role !== 'admin' && !isWorkspaceAdmin(user.id, row.workspace)) {
    res.status(403).json({ error: `Workspace admin role required for '${row.workspace}'` })
    return
  }
  res.json(mapRow(row, true))
})

// POST /api/test-credentials — create + encrypt
router.post('/', (req: AuthRequest, res) => {
  const user = req.user!
  const body = req.body as CreateTestCredentialRequest
  if (!body || !body.slug || !body.workspace || !body.label || !body.login_url || !body.fields || typeof body.fields !== 'object') {
    res.status(400).json({ error: 'slug, workspace, label, login_url, and fields are required' })
    return
  }
  if (!/^[a-z0-9][a-z0-9-_]{1,60}$/.test(body.slug)) {
    res.status(400).json({ error: 'slug must be 2-61 chars: lowercase alnum + hyphen/underscore' })
    return
  }
  if (user.role !== 'admin' && !isWorkspaceAdmin(user.id, body.workspace)) {
    res.status(403).json({ error: `Workspace admin role required for '${body.workspace}'` })
    return
  }

  let fieldsEncrypted: string
  try {
    fieldsEncrypted = encryptCredentialFields(body.fields)
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'encryption failed' })
    return
  }

  const db = getDb()
  try {
    db.prepare(
      `INSERT INTO test_credentials
        (slug, workspace, project, label, login_url, fields_encrypted, notes, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      body.slug,
      body.workspace,
      body.project ?? null,
      body.label,
      body.login_url,
      fieldsEncrypted,
      body.notes ?? null,
      user.id
    )
  } catch (err) {
    if (err instanceof Error && /UNIQUE/.test(err.message)) {
      res.status(409).json({ error: `slug '${body.slug}' already exists` })
      return
    }
    throw err
  }

  const row = db
    .prepare('SELECT * FROM test_credentials WHERE slug = ?')
    .get(body.slug) as TestCredentialRow
  res.status(201).json(mapRow(row, true))
})

// PUT /api/test-credentials/:slug — full or partial update; re-encrypts when fields provided
router.put('/:slug', (req: AuthRequest, res) => {
  const user = req.user!
  const db = getDb()
  const existing = db
    .prepare('SELECT * FROM test_credentials WHERE slug = ?')
    .get(req.params.slug) as TestCredentialRow | undefined
  if (!existing) {
    res.status(404).json({ error: 'Test credential not found' })
    return
  }
  if (user.role !== 'admin' && !isWorkspaceAdmin(user.id, existing.workspace)) {
    res.status(403).json({ error: `Workspace admin role required for '${existing.workspace}'` })
    return
  }

  const body = req.body as UpdateTestCredentialRequest

  // If workspace is changing, the caller must also have admin in the target.
  if (body.workspace && body.workspace !== existing.workspace) {
    if (user.role !== 'admin' && !isWorkspaceAdmin(user.id, body.workspace)) {
      res.status(403).json({ error: `Workspace admin role required for '${body.workspace}'` })
      return
    }
  }

  let fieldsEncrypted = existing.fields_encrypted
  if (body.fields !== undefined) {
    if (!body.fields || typeof body.fields !== 'object') {
      res.status(400).json({ error: 'fields must be an object' })
      return
    }
    try {
      fieldsEncrypted = encryptCredentialFields(body.fields)
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'encryption failed' })
      return
    }
  }

  db.prepare(
    `UPDATE test_credentials SET
       workspace = COALESCE(?, workspace),
       project = ?,
       label = COALESCE(?, label),
       login_url = COALESCE(?, login_url),
       fields_encrypted = ?,
       notes = ?,
       updated_at = datetime('now')
     WHERE slug = ?`
  ).run(
    body.workspace ?? null,
    body.project !== undefined ? body.project : existing.project,
    body.label ?? null,
    body.login_url ?? null,
    fieldsEncrypted,
    body.notes !== undefined ? body.notes : existing.notes,
    req.params.slug
  )

  const row = db
    .prepare('SELECT * FROM test_credentials WHERE slug = ?')
    .get(req.params.slug) as TestCredentialRow
  res.json(mapRow(row, true))
})

// POST /api/test-credentials/:slug/primary — mark this slug the canonical QA
// target for its (workspace, project). Clears any sibling primary atomically.
router.post('/:slug/primary', (req: AuthRequest, res) => {
  const user = req.user!
  const db = getDb()
  const existing = db
    .prepare('SELECT workspace FROM test_credentials WHERE slug = ?')
    .get(req.params.slug) as { workspace: string } | undefined
  if (!existing) {
    res.status(404).json({ error: 'Test credential not found' })
    return
  }
  if (user.role !== 'admin' && !isWorkspaceAdmin(user.id, existing.workspace)) {
    res.status(403).json({ error: `Workspace admin role required for '${existing.workspace}'` })
    return
  }
  setPrimaryTestCredential(String(req.params.slug))
  const row = db
    .prepare('SELECT * FROM test_credentials WHERE slug = ?')
    .get(req.params.slug) as TestCredentialRow
  res.json(mapRow(row, false))
})

// DELETE /api/test-credentials/:slug
router.delete('/:slug', (req: AuthRequest, res) => {
  const user = req.user!
  const db = getDb()
  const existing = db
    .prepare('SELECT workspace FROM test_credentials WHERE slug = ?')
    .get(req.params.slug) as { workspace: string } | undefined
  if (!existing) {
    res.status(404).json({ error: 'Test credential not found' })
    return
  }
  if (user.role !== 'admin' && !isWorkspaceAdmin(user.id, existing.workspace)) {
    res.status(403).json({ error: `Workspace admin role required for '${existing.workspace}'` })
    return
  }
  db.prepare('DELETE FROM test_credentials WHERE slug = ?').run(req.params.slug)
  res.status(204).end()
})

// ─── Localhost-only internal route ──────────────────────────────────────────

export const internalTestCredentialsRouter = Router()

// GET /api/internal/test-credentials/resolve?project=<p>[&workspace=<ws>]
// (obj-2391) — localhost-only plaintext resolve BY PROJECT for the QA/Playwright
// spawn path: a run for project X fetches its managed test login + testing link
// here instead of carrying a hardcoded prod admin. Declared BEFORE '/:slug'.
// 404 = no managed cred for the project; callers continue without.
internalTestCredentialsRouter.get('/resolve', (req, res) => {
  if (!isLocalhost(req)) {
    res.status(403).json({ error: 'Internal API: localhost only' })
    return
  }
  if (!requireInternalSecret(req, res)) return
  const project = (req.query.project as string | undefined)?.trim()
  const workspace = (req.query.workspace as string | undefined)?.trim() || undefined
  if (!project) {
    res.status(400).json({ error: 'project query param is required' })
    return
  }
  try {
    const target = resolveProjectTestTarget({ project, workspace })
    if (!target) {
      res.status(404).json({ error: `No managed test credential for project '${project}'` })
      return
    }
    res.json(target)
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'resolution failed' })
  }
})

// GET /api/internal/test-credentials/:slug — plaintext fields for the reviewer
// spawn path. Returns 404 if the slug is missing — callers (session-manager)
// should treat that as "no creds, continue without".
internalTestCredentialsRouter.get('/:slug', (req, res) => {
  if (!isLocalhost(req)) {
    res.status(403).json({ error: 'Internal API: localhost only' })
    return
  }
  if (!requireInternalSecret(req, res)) return
  const db = getDb()
  const row = db
    .prepare('SELECT * FROM test_credentials WHERE slug = ?')
    .get(req.params.slug) as TestCredentialRow | undefined
  if (!row) {
    res.status(404).json({ error: 'Test credential not found' })
    return
  }
  try {
    res.json(mapRow(row, true))
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'decryption failed' })
  }
})

export default router
