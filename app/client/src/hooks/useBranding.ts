import { useEffect, useState } from 'react'

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
  is_customized: boolean
  default_name: string
}

const DEFAULT_BRANDING: Branding = {
  name: 'Operation Kit',
  logo_url: null,
  wordmark_url: null,
  wordmark_dark_url: null,
  icon_url: null,
  favicon_url: null,
  tokens: {
    accent: '#2B2BE8', accentHover: '#2727C9', accentPress: '#2323A9', accentFg: '#F3F0E8',
    verify: '#0B7643', verifyOnDark: '#63D18F', caution: '#BD321B', cautionOnDark: '#F47D67',
  },
  env_locked_fields: [],
  is_customized: false,
  default_name: 'Operation Kit',
}

let cached: Promise<Branding> | null = null

/** Product name, accent/palette tokens and logos set by the install (env var,
 * config/branding.json, or the Settings > Branding panel) — GET /api/branding. */
export function loadBranding(): Promise<Branding> {
  if (!cached) {
    cached = fetch('/api/branding', { credentials: 'include' })
      .then(r => (r.ok ? r.json() : DEFAULT_BRANDING))
      .then((b: Partial<Branding>) => ({
        ...DEFAULT_BRANDING,
        ...b,
        tokens: { ...DEFAULT_BRANDING.tokens, ...b.tokens },
        logo_url: b.logo_url ?? b.wordmark_url ?? null,
      }))
      .catch(() => DEFAULT_BRANDING)
  }
  return cached
}

/** Re-fetches on next call — used after the Branding panel saves a change. */
export function invalidateBranding(): void {
  cached = null
}

/** Applies accent/status tokens as CSS custom-property overrides on <html>,
 * so a re-brand reaches every Tailwind class that resolves `var(--accent)`
 * etc. (tailwind.config.ts) without a rebuild. Called once at boot (main.tsx)
 * and again whenever the Branding panel saves. */
export function applyBrandTokens(tokens: BrandTokens): void {
  const root = document.documentElement.style
  root.setProperty('--accent', tokens.accent)
  root.setProperty('--accent-hover', tokens.accentHover)
  root.setProperty('--accent-press', tokens.accentPress)
  root.setProperty('--accent-fg', tokens.accentFg)
  root.setProperty('--ok-verify', tokens.verify)
  root.setProperty('--ok-alarm', tokens.caution)
}

export function useBranding(): Branding {
  const [branding, setBranding] = useState<Branding>(DEFAULT_BRANDING)
  useEffect(() => {
    let alive = true
    loadBranding().then(b => {
      if (!alive) return
      setBranding(b)
      document.title = b.name
      applyBrandTokens(b.tokens)
      if (b.favicon_url) {
        let link = document.querySelector<HTMLLinkElement>("link[rel='icon']")
        if (!link) {
          link = document.createElement('link')
          link.rel = 'icon'
          document.head.appendChild(link)
        }
        link.href = b.favicon_url
      }
    })
    return () => { alive = false }
  }, [])
  return branding
}
