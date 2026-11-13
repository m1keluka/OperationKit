/**
 * Branding (obj 719935, extended obj 900494) — the product name, accent
 * palette and logos a client install shows across the whole UI (sign-in,
 * tab title, topbar, favicon/app icons) and the Settings > Branding panel.
 *
 * GET routes are unauthenticated on purpose: the sign-in page and favicon
 * render before anyone is signed in, and nothing here is secret. On a client
 * install the whole site already sits behind Cloudflare Access.
 *
 * POST/DELETE routes (set name/tokens, upload/reset logos) are admin-only —
 * see docs/branding.md for the env var / config file / panel precedence.
 */
import { Router } from 'express'
import fs from 'fs'
import path from 'path'
import multer from 'multer'
import { requireAuth, requireAdmin, type AuthRequest } from '../middleware/auth.js'
import {
  resolveBrandName,
  resolveBrandTokens,
  envLockedFields,
  explicitTokenFields,
  isCustomized,
  writeBrandingConfig,
  resetBrandingConfig,
  resolvePoweredBy,
  brandingDataDir,
  DEFAULT_BRAND_NAME,
} from '../services/branding-config.js'

const DEFAULT_ASSET_DIR = path.join(import.meta.dirname, '..', '..', '..', 'client', 'src', 'assets', 'brand')

type Slot = 'wordmark' | 'wordmark-dark' | 'icon' | 'favicon'
const SLOT_FILES: Record<Slot, Array<[string, string]>> = {
  wordmark: [['wordmark.svg', 'image/svg+xml'], ['wordmark.png', 'image/png']],
  'wordmark-dark': [['wordmark-dark.svg', 'image/svg+xml'], ['wordmark-dark.png', 'image/png']],
  icon: [['icon.svg', 'image/svg+xml'], ['icon.png', 'image/png']],
  favicon: [['favicon.ico', 'image/x-icon'], ['favicon.svg', 'image/svg+xml'], ['favicon.png', 'image/png']],
}

/** The admin-uploaded file for a slot in the install's data dir, if any. */
export function findCustomAsset(slot: Slot, dataDir: string = brandingDataDir()): { file: string; type: string } | null {
  for (const [name, type] of SLOT_FILES[slot]) {
    const file = path.join(dataDir, name)
    if (fs.existsSync(file)) return { file, type }
  }
  return null
}

/** Looks in the install's data dir (admin upload) first, then — unless
 * `includeDefaults` is false — the shipped default asset dir. */
export function findAsset(
  slot: Slot,
  dataDir: string = brandingDataDir(),
  includeDefaults = true,
): { file: string; type: string } | null {
  const custom = findCustomAsset(slot, dataDir)
  if (custom || !includeDefaults) return custom
  for (const [name, type] of SLOT_FILES[slot]) {
    const file = path.join(DEFAULT_ASSET_DIR, name)
    if (fs.existsSync(file)) return { file, type }
  }
  return null
}

/** White-labeled = the install has its own name OR uploaded any logo/icon.
 * From that point the shipped default marks are never served (obj 900543):
 * a client who renamed the product but uploaded only an icon must not get the
 * default wordmark, favicon or arrow anywhere. */
export function isWhiteLabeled(env: NodeJS.ProcessEnv = process.env, dataDir: string = brandingDataDir(env)): boolean {
  if (resolveBrandName(env) !== DEFAULT_BRAND_NAME) return true
  return (['wordmark', 'wordmark-dark', 'icon', 'favicon'] as Slot[]).some(s => findCustomAsset(s, dataDir))
}

/** The asset the UI should show for a slot, honouring white-label rules.
 * Favicon falls back to the install's own icon before anything else. */
export function resolveAsset(slot: Slot, env: NodeJS.ProcessEnv = process.env, dataDir: string = brandingDataDir(env)) {
  const includeDefaults = !isWhiteLabeled(env, dataDir)
  const hit = findAsset(slot, dataDir, includeDefaults)
  if (hit || slot !== 'favicon') return hit
  return findAsset('icon', dataDir, includeDefaults)
}

function escapeXml(v: string): string {
  return v.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string))
}

/** Generated favicon for a white-labeled install with no icon of its own:
 * the brand's first letter on its accent — never the default mark. */
export function monogramSvg(name: string, accent: string, fg: string): string {
  const letter = escapeXml((name.trim()[0] || '•').toUpperCase())
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="${escapeXml(accent)}"/>`
    + `<text x="16" y="22" text-anchor="middle" font-family="system-ui,sans-serif" font-size="18" font-weight="700" fill="${escapeXml(fg)}">${letter}</text></svg>`
}

/** Injects the install's brand name + favicon into index.html so even the
 * first paint (before JS) shows the client's brand, not the default. */
export function renderBrandedIndex(html: string, env: NodeJS.ProcessEnv = process.env): string {
  const name = escapeXml(resolveBrandName(env))
  return html
    .replace(/<title>[^<]*<\/title>/, `<title>${name}</title>`)
    .replace(/<link rel="icon"[^>]*>/, '<link rel="icon" href="/api/branding/favicon" />')
}

/** Back-compat for obj 719935 callers/tests: the original single-logo API. */
export function brandingDir(env: NodeJS.ProcessEnv = process.env): string {
  return brandingDataDir(env)
}
export function brandName(env: NodeJS.ProcessEnv = process.env): string {
  return resolveBrandName(env)
}
export function findLogo(dir: string = brandingDataDir()): { file: string; type: string } | null {
  return findAsset('wordmark', dir) || findAsset('icon', dir)
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 }, // 2MB — logos/icons, not photos
})

/** Asset URL carrying the file's mtime, so a fresh upload is never hidden by
 * the browser cache (served with max-age) — it shows on the next fetch. */
function assetUrl(slot: Slot, asset: { file: string }): string {
  let v = '0'
  try { v = String(Math.round(fs.statSync(asset.file).mtimeMs)) } catch { /* ignore */ }
  return `/api/branding/${slot}?v=${v}`
}

function urlFor(slot: Slot): string | null {
  const asset = resolveAsset(slot)
  return asset ? assetUrl(slot, asset) : null
}

function sendJson(_req: unknown, res: import('express').Response) {
  const tokens = resolveBrandTokens()
  res.setHeader('Cache-Control', 'no-cache')
  res.json({
    name: resolveBrandName(),
    logo_url: urlFor('wordmark'), // obj 719935 field name, kept
    wordmark_url: urlFor('wordmark'),
    wordmark_dark_url: urlFor('wordmark-dark'),
    icon_url: urlFor('icon'),
    favicon_url: urlFor('favicon') ?? '/api/branding/favicon',
    tokens,
    env_locked_fields: envLockedFields(),
    // Token fields set explicitly (env / config file); the rest are derived
    // from the accent or are the shipped defaults (obj 900750).
    explicit_token_fields: explicitTokenFields(),
    is_customized: isCustomized(),
    default_name: DEFAULT_BRAND_NAME,
    white_label: isWhiteLabeled(),
    powered_by: resolvePoweredBy(),
  })
}

const router = Router()

router.get('/', sendJson)

function serveAsset(slot: Slot) {
  return (_req: AuthRequest, res: import('express').Response) => {
    const asset = resolveAsset(slot)
    if (!asset && slot === 'favicon') {
      const t = resolveBrandTokens()
      res.setHeader('Content-Type', 'image/svg+xml')
      res.setHeader('Cache-Control', 'no-cache')
      res.send(monogramSvg(resolveBrandName(), t.accent, t.accentFg))
      return
    }
    if (!asset) {
      res.status(404).json({ error: `No ${slot} configured` })
      return
    }
    res.setHeader('Content-Type', asset.type)
    // An uploaded SVG must never run script in our origin.
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox")
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Cache-Control', 'public, max-age=300')
    fs.createReadStream(asset.file).pipe(res)
  }
}

router.get('/logo', serveAsset('wordmark')) // obj 719935 back-compat path
router.get('/wordmark', serveAsset('wordmark'))
router.get('/wordmark-dark', serveAsset('wordmark-dark'))
router.get('/icon', serveAsset('icon'))
router.get('/favicon', serveAsset('favicon'))

// ── Admin: set brand name / accent tokens ──────────────────────────────────
router.post('/', requireAuth, requireAdmin, (req: AuthRequest, res) => {
  const body = req.body as { name?: string; tokens?: Record<string, string | null>; powered_by?: boolean }
  writeBrandingConfig({ name: body.name, tokens: body.tokens, powered_by: body.powered_by })
  sendJson(req, res)
})

router.post('/reset', requireAuth, requireAdmin, (req: AuthRequest, res) => {
  resetBrandingConfig()
  sendJson(req, res)
})

// ── Admin: upload a logo/icon/favicon file into the install's data dir ─────
const UPLOADABLE_SLOTS: Slot[] = ['wordmark', 'wordmark-dark', 'icon', 'favicon']
router.post('/upload/:slot', requireAuth, requireAdmin, upload.single('file'), (req: AuthRequest, res) => {
  const slot = req.params.slot as Slot
  if (!UPLOADABLE_SLOTS.includes(slot)) {
    res.status(400).json({ error: `Unknown slot: ${slot}` })
    return
  }
  const file = req.file
  if (!file) {
    res.status(400).json({ error: 'No file uploaded' })
    return
  }
  const ext = file.mimetype === 'image/svg+xml' ? 'svg'
    : file.mimetype === 'image/png' ? 'png'
    : file.mimetype === 'image/x-icon' || file.mimetype === 'image/vnd.microsoft.icon' ? 'ico'
    : null
  if (!ext) {
    res.status(400).json({ error: 'Only SVG, PNG or ICO files are accepted' })
    return
  }
  const dir = brandingDataDir()
  fs.mkdirSync(dir, { recursive: true })
  // Clear any other extension previously uploaded for this slot (avoid a stale
  // file winning findAsset's svg-before-png search order).
  for (const [name] of SLOT_FILES[slot]) fs.rmSync(path.join(dir, name), { force: true })
  fs.writeFileSync(path.join(dir, `${slot}.${ext}`), file.buffer)
  sendJson(req, res)
})

router.delete('/upload/:slot', requireAuth, requireAdmin, (req: AuthRequest, res) => {
  const slot = req.params.slot as Slot
  if (!UPLOADABLE_SLOTS.includes(slot)) {
    res.status(400).json({ error: `Unknown slot: ${slot}` })
    return
  }
  const dir = brandingDataDir()
  for (const [name] of SLOT_FILES[slot]) fs.rmSync(path.join(dir, name), { force: true })
  sendJson(req, res)
})

export default router
