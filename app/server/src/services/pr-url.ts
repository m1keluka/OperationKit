// Parse a GitHub PR number out of a PR URL.
//
// Why this exists: objective rows can have `pr_url` populated but `pr_number` NULL
// (e.g. a worker opens its own PR and only the URL gets linked to the row). The
// harness gate requires a `harness/test-agent` commit status keyed off the PR number,
// so a null `pr_number` strands the PR at "no checks reported" forever. Both the
// link path (so the column is never null when pr_url is set) and postHarnessStatus
// (defensive fallback) derive the number from the URL via this helper.
//
// Accepts the canonical PR URL shape `.../pull/<N>` (optionally with a trailing
// segment like `/files` or a query/fragment). Returns null on anything unparseable.
export function parsePrNumberFromUrl(prUrl: string | null | undefined): number | null {
  if (!prUrl) return null
  const m = prUrl.match(/\/pull\/(\d+)(?:[/?#]|$)/)
  if (!m) return null
  const n = parseInt(m[1], 10)
  return Number.isInteger(n) && n > 0 ? n : null
}
