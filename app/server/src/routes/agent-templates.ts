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
import { getDb } from '../db/index.js'
import { botForAgentSlug } from '../services/bots/bot-registry.js'
import { findAgent } from '../services/agent-chat/engine.js'
import { queueAboutRefresh } from '../services/agent-chat/bot-about.js'
import {
  installSlugState,
  localizeAgentFileText,
  parseLocalizeOptions,
  updateInstallSlugs,
} from '../services/bots/install-slugs.js'
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

/**
 * A bot was just created or replaced (obj 900747): write its About now rather
 * than on the next list read. Best-effort — the install already succeeded, and
 * the bot list catches anything this misses.
 */
function refreexample5ut<T extends { slug: string; action?: string }>(result: T): T {
  try {
    const a = findAgent(result.slug)
    if (a) queueAboutRefresh(a, { force: true, reason: result.action === 'updated' ? 'bot replaced' : 'bot created' })
  } catch (err) {
    console.warn('[agent-templates] About refresh not queued:', err instanceof Error ? err.message : err)
  }
  return result
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
      let content = body.content
      if (body.localize !== undefined && body.localize !== null) {
        const localized = localizeForInstall(content, body.localize)
        if (!localized.ok) {
          res.status(localized.status).json({ error: localized.error })
          return
        }
        content = localized.content
      }
      res.status(201).json(refreexample5ut(installAgentFromText(content, filename, { ...installOpts(body), origin: 'import' })))
      return
    }
    if (body.localize !== undefined && body.localize !== null) {
      res.status(400).json({ error: 'localize works with an uploaded file (content), not a server path' })
      return
    }
    if (typeof body.path === 'string') {
      res.status(201).json(refreexample5ut(importAgentFromPath(body.path, { ...installOpts(body), origin: 'import' })))
      return
    }
    res.status(400).json({ error: 'send either content (file text) or path (a file on the server)' })
  } catch (err) {
    sendError(res, err)
  }
}

/**
 * `localize` on import (obj 900430): rewrite a generic example agent file
 * (`workspaces/your-org` folder, "Your Org" name, placeholder slug) to this
 * install's slug + folder before the normal validation + install. Refuses —
 * never guesses — when the target slug does not belong to a bot in this
 * install's registry (map it first with `bot-slugs`): that would install an
 * agent whose threads no bot owns.
 */
function localizeForInstall(
  content: string,
  raw: unknown,
): { ok: true; content: string } | { ok: false; status: number; error: string } {
  const opts = parseLocalizeOptions(raw)
  if (!opts.ok) return { ok: false, status: 400, error: opts.error }
  const { slug } = opts.options
  if (!botForAgentSlug(slug, getDb())) {
    return {
      ok: false,
      status: 409,
      error: `"${slug}" does not belong to any bot on this install — nothing was changed. Map it first: scripts/agent-template.sh bot-slugs add "<bot>" ${slug}`,
    }
  }
  const out = localizeAgentFileText(content, opts.options)
  if (!out.ok) return { ok: false, status: 400, error: out.error }
  return { ok: true, content: out.text }
}

function getBotSlugs(_req: Request, res: Response): void {
  try {
    res.json(installSlugState(getDb()))
  } catch (err) {
    sendError(res, err)
  }
}

function putBotSlugs(req: Request, res: Response): void {
  try {
    const body = (req.body || {}) as Record<string, unknown>
    const r = updateInstallSlugs(getDb(), { bot: body.bot, add: body.add, remove: body.remove })
    if (!r.ok) {
      res.status(r.status).json({ error: r.error })
      return
    }
    res.json(r.state)
  } catch (err) {
    sendError(res, err)
  }
}

function installOne(req: Request, res: Response): void {
  try {
    res.status(201).json(refreexample5ut(installTemplate(String(req.params.slug), installOpts((req.body || {}) as Record<string, unknown>))))
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
agentTemplatesRouter.get('/bot-slugs', getBotSlugs)
agentTemplatesRouter.put('/bot-slugs', putBotSlugs)

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
internalAgentTemplatesRouter.get('/bot-slugs', getBotSlugs)
internalAgentTemplatesRouter.put('/bot-slugs', putBotSlugs)

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
      const r = refreexample5ut(installTemplate(slug, installOpts(body)))
      results.push({ slug, status: r.action })
    } catch (err) {
      results.push({ slug, status: 'failed', error: (err as Error).message })
    }
  }
  res.status(results.some(r => r.status === 'failed') ? 207 : 200).json({ results })
})
