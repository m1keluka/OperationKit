import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import './preview.css'
import { DiskLowBanner } from '../components/DiskLowBanner'
import { paintTheme, readStoredTheme, resolveTheme, setTheme as persistTheme, type Theme } from '../lib/theme'

const BoardThemeContext = createContext<{
  theme: Theme
  toggleTheme: () => void
}>({ theme: 'light', toggleTheme: () => {} })

/** App-wide theme state (name kept for back-compat). Reads and writes the ONE
 * theme store in lib/theme.ts, which paints `<html data-theme>` — so the
 * header, board, settings, login and portals always agree (obj 900543). */
export function BoardThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(resolveTheme)

  // No explicit choice yet → follow the OS preference live.
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)')
    if (!mq) return
    const onChange = () => {
      if (readStoredTheme()) return
      const next: Theme = mq.matches ? 'dark' : 'light'
      paintTheme(next)
      setThemeState(next)
    }
    mq.addEventListener?.('change', onChange)
    return () => mq.removeEventListener?.('change', onChange)
  }, [])

  function toggleTheme() {
    setThemeState(prev => {
      const next: Theme = prev === 'light' ? 'dark' : 'light'
      persistTheme(next)
      return next
    })
  }

  return (
    <BoardThemeContext.Provider value={{ theme, toggleTheme }}>
      {children}
    </BoardThemeContext.Provider>
  )
}

export function useBoardTheme() {
  return useContext(BoardThemeContext)
}

/** Canvas for the workspace board / objective page. Lives inside Layout and
 * inherits the theme from <html data-theme> — it no longer carries its own. */
export function BoardShell({ children }: { children: ReactNode }) {
  return (
    <div className="cc-ws flex h-full min-h-0 flex-col">
      <DiskLowBanner />
      {children}
    </div>
  )
}
