import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import {
  ARCHETYPES,
  DEFAULT_ARENA_N,
  isArenaEnabled,
  isArenaEligible,
  shouldRunArena,
  buildVariantSpecs,
  scoreVariant,
  rankVariants,
  buildPairwiseTiebreakPrompt,
  buildVariantJudgePrompt,
  parseVariantScorecard,
  runArena,
  toRankingArtifact,
  type VariantScorecard,
  type ArenaDeps,
} from './design-arena.js'
import { clearGateConfigCache, getEffectiveGateMode } from './design-context.js'
import type { Objective } from '@operationkit/shared'

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

// 'example-project-platform' is a registered frontend repo in .design-registry.json, so
// isUiObjective() is true for it deterministically (no NLP).
const WS = 'example-project-platform'

// ─── Prototype fixture (obj 583) ──────────────────────────────────────────────
// Verbatim dimension verdicts from /tmp/design-arena-proto/results/ranking.json,
// transcribed as the structured scorecard the ranker consumes. The ranker MUST
// reproduce the prototype's outcome: B wins 14/14; A & D 13; C auto-FAILs on the R7
// responsive defect + slop-accumulation.
const PROTO_FIXTURE: VariantScorecard[] = [
  {
    variant: 'B — editorial / hero-led', file: 'variants/variant-b-editorial.html', archetype: 'editorial',
    dimensions: { R1: 'pass', R2: 'pass', R3: 'pass', R4: 'pass', R5: 'pass', R6: 'pass', R7: 'pass', R8: 'PASS', R9: 'PASS' },
  },
  {
    variant: 'A — command terminal', file: 'variants/variant-a-terminal.html', archetype: 'terminal',
    dimensions: { R1: 'warn', R2: 'pass', R3: 'pass', R4: 'pass', R5: 'pass', R6: 'pass', R7: 'pass', R8: 'PASS', R9: 'PASS' },
  },
  {
    variant: 'D — progressive stacked', file: 'variants/variant-d-stacked.html', archetype: 'stacked',
    dimensions: { R1: 'pass', R2: 'warn', R3: 'pass', R4: 'pass', R5: 'pass', R6: 'pass', R7: 'pass', R8: 'PASS', R9: 'PASS' },
  },
  {
    variant: 'C — KPI cockpit', file: 'variants/variant-c-cockpit.html', archetype: 'cockpit',
    dimensions: { R1: 'pass', R2: 'warn', R3: 'pass', R4: 'warn', R5: 'warn', R6: 'pass', R7: 'fail', R8: 'PASS', R9: 'PASS' },
  },
]

// ═══════════════════════════════════════════════════════════════════════════════
describe('eligibility selector (arena-eligible vs not → correct branch)', () => {
  it('eligible: net-new, visually-central UI surface', () => {
    const e = isArenaEligible(obj({ project: WS, title: 'New buyer dashboard landing page' }))
    expect(e.eligible).toBe(true)
  })

  it('NOT eligible: bug-fix / copy tweak / refactor (maintenance) stays single-worker', () => {
    expect(isArenaEligible(obj({ project: WS, title: 'Fix overflow bug on dashboard' })).eligible).toBe(false)
    expect(isArenaEligible(obj({ project: WS, title: 'Copy tweak on the homepage' })).eligible).toBe(false)
    expect(isArenaEligible(obj({ project: WS, title: 'Refactor dashboard data hooks' })).eligible).toBe(false)
  })

  it('NOT eligible: non-UI objective (unregistered repo, no visual criterion)', () => {
    expect(isArenaEligible(obj({ project: 'some-backend-svc', acceptance_criteria: [] })).eligible).toBe(false)
  })

  it('NOT eligible: UI objective with no high-value/visually-central hint defaults to single-worker', () => {
    expect(isArenaEligible(obj({ project: WS, title: 'Adjust a form field width' })).eligible).toBe(false)
  })

  it('explicit [arena] flag forces eligibility even without a visually-central hint', () => {
    expect(isArenaEligible(obj({ project: WS, title: '[arena] internal tooling surface' })).eligible).toBe(true)
    expect(isArenaEligible(obj({ project: WS, title: 'x', arena: true } as Partial<Objective>)).eligible).toBe(true)
  })

  it('explicit [no-arena] opt-out wins over inference', () => {
    expect(isArenaEligible(obj({ project: WS, title: '[no-arena] New buyer dashboard landing' })).eligible).toBe(false)
  })

  // obj-1216: the spawn/resume path passes the UNMAPPED DB row, where
  // acceptance_criteria is the raw JSON-string TEXT column. `?? []` does not
  // normalize a string, so the old `crits.some(...)` threw ".some is not a
  // function" and crash-looped the spawn whenever the arena was enabled for a
  // UI objective. hasExplicitArenaFlag must normalize string→array first.
  it('tolerates acceptance_criteria as a raw JSON string without throwing (spawn path passes the unmapped DB row)', () => {
    // An arena criterion encoded as the raw JSON string the DB stores.
    const withArenaCrit = obj({
      project: WS,
      title: 'Adjust a form field width', // no visually-central hint → only the explicit flag can make it eligible
      acceptance_criteria: JSON.stringify([
        { id: 'a', criterion: 'x', method: 'arena' },
      ]) as unknown as Objective['acceptance_criteria'],
    })
    expect(() => isArenaEligible(withArenaCrit)).not.toThrow()
    // The arena criterion inside the raw string must still be detected.
    expect(isArenaEligible(withArenaCrit).eligible).toBe(true)

    // A raw JSON string with no arena marker → no explicit flag, stays single-worker.
    const noArenaCrit = obj({
      project: WS,
      title: 'Adjust a form field width',
      acceptance_criteria: JSON.stringify([
        { id: 'a', criterion: 'x', method: 'api' },
      ]) as unknown as Objective['acceptance_criteria'],
    })
    expect(() => isArenaEligible(noArenaCrit)).not.toThrow()
    expect(isArenaEligible(noArenaCrit).eligible).toBe(false)

    // Garbage / non-JSON string must degrade to a no-op, never throw.
    const garbage = obj({
      project: WS,
      title: 'Adjust a form field width',
      acceptance_criteria: '{not valid json' as unknown as Objective['acceptance_criteria'],
    })
    expect(() => isArenaEligible(garbage)).not.toThrow()
    expect(isArenaEligible(garbage).eligible).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
describe('runtime flag — isArenaEnabled (reuses .ui-gate.json control-plane)', () => {
  let tmpFile: string
  beforeEach(() => {
    tmpFile = path.join(os.tmpdir(), `ui-gate-arena-${Date.now()}-${process.pid}.json`)
    process.env.UI_GATE_FILE = tmpFile
    delete process.env.CC_ARENA_ENABLED
    clearGateConfigCache()
  })
  afterEach(() => {
    try { fs.unlinkSync(tmpFile) } catch {}
    delete process.env.UI_GATE_FILE
    delete process.env.CC_ARENA_ENABLED
    clearGateConfigCache()
  })

  it('DORMANT by default: file absent ⇒ arena OFF for every project', () => {
    expect(isArenaEnabled(WS)).toBe(false)
    expect(isArenaEnabled(null)).toBe(false)
  })

  it('a gate file WITHOUT an arena block keeps the arena OFF and the gate mode intact', () => {
    fs.writeFileSync(tmpFile, JSON.stringify({ mode: 'advisory', platforms: [WS] }))
    clearGateConfigCache()
    expect(isArenaEnabled(WS)).toBe(false) // arena absent ⇒ dormant
    expect(getEffectiveGateMode(WS)).toBe('advisory') // existing gate UNAFFECTED
  })

  it('arena enabled globally (empty allowlist) ⇒ on for every project', () => {
    fs.writeFileSync(tmpFile, JSON.stringify({ mode: 'off', platforms: [], arena: { enabled: true, platforms: [] } }))
    clearGateConfigCache()
    expect(isArenaEnabled(WS)).toBe(true)
    expect(isArenaEnabled('anything')).toBe(true)
  })

  it('arena enabled with a platform allowlist ⇒ on for listed, off for others', () => {
    fs.writeFileSync(tmpFile, JSON.stringify({ mode: 'off', platforms: [], arena: { enabled: true, platforms: [WS] } }))
    clearGateConfigCache()
    expect(isArenaEnabled(WS)).toBe(true)
    expect(isArenaEnabled('other-platform')).toBe(false)
  })

  it('arena {enabled:false} ⇒ off (explicit dormant)', () => {
    fs.writeFileSync(tmpFile, JSON.stringify({ mode: 'hard', platforms: [], arena: { enabled: false, platforms: [] } }))
    clearGateConfigCache()
    expect(isArenaEnabled(WS)).toBe(false)
  })

  it('malformed arena block degrades to OFF without breaking the gate mode', () => {
    fs.writeFileSync(tmpFile, JSON.stringify({ mode: 'advisory', platforms: [WS], arena: { enabled: 'yes' } }))
    clearGateConfigCache()
    expect(isArenaEnabled(WS)).toBe(false)
    expect(getEffectiveGateMode(WS)).toBe('advisory')
  })

  it('env fallback CC_ARENA_ENABLED applies only when no arena block is present', () => {
    process.env.CC_ARENA_ENABLED = '1'
    clearGateConfigCache()
    expect(isArenaEnabled(WS)).toBe(true) // file absent ⇒ env fallback
    // but a file arena block wins over the env fallback:
    fs.writeFileSync(tmpFile, JSON.stringify({ mode: 'off', platforms: [], arena: { enabled: false, platforms: [] } }))
    clearGateConfigCache()
    expect(isArenaEnabled(WS)).toBe(false)
  })

  it('shouldRunArena ANDs enabled + eligible (default false ⇒ dormant)', () => {
    const eligible = obj({ project: WS, title: 'New dashboard landing page' })
    expect(shouldRunArena(eligible)).toBe(false) // disabled by default
    fs.writeFileSync(tmpFile, JSON.stringify({ mode: 'off', platforms: [], arena: { enabled: true, platforms: [WS] } }))
    clearGateConfigCache()
    expect(shouldRunArena(eligible)).toBe(true)
    expect(shouldRunArena(obj({ project: WS, title: 'Fix a bug' }))).toBe(false) // enabled but not eligible
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
describe('orchestrator — archetype-seeded fan-out', () => {
  const o = obj({ project: WS, title: 'New buyer dashboard' })

  it('produces N distinct archetype-seeded specs (default N=4)', () => {
    const specs = buildVariantSpecs(o)
    expect(specs).toHaveLength(DEFAULT_ARENA_N)
    const keys = specs.map((s) => s.archetypeKey)
    expect(new Set(keys).size).toBe(specs.length) // all distinct
    expect(keys).toEqual(['terminal', 'editorial', 'cockpit', 'stacked'])
  })

  it('each spec reuses the shipped design-context block AND appends its archetype seed', () => {
    const specs = buildVariantSpecs(o, 3)
    expect(specs).toHaveLength(3)
    for (const s of specs) {
      expect(s.prompt).toContain('Design Context') // from buildDesignContextBlock (reused)
      expect(s.prompt).toContain('Design Arena — your assigned layout archetype')
      expect(s.prompt).toContain('HARD CONSTRAINT')
    }
    // Only the FORM varies: each carries a different archetype name.
    expect(specs[0].prompt).toContain(ARCHETYPES[0].name)
    expect(specs[1].prompt).toContain(ARCHETYPES[1].name)
  })

  it('clamps N to the available archetypes (min 2)', () => {
    expect(buildVariantSpecs(o, 99)).toHaveLength(ARCHETYPES.length)
    expect(buildVariantSpecs(o, 1)).toHaveLength(2)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
describe('ranker — reproduces the prototype ranking from the committed scorecards', () => {
  it('scoreVariant applies the exact gate rules (pass2/warn1/fail0; hard gates; ≥3 warns)', () => {
    const [b, a, d, c] = PROTO_FIXTURE.map(scoreVariant)
    expect(b.score).toBe(14); expect(b.verdict).toBe('PASS')
    expect(a.score).toBe(13); expect(a.verdict).toBe('PASS')
    expect(d.score).toBe(13); expect(d.verdict).toBe('PASS')
    expect(c.score).toBe(9); expect(c.verdict).toBe('FAIL')
    // C fails for BOTH the R7 responsive defect and the slop-accumulation rule.
    expect(c.failReasons).toContain('R7 fail')
    expect(c.failReasons.some((r) => /≥3 WARNs/.test(r))).toBe(true)
  })

  it('rankVariants crowns B (14/14) and sinks C to last (FAIL), with a clean winner (no tie)', () => {
    const ranked = rankVariants(PROTO_FIXTURE)
    expect(ranked.ranking[0].archetype).toBe('editorial') // B wins
    expect(ranked.ranking[0].score).toBe(14)
    expect(ranked.ranking[ranked.ranking.length - 1].archetype).toBe('cockpit') // C last (FAIL)
    expect(ranked.winner?.archetype).toBe('editorial')
    expect(ranked.tiebreakNeeded).toBe(false) // 14 vs 13 — no top-2 tie
  })

  it('R8 hard gate and R9 binary each force FAIL regardless of R1–R7 score', () => {
    const clean = PROTO_FIXTURE[0].dimensions
    expect(scoreVariant({ variant: 'x', file: 'x', dimensions: { ...clean, R8: 'FAIL' } }).verdict).toBe('FAIL')
    expect(scoreVariant({ variant: 'x', file: 'x', dimensions: { ...clean, R9: 'FAIL' } }).verdict).toBe('FAIL')
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
describe('ranker — single pairwise tiebreak only on a clean top-2 tie', () => {
  it('flags tiebreakNeeded when the top two PASS variants tie on score', () => {
    const tie: VariantScorecard[] = [
      { variant: 'P1', file: 'p1', archetype: 'editorial', dimensions: { R1: 'pass', R2: 'pass', R3: 'pass', R4: 'pass', R5: 'pass', R6: 'pass', R7: 'pass', R8: 'PASS', R9: 'PASS' } },
      { variant: 'P2', file: 'p2', archetype: 'terminal', dimensions: { R1: 'pass', R2: 'pass', R3: 'pass', R4: 'pass', R5: 'pass', R6: 'pass', R7: 'pass', R8: 'PASS', R9: 'PASS' } },
    ]
    const ranked = rankVariants(tie)
    expect(ranked.tiebreakNeeded).toBe(true)
    expect(ranked.tiebreakPair?.map((v) => v.variant)).toEqual(['P1', 'P2'])
    const prompt = buildPairwiseTiebreakPrompt(obj({ title: 'X' }), ranked.tiebreakPair![0], ranked.tiebreakPair![1])
    expect(prompt).toContain('<winner>A|B</winner>')
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
describe('judge prompt + scorecard parse (state-poller-compatible shape)', () => {
  it('judge prompt embeds the R1–R9 rubric verbatim and asks for a <scorecard>', () => {
    const p = buildVariantJudgePrompt(obj({ title: 'Dash' }), { name: 'B', archetype: 'editorial', screenshots: ['b-1440.png', 'b-390.png'] })
    expect(p).toContain('R1 Visual hierarchy')
    expect(p).toContain('R9 Token/primitive conformance')
    expect(p).toContain('<scorecard>')
    expect(p).toContain('<verdict>')
  })

  it('parses a <scorecard> JSON block; malformed/absent ⇒ null', () => {
    const t = 'blah <scorecard>{"R1":"pass","R2":"warn","R3":"pass","R4":"pass","R5":"pass","R6":"pass","R7":"pass","R8":"PASS","R9":"PASS"}</scorecard> more'
    const card = parseVariantScorecard(t, { name: 'B', file: 'b.html', archetype: 'editorial' })
    expect(card).not.toBeNull()
    expect(scoreVariant(card!).score).toBe(13)
    expect(parseVariantScorecard('no tags here', { name: 'x', file: 'x' })).toBeNull()
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
describe('runArena — end-to-end orchestration with injected fakes', () => {
  const o = obj({ id: 7, project: WS, title: 'New buyer dashboard' })

  function fakeDeps(cards: VariantScorecard[], overrides: Partial<ArenaDeps> = {}): ArenaDeps {
    const byKey = new Map(cards.map((c) => [c.archetype!, c]))
    return {
      generate: async (spec) => ({ archetypeKey: spec.archetypeKey, archetypeName: spec.archetypeName, files: [`${spec.archetypeKey}.html`], handle: `${spec.archetypeKey}.html` }),
      render: async () => ['1440.png', '390.png'],
      judge: async (build) => byKey.get(build.archetypeKey) ?? null,
      preFilter: () => ({ pass: true, output: '' }), // R9 passes for all in the prototype
      ...overrides,
    }
  }

  it('runs fan-out → prefilter → render → judge → rank → promote winner (B)', async () => {
    // Map prototype scorecards onto the 4 archetypes the orchestrator fans out.
    const cards = PROTO_FIXTURE.map((c) => ({ ...c }))
    const result = await runArena(o, 4, fakeDeps(cards))
    expect(result.winner?.archetype).toBe('editorial')
    expect(result.ranking).toHaveLength(4)
    expect(result.r9Eliminated).toHaveLength(0)
    const artifact = toRankingArtifact(o, result)
    expect(artifact.winner).toContain('editorial')
  })

  it('R9 pre-filter eliminates a non-conformant variant before render (no judge call for it)', async () => {
    let judged = 0
    const deps = fakeDeps(PROTO_FIXTURE, {
      preFilter: (files) => ({ pass: !files[0].startsWith('cockpit'), output: '' }), // drop cockpit
      judge: async (build) => { judged++; return PROTO_FIXTURE.find((c) => c.archetype === build.archetypeKey) ?? null },
    })
    const result = await runArena(o, 4, deps)
    expect(result.r9Eliminated).toContain('KPI cockpit / left-rail app shell')
    expect(judged).toBe(3) // only the 3 survivors were graded
    expect(result.winner?.archetype).toBe('editorial')
  })

  it('invokes the SINGLE pairwise tiebreak when the top two tie, and promotes its winner', async () => {
    const tie = PROTO_FIXTURE.map((c) => ({ ...c, dimensions: { ...PROTO_FIXTURE[0].dimensions } })) // all 14/14
    let pairwiseCalls = 0
    const deps = fakeDeps(tie, {
      pairwise: async (a) => { pairwiseCalls++; return a.variant }, // pick first
    })
    const result = await runArena(o, 4, deps)
    expect(pairwiseCalls).toBe(1) // exactly ONE comparison, not a tournament
    expect(result.tiebreak).toBeDefined()
    expect(result.winner?.variant).toBe(result.tiebreak?.winner)
  })
})
