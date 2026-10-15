/**
 * /api/files — read-only, workspace-scoped search + stat + download for
 * non-markdown files on the VPS (pptx, pdf, key, images, spreadsheets…).
 * obj 715485. Same Bearer key / cookie auth as the rest of the Agent API.
 *
 * Policy (roots, denylist, workspace scope) lives in services/file-access.ts.
 * This router only parses params, rate-limits, streams, and audits.
 * There are deliberately NO write / move / delete / exec routes here.
 */
import { Router, type Response } from 'express'
import fs from 'fs'
import path from 'path'
import { createHash } from 'crypto'
import { requireAuth, type AuthRequest } from '../middleware/auth.js'
import { getUserWorkspaces, userHasWorkspace } from '../middleware/workspace.js'
import { getDb } from '../db/index.js'
import { isApiKey } from '../lib/api-keys.js'
import {
  buildScope,
  getMaxDownloadBytes,
  inScope,
  mimeFor,
  rateLimit,
  resolveFile,
  searchFiles,
  TYPE_GROUPS,
  type ResolveError,
  type Scope,
} from '../services/file-access.js'

const router = Router()
router.use(requireAuth)

const SEARCH_RATE = () => Number(process.env.CC_FILES_RATE_PER_MIN) || 60
const DOWNLOAD_RATE = () => Number(process.env.CC_FILES_DOWNLOAD_RATE_PER_MIN) || 20

function limited(req: AuthRequest, res: Response, bucket: string, limit: number): boolean {
  const retry = rateLimit(`${bucket}:${req.user!.id}`, limit)
  if (retry === null) return false
  res.setHeader('Retry-After', String(retry))
  res.status(429).json({ error: 'Rate limit exceeded', retry_after: retry })
  return true
}

/** Resolve the caller's scope, honouring ?workspace=. Sends 403 and returns null on a bad workspace. */
function scopeFor(req: AuthRequest, res: Response): Scope | null {
  const isAdmin = req.user!.role === 'admin'
  const raw = typeof req.query.workspace === 'string' ? req.query.workspace.trim() : ''
  const only = raw && raw !== 'all' ? raw : undefined
  if (only && !isAdmin && !userHasWorkspace(req.user!.id, only)) {
    res.status(403).json({ error: `No access to workspace '${only}'` })
    return null
  }
  const memberships = isAdmin ? [] : getUserWorkspaces(req.user!.id).map(w => w.workspace)
  return buildScope(isAdmin, memberships, only)
}

const ERROR_STATUS: Record<ResolveError, number> = {
  bad_path: 400,
  not_found: 404,
  forbidden: 403,
  denied: 403,
  not_file: 400,
}
const ERROR_TEXT: Record<ResolveError, string> = {
  bad_path: 'path must be an absolute path',
  not_found: 'File not found',
  forbidden: 'Path not allowed',
  denied: 'Path not allowed',
  not_file: 'Not a regular file',
}

function parseDate(v: unknown): number | undefined | 'bad' {
  if (typeof v !== 'string' || !v) return undefined
  const t = Date.parse(v)
  return Number.isFinite(t) ? t : 'bad'
}

// GET /api/files/search?q=&glob=&ext=&type=&path_prefix=&modified_after=&modified_before=&workspace=&limit=&offset=
router.get('/search', (req: AuthRequest, res) => {
  if (limited(req, res, 'files-search', SEARCH_RATE())) return
  const scope = scopeFor(req, res)
  if (!scope) return

  const exts = new Set<string>()
  for (const key of ['ext', 'type'] as const) {
    const v = req.query[key]
    if (typeof v !== 'string' || !v) continue
    for (const part of v.split(',').map(s => s.trim().toLowerCase().replace(/^\./, '')).filter(Boolean)) {
      for (const e of TYPE_GROUPS[part] ?? [part]) exts.add(e)
    }
  }
  const after = parseDate(req.query.modified_after)
  const before = parseDate(req.query.modified_before)
  if (after === 'bad' || before === 'bad') {
    res.status(400).json({ error: 'modified_after / modified_before must be ISO-8601 dates' })
    return
  }
  const pathPrefix = typeof req.query.path_prefix === 'string' && req.query.path_prefix ? req.query.path_prefix : undefined
  if (pathPrefix && (!path.isAbsolute(pathPrefix) || pathPrefix.includes('\0'))) {
    res.status(400).json({ error: 'path_prefix must be an absolute path' })
    return
  }
  if (pathPrefix && !inScope(pathPrefix, scope) && !scope.entries.some(e => e.prefix.startsWith(path.resolve(pathPrefix) + path.sep))) {
    res.status(403).json({ error: 'path_prefix not allowed' })
    return
  }
  const rawLimit = parseInt(String(req.query.limit ?? ''), 10)
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 200) : 50
  const rawOffset = parseInt(String(req.query.offset ?? ''), 10)
  const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? rawOffset : 0

  const { hits, truncated } = searchFiles(scope, {
    q: typeof req.query.q === 'string' && req.query.q.trim() ? req.query.q.trim() : undefined,
    glob: typeof req.query.glob === 'string' && req.query.glob ? req.query.glob : undefined,
    exts: exts.size ? exts : undefined,
    pathPrefix,
    modifiedAfter: after,
    modifiedBefore: before,
  })
  const page = hits.slice(offset, offset + limit)
  res.json({
    results: page,
    total: hits.length,
    limit,
    offset,
    next_offset: offset + limit < hits.length ? offset + limit : null,
    truncated,
  })
})

// GET /api/files/stat?path=&sha256=1
router.get('/stat', async (req: AuthRequest, res) => {
  if (limited(req, res, 'files-search', SEARCH_RATE())) return
  const scope = scopeFor(req, res)
  if (!scope) return
  const r = resolveFile(req.query.path, scope)
  if ('error' in r) {
    res.status(ERROR_STATUS[r.error]).json({ error: ERROR_TEXT[r.error] })
    return
  }
  const body: Record<string, unknown> = {
    path: r.path,
    name: path.basename(r.path),
    size: r.stat.size,
    mime: mimeFor(r.path),
    mtime: r.stat.mtime.toISOString(),
    ctime: r.stat.ctime.toISOString(),
    created: r.stat.birthtimeMs > 0 ? r.stat.birthtime.toISOString() : null,
    workspace: r.workspace,
    root: r.rootId,
    downloadable: r.stat.size <= getMaxDownloadBytes(),
  }
  const wantHash = ['1', 'true', 'yes'].includes(String(req.query.sha256 ?? '').toLowerCase())
  if (wantHash) {
    if (r.stat.size > getMaxDownloadBytes()) {
      body.sha256 = null
    } else {
      body.sha256 = await new Promise<string>((resolve, reject) => {
        const h = createHash('sha256')
        fs.createReadStream(r.path).on('data', c => h.update(c)).on('end', () => resolve(h.digest('hex'))).on('error', reject)
      }).catch(() => null)
    }
  }
  res.json(body)
})

function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`
}

function auditDownload(req: AuthRequest, file: { path: string; workspace: string | null; rootId: string }, bytes: number, range: string | null, complete: boolean): void {
  const header = req.headers.authorization
  const bearer = header?.startsWith('Bearer ') ? header.slice(7).trim() : ''
  const viaKey = isApiKey(bearer)
  const metadata = {
    path: file.path,
    root: file.rootId,
    workspace: file.workspace,
    bytes,
    range,
    complete,
    user_id: req.user!.id,
    username: req.user!.username,
    auth: viaKey ? 'api_key' : 'session',
    key_last4: viaKey ? bearer.slice(-4) : null,
  }
  try {
    getDb().prepare(
      `INSERT INTO activity_log (project, workspace, event_type, title, detail, metadata)
       VALUES ('operationkit', ?, 'milestone', 'file_download', ?, ?)`,
    ).run(file.workspace ?? 'shared', `${req.user!.username} downloaded ${file.path} (${bytes} bytes)`, JSON.stringify(metadata))
  } catch (err) {
    console.error('[files] audit insert failed', err)
  }
  console.log(`[files] download user=${req.user!.id} auth=${metadata.auth} key=${metadata.key_last4 ?? '-'} ws=${file.workspace ?? '-'} bytes=${bytes} path=${file.path}`)
}

// GET /api/files/download?path=   (supports a single `Range: bytes=a-b`)
router.get('/download', (req: AuthRequest, res) => {
  if (limited(req, res, 'files-download', DOWNLOAD_RATE())) return
  const scope = scopeFor(req, res)
  if (!scope) return
  const r = resolveFile(req.query.path, scope)
  if ('error' in r) {
    res.status(ERROR_STATUS[r.error]).json({ error: ERROR_TEXT[r.error] })
    return
  }
  const size = r.stat.size
  const cap = getMaxDownloadBytes()
  if (size > cap) {
    res.status(413).json({ error: `File is ${size} bytes; download cap is ${cap} bytes`, size, max_bytes: cap })
    return
  }

  let start = 0
  let end = size - 1
  let partial = false
  const rangeHeader = typeof req.headers.range === 'string' ? req.headers.range : null
  if (rangeHeader) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim())
    if (!m || (m[1] === '' && m[2] === '')) {
      res.setHeader('Content-Range', `bytes */${size}`)
      res.status(416).json({ error: 'Unsupported Range (single bytes=a-b only)' })
      return
    }
    if (m[1] === '') {
      const suffix = Number(m[2])
      start = Math.max(0, size - suffix)
    } else {
      start = Number(m[1])
      end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1)
    }
    if (start > end || start >= size) {
      res.setHeader('Content-Range', `bytes */${size}`)
      res.status(416).json({ error: 'Range not satisfiable' })
      return
    }
    partial = true
  }

  const length = size === 0 ? 0 : end - start + 1
  res.status(partial ? 206 : 200)
  res.setHeader('Content-Type', mimeFor(r.path))
  res.setHeader('Content-Disposition', contentDisposition(path.basename(r.path)))
  res.setHeader('Content-Length', String(length))
  res.setHeader('Accept-Ranges', 'bytes')
  res.setHeader('Last-Modified', r.stat.mtime.toUTCString())
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Cache-Control', 'private, no-store')
  if (partial) res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`)

  let sent = 0
  let audited = false
  const audit = (complete: boolean) => {
    if (audited) return
    audited = true
    auditDownload(req, r, sent, partial ? `${start}-${end}` : null, complete)
  }
  if (length === 0) {
    res.end()
    audit(true)
    return
  }
  const stream = fs.createReadStream(r.path, { start, end })
  stream.on('data', chunk => { sent += chunk.length })
  stream.on('error', () => {
    audit(false)
    res.destroy()
  })
  res.on('finish', () => audit(sent === length))
  res.on('close', () => {
    stream.destroy()
    audit(sent === length && res.writableFinished)
  })
  stream.pipe(res)
})

export default router
