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
  isCustomized,
  writeBrandingConfig,
  resetBrandingConfig,
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

/** Looks in the install's data dir (admin upload) first, then the shipped
 * default asset dir. Returns null only if neither has the slot. */
export function findAsset(slot: Slot, dataDir: string = brandingDataDir()): { file: string; type: string } | null {
  for (const dir of [dataDir, DEFAULT_ASSET_DIR]) {
    for (const [name, type] of SLOT_FILES[slot]) {
      const file = path.join(dir, name)
      if (fs.existsSync(file)) return { file, type }
    }
  }
  return null
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

function assetUrl(slot: Slot): string {
  return `/api/branding/${slot}`
}

function sendJson(_req: unknown, res: import('express').Response) {
  const tokens = resolveBrandTokens()
  res.setHeader('Cache-Control', 'no-cache')
  res.json({
    name: resolveBrandName(),
    logo_url: findAsset('wordmark') ? assetUrl('wordmark') : null, // obj 719935 field name, kept
    wordmark_url: findAsset('wordmark') ? assetUrl('wordmark') : null,
    wordmark_dark_url: findAsset('wordmark-dark') ? assetUrl('wordmark-dark') : null,
    icon_url: findAsset('icon') ? assetUrl('icon') : null,
    favicon_url: findAsset('favicon') ? assetUrl('favicon') : null,
    tokens,
    env_locked_fields: envLockedFields(),
    is_customized: isCustomized(),
    default_name: DEFAULT_BRAND_NAME,
  })
}

const router = Router()

router.get('/', sendJson)

function serveAsset(slot: Slot) {
  return (_req: AuthRequest, res: import('express').Response) => {
    const asset = findAsset(slot)
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
  const body = req.body as { name?: string; tokens?: Record<string, string> }
  writeBrandingConfig({ name: body.name, tokens: body.tokens })
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
