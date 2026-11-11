// ── dream-cycle 'retro' phase wiring (spec §D.4 test 17, risk D.6-3) ─────────
//
// Two things must hold and neither is provable by reading the phase body:
//   1. ORDER — retro runs after 'mining' and before 'cleanup'. cleanup DELETEs
//      session_events, which the D6 escalation detector reads; a reorder would
//      silently blind the detector with no error anywhere.
//   2. NON-FATAL — the phase is disabled by default and, when it throws, it
//      must not abort cleanup/index/health.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const TMP_DB = path.join(os.tmpdir(), `cc-dream-retro-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB
delete process.env.CC_DSR_ENABLED
delete process.env.CC_DSR_LIVE

const { initDb, getDb } = await import('../db/index.js')
const dc = await import('./dream-cycle.js')

beforeAll(() => {
  for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(TMP_DB + s) } catch { /* ignore */ } }
  initDb()
})
afterAll(() => {
  for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(TMP_DB + s) } catch { /* ignore */ } }
})

describe('phase order', () => {
  it('places retro strictly between mining and cleanup', () => {
    const phases = [...dc.DREAM_CYCLE_PHASES]
    expect(phases).toContain('retro')
    expect(phases.indexOf('retro')).toBeGreaterThan(phases.indexOf('mining'))
    expect(phases.indexOf('retro')).toBeLessThan(phases.indexOf('cleanup'))
  })

  it('keeps every pre-existing phase, in their original relative order', () => {
    const phases = [...dc.DREAM_CYCLE_PHASES]
    expect(phases.filter(p => p !== 'retro')).toEqual(['blockers', 'rollup', 'mining', 'cleanup', 'index', 'health'])
  })
})

describe('retro phase gating', () => {
  it('is a no-op while dsr_enabled=0 and never throws', async () => {
    expect(
      (getDb().prepare("SELECT value FROM settings WHERE key = 'dsr_enabled'").get() as { value: string }).value,
    ).toBe('0')
    const results = await dc.runDreamCycle('retro')
    expect(results).toHaveLength(1)
    expect(results[0].phase).toBe('retro')
    expect(results[0].results).toMatchObject({ skipped: 'disabled' })
    // Nothing written while disabled.
    expect((getDb().prepare('SELECT COUNT(*) n FROM dsr_runs').get() as { n: number }).n).toBe(0)
  })

  it('surfaces a retro failure as a phase result rather than throwing', async () => {
    // Arm the phase, then break the read it depends on so runDailyRetro throws.
    getDb().prepare("UPDATE settings SET value = '1' WHERE key = 'dsr_enabled'").run()
    getDb().exec('ALTER TABLE dsr_runs RENAME TO dsr_runs_hidden')
    try {
      const results = await dc.runDreamCycle('retro')
      expect(results[0].results).toHaveProperty('error')
    } finally {
      getDb().exec('ALTER TABLE dsr_runs_hidden RENAME TO dsr_runs')
      getDb().prepare("UPDATE settings SET value = '0' WHERE key = 'dsr_enabled'").run()
    }
  })
})
