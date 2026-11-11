/**
 * Branding (obj 719935) — the product name and optional logo a client install
 * shows on the sign-in page, the forced password-change page and the tab title.
 *
 * Unauthenticated on purpose: the sign-in page renders it before anyone is
 * signed in, and it holds nothing secret. On a client install the whole site
 * already sits behind Cloudflare Access. Configured by install.sh:
 *   OK_BRAND_NAME   display name (default OperationKit)
 *   <data dir>/branding/logo.png|logo.svg   optional logo (copied in by install.sh)
 */
import { Router } from 'express'
import fs from 'fs'
import path from 'path'

const DEFAULT_BRAND_NAME = 'OperationKit'
const LOGO_TYPES: Array<[string, string]> = [['logo.svg', 'image/svg+xml'], ['logo.png', 'image/png']]

export function brandingDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(path.dirname(env.DB_PATH || '/app/data/command-center.db'), 'branding')
}

export function brandName(env: NodeJS.ProcessEnv = process.env): string {
  const name = (env.OK_BRAND_NAME || '').trim().slice(0, 60)
  return name || DEFAULT_BRAND_NAME
}

export function findLogo(dir: string = brandingDir()): { file: string; type: string } | null {
  for (const [name, type] of LOGO_TYPES) {
    const file = path.join(dir, name)
    if (fs.existsSync(file)) return { file, type }
  }
  return null
}

const router = Router()

router.get('/', (_req, res) => {
  res.setHeader('Cache-Control', 'no-cache')
  res.json({ name: brandName(), logo_url: findLogo() ? '/api/branding/logo' : null })
})

router.get('/logo', (_req, res) => {
  const logo = findLogo()
  if (!logo) {
    res.status(404).json({ error: 'No logo configured' })
    return
  }
  res.setHeader('Content-Type', logo.type)
  // An uploaded SVG must never run script in our origin.
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox")
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Cache-Control', 'public, max-age=300')
  fs.createReadStream(logo.file).pipe(res)
})

export default router
