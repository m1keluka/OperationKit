/**
 * Settings → Branding (obj 900494). Mounts the real branding editor built in
 * sprint 3 — accent/palette, logo uploads, live preview — inside the sprint
 * 4b settings shell. This file only mounts BrandingPanel; the panel's own
 * implementation lives in BrandingPanel.tsx.
 */
import { BrandingPanel } from './BrandingPanel'

export function SettingsBranding() {
  return <BrandingPanel />
}
