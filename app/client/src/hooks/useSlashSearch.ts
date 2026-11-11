import { useEffect, useState } from 'react'

/**
 * "/" opens objective search (unless the user is already typing in a field).
 * Esc is handled by ObjectiveSearchPanel. Kept off ⌘K, which Layout owns
 * for the nav palette.
 */
export function useSlashSearch() {
  const [searchOpen, setSearchOpen] = useState(false)

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return
      const el = e.target as HTMLElement | null
      const tag = el?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || el?.isContentEditable) return
      e.preventDefault()
      setSearchOpen(true)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  return [searchOpen, setSearchOpen] as const
}
