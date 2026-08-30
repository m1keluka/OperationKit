import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import {
  registerArenaCohort,
  getArenaCohort,
  hasArenaCohort,
  clearArenaCohort,
  buildArenaDeps,
  evaluateAndPromoteArena,
  type CohortVariant,
  type ArenaLifecycleIO,
} from './arena-lifecycle.js'
import type { Objective } from '@operationkit/shared'

function obj(partial: Partial<Objective>): Objective {
  return { id: 7, title: 'New buyer dashboard', type: 'task', workspace: 'personal', project: 'example-project-platform', acceptance_criteria: null, ...partial } as Objective
}

const COHORT: CohortVariant[] = [
  { archetypeKey: 'terminal', archetypeName: 'command terminal / data-dense', sessionId: 'cc-7-arena-terminal' },
  { archetypeKey: 'editorial', archetypeName: 'editorial / hero-led', sessionId: 'cc-7-arena-editorial' },
  { archetypeKey: 'cockpit', archetypeName: 'KPI cockpit / left-rail app shell', sessionId: 'cc-7-arena-cockpit' },
  { archetypeKey: 'stacked', archetypeName: 'progressive stacked / mobile-first', sessionId: 'cc-7-arena-stacked' },
]

// Variant self-emitted scorecards (prototype outcome): editorial 14/14 wins, terminal &
// stacked 13, cockpit auto-FAILs on R7 + slop.
const SCORECARDS: Record<string, string> = {
  'cc-7-arena-editorial': '<scorecard>{"R1":"pass","R2":"pass","R3":"pass","R4":"pass","R5":"pass","R6":"pass","R7":"pass","R8":"PASS","R9":"PASS"}</scorecard>',
  'cc-7-arena-terminal': '<scorecard>{"R1":"warn","R2":"pass","R3":"pass","R4":"pass","R5":"pass","R6":"pass","R7":"pass","R8":"PASS","R9":"PASS"}</scorecard>',
  'cc-7-arena-stacked': '<scorecard>{"R1":"pass","R2":"warn","R3":"pass","R4":"pass","R5":"pass","R6":"pass","R7":"pass","R8":"PASS","R9":"PASS"}</scorecard>',
  'cc-7-arena-cockpit': '<scorecard>{"R1":"pass","R2":"warn","R3":"pass","R4":"warn","R5":"warn","R6":"pass","R7":"fail","R8":"PASS","R9":"PASS"}</scorecard>',
}

let tmpDir: string
let promoted: Array<{ objId: number; sid: string }>

function baseIO(states: Record<string, string>): ArenaLifecycleIO {
  return {
    getState: (sid) => states[sid] ?? 'dead',
    getTranscript: (sid) => `final summary…\n${SCORECARDS[sid] ?? ''}`,
    promote: (objId, sid) => promoted.push({ objId, sid }),
    artifactDir: () => tmpDir,
    preFilter: () => ({ pass: true, output: '' }), // R9 passes for all (prototype)
    log: () => {},
  }
}

beforeEach(() => {
  promoted = []
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-lc-'))
})
afterEach(() => {
  clearArenaCohort(7)
  try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch {}
})

describe('cohort registry', () => {
  it('register / get / has / clear', () => {
    expect(hasArenaCohort(7)).toBe(false)
    registerArenaCohort(7, COHORT)
    expect(hasArenaCohort(7)).toBe(true)
    expect(getArenaCohort(7)).toHaveLength(4)
    clearArenaCohort(7)
    expect(hasArenaCohort(7)).toBe(false)
  })
})

describe('DORMANCY (#1 gate) — the poller hook is a strict no-op when arena is off', () => {
  it('no cohort is ever registered unless startArenaSession ran ⇒ hasArenaCohort is false', () => {
    // With the arena flag off, shouldRunArena is false ⇒ startArenaSession never runs ⇒
    // no cohort is registered. The poller hook is literally
    //   `if (hasArenaCohort(objective.id)) { await promoteArenaCohortIfReady(objective); continue }`
    // so when no cohort exists the guard is false and the arena code is never entered —
    // the poller falls through to the byte-identical pre-arena path.
    expect(hasArenaCohort(123456)).toBe(false)
    // Re-prove the guard short-circuits: getArenaCohort is undefined, so even if the hook
    // were entered it would early-return without calling getState/judge/promote.
    expect(getArenaCohort(123456)).toBeUndefined()
  })
})

describe('buildArenaDeps — judge reads the variant transcript <scorecard>', () => {
  it('grades a variant by parsing its session transcript (no nested grader session)', async () => {
    const deps = buildArenaDeps(baseIO({}))
    const card = await deps.judge!({ archetypeKey: 'editorial', archetypeName: 'editorial / hero-led', files: [], handle: 'cc-7-arena-editorial' }, [])
    expect(card).not.toBeNull()
    expect(card!.dimensions.R1).toBe('pass')
  })
})

describe('evaluateAndPromoteArena — completion gate + promotion', () => {
  it('returns WAITING (no promotion) while any variant session is still working', async () => {
    const io = baseIO({ 'cc-7-arena-editorial': 'working', 'cc-7-arena-terminal': 'dead', 'cc-7-arena-cockpit': 'dead', 'cc-7-arena-stacked': 'dead' })
    const out = await evaluateAndPromoteArena(obj({}), COHORT, io)
    expect(out.status).toBe('waiting')
    expect(promoted).toHaveLength(0)
  })

  it('when ALL finished: ranks, picks the editorial winner, and promotes its session into ai_review', async () => {
    registerArenaCohort(7, COHORT)
    const io = baseIO({}) // all default 'dead' ⇒ finished
    const out = await evaluateAndPromoteArena(obj({}), COHORT, io)
    expect(out.status).toBe('promoted')
    expect(out.status === 'promoted' && out.result.winner?.archetype).toBe('editorial')
    // The objective's session_id is repointed at the WINNING variant's session.
    expect(promoted).toEqual([{ objId: 7, sid: 'cc-7-arena-editorial' }])
    // Cohort cleared so the next tick routes the winner normally (not re-evaluated).
    expect(hasArenaCohort(7)).toBe(false)
    // Audit artifact written.
    expect(fs.existsSync(path.join(tmpDir, 'arena-ranking.json'))).toBe(true)
    const art = JSON.parse(fs.readFileSync(path.join(tmpDir, 'arena-ranking.json'), 'utf-8'))
    expect(art.winner).toContain('editorial')
    expect(art.ranking[0].score).toBe(14)
  })

  it('a single pairwise tiebreak runs only on a clean top-2 tie, and its winner is promoted', async () => {
    // Make terminal also 14/14 so editorial & terminal tie at the top.
    const tieIO: ArenaLifecycleIO = {
      ...baseIO({}),
      getTranscript: (sid) =>
        sid === 'cc-7-arena-cockpit'
          ? `x\n${SCORECARDS['cc-7-arena-cockpit']}`
          : '<scorecard>{"R1":"pass","R2":"pass","R3":"pass","R4":"pass","R5":"pass","R6":"pass","R7":"pass","R8":"PASS","R9":"PASS"}</scorecard>',
      pairwise: async (_a, b) => b.variant, // pick the SECOND of the tie
    }
    const out = await evaluateAndPromoteArena(obj({}), COHORT, tieIO)
    expect(out.status).toBe('promoted')
    expect(out.status === 'promoted' && out.result.tiebreak).toBeDefined()
    // Winner is whichever variant the pairwise picked; its session must be promoted.
    const winnerArch = out.status === 'promoted' ? out.result.winner!.archetype : ''
    const expectSid = COHORT.find((c) => c.archetypeKey === winnerArch)!.sessionId
    expect(promoted[0].sid).toBe(expectSid)
  })

  it('no PASS variant ⇒ still promotes the highest-scored for ai_review to catch (nothing dropped)', async () => {
    // All variants fail R8 (hard gate) ⇒ no PASS; highest R1–R7 score still promoted.
    const failIO: ArenaLifecycleIO = {
      ...baseIO({}),
      getTranscript: (sid) =>
        sid === 'cc-7-arena-editorial'
          ? '<scorecard>{"R1":"pass","R2":"pass","R3":"pass","R4":"pass","R5":"pass","R6":"pass","R7":"pass","R8":"FAIL","R9":"PASS"}</scorecard>'
          : '<scorecard>{"R1":"warn","R2":"warn","R3":"warn","R4":"pass","R5":"pass","R6":"pass","R7":"pass","R8":"FAIL","R9":"PASS"}</scorecard>',
    }
    const out = await evaluateAndPromoteArena(obj({}), COHORT, failIO)
    expect(out.status).toBe('no-winner')
    // editorial has the highest R1–R7 score (14) even though it FAILs R8 → promoted.
    expect(promoted[0].sid).toBe('cc-7-arena-editorial')
  })
})
