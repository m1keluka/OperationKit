import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './index.css'
import { loadBranding, applyBrandTokens } from './hooks/useBranding'

// Theme (obj 900494): light is the default (matches the Operation Kit site);
// a prior explicit choice (toggle in the topbar) persists across visits.
// Applied before first paint to avoid a flash of the wrong theme.
const THEME_KEY = 'ok-theme'
const storedTheme = localStorage.getItem(THEME_KEY)
if (storedTheme === 'dark' || storedTheme === 'light') {
  document.documentElement.setAttribute('data-theme', storedTheme)
} else {
  document.documentElement.setAttribute('data-theme', 'auto')
}

export function setTheme(theme: 'light' | 'dark'): void {
  document.documentElement.setAttribute('data-theme', theme)
  localStorage.setItem(THEME_KEY, theme)
}

// Default favicon paints instantly (install's accent, from the shipped OK
// palette) — swapped for the install's configured favicon once /api/branding
// resolves (useBranding does this too; this covers the pre-React first paint).
{
  const favicon =
    (document.querySelector("link[rel='icon']") as HTMLLinkElement | null) ??
    document.head.appendChild(Object.assign(document.createElement('link'), { rel: 'icon' }))
  favicon.type = 'image/svg+xml'
  favicon.href =
    "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%232B2BE8'/%3E%3Ccircle cx='16' cy='16' r='7' fill='none' stroke='%23F3F0E8' stroke-width='3'/%3E%3C/svg%3E"
  loadBranding().then(b => {
    document.title = b.name
    applyBrandTokens(b.tokens)
    if (b.favicon_url) favicon.href = b.favicon_url
  })
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
