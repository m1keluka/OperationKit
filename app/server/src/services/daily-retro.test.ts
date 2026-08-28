// ── DSR pipeline integration tests (spec §D.4, tests 6-17) ───────────────────
//
// Runs the REAL initDb schema against a temp SQLite file, with synthetic
// transcripts on disk and BOTH network seams stubbed (lens runner + objective
// poster). Every assertion that matters here is a safety assertion: shadow
// posts nothing, the ledger never re-proposes, the cap drops without ledgering,
// a single lens can veto, the kill switch beats every other flag.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const TMP_DB = path.join(os.tmpdir(), `cc-daily-retro-${process.pid}-${Date.now()}.db`)
const TMP_TRANSCRIPTS = path.join(os.tmpdir(), `cc-daily-retro-tx-${process.pid}-${Date.now()}`)
process.env.DB_PATH = TMP_DB
// No ambient flag may arm the loop during tests.
for (const k of [
  'CC_DSR_ENABLED', 'CC_DSR_LIVE', 'CC_DSR_KILLED', 'CC_DSR_MIN_CONFIDENCE',
  'CC_DSR_MAX_OBJECTIVES', 'CC_DSR_WIP_CAP', 'CC_DSR_SANITY_MAX', 'CC_DSR_MAX_COST_USD',
  'CC_DSR_PARENT_OBJECTIVE_ID', 'CC_DSR_CHAT_OBJECTIVES', 'CC_DSR_TUNER_ENABLED',
]) delete process.env[k]

const { initDb, getDb } = await import('../db/index.js')
const dsr = await import('./daily-retro.js')
type LensRunner = import('./daily-retro.js').LensRunner
type ObjectivePoster = import('./daily-retro.js').ObjectivePoster

const DAY = '2026-08-07'

// ── Stubs ────────────────────────────────────────────────────────────────────

interface LensPlan {
  l1?: Partial<import('./daily-retro.js').L1Verdict>
  l1prime?: Partial<import('./daily-retro.js').L1Verdict>
  l2?: Partial<import('./daily-retro.js').L2Verdict>
  l3?: Partial<import('./daily-retro.js').L3Verdict>
  cost?: number
}

type CountingLens = LensRunner & { calls: string[] }

function makeLens(plan: LensPlan = {}): CountingLens {
  const calls: string[] = []
  const fn = (async (lens: string) => {
    calls.push(lens)
    const cost = plan.cost ?? 0
    if (lens === 'L1') {
      return { verdict: { refuted: false, is_real_defect: true, one_line_statement: 'stub defect', evidence_quote: 'q', confidence: 0.9, ...plan.l1 }, cost_usd: cost }
    }
    if (lens === "L1'") {
      return { verdict: { refuted: false, is_real_defect: true, one_line_statement: 'stub defect', evidence_quote: 'q', confidence: 0.9, ...plan.l1prime }, cost_usd: cost }
    }
    if (lens === 'L2') {
      return { verdict: { duplicate: false, already_fixed: false, duplicate_of: null, evidence: 'e', ...plan.l2 }, cost_usd: cost }
    }
    return { verdict: { remedy: 'fix_objective', scope_ok: true, priority: 'P1', rationale: 'r', ...plan.l3 }, cost_usd: cost }
  }) as unknown as CountingLens
  fn.calls = calls
  return fn
}

function makePoster(): ObjectivePoster & { posts: Record<string, unknown>[] } {
  const posts: Record<string, unknown>[] = []
  let next = 900_001
  const fn = (async (payload: Record<string, unknown>) => {
    posts.push(payload)
    return { id: next++ }
  }) as ObjectivePoster & { posts: Record<string, unknown>[] }
  fn.posts = posts
  return fn
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

function writeTranscript(sessionId: string, lines: unknown[]): void {
  fs.writeFileSync(path.join(TMP_TRANSCRIPTS, `${sessionId}.jsonl`), lines.map(l => JSON.stringify(l)).join('\n') + '\n')
}

/** Seed one objective + session_intel row + a transcript with N corrections. */
function seedSession(opts: {
  objectiveId: number
  sessionId: string
  endedAt?: string
  corrections?: string[]
  origin?: string
  outcome?: string | null
  toolErrors?: string[]
  extraLines?: unknown[]
}): void {
  const db = getDb()
  db.prepare(
    `INSERT OR REPLACE INTO objectives (id, title, description, status, agent_context, project, origin, created_at, updated_at)
     VALUES (?, ?, '', 'done', 'cto', 'command-center-infra', ?, ?, ?)`,
  ).run(opts.objectiveId, `obj ${opts.objectiveId}`, opts.origin ?? 'manual', `${DAY} 10:00:00`, `${DAY} 12:00:00`)
  db.prepare(
    `INSERT OR REPLACE INTO session_intel (objective_id, session_id, started_at, ended_at, outcome, extraction_status)
     VALUES (?, ?, ?, ?, ?, 'summarized')`,
  ).run(opts.objectiveId, opts.sessionId, `${DAY} 10:00:00`, opts.endedAt ?? `${DAY} 12:00:00`, opts.outcome ?? 'success')

  const lines: unknown[] = [{ type: 'prompt', text: 'spawn prompt' }]
  for (const c of opts.corrections ?? []) {
    lines.push({ type: 'assistant', message: { content: [{ type: 'text', text: 'All set — done.' }] } })
    lines.push({ type: 'followup', text: c })
  }
  for (const e of opts.toolErrors ?? []) {
    lines.push({ type: 'user', message: { content: [{ type: 'tool_result', is_error: true, content: e }] } })
  }
  lines.push(...(opts.extraLines ?? []))
  writeTranscript(opts.sessionId, lines)
}

function resetData(): void {
  const db = getDb()
  for (const t of ['dsr_lens_misses', 'dsr_candidates', 'dsr_fingerprints', 'dsr_signal_stats', 'dsr_runs', 'session_corrections', 'session_intel', 'objective_reviews', 'session_events', 'objectives']) {
    db.prepare(`DELETE FROM ${t}`).run()
  }
  db.prepare("UPDATE settings SET value = '0' WHERE key IN ('dsr_enabled','dsr_live','dsr_killed')").run()
  db.prepare("DELETE FROM settings WHERE key LIKE 'dsr_%' AND key NOT IN ('dsr_enabled','dsr_live','dsr_killed')").run()
  for (const f of fs.readdirSync(TMP_TRANSCRIPTS)) fs.unlinkSync(path.join(TMP_TRANSCRIPTS, f))
}

function setFlag(key: string, value: string): void {
  getDb().prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)
}

async function run(overrides: Partial<import('./daily-retro.js').RunOptions> = {}, lens = makeLens(), poster = makePoster()) {
  const result = await dsr.runDailyRetro({
    day: DAY,
    transcriptDir: TMP_TRANSCRIPTS,
    lensRunner: lens,
    poster,
    since: null, // defeat the watermark unless a test sets one explicitly
    ...overrides,
  })
  return { result, lens, poster }
}

const CORRECTION = "that's wrong — the poller should have used /app/server/src/services/x.ts"

beforeAll(() => {
  for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(TMP_DB + s) } catch { /* ignore */ } }
  fs.mkdirSync(TMP_TRANSCRIPTS, { recursive: true })
  initDb()
})

afterAll(() => {
  for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(TMP_DB + s) } catch { /* ignore */ } }
  try { fs.rmSync(TMP_TRANSCRIPTS, { recursive: true, force: true }) } catch { /* ignore */ }
})

beforeEach(() => resetData())

// ── Migration + flag defaults ────────────────────────────────────────────────

describe('migration + shipped flag defaults', () => {
  it('creates the five dsr_* tables', () => {
    const names = (getDb().prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'dsr_%'").all() as { name: string }[]).map(r => r.name)
    for (const t of ['dsr_runs', 'dsr_candidates', 'dsr_fingerprints', 'dsr_signal_stats', 'dsr_lens_misses']) {
      expect(names).toContain(t)
    }
  })

  it('ships dsr_enabled=0, dsr_live=0, dsr_killed=0', () => {
    const get = (k: string) => (getDb().prepare('SELECT value FROM settings WHERE key = ?').get(k) as { value?: string } | undefined)?.value
    expect(get('dsr_enabled')).toBe('0')
    expect(get('dsr_live')).toBe('0')
    expect(get('dsr_killed')).toBe('0')
  })

  it('flag helpers are fail-closed by default and env-overridable', () => {
    const db = getDb()
    expect(dsr.isRetroEnabled(db, {})).toBe(false)
    expect(dsr.isRetroLive(db, {})).toBe(false)
    expect(dsr.isRetroKilled(db, {})).toBe(false)
    expect(dsr.isRetroEnabled(db, { CC_DSR_ENABLED: '1' })).toBe(true)
    expect(dsr.isRetroLive(db, { CC_DSR_LIVE: 'true' })).toBe(true)
    expect(dsr.isRetroKilled(db, { CC_DSR_KILLED: 'yes' })).toBe(true)
  })

  it('is a complete no-op while dsr_enabled=0', async () => {
    seedSession({ objectiveId: 705001, sessionId: 'cc-705001-1', corrections: [CORRECTION] })
    const { result, poster } = await run()
    expect(result.skipped).toBe('disabled')
    expect(poster.posts).toHaveLength(0)
    expect((getDb().prepare('SELECT COUNT(*) n FROM dsr_runs').get() as { n: number }).n).toBe(0)
  })
})

// ── 6. Shadow mode posts nothing ─────────────────────────────────────────────

describe('shadow mode (dsr_enabled=1, dsr_live=0)', () => {
  beforeEach(() => setFlag('dsr_enabled', '1'))

  it('runs the FULL lens gate, records promoted, and posts ZERO objectives', async () => {
    seedSession({ objectiveId: 705001, sessionId: 'cc-705001-1', corrections: [CORRECTION] })
    const { result, lens, poster } = await run()
    expect(result.mode).toBe('shadow')
    expect(result.skipped).toBeNull()
    // Shadow must exercise all three lenses — the shadow output Mike reviews is
    // the actual set of objectives that WOULD be created, not a raw dump.
    expect(lens.calls).toEqual(expect.arrayContaining(['L1', 'L2', 'L3']))
    const cands = getDb().prepare("SELECT * FROM dsr_candidates WHERE verdict = 'promoted'").all() as Array<{ created_objective_id: number | null }>
    expect(cands.length).toBeGreaterThanOrEqual(1)
    expect(cands[0].created_objective_id).toBeNull()
    expect(poster.posts).toHaveLength(0)
    expect(result.created).toBe(0)
    expect((getDb().prepare('SELECT created FROM dsr_runs ORDER BY id DESC LIMIT 1').get() as { created: number }).created).toBe(0)
  })

  it('never leaks the detector confidence into a lens prompt (no anchoring)', async () => {
    seedSession({ objectiveId: 705001, sessionId: 'cc-705001-1', corrections: [CORRECTION] })
    const seen: string[] = []
    const inner = makeLens()
    const lens = Object.assign(
      async (l: Parameters<LensRunner>[0], c: Parameters<LensRunner>[1], ctx: string) => {
        seen.push(ctx)
        return inner(l, c, ctx)
      },
      { calls: inner.calls },
    ) as CountingLens
    await run({}, lens)
    expect(seen.length).toBeGreaterThan(0)
    for (const ctx of seen) expect(ctx).not.toMatch(/confidence/i)
  })
})

// ── 7. Live mode posts exactly one, back-fills created_objective_id ──────────

describe('live mode', () => {
  beforeEach(() => {
    setFlag('dsr_enabled', '1')
    setFlag('dsr_live', '1')
    setFlag('dsr_parent_objective_id', '700000')
    getDb().prepare(
      `INSERT OR REPLACE INTO objectives (id, title, description, status, agent_context, project, origin)
       VALUES (700000, 'DSR parent', '', 'working', 'cto', 'command-center-infra', 'manual')`,
    ).run()
  })

  it('posts exactly one objective with the §C.5 payload shape and back-fills the id', async () => {
    seedSession({ objectiveId: 705001, sessionId: 'cc-705001-1', corrections: [CORRECTION] })
    const { result, poster } = await run({ mode: undefined })
    expect(result.mode).toBe('live')
    expect(poster.posts).toHaveLength(1)
    const p = poster.posts[0]
    expect(p.title as string).toMatch(/^\[retro\] /)
    expect(p.project).toBe('command-center-infra')
    expect(p.origin).toBe('retro')
    expect(p.type).toBe('bug')
    expect(p.parent_id).toBe(700000)
    expect(p.description as string).toContain('<!-- dsr:')
    expect((p.acceptance_criteria as unknown[]).map((c: any) => c.id)).toEqual(['repro', 'fix', 'regress'])
    const row = getDb().prepare("SELECT created_objective_id FROM dsr_candidates WHERE verdict='promoted'").get() as { created_objective_id: number }
    expect(row.created_objective_id).toBe(900001)
    expect(result.created).toBe(1)
  })

  // 14. Live without a parent id must refuse live and fall back to shadow.
  it('refuses live when dsr_parent_objective_id is unset and falls back to shadow', async () => {
    getDb().prepare("DELETE FROM settings WHERE key = 'dsr_parent_objective_id'").run()
    seedSession({ objectiveId: 705001, sessionId: 'cc-705001-1', corrections: [CORRECTION] })
    const { result, poster } = await run({ mode: undefined })
    expect(result.mode).toBe('shadow')
    expect(result.notes).toContain('live_refused_no_parent')
    expect(poster.posts).toHaveLength(0)
  })
})

// ── 13. Kill switch beats everything ─────────────────────────────────────────

describe('kill switch', () => {
  it('returns immediately and writes zero rows even with enabled=1 live=1', async () => {
    setFlag('dsr_enabled', '1')
    setFlag('dsr_live', '1')
    setFlag('dsr_killed', '1')
    setFlag('dsr_parent_objective_id', '700000')
    seedSession({ objectiveId: 705001, sessionId: 'cc-705001-1', corrections: [CORRECTION] })
    const { result, lens, poster } = await run({ mode: undefined })
    expect(result.skipped).toBe('killed')
    expect(lens.calls).toHaveLength(0)
    expect(poster.posts).toHaveLength(0)
    expect((getDb().prepare('SELECT COUNT(*) n FROM dsr_runs').get() as { n: number }).n).toBe(0)
    expect((getDb().prepare('SELECT COUNT(*) n FROM dsr_candidates').get() as { n: number }).n).toBe(0)
  })
})

// ── 8/9/10. Ledger, watermark, cap ───────────────────────────────────────────

describe('safety brakes', () => {
  beforeEach(() => setFlag('dsr_enabled', '1'))

  it('8. ledger — a second run over the same day proposes nothing new', async () => {
    seedSession({ objectiveId: 705001, sessionId: 'cc-705001-1', corrections: [CORRECTION] })
    const first = await run()
    expect(first.result.above_floor).toBeGreaterThanOrEqual(1)
    const second = await run()
    expect(second.result.above_floor).toBe(0)
    expect(second.lens.calls).toHaveLength(0)
    expect(second.result.notes.some(n => n.startsWith('ledger_skipped:'))).toBe(true)
  })

  it('9. watermark — a session ending before the watermark is not scanned', async () => {
    seedSession({ objectiveId: 705001, sessionId: 'cc-705001-1', endedAt: `${DAY} 09:00:00`, corrections: [CORRECTION] })
    seedSession({ objectiveId: 705002, sessionId: 'cc-705002-1', endedAt: `${DAY} 20:00:00`, corrections: [CORRECTION.replace('x.ts', 'y.ts')] })
    const { result } = await run({ since: `${DAY} 12:00:00` })
    expect(result.sessions_scanned).toBe(1)
    const sources = result.candidates.map(c => c.source_objective_id)
    expect(sources).toContain(705002)
    expect(sources).not.toContain(705001)
  })

  it('9b. the watermark advances to the newest ended_at seen', async () => {
    seedSession({ objectiveId: 705002, sessionId: 'cc-705002-1', endedAt: `${DAY} 20:00:00`, corrections: [CORRECTION] })
    await run()
    const wm = (getDb().prepare('SELECT watermark_at FROM dsr_runs ORDER BY id DESC LIMIT 1').get() as { watermark_at: string }).watermark_at
    expect(wm).toBe(`${DAY} 20:00:00`)
  })

  it('10. cap — over-cap candidates are dropped, NOT ledgered, and resurface', async () => {
    for (let i = 0; i < 12; i++) {
      seedSession({
        objectiveId: 705100 + i,
        sessionId: `cc-${705100 + i}-1`,
        corrections: [`that's wrong — module /app/server/src/services/mod${i}.ts should have exported foo`],
      })
    }
    const { result, poster } = await run({ max: 3 })
    expect(result.above_floor).toBe(12)
    const promoted = result.candidates.filter(c => c.verdict === 'promoted')
    const dropped = result.candidates.filter(c => c.verdict === 'dropped_cap')
    expect(promoted).toHaveLength(3)
    expect(dropped).toHaveLength(9)
    expect(result.dropped_by_cap).toBe(9)
    expect(poster.posts).toHaveLength(0) // shadow

    // The 9 dropped fingerprints must be ABSENT from the ledger…
    const ledgered = new Set((getDb().prepare('SELECT fingerprint FROM dsr_fingerprints').all() as { fingerprint: string }[]).map(r => r.fingerprint))
    expect(ledgered.size).toBe(3)
    for (const d of dropped) expect(ledgered.has(d.fingerprint)).toBe(false)

    // …so the next run re-proposes exactly those 9.
    const next = await run({ max: 3 })
    expect(next.result.above_floor).toBe(9)
  })

  it('sanity brake — aborts and writes no candidates above dsr_sanity_max', async () => {
    setFlag('dsr_sanity_max', '2')
    for (let i = 0; i < 6; i++) {
      seedSession({
        objectiveId: 705200 + i,
        sessionId: `cc-${705200 + i}-1`,
        corrections: [`that's wrong — file /app/src/s${i}.ts should have been updated`],
      })
    }
    const { result, lens } = await run()
    expect(result.skipped).toMatch(/^sanity abort/)
    expect(lens.calls).toHaveLength(0)
    expect((getDb().prepare('SELECT COUNT(*) n FROM dsr_candidates').get() as { n: number }).n).toBe(0)
  })

  it('15. WIP brake — skips the run when open retro objectives reach the cap', async () => {
    const db = getDb()
    for (let i = 0; i < 8; i++) {
      db.prepare(
        `INSERT INTO objectives (title, description, status, agent_context, project, origin)
         VALUES (?, '', 'queue', 'cto', 'command-center-infra', 'retro')`,
      ).run(`[retro] open ${i}`)
    }
    seedSession({ objectiveId: 705001, sessionId: 'cc-705001-1', corrections: [CORRECTION] })
    const { result, lens } = await run()
    expect(result.skipped).toMatch(/^wip_cap:8>=8/)
    expect(lens.calls).toHaveLength(0)
  })

  it('self-exclusion — a source objective with origin=retro is never a source', async () => {
    seedSession({ objectiveId: 705001, sessionId: 'cc-705001-1', corrections: [CORRECTION], origin: 'retro' })
    const { result } = await run()
    expect(result.sessions_scanned).toBe(0)
    expect(result.above_floor).toBe(0)
  })

  it('cost ceiling — truncates loudly and records the note', async () => {
    setFlag('dsr_max_cost_usd', '0.02')
    for (let i = 0; i < 5; i++) {
      seedSession({
        objectiveId: 705300 + i,
        sessionId: `cc-${705300 + i}-1`,
        corrections: [`that's wrong — /app/src/c${i}.ts should have compiled`],
      })
    }
    const { result } = await run({ max: 99 }, makeLens({ cost: 0.03 }))
    expect(result.notes.some(n => n.startsWith('cost_ceiling_truncated:'))).toBe(true)
    expect(result.candidates.length).toBeLessThan(5)
  })

  it('chat-objective penalty — obj 1432 followups fall below the floor', async () => {
    setFlag('dsr_chat_objectives', '705001')
    seedSession({ objectiveId: 705001, sessionId: 'cc-705001-1', corrections: [CORRECTION] })
    const { result } = await run()
    expect(result.raw_signals).toBeGreaterThan(0) // detected…
    expect(result.above_floor).toBe(0) // …but penalised below the floor
  })
})

// ── 11/12. Lens vetoes and the split-vote hold ───────────────────────────────

describe('review gate vetoes and routing', () => {
  beforeEach(() => {
    setFlag('dsr_enabled', '1')
    seedSession({ objectiveId: 705001, sessionId: 'cc-705001-1', corrections: [CORRECTION] })
  })

  it('11a. L1 refuted → killed AND ledgered', async () => {
    const { result } = await run({}, makeLens({ l1: { refuted: true, is_real_defect: false } }))
    expect(result.lens_killed).toBe(1)
    expect(result.candidates[0].verdict).toBe('killed')
    const led = getDb().prepare('SELECT disposition FROM dsr_fingerprints').all() as { disposition: string }[]
    expect(led).toHaveLength(1)
    expect(led[0].disposition).toBe('killed')
  })

  it('11b. L2 duplicate → killed AND ledgered', async () => {
    const { result } = await run({}, makeLens({ l2: { duplicate: true, duplicate_of: 12345 } }))
    expect(result.candidates[0].verdict).toBe('killed')
    expect((getDb().prepare('SELECT COUNT(*) n FROM dsr_fingerprints').get() as { n: number }).n).toBe(1)
  })

  it('11b-2. L2 already_fixed → killed', async () => {
    const { result } = await run({}, makeLens({ l2: { already_fixed: true } }))
    expect(result.candidates[0].verdict).toBe('killed')
  })

  it('11c. L3 skill_edit → routed_correction AND a session_corrections row', async () => {
    const { result, poster } = await run({}, makeLens({ l3: { remedy: 'skill_edit' } }))
    expect(result.candidates[0].verdict).toBe('routed_correction')
    expect(result.routed_corrections).toBe(1)
    expect(poster.posts).toHaveLength(0)
    const corr = getDb().prepare('SELECT objective_id, label FROM session_corrections').all() as { objective_id: number; label: string }[]
    expect(corr).toHaveLength(1)
    expect(corr[0].objective_id).toBe(705001)
    expect(corr[0].label).toMatch(/^\[retro\] /)
    expect(corr[0].label).toMatch(/skill_edit/)
  })

  it('11d. L3 no_action → killed, no correction written', async () => {
    const { result } = await run({}, makeLens({ l3: { remedy: 'no_action' } }))
    expect(result.candidates[0].verdict).toBe('killed')
    expect((getDb().prepare('SELECT COUNT(*) n FROM session_corrections').get() as { n: number }).n).toBe(0)
  })

  it('12. L1 low-confidence + L1-prime refutes → held, NOT ledgered', async () => {
    const lens = makeLens({ l1: { confidence: 0.4 }, l1prime: { refuted: true, is_real_defect: false } })
    const { result } = await run({}, lens)
    expect(lens.calls).toContain("L1'")
    expect(result.held).toBe(1)
    expect(result.candidates[0].verdict).toBe('held')
    // Held candidates MUST stay out of the ledger so they resurface.
    expect((getDb().prepare('SELECT COUNT(*) n FROM dsr_fingerprints').get() as { n: number }).n).toBe(0)
    const next = await run()
    expect(next.result.above_floor).toBe(1)
  })

  it('12b. L1 low-confidence + L1-prime agrees → still promoted (2-of-2)', async () => {
    const lens = makeLens({ l1: { confidence: 0.4 } })
    const { result } = await run({}, lens)
    expect(lens.calls).toContain("L1'")
    expect(result.candidates[0].verdict).toBe('promoted')
  })

  it('L1-prime is NOT run when L1 is confident', async () => {
    const lens = makeLens({ l1: { confidence: 0.9 } })
    await run({}, lens)
    expect(lens.calls).not.toContain("L1'")
  })
})

// ── D-5: L2 must never be able to self-duplicate ─────────────────────────────
//
// Regression for the shipped bug (merge c10425f): L2 read `source: objective
// <ID>` out of its own evidence header and returned that same id as
// `duplicate_of`, so EVERY candidate was vetoed as a duplicate of itself and
// the loop could never promote anything (32/32 killed on 2026-08-07).

describe('L2 self-duplicate (D-5)', () => {
  const SOURCE = 705001

  beforeEach(() => {
    setFlag('dsr_enabled', '1')
    seedSession({ objectiveId: SOURCE, sessionId: 'cc-705001-1', corrections: [CORRECTION] })
  })

  /**
   * Faithful model of the real lens: it reads an objective id out of whatever
   * context it is handed and calls the candidate a duplicate of it. Against the
   * PRE-FIX gate (source line present) this kills 100% of candidates.
   */
  function echoingLens(): CountingLens {
    const base = makeLens()
    const calls: string[] = []
    const fn = (async (lens: string, candidate: unknown, context: string) => {
      calls.push(lens)
      if (lens !== 'L2') return base(lens as never, candidate as never, context)
      const m = /source: objective (\d+)/.exec(context)
      return m
        ? { verdict: { duplicate: true, already_fixed: false, duplicate_of: Number(m[1]), evidence: `objective ${m[1]} already tracks this` }, cost_usd: 0 }
        : { verdict: { duplicate: false, already_fixed: false, duplicate_of: null, evidence: 'no matching open objective' }, cost_usd: 0 }
    }) as unknown as CountingLens
    fn.calls = calls
    return fn
  }

  it('D5-a. the source objective id is withheld from L2 (was: echoed back as duplicate_of)', async () => {
    let l2Context = ''
    const lens = makeLens()
    const spy = (async (lensName: string, candidate: unknown, context: string) => {
      if (lensName === 'L2') l2Context = context
      return lens(lensName as never, candidate as never, context)
    }) as unknown as LensRunner
    await run({}, spy as CountingLens)
    expect(l2Context).not.toContain(`objective ${SOURCE}`)
    expect(l2Context).toContain('source: (withheld')
  })

  it('D5-b. a lens that echoes the source id no longer kills the candidate', async () => {
    const { result, poster } = await run({}, echoingLens())
    expect(result.candidates[0].verdict).toBe('promoted')
    expect(result.lens_killed).toBe(0)
    // Shadow mode — promotion is a verdict, not a board write.
    expect(poster.posts).toHaveLength(0)
  })

  it('D5-c. NEGATIVE CONTROL — a genuinely similar OTHER objective still kills it', async () => {
    const { result } = await run({}, makeLens({ l2: { duplicate: true, duplicate_of: 704111, evidence: 'objective 704111 covers this' } }))
    expect(result.candidates[0].verdict).toBe('killed')
    expect(result.lens_killed).toBe(1)
  })

  it('D5-d. a self-referential duplicate_of that leaks through anyway is suppressed', async () => {
    const { result } = await run({}, makeLens({ l2: { duplicate: true, duplicate_of: SOURCE } }))
    expect(result.candidates[0].verdict).toBe('promoted')
    const l2 = JSON.parse((getDb().prepare('SELECT lens_l2 FROM dsr_candidates').get() as { lens_l2: string }).lens_l2)
    expect(l2.duplicate).toBe(false)
    expect(l2.evidence).toMatch(/self-duplicate suppressed/)
  })

  /** A prior retro run that already turned SOURCE into board objective `childId`. */
  function seedPriorRetroChild(fp: string, childId: number): void {
    const db = getDb()
    const runId = db.prepare(`INSERT INTO dsr_runs (target_day) VALUES ('2026-08-06')`).run().lastInsertRowid as number
    db.prepare(
      `INSERT INTO dsr_candidates (run_id, fingerprint, signal_type, confidence, recurrence,
        source_objective_id, created_objective_id, verdict)
       VALUES (?, ?, 'agent_self_correction', 0.9, 1, ?, ?, 'promoted')`,
    ).run(runId, fp, SOURCE, childId)
  }

  it('D5-e. an objective a PRIOR retro run created from the same source is also self-referential', async () => {
    seedPriorRetroChild('prior-fp', 999111)
    const { result } = await run({}, makeLens({ l2: { duplicate: true, duplicate_of: 999111 } }))
    expect(result.candidates[0].verdict).toBe('promoted')
  })

  it('D5-f. board context drops self-referential rows, keeps every other objective', () => {
    const ctx = [
      'Recent objectives (id | status | title):',
      `${SOURCE} | done | obj ${SOURCE}`,
      '999111 | working | retro child',
      '704111 | working | some other objective',
      'Known learnings:',
      '- a learning',
    ].join('\n')
    const filtered = dsr.filterBoardContext(ctx, new Set([SOURCE, 999111]))
    expect(filtered).not.toContain(`${SOURCE} | done`)
    expect(filtered).not.toContain('999111 | working')
    expect(filtered).toContain('704111 | working | some other objective')
    expect(filtered).toContain('Known learnings:')
  })

  it('D5-g. selfExclusionIds = source + prior retro children; empty when no source', () => {
    seedPriorRetroChild('prior-fp2', 999222)
    const base = { fingerprint: 'f', signal_type: 'review_failure', confidence: 0.9, recurrence: 1, source_session_id: 's', transcript_path: null, excerpt: 'e', window: 'w' }
    const ids = dsr.selfExclusionIds({ ...base, source_objective_id: SOURCE } as never, getDb())
    expect([...ids].sort()).toEqual([SOURCE, 999222].sort())
    expect(dsr.selfExclusionIds({ ...base, source_objective_id: null } as never, getDb()).size).toBe(0)
  })
})

// ── Detection behaviour ──────────────────────────────────────────────────────

describe('detection', () => {
  beforeEach(() => setFlag('dsr_enabled', '1'))

  it('the same defect across five sessions collapses to ONE candidate', async () => {
    for (let i = 0; i < 5; i++) {
      seedSession({ objectiveId: 705400 + i, sessionId: `cc-${705400 + i}-1`, corrections: [CORRECTION] })
    }
    const { result } = await run()
    expect(result.raw_signals).toBe(5)
    expect(result.above_floor).toBe(1)
    expect(result.candidates[0].recurrence).toBe(5)
  })

  it('AUTO followups produce no human_correction candidate', async () => {
    seedSession({
      objectiveId: 705001,
      sessionId: 'cc-705001-1',
      corrections: ['[child-complete] worker done', 'AUTO-RESUME: continuing'],
    })
    const { result } = await run()
    expect(result.candidates.filter(c => c.signal_type === 'human_correction')).toHaveLength(0)
  })

  it('counts unclassified followups so classifier drift is visible', async () => {
    seedSession({
      objectiveId: 705001,
      sessionId: 'cc-705001-1',
      corrections: ['[some-new-automated-prefix] please continue', 'and also add a chart'],
    })
    const { result } = await run()
    // Neither matches an AUTO pattern nor carries corrective phrasing → both are
    // "unclassified" and neither becomes a false human correction.
    expect(result.unclassified_followups).toBe(2)
    expect(result.candidates.filter(c => c.signal_type === 'human_correction')).toHaveLength(0)
  })

  it('harness-noise tool errors stay below the floor; a stuck loop clears it', async () => {
    seedSession({
      objectiveId: 705001,
      sessionId: 'cc-705001-1',
      toolErrors: ['Exit code 127\n===\nsqlite3: command not found'],
    })
    seedSession({
      objectiveId: 705002,
      sessionId: 'cc-705002-1',
      toolErrors: [
        "ENOENT: no such file or directory, open '/app/server/src/services/missing.ts'",
        "ENOENT: no such file or directory, open '/app/server/src/services/missing.ts'",
        "ENOENT: no such file or directory, open '/app/server/src/services/missing.ts'",
      ],
    })
    const { result } = await run()
    const above = result.candidates.filter(c => c.verdict !== 'dropped_cap')
    expect(above.every(c => !/command not found/.test(c.excerpt))).toBe(true)
    expect(above.some(c => /missing\.ts/.test(c.excerpt))).toBe(true)
  })

  it('D4 — a failed review is detected from objective_reviews', async () => {
    const db = getDb()
    db.prepare(
      `INSERT INTO objectives (id, title, description, status, agent_context, project, origin)
       VALUES (705500, 'broken thing', '', 'review', 'cto', 'command-center-infra', 'manual')`,
    ).run()
    db.prepare(
      `INSERT INTO objective_reviews (objective_id, reviewer_session_id, mode, verdict, markdown_body, iteration, created_at)
       VALUES (705500, 'cc-review-705500-1', 'browser', 'fail', 'the drawer never opened', 1, ?)`,
    ).run(`${DAY} 11:00:00`)
    const { result } = await run()
    const d4 = result.candidates.find(c => c.signal_type === 'review_failure')
    expect(d4).toBeTruthy()
    expect(d4!.confidence).toBeCloseTo(0.85, 5) // 0.75 + 0.10 browser
  })

  it('D7 max-turns is recorded but never reaches the floor', async () => {
    seedSession({
      objectiveId: 705001,
      sessionId: 'cc-705001-1',
      corrections: ['Claude reached maximum number of turns for this session'],
    })
    const { result } = await run()
    expect(result.raw_signals).toBeGreaterThan(0)
    expect(result.above_floor).toBe(0)
  })
})

// ── 16. Tuner ────────────────────────────────────────────────────────────────

describe('16. precision tuner (deterministic, bounded)', () => {
  function seedGraded(signal: string, tp: number, fp: number): void {
    const db = getDb()
    const runId = db.prepare("INSERT INTO dsr_runs (mode, target_day) VALUES ('live', ?)").run(DAY).lastInsertRowid as number
    let n = 0
    const mk = (status: string) => {
      n++
      const oid = 706000 + n + (signal === 'tool_error' ? 0 : 500)
      db.prepare(
        `INSERT INTO objectives (id, title, description, status, agent_context, project, origin, ai_review_verdict, created_at)
         VALUES (?, '[retro] x', '', ?, 'cto', 'command-center-infra', 'retro', 'pass', datetime('now','-5 days'))`,
      ).run(oid, status)
      db.prepare(
        `INSERT INTO dsr_candidates (run_id, fingerprint, signal_type, confidence, created_objective_id, verdict)
         VALUES (?, ?, ?, 0.7, ?, 'promoted')`,
      ).run(runId, `fp-${signal}-${n}`, signal, oid)
    }
    for (let i = 0; i < tp; i++) mk('done')
    for (let i = 0; i < fp; i++) mk('cancelled')
  }

  it('raises the threshold by 0.05 when precision < 0.5 with n >= 6', () => {
    seedGraded('tool_error', 2, 5) // precision 2/7 = 0.286 but n=7 < 10 → raise, not disable
    const t = dsr.tunePrecision(getDb())
    const row = getDb().prepare("SELECT * FROM dsr_signal_stats WHERE signal_type='tool_error'").get() as { precision: number; current_threshold: number }
    expect(row.precision).toBeLessThan(0.5)
    expect(row.current_threshold).toBeCloseTo(0.65, 5)
    expect(t.adjustments[0].to).toBeCloseTo(0.65, 5)
  })

  it('auto-disables a signal at 1.01 when precision < 0.3 with n >= 10', () => {
    seedGraded('tool_error', 2, 9) // 2/11 = 0.18, n = 11
    dsr.tunePrecision(getDb())
    const row = getDb().prepare("SELECT * FROM dsr_signal_stats WHERE signal_type='tool_error'").get() as { current_threshold: number; note: string }
    expect(row.current_threshold).toBeCloseTo(1.01, 5)
    expect(row.note).toMatch(/auto-disabled/)
  })

  it('lowers the threshold when precision > 0.85, floored at 0.40', () => {
    seedGraded('human_correction', 9, 0)
    dsr.tunePrecision(getDb())
    const row = getDb().prepare("SELECT * FROM dsr_signal_stats WHERE signal_type='human_correction'").get() as { current_threshold: number }
    expect(row.current_threshold).toBeCloseTo(0.55, 5)
  })

  it('does not move a threshold below the n >= 6 sample floor', () => {
    seedGraded('escalation', 0, 3)
    dsr.tunePrecision(getDb())
    const row = getDb().prepare("SELECT * FROM dsr_signal_stats WHERE signal_type='escalation'").get() as { current_threshold: number }
    expect(row.current_threshold).toBeCloseTo(0.60, 5)
  })

  it('records one lens miss per FP, idempotently', () => {
    seedGraded('tool_error', 2, 5)
    const first = dsr.tunePrecision(getDb())
    expect(first.lens_misses_recorded).toBe(5)
    const second = dsr.tunePrecision(getDb())
    expect(second.lens_misses_recorded).toBe(0)
    expect((getDb().prepare('SELECT COUNT(*) n FROM dsr_lens_misses').get() as { n: number }).n).toBe(5)
  })

  it('an auto-disabled signal is then filtered out by effectiveThreshold', () => {
    seedGraded('tool_error', 2, 9)
    dsr.tunePrecision(getDb())
    expect(dsr.effectiveThreshold(getDb(), 'tool_error', 0.6)).toBeCloseTo(1.01, 5)
    expect(dsr.effectiveThreshold(getDb(), 'human_correction', 0.6)).toBeCloseTo(0.6, 5)
  })
})

// ── Dry run ──────────────────────────────────────────────────────────────────

describe('dry run (the CLI path)', () => {
  it('runs the full gate while dsr_enabled=0 and writes NOTHING', async () => {
    seedSession({ objectiveId: 705001, sessionId: 'cc-705001-1', corrections: [CORRECTION] })
    const { result, lens, poster } = await run({ dryRun: true })
    expect(result.skipped).toBeNull()
    expect(lens.calls).toEqual(expect.arrayContaining(['L1', 'L2', 'L3']))
    expect(result.candidates.filter(c => c.verdict === 'promoted')).toHaveLength(1)
    expect(result.candidates[0].would_create).toBeTruthy()
    expect(poster.posts).toHaveLength(0)
    const db = getDb()
    for (const t of ['dsr_runs', 'dsr_candidates', 'dsr_fingerprints', 'session_corrections']) {
      expect((db.prepare(`SELECT COUNT(*) n FROM ${t}`).get() as { n: number }).n).toBe(0)
    }
  })
})
