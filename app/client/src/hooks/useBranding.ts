import { useEffect, useState } from 'react'
import { deriveAccent } from '@operationkit/shared'

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

export interface Branding {
  name: string
  logo_url: string | null
  wordmark_url: string | null
  wordmark_dark_url: string | null
  icon_url: string | null
  favicon_url: string | null
  tokens: BrandTokens
  env_locked_fields: string[]
  /** Token fields the install set explicitly; the rest are derived from the
   * accent (hover / pressed / text-on-accent) or are semantic defaults. */
  explicit_token_fields?: string[]
  is_customized: boolean
  default_name: string
  /** Install has its own name or uploaded marks — default marks are never shown. */
  white_label: boolean
  /** Optional small "Powered by" credit; off by default. */
  powered_by: boolean
}

/** Shipped default brand — used only until /api/branding answers, and when it
 * can't be reached. Exported so the brand-string guard test can whitelist it. */
export const DEFAULT_BRAND_NAME = 'Operation Kit'

/** Where the product's human-readable docs live: the public source repo on
 * `main` (obj 900745). An install does not serve the repo's docs/ folder, so
 * Settings → API & MCP links its API guide here. Kept in this module because it
 * names the product, like DEFAULT_BRAND_NAME (see no-hardcoded-brand.test.ts). */
export const PUBLIC_DOCS_BASE = 'https://github.com/m1keluka/OperationKit/blob/main'

export const DEFAULT_BRANDING: Branding = {
  name: DEFAULT_BRAND_NAME,
  logo_url: null,
  wordmark_url: null,
  wordmark_dark_url: null,
  icon_url: null,
  favicon_url: null,
  tokens: {
    accent: '#2B2BE8', accentHover: '#2727C9', accentPress: '#2323A9', accentFg: '#FFFFFF',
    verify: '#1A7F37', verifyOnDark: '#3FB950', caution: '#D1242F', cautionOnDark: '#F85149',
  },
  env_locked_fields: [],
  is_customized: false,
  default_name: DEFAULT_BRAND_NAME,
  white_label: false,
  powered_by: false,
}

let cached: Promise<Branding> | null = null
let current: Branding | null = null
const listeners = new Set<(b: Branding) => void>()

function normalize(b: Partial<Branding>): Branding {
  return {
    ...DEFAULT_BRANDING,
    ...b,
    tokens: { ...DEFAULT_BRANDING.tokens, ...b.tokens },
    logo_url: b.logo_url ?? b.wordmark_url ?? null,
    white_label: b.white_label ?? false,
    powered_by: b.powered_by ?? false,
  }
}

/** Product name, accent/palette tokens and logos set by the install (env var,
 * config/branding.json, or the Settings > Branding panel) — GET /api/branding. */
export function loadBranding(): Promise<Branding> {
  if (!cached) {
    cached = fetch('/api/branding', { credentials: 'include', cache: 'no-store' })
      .then(r => (r.ok ? r.json() : DEFAULT_BRANDING))
      .then((b: Partial<Branding>) => normalize(b))
      .catch(() => DEFAULT_BRANDING)
      .then(b => { publish(b); return b })
  }
  return cached
}

/** Applies a branding object everywhere at once: every mounted useBranding()
 * (header, login, mobile nav…), CSS tokens, tab title and favicon. */
export function publish(b: Branding): void {
  current = b
  document.title = b.name
  applyBrandTokens(b.tokens)
  applyFavicon(b.favicon_url)
  for (const fn of listeners) fn(b)
}

/** Re-fetches and pushes the result to every mounted consumer — used after the
 * Branding panel saves/uploads, so the new logo/name shows without a reload. */
export function invalidateBranding(next?: Partial<Branding>): Promise<Branding> {
  cached = null
  if (next) {
    const b = normalize(next)
    cached = Promise.resolve(b)
    publish(b)
    return cached
  }
  return loadBranding()
}

/** CSS custom properties for a token set — the accent plus the accent TEXT
 * colours derived from it so links/icons/rings clear 4.5:1 on the neutral
 * grounds in both themes, whatever accent the install picked (obj 900750). */
export function brandTokenVars(tokens: BrandTokens): Record<string, string> {
  const d = deriveAccent(tokens.accent)
  return {
    '--accent': tokens.accent,
    '--accent-hover': tokens.accentHover,
    '--accent-press': tokens.accentPress,
    '--accent-fg': tokens.accentFg,
    '--brand-accent-text': d.textLight,
    '--brand-accent-text-dark': d.textDark,
    '--brand-verify': tokens.verify,
    '--brand-verify-on-dark': tokens.verifyOnDark,
    '--brand-caution': tokens.caution,
    '--brand-caution-on-dark': tokens.cautionOnDark,
  }
}

/** Applies accent/status tokens as CSS custom-property overrides on <html>,
 * so a re-brand reaches every Tailwind class that resolves `var(--accent)`
 * etc. (tailwind.config.ts) without a rebuild. */
export function applyBrandTokens(tokens: BrandTokens): void {
  const root = document.documentElement.style
  for (const [k, v] of Object.entries(brandTokenVars(tokens))) root.setProperty(k, v)
}

export function applyFavicon(url: string | null): void {
  if (!url) return
  let link = document.querySelector<HTMLLinkElement>("link[rel='icon']")
  if (!link) {
    link = document.createElement('link')
    link.rel = 'icon'
    document.head.appendChild(link)
  }
  link.removeAttribute('type')
  link.href = url
}

/** Branding plus whether /api/branding has answered yet — brand marks render
 * a neutral placeholder until then, so a white-labeled install never flashes
 * the default name or mark. */
export function useBrandingState(): { branding: Branding; loaded: boolean } {
  const [state, setState] = useState(() => ({ branding: current ?? DEFAULT_BRANDING, loaded: current !== null }))
  useEffect(() => {
    let alive = true
    const onChange = (b: Branding) => { if (alive) setState({ branding: b, loaded: true }) }
    listeners.add(onChange)
    loadBranding().then(onChange)
    return () => { alive = false; listeners.delete(onChange) }
  }, [])
  return state
}

export function useBranding(): Branding {
  return useBrandingState().branding
}
