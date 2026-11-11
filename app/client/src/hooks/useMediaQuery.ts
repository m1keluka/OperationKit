import { useEffect, useState } from 'react'

/** Matches `board.css` mobile stack (`max-width: 767px`). */
export const BOARD_MOBILE_QUERY = '(max-width: 767px)'

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window !== 'undefined' && window.matchMedia(query).matches,
  )
  useEffect(() => {
    const mq = window.matchMedia(query)
    const onChange = () => setMatches(mq.matches)
    onChange()
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [query])
  return matches
}

export function useIsBoardMobile(): boolean {
  return useMediaQuery(BOARD_MOBILE_QUERY)
}
