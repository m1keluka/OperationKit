/**
 * Branding config (obj 900494) — resolves the install's brand (name, accent
 * palette, logo paths) so ANY install can re-brand without touching code.
 *
 * Precedence (highest wins), documented in docs/branding.md:
 *   1. Environment variables (OK_BRAND_*)         — ops/compose override
 *   2. config/branding.json (gitignored, optional) — settable from the
 *      Settings > Branding admin panel; a server restart is enough, no
 *      rebuild needed, because this file lives in the mounted source tree
 *      and is read fresh on every GET /api/branding call (not cached).
 *   3. Built-in Operation Kit brand 1.0 defaults (this file's DEFAULT_*).
 *
 * config/branding.json.example is checked in (documents the shape);
 * config/branding.json itself is gitignored — it's per-install runtime
 * state, not source.
 */
import fs from 'fs'
import path from 'path'

export const DEFAULT_BRAND_NAME = 'Operation Kit'

/** Operation Kit brand 1.0 ("circle O") palette — matches operationkit-site tokens.css. */
export const DEFAULT_TOKENS = {
  accent: '#2B2BE8',        // Ultramarine (primary)
  accentHover: '#2727C9',
  accentPress: '#2323A9',
  accentFg: '#F3F0E8',
  verify: '#0B7643',
  verifyOnDark: '#63D18F',
  caution: '#BD321B',
  cautionOnDark: '#F47D67',
} as const

export interface BrandTokens {
  accent: string
  accentHover: string
  accentPress: string
  accentFg: string
  verify: string
  verifyOnDark: string
  caution: string
  cautionOnDark: string
}

export interface BrandingConfigFile {
  name?: string
  tokens?: Partial<BrandTokens>
}

/** Where the per-install data (uploaded logos, the gitignored config file lives
 * next to the SQLite DB) — same directory the original obj-719935 logo used. */
export function brandingDataDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(path.dirname(env.DB_PATH || '/app/data/command-center.db'), 'branding')
}

/** Repo-relative config file, read fresh (not cached) so a restart alone picks
 * up an admin-panel save or a hand-edited file — no rebuild. */
export function brandingConfigPath(): string {
  // app/server/src/services -> repo root is 4 levels up at build time (dist) or
  // 5 at source time (tsx). Resolve from this module's own directory either way.
  return path.join(import.meta.dirname, '..', '..', '..', '..', 'config', 'branding.json')
}

function readConfigFile(): BrandingConfigFile {
  try {
    const raw = fs.readFileSync(brandingConfigPath(), 'utf-8')
    return JSON.parse(raw) as BrandingConfigFile
  } catch {
    return {}
  }
}

function hexOrUndefined(v: string | undefined): string | undefined {
  if (!v) return undefined
  const trimmed = v.trim()
  return /^#[0-9a-fA-F]{3,8}$/.test(trimmed) ? trimmed : undefined
}

export function resolveBrandName(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = (env.OK_BRAND_NAME || '').trim().slice(0, 60)
  if (fromEnv) return fromEnv
  const fromFile = readConfigFile().name?.trim().slice(0, 60)
  if (fromFile) return fromFile
  return DEFAULT_BRAND_NAME
}

export function resolveBrandTokens(env: NodeJS.ProcessEnv = process.env): BrandTokens {
  const file = readConfigFile().tokens || {}
  return {
    accent: hexOrUndefined(env.OK_BRAND_ACCENT) || file.accent || DEFAULT_TOKENS.accent,
    accentHover: hexOrUndefined(env.OK_BRAND_ACCENT_HOVER) || file.accentHover || DEFAULT_TOKENS.accentHover,
    accentPress: hexOrUndefined(env.OK_BRAND_ACCENT_PRESS) || file.accentPress || DEFAULT_TOKENS.accentPress,
    accentFg: hexOrUndefined(env.OK_BRAND_ACCENT_FG) || file.accentFg || DEFAULT_TOKENS.accentFg,
    verify: hexOrUndefined(env.OK_BRAND_VERIFY) || file.verify || DEFAULT_TOKENS.verify,
    verifyOnDark: hexOrUndefined(env.OK_BRAND_VERIFY_ON_DARK) || file.verifyOnDark || DEFAULT_TOKENS.verifyOnDark,
    caution: hexOrUndefined(env.OK_BRAND_CAUTION) || file.caution || DEFAULT_TOKENS.caution,
    cautionOnDark: hexOrUndefined(env.OK_BRAND_CAUTION_ON_DARK) || file.cautionOnDark || DEFAULT_TOKENS.cautionOnDark,
  }
}

/** True once any brand value has been customized away from the OK defaults —
 * used by the admin panel to show a "reset to default" affordance. */
export function isCustomized(env: NodeJS.ProcessEnv = process.env): boolean {
  const tokens = resolveBrandTokens(env)
  const name = resolveBrandName(env)
  return name !== DEFAULT_BRAND_NAME || JSON.stringify(tokens) !== JSON.stringify(DEFAULT_TOKENS)
}

/** Env vars always win and can't be overwritten by the panel — tell the caller
 * which (if any) brand fields are env-locked so the UI can disable those inputs. */
export function envLockedFields(env: NodeJS.ProcessEnv = process.env): string[] {
  const locked: string[] = []
  if ((env.OK_BRAND_NAME || '').trim()) locked.push('name')
  if (hexOrUndefined(env.OK_BRAND_ACCENT)) locked.push('accent')
  if (hexOrUndefined(env.OK_BRAND_ACCENT_HOVER)) locked.push('accentHover')
  if (hexOrUndefined(env.OK_BRAND_ACCENT_PRESS)) locked.push('accentPress')
  return locked
}

/** Writes name/tokens into config/branding.json (merges with the existing
 * file). Refuses to write a field that's env-locked — the caller should have
 * already disabled that input, this is the server-side backstop. */
export function writeBrandingConfig(patch: BrandingConfigFile, env: NodeJS.ProcessEnv = process.env): void {
  const locked = new Set(envLockedFields(env))
  const current = readConfigFile()
  const next: BrandingConfigFile = { name: current.name, tokens: { ...current.tokens } }
  if (patch.name !== undefined && !locked.has('name')) next.name = patch.name
  if (patch.tokens) {
    for (const [key, value] of Object.entries(patch.tokens)) {
      if (locked.has(key)) continue
      if (hexOrUndefined(value)) (next.tokens as Record<string, string>)[key] = value as string
    }
  }
  const filePath = brandingConfigPath()
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify(next, null, 2) + '\n')
}

export function resetBrandingConfig(): void {
  const filePath = brandingConfigPath()
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
}
