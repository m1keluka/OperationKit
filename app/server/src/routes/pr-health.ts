/**
 * The Operator-facing PR-health surface (obj 704700).
 *
 * WHY A ROUTE + DIGEST RATHER THAN A UI PANEL
 * -------------------------------------------
 * The ask was "one place that answers, without hunting: which PRs are red, what is red
 * about each, real failure or noise, which objective owns it, attempts spent." Two
 * endpoints do that completely:
 *   GET /api/internal/pr-health         → the structured report (JSON), for tooling
 *   GET /api/internal/pr-health/digest  → the same report rendered as markdown, for eyes
 *
 * A full client panel was considered and rejected for now. The existing client has no
 * PR-centric view to hang this off, so a panel means new nav + new component + new
 * client build — a large diff in a repo where a sibling worker is concurrently editing
 * the remediation services, for no additional answered question. The digest is one
 * `curl` and is already the format Operator reads elsewhere (hygiene digest, Assistant
 * briefing), and the JSON endpoint means a panel can be added later with zero rework.
 *
 * WHAT THE REPORT NOW ANSWERS (obj 704763)
 * ----------------------------------------
 * "Which PRs are red" turned out to be the wrong headline on its own — most red checks
 * gate nothing. Every row now carries `requiredRedChecks` / `advisoryRedChecks` (split on
 * the live ruleset for the PR's BASE branch), `requiredContexts`, `requiredGateState`, and
 * `mergeableNow`. The digest leads with a **MERGEABLE NOW** section and the header tally
 * reads `N red · N with a REQUIRED check failing · N mergeable now · …`.
 *
 * `requiredGateState: 'no-ruleset'` — the live state of example-platform's `redesign` branch,
 * which is what most example PRs target — means GitHub returned an EMPTY required list. That
 * is "nothing is gating this PR", NOT "the checks passed". The digest prints it in those
 * words rather than as a green tick, and `mergeableNow` there rests on GitHub's own
 * `mergeStateStatus`, not on the empty list. `'unknown'` (ruleset unreadable) is surfaced
 * as a banner and makes `mergeableNow` false: we do not assert mergeability from a gate we
 * failed to read.
 *
 * BOTH ENDPOINTS ARE STRICTLY READ-ONLY. They force `dryRun: true`, so hitting the URL
 * can never re-run a job, nudge a session, or post an escalation regardless of whether
 * the watchdog flag is armed. Reading a status page must never change the status.
 */

import { Router } from 'express'
import { getDb } from '../db/index.js'
import { isLocalhost } from '../lib/is-localhost.js'
import {
  runWatchdogOnce,
  renderDigest,
  buildDefaultDeps,
  type SweepResult,
} from '../services/pr-health-watchdog.js'
// obj 704785: objectives that CLOSED on a non-green PR are rendered onto this same
// surface rather than a new one Operator would have to remember to check. The watchdog
// answers "which open PRs are red"; this answers "which finished objectives left one
// behind, and why the CI-green gate released them". Composed here, in the route, so
// pr-health-watchdog.ts itself is untouched (a sibling worker owns that file).
import {
  listNonGreenCompletions,
  renderNonGreenCompletions,
} from '../services/ci-green-gate.js'

const router = Router()

/** A sweep costs one `gh` call per repo, so a hot-reloading dashboard must not fan out
 *  into rate limiting. Serve a recent report instead. */
const CACHE_MS = 60_000
let cached: { at: number; report: SweepResult } | null = null

async function getReport(force: boolean): Promise<SweepResult> {
  if (!force && cached && Date.now() - cached.at < CACHE_MS) return cached.report
  const db = getDb()
  // dryRun is hard-wired: this is an observation surface, never an act-path.
  const deps = await buildDefaultDeps(db, { dryRun: true })
  const report = await runWatchdogOnce(deps)
  cached = { at: Date.now(), report }
  return report
}

function gate(req: Parameters<typeof isLocalhost>[0], res: { status: (n: number) => { json: (b: unknown) => void } }): boolean {
  if (!isLocalhost(req)) {
    res.status(403).json({ error: 'Internal API: localhost only' })
    return false
  }
  return true
}

/** Structured report — every field the digest renders, plus the green/pending PRs. */
router.get('/', async (req, res) => {
  if (!gate(req, res)) return
  try {
    const report = await getReport(req.query.refresh === '1')
    res.json({ ...report, nonGreenCompletions: listNonGreenCompletions(getDb()) })
  } catch (err) {
    res.status(500).json({ error: (err as Error).message })
  }
})

/** The one-screen answer. text/markdown so `curl` renders readably in a terminal. */
router.get('/digest', async (req, res) => {
  if (!gate(req, res)) return
  try {
    const report = await getReport(req.query.refresh === '1')
    res.type('text/markdown').send(
      renderDigest(report) + renderNonGreenCompletions(listNonGreenCompletions(getDb())),
    )
  } catch (err) {
    res.status(500).type('text/plain').send(`PR health sweep failed: ${(err as Error).message}\n`)
  }
})

export default router
