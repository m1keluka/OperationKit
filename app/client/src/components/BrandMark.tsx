import type { Branding } from '../hooks/useBranding'

/** Logo (when the install has one) + product name, used on the sign-in screens. */
export function BrandMark({ branding }: { branding: Branding }) {
  return (
    <h1 className="flex items-center justify-center gap-2 font-display text-2xl font-bold text-fg-0">
      {branding.logo_url
        ? <img src={branding.logo_url} alt="" className="h-8 w-8 rounded object-contain" />
        : <span className="text-accent" aria-hidden="true">›</span>}
      {branding.name}
    </h1>
  )
}
