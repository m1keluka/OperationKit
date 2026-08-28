// Durable Fable→Opus fallback attribution (audit 2026-07-04, recs #1 & #3).
//
// scanStreamTelemetry must (a) detect a fallback from a PER-TURN assistant event
// even when the final `result` event still reports the originally-requested
// model (mid-stream fallback the old result-only check missed), and (b) persist a
// durable marker — objectives.ran_on_fallback = 1 + an activity_log row — so the
// attribution survives a process restart. It must de-dupe on that persisted
// marker (no duplicate activity_log rows across repeat scans).

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const TMP_DB = path.join(os.tmpdir(), `cc-fallback-attr-test-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB

const { initDb, getDb } = await import('../db/index.js')
const { scanStreamTelemetry } = await import('./session-manager.js')
const { analyzeStreamAttribution, detectMainLoopFallback, mergeRanModel, FALLBACK_MODEL_ID } = await import('./model-attribution.js')

const scratch: string[] = []
function tmpFile(name: string, content: string): string {
  const p = path.join(os.tmpdir(), `cc-fallback-attr-${process.pid}-${Date.now()}-${name}`)
  fs.writeFileSync(p, content)
  scratch.push(p)
  return p
}

beforeAll(() => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
})

afterAll(() => {
  try { getDb().close() } catch {/* ignore */}
  for (const suffix of ['', '-wal', '-shm']) {
    const f = `${TMP_DB}${suffix}`
    if (fs.existsSync(f)) fs.unlinkSync(f)
  }
  for (const f of scratch) { if (fs.existsSync(f)) fs.unlinkSync(f) }
})

function seedObjective(model: string): number {
  const r = getDb().prepare(
    `INSERT INTO objectives (title, agent_context, status, model)
     VALUES ('fable worker', 'cto', 'working', ?)`
  ).run(model)
  return r.lastInsertRowid as number
}

describe('scanStreamTelemetry — durable fallback attribution', () => {
  it('the migration added the nullable ran_on_fallback marker columns to objectives', () => {
    const cols = new Set(
      (getDb().prepare('PRAGMA table_info(objectives)').all() as { name: string }[]).map(c => c.name)
    )
    expect(cols.has('ran_on_fallback')).toBe(true)
    expect(cols.has('fallback_detected_at')).toBe(true)
  })

  it('detects a MID-STREAM fallback via a per-turn assistant model even when the result reports the requested model, and persists the marker', () => {
    const objId = seedObjective('claude-fable-5')
    // Assistant turn ran on the fallback; final result still names Fable —
    // the old result-only check would have missed this.
    const jsonl = tmpFile(`${objId}.jsonl`, [
      JSON.stringify({ type: 'assistant', message: { model: FALLBACK_MODEL_ID } }),
      JSON.stringify({ type: 'result', model: 'claude-fable-5', modelUsage: { 'claude-fable-5': {} } }),
    ].join('\n') + '\n')
    const log = tmpFile(`${objId}.log`, '')

    scanStreamTelemetry('cc-test-1', jsonl, log, 'claude-fable-5', objId)

    const row = getDb().prepare('SELECT ran_on_fallback, fallback_detected_at FROM objectives WHERE id = ?')
      .get(objId) as { ran_on_fallback: number; fallback_detected_at: string | null }
    expect(row.ran_on_fallback).toBe(1)
    expect(row.fallback_detected_at).toBeTruthy()

    const act = getDb().prepare(
      "SELECT event_type, title, detail FROM activity_log WHERE objective_id = ? AND title = 'ran_on_fallback'"
    ).all(objId) as { event_type: string; title: string; detail: string }[]
    expect(act.length).toBe(1)
    expect(act[0].detail).toContain('claude-fable-5')
    expect(act[0].detail).toContain(FALLBACK_MODEL_ID)
  })

  it('de-dupes on the PERSISTED marker — a repeat scan does not add a second activity_log row', () => {
    const objId = seedObjective('claude-fable-5')
    const jsonl = tmpFile(`${objId}-b.jsonl`, JSON.stringify({ type: 'result', model: FALLBACK_MODEL_ID }) + '\n')
    const log = tmpFile(`${objId}-b.log`, '')

    // Two scans of the same session (simulates a re-scan / restart).
    scanStreamTelemetry('cc-test-2', jsonl, log, 'claude-fable-5', objId)
    scanStreamTelemetry('cc-test-2', jsonl, log, 'claude-fable-5', objId)

    const count = (getDb().prepare(
      "SELECT COUNT(*) AS n FROM activity_log WHERE objective_id = ? AND title = 'ran_on_fallback'"
    ).get(objId) as { n: number }).n
    expect(count).toBe(1)
  })

  it('does NOT flag when the requested model IS the fallback or when no fallback occurred', () => {
    // Requested = fallback → never flag.
    const fbObj = seedObjective(FALLBACK_MODEL_ID)
    const jsonlFb = tmpFile(`${fbObj}.jsonl`, JSON.stringify({ type: 'result', model: FALLBACK_MODEL_ID }) + '\n')
    scanStreamTelemetry('cc-test-3', jsonlFb, tmpFile(`${fbObj}.log`, ''), FALLBACK_MODEL_ID, fbObj)
    expect((getDb().prepare('SELECT ran_on_fallback FROM objectives WHERE id = ?').get(fbObj) as { ran_on_fallback: number }).ran_on_fallback).toBe(0)

    // Fable requested, Fable ran → no fallback, no flag.
    const fableObj = seedObjective('claude-fable-5')
    const jsonlFable = tmpFile(`${fableObj}.jsonl`, JSON.stringify({ type: 'result', model: 'claude-fable-5', modelUsage: { 'claude-fable-5': {} } }) + '\n')
    scanStreamTelemetry('cc-test-4', jsonlFable, tmpFile(`${fableObj}.log`, ''), 'claude-fable-5', fableObj)
    expect((getDb().prepare('SELECT ran_on_fallback FROM objectives WHERE id = ?').get(fableObj) as { ran_on_fallback: number }).ran_on_fallback).toBe(0)
  })
})

// ── Hardened main-loop attribution (obj 701053) ──
// A Fable objective legitimately spends Opus via sub-agents (sidechain events),
// helper models (haiku), and the rolled-up result.modelUsage map. None of those
// may flag ran_on_fallback; only the objective's OWN main-loop turns count.
// Fixture shapes mirror real transcripts (verified on cc-700913-1783349048324,
// which contains an explicit {type:'fallback', from, to} content block).

describe('scanStreamTelemetry — hardened main-loop attribution (obj 701053)', () => {
  it('does NOT flag when Opus appears only in sub-agent events and the modelUsage rollup; persists positive ran_model', () => {
    const objId = seedObjective('claude-fable-5')
    const jsonl = tmpFile(`${objId}-mainloop.jsonl`, [
      // main loop: pure Fable
      JSON.stringify({ type: 'assistant', parent_tool_use_id: null, message: { model: 'claude-fable-5', content: [{ type: 'text', text: 'hi' }] } }),
      JSON.stringify({ type: 'assistant', parent_tool_use_id: null, message: { model: 'claude-fable-5', content: [{ type: 'tool_use', name: 'Agent' }] } }),
      // sub-agent (worktree Agent-tool) turns on Opus — sidechain, must be ignored
      JSON.stringify({ type: 'assistant', parent_tool_use_id: 'toolu_01x', message: { model: 'claude-opus-4-8', content: [{ type: 'text', text: 'sub' }] } }),
      JSON.stringify({ type: 'assistant', isSidechain: true, message: { model: 'claude-opus-4-8', content: [{ type: 'text', text: 'sub2' }] } }),
      // rolled-up usage includes Opus + the haiku helper — presence alone must not flag
      JSON.stringify({ type: 'result', model: 'claude-fable-5', modelUsage: { 'claude-fable-5': {}, 'claude-opus-4-8': {}, 'claude-haiku-4-5-20251001': {} } }),
    ].join('\n') + '\n')

    scanStreamTelemetry('cc-test-h1', jsonl, tmpFile(`${objId}-mainloop.log`, ''), 'claude-fable-5', objId)

    const row = getDb().prepare('SELECT ran_on_fallback, ran_model FROM objectives WHERE id = ?')
      .get(objId) as { ran_on_fallback: number; ran_model: string | null }
    expect(row.ran_on_fallback).toBe(0)
    expect(row.ran_model).toBe('claude-fable-5')
    // no fallback warning event was appended to the stream
    expect(fs.readFileSync(jsonl, 'utf-8')).not.toContain('fallback model used')
  })

  it('STILL flags a genuine main-loop fallback (explicit fallback block + Opus main-loop turns)', () => {
    const objId = seedObjective('claude-fable-5')
    const jsonl = tmpFile(`${objId}-genuine.jsonl`, [
      JSON.stringify({ type: 'assistant', parent_tool_use_id: null, message: { model: 'claude-fable-5', content: [{ type: 'text', text: 'start' }] } }),
      // real CLI shape on a mid-run rate-limit switch (from cc-700913 session 1)
      JSON.stringify({ type: 'assistant', parent_tool_use_id: null, message: { model: FALLBACK_MODEL_ID, content: [{ type: 'fallback', from: { model: 'claude-fable-5' }, to: { model: FALLBACK_MODEL_ID } }] } }),
      JSON.stringify({ type: 'assistant', parent_tool_use_id: null, message: { model: FALLBACK_MODEL_ID, content: [{ type: 'text', text: 'continuing on fallback' }] } }),
      JSON.stringify({ type: 'result', modelUsage: { 'claude-fable-5': {}, [FALLBACK_MODEL_ID]: {} } }),
    ].join('\n') + '\n')

    scanStreamTelemetry('cc-test-h2', jsonl, tmpFile(`${objId}-genuine.log`, ''), 'claude-fable-5', objId)

    const row = getDb().prepare('SELECT ran_on_fallback, ran_model FROM objectives WHERE id = ?')
      .get(objId) as { ran_on_fallback: number; ran_model: string | null }
    expect(row.ran_on_fallback).toBe(1)
    // mixed run: both models are attributed, most main-loop turns first
    expect(row.ran_model).toBe(`${FALLBACK_MODEL_ID},claude-fable-5`)
  })

  it('still emits the refusal warning (stop_reason=refusal), unchanged', () => {
    const objId = seedObjective('claude-fable-5')
    const jsonl = tmpFile(`${objId}-refusal.jsonl`, [
      JSON.stringify({ type: 'assistant', parent_tool_use_id: null, message: { model: 'claude-fable-5', stop_reason: 'refusal', content: [{ type: 'text', text: '' }] } }),
    ].join('\n') + '\n')

    scanStreamTelemetry('cc-test-h3', jsonl, tmpFile(`${objId}-refusal.log`, ''), 'claude-fable-5', objId)

    expect(fs.readFileSync(jsonl, 'utf-8')).toContain('model refused (stop_reason=refusal)')
    expect((getDb().prepare('SELECT ran_on_fallback FROM objectives WHERE id = ?').get(objId) as { ran_on_fallback: number }).ran_on_fallback).toBe(0)
  })
})

describe('model-attribution pure core', () => {
  it('classifies main-loop vs sidechain and reads the explicit fallback block', () => {
    const attr = analyzeStreamAttribution([
      JSON.stringify({ type: 'assistant', parent_tool_use_id: null, message: { model: 'claude-fable-5', content: [] } }),
      JSON.stringify({ type: 'assistant', parent_tool_use_id: 'toolu_z', message: { model: 'claude-opus-4-8', content: [] } }),
      JSON.stringify({ type: 'result', model: 'claude-fable-5', modelUsage: { 'claude-opus-4-8': {} } }),
    ].join('\n'))
    expect(attr.mainLoopTurns).toEqual({ 'claude-fable-5': 1 })
    expect(detectMainLoopFallback(attr, 'claude-fable-5')).toBe(false)

    const genuine = analyzeStreamAttribution(
      JSON.stringify({ type: 'assistant', message: { model: FALLBACK_MODEL_ID, content: [{ type: 'fallback', from: { model: 'claude-fable-5' }, to: { model: FALLBACK_MODEL_ID } }] } })
    )
    expect(genuine.fallbackSwitchTo).toEqual([FALLBACK_MODEL_ID])
    expect(detectMainLoopFallback(genuine, 'claude-fable-5')).toBe(true)
    // requested == fallback → never flag
    expect(detectMainLoopFallback(genuine, FALLBACK_MODEL_ID)).toBe(false)
  })

  it('mergeRanModel de-dupes and preserves order across repeat scans', () => {
    expect(mergeRanModel(null, ['claude-fable-5'])).toBe('claude-fable-5')
    expect(mergeRanModel('claude-fable-5', ['claude-fable-5'])).toBe('claude-fable-5')
    expect(mergeRanModel('claude-fable-5', ['claude-opus-4-8'])).toBe('claude-fable-5,claude-opus-4-8')
    expect(mergeRanModel(null, [])).toBe(null)
  })
})
