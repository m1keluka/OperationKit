/**
 * Knowledge-base wiki routes (obj 720117) — the HTTP surface over
 * services/kb-wiki/: browse the compiled wiki, file Ask answers back as pages,
 * import chat exports and call transcripts, and the cleanup (lint) pass.
 *
 *   GET  /api/kb-wiki/pages?workspace=                 every wiki page + counts per kind
 *   GET  /api/kb-wiki/page?workspace=&path=            one page + its backlinks
 *   POST /api/kb-wiki/answers                          {workspace, question, answer, sources} → saved page
 *   POST /api/kb-wiki/imports?workspace=               multipart "files" → import jobs (in review)
 *   POST /api/kb-wiki/imports/samples?workspace=       the made-up sample chats and calls
 *   GET  /api/kb-wiki/imports?workspace=               jobs (no item rows) + working flag
 *   GET  /api/kb-wiki/imports/:id/items?workspace=&q=&from=&to=&status=&min_messages=&offset=&limit=
 *   POST /api/kb-wiki/imports/:id/select               {workspace, keys? | all_matching?, selected}
 *   POST /api/kb-wiki/imports/:id/start|pause|cancel   {workspace}
 *   GET  /api/kb-wiki/lint?workspace=                  last cleanup report + settings + next run
 *   POST /api/kb-wiki/lint/run?workspace=              run the cleanup now
 *   PUT  /api/kb-wiki/lint/settings                    admin only
 *   POST /api/kb-wiki/rebuild?workspace=               admin only, body {confirm: true}
 *   GET  /api/kb-wiki/graph/related?workspace=&page=&depth=   pages connected to one page (link graph, obj 720162)
 *   GET  /api/kb-wiki/graph/who-knows?workspace=&topic=      people linked to a topic, best-sourced first
 *
 * Internal (localhost only), for board-card sessions filing answers with curl:
 *   POST /api/internal/kb-wiki/answers {workspace, question, answer, sources, filed_by}
 *
 * Every user route needs login + workspace membership (admins bypass), and
 * 404s while the document library is switched off. Errors are {error: "<plain sentence>"}.
 */
import { Router, type Response, type NextFunction } from 'express'
import fs from 'fs'
import os from 'os'
import path from 'path'
import multer from 'multer'
import { requireAuth, requireAdmin, type AuthRequest } from '../middleware/auth.js'
import { userHasWorkspace } from '../middleware/workspace.js'
import { isLocalhost } from '../lib/is-localhost.js'
import { getDb } from '../db/index.js'
import { getWorkspace, getWorkspaceSlugs } from '../services/workspaces.js'
import { workspaceKbRoot } from '../services/doc-ingest/kb-paths.js'
import { ingestEnabled, startDrain } from '../services/doc-ingest/service.js'
import { generatedPagePath, onWikiCompiled, readPage, scanWiki } from '../services/kb-wiki/wiki.js'
import { MAX_RELATED_DEPTH, kbRelated, kbWhoKnows, syncGraph } from '../services/kb-wiki/graph.js'
import { fileAnswer } from '../services/kb-wiki/answers.js'
import { LINT_LAST, type LintReport } from '../services/kb-wiki/lint.js'
import { runLintForWorkspace, startWikiLintScheduler } from '../services/kb-wiki/scheduler.js'
import { getWikiSettings, saveWikiSettings, type WikiSettings } from '../services/kb-wiki/settings.js'
import { rebuildWiki } from '../services/kb-wiki/rebuild.js'
import { IMPORTS_STATE_DIR, INDEX_PAGE, LOG_PAGE, isProtectedPath } from '../services/kb-wiki/paths.js'
import {
  ImportNotFoundError, cancelImport, createImport, isImporting, listImports, listItems, pauseImport,
  resumeImports, sampleImportFiles, selectItems, startImport, type ItemFilter, type ImportItemStatus, type ImportJob, type ImportJobSummary,
} from '../services/kb-wiki/imports.js'

export const MAX_IMPORT_BYTES = 500 * 1024 * 1024
const MAX_IMPORT_FILES = 20
/** All files in one upload together — each is read into memory while it is parsed. */
export const MAX_IMPORT_TOTAL_BYTES = 1024 * 1024 * 1024
const ITEM_STATUSES: ImportItemStatus[] = ['pending', 'queued', 'working', 'done', 'skipped', 'failed']

const upload = multer({
  storage: multer.diskStorage({ destination: os.tmpdir() }),
  limits: { fileSize: MAX_IMPORT_BYTES, files: MAX_IMPORT_FILES },
})

const router = Router()
router.use(requireAuth)

/** Resolve + authorize ?workspace= (or body.workspace). Sends the error and returns null on failure. */
function resolveWorkspace(req: AuthRequest, res: Response): string | null {
  const ws = String((req.query.workspace as string | undefined) ?? (req.body?.workspace as string | undefined) ?? '').trim()
  if (!ws) { res.status(400).json({ error: 'Say which workspace (workspace is required).' }); return null }
  if (!getWorkspace(ws)) { res.status(404).json({ error: `There is no workspace called '${ws}'.` }); return null }
  if (req.user!.role !== 'admin' && !userHasWorkspace(req.user!.id, ws)) {
    res.status(403).json({ error: `You do not have access to the workspace '${ws}'.` }); return null
  }
  // A scoped agent key may also be pinned to a list of workspaces.
  const allow = req.agentKey?.workspaces
  if (allow && !allow.includes(ws)) {
    res.status(403).json({ error: `This key cannot use the workspace '${ws}'.` }); return null
  }
  return ws
}

function requireEnabled(_req: AuthRequest, res: Response, next: NextFunction): void {
  if (!ingestEnabled()) {
    res.status(404).json({ error: 'The knowledge base is switched off on this install.', pack_enabled: false })
    return
  }
  next()
}

/** Send a thrown error as plain JSON: missing import → 404, anything else → `status`. */
function fail(res: Response, err: unknown, status = 400): void {
  const e = err as Error
  res.status(e instanceof ImportNotFoundError ? 404 : status).json({ error: e?.message || 'Something went wrong.' })
}

router.use(requireEnabled)

// ── Browsing ─────────────────────────────────────────────────────────────────

router.get('/pages', (req: AuthRequest, res) => {
  const ws = resolveWorkspace(req, res); if (!ws) return
  const kb = workspaceKbRoot(ws)
  const pages = scanWiki(kb).map(p => ({ rel: p.rel, title: p.title, kind: p.kind, summary: p.summary, updated: p.updated }))
  const counts: Record<string, number> = {}
  for (const p of pages) counts[p.kind] = (counts[p.kind] ?? 0) + 1
  res.json({ pages, counts, index: generatedPagePath(kb, INDEX_PAGE), log: generatedPagePath(kb, LOG_PAGE) })
})

router.get('/page', (req: AuthRequest, res) => {
  const ws = resolveWorkspace(req, res); if (!ws) return
  const rel = typeof req.query.path === 'string' ? req.query.path : ''
  if (!rel || rel.includes('\0') || path.isAbsolute(rel) || isProtectedPath(rel) || !rel.toLowerCase().endsWith('.md')) {
    res.status(404).json({ error: 'That page was not found.' }); return
  }
  try {
    res.json(readPage(workspaceKbRoot(ws), rel))
  } catch {
    res.status(404).json({ error: 'That page was not found.' })
  }
})

// ── Link graph (obj 720162) ──────────────────────────────────────────────────

/** The workspace whose knowledge base lives at `kbRoot`, if any. */
export function workspaceForKbRoot(kbRoot: string): string | null {
  const want = path.resolve(kbRoot)
  for (const ws of getWorkspaceSlugs({ includeArchived: true })) {
    try { if (workspaceKbRoot(ws) === want) return ws } catch { /* bad slug */ }
  }
  return null
}

// The graph tables follow the files: every compile refreshes that workspace's rows.
onWikiCompiled(kb => {
  const ws = workspaceForKbRoot(kb)
  if (ws) syncGraph(getDb(), ws, kb)
})

function intArg(v: unknown, dflt: number, min: number, max: number): number {
  const n = Number(v)
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.floor(n))) : dflt
}

router.get('/graph/related', (req: AuthRequest, res) => {
  const ws = resolveWorkspace(req, res); if (!ws) return
  const page = typeof req.query.page === 'string' ? req.query.page.trim() : ''
  if (!page) { res.status(400).json({ error: 'Say which page (page is required: a path like people/dana-ruiz.md, or a name).' }); return }
  try {
    const db = getDb()
    syncGraph(db, ws, workspaceKbRoot(ws))
    const r = kbRelated(db, ws, page, { depth: intArg(req.query.depth, 1, 1, MAX_RELATED_DEPTH), limit: intArg(req.query.limit, 50, 1, 200) })
    if (!r) { res.status(404).json({ error: `No page called "${page}" in this knowledge base.` }); return }
    res.json(r)
  } catch (err) { fail(res, err, 500) }
})

router.get('/graph/who-knows', (req: AuthRequest, res) => {
  const ws = resolveWorkspace(req, res); if (!ws) return
  const topic = typeof req.query.topic === 'string' ? req.query.topic.trim() : ''
  if (!topic) { res.status(400).json({ error: 'Say which topic (topic is required).' }); return }
  try {
    const db = getDb()
    syncGraph(db, ws, workspaceKbRoot(ws))
    res.json(kbWhoKnows(db, ws, topic.slice(0, 200), { limit: intArg(req.query.limit, 10, 1, 50) }))
  } catch (err) { fail(res, err, 500) }
})

// ── Filing answers ───────────────────────────────────────────────────────────

interface AnswerBody { question?: unknown; answer?: unknown; sources?: unknown }

/** Validate an answer body. Returns the error sentence, or the clean input. */
function answerInput(body: AnswerBody): string | { question: string; answer: string; sources: string[] } {
  const question = typeof body.question === 'string' ? body.question.trim() : ''
  const answer = typeof body.answer === 'string' ? body.answer : ''
  if (!question) return 'Include the question the answer is for.'
  if (question.length > 2000) return 'Keep the question under 2,000 characters.'
  if (!answer.trim()) return 'The answer is empty.'
  if (answer.length > 200_000) return 'That answer is too long to save.'
  if (body.sources !== undefined && !Array.isArray(body.sources)) return 'sources must be a list of page paths.'
  const sources = ((body.sources as unknown[] | undefined) ?? []).filter((s): s is string => typeof s === 'string').slice(0, 200)
  return { question, answer, sources }
}

router.post('/answers', (req: AuthRequest, res) => {
  const ws = resolveWorkspace(req, res); if (!ws) return
  const input = answerInput(req.body ?? {})
  if (typeof input === 'string') { res.status(400).json({ error: input }); return }
  try {
    const filedBy = req.agentKey ? `${req.user!.username} (agent: ${req.agentKey.label})` : req.user!.username
    res.status(201).json(fileAnswer(workspaceKbRoot(ws), { ...input, filedBy }))
  } catch (err) { fail(res, err) }
})

// ── Imports ──────────────────────────────────────────────────────────────────

function cleanupUploads(files: Express.Multer.File[]): void {
  for (const f of files) { try { fs.unlinkSync(f.path) } catch { /* already gone */ } }
}

router.post('/imports', (req: AuthRequest, res, next) => {
  upload.array('files', MAX_IMPORT_FILES)(req, res, err => {
    if (err) {
      cleanupUploads((req.files as Express.Multer.File[] | undefined) ?? [])
      const msg = err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE'
        ? `A file is over the ${MAX_IMPORT_BYTES / 1024 / 1024} MB limit.`
        : err instanceof multer.MulterError && err.code === 'LIMIT_FILE_COUNT'
          ? `Upload at most ${MAX_IMPORT_FILES} files at a time.`
          : (err as Error).message
      res.status(400).json({ error: msg }); return
    }
    next()
  })
}, (req: AuthRequest, res) => {
  const files = (req.files as Express.Multer.File[] | undefined) ?? []
  try {
    const ws = resolveWorkspace(req, res); if (!ws) return
    if (!files.length) { res.status(400).json({ error: 'No files arrived. Send them in the form field "files".' }); return }
    if (files.reduce((n, f) => n + f.size, 0) > MAX_IMPORT_TOTAL_BYTES) {
      res.status(413).json({ error: `Those files add up to more than ${MAX_IMPORT_TOTAL_BYTES / 1024 / 1024 / 1024} GB. Upload them in smaller groups.` }); return
    }
    const jobs = createImport(workspaceKbRoot(ws), files.map(f => ({
      // multer hands back latin1-decoded names; restore UTF-8.
      name: Buffer.from(f.originalname, 'latin1').toString('utf8'),
      path: f.path,
    })), { by: req.user!.username })
    res.status(201).json({ jobs: jobs.map(summary) })
  } catch (err) {
    fail(res, err)
  } finally {
    cleanupUploads(files)
  }
})

router.post('/imports/samples', (req: AuthRequest, res) => {
  const ws = resolveWorkspace(req, res); if (!ws) return
  const files = sampleImportFiles()
  if (!files.length) { res.status(404).json({ error: 'This install has no sample chats or calls.' }); return }
  try {
    res.status(201).json({ jobs: createImport(workspaceKbRoot(ws), files, { by: req.user!.username }).map(summary) })
  } catch (err) { fail(res, err) }
})

function summary(job: ImportJob): ImportJobSummary {
  const { items: _items, ...rest } = job
  return rest
}

router.get('/imports', (req: AuthRequest, res) => {
  const ws = resolveWorkspace(req, res); if (!ws) return
  const kb = workspaceKbRoot(ws)
  res.json({ imports: listImports(kb), working: isImporting(kb) })
})

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined
}

/** Read an item filter from a query string or a JSON body. Returns the error sentence on bad input. */
function parseFilter(src: Record<string, unknown>): ItemFilter | string {
  const f: ItemFilter = {}
  const q = str(src.q); if (q) f.q = q
  for (const k of ['from', 'to'] as const) {
    const v = str(src[k])
    if (v === undefined) continue
    if (!/^\d{4}-\d{2}-\d{2}/.test(v)) return `${k} must be a date like 2026-09-14.`
    f[k] = v
  }
  const status = str(src.status)
  if (status) {
    if (!ITEM_STATUSES.includes(status as ImportItemStatus)) return `status must be one of: ${ITEM_STATUSES.join(', ')}.`
    f.status = status as ImportItemStatus
  }
  if (src.min_messages !== undefined && src.min_messages !== '') {
    const n = Number(src.min_messages)
    if (!Number.isInteger(n) || n < 0) return 'min_messages must be a whole number.'
    f.min_messages = n
  }
  return f
}

router.get('/imports/:id/items', (req: AuthRequest, res) => {
  const ws = resolveWorkspace(req, res); if (!ws) return
  const f = parseFilter(req.query as Record<string, unknown>)
  if (typeof f === 'string') { res.status(400).json({ error: f }); return }
  const offset = req.query.offset !== undefined ? Number(req.query.offset) : undefined
  const limit = req.query.limit !== undefined ? Number(req.query.limit) : undefined
  if ((offset !== undefined && !Number.isFinite(offset)) || (limit !== undefined && !Number.isFinite(limit))) {
    res.status(400).json({ error: 'offset and limit must be numbers.' }); return
  }
  try {
    res.json(listItems(workspaceKbRoot(ws), String(req.params.id), { ...f, offset, limit }))
  } catch (err) { fail(res, err) }
})

router.post('/imports/:id/select', (req: AuthRequest, res) => {
  const ws = resolveWorkspace(req, res); if (!ws) return
  const b = req.body ?? {}
  if (typeof b.selected !== 'boolean') { res.status(400).json({ error: 'Say whether to tick or untick (selected: true or false).' }); return }
  let sel: { keys?: string[]; all_matching?: ItemFilter; selected: boolean }
  if (Array.isArray(b.keys)) {
    sel = { keys: b.keys.filter((k: unknown): k is string => typeof k === 'string'), selected: b.selected }
  } else if (b.all_matching && typeof b.all_matching === 'object') {
    const f = parseFilter(b.all_matching as Record<string, unknown>)
    if (typeof f === 'string') { res.status(400).json({ error: f }); return }
    sel = { all_matching: f, selected: b.selected }
  } else {
    res.status(400).json({ error: 'Send either keys (a list of chats) or all_matching (a filter).' }); return
  }
  try {
    res.json(selectItems(workspaceKbRoot(ws), String(req.params.id), sel))
  } catch (err) { fail(res, err) }
})

const CONTROL = {
  start: (kb: string, id: string) => startImport(kb, id),
  pause: pauseImport,
  cancel: cancelImport,
} as const

for (const [action, run] of Object.entries(CONTROL)) {
  router.post(`/imports/:id/${action}`, (req: AuthRequest, res) => {
    const ws = resolveWorkspace(req, res); if (!ws) return
    try {
      res.json({ job: run(workspaceKbRoot(ws), String(req.params.id)) })
    } catch (err) { fail(res, err, 409) }
  })
}

// ── Cleanup (lint) ───────────────────────────────────────────────────────────

function readLastReport(kb: string): LintReport | null {
  try { return JSON.parse(fs.readFileSync(path.join(kb, LINT_LAST), 'utf8')) as LintReport } catch { return null }
}

/** When the scheduler will next run the cleanup (ISO), or null when switched off. */
export function nextLintRun(lastRunIso: string | null, s: Pick<WikiSettings, 'lint_schedule' | 'lint_hour_utc'>, now: Date): string | null {
  if (s.lint_schedule === 'off') return null
  const last = lastRunIso ? Date.parse(lastRunIso) : NaN
  if (s.lint_schedule === 'weekly') {
    return new Date(Number.isFinite(last) ? Math.max(last + 7 * 86_400_000, now.getTime()) : now.getTime()).toISOString()
  }
  let slot = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), s.lint_hour_utc)
  // Today's slot already used (or passed with a run after it) → tomorrow's.
  if (Number.isFinite(last) && last >= slot) slot += 86_400_000
  return new Date(Math.max(slot, now.getTime())).toISOString()
}

router.get('/lint', (req: AuthRequest, res) => {
  const ws = resolveWorkspace(req, res); if (!ws) return
  const report = readLastReport(workspaceKbRoot(ws))
  const settings = getWikiSettings()
  res.json({ report, settings, next_run: nextLintRun(report?.ran_at ?? null, settings, new Date()) })
})

const lintRunning = new Set<string>()

router.post('/lint/run', async (req: AuthRequest, res) => {
  const ws = resolveWorkspace(req, res); if (!ws) return
  if (lintRunning.has(ws)) { res.status(409).json({ error: 'A cleanup is already running for this workspace.' }); return }
  lintRunning.add(ws)
  try {
    res.json({ report: await runLintForWorkspace(ws) })
  } catch (err) {
    fail(res, err, 500)
  } finally {
    lintRunning.delete(ws)
  }
})

router.put('/lint/settings', requireAdmin, (req: AuthRequest, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>
  const patch: Partial<WikiSettings> = {}
  for (const k of ['lint_schedule', 'lint_hour_utc', 'lint_stale_days', 'lint_ai_pages'] as const) {
    if (b[k] !== undefined) (patch as Record<string, unknown>)[k] = b[k]
  }
  try {
    res.json({ settings: saveWikiSettings(patch) })
  } catch (err) { fail(res, err) }
})

// ── Rebuild ──────────────────────────────────────────────────────────────────

router.post('/rebuild', requireAdmin, (req: AuthRequest, res) => {
  const ws = resolveWorkspace(req, res); if (!ws) return
  if (req.body?.confirm !== true) {
    res.status(400).json({ error: 'Rebuilding re-reads every file. Send confirm: true to go ahead.' }); return
  }
  try {
    const kb = workspaceKbRoot(ws)
    const result = rebuildWiki(kb)
    startDrain(ws)
    resumeImports(kb)
    res.json(result)
  } catch (err) { fail(res, err, 500) }
})

export default router

// ── Internal: board-card sessions file answers with curl ─────────────────────

export const internalKbWikiRouter = Router()

internalKbWikiRouter.use((req, res, next) => {
  if (!isLocalhost(req)) { res.status(403).json({ error: 'Internal API: localhost only' }); return }
  next()
})

internalKbWikiRouter.post('/answers', (req, res) => {
  const ws = typeof req.body?.workspace === 'string' ? req.body.workspace.trim() : ''
  if (!ws || !getWorkspace(ws)) { res.status(404).json({ error: `There is no workspace called '${ws}'.` }); return }
  if (!ingestEnabled()) { res.status(404).json({ error: 'The knowledge base is switched off on this install.' }); return }
  const input = answerInput(req.body ?? {})
  if (typeof input === 'string') { res.status(400).json({ error: input }); return }
  const filedBy = typeof req.body?.filed_by === 'string' && req.body.filed_by.trim() ? req.body.filed_by.trim().slice(0, 200) : 'board session'
  try {
    res.status(201).json(fileAnswer(workspaceKbRoot(ws), { ...input, filedBy }))
  } catch (err) { fail(res, err) }
})

// ── Boot ─────────────────────────────────────────────────────────────────────

/**
 * On server start (next to the document-queue resume): pick up any import a
 * restart interrupted, per workspace that has one, and start the cleanup
 * scheduler. Imports only resume while the knowledge base is switched on.
 */
export function resumeKbWiki(workspaces: string[]): void {
  startWikiLintScheduler()
  if (!ingestEnabled()) return
  for (const ws of workspaces) {
    try {
      const kb = workspaceKbRoot(ws)
      if (!fs.existsSync(path.join(kb, IMPORTS_STATE_DIR))) continue
      const n = resumeImports(kb)
      if (n) console.log(`[kb-wiki] ${ws}: resuming ${n} import(s)`)
    } catch (err) {
      console.warn(`[kb-wiki] resume ${ws}: ${(err as Error).message}`)
    }
  }
}
