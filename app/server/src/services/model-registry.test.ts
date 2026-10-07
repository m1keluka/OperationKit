import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

// Temp-file DB so initDb's real schema + first-seed migration run (mirrors the
// mentor.test.ts pattern). Must set DB_PATH before importing the db module.
const TMP_DB = path.join(os.tmpdir(), `cc-models-test-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB

const { initDb, getDb } = await import('../db/index.js')
const {
  listModels, listEnabledModels, getDefaultModelId, getPlannerModelId, getModelEngine,
  setModelEnabled, setDefaultModel, setPlannerModel,
  resolveObjectiveModel, getGruntModelId, getReviewerModelId, GRUNT_WORKER_MODEL_ID,
} = await import('./model-registry.js')

const BASELINE = [
  ['claude-fable-5-1', 'Fable 5.1', 'claude', 1, 0, 0, 3],
  ['claude-opus-5-5', 'Opus 5.5', 'claude', 1, 1, 1, 4],
  ['claude-opus-5', 'Opus 5 (legacy)', 'claude', 1, 0, 0, 5],
  ['claude-opus-4-8', 'Opus 4.8 (legacy)', 'claude', 1, 0, 0, 10],
  ['claude-sonnet-5', 'Sonnet 5', 'claude', 1, 0, 0, 18],
  ['claude-sonnet-4-6', 'Sonnet 4.6 (legacy)', 'claude', 1, 0, 0, 20],
  ['gpt-5.5', 'GPT-5.5 (Codex)', 'codex', 1, 0, 0, 30],
  ['gpt-5.4', 'GPT-5.4 (Codex)', 'codex', 1, 0, 0, 31],
  ['gpt-5.4-mini', 'GPT-5.4-mini (Codex)', 'codex', 1, 0, 0, 32],
  ['claude-fable-5', 'Fable 5 (disabled)', 'claude', 0, 0, 0, 40],
] as const

function reseedBaseline() {
  const db = getDb()
  db.exec('DELETE FROM objectives')
  db.exec('DELETE FROM models')
  const stmt = db.prepare(
    'INSERT INTO models (id,label,engine,enabled,is_default,is_planner,sort_order) VALUES (?,?,?,?,?,?,?)'
  )
  for (const row of BASELINE) stmt.run(...row)
}

beforeAll(() => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
})

afterAll(() => {
  try { getDb().close() } catch {}
  for (const s of ['', '-wal', '-shm']) {
    const f = `${TMP_DB}${s}`
    if (fs.existsSync(f)) fs.unlinkSync(f)
  }
})

beforeEach(() => reseedBaseline())

describe('model-registry: seeded baseline', () => {
  it('makes Opus 5.5 the default and the planner', () => {
    expect(getDefaultModelId()).toBe('claude-opus-5-5')
    expect(getPlannerModelId()).toBe('claude-opus-5-5')
  })

  it('keeps Opus 4.8 selectable as a legacy option', () => {
    const opus48 = listModels().find(m => m.id === 'claude-opus-4-8')
    expect(opus48).toBeDefined()
    expect(opus48!.enabled).toBe(true)
    expect(opus48!.is_default).toBe(false)
    expect(opus48!.is_planner).toBe(false)
  })

  it('keeps the banned Fable 5 on record but disabled', () => {
    const fable = listModels().find(m => m.id === 'claude-fable-5')
    expect(fable).toBeDefined()
    expect(fable!.enabled).toBe(false)
  })

  it('excludes disabled models from the selectable list', () => {
    const enabled = listEnabledModels().map(m => m.id)
    expect(enabled).toContain('claude-opus-4-8')
    expect(enabled).toContain('gpt-5.5')
    expect(enabled).not.toContain('claude-fable-5')
  })

  it('exposes the three Codex models as a codex engine', () => {
    const codexIds = listModels().filter(m => m.engine === 'codex').map(m => m.id)
    expect(codexIds).toEqual(expect.arrayContaining(['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini']))
  })

  it('maps integer columns to booleans and engine to a union', () => {
    const m = listModels().find(x => x.id === 'gpt-5.5')!
    expect(m.engine).toBe('codex')
    expect(m.enabled).toBe(true)
    expect(typeof m.is_default).toBe('boolean')
  })
})

describe('model-registry: getModelEngine', () => {
  it('resolves the engine from the registry', () => {
    expect(getModelEngine('claude-opus-4-8')).toBe('claude')
    expect(getModelEngine('gpt-5.5')).toBe('codex')
    expect(getModelEngine('gpt-5.4-mini')).toBe('codex')
  })

  it('falls back heuristically for ids not in the registry', () => {
    expect(getModelEngine('grok-4.6')).toBe('grok')
    expect(getModelEngine('codex')).toBe('codex')          // legacy generic alias
    expect(getModelEngine('gpt-6')).toBe('codex')
    expect(getModelEngine('o3')).toBe('codex')
    expect(getModelEngine('some-future-claude')).toBe('claude')
    expect(getModelEngine(undefined)).toBe('claude')
    expect(getModelEngine(null)).toBe('claude')
  })
})

describe('model-registry: setting default / planner', () => {
  it('moves the default to exactly one model', () => {
    setDefaultModel('claude-sonnet-5')
    expect(getDefaultModelId()).toBe('claude-sonnet-5')
    expect(listModels().filter(m => m.is_default)).toHaveLength(1)
  })

  it('can set a Codex model as the planner', () => {
    setPlannerModel('gpt-5.5')
    expect(getPlannerModelId()).toBe('gpt-5.5')
    expect(getDefaultModelId()).toBe('claude-opus-5-5')
    expect(listModels().filter(m => m.is_planner)).toHaveLength(1)
  })

  it('auto-enables a disabled model when it is made the default', () => {
    setDefaultModel('claude-fable-5')
    const fable = listModels().find(m => m.id === 'claude-fable-5')!
    expect(fable.enabled).toBe(true)
    expect(fable.is_default).toBe(true)
  })

  it('throws on an unknown model id', () => {
    expect(() => setDefaultModel('claude-nonexistent')).toThrow(/Unknown model/)
  })
})

describe('model-registry: enable / disable', () => {
  it('re-enables a disabled model so it becomes selectable', () => {
    setModelEnabled('claude-fable-5', true)
    expect(listEnabledModels().map(m => m.id)).toContain('claude-fable-5')
  })

  it('refuses to disable the current default model', () => {
    expect(() => setModelEnabled('claude-opus-5-5', false)).toThrow(/current default/)
  })

  it('refuses to disable the current planner model', () => {
    setDefaultModel('claude-sonnet-5') // move default off opus-5.5 so failure is attributable to the planner role
    expect(() => setModelEnabled('claude-opus-5-5', false)).toThrow(/planner/)
  })

  it('allows disabling a Codex model that holds no role', () => {
    const m = setModelEnabled('gpt-5.4', false)
    expect(m.enabled).toBe(false)
  })
})

describe('resolveObjectiveModel — grunt workers get Sonnet', () => {
  it('an explicit model always wins', () => {
    expect(resolveObjectiveModel({ model: 'claude-opus-5', type: 'task' })).toBe('claude-opus-5')
  })

  it('task/bug without a PR and not a delegator → Sonnet', () => {
    expect(resolveObjectiveModel({ type: 'task' })).toBe(GRUNT_WORKER_MODEL_ID)
    expect(resolveObjectiveModel({ type: 'bug' })).toBe(GRUNT_WORKER_MODEL_ID)
    expect(getGruntModelId()).toBe(GRUNT_WORKER_MODEL_ID)
  })

  it('AI reviewer uses the grunt model (Sonnet), not the board default (Opus)', () => {
    expect(getReviewerModelId()).toBe(GRUNT_WORKER_MODEL_ID)
    expect(getReviewerModelId()).not.toBe(getDefaultModelId())
  })

  it('projects, PR work, and delegators keep the board default', () => {
    expect(resolveObjectiveModel({ type: 'project' })).toBe(getDefaultModelId())
    expect(resolveObjectiveModel({ type: 'task', create_pr: true })).toBe(getDefaultModelId())
    expect(resolveObjectiveModel({ type: 'task', delegate_mode: true })).toBe(getDefaultModelId())
  })
})

describe('model-registry: defensive fallback', () => {
  it('falls back to Opus 4.8 when no default row exists', () => {
    getDb().exec('DELETE FROM models')
    expect(getDefaultModelId()).toBe('claude-opus-4-8')
    expect(getPlannerModelId()).toBe('claude-opus-4-8')
  })
})

describe('model-registry: Fable→Opus data migration', () => {
  it('repoints existing fable objectives to opus when the registry is first seeded', () => {
    getDb().prepare(
      "INSERT INTO objectives (title, model, status, agent_context) VALUES ('legacy', 'claude-fable-5', 'queue', 'general')"
    ).run()
    getDb().exec('DELETE FROM models')
    initDb()
    const obj = getDb().prepare("SELECT model FROM objectives WHERE title = 'legacy'").get() as { model: string }
    expect(obj.model).toBe('claude-opus-4-8')
  })
})

describe('model-registry: Codex multi-model migration', () => {
  it('replaces a legacy generic codex row with the three explicit Codex models', () => {
    // Simulate the pre-expansion world: one generic 'codex' row + an objective pinned to it.
    getDb().exec('DELETE FROM models')
    getDb().prepare(
      "INSERT INTO models (id,label,engine,enabled,is_default,is_planner,sort_order) VALUES ('codex','Codex (ChatGPT sub)','codex',1,0,0,30)"
    ).run()
    getDb().prepare(
      "INSERT INTO objectives (title, model, status, agent_context) VALUES ('legacy-codex', 'codex', 'queue', 'general')"
    ).run()
    initDb()
    const ids = listModels().map(m => m.id)
    expect(ids).toEqual(expect.arrayContaining(['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini']))
    expect(ids).not.toContain('codex')
    const obj = getDb().prepare("SELECT model FROM objectives WHERE title = 'legacy-codex'").get() as { model: string }
    expect(obj.model).toBe('gpt-5.5')
    expect(getModelEngine('gpt-5.4')).toBe('codex')
  })
})

describe('model-registry: Opus 5.5 promotion migration', () => {
  // Boot from a registry that predates BOTH promotions (Opus 4.8 holds the roles).
  // initDb replays the 2026-07-24 Opus 5 block and then the 2026-09-23 Opus 5.5
  // block, so the LATEST model must end up holding default + planner.
  function bootFromOpus48Only() {
    getDb().exec('DELETE FROM models')
    getDb().prepare(
      "INSERT INTO models (id,label,engine,enabled,is_default,is_planner,sort_order) VALUES ('claude-opus-4-8','Opus 4.8','claude',1,1,1,10)"
    ).run()
    initDb()
  }

  it('adds Opus 5.5 and promotes it to default + planner on a re-seeded registry', () => {
    bootFromOpus48Only()
    const opus55 = listModels().find(m => m.id === 'claude-opus-5-5')!
    expect(opus55.enabled).toBe(true)
    expect(opus55.is_default).toBe(true)
    expect(opus55.is_planner).toBe(true)
    expect(getDefaultModelId()).toBe('claude-opus-5-5')
    expect(getPlannerModelId()).toBe('claude-opus-5-5')
    // Exactly one default / planner (partial unique indexes upheld).
    expect(listModels().filter(m => m.is_default)).toHaveLength(1)
    expect(listModels().filter(m => m.is_planner)).toHaveLength(1)
  })

  it('also seeds Fable 5.1 and Sonnet 5 as selectable non-default options', () => {
    bootFromOpus48Only()
    for (const id of ['claude-fable-5-1', 'claude-sonnet-5']) {
      const m = listModels().find(x => x.id === id)!
      expect(m).toBeDefined()
      expect(m.enabled).toBe(true)
      expect(m.is_default).toBe(false)
      expect(m.is_planner).toBe(false)
    }
  })

  it('leaves superseded models enabled (only relabelled) so in-flight objectives still spawn', () => {
    bootFromOpus48Only()
    // Disabling them would trip the disabled-model rescue and alert on every
    // non-terminal objective still pinned to the old id.
    for (const id of ['claude-opus-5', 'claude-opus-4-8']) {
      const m = listModels().find(x => x.id === id)!
      expect(m.enabled).toBe(true)
      expect(m.is_default).toBe(false)
      expect(m.is_planner).toBe(false)
    }
    expect(listModels().find(m => m.id === 'claude-opus-5')!.label).toBe('Opus 5 (legacy)')
  })

  it('does not re-clobber a later manual default reassignment on the next boot', () => {
    bootFromOpus48Only()
    setDefaultModel('claude-opus-5')
    expect(getDefaultModelId()).toBe('claude-opus-5')
    // A subsequent boot must respect the operator's choice (guard on row presence).
    initDb()
    expect(getDefaultModelId()).toBe('claude-opus-5')
  })

  it('routes grunt workers and the AI reviewer to Sonnet 5', () => {
    bootFromOpus48Only()
    expect(GRUNT_WORKER_MODEL_ID).toBe('claude-sonnet-5')
    expect(getGruntModelId()).toBe('claude-sonnet-5')
    expect(getReviewerModelId()).toBe('claude-sonnet-5')
  })
})
