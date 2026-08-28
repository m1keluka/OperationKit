// OUTCOME ASSERTION (example #1 — DATA / state-delta) — obj 700028
//
// A data/research/scrape objective claims "I loaded N records." The summary can
// say anything; THIS asserts the real state. It reads a data file (a JSON array —
// stand-in for a DB row-count export / a Supabase count(*) / an API list) relative
// to the gate's cwd and exits non-zero unless the array has at least MIN_ROWS rows.
//
// This is the deterministic equivalent of the code floor's layer-4 state-delta,
// generalized to a non-code objective: the worker cannot fake "the rows exist" —
// the rows either exist in the asserted artifact or they don't.
//
//   Env (all optional, with defaults):
//     OUTCOME_DATA      path to the JSON array, relative to cwd   (default data/records.json)
//     OUTCOME_MIN_ROWS  minimum acceptable row count               (default 1)
//
//   Exit 0  → the asserted state exists (≥ MIN_ROWS rows).         → gate PASS
//   Exit 1  → the state did NOT materialize (missing/short/empty). → gate BLOCK
//   (Any thrown infra error surfaces as a non-zero exit; the gate's runner maps
//    spawn/timeout/127/126 to fail-safe-OPEN, never a wedge.)
import fs from 'fs'
import path from 'path'

const dataPath = process.env.OUTCOME_DATA || 'data/records.json'
const minRows = Number(process.env.OUTCOME_MIN_ROWS || '1')
const abs = path.resolve(process.cwd(), dataPath)

let rows
try {
  rows = JSON.parse(fs.readFileSync(abs, 'utf-8'))
} catch (err) {
  console.error(`OUTCOME FAIL: could not read/parse data file at ${abs}: ${err.message}`)
  console.error('The asserted records were never produced — the outcome did not happen.')
  process.exit(1)
}

const count = Array.isArray(rows) ? rows.length : -1
if (count < minRows) {
  console.error(
    `OUTCOME FAIL: expected ≥ ${minRows} record(s) in ${dataPath}, found ${count}. ` +
      `The data delta did not occur — the success claim is unbacked.`,
  )
  process.exit(1)
}
console.log(`outcome ok: ${count} record(s) present in ${dataPath} (≥ ${minRows} required)`)
