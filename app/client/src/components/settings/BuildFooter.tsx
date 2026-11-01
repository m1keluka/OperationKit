/**
 * Which build is running (obj 720210): the commit from /api/health, so a
 * support conversation can start from "Settings → bottom of the page".
 */
import { useEffect, useState } from 'react'

export function BuildFooter() {
  const [commit, setCommit] = useState<string | null | undefined>(undefined)

  useEffect(() => {
    let live = true
    fetch('/api/health', { credentials: 'include' })
      .then(r => (r.ok ? r.json() : null))
      .then((b: { commit?: string | null } | null) => { if (live) setCommit(b?.commit ?? null) })
      .catch(() => { if (live) setCommit(null) })
    return () => { live = false }
  }, [])

  return (
    <footer className="mt-10 border-t border-line-soft pt-4 text-[12px] text-fg-2" data-testid="build-footer">
      Build{' '}
      {commit === undefined ? (
        <span className="inline-block h-3 w-20 animate-pulse rounded bg-surface-3 align-middle" aria-label="Loading build" />
      ) : (
        <span className="select-all font-mono text-fg-1">{commit ?? 'unknown'}</span>
      )}
    </footer>
  )
}
