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
import { deriveAccent } from '@operationkit/shared'

export const DEFAULT_BRAND_NAME = 'Operation Kit'

/** Shipped defaults. The ACCENT is the one brand lever (Operation Kit
 * Ultramarine); everything else in the UI is neutral (obj 900750). verify /
 * caution are SEMANTIC status colours (success / danger), not brand colours —
 * still overridable, but a white-label install never needs to touch them. */
export const DEFAULT_TOKENS = {
  accent: '#2B2BE8',        // Ultramarine (primary)
  accentHover: '#2727C9',
  accentPress: '#2323A9',
  accentFg: '#FFFFFF',
  verify: '#1A7F37',        // success (light)
  verifyOnDark: '#3FB950',  // success (dark)
  caution: '#D1242F',       // danger (light)
  cautionOnDark: '#F85149', // danger (dark)
} as const

/** The pre-obj-900750 shipped palette. Before the single-accent model, the
 * Settings > Branding panel saved ALL eight tokens on every Save, so existing
 * installs have these exact values sitting in config/branding.json. They are
 * the old DEFAULTS, not a deliberate brand choice — read literally they would
 * pin the old hover / pressed / cream text-on-accent shades next to a new
 * accent and freeze the old status colours. A file token equal to its legacy
 * default is therefore treated as UNSET (derived / current default), and the
 * next panel Save drops it from the file. A value the admin actually changed
 * (anything else) is still honoured. Env vars are deliberate ops input and are
 * never filtered. */
export const LEGACY_DEFAULT_TOKENS: Readonly<Partial<BrandTokens>> = {
  accentHover: '#2727C9',
  accentPress: '#2323A9',
  accentFg: '#F3F0E8',
  verify: '#0B7643',
  verifyOnDark: '#63D18F',
  caution: '#BD321B',
  cautionOnDark: '#F47D67',
}

/** Shades derived from the accent when the install sets only the accent. */
export const DERIVED_TOKEN_FIELDS = ['accentHover', 'accentPress', 'accentFg'] as const
type DerivedField = typeof DERIVED_TOKEN_FIELDS[number]

const ENV_FOR: Record<keyof BrandTokens, string> = {
  accent: 'OK_BRAND_ACCENT',
  accentHover: 'OK_BRAND_ACCENT_HOVER',
  accentPress: 'OK_BRAND_ACCENT_PRESS',
  accentFg: 'OK_BRAND_ACCENT_FG',
  verify: 'OK_BRAND_VERIFY',
  verifyOnDark: 'OK_BRAND_VERIFY_ON_DARK',
  caution: 'OK_BRAND_CAUTION',
  cautionOnDark: 'OK_BRAND_CAUTION_ON_DARK',
}

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
  /** Show a small "Powered by <default product>" line. OFF unless set (obj 900543). */
  powered_by?: boolean
}

/** A POST body may send '' or null for a token to clear its override. */
export interface BrandingConfigFileWrite extends Omit<BrandingConfigFile, 'tokens'> {
  tokens?: Partial<Record<keyof BrandTokens, string | null>>
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
    const parsed = JSON.parse(raw) as BrandingConfigFile
    if (parsed && typeof parsed === 'object' && parsed.tokens) parsed.tokens = dropLegacyDefaults(parsed.tokens)
    return parsed
  } catch {
    return {}
  }
}

/** Removes file tokens that still hold the legacy shipped default for that
 * same field (see LEGACY_DEFAULT_TOKENS). */
export function dropLegacyDefaults(tokens: Partial<BrandTokens>): Partial<BrandTokens> {
  const out: Partial<BrandTokens> = {}
  for (const [key, value] of Object.entries(tokens) as Array<[keyof BrandTokens, string]>) {
    const legacy = LEGACY_DEFAULT_TOKENS[key]
    if (legacy && typeof value === 'string' && value.trim().toLowerCase() === legacy.toLowerCase()) continue
    out[key] = value
  }
  return out
}

/** A CSS hex colour: strictly #rgb or #rrggbb (no alpha forms). */
export function hexOrUndefined(v: string | undefined): string | undefined {
  if (typeof v !== 'string' || !v) return undefined
  const trimmed = v.trim()
  return /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(trimmed) ? trimmed : undefined
}

export function resolveBrandName(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = (env.OK_BRAND_NAME || '').trim().slice(0, 60)
  if (fromEnv) return fromEnv
  const fromFile = readConfigFile().name?.trim().slice(0, 60)
  if (fromFile) return fromFile
  return DEFAULT_BRAND_NAME
}

/** One token from env > config file, or undefined when neither sets it. */
function explicitToken(key: keyof BrandTokens, env: NodeJS.ProcessEnv, file: Partial<BrandTokens>): string | undefined {
  return hexOrUndefined(env[ENV_FOR[key]]) || hexOrUndefined(file[key])
}

export function resolveBrandTokens(env: NodeJS.ProcessEnv = process.env): BrandTokens {
  const file = readConfigFile().tokens || {}
  const accent = explicitToken('accent', env, file) || DEFAULT_TOKENS.accent
  // Single-lever white-label (obj 900750): an install that sets ONLY the accent
  // gets hover / pressed / text-on-accent derived from it — never the default
  // brand's shades sitting next to a custom accent.
  const derived = accent.toLowerCase() === DEFAULT_TOKENS.accent.toLowerCase() ? null : deriveAccent(accent)
  const shade = (key: DerivedField, d: keyof ReturnType<typeof deriveAccent>): string =>
    explicitToken(key, env, file) || (derived ? derived[d] : DEFAULT_TOKENS[key])
  const pick = (key: keyof BrandTokens): string => explicitToken(key, env, file) || DEFAULT_TOKENS[key]
  return {
    accent,
    accentHover: shade('accentHover', 'hover'),
    accentPress: shade('accentPress', 'press'),
    accentFg: shade('accentFg', 'fg'),
    verify: pick('verify'),
    verifyOnDark: pick('verifyOnDark'),
    caution: pick('caution'),
    cautionOnDark: pick('cautionOnDark'),
  }
}

/** Token fields the install set explicitly (env or config file). The Branding
 * panel shows every OTHER derived shade as "Auto (from accent)". */
export function explicitTokenFields(env: NodeJS.ProcessEnv = process.env): Array<keyof BrandTokens> {
  const file = readConfigFile().tokens || {}
  return (Object.keys(ENV_FOR) as Array<keyof BrandTokens>).filter(k => explicitToken(k, env, file) !== undefined)
}

/** Optional small "Powered by" credit — OFF by default so a white-labeled
 * install shows only its own brand (obj 900543). Env OK_BRAND_POWERED_BY
 * (1/true/0/false) wins over the config file. */
export function resolvePoweredBy(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.OK_BRAND_POWERED_BY || '').trim().toLowerCase()
  if (raw === '1' || raw === 'true' || raw === 'yes') return true
  if (raw === '0' || raw === 'false' || raw === 'no') return false
  return readConfigFile().powered_by === true
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
  if (hexOrUndefined(env.OK_BRAND_ACCENT_FG)) locked.push('accentFg')
  if (hexOrUndefined(env.OK_BRAND_VERIFY)) locked.push('verify')
  if (hexOrUndefined(env.OK_BRAND_VERIFY_ON_DARK)) locked.push('verifyOnDark')
  if (hexOrUndefined(env.OK_BRAND_CAUTION)) locked.push('caution')
  if (hexOrUndefined(env.OK_BRAND_CAUTION_ON_DARK)) locked.push('cautionOnDark')
  if ((env.OK_BRAND_POWERED_BY || '').trim()) locked.push('powered_by')
  return locked
}

/** Writes name/tokens into config/branding.json (merges with the existing
 * file). Refuses to write a field that's env-locked — the caller should have
 * already disabled that input, this is the server-side backstop. */
export function writeBrandingConfig(patch: BrandingConfigFileWrite, env: NodeJS.ProcessEnv = process.env): void {
  const locked = new Set(envLockedFields(env))
  const current = readConfigFile()
  const next: BrandingConfigFile = { name: current.name, tokens: { ...current.tokens } }
  if (current.powered_by !== undefined) next.powered_by = current.powered_by
  if (patch.name !== undefined && !locked.has('name')) next.name = patch.name
  if (typeof patch.powered_by === 'boolean' && !locked.has('powered_by')) next.powered_by = patch.powered_by
  if (patch.tokens) {
    for (const [key, value] of Object.entries(patch.tokens)) {
      if (locked.has(key)) continue
      // '' / null clears an override — the shade goes back to "derived from accent".
      if (value === '' || value === null) delete (next.tokens as Record<string, string>)[key]
      else if (hexOrUndefined(value as string)) (next.tokens as Record<string, string>)[key] = value as string
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
