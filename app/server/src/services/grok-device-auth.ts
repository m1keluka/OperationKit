/**
 * SuperGrok device-code login helpers (headless Connect on the dashboard).
 * `grok login --device-auth` prints a URL + short code; the operator approves
 * on any device; the CLI writes ~/.grok/auth.json and we detect that file.
 */
export function extractGrokDeviceAuth(pane: string): { url: string; userCode: string } | null {
  const cleaned = pane.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/\r/g, '')
  const urls = cleaned.match(/https:\/\/[^\s"'<>\\]+/gi) || []
  const url = urls.find(u => /device|activate|auth\.x\.ai|accounts\.x\.ai|grok\.com/i.test(u)) || urls[0]
  if (!url) return null
  const trimmedUrl = url.replace(/[.,;)\]]+$/, '')

  let userCode: string | null = null
  try {
    const parsed = new URL(trimmedUrl)
    userCode = parsed.searchParams.get('user_code') || parsed.searchParams.get('code')
  } catch { /* pane fragment, not a full URL */ }

  if (!userCode) {
    const labeled = cleaned.match(
      /(?:user[\s-]?code|enter(?:\s+the)?\s+code|code)[:\s]+([A-Z0-9]{4,8}(?:-[A-Z0-9]{4,8})?)/i,
    )
    const dotted = cleaned.match(/\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/)
    userCode = labeled?.[1] || dotted?.[1] || null
  }
  if (!userCode) return null
  return { url: trimmedUrl, userCode: userCode.toUpperCase() }
}

export function grokLoginSucceeded(pane: string): boolean {
  return /logged in|login successful|authentication successful|you are now (?:signed|logged) in/i.test(pane)
}
