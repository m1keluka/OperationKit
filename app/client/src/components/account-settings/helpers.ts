/**
 * Shared Account settings helpers — extracted from AccountSettings.tsx
 * (behavior frozen).
 */
export function maskedToken(last4: string): string {
  return `ghp_••••••••••••${last4}`
}

export function fmtDate(iso: string | null): string {
  if (!iso) return 'never'
  // Server stores `datetime('now')` (UTC, space-separated). Normalize to ISO.
  const d = new Date(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z')
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString()
}
