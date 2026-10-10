/**
 * Admin PR-link override for `PUT /api/objectives/:id` (obj 712954).
 *
 * The PUT used to write a fixed column list, so pr_url / pr_number / branch_name
 * in the body were dropped with a 200 (verified on obj 712923, 2026-09-28) — an
 * operator had no way to fix a stale link. This is the pure validator; the route
 * gates it to admins, writes it, and appends an `objective_audit` row.
 */

export interface PrLinkPatch {
  /** undefined (with pr_number) = leave the PR link as is. */
  pr_url?: string | null
  pr_number?: number | null
  /** undefined = leave branch_name as is. */
  branch_name?: string | null
}

export type PrLinkPatchResult =
  | { touched: false }
  | { touched: true; ok: true; patch: PrLinkPatch }
  | { touched: true; ok: false; error: string }

const PR_URL_RE = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/(\d+)\/?$/
// A git ref name: no spaces, no `..`, no leading `-`/`/`, no control chars.
const BRANCH_RE = /^(?![-/])(?!.*\.\.)[A-Za-z0-9._/-]{1,255}$/

/** Pure: validate the PR-link keys of a PUT body. `touched: false` when none are present. */
export function parsePrLinkPatch(body: Record<string, unknown>): PrLinkPatchResult {
  const has = (k: string) => Object.prototype.hasOwnProperty.call(body, k) && body[k] !== undefined
  if (!has('pr_url') && !has('pr_number') && !has('branch_name')) return { touched: false }

  const bad = (error: string): PrLinkPatchResult => ({ touched: true, ok: false, error })
  let branch: string | null | undefined
  if (has('branch_name')) {
    const b = body.branch_name
    if (b === null) branch = null
    else if (typeof b === 'string' && BRANCH_RE.test(b.trim())) branch = b.trim()
    else return bad('branch_name must be a valid git branch name or null')
  }

  if (!has('pr_url')) {
    if (has('pr_number')) return bad('pr_number requires pr_url (a GitHub PR URL with the same number)')
    return { touched: true, ok: true, patch: { branch_name: branch } }
  }

  if (body.pr_url === null) {
    if (has('pr_number') && body.pr_number !== null) return bad('pr_number must be null when pr_url is null')
    return { touched: true, ok: true, patch: { pr_url: null, pr_number: null, branch_name: branch } }
  }
  if (typeof body.pr_url !== 'string') return bad('pr_url must be a GitHub PR URL or null')
  const m = PR_URL_RE.exec(body.pr_url.trim())
  if (!m) return bad('pr_url must look like https://github.com/<owner>/<repo>/pull/<number>')
  const urlNumber = parseInt(m[1], 10)
  if (!(urlNumber > 0)) return bad('pr_url has no valid PR number')
  if (has('pr_number')) {
    const n = body.pr_number
    if (typeof n !== 'number' || !Number.isInteger(n) || n <= 0) return bad('pr_number must be a positive integer')
    if (n !== urlNumber) return bad(`pr_number ${n} does not match pr_url number ${urlNumber}`)
  }
  return {
    touched: true,
    ok: true,
    patch: { pr_url: body.pr_url.trim().replace(/\/$/, ''), pr_number: urlNumber, branch_name: branch },
  }
}
