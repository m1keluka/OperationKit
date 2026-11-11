import { useEffect, useState } from 'react'

export interface Branding {
  name: string
  logo_url: string | null
}

const DEFAULT_BRANDING: Branding = { name: 'OperationKit', logo_url: null }
let cached: Promise<Branding> | null = null

/** Product name + optional logo set by the client installer (GET /api/branding). */
export function loadBranding(): Promise<Branding> {
  if (!cached) {
    cached = fetch('/api/branding', { credentials: 'include' })
      .then(r => (r.ok ? r.json() : DEFAULT_BRANDING))
      .then((b: Partial<Branding>) => ({ name: b.name || DEFAULT_BRANDING.name, logo_url: b.logo_url ?? null }))
      .catch(() => DEFAULT_BRANDING)
  }
  return cached
}

export function useBranding(): Branding {
  const [branding, setBranding] = useState<Branding>(DEFAULT_BRANDING)
  useEffect(() => {
    let alive = true
    loadBranding().then(b => {
      if (!alive) return
      setBranding(b)
      document.title = b.name
    })
    return () => { alive = false }
  }, [])
  return branding
}
