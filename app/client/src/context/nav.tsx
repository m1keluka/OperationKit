import { createContext, useContext } from 'react'

/**
 * In-app SPA navigation. The provider (AppContent) supplies a `navigate(href)`
 * that calls react-router `navigate` — NO full document reload. Consumers
 * (Layout nav links, the ⌘K palette) call it for plain left-clicks; modified
 * clicks fall through to the real anchor so cmd/ctrl/middle-click still open
 * a new tab.
 *
 * The default is a hard navigation so the hook is safe if ever used outside the
 * provider.
 */
export const NavContext = createContext<(href: string) => void>((href) => {
  window.location.assign(href)
})

export function useNavigate() {
  return useContext(NavContext)
}
