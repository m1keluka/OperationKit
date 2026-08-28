/** True when the optimistic send bubble can retire — the real follow-up is in the timeline. */
export function echoLandedInSegments(
  segments: { type: string; text?: string }[],
  echo: string,
): boolean {
  const t = echo.trim()
  if (!t) return false
  return segments.some(s =>
    (s.type === 'divider' || s.type === 'question') &&
    typeof s.text === 'string' &&
    (s.text === t || s.text.startsWith(t)),
  )
}
