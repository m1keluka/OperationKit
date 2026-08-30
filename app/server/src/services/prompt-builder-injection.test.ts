import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { buildDelegatorBlock } from './prompt-builder.js'
import { clearGateConfigCache } from './design-context.js'
import type { Objective } from '@operationkit/shared'

// ─────────────────────────────────────────────────────────────────────────────
// Spawn-prompt injection on the FILE control-plane (obj 1117).
//
// `buildDelegatorBlock` is a pure, DB-free string builder, so it gives a byte-level
// proof of the prompt-builder.ts:285 gate: the delegator "REQUIRED (UI): … ds-conformance
// acceptance criteria" instruction line is appended IFF `isUiInjectionActive(objective)` —
// i.e. the file-backed, per-platform gate resolves this objective's project to a non-'off'
// mode. With the gate dormant the delegator block must be byte-identical to pre-activation.
//
// UI_GATE_FILE is pointed at a scratch file so these tests NEVER touch the real
// /home/operator/projects/.ui-gate.json.
// ─────────────────────────────────────────────────────────────────────────────

const GATE_FILE = path.join(os.tmpdir(), `ui-gate-pb-injection-test-${process.pid}.json`)
// The line obj 1117 turns on at spawn (a stable, unique substring of the ds-criteria instruction).
const DS_LINE = 'REQUIRED (UI): if a worker targets a registered frontend repo'
const PLATFORMS = ['command-center-infra', 'example-project-platform', 'example-platform', 'example3-platform']

function obj(partial: Partial<Objective>): Objective {
  return {
    id: 42,
    title: 'Delegate UI work',
    type: 'objective',
    workspace: 'personal',
    project: 'example-project-platform',
    agent_context: 'cto',
    delegate_mode: 1,
    acceptance_criteria: null,
    ...partial,
  } as Objective
}

function writeGate(contents: string) {
  fs.writeFileSync(GATE_FILE, contents)
}
function removeGate() {
  try { fs.unlinkSync(GATE_FILE) } catch { /* already gone */ }
}

beforeEach(() => {
  delete process.env.UI_GATE_MODE
  process.env.UI_GATE_FILE = GATE_FILE
  removeGate()
  clearGateConfigCache()
})
afterEach(() => {
  delete process.env.UI_GATE_MODE
  delete process.env.UI_GATE_FILE
  removeGate()
  clearGateConfigCache()
})

describe('buildDelegatorBlock — ds-criteria line rides the file control-plane (obj 1117)', () => {
  it('dormant when off (no file + no env): the ds-criteria line is ABSENT (byte-identical)', () => {
    const dormant = buildDelegatorBlock(obj({ project: 'example-project-platform' })).join('\n')
    expect(dormant).not.toContain(DS_LINE)

    // Explicit mode:off with platforms listed is equally dormant.
    writeGate(JSON.stringify({ mode: 'off', platforms: PLATFORMS }))
    clearGateConfigCache()
    expect(buildDelegatorBlock(obj({ project: 'example-project-platform' })).join('\n')).not.toContain(DS_LINE)
  })

  it('advisory GLOBAL: the ds-criteria line is PRESENT for a delegator on each platform', () => {
    writeGate(JSON.stringify({ mode: 'advisory' }))
    clearGateConfigCache()
    for (const p of PLATFORMS) {
      expect(buildDelegatorBlock(obj({ project: p })).join('\n')).toContain(DS_LINE)
    }
  })

  it('advisory + four-platform allowlist: PRESENT for each listed platform', () => {
    writeGate(JSON.stringify({ mode: 'advisory', platforms: PLATFORMS }))
    clearGateConfigCache()
    for (const p of PLATFORMS) {
      expect(buildDelegatorBlock(obj({ project: p })).join('\n')).toContain(DS_LINE)
    }
  })

  it('a platform EXCLUDED from a non-empty allowlist: ABSENT (byte-identical)', () => {
    writeGate(JSON.stringify({ mode: 'advisory', platforms: ['example-project-platform'] }))
    clearGateConfigCache()
    // In-scope ⇒ present.
    expect(buildDelegatorBlock(obj({ project: 'example-project-platform' })).join('\n')).toContain(DS_LINE)
    // Out-of-scope ⇒ absent, and byte-identical to the dormant block.
    const dormantOff = (() => { removeGate(); clearGateConfigCache(); return buildDelegatorBlock(obj({ project: 'example-platform' })).join('\n') })()
    writeGate(JSON.stringify({ mode: 'advisory', platforms: ['example-project-platform'] }))
    clearGateConfigCache()
    const excluded = buildDelegatorBlock(obj({ project: 'example-platform' })).join('\n')
    expect(excluded).not.toContain(DS_LINE)
    expect(excluded).toBe(dormantOff)
  })
})
