/**
 * Knowledge Base Setup routes (obj 900556).
 *
 *   GET  /api/kb-setup/status?workspace=            intake count, active/last run, pages per section, open questions, step_done
 *   POST /api/kb-setup/upload?workspace=            multipart "files" (+ "paths": JSON array of relative paths, same order) → intake/
 *   POST /api/kb-setup/sample?workspace=            copy the built-in sample folder into intake/
 *   POST /api/kb-setup/runs?workspace=              start a run over everything in intake/ (409 while one is active)
 *   GET  /api/kb-setup/runs/:id?workspace=          one run with every file's outcome + the summary
 *   POST /api/kb-setup/runs/:id/pause?workspace=
 *   POST /api/kb-setup/runs/:id/resume?workspace=   {ignore_ceiling?: true}
 *   GET  /api/kb-setup/questions?workspace=         open + answered questions
 *   POST /api/kb-setup/questions/:qid?workspace=    {answer} or {dismiss: true}
 *
 * Every route requires login + membership of the workspace (admins bypass),
 * and only ever touches that ONE workspace's knowledge-base folder — the same
 * gate the file-import and wiki routes use.
 */
import { Router, type Response } from 'express'
import multer from 'multer'
import { requireAuth, type AuthRequest } from '../middleware/auth.js'
import { userHasWorkspace } from '../middleware/workspace.js'
import { getWorkspace } from '../services/workspaces.js'
import { workspaceKbRoot } from '../services/doc-ingest/kb-paths.js'
import { getDb } from '../db/index.js'
import {
  MAX_FILE_BYTES, RunConflictError, addToIntake, answerQuestion, createRun, getRun, pauseRun, readQuestions, resumeRun,
  setupOverview, stageSampleIntake,
} from '../services/kb-setup/runs.js'
import { skipReason } from '../services/kb-setup/extract.js'
import { startRunWorker } from '../services/kb-setup/service.js'

/** Per request; the client sends a big folder in several requests. */
export const MAX_FILES_PER_UPLOAD = 50

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_FILE_BYTES, files: MAX_FILES_PER_UPLOAD } })

const router = Router()
router.use(requireAuth)

function resolveWorkspace(req: AuthRequest, res: Response): string | null {
  const ws = String((req.query.workspace as string | undefined) ?? (req.body?.workspace as string | undefined) ?? '').trim()
  if (!ws) { res.status(400).json({ error: 'workspace is required' }); return null }
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(ws) || !getWorkspace(ws)) { res.status(404).json({ error: `No workspace '${ws}'` }); return null }
  if (req.user!.role !== 'admin' && !userHasWorkspace(req.user!.id, ws)) {
    res.status(403).json({ error: `No access to workspace '${ws}'` }); return null
  }
  return ws
}

function dbOrUndefined() {
  try { return getDb() } catch { return undefined }
}

router.get('/status', (req: AuthRequest, res) => {
  const ws = resolveWorkspace(req, res); if (!ws) return
  const kb = workspaceKbRoot(ws)
  const o = setupOverview(kb)
  // The absolute host path is only useful to an admin who can reach the server.
  res.json({ workspace: ws, ...o, intake: { ...o.intake, folder: req.user!.role === 'admin' ? o.intake.folder : 'intake/' } })
})

router.post('/upload', (req: AuthRequest, res, next) => {
  upload.array('files', MAX_FILES_PER_UPLOAD)(req, res, err => {
    if (err) {
      const msg = err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE'
        ? `A file is over the ${MAX_FILE_BYTES / 1024 / 1024} MB limit.`
        : err instanceof multer.MulterError && err.code === 'LIMIT_FILE_COUNT'
          ? `Send at most ${MAX_FILES_PER_UPLOAD} files per request.`
          : (err as Error).message
      res.status(400).json({ error: msg }); return
    }
    next()
  })
}, (req: AuthRequest, res) => {
  const ws = resolveWorkspace(req, res); if (!ws) return
  const files = (req.files as Express.Multer.File[] | undefined) ?? []
  if (!files.length) { res.status(400).json({ error: 'No files received (form field "files").' }); return }
  let paths: unknown = []
  try { paths = JSON.parse(String(req.body?.paths ?? '[]')) } catch { paths = [] }
  const rels = Array.isArray(paths) ? paths : []
  const kb = workspaceKbRoot(ws)
  const saved: string[] = []
  const skipped: Array<{ path: string; reason: string }> = []
  files.forEach((f, i) => {
    // multer hands back latin1-decoded names; restore UTF-8 (é, –, …).
    const name = Buffer.from(f.originalname, 'latin1').toString('utf8')
    const rel = typeof rels[i] === 'string' && rels[i] ? String(rels[i]) : name
    const why = skipReason(rel)
    // Credentials files are refused at the door: they never touch the disk.
    if (why && /credentials/.test(why)) { skipped.push({ path: rel, reason: why }); return }
    try { saved.push(addToIntake(kb, rel, f.buffer)) } catch (e) { skipped.push({ path: rel, reason: (e as Error).message }) }
  })
  res.status(201).json({ saved, skipped })
})

router.post('/sample', (req: AuthRequest, res) => {
  const ws = resolveWorkspace(req, res); if (!ws) return
  const saved = stageSampleIntake(workspaceKbRoot(ws))
  res.status(201).json({ saved })
})

router.post('/runs', (req: AuthRequest, res) => {
  const ws = resolveWorkspace(req, res); if (!ws) return
  try {
    const run = createRun(workspaceKbRoot(ws), ws, { by: req.user!.username, db: dbOrUndefined() })
    void startRunWorker(ws, run.id)
    res.status(202).json(run)
  } catch (err) {
    res.status(err instanceof RunConflictError ? 409 : 400).json({ error: (err as Error).message })
  }
})

router.get('/runs/:id', (req: AuthRequest, res) => {
  const ws = resolveWorkspace(req, res); if (!ws) return
  let run
  try { run = getRun(workspaceKbRoot(ws), String(req.params.id)) } catch { run = null }
  if (!run) { res.status(404).json({ error: 'No such run' }); return }
  res.json(run)
})

router.post('/runs/:id/pause', (req: AuthRequest, res) => {
  const ws = resolveWorkspace(req, res); if (!ws) return
  try { res.json(pauseRun(workspaceKbRoot(ws), String(req.params.id))) } catch (err) { res.status(404).json({ error: (err as Error).message }) }
})

router.post('/runs/:id/resume', (req: AuthRequest, res) => {
  const ws = resolveWorkspace(req, res); if (!ws) return
  try {
    const run = resumeRun(workspaceKbRoot(ws), String(req.params.id), { ignoreCeiling: req.body?.ignore_ceiling === true, db: dbOrUndefined() })
    if (run.status === 'running') void startRunWorker(ws, run.id)
    res.json(run)
  } catch (err) { res.status(404).json({ error: (err as Error).message }) }
})

router.get('/questions', (req: AuthRequest, res) => {
  const ws = resolveWorkspace(req, res); if (!ws) return
  const qs = readQuestions(workspaceKbRoot(ws))
  res.json({ questions: [...qs.filter(q => q.status === 'open'), ...qs.filter(q => q.status !== 'open')] })
})

router.post('/questions/:qid', (req: AuthRequest, res) => {
  const ws = resolveWorkspace(req, res); if (!ws) return
  try {
    const q = answerQuestion(workspaceKbRoot(ws), String(req.params.qid), {
      answer: typeof req.body?.answer === 'string' ? req.body.answer : undefined,
      dismiss: req.body?.dismiss === true,
      by: req.user!.username,
      db: dbOrUndefined(),
    })
    res.json(q)
  } catch (err) {
    res.status(/No such/.test((err as Error).message) ? 404 : 400).json({ error: (err as Error).message })
  }
})

export default router
