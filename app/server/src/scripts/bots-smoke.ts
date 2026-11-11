#!/usr/bin/env tsx
/**
 * CLI for the live-install bounded Bots job smoke (obj 900366).
 *
 * The procedure is `docs/bots/live-install-job-smoke-runbook.md`. All of the
 * behaviour lives in `services/bots/bots-smoke-cli.ts` so it can be tested
 * without this file's `db/index.js` import (which transitively needs the
 * node-pty native module); this is wiring only.
 *
 * Every subcommand is READ-ONLY against the database. Nothing here cancels a
 * job, deletes a row or removes a file — `cleanup-plan` PRINTS the steps and a
 * person runs them through the product. That is deliberate: a mutating helper
 * pointed at a live install is the hazard the runbook exists to avoid.
 *
 *   docker exec command-center tsx /app/server/src/scripts/bots-smoke.ts preflight operationkit
 */
import fs from 'fs'
import { getDb, initDb } from '../db/index.js'
import { agentsDir, loadChatAgents } from '../services/agent-chat/agent-defs.js'
import { occupiedLaneSlugs } from '../services/bots/bots-smoke.js'
import { runSmokeCli } from '../services/bots/bots-smoke-cli.js'

initDb()

const exitCode = runSmokeCli(process.argv.slice(2), {
  db: getDb(),
  occupiedSlugs: () => {
    const dir = agentsDir()
    if (!fs.existsSync(dir)) {
      // An absent agents dir must not read as "every slug is free".
      throw new Error(`No chat-agents directory at ${dir}, so no slug can be shown to be free. Set AGENT_FILES_DIR before running the smoke.`)
    }
    const loaded = loadChatAgents({ includeDemo: true })
    // A folder that FAILED to parse still occupies its slug.
    return occupiedLaneSlugs(getDb(), [...loaded.agents.map(a => a.slug), ...loaded.problems.map(p => p.slug)])
  },
  readJson: path => JSON.parse(fs.readFileSync(path, 'utf8')) as unknown,
  out: value => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`),
  err: line => console.error(line),
})

process.exit(exitCode)
