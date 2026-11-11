import type { Branding } from '../hooks/useBranding'
import { BrandLogo } from './BrandLogo'

/** The install's logo lockup, used on the sign-in screens. Routes through
 * BrandLogo (live /api/branding state, neutral placeholder until it answers)
 * so the uploaded wordmark/icon shows — never a hardcoded mark. The prop is
 * kept for call-site compatibility. */
export function BrandMark(_props: { branding?: Branding }) {
  return (
    <h1 className="flex items-center justify-center">
      <BrandLogo size="lg" />
    </h1>
  )
}
