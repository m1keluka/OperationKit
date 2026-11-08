/**
 * obj 900322 (corrections round) — BOUNDED EXECUTION AT RUN TIME.
 *
 * The first round stored a ceiling and shipped an `evaluateCeiling` helper, but
 * nothing in the runner ever fed `elapsed_ms` or `spent_usd`, so "a running job
 * is stopped at its ceiling" was a claim about a helper rather than about the
 * runner: the only way to exceed a ceiling was for a test to write the number
 * itself. These tests drive `enforceRunningCeiling` — the function the poller's
 * live `working` branch calls on every tick — over a real migrated DB, a real
 * `session_spawns` clock and the real teardown ledger.
 *
 * What is deliberately NOT claimed here: a dollar hard stop. Nothing in this
 * system collects measured provider spend (sessions run on subscription seats
 * through the CLI; there is no billing feed into this process), so the cost
 * ceiling gates only explicitly recorded estimates. The ENFORCED dimension is
 * TIME, measured on our own clock, and the tests say which is which.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-exec-b-runtime-'))
process.env.DB_PATH = path.join(TMP, 'db.sqlite')
process.env.JWT_SECRET = 'test-secret-900322-rt'
process.env.TRANSCRIPT_DIR = TMP
process.env.PROJECTS_DIR = TMP

const broadcastMock = vi.fn()
vi.mock('../ws/index.js', () => ({
  broadcast: (...a: unknown[]) => broadcastMock(...a),
  broadcastToObjective: vi.fn(),
}))
vi.mock('./notifier.js', () => ({ sendTelegram: vi.fn(), insertAlert: vi.fn() }))
vi.mock('./session-intel-pipeline.js', () => ({ queueExtraction: vi.fn() }))

// The tmux killer is the ONE side effect we refuse to perform for real. It is
// recorded by exact name so "cancel stops only the card's own worker" is a
// checkable assertion rather than a hope.
const killedTmux: string[] = []
vi.mock('./session-control.js', async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>)
  return {
    ...actual,
    killTmuxByName: (name: string) => { killedTmux.push(name); return true },
  }
})

const { getDb, initDb } = await import('../db/index.js')
const { enforceRunningCeiling, handleDeadSessionOutcome, noopRespawnCounts } = await import('./poller-loop.js')
const { teardownObjectiveJob } = await import('./job-teardown.js')
const { MAX_NOOP_RESPAWNS } = await import('./poller-decisions.js')
const { getAttempts } = await import('./job-accounting.js')
const {
  setObjectiveCeiling, observeSessionElapsed, getSpend, evaluateCeiling,
  getObservedSessionMs, describeCeilingSupport, resolveConfiguredCeiling,
  CEILING_ENFORCEMENT, recordSpend,
} = await import('./job-accounting.js')
const { recordSessionSpawn } = await import('./session-spawn-clock.js')

beforeAll(() => { initDb() })
afterAll(() => {
  try { getDb().close() } catch { /* ignore */ }
  fs.rmSync(TMP, { recursive: true, force: true })
})
beforeEach(() => { broadcastMock.mockClear(); killedTmux.length = 0 })

let nextId = 9200322
function seedWorking(opts: { sessionId?: string; workspace?: string } = {}) {
  const db = getDb()
  const id = nextId++
  const sessionId = opts.sessionId ?? `cc-${id}-s1`
  db.prepare(
    `INSERT INTO objectives (id, title, type, status, effort, session_id, project, workspace, create_pr, delegate_mode)
     VALUES (?, ?, 'task', 'working', 'normal', ?, 'operationkit', ?, 0, 0)`,
  ).run(id, `obj ${id}`, sessionId, opts.workspace ?? 'operationkit')
  // The card owns its session lease, exactly as a live spawn would.
  db.prepare(
    `INSERT INTO session_leases (lease_key, objective_id, session_id, tmux_name) VALUES (?, ?, ?, ?)`,
  ).run(`obj:${id}`, id, sessionId, sessionId)
  return { id, sessionId }
}

function cardOf(id: number) {
  return getDb().prepare('SELECT * FROM objectives WHERE id = ?').get(id) as {
    status: string; session_id: string | null; ai_review_verdict: string | null
    ai_review_findings: string | null; has_blockers: number
  }
}

/** A live spawn that started `ms` ago, as the restart-durable clock sees it. */
function spawnStartedMsAgo(sessionId: string, ms: number) {
  recordSessionSpawn(getDb(), sessionId, Date.now() - ms)
}

function openLeases(id: number): number {
  return (getDb()
    .prepare('SELECT COUNT(*) AS n FROM session_leases WHERE objective_id = ? AND released_at IS NULL')
    .get(id) as { n: number }).n
}

function teardownRows(id: number) {
  return getDb()
    .prepare('SELECT reason, killed_tmux, leases_released FROM objective_job_teardowns WHERE objective_id = ? ORDER BY id')
    .all(id) as { reason: string; killed_tmux: number; leases_released: number }[]
}

// ───────────────────────────────────────────────────────────────────────────
// G12 — a running job is actually stopped at its configured TIME ceiling
// ───────────────────────────────────────────────────────────────────────────

describe('G12 — running wall-clock ceiling, enforced on the live poller branch', () => {
  it('a card with NO configured ceiling is never stopped — absent is not exceeded', async () => {
    const { id, sessionId } = seedWorking()
    spawnStartedMsAgo(sessionId, 10 * 60 * 60 * 1000) // ten hours, no budget set
    expect(await enforceRunningCeiling(cardRow(id))).toBe(false)
    expect(cardOf(id).status).toBe('working')
    expect(resolveConfiguredCeiling(getDb(), id, 'operationkit').source).toBe('none')
  })

  it('under its ceiling, the job runs on and the tick is a no-op', async () => {
    const { id, sessionId } = seedWorking()
    setObjectiveCeiling(getDb(), id, { wallclockMs: 60 * 60 * 1000 })
    spawnStartedMsAgo(sessionId, 5 * 60 * 1000)
    expect(await enforceRunningCeiling(cardRow(id))).toBe(false)
    expect(cardOf(id).status).toBe('working')
    expect(cardOf(id).session_id).toBe(sessionId) // nothing torn down
  })

  it('OVER its ceiling, the LIVE job is stopped, blocked with measured numbers, and torn down', async () => {
    const { id, sessionId } = seedWorking()
    setObjectiveCeiling(getDb(), id, { wallclockMs: 10 * 60 * 1000 }) // 10 min
    spawnStartedMsAgo(sessionId, 25 * 60 * 1000)                      // 25 min in

    expect(await enforceRunningCeiling(cardRow(id))).toBe(true)

    const card = cardOf(id)
    // Human review semantics preserved: blocked for a person, NOT auto-done.
    expect(card.status).toBe('review')
    expect(card.ai_review_verdict).toBe('blocked')
    expect(card.has_blockers).toBe(1)
    expect(card.ai_review_findings).toContain('Wall-clock ceiling reached')
    expect(card.ai_review_findings).toContain('1500s')   // the measured number
    expect(card.ai_review_findings).toContain('600s')    // against the configured one
    expect(card.ai_review_findings).toContain('ENFORCES')

    // It tore down only what this card owns, exactly once, and said so.
    expect(killedTmux).toEqual([sessionId])
    expect(openLeases(id)).toBe(0)
    expect(card.session_id).toBeNull()
    expect(teardownRows(id).map(r => r.reason)).toEqual([`ceiling:${sessionId}`])
    expect(broadcastMock).toHaveBeenCalled()
  })

  it('a neighbouring card is untouched by another card hitting its ceiling', async () => {
    const neighbour = seedWorking()
    const { id, sessionId } = seedWorking()
    setObjectiveCeiling(getDb(), id, { wallclockMs: 1_000 })
    spawnStartedMsAgo(sessionId, 60_000)

    await enforceRunningCeiling(cardRow(id))

    expect(killedTmux).toEqual([sessionId])
    expect(killedTmux).not.toContain(neighbour.sessionId)
    expect(cardOf(neighbour.id).status).toBe('working')
    expect(cardOf(neighbour.id).session_id).toBe(neighbour.sessionId)
    expect(openLeases(neighbour.id)).toBe(1)
  })

  it('re-ticking an over-budget card does not re-tear-down or duplicate the ledger', async () => {
    const { id, sessionId } = seedWorking()
    setObjectiveCeiling(getDb(), id, { wallclockMs: 1_000 })
    spawnStartedMsAgo(sessionId, 60_000)

    const row = cardRow(id)
    await enforceRunningCeiling(row)
    killedTmux.length = 0
    await enforceRunningCeiling(row) // the poller re-selects every 3s
    await enforceRunningCeiling(row)

    expect(teardownRows(id)).toHaveLength(1)   // exactly once
    expect(killedTmux).toHaveLength(0)         // and no second kill
  })
})

// ───────────────────────────────────────────────────────────────────────────
// Cumulative accounting: a retry must not refill the budget
// ───────────────────────────────────────────────────────────────────────────

describe('cumulative accounting across ticks, retries, resumes and restarts', () => {
  it('ticking the same session repeatedly does not inflate elapsed time', async () => {
    const { id, sessionId } = seedWorking()
    setObjectiveCeiling(getDb(), id, { wallclockMs: 60 * 60 * 1000 })
    spawnStartedMsAgo(sessionId, 5 * 60 * 1000)

    for (let i = 0; i < 20; i++) await enforceRunningCeiling(cardRow(id))

    // ~5 minutes, NOT 20 × 5 minutes. The observation is idempotent per session.
    const { elapsedMs } = getSpend(getDb(), id)
    expect(elapsedMs).toBeGreaterThanOrEqual(5 * 60 * 1000)
    expect(elapsedMs).toBeLessThan(6 * 60 * 1000)
  })

  it('a RETRY under a new session id ADDS to the total — it cannot reset the budget', async () => {
    const { id, sessionId } = seedWorking()
    setObjectiveCeiling(getDb(), id, { wallclockMs: 100_000 })

    // Attempt 1 burns 60s and dies.
    observeSessionElapsed(getDb(), id, sessionId, 60_000)
    expect(evaluateCeiling(getDb(), id).state).toBe('ok')

    // Attempt 2 is a fresh session id — the naive design would start from zero.
    const retrySession = `${sessionId}-retry`
    getDb().prepare('UPDATE objectives SET session_id = ? WHERE id = ?').run(retrySession, id)
    observeSessionElapsed(getDb(), id, retrySession, 50_000)

    expect(getObservedSessionMs(getDb(), id)).toBe(110_000)
    const v = evaluateCeiling(getDb(), id)
    expect(v.state).toBe('exceeded')             // 110s against a 100s budget
    expect(v.reason).toContain('110s')
  })

  it('a RESUME of the same session converges rather than double-counting', () => {
    const { id, sessionId } = seedWorking()
    observeSessionElapsed(getDb(), id, sessionId, 30_000)
    observeSessionElapsed(getDb(), id, sessionId, 45_000) // same session, later read
    expect(getObservedSessionMs(getDb(), id)).toBe(45_000)
    observeSessionElapsed(getDb(), id, sessionId, 10_000) // a stale/backwards read
    expect(getObservedSessionMs(getDb(), id)).toBe(45_000) // never goes down
  })

  it('a server RESTART does not reset the total — the ledger is the DB, not a Map', async () => {
    const { id, sessionId } = seedWorking()
    setObjectiveCeiling(getDb(), id, { wallclockMs: 100_000 })
    observeSessionElapsed(getDb(), id, sessionId, 80_000)

    // "Restart": a fresh module instance, no in-memory state carried over.
    vi.resetModules()
    const fresh = await import('./job-accounting.js')
    expect(fresh.getObservedSessionMs(getDb(), id)).toBe(80_000)

    // The post-restart continuation adds to the SAME total and trips the budget.
    fresh.observeSessionElapsed(getDb(), id, `${sessionId}-after-restart`, 30_000)
    expect(fresh.evaluateCeiling(getDb(), id).state).toBe('exceeded')
  })
})

// ───────────────────────────────────────────────────────────────────────────
// What a ceiling can honestly promise
// ───────────────────────────────────────────────────────────────────────────

describe('the dollar guarantee is separated from the time guarantee', () => {
  it('declares time ENFORCED and cost ADVISORY, and never calls cost a billing cap', () => {
    expect(CEILING_ENFORCEMENT).toEqual({ time: 'enforced', cost: 'advisory' })
    const { id } = seedWorking()
    setObjectiveCeiling(getDb(), id, { wallclockMs: 600_000, costUsd: 5 })
    const text = describeCeilingSupport(resolveConfiguredCeiling(getDb(), id))
    expect(text).toContain('ENFORCES')
    expect(text).toContain('ADVISORY')
    expect(text).toContain('not a billing cap')
  })

  it('a cost ceiling gates only EXPLICITLY RECORDED spend — nothing measures a seat', async () => {
    const { id, sessionId } = seedWorking()
    setObjectiveCeiling(getDb(), id, { costUsd: 1 })
    spawnStartedMsAgo(sessionId, 10 * 60 * 60 * 1000) // ten hours of real runtime

    // No provider feed exists, so ten hours of work records $0 and the cost
    // ceiling does not fire. This test documents the gap rather than hiding it.
    expect(await enforceRunningCeiling(cardRow(id))).toBe(false)
    expect(getSpend(getDb(), id).spentUsd).toBe(0)

    // It fires only once something explicitly records an estimate.
    recordSpend(getDb(), id, { usd: 2 })
    expect(await enforceRunningCeiling(cardRow(id))).toBe(true)
    expect(cardOf(id).ai_review_findings).toContain('Cost ceiling reached')
  })
})

// ───────────────────────────────────────────────────────────────────────────
// Restart-then-cancel, and bounded crash recovery
// ───────────────────────────────────────────────────────────────────────────

describe('restart-then-cancel and crash recovery (G10)', () => {
  it('cancel after a RESTART still kills the card’s own tmux and releases its lease', async () => {
    const { id, sessionId } = seedWorking()
    const neighbour = seedWorking()

    // "Restart": nothing in memory knows about this session any more. Teardown
    // must work off durable state alone.
    vi.resetModules()
    const fresh = await import('./job-teardown.js')
    const killed: string[] = []
    const res = fresh.teardownObjectiveJob(getDb(), id, 'status:cancelled', {
      killTmux: (n: string) => { killed.push(n); return true },
      releaseBranchLeases: () => {},
      releaseSessionLeases: (db, objId) => {
        db.prepare("UPDATE session_leases SET released_at = datetime('now') WHERE objective_id = ? AND released_at IS NULL").run(objId)
      },
    })

    expect(res.performed).toBe(true)
    expect(killed).toEqual([sessionId])
    expect(killed).not.toContain(neighbour.sessionId)
    expect(openLeases(id)).toBe(0)
    expect(openLeases(neighbour.id)).toBe(1)   // the neighbour survives the restart+cancel
    expect(cardOf(id).session_id).toBeNull()
  })

  it('crash recovery is BOUNDED: repeated recovery attempts release exactly once', () => {
    const { id } = seedWorking()
    const deps = {
      killTmux: () => true,
      releaseBranchLeases: () => {},
      releaseSessionLeases: (db: never, objId: number) => {
        ;(db as unknown as { prepare: (s: string) => { run: (x: number) => void } })
          .prepare("UPDATE session_leases SET released_at = datetime('now') WHERE objective_id = ? AND released_at IS NULL")
          .run(objId)
      },
    } as never

    const first = teardownObjectiveJob(getDb(), id, 'recovery:crash', deps)
    const second = teardownObjectiveJob(getDb(), id, 'recovery:crash', deps)
    const third = teardownObjectiveJob(getDb(), id, 'recovery:crash', deps)

    expect(first.performed).toBe(true)
    expect(second.performed).toBe(false)
    expect(third.performed).toBe(false)
    expect(teardownRows(id).filter(r => r.reason === 'recovery:crash')).toHaveLength(1)
  })
})

function cardRow(id: number) {
  return getDb().prepare('SELECT * FROM objectives WHERE id = ?').get(id) as never
}

// ───────────────────────────────────────────────────────────────────────────
// G10/G11 — the poller's DEAD branch recovery teardown, with seeded leases
//
// This closes the gap the corrections PR listed explicitly: `handleDeadSessionOutcome`
// routes its recovery through `teardownObjectiveJob` + the real `pollerTeardownDeps`
// (the real `killTmuxByName`, mocked only at the process boundary, and the real
// `releaseSessionLeasesForObjective` / `releaseBranchLeasesForObjective`), but nothing
// drove that call with leases actually seeded. So "releases only what the card owns,
// exactly once, and after a restart" was an argument about the code rather than a
// measurement of it. These tests seed BOTH lease tables for the card AND for a
// neighbour, empty the in-memory maps, and assert on the durable aftermath.
// ───────────────────────────────────────────────────────────────────────────

describe('dead-branch recovery teardown releases only owned resources, exactly once', () => {
  /** A card that owns both of its leases, exactly as a live PR spawn would. */
  function seedLeasedWorker() {
    const { id, sessionId } = seedWorking()
    const branch = `cc/obj-${id}-x`
    getDb()
      .prepare('INSERT INTO branch_leases (branch_name, objective_id, session_id, tmux_name) VALUES (?, ?, ?, ?)')
      .run(branch, id, sessionId, sessionId)
    return { id, sessionId, branch }
  }

  /** A no-output death: the transcript exists (so this is NOT a startup failure) and holds no tool use. */
  function writeNoOutputTranscript(sessionId: string) {
    fs.writeFileSync(path.join(TMP, `${sessionId}.jsonl`),
      JSON.stringify({ type: 'system', subtype: 'init', session_id: sessionId }) + '\n')
    fs.writeFileSync(path.join(TMP, `${sessionId}.log`), '[wrapper] Starting\n')
  }

  function openBranchLeases(id: number): number {
    return (getDb()
      .prepare('SELECT COUNT(*) AS n FROM branch_leases WHERE objective_id = ? AND released_at IS NULL')
      .get(id) as { n: number }).n
  }

  function rearm(id: number, sessionId: string) {
    getDb().prepare("UPDATE objectives SET status = 'working', session_id = ? WHERE id = ?").run(sessionId, id)
  }

  it('kills ONLY the card’s own tmux and releases ONLY its leases — the neighbour runs on', async () => {
    const own = seedLeasedWorker()
    const neighbour = seedLeasedWorker()
    writeNoOutputTranscript(own.sessionId)
    writeNoOutputTranscript(neighbour.sessionId)

    // Death 1 is below the bound: the existing respawn machinery owns it, so
    // there must be NO teardown and NO kill yet.
    expect(await handleDeadSessionOutcome(cardRow(own.id))).toBe(false)
    expect(killedTmux).toEqual([])
    expect(teardownRows(own.id)).toHaveLength(0)
    expect(getAttempts(getDb(), own.id, 'noop_respawn')).toBe(1)

    // Death 2 exhausts the durable budget → block + owned recovery teardown.
    expect(await handleDeadSessionOutcome(cardRow(own.id))).toBe(true)

    // Ownership is resolved from durable rows, and the card's session lease,
    // branch lease and `session_id` all name the same tmux → exactly one kill,
    // de-duplicated, and never the neighbour's.
    expect(killedTmux).toEqual([own.sessionId])
    expect(killedTmux).not.toContain(neighbour.sessionId)

    // Both of the card's lease tables are released; both of the neighbour's stand.
    expect(openLeases(own.id)).toBe(0)
    expect(openBranchLeases(own.id)).toBe(0)
    expect(openLeases(neighbour.id)).toBe(1)
    expect(openBranchLeases(neighbour.id)).toBe(1)
    expect(cardOf(neighbour.id).session_id).toBe(neighbour.sessionId)
    expect(cardOf(neighbour.id).status).toBe('working')

    // One ledger row, attributed to THIS death, recording what it actually did.
    const rows = teardownRows(own.id)
    expect(rows).toHaveLength(1)
    expect(rows[0].reason).toBe(`dead-no-output:${own.sessionId}`)
    expect(rows[0].killed_tmux).toBe(1)
    expect(rows[0].leases_released).toBe(1)

    // Human review semantics preserved: blocked for a person, not silently done.
    const card = cardOf(own.id)
    expect(card.status).toBe('review')
    expect(card.ai_review_verdict).toBe('blocked')
    expect(card.has_blockers).toBe(1)
    expect(card.session_id).toBeNull()
  })

  it('works after a RESTART: in-memory maps are empty, durable state still drives teardown', async () => {
    const own = seedLeasedWorker()
    const neighbour = seedLeasedWorker()
    writeNoOutputTranscript(own.sessionId)

    expect(await handleDeadSessionOutcome(cardRow(own.id))).toBe(false) // attempt 1

    // The restart, as it really happens: every module-level Map is reconstructed
    // empty by a redeploy. Nothing that follows may depend on one.
    noopRespawnCounts.clear()
    expect(noopRespawnCounts.size).toBe(0)
    expect(getAttempts(getDb(), own.id, 'noop_respawn')).toBe(1) // durable, not re-armed

    expect(await handleDeadSessionOutcome(cardRow(own.id))).toBe(true)
    expect(killedTmux).toEqual([own.sessionId])
    expect(openLeases(own.id)).toBe(0)
    expect(openBranchLeases(own.id)).toBe(0)
    expect(openLeases(neighbour.id)).toBe(1)
    expect(teardownRows(own.id)).toHaveLength(1)
  })

  it('a re-tick on the same dead session releases EXACTLY once — no second kill', async () => {
    const own = seedLeasedWorker()
    writeNoOutputTranscript(own.sessionId)
    await handleDeadSessionOutcome(cardRow(own.id))               // attempt 1
    expect(await handleDeadSessionOutcome(cardRow(own.id))).toBe(true) // block + teardown
    expect(killedTmux).toEqual([own.sessionId])

    // The poller re-selects a card every ~3s. Re-arm the card onto the SAME
    // session id (the shape of a racing tick / a reopen inside the lease TTL)
    // and tick twice more. The ledger key is (objective, reason) and the reason
    // embeds the session id, so these are duplicates and must do nothing.
    for (let i = 0; i < 2; i++) {
      rearm(own.id, own.sessionId)
      expect(await handleDeadSessionOutcome(cardRow(own.id))).toBe(true) // still blocked, never "done"
    }
    expect(teardownRows(own.id).filter(r => r.reason === `dead-no-output:${own.sessionId}`)).toHaveLength(1)
    expect(killedTmux).toEqual([own.sessionId]) // still exactly one kill in total
    expect(cardOf(own.id).ai_review_verdict).toBe('blocked')
  })

  it('retry accounting stays BOUNDED: a respawned session never refills the budget', async () => {
    const own = seedLeasedWorker()
    writeNoOutputTranscript(own.sessionId)
    expect(await handleDeadSessionOutcome(cardRow(own.id))).toBe(false) // attempt 1
    expect(await handleDeadSessionOutcome(cardRow(own.id))).toBe(true)  // attempt 2 → bound

    // A respawn gives the card a NEW session id. The attempt counter is keyed on
    // the CARD, so the new session inherits an already-exhausted budget and is
    // blocked on its first death instead of buying two more.
    const respawned = `${own.sessionId}-r2`
    writeNoOutputTranscript(respawned)
    getDb()
      .prepare('INSERT INTO session_leases (lease_key, objective_id, session_id, tmux_name) VALUES (?, ?, ?, ?)')
      .run(`obj:${own.id}:r2`, own.id, respawned, respawned)
    rearm(own.id, respawned)

    expect(await handleDeadSessionOutcome(cardRow(own.id))).toBe(true)
    expect(getAttempts(getDb(), own.id, 'noop_respawn')).toBeGreaterThanOrEqual(MAX_NOOP_RESPAWNS)
    expect(cardOf(own.id).ai_review_verdict).toBe('blocked')

    // The new death gets its OWN ledger row (a distinct resource was released),
    // and that row killed the respawned tmux — not the original one twice.
    const rows = teardownRows(own.id)
    expect(rows.map(r => r.reason)).toEqual([
      `dead-no-output:${own.sessionId}`,
      `dead-no-output:${respawned}`,
    ])
    expect(killedTmux).toEqual([own.sessionId, respawned])
    expect(openLeases(own.id)).toBe(0)
  })
})
