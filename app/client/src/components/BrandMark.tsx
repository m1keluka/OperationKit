import type { Branding } from '../hooks/useBranding'

/** Icon mark (when the install has one) + product name, used on the sign-in screens. */
export function BrandMark({ branding }: { branding: Branding }) {
  const mark = branding.icon_url || branding.logo_url
  return (
    <h1 className="flex items-center justify-center gap-2 font-display text-2xl font-bold text-fg-0">
      {mark
        ? <img src={mark} alt="" className="h-8 w-8 rounded object-contain" />
        : <span className="text-accent" aria-hidden="true">›</span>}
      {branding.name}
    </h1>
  )
}
