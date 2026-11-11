/**
 * The live-install smoke CLI, as a FUNCTION (obj 900366).
 *
 * `src/scripts/bots-smoke.ts` is a ten-line wrapper around `runSmokeCli`. The
 * split is not decoration: `db/index.ts` transitively pulls `node-pty`, a
 * native module that only exists where the image built it, so a CLI written as
 * a top-level script can be typechecked but never EXERCISED in a test. Every
 * decision an operator depends on — which subcommand does what, what exit code
 * they get, what the payload contains — would then be unverified glue wrapped
 * around verified logic.
 *
 * So the database handle and the agent-slug lookup arrive as injected deps, and
 * this module imports nothing that needs a native build. Exit codes are the
 * contract:
 *
 *   0  proceed
 *   1  refused / preservation differs — stop, the payload says why
 *   2  usage error
 */
import type { Database } from 'better-sqlite3'
import {
  assessCeilingReadiness,
  chooseThreadLane,
  diffFingerprints,
  planSmokeCleanup,
  preservationFingerprint,
  resolveSmokeIdentity,
  type PreservationFingerprint,
} from './bots-smoke.js'

export interface SmokeCliDeps {
  db: Database
  /** Every agent slug already spoken for on this install. MUST throw rather than return [] when it cannot tell. */
  occupiedSlugs: () => string[]
  readJson: (path: string) => unknown
  out: (value: unknown) => void
  err: (line: string) => void
}

export const SMOKE_CLI_USAGE =
  'usage: bots-smoke <preflight <workspace> [bot] | fingerprint | diff <before.json> <after.json> | cleanup-plan <id> <lane> <workspace>>\n' +
  '       see docs/bots/live-install-job-smoke-runbook.md'

/**
 * Accept either a bare fingerprint or a whole preflight payload, so an operator
 * can diff the exact file preflight told them to save instead of having to
 * extract a sub-object first.
 */
export function asFingerprint(parsed: unknown): PreservationFingerprint {
  const v = parsed as PreservationFingerprint & { fingerprint?: PreservationFingerprint }
  return v?.fingerprint ?? v
}

function preflight(deps: SmokeCliDeps, workspace: string, botName: string): number {
  const identity = resolveSmokeIdentity(deps.db, botName)
  if (!identity.ok) {
    deps.out({ ready: false, stage: 'identity', ...identity })
    return 1
  }
  let occupied: string[]
  try {
    occupied = deps.occupiedSlugs()
  } catch (e) {
    // "I cannot tell which slugs are free" is NOT "they are all free". Treating
    // it as the latter would hand the smoke somebody's live conversation.
    deps.out({ ready: false, stage: 'thread_lane', code: 'slugs_unknown', error: (e as Error).message })
    return 1
  }
  const lane = chooseThreadLane(deps.db, identity.bot, occupied)
  if (!lane.ok) {
    deps.out({ ready: false, stage: 'thread_lane', bot: identity.bot.id, ...lane })
    return 1
  }
  const ceiling = assessCeilingReadiness(deps.db, { workspace })
  deps.out({
    ready: ceiling.ready,
    stage: ceiling.ready ? 'ready' : 'ceiling',
    workspace,
    bot: identity.bot.id,
    recognised_slugs: identity.recognisedSlugs,
    thread_lane: lane,
    ceiling,
    fingerprint: preservationFingerprint(deps.db),
    next: ceiling.ready
      ? 'Save this JSON as before.json, then follow the runbook from step 3.'
      : 'STOP. Do not run the smoke. Report the ceiling gap exactly as printed above; do not configure a ceiling in order to get past this.',
  })
  return ceiling.ready ? 0 : 1
}

export function runSmokeCli(argv: string[], deps: SmokeCliDeps): number {
  const [cmd, ...args] = argv
  switch (cmd) {
    case 'preflight': {
      const workspace = (args[0] ?? '').trim()
      if (!workspace) {
        deps.err('usage: bots-smoke preflight <workspace> [bot]   — the workspace is explicit on purpose; there is no default')
        return 2
      }
      return preflight(deps, workspace, (args[1] ?? 'Operation Kit').trim())
    }
    case 'fingerprint':
      deps.out(preservationFingerprint(deps.db))
      return 0
    case 'diff': {
      if (!args[0] || !args[1]) {
        deps.err('usage: bots-smoke diff <before.json> <after.json>')
        return 2
      }
      const d = diffFingerprints(asFingerprint(deps.readJson(args[0])), asFingerprint(deps.readJson(args[1])))
      deps.out(d)
      return d.clean ? 0 : 1
    }
    case 'cleanup-plan': {
      const objectiveId = Number(args[0])
      const laneSlug = (args[1] ?? '').trim()
      const workspace = (args[2] ?? '').trim()
      if (!Number.isInteger(objectiveId) || !laneSlug || !workspace) {
        deps.err('usage: bots-smoke cleanup-plan <objective_id> <lane_slug> <workspace>')
        return 2
      }
      const plan = planSmokeCleanup(deps.db, { objectiveId, laneSlug, workspace })
      deps.out(plan)
      return plan.ok ? 0 : 1
    }
    default:
      deps.err(SMOKE_CLI_USAGE)
      return 2
  }
}
