/**
 * Knowledge-base file import routes — starter pack `knowledge-import` (obj 719936).
 *
 *   GET  /api/kb-ingest/enabled               is the pack switched on (nav)
 *   GET  /api/kb-ingest/status?workspace=     files + their reading status
 *   POST /api/kb-ingest/upload?workspace=     multipart "files" → inbox → read
 *   POST /api/kb-ingest/samples?workspace=    copy the pack's sample files in → read
 *   POST /api/kb-ingest/files/:id/retry       read one file again
 *   POST /api/kb-ingest/ask                   {workspace, question} → answer + sources
 *   GET  /api/kb-ingest/note?workspace=&path= one note / source copy (markdown)
 *   GET  /api/kb-ingest/original?workspace=&path=  download an original file
 *
 * Plus the pack's setup hook (localhost + X-Internal-Secret), called by the
 * starter-pack loader: POST /api/internal/kb-ingest/setup {workspace, with_samples}.
 *
 * Every user route requires login + membership of the workspace (admins
 * bypass) and 404s while the pack is switched off. Files are written only
 * under the workspace's knowledge-base folder.
 */
import { Router, type Response, type NextFunction } from 'express'
import fs from 'fs'
import path from 'path'
import multer from 'multer'
import { requireAuth, type AuthRequest } from '../middleware/auth.js'
import { userHasWorkspace } from '../middleware/workspace.js'
import { isLocalhost } from '../lib/is-localhost.js'
import { requireInternalSecret } from '../middleware/internal-secret.js'
import { getWorkspace, updateWorkspace } from '../services/workspaces.js'
import { workspaceKbRoot } from '../services/doc-ingest/kb-paths.js'
import { ensureKbFolders, isDraining, readManifest, requeue, safeFileName } from '../services/doc-ingest/ingest.js'
import { kindForFile, SUPPORTED_EXTENSIONS } from '../services/doc-ingest/extract.js'
import { askKnowledgeBase } from '../services/doc-ingest/ask.js'
import {
  answerLlm, claimAndStart, ingestEnabled, packPrompt, sampleFiles, stageSamples, startDrain,
} from '../services/doc-ingest/service.js'

export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024
const MAX_FILES = 20

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_BYTES, files: MAX_FILES } })

const router = Router()
router.use(requireAuth)

/** Resolve + authorize ?workspace= (or body.workspace). Sends the error and returns null on failure. */
function resolveWorkspace(req: AuthRequest, res: Response): string | null {
  const ws = String((req.query.workspace as string | undefined) ?? (req.body?.workspace as string | undefined) ?? '').trim()
  if (!ws) { res.status(400).json({ error: 'workspace is required' }); return null }
  if (!getWorkspace(ws)) { res.status(404).json({ error: `No workspace '${ws}'` }); return null }
  if (req.user!.role !== 'admin' && !userHasWorkspace(req.user!.id, ws)) {
    res.status(403).json({ error: `No access to workspace '${ws}'` }); return null
  }
  return ws
}

function requireEnabled(_req: AuthRequest, res: Response, next: NextFunction): void {
  if (!ingestEnabled()) {
    res.status(404).json({ error: 'File import is switched off on this install.', pack_enabled: false })
    return
  }
  next()
}

/** Resolve a KB-relative path, refusing anything that escapes the KB folder. */
export function safeKbPath(kbRoot: string, rel: string): string | null {
  if (!rel || rel.includes('\0') || path.isAbsolute(rel)) return null
  const abs = path.resolve(kbRoot, rel)
  return abs.startsWith(kbRoot + path.sep) ? abs : null
}

// Cheap check for the nav: is file import switched on?
router.get('/enabled', (_req, res) => { res.json({ pack_enabled: ingestEnabled() }) })

router.get('/status', (req: AuthRequest, res) => {
  if (!ingestEnabled()) { res.json({ pack_enabled: false }); return }
  const ws = resolveWorkspace(req, res); if (!ws) return
  const kb = workspaceKbRoot(ws)
  const files = readManifest(kb).slice().reverse()
  res.json({
    pack_enabled: true,
    workspace: ws,
    working: isDraining(kb),
    files,
    supported: SUPPORTED_EXTENSIONS,
    max_upload_mb: MAX_UPLOAD_BYTES / 1024 / 1024,
    samples: sampleFiles(),
  })
})

router.post('/upload', requireEnabled, (req: AuthRequest, res, next) => {
  upload.array('files', MAX_FILES)(req, res, err => {
    if (err) {
      const msg = err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE'
        ? `A file is over the ${MAX_UPLOAD_BYTES / 1024 / 1024} MB limit.`
        : (err as Error).message
      res.status(400).json({ error: msg }); return
    }
    next()
  })
}, (req: AuthRequest, res) => {
  const ws = resolveWorkspace(req, res); if (!ws) return
  const files = (req.files as Express.Multer.File[] | undefined) ?? []
  if (!files.length) { res.status(400).json({ error: 'No files received (form field "files").' }); return }
  const kb = workspaceKbRoot(ws)
  ensureKbFolders(kb)
  for (const f of files) {
    // multer hands back latin1-decoded names; restore UTF-8 (é, –, …).
    const name = safeFileName(Buffer.from(f.originalname, 'latin1').toString('utf8'))
    fs.writeFileSync(path.join(kb, 'sources/inbox', name), f.buffer)
  }
  const added = claimAndStart(ws, req.user!.username)
  res.status(202).json({ added })
})

router.post('/samples', requireEnabled, (req: AuthRequest, res) => {
  const ws = resolveWorkspace(req, res); if (!ws) return
  const staged = stageSamples(ws)
  if (!staged.length) { res.status(404).json({ error: 'This install has no sample files.' }); return }
  const added = claimAndStart(ws, req.user!.username)
  res.status(202).json({ added })
})

router.post('/files/:id/retry', requireEnabled, (req: AuthRequest, res) => {
  const ws = resolveWorkspace(req, res); if (!ws) return
  const e = requeue(workspaceKbRoot(ws), String(req.params.id))
  if (!e) { res.status(409).json({ error: 'That file cannot be read again right now.' }); return }
  startDrain(ws)
  res.status(202).json({ file: e })
})

router.post('/ask', requireEnabled, async (req: AuthRequest, res) => {
  const ws = resolveWorkspace(req, res); if (!ws) return
  const question = typeof req.body?.question === 'string' ? req.body.question.trim() : ''
  if (!question) { res.status(400).json({ error: 'question is required' }); return }
  if (question.length > 2000) { res.status(400).json({ error: 'Keep the question under 2,000 characters.' }); return }
  try {
    res.json(await askKnowledgeBase(workspaceKbRoot(ws), question, answerLlm(), packPrompt('answer')))
  } catch (err) {
    res.status(502).json({ error: (err as Error).message })
  }
})

router.get('/note', requireEnabled, (req: AuthRequest, res) => {
  const ws = resolveWorkspace(req, res); if (!ws) return
  const kb = workspaceKbRoot(ws)
  const rel = String(req.query.path ?? '')
  const abs = safeKbPath(kb, rel)
  if (!abs || !rel.endsWith('.md') || !fs.existsSync(abs)) { res.status(404).json({ error: 'Note not found' }); return }
  res.json({ path: rel, content: fs.readFileSync(abs, 'utf8') })
})

router.get('/original', requireEnabled, (req: AuthRequest, res) => {
  const ws = resolveWorkspace(req, res); if (!ws) return
  const kb = workspaceKbRoot(ws)
  const rel = String(req.query.path ?? '')
  const abs = safeKbPath(kb, rel)
  if (!abs || !rel.startsWith('sources/files/') || !kindForFile(abs) || !fs.existsSync(abs)) { res.status(404).json({ error: 'File not found' }); return }
  const entry = readManifest(kb).find(e => e.stored === rel)
  res.download(abs, entry?.file_name ?? path.basename(abs))
})

export default router

// ── Pack setup hook (called by the starter-pack loader) ─────────────────────

export const internalKbIngestRouter = Router()

internalKbIngestRouter.use((req, res, next) => {
  if (!isLocalhost(req)) { res.status(403).json({ error: 'Internal API: localhost only' }); return }
  if (!requireInternalSecret(req, res)) return
  next()
})

// POST /api/internal/kb-ingest/setup {workspace} — make the KB folders. Idempotent.
// Sample files are NOT ingested here: the demo starts with an empty knowledge base and
// the "Add sample files" button, so the audience sees the reading happen.
internalKbIngestRouter.post('/setup', (req, res) => {
  const ws = typeof req.body?.workspace === 'string' ? req.body.workspace : ''
  if (!getWorkspace(ws)) { res.status(404).json({ error: `No workspace '${ws}'` }); return }
  const kb = workspaceKbRoot(ws)
  ensureKbFolders(kb)
  // Let the rest of the app (Knowledge base page, search, agents' read access)
  // see the imported notes, and let people edit them there.
  const w = getWorkspace(ws)!
  const covers = (roots: string[]) => roots.some(r => kb === r || kb.startsWith(r.replace(/\/+$/, '') + '/'))
  const patch: { doc_read_roots?: string[]; doc_write_roots?: string[] } = {}
  if (!covers(w.doc_read_roots)) patch.doc_read_roots = [...w.doc_read_roots, kb]
  if (!covers(w.doc_write_roots)) patch.doc_write_roots = [...w.doc_write_roots, kb]
  if (patch.doc_read_roots || patch.doc_write_roots) updateWorkspace(ws, patch)
  res.json({ ok: true, workspace: ws, knowledge_base: kb, samples_available: sampleFiles().length })
})
