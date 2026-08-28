#!/usr/bin/env tsx
/**
 * One-shot runner for the CI → objective feedback bridge (obj 701617).
 *
 * Runs a SINGLE polling pass over the target repo's open PRs and prints a per-PR
 * outcome table. Two uses:
 *   1. Ops / cron: run one pass on a schedule without the in-process 5-min timer.
 *   2. Demo / debug: `--force` bypasses the enable gate so you can prove the mechanism
 *      end-to-end even while settings.ci_feedback_bridge_enabled is still '0'.
 *
 * MUST run inside the command-center container (or with DB_PATH + localhost:3002 + a
 * `gh` that can read the repo) so it can reach the local internal API. Examples:
 *   docker exec command-center npx tsx /app/server/src/scripts/ci-feedback-bridge-run.ts
 *   docker exec command-center npx tsx /app/server/src/scripts/ci-feedback-bridge-run.ts --force
 *   ... --repo your-org/example-platform
 *
 * READ-ONLY against GitHub; the only writes are POSTs to the localhost message endpoint
 * (and only when enabled or --force). No secrets are read or printed.
 */
import { runCiFeedbackBridgeOnce } from '../services/ci-feedback-bridge.js'

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const force = argv.includes('--force')
  const repoFlag = argv.indexOf('--repo')
  const repo = repoFlag !== -1 ? argv[repoFlag + 1] : undefined

  console.log(`[ci-feedback-bridge-run] one-shot pass — repo=${repo || '(default)'} force=${force}`)
  const outcomes = await runCiFeedbackBridgeOnce({ force, repo })
  if (outcomes.length === 0) {
    console.log('  (no open PRs / nothing to do)')
  }
  for (const o of outcomes) {
    console.log(`  PR #${o.pr}  obj=${o.objectiveId ?? '-'}  → ${o.action}${o.detail ? ` (${o.detail})` : ''}`)
  }
  const nudged = outcomes.filter(o => o.action === 'nudged').length
  console.log(`[ci-feedback-bridge-run] done — ${nudged} nudge(s) sent`)
  process.exit(0)
}

main().catch(err => {
  console.error('[ci-feedback-bridge-run] fatal:', err)
  process.exit(1)
})
