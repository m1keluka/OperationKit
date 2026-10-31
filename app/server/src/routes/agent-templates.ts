/**
 * Agent templates API (obj 719986).
 *
 *   /api/agent-templates            — admin (cookie / bearer), drives the Templates page
 *   /api/internal/agent-templates   — localhost + X-Internal-Secret, drives
 *                                     scripts/agent-template.sh and the installer
 *
 * Both surfaces call the same service functions (services/agent-templates.ts),
 * so the UI path and the script path cannot drift.
 */
import { Router, type Request, type Response } from 'express'
import { requireAuth, requireAdmin } from '../middleware/auth.js'
import { isLocalhost } from '../lib/is-localhost.js'
import { requireInternalSecret } from '../middleware/internal-secret.js'
import { parseAgentFile } from '../services/agent-file.js'
import {
  AgentInstallError,
  exportAgent,
  importAgentFromPath,
  importRoots,
  installAgentFromText,
  installTemplate,
  listInstalledAgents,
  listTemplates,
  type InstallOptions,
} from '../services/agent-templates.js'

function sendError(res: Response, err: unknown): void {
  if (err instanceof AgentInstallError) {
    res.status(err.status).json({ error: err.message, errors: err.errors, warnings: err.warnings })
    return
  }
  console.error('[agent-templates]', err)
  res.status(500).json({ error: (err as Error).message })
}

function installOpts(body: Record<string, unknown>): InstallOptions {
  return {
    overwrite: body.overwrite === true,
    workspace: typeof body.workspace === 'string' ? body.workspace : null,
  }
}

function gallery(_req: Request, res: Response): void {
  try {
    const { templates, problems } = listTemplates()
    res.json({ templates, installed: listInstalledAgents(), problems, import_roots: importRoots() })
  } catch (err) {
    sendError(res, err)
  }
}

function validate(req: Request, res: Response): void {
  const body = (req.body || {}) as Record<string, unknown>
  if (typeof body.content !== 'string') {
    res.status(400).json({ error: 'content (the file text) is required' })
    return
  }
  res.json(parseAgentFile(body.content, { filename: typeof body.filename === 'string' ? body.filename : undefined }))
}

function importOne(req: Request, res: Response): void {
  const body = (req.body || {}) as Record<string, unknown>
  try {
    if (typeof body.content === 'string') {
      const filename = typeof body.filename === 'string' ? body.filename : undefined
      res.status(201).json(installAgentFromText(body.content, filename, { ...installOpts(body), origin: 'import' }))
      return
    }
    if (typeof body.path === 'string') {
      res.status(201).json(importAgentFromPath(body.path, { ...installOpts(body), origin: 'import' }))
      return
    }
    res.status(400).json({ error: 'send either content (file text) or path (a file on the server)' })
  } catch (err) {
    sendError(res, err)
  }
}

function installOne(req: Request, res: Response): void {
  try {
    res.status(201).json(installTemplate(String(req.params.slug), installOpts((req.body || {}) as Record<string, unknown>)))
  } catch (err) {
    sendError(res, err)
  }
}

function exportOne(req: Request, res: Response): void {
  try {
    const out = exportAgent(String(req.params.slug))
    if (req.query.format === 'json') {
      res.json(out)
      return
    }
    res.setHeader('Content-Type', 'application/yaml; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="${out.filename}"`)
    res.send(out.content)
  } catch (err) {
    sendError(res, err)
  }
}

// ── Admin (UI) ──────────────────────────────────────────────────────────────

export const agentTemplatesRouter = Router()
agentTemplatesRouter.use(requireAuth, requireAdmin)
agentTemplatesRouter.get('/', gallery)
agentTemplatesRouter.post('/validate', validate)
agentTemplatesRouter.post('/import', importOne)
agentTemplatesRouter.post('/templates/:slug/install', installOne)
agentTemplatesRouter.get('/agents/:slug/export', exportOne)

// ── Internal (script / installer) ───────────────────────────────────────────

export const internalAgentTemplatesRouter = Router()
internalAgentTemplatesRouter.use((req, res, next) => {
  if (!isLocalhost(req)) {
    res.status(403).json({ error: 'localhost only' })
    return
  }
  // Reads are harmless but exports carry full agent instructions; require the
  // shared secret on every route, like internal-routines.
  if (!requireInternalSecret(req, res)) return
  next()
})
internalAgentTemplatesRouter.get('/', gallery)
internalAgentTemplatesRouter.post('/validate', validate)
internalAgentTemplatesRouter.post('/import', importOne)
internalAgentTemplatesRouter.post('/templates/:slug/install', installOne)
internalAgentTemplatesRouter.get('/agents/:slug/export', exportOne)

/** Installer switch: `{ "templates": "all" }` or `{ "templates": ["operator"] }`.
 *  Skips any slug that is already installed unless `overwrite` is true. */
internalAgentTemplatesRouter.post('/install-starters', (req, res) => {
  const body = (req.body || {}) as Record<string, unknown>
  const { templates } = listTemplates()
  const wanted = body.templates === 'all' || body.templates === undefined
    ? templates.filter(t => t.source === 'starter').map(t => t.slug)
    : Array.isArray(body.templates) ? body.templates.map(String) : []
  const results: Array<{ slug: string; status: string; error?: string }> = []
  for (const slug of wanted) {
    const t = templates.find(x => x.slug === slug)
    if (t?.installed && body.overwrite !== true) {
      results.push({ slug, status: 'already-installed' })
      continue
    }
    try {
      const r = installTemplate(slug, installOpts(body))
      results.push({ slug, status: r.action })
    } catch (err) {
      results.push({ slug, status: 'failed', error: (err as Error).message })
    }
  }
  res.status(results.some(r => r.status === 'failed') ? 207 : 200).json({ results })
})
