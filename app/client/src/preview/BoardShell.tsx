import { createContext, useContext, useState, type ReactNode } from 'react'
import './preview.css'

const THEME_KEY = 'cc.preview.theme.v2'

function loadTheme(): 'light' | 'dark' {
  try {
    const v = localStorage.getItem(THEME_KEY)
    if (v === 'dark' || v === 'light') return v
  } catch { /* ignore */ }
  return 'dark'
}

const BoardThemeContext = createContext<{
  theme: 'light' | 'dark'
  toggleTheme: () => void
}>({ theme: 'dark', toggleTheme: () => {} })

export function BoardThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<'light' | 'dark'>(loadTheme)

  function toggleTheme() {
    setTheme(prev => {
      const next = prev === 'light' ? 'dark' : 'light'
      try { localStorage.setItem(THEME_KEY, next) } catch { /* ignore */ }
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

/** Themed canvas for the workspace board / objective page. Lives inside Layout. */
export function BoardShell({ children }: { children: ReactNode }) {
  const { theme } = useBoardTheme()
  return (
    <div className="cc-ws flex h-full min-h-0 flex-col" data-theme={theme}>
      {children}
    </div>
  )
}
