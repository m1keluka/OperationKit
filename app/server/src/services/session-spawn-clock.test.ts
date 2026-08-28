import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import os from 'os'
import path from 'path'
import fs from 'fs'
import Database from 'better-sqlite3'
import {
  ensureSessionSpawnTable,
  recordSessionSpawn,
  getPersistedSpawnStart,
  clearSessionSpawn,
  resolveSpawnStartMs,
} from './session-spawn-clock.js'
import { watchdogDecision } from './state-poller.js'

// Regression cover for obj 705463 / P2: the WATCHDOG force-routed freshly-resumed
// sessions after a server restart because the in-memory spawn map was gone and the
// wall clock fell back to the transcript file's birthtime (the FIRST-ever spawn).
const TMP_DB = path.join(os.tmpdir(), `cc-spawn-clock-${process.pid}-${Date.now()}.db`)
let db: Database.Database

beforeEach(() => {
  db?.close()
  try { fs.unlinkSync(TMP_DB) } catch { /* first run */ }
  db = new Database(TMP_DB)
  ensureSessionSpawnTable(db)
})

afterAll(() => {
  try { db?.close() } catch { /* ignore */ }
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(TMP_DB + suffix) } catch { /* ignore */ }
  }
})

describe('session_spawns durable clock', () => {
  it('round-trips a recorded spawn start', () => {
    recordSessionSpawn(db, 'cc-705463-abc', 1_700_000_000_000)
    expect(getPersistedSpawnStart(db, 'cc-705463-abc')).toBe(1_700_000_000_000)
  })

  it('returns null for a session it has never seen', () => {
    expect(getPersistedSpawnStart(db, 'cc-unknown')).toBeNull()
  })

  it('OVERWRITES on re-spawn so a resumed turn gets a fresh clock', () => {
    recordSessionSpawn(db, 'cc-705463-abc', 1_700_000_000_000)
    recordSessionSpawn(db, 'cc-705463-abc', 1_700_000_500_000)
    expect(getPersistedSpawnStart(db, 'cc-705463-abc')).toBe(1_700_000_500_000)
  })

  it('clears the row on stop/death', () => {
    recordSessionSpawn(db, 'cc-705463-abc', 1_700_000_000_000)
    clearSessionSpawn(db, 'cc-705463-abc')
    expect(getPersistedSpawnStart(db, 'cc-705463-abc')).toBeNull()
  })
})

describe('resolveSpawnStartMs precedence', () => {
  it('prefers the in-memory spawn start over everything else', () => {
    expect(resolveSpawnStartMs({ inMemoryMs: 300, persistedMs: 200, birthtimeMs: 100 })).toBe(300)
  })

  it('falls back to the PERSISTED start when the in-memory map was wiped by a restart', () => {
    expect(resolveSpawnStartMs({ inMemoryMs: null, persistedMs: 200, birthtimeMs: 100 })).toBe(200)
  })

  it('only reaches the transcript birthtime when nothing else is known', () => {
    expect(resolveSpawnStartMs({ inMemoryMs: null, persistedMs: null, birthtimeMs: 100 })).toBe(100)
  })

  it('returns null when nothing is known at all', () => {
    expect(resolveSpawnStartMs({ inMemoryMs: null, persistedMs: null, birthtimeMs: null })).toBeNull()
  })
})

describe('watchdog does not force-route a freshly-resumed session after a restart', () => {
  const WALL_CLOCK_LIMIT_MS = 8 * 60 * 60_000  // production budget
  const IDLE_FORCE_MS = 90 * 60_000
  const now = 1_700_000_000_000
  // obj 702774's shape: transcript file first created ~21 days ago (appended across
  // every resume), current spawn started 35 s ago after a server restart.
  const birthtimeMs = now - 21 * 24 * 60 * 60_000
  const currentSpawnMs = now - 35_000

  it('routes on the stale birthtime alone (the bug being fixed)', () => {
    const startMs = resolveSpawnStartMs({ inMemoryMs: null, persistedMs: null, birthtimeMs })!
    const d = watchdogDecision({
      idleMs: 5_000,
      wallClockMs: now - startMs,
      idleForceMs: IDLE_FORCE_MS,
      wallClockLimitMs: WALL_CLOCK_LIMIT_MS,
    })
    expect(d.forceRoute).toBe(true)
    expect(d.reason).toBe('wall-clock')
  })

  it('does NOT route once the durable spawn clock rehydrates the current spawn', () => {
    recordSessionSpawn(db, 'cc-702774-resumed', currentSpawnMs)
    const startMs = resolveSpawnStartMs({
      inMemoryMs: null,                                        // wiped by the restart
      persistedMs: getPersistedSpawnStart(db, 'cc-702774-resumed'),
      birthtimeMs,                                             // 21 days old, must be ignored
    })!
    expect(startMs).toBe(currentSpawnMs)
    const d = watchdogDecision({
      idleMs: 5_000,
      wallClockMs: now - startMs,
      idleForceMs: IDLE_FORCE_MS,
      wallClockLimitMs: WALL_CLOCK_LIMIT_MS,
    })
    expect(d.forceRoute).toBe(false)
  })

  it('STILL routes a genuinely long-running current spawn (guard not defeated)', () => {
    recordSessionSpawn(db, 'cc-runaway', now - 9 * 60 * 60_000)
    const startMs = resolveSpawnStartMs({
      inMemoryMs: null,
      persistedMs: getPersistedSpawnStart(db, 'cc-runaway'),
      birthtimeMs,
    })!
    const d = watchdogDecision({
      idleMs: 5_000,
      wallClockMs: now - startMs,
      idleForceMs: IDLE_FORCE_MS,
      wallClockLimitMs: WALL_CLOCK_LIMIT_MS,
    })
    expect(d.forceRoute).toBe(true)
    expect(d.reason).toBe('wall-clock')
  })
})
