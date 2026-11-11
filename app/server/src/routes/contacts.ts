// Phase 2 Personal CRM — admin-only REST surface for the Contacts page.
// All routes are admin-locked per the single-user product decision (see
// 2026-05-30-personal-crm-architecture.md).

import { Router } from 'express'
import { getDb } from '../db/index.js'
import { requireAuth, requireAdmin, type AuthRequest } from '../middleware/auth.js'
import {
  rebuildContactsIndex,
  listContacts,
  getContactByPath,
  readContactFile,
  createContact,
  patchContact,
  extractContactsFromText,
  applyExtractDiff,
  type ContactSort,
  type ContactPatch,
  type CreateContactInput,
  type ExtractDiff,
} from '../services/contacts.js'

const router = Router()
router.use(requireAuth)
router.use(requireAdmin)

const VAULT_BASE = process.env.VAULT_PATH || '/home/operator/second-brain'

// POST /api/contacts/reindex — rebuild contacts_index from vault.
router.post('/reindex', (req: AuthRequest, res) => {
  const dryRun = req.query.dryRun === '1' || req.query.dryRun === 'true'
  const result = rebuildContactsIndex(getDb(), VAULT_BASE, { dryRun })
  res.json({ vault_root: VAULT_BASE, ...result })
})

// GET /api/contacts?sort=overdue|name|recent&tag=...&workspace=...
router.get('/', (req: AuthRequest, res) => {
  const sortParam = (req.query.sort as string) || 'overdue'
  const sort: ContactSort = sortParam === 'name' || sortParam === 'recent' ? sortParam : 'overdue'
  const tag = typeof req.query.tag === 'string' && req.query.tag ? req.query.tag : undefined
  const workspace = typeof req.query.workspace === 'string' && req.query.workspace ? req.query.workspace : undefined
  const rows = listContacts(getDb(), { sort, tag, workspace })
  res.json({ contacts: rows, vault_root: VAULT_BASE })
})

// POST /api/contacts — create a new contact (writes .md file + indexes).
router.post('/', (req: AuthRequest, res) => {
  const body = req.body as CreateContactInput
  if (!body?.name?.trim()) {
    res.status(400).json({ error: 'name is required' })
    return
  }
  try {
    const created = createContact(getDb(), VAULT_BASE, body)
    const summary = getContactByPath(getDb(), created.vault_path)
    res.status(201).json({ ...created, contact: summary })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'create failed'
    const code = /already exists/i.test(message) ? 409 : 400
    res.status(code).json({ error: message })
  }
})

// POST /api/contacts/extract — drop-text → LLM diff.
// Kept above the /by-path routes so route ordering is unambiguous.
router.post('/extract', async (req: AuthRequest, res) => {
  const { text } = req.body as { text?: string }
  if (!text || !text.trim()) {
    res.status(400).json({ error: 'text is required' })
    return
  }
  try {
    const diff = await extractContactsFromText(getDb(), text)
    res.json({ diff })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'extract failed'
    res.status(500).json({ error: message })
  }
})

// POST /api/contacts/extract/apply — write a (possibly-edited) diff to disk.
router.post('/extract/apply', (req: AuthRequest, res) => {
  const { diff } = req.body as { diff?: ExtractDiff }
  if (!diff || typeof diff !== 'object') {
    res.status(400).json({ error: 'diff is required' })
    return
  }
  try {
    const result = applyExtractDiff(getDb(), VAULT_BASE, diff)
    res.json(result)
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'apply failed' })
  }
})

// GET /api/contacts/by-path?path=workspaces/example/contacts/alex-rivera.md
// Query string instead of `/api/contacts/:path` because vault paths contain
// slashes — matches the `/api/docs/file?path=` convention used elsewhere.
router.get('/by-path', (req: AuthRequest, res) => {
  const vaultPath = req.query.path as string
  if (!vaultPath) {
    res.status(400).json({ error: 'path query param required' })
    return
  }
  const summary = getContactByPath(getDb(), vaultPath)
  if (!summary) {
    res.status(404).json({ error: 'Contact not found' })
    return
  }
  const file = readContactFile(VAULT_BASE, vaultPath)
  res.json({
    contact: summary,
    absolute_path: file?.absolute || null,
    content: file?.content || null,
  })
})

// PATCH /api/contacts/by-path?path=...
router.patch('/by-path', (req: AuthRequest, res) => {
  const vaultPath = req.query.path as string
  if (!vaultPath) {
    res.status(400).json({ error: 'path query param required' })
    return
  }
  const patch = req.body as ContactPatch
  if (!patch || typeof patch !== 'object') {
    res.status(400).json({ error: 'JSON body required' })
    return
  }
  try {
    const updated = patchContact(getDb(), VAULT_BASE, vaultPath, patch)
    res.json({ contact: updated })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'patch failed'
    const code = /not found/i.test(message) ? 404 : 400
    res.status(code).json({ error: message })
  }
})

export default router
