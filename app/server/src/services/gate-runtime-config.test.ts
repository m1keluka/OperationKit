import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  loadGateConfig,
  clearGateConfigCache,
  getEffectiveGateMode,
  buildVisionRubricBlock,
  isUiObjective,
} from './design-context.js'
import type { Objective } from '@operationkit/shared'

// ── Fixtures ────────────────────────────────────────────────────────────────
// A unique scratch path for the runtime gate file, pointed at via UI_GATE_FILE so
// these tests NEVER read or write the real /home/operator/projects/.ui-gate.json.
const GATE_FILE = path.join(os.tmpdir(), `ui-gate-test-${process.pid}.json`)

const WS_KEY = 'example-project-platform' // a registered frontend repo in .design-registry.json

function obj(partial: Partial<Objective>): Objective {
  return {
    id: 1,
    title: 't',
    type: 'task',
    workspace: 'operator',
    project: null,
    acceptance_criteria: null,
    ...partial,
  } as Objective
}

const wsObjective = obj({ project: WS_KEY })
const nonWsObjective = obj({ project: 'example-platform' }) // registered, but NOT example-project

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
  vi.useRealTimers()
  delete process.env.UI_GATE_MODE
  delete process.env.UI_GATE_FILE
  removeGate()
  clearGateConfigCache()
})

// ── (a) Dormancy: file absent + env unset ⇒ off ───────────────────────────────
describe('(a) dormancy: no file + no env ⇒ off', () => {
  it('loadGateConfig falls back to off with an empty allowlist', () => {
    expect(loadGateConfig()).toEqual({ mode: 'off', platforms: [] })
  })
  it('getEffectiveGateMode is off for every project', () => {
    expect(getEffectiveGateMode(WS_KEY)).toBe('off')
    expect(getEffectiveGateMode('anything')).toBe('off')
    expect(getEffectiveGateMode(null)).toBe('off')
  })
  it('reviewer rubric block is empty (byte-identical to Wave A) for an in-scope-looking UI objective', () => {
    expect(buildVisionRubricBlock(wsObjective, getEffectiveGateMode(wsObjective.project), true)).toBe('')
  })
})

// ── (b) Per-platform scoping ──────────────────────────────────────────────────
describe('(b) per-platform allowlist scopes the mode', () => {
  it('advisory on [example-project] ⇒ advisory for WS, off for a non-WS project', () => {
    writeGate(JSON.stringify({ mode: 'advisory', platforms: [WS_KEY] }))
    clearGateConfigCache()
    expect(getEffectiveGateMode(WS_KEY)).toBe('advisory')
    expect(getEffectiveGateMode('example-platform')).toBe('off')
    expect(getEffectiveGateMode(null)).toBe('off')
  })
  it('empty/absent allowlist ⇒ mode applies globally', () => {
    writeGate(JSON.stringify({ mode: 'soft' }))
    clearGateConfigCache()
    expect(getEffectiveGateMode(WS_KEY)).toBe('soft')
    expect(getEffectiveGateMode('example-platform')).toBe('soft')
  })
  it('mode:off in the file ⇒ off even if the project is listed', () => {
    writeGate(JSON.stringify({ mode: 'off', platforms: [WS_KEY] }))
    clearGateConfigCache()
    expect(getEffectiveGateMode(WS_KEY)).toBe('off')
  })
})

// ── (c) advisory NEVER bounces, even for an in-scope WS objective ─────────────
describe('(c) advisory never yields an enforcing/bouncing verdict', () => {
  it('in-scope WS objective at file-advisory grades but does not enforce', () => {
    writeGate(JSON.stringify({ mode: 'advisory', platforms: [WS_KEY] }))
    clearGateConfigCache()
    const mode = getEffectiveGateMode(wsObjective.project)
    expect(mode).toBe('advisory')
    expect(isUiObjective(wsObjective)).toBe(true)
    // Even as a delegator→worker task (the case that soft/hard would enforce),
    // advisory must stay advisory — the verdict math must not be injected.
    const block = buildVisionRubricBlock(wsObjective, mode, /* isDelegatorWorker */ true)
    expect(block).toContain('MANDATORY UI/UX RUBRIC')
    expect(block).toContain('VERDICT IMPACT — ADVISORY')
    expect(block).not.toContain('VERDICT IMPACT — ENFORCED')
  })
})

// ── (d) env fallback still works when the file is absent ──────────────────────
describe('(d) env UI_GATE_MODE fallback (file absent)', () => {
  it('env=advisory ⇒ advisory globally (no allowlist from env)', () => {
    removeGate()
    process.env.UI_GATE_MODE = 'advisory'
    clearGateConfigCache()
    expect(loadGateConfig()).toEqual({ mode: 'advisory', platforms: [] })
    expect(getEffectiveGateMode(WS_KEY)).toBe('advisory')
    expect(getEffectiveGateMode('example-platform')).toBe('advisory')
  })
  it('env=hard ⇒ hard', () => {
    removeGate()
    process.env.UI_GATE_MODE = 'hard'
    clearGateConfigCache()
    expect(getEffectiveGateMode('anything')).toBe('hard')
  })
  it('malformed file ⇒ falls back to env', () => {
    writeGate('{ not valid json')
    process.env.UI_GATE_MODE = 'soft'
    clearGateConfigCache()
    expect(getEffectiveGateMode('anything')).toBe('soft')
  })
  it('file with an unrecognized mode ⇒ falls back to env', () => {
    writeGate(JSON.stringify({ mode: 'enabled', platforms: [WS_KEY] }))
    process.env.UI_GATE_MODE = 'advisory'
    clearGateConfigCache()
    // env has no allowlist ⇒ advisory applies globally; the bad file is ignored.
    expect(getEffectiveGateMode('example-platform')).toBe('advisory')
  })
  it('file with a non-array platforms ⇒ invalid ⇒ env fallback', () => {
    writeGate(JSON.stringify({ mode: 'advisory', platforms: 'example-project-platform' }))
    process.env.UI_GATE_MODE = 'hard'
    clearGateConfigCache()
    expect(getEffectiveGateMode(WS_KEY)).toBe('hard')
  })
})

// ── (e) a live file change is picked up after the TTL, no restart ─────────────
describe('(e) TTL: a file edit is picked up at runtime without a restart', () => {
  it('serves the cached value within the TTL, then re-reads after it expires', () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    writeGate(JSON.stringify({ mode: 'advisory', platforms: [WS_KEY] }))
    clearGateConfigCache()
    expect(getEffectiveGateMode(WS_KEY)).toBe('advisory') // reads + caches at t=0

    // Operator edits the file live (no process restart).
    writeGate(JSON.stringify({ mode: 'hard', platforms: [WS_KEY] }))
    // Within the 5s TTL the cached value is still served — fs not re-hit.
    vi.advanceTimersByTime(4000)
    expect(getEffectiveGateMode(WS_KEY)).toBe('advisory')

    // Past the TTL the next read picks up the edit — no restart, no manual clear.
    vi.advanceTimersByTime(2000) // total 6s > 5s TTL
    expect(getEffectiveGateMode(WS_KEY)).toBe('hard')
  })

  it('clearGateConfigCache forces an immediate re-read (test/ops seam)', () => {
    writeGate(JSON.stringify({ mode: 'advisory' }))
    clearGateConfigCache()
    expect(getEffectiveGateMode('x')).toBe('advisory')
    writeGate(JSON.stringify({ mode: 'soft' }))
    clearGateConfigCache()
    expect(getEffectiveGateMode('x')).toBe('soft')
  })
})
