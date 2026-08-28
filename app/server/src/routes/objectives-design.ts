/**
 * Design-review frame — proxies a preview URL through Command Center so the
 * canvas iframe can host an injected click/text overlay (Claude Design-style).
 */
import type { Router } from 'express'
import { getDb } from '../db/index.js'
import { type AuthRequest } from '../middleware/auth.js'
import type { Objective } from '@command-center/shared'
import { canReadObjective } from './objectives-helpers.js'
import { DESIGN_FRAME_CSP } from '../middleware/security-headers.js'
import {
  parsePreviewUrl,
  rewriteDesignHtml,
  frameErrorPage,
} from '../lib/design-frame.js'

const FETCH_MS = 12_000
const MAX_BYTES = 1_500_000

function resolveParentOrigin(req: AuthRequest): string {
  const host = String(req.get('x-forwarded-host') || req.get('host') || '').split(',')[0].trim()
  const proto = String(req.get('x-forwarded-proto') || req.protocol || 'https').split(',')[0].trim()
  const inferred = `${proto}://${host}`
  const raw = String(req.query.parent || '')
  try {
    const origin = new URL(raw).origin
    if (origin === inferred || origin === `https://${host}` || origin === `http://${host}`) return origin
  } catch { /* ignore */ }
  return inferred
}

export function registerObjectiveDesignRoutes(router: Router): void {
  router.get('/:id/design-frame', async (req: AuthRequest, res) => {
    const db = getDb()
    const objective = db.prepare('SELECT * FROM objectives WHERE id = ?').get(req.params.id) as Objective | undefined
    if (!objective) {
      res.status(404).type('html').send(frameErrorPage('Objective not found'))
      return
    }
    if (!canReadObjective(req, objective)) {
      res.status(403).type('html').send(frameErrorPage('You do not have access to this objective'))
      return
    }

    const raw = String(req.query.url || '')
    const parsed = parsePreviewUrl(raw)
    if (!parsed) {
      res.status(400).type('html').send(frameErrorPage('Paste an http(s) preview URL. Private/local hosts are blocked.'))
      return
    }

    const parentOrigin = resolveParentOrigin(req)
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), FETCH_MS)
    try {
      const upstream = await fetch(parsed.href, {
        redirect: 'follow',
        signal: ctrl.signal,
        headers: {
          Accept: 'text/html,application/xhtml+xml',
          'User-Agent': 'CommandCenter-DesignFrame/1',
        },
      })
      const buf = Buffer.from(await upstream.arrayBuffer())
      if (buf.length > MAX_BYTES) {
        res.status(413).type('html').send(frameErrorPage('Preview is larger than 1.5MB — open it in a new tab instead.'))
        return
      }
      const ctype = upstream.headers.get('content-type') || ''
      if (!upstream.ok) {
        res.status(502).type('html').send(frameErrorPage(`Preview returned ${upstream.status}`))
        return
      }
      if (ctype && !/html|xml|text\/plain/i.test(ctype)) {
        res.status(415).type('html').send(frameErrorPage(`Preview is ${ctype}, not HTML.`))
        return
      }
      const html = buf.toString('utf8')
      const rewritten = rewriteDesignHtml(html, { sourceUrl: parsed.href, parentOrigin })
      res.status(200)
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.setHeader('Cache-Control', 'no-store')
      res.removeHeader('X-Frame-Options')
      res.setHeader('Content-Security-Policy', DESIGN_FRAME_CSP)
      res.send(rewritten)
    } catch (err) {
      const aborted = err instanceof Error && err.name === 'AbortError'
      res.status(502).type('html').send(frameErrorPage(aborted ? 'Preview timed out.' : 'Could not fetch that preview.'))
    } finally {
      clearTimeout(timer)
    }
  })
}
