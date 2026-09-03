#!/usr/bin/env node
// secrets-import-from-doppler.mjs — one-time Doppler → native secrets-store importer
// (obj-2353 / W3 migration).
//
// Reads the CURRENT Doppler secrets for the broadcast projects and writes them as
// `global`-scope rows into the native scoped secrets store (services/secrets-store.ts,
// `setSecret`), so the store can become the source of truth at cutover.
//
// WHAT THIS DOES NOT DO (by construction):
//   - It NEVER mutates Doppler state (read-only `doppler secrets --json`).
//   - It NEVER rotates, prints, or persists the admin/Doppler token.
//   - It NEVER flips USE_SCOPED_SECRETS (or any flag) and never restarts anything.
//   - It NEVER prints a secret VALUE — only KEY NAMES and counts.
//   - DEFAULT is a DRY-RUN: it prints what WOULD be imported and writes nothing.
//     Writing requires an explicit `--apply`.
//
// Usage:
//   # dry-run (default) — safe, no writes, no SECRETS_MASTER_KEY needed:
//   node scripts/secrets-import-from-doppler.mjs
//
//   # apply — actually upsert global rows into the store. Requires SECRETS_MASTER_KEY
//   # and must run under tsx (it imports the TypeScript service layer):
//   SECRETS_MASTER_KEY=... ./app/node_modules/.bin/tsx scripts/secrets-import-from-doppler.mjs --apply
//
// Auth for the `doppler` CLI: uses DOPPLER_TOKEN from the env if set, else the host
// admin-token file /home/operator/projects/.doppler-admin-token (same source the server
// uses). If neither is available (e.g. a sandbox), the dry-run prints a clear
// "DOPPLER_TOKEN not set / doppler unavailable" notice and exits 0 — that is OK.
//
// Idempotent: setSecret upserts (re-running bumps the version, never duplicates).

import { execFileSync } from 'child_process'
import fs from 'fs'

// Projects whose `prd` config feeds the broadcast secret set today.
const PROJECTS = ['example', 'command-center-infra']
const CONFIG = 'prd'
const ADMIN_TOKEN_PATH = '/home/operator/projects/.doppler-admin-token'

// ── Pure, testable transform ────────────────────────────────────────────────
//
// `doppler secrets --json` returns a map: { KEY: { computed, raw, note, ... } }.
// We import the COMPUTED (effective) value as a global secret. This function maps
// that JSON object to the ordered list of { key } entries we will import. It does
// NOT carry values out (the importer reads the value separately at write time),
// so it is safe to log/test. Doppler injects pseudo-vars like `DOPPLER_*` and
// `DOPPLER_CONFIG`/`DOPPLER_ENVIRONMENT`/`DOPPLER_PROJECT` — those are runtime
// metadata, not real secrets, so we exclude them.
export function dopplerJsonToImportList(json) {
  if (!json || typeof json !== 'object') return []
  return Object.keys(json)
    .filter((k) => !/^DOPPLER_/.test(k))
    .sort()
    .map((key) => ({ key }))
}

// ── Doppler read (read-only) ────────────────────────────────────────────────

function resolveDopplerToken() {
  if (process.env.DOPPLER_TOKEN && process.env.DOPPLER_TOKEN.trim()) {
    return process.env.DOPPLER_TOKEN.trim()
  }
  try {
    const t = fs.readFileSync(ADMIN_TOKEN_PATH, 'utf-8').trim()
    return t || null
  } catch {
    return null
  }
}

function readDopplerSecrets(project, token) {
  // Read-only. `--json` prints the computed map. Token passed via env so it never
  // lands on a command line / process list.
  const out = execFileSync(
    'doppler',
    ['--project', project, '--config', CONFIG, 'secrets', '--json'],
    { env: { ...process.env, DOPPLER_TOKEN: token }, encoding: 'utf-8' },
  )
  return JSON.parse(out)
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const apply = process.argv.includes('--apply')
  console.log(`[secrets-import] mode = ${apply ? 'APPLY (writing global rows)' : 'DRY-RUN (no writes)'}`)
  console.log(`[secrets-import] projects = ${PROJECTS.join(', ')} (config ${CONFIG})`)
  console.log('[secrets-import] this NEVER mutates Doppler, rotates tokens, flips flags, or prints values.\n')

  const token = resolveDopplerToken()
  if (!token) {
    console.log('[secrets-import] DOPPLER_TOKEN not set and no admin-token file readable —')
    console.log('[secrets-import] cannot read Doppler here (OK in a sandbox). Nothing to do.')
    return
  }

  if (apply && !process.env.SECRETS_MASTER_KEY) {
    console.error('[secrets-import] FATAL: --apply requires SECRETS_MASTER_KEY to be set (the store')
    console.error('[secrets-import] encrypts at rest under it). Aborting — nothing written.')
    process.exit(1)
  }

  // Lazily import the TS service ONLY on --apply (requires tsx). The dry-run must
  // run cleanly under plain `node`, so it never touches the TypeScript layer.
  let setSecret = null
  if (apply) {
    try {
      ;({ setSecret } = await import('../app/server/src/services/secrets-store.ts'))
    } catch (err) {
      console.error('[secrets-import] FATAL: could not load the secrets-store service.')
      console.error('[secrets-import] Run --apply under tsx, e.g.:')
      console.error('[secrets-import]   ./app/node_modules/.bin/tsx scripts/secrets-import-from-doppler.mjs --apply')
      console.error(`[secrets-import] underlying error: ${err.message}`)
      process.exit(1)
    }
  }

  let grandTotal = 0
  for (const project of PROJECTS) {
    let json
    try {
      json = readDopplerSecrets(project, token)
    } catch (err) {
      console.error(`[secrets-import] WARN: failed to read project '${project}': ${err.message}`)
      continue
    }
    const list = dopplerJsonToImportList(json)
    console.log(`[secrets-import] ${project}/${CONFIG}: ${list.length} secret(s) would be imported as global rows:`)
    for (const { key } of list) console.log(`    - ${key}`) // KEY NAMES ONLY
    grandTotal += list.length

    if (apply) {
      for (const { key } of list) {
        // Read the computed value for THIS key only at write time; never logged.
        const value = json[key]?.computed ?? json[key]?.raw ?? ''
        setSecret({ scope: { scopeType: 'global' }, key, value, actorUserId: null })
      }
      console.log(`[secrets-import] ${project}/${CONFIG}: wrote ${list.length} global row(s).`)
    }
    console.log('')
  }

  console.log(`[secrets-import] TOTAL keys ${apply ? 'imported' : 'that would be imported'}: ${grandTotal}`)
  if (!apply) console.log('[secrets-import] DRY-RUN only — re-run with --apply (under tsx) to write.')
}

// Only run when invoked directly (so the pure transform can be unit-tested).
const invokedDirectly = process.argv[1] && process.argv[1].endsWith('secrets-import-from-doppler.mjs')
if (invokedDirectly) {
  main().catch((err) => {
    console.error('[secrets-import] FATAL:', err.message)
    process.exit(1)
  })
}
