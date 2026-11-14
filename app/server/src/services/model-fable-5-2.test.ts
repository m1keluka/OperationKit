// Claude Fable 5.2 (`claude-fable-5-2`) end to end through the model plumbing
// (obj 900796): curated catalog → boot seed → registry/picker → objective
// model resolution → spawn command → usage pricing → provider refresh labels →
// LLM gateway allow-list → main-loop attribution.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const TMP_DB = path.join(os.tmpdir(), `cc-fable52-models-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB

const { initDb, getDb } = await import('../db/index.js')
const { seedCatalogModels } = await import('../db/schema/models.js')
const { CLAUDE_MODEL_CATALOG, catalogEntry, catalogEntryForUsage } = await import('../lib/claude-model-catalog.js')
const {
  listEnabledModels, listModels, getDefaultModelId, getPlannerModelId, getModelEngine, resolveObjectiveModel, setModelEnabled,
} = await import('./model-registry.js')
const { applyProviderModels } = await import('./model-refresh.js')
const { estimateCostUsd } = await import('./unresulted-usage.js')
const { buildClaudeCommand } = await import('./session-spawn-command.js')
const { SUPPORTED_MODELS } = await import('./llm-gateway/translate.js')
const { analyzeStreamAttribution, detectMainLoopFallback, mainLoopModelsRan } = await import('./model-attribution.js')

const FABLE = 'claude-fable-5-2'
const row = (id: string) => listModels().find(m => m.id === id)

beforeAll(() => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
})

afterAll(() => {
  try { getDb().close() } catch { /* already closed */ }
  for (const s of ['', '-wal', '-shm']) fs.rmSync(`${TMP_DB}${s}`, { force: true })
})

describe('curated Claude catalog', () => {
  it('lists Fable 5.2 with the official id, display name and release price', () => {
    expect(catalogEntry(FABLE)).toMatchObject({
      label: 'Claude Fable 5.2', seed: true, price: { input: 8, output: 40, cache_read: 0.2 },
    })
  })

  it('keeps Mythos 5.2 gated: priced, never seeded', () => {
    expect(catalogEntry('claude-mythos-5-2')).toMatchObject({ seed: false, gated: expect.stringMatching(/verified/) })
  })

  it('is well-formed: unique dateless claude- ids, positive prices, a reason on every unseeded entry', () => {
    const ids = CLAUDE_MODEL_CATALOG.map(e => e.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const e of CLAUDE_MODEL_CATALOG) {
      expect(e.id).toMatch(/^claude-[a-z]+-\d+(-\d+)?$/)
      expect(e.label.trim()).not.toBe('')
      expect(e.price.input).toBeGreaterThan(0)
      expect(e.price.output).toBeGreaterThan(e.price.input)
      if (!e.seed) expect(e.gated).toBeTruthy()
    }
  })

  it('maps a usage model string to the right entry — never a shorter sibling id', () => {
    expect(catalogEntryForUsage(FABLE)?.id).toBe(FABLE)
    expect(catalogEntryForUsage('claude-fable-5-2[1m]')?.id).toBe(FABLE)
    expect(catalogEntryForUsage('claude-fable-5-2-20261109')?.id).toBe(FABLE)
    expect(catalogEntryForUsage('claude-fable-5-1')?.id).toBe('claude-fable-5-1')
    expect(catalogEntryForUsage('claude-fable-5')).toBeUndefined()
    expect(catalogEntryForUsage('claude-sonnet-5-5')).toBeUndefined() // not claude-sonnet-5
  })
})

describe('registry seed (the root-cause fix)', () => {
  it('a fresh install has Fable 5.2 enabled, curated, and not default/planner', () => {
    expect(row(FABLE)).toMatchObject({ label: 'Claude Fable 5.2', engine: 'claude', enabled: true, is_default: false, is_planner: false, source: 'seed' })
    expect(listEnabledModels().map(m => m.id)).toContain(FABLE)
    expect(getDefaultModelId()).toBe('claude-opus-5-5')
    expect(getPlannerModelId()).toBe('claude-opus-5-5')
    expect(row('claude-mythos-5-2')).toBeUndefined()
  })

  it('sorts Fable 5.2 above Fable 5.1 in the picker', () => {
    const ids = listEnabledModels().map(m => m.id)
    expect(ids.indexOf(FABLE)).toBeLessThan(ids.indexOf('claude-fable-5-1'))
  })

  it('runs once: an admin who switches it off stays off across boots', () => {
    setModelEnabled(FABLE, false)
    expect(seedCatalogModels(getDb())).toEqual([])
    initDb() // a full re-boot of the schema
    expect(row(FABLE)?.enabled).toBe(false)
    setModelEnabled(FABLE, true)
  })

  it('adopts a row the provider refresh had filed DISABLED (how the gap looked on a live install)', () => {
    const db = getDb()
    db.prepare('DELETE FROM models WHERE id = ?').run(FABLE)
    db.prepare('DELETE FROM model_catalog_seeds WHERE model_id = ?').run(FABLE)
    applyProviderModels('claude', [{ id: FABLE, label: 'Claude Fable 5.2' }], new Date().toISOString())
    expect(row(FABLE)).toMatchObject({ enabled: false, source: 'provider', sort_order: 2 })
    expect(listEnabledModels().map(m => m.id)).not.toContain(FABLE)

    expect(seedCatalogModels(db)).toEqual([FABLE])
    expect(row(FABLE)).toMatchObject({ enabled: true, source: 'seed', label: 'Claude Fable 5.2' })
  })

  it('never touches a curated row that already exists, and never seeds a gated entry', () => {
    const db = getDb()
    db.prepare('DELETE FROM model_catalog_seeds WHERE model_id = ?').run('claude-opus-5-5')
    db.prepare("UPDATE models SET label = 'My Opus' WHERE id = 'claude-opus-5-5'").run()
    expect(seedCatalogModels(db)).toEqual([])
    expect(row('claude-opus-5-5')?.label).toBe('My Opus')
    db.prepare("UPDATE models SET label = 'Opus 5.5' WHERE id = 'claude-opus-5-5'").run()

    const gated = [{ id: 'claude-test-9', label: 'Gated', sort_order: 1, price: { input: 1, output: 2, cache_read: 0.1 }, seed: false, gated: 'test' }]
    expect(seedCatalogModels(db, gated)).toEqual([])
    expect(row('claude-test-9')).toBeUndefined()
  })
})

describe('the provider refresh files a catalog id under its curated name', () => {
  it('uses the catalog label + position for a newly discovered catalog id (still disabled)', () => {
    getDb().prepare("DELETE FROM models WHERE id = 'claude-mythos-5-2'").run()
    applyProviderModels('claude', [{ id: 'claude-mythos-5-2', label: 'claude-mythos-5-2' }], new Date().toISOString())
    expect(row('claude-mythos-5-2')).toMatchObject({ label: 'Claude Mythos 5.2', sort_order: 2, enabled: false, source: 'provider' })
    getDb().prepare("DELETE FROM models WHERE id = 'claude-mythos-5-2'").run()
  })
})

describe('agents and card sessions can run it', () => {
  it('an objective that asks for it keeps it, on the Claude engine', () => {
    expect(resolveObjectiveModel({ model: FABLE, type: 'task' })).toBe(FABLE)
    expect(getModelEngine(FABLE)).toBe('claude')
  })

  it('the spawn command passes --model claude-fable-5-2 to the Claude CLI', () => {
    const cmd = buildClaudeCommand({ engine: 'claude', budget: 5, effortLevel: 'high', model: FABLE })
    expect(cmd).toContain('--model "claude-fable-5-2"')
  })

  it('the LLM gateway (workflow llm nodes, openai-compatible bots) accepts it', () => {
    expect(SUPPORTED_MODELS as readonly string[]).toContain(FABLE)
  })
})

describe('pricing + attribution', () => {
  const MTOK = { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }
  it('prices Fable 5.2 at $8 / $40 per MTok (not the Fable 5.1 $10 / $50)', () => {
    expect(estimateCostUsd(MTOK, FABLE)).toBeCloseTo(8)
    expect(estimateCostUsd({ ...MTOK, input: 0, output: 1_000_000 }, FABLE)).toBeCloseTo(40)
    expect(estimateCostUsd({ ...MTOK, input: 0, cacheRead: 1_000_000 }, FABLE)).toBeCloseTo(0.2)
    expect(estimateCostUsd(MTOK, 'claude-fable-5-2[1m]')).toBeCloseTo(8)
    expect(estimateCostUsd(MTOK, 'claude-mythos-5-2')).toBeCloseTo(8)
    // unchanged neighbours
    expect(estimateCostUsd(MTOK, 'claude-fable-5-1')).toBeCloseTo(10)
    expect(estimateCostUsd(MTOK, 'claude-fable-5')).toBeCloseTo(10)
    expect(estimateCostUsd(MTOK, 'claude-opus-5-5')).toBeCloseTo(4)
  })

  const ev = (model: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ type: 'assistant', parent_tool_use_id: null, message: { model, content: [{ type: 'text', text: 'x' }] }, ...extra })

  it('a Fable 5.2 main loop is attributed to Fable 5.2 — sub-agent Opus turns are not a fallback', () => {
    const attr = analyzeStreamAttribution([ev(FABLE), ev('claude-opus-5-5', { parent_tool_use_id: 'toolu_1' }), ev(FABLE)].join('\n'))
    expect(mainLoopModelsRan(attr)).toEqual([FABLE])
    expect(detectMainLoopFallback(attr, FABLE)).toBe(false)
  })

  it('a main loop that silently ran on the fallback model (e.g. a CLI too old for Fable 5.2) is flagged', () => {
    const attr = analyzeStreamAttribution([ev('claude-sonnet-5'), ev('claude-sonnet-5')].join('\n'))
    expect(detectMainLoopFallback(attr, FABLE)).toBe(true)
  })
})
