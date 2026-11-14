/**
 * The board's deterministic title key (obj 64, Part C) — split out of
 * `objective-dedupe.ts` (obj 900795) so pure readers such as the High Agency
 * supervisor can use the SAME normaliser without importing the activity feed
 * (and with it the whole server graph). `objective-dedupe.ts` re-exports it, so
 * every existing import keeps working. Steps are documented there.
 */

/** One or more trailing copy-style suffixes, matched on the lowercased title. */
const COPY_SUFFIX_RE = /\s*(?:\(\s*(?:copy(?:\s*\d+)?|\d+)\s*\)|[-–—_:]?\s*\bcopy(?:\s*\d+)?)\s*$/u

/** Deterministic title key — see the module header for the exact steps. */
export function normalizeTitle(title: string | null | undefined): string {
  let s = (title ?? '').normalize('NFKC').toLowerCase().trim()
  // Strip stacked suffixes ("Foo (copy) (2)") until stable; bounded so a hostile
  // title cannot spin.
  for (let i = 0; i < 5; i++) {
    const next = s.replace(COPY_SUFFIX_RE, '')
    if (next === s) break
    s = next
  }
  return s
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}
