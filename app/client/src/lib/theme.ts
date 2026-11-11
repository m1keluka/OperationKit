/**
 * Theme — ONE source of truth for light/dark (obj 900543).
 *
 * Root cause of "light mode doesn't work": the topbar toggle used to write a
 * second, board-only store (`cc.preview.theme.v2`, default dark) and set
 * `data-theme` only on the board wrapper, while the header, login, settings,
 * dialogs and every portal read `:root[data-theme]` from a different key
 * (`ok-theme`) that nothing ever wrote. Toggling therefore only repainted the
 * board, and on a dark-OS machine everything else stayed dark.
 *
 * Now: the choice lives in `localStorage['ok-theme']` (same key the brand site
 * uses), is applied to `<html data-theme>` (the only place tokens read from),
 * and with no explicit choice it follows the OS `prefers-color-scheme`.
 */

export type Theme = 'light' | 'dark'

export const THEME_KEY = 'ok-theme'
/** Pre-900543 board-only key — migrated once, then removed. */
export const LEGACY_THEME_KEY = 'cc.preview.theme.v2'

const THEME_COLOR: Record<Theme, string> = { light: '#F3F0E8', dark: '#16163A' }

function safeGet(key: string): string | null {
  try { return localStorage.getItem(key) } catch { return null }
}

/** Explicit user choice, or null when the user never picked one. */
export function readStoredTheme(): Theme | null {
  const v = safeGet(THEME_KEY)
  if (v === 'light' || v === 'dark') return v
  return null
}

export function systemTheme(): Theme {
  try {
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  } catch {
    return 'light'
  }
}

/** The theme to render: the explicit choice, else the OS preference. */
export function resolveTheme(): Theme {
  return readStoredTheme() ?? systemTheme()
}

/** Paints `theme` on <html> (tokens + color-scheme + mobile browser chrome). */
export function paintTheme(theme: Theme): void {
  const root = document.documentElement
  root.setAttribute('data-theme', theme)
  root.style.colorScheme = theme
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
  if (meta) meta.content = THEME_COLOR[theme]
}

/** Persists an explicit choice and paints it. */
export function setTheme(theme: Theme): void {
  try { localStorage.setItem(THEME_KEY, theme) } catch { /* private mode */ }
  paintTheme(theme)
}

/** Boot: migrate the legacy board key once, then paint the resolved theme. */
export function initTheme(): Theme {
  if (!readStoredTheme()) {
    const legacy = safeGet(LEGACY_THEME_KEY)
    if (legacy === 'light' || legacy === 'dark') {
      try { localStorage.setItem(THEME_KEY, legacy) } catch { /* ignore */ }
    }
  }
  try { localStorage.removeItem(LEGACY_THEME_KEY) } catch { /* ignore */ }
  const t = resolveTheme()
  paintTheme(t)
  return t
}
