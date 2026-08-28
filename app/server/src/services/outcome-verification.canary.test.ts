// ── Outcome verification — DIFFERENTIAL CANARY PROOF (executed) — obj 700028 ──
//
// The load-bearing acceptance proof: the SAME outcome assertion, run for real via
// execRunner through evaluateOutcomeGate, must
//   • BLOCK when the command runs successfully but the asserted state did NOT
//     change (the broken-outcome canary — "I claimed success, produced nothing"), and
//   • PROCEED when the real outcome exists.
// Both worked examples (data/state-delta and content/published-artifact) are
// exercised against real on-disk state created per-test in an OS temp dir — no
// fakes, no network, CI-safe (node only).
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import {
  evaluateOutcomeGate,
  runFloor,
  execRunner,
  type OutcomeAssertionConfig,
  type FloorConfig,
} from './deterministic-floor.js'

const FIXTURE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../fixtures/outcome')
const DATA_ASSERT = path.join(FIXTURE_ROOT, 'data-state-delta', 'assert-rowcount.mjs')
const CONTENT_ASSERT = path.join(FIXTURE_ROOT, 'content-artifact', 'assert-published.mjs')

let workdir: string
beforeEach(() => {
  workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-canary-'))
  fs.mkdirSync(path.join(workdir, 'data'), { recursive: true })
  fs.mkdirSync(path.join(workdir, 'published'), { recursive: true })
})
afterEach(() => {
  try { fs.rmSync(workdir, { recursive: true, force: true }) } catch { /* best-effort */ }
})

// Run the gate for real (execRunner) with the assertion `command`, cwd = workdir.
function gate(command: string) {
  const cfg: OutcomeAssertionConfig = { command, cwd: workdir, source: 'objective' }
  return evaluateOutcomeGate({
    getConfig: () => cfg,
    resolveFallbackCwd: () => { throw new Error('explicit cwd should win') },
    run: (c: FloorConfig, cwd: string) => runFloor(c, cwd, execRunner),
    record: () => {},
    logMilestone: () => {},
  })
}

describe('DATA / state-delta — broken outcome is CAUGHT, real outcome PASSES', () => {
  const cmd = `OUTCOME_MIN_ROWS=3 node ${JSON.stringify(DATA_ASSERT)}`

  it('BROKEN: assertion runs but the rows never materialized (empty array) → BLOCK', () => {
    fs.writeFileSync(path.join(workdir, 'data', 'records.json'), '[]')
    const d = gate(cmd)
    expect(d.action).toBe('block')
    if (d.action === 'block') expect(d.run.failingOutput).toContain('OUTCOME FAIL')
  })

  it('BROKEN: the data file was never even produced → BLOCK (not a wedge — clean exit 1)', () => {
    const d = gate(cmd)
    expect(d.action).toBe('block')
  })

  it('REAL: the rows exist (≥3) → PROCEED(green)', () => {
    fs.writeFileSync(path.join(workdir, 'data', 'records.json'), JSON.stringify([{ a: 1 }, { a: 2 }, { a: 3 }]))
    const d = gate(cmd)
    expect(d.action).toBe('proceed')
    expect(d.action === 'proceed' && d.reason).toBe('green')
  })
})

describe('CONTENT / published-artifact — broken outcome is CAUGHT, real outcome PASSES', () => {
  const cmd = `node ${JSON.stringify(CONTENT_ASSERT)}`

  it('BROKEN: nothing published (file absent) → BLOCK', () => {
    const d = gate(cmd)
    expect(d.action).toBe('block')
    if (d.action === 'block') expect(d.run.failingOutput).toContain('not found')
  })

  it('BROKEN: only an empty stub was written (state "changed" but is trivial) → BLOCK', () => {
    fs.writeFileSync(path.join(workdir, 'published', 'report.md'), '# x')
    const d = gate(cmd)
    expect(d.action).toBe('block')
    if (d.action === 'block') expect(d.run.failingOutput).toContain('stub')
  })

  it('REAL: a non-trivial article with the headline marker → PROCEED(green)', () => {
    fs.writeFileSync(path.join(workdir, 'published', 'report.md'), `# Real Headline\n\n${'body '.repeat(80)}\n`)
    const d = gate(cmd)
    expect(d.action).toBe('proceed')
    expect(d.action === 'proceed' && d.reason).toBe('green')
  })
})
