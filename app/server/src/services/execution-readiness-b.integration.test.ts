/**
 * obj 900322 — execution readiness B: truthful no-output, owned cancellation,
 * restart-safe job accounting.
 *
 * These are INTEGRATION tests against the real wiring, not unit tests beside it:
 *  - `handleDeadSessionOutcome` is the function the poller's `dead` branch
 *    actually calls (poller-loop.ts), driven here over a REAL on-disk transcript
 *    and a REAL migrated SQLite database;
 *  - `teardownObjectiveJob` is the function the `cancelled` branch of
 *    `PATCH /api/objectives/:id/status` actually calls, driven here against the
 *    real `objectives` / `session_leases` / `branch_leases` / teardown-ledger
 *    tables;
 *  - `guardAutoStartCeiling` is the function the chat auto-start path in
 *    `routes/internal-create.ts` actually calls.
 *
 * The heavy spawn/ws/intel dependencies are mocked (same approach as
 * runaway-caps.integration.test.ts); everything on the path under test — the
 * classifier, the DB writes, the ledger, the budget arithmetic — is real.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-exec-ready-b-'))
process.env.DB_PATH = path.join(TMP, 'db.sqlite')
process.env.JWT_SECRET = 'test-secret-900322'
process.env.TRANSCRIPT_DIR = TMP
process.env.PROJECTS_DIR = TMP

const broadcastMock = vi.fn()
vi.mock('../ws/index.js', () => ({
  broadcast: (...a: unknown[]) => broadcastMock(...a),
  broadcastToObjective: vi.fn(),
}))
vi.mock('./notifier.js', () => ({ sendTelegram: vi.fn(), insertAlert: vi.fn() }))
vi.mock('./session-intel-pipeline.js', () => ({ queueExtraction: vi.fn() }))

const { getDb, initDb } = await import('../db/index.js')
const { handleDeadSessionOutcome } = await import('./poller-loop.js')
const { teardownObjectiveJob, resolveOwnedJob } = await import('./job-teardown.js')
const {
  bumpAttempt, getAttempts, resetAttempts,
  setObjectiveCeiling, recordSpend, evaluateCeiling,
  guardAutoStartCeiling, resolveConfiguredCeiling,
} = await import('./job-accounting.js')
const { classifyTerminalOutcome, detectRefusal } = await import('./session-outcome.js')
const { resolveWorkerEndStatus } = await import('./poller-decisions.js')
const { STARTUP_FAILURE_MARKER, STARTUP_FAILURE_SUBTYPE } = await import('./session-startup-failure.js')

beforeAll(() => { initDb() })
afterAll(() => {
  try { getDb().close() } catch { /* ignore */ }
  fs.rmSync(TMP, { recursive: true, force: true })
})

let nextId = 9000322
function seedObjective(over: Record<string, unknown> = {}): { id: number; session_id: string } {
  const db = getDb()
  const id = nextId++
  const sessionId = (over.session_id as string) ?? `cc-${id}-s1`
  db.prepare(
    `INSERT INTO objectives (id, title, type, status, effort, session_id, project, workspace, create_pr, delegate_mode)
     VALUES (?, ?, 'task', ?, 'normal', ?, 'operationkit', ?, 0, ?)`,
  ).run(
    id,
    (over.title as string) ?? `obj ${id}`,
    (over.status as string) ?? 'working',
    sessionId,
    (over.workspace as string) ?? 'operationkit',
    (over.delegate_mode as number) ?? 0,
  )
  return { id, session_id: sessionId }
}

function writeTranscript(sessionId: string, jsonlLines: string[], logText = ''): void {
  fs.writeFileSync(path.join(TMP, `${sessionId}.jsonl`), jsonlLines.join('\n') + (jsonlLines.length ? '\n' : ''))
  fs.writeFileSync(path.join(TMP, `${sessionId}.log`), logText)
}

function cardOf(id: number) {
  return getDb().prepare('SELECT * FROM objectives WHERE id = ?').get(id) as {
    status: string; ai_review_verdict: string | null; ai_review_findings: string | null
    has_blockers: number; session_id: string | null
  }
}

function activityFor(id: number) {
  return getDb()
    .prepare('SELECT event_type, title, detail FROM activity_log WHERE objective_id = ? ORDER BY id')
    .all(id) as { event_type: string; title: string; detail: string }[]
}

beforeEach(() => { broadcastMock.mockClear() })

// ───────────────────────────────────────────────────────────────────────────
// G11 — a session that produces nothing says so
// ───────────────────────────────────────────────────────────────────────────

describe('G11 — truthful no-output (C3), through the poller dead branch', () => {
  it('startup death BEFORE first output → blocked with the exit code and stderr, never a silent review', async () => {
    const { id, session_id } = seedObjective()
    // Exactly what the wrapper emits (session-startup-failure.ts): a type:"error"
    // event, which `jsonlHasResult` does NOT match — hence the dead branch.
    writeTranscript(
      session_id,
      [JSON.stringify({
        type: 'error', subtype: STARTUP_FAILURE_SUBTYPE, is_error: true,
        session_id, exit_code: 78, reason: 'workdir_unreachable',
        workdir: '/workspace', error: 'startup failed: cannot enter workdir /workspace',
      })],
      `${STARTUP_FAILURE_MARKER} cannot enter workdir /workspace\ncd: /workspace: Permission denied\n`,
    )

    const handled = await handleDeadSessionOutcome(
      getDb().prepare('SELECT * FROM objectives WHERE id = ?').get(id) as never,
    )
    expect(handled).toBe(true)

    const card = cardOf(id)
    expect(card.ai_review_verdict).toBe('blocked')
    expect(card.has_blockers).toBe(1)
    // Specific reason, not "ended": cause, exit code and the real stderr.
    expect(card.ai_review_findings).toContain('workdir_unreachable')
    expect(card.ai_review_findings).toContain('78')
    expect(card.ai_review_findings).toContain('Permission denied')

    // An explicit error record exists — the card is not merely a status write.
    const acts = activityFor(id)
    expect(acts.some(a => a.event_type === 'error' && a.title === 'session_startup_failed')).toBe(true)
    expect(broadcastMock).toHaveBeenCalled()
  })

  it('a startup failure NEVER consumes the respawn budget (re-spawning reproduces the fault)', async () => {
    const { id, session_id } = seedObjective()
    writeTranscript(
      session_id,
      [JSON.stringify({ type: 'error', subtype: STARTUP_FAILURE_SUBTYPE, exit_code: 78, reason: 'workdir_unreachable' })],
      `${STARTUP_FAILURE_MARKER} nope\n`,
    )
    await handleDeadSessionOutcome(getDb().prepare('SELECT * FROM objectives WHERE id = ?').get(id) as never)
    expect(getAttempts(getDb(), id, 'noop_respawn')).toBe(0)
  })

  it('a silent no-output death blocks only once the DURABLE budget is exhausted, then carries the count', async () => {
    const { id, session_id } = seedObjective()
    // Non-empty transcript (so this is NOT a startup failure) with zero tools.
    writeTranscript(session_id, [JSON.stringify({ type: 'system', subtype: 'init', session_id })], '[wrapper] Starting at T\n')
    const row = () => getDb().prepare('SELECT * FROM objectives WHERE id = ?').get(id) as never

    // MAX_NOOP_RESPAWNS is 2: the first death records attempt 1 and defers to
    // the existing respawn machinery rather than blocking.
    expect(await handleDeadSessionOutcome(row())).toBe(false)
    expect(getAttempts(getDb(), id, 'noop_respawn')).toBe(1)

    // Second death hits the bound → blocked, truthfully, with the count.
    expect(await handleDeadSessionOutcome(row())).toBe(true)
    const card = cardOf(id)
    expect(card.ai_review_verdict).toBe('blocked')
    expect(card.ai_review_findings).toContain('produced no output')
    expect(card.ai_review_findings).toContain('2/2')
    expect(activityFor(id).some(a => a.event_type === 'error' && a.title === 'session_no_output')).toBe(true)
  })

  it('THE RESTART CASE: the no-output budget survives a process restart and is NOT re-armed', async () => {
    const { id, session_id } = seedObjective()
    writeTranscript(session_id, [JSON.stringify({ type: 'system', subtype: 'init', session_id })], '[wrapper] Starting\n')
    const row = () => getDb().prepare('SELECT * FROM objectives WHERE id = ?').get(id) as never
    await handleDeadSessionOutcome(row()) // attempt 1

    // Simulate the restart the way the bug actually happens: every in-memory
    // budget Map is module-level, so a deploy empties them. The durable counter
    // is what must NOT move.
    const { noopRespawnCounts } = await import('./poller-loop.js')
    noopRespawnCounts.clear()

    expect(getAttempts(getDb(), id, 'noop_respawn')).toBe(1) // unchanged by the "restart"
    expect(await handleDeadSessionOutcome(row())).toBe(true) // blocks on attempt 2, not 3
    expect(cardOf(id).ai_review_verdict).toBe('blocked')
  })

  it('a session that DID work is never blocked — the dead branch falls through untouched', async () => {
    const { id, session_id } = seedObjective()
    writeTranscript(session_id, [
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: '/tmp/x.ts' } }] } }),
    ], '[wrapper] Starting\n')
    expect(await handleDeadSessionOutcome(getDb().prepare('SELECT * FROM objectives WHERE id = ?').get(id) as never)).toBe(false)
    expect(cardOf(id).ai_review_verdict).toBeNull()
  })

  it('NO transcript and NO log at all → the legacy silent shape, blocked as wrapper_never_started', async () => {
    // This is the exact case obj 900038 documented: a wrapper that died before
    // it announced itself leaves both files empty/absent. Blocking it with that
    // name is the truthful answer — the opposite of today's silent `review` —
    // and it must NOT be re-spawned, because the fault reproduces exactly.
    const { id } = seedObjective({ session_id: 'cc-missing-transcript' })
    expect(await handleDeadSessionOutcome(getDb().prepare('SELECT * FROM objectives WHERE id = ?').get(id) as never)).toBe(true)
    const card = cardOf(id)
    expect(card.ai_review_verdict).toBe('blocked')
    expect(card.ai_review_findings).toContain('wrapper_never_started')
    expect(getAttempts(getDb(), id, 'noop_respawn')).toBe(0) // environment fault → no budget spent
  })

  it('a session with real work and an unreadable log is NEVER blocked (no guessing from a read failure)', async () => {
    const { id, session_id } = seedObjective()
    // Transcript has genuine tool use; the log is absent. detectStartupFailure
    // must not read "empty log" as a failure when the transcript has events.
    fs.writeFileSync(path.join(TMP, `${session_id}.jsonl`),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] } }) + '\n')
    expect(await handleDeadSessionOutcome(getDb().prepare('SELECT * FROM objectives WHERE id = ?').get(id) as never)).toBe(false)
    expect(cardOf(id).ai_review_verdict).toBeNull()
  })

  it('a refusal is classified as a refusal, not as silence (different human response)', () => {
    const refused = classifyTerminalOutcome({
      hasResult: true, toolCalls: 0, filesCreated: 0, filesModified: 0,
      refusalText: 'I cannot complete this task without credentials.',
    })
    expect(refused.kind).toBe('refused')
    expect(refused.blocked).toBe(true)
    expect(refused.reason).toContain('refused')
    // And it is NOT allowed to read as a completed answer.
    expect(refused.kind).not.toBe('produced-output')
  })
})

// ───────────────────────────────────────────────────────────────────────────
// G10 — cancellation and restart
// ───────────────────────────────────────────────────────────────────────────

describe('G10 — owned cancellation releases exactly once (C4)', () => {
  const deps = (killed: string[]) => ({
    killTmux: (name: string) => { killed.push(name); return true },
    releaseBranchLeases: (db: never, objId: number) => {
      getDb().prepare("UPDATE branch_leases SET released_at = datetime('now') WHERE objective_id = ? AND released_at IS NULL").run(objId)
    },
    releaseSessionLeases: (db: never, objId: number) => {
      getDb().prepare("UPDATE session_leases SET released_at = datetime('now') WHERE objective_id = ? AND released_at IS NULL").run(objId)
    },
  })

  function holdLeases(id: number, sessionId: string) {
    getDb().prepare('INSERT INTO session_leases (lease_key, objective_id, session_id, tmux_name) VALUES (?, ?, ?, ?)')
      .run(`obj:${id}`, id, sessionId, sessionId)
    getDb().prepare('INSERT INTO branch_leases (branch_name, objective_id, session_id, tmux_name) VALUES (?, ?, ?, ?)')
      .run(`cc/obj-${id}`, id, sessionId, sessionId)
  }

  it('cancel kills the card\'s OWN tmux and releases its leases, and clears session_id', () => {
    const { id, session_id } = seedObjective()
    holdLeases(id, session_id)

    const killed: string[] = []
    const r = teardownObjectiveJob(getDb(), id, 'status:cancelled', deps(killed) as never)

    expect(r.performed).toBe(true)
    expect(killed).toEqual([session_id])
    expect(r.leasesReleased).toBe(true)
    expect(cardOf(id).session_id).toBeNull()
    const held = getDb()
      .prepare('SELECT COUNT(*) n FROM session_leases WHERE objective_id = ? AND released_at IS NULL')
      .get(id) as { n: number }
    expect(held.n).toBe(0)
  })

  it('teardown is IDEMPOTENT — a second cancel releases nothing a second time', () => {
    const { id, session_id } = seedObjective()
    holdLeases(id, session_id)
    const first: string[] = []
    const second: string[] = []
    expect(teardownObjectiveJob(getDb(), id, 'status:cancelled', deps(first) as never).performed).toBe(true)
    expect(teardownObjectiveJob(getDb(), id, 'status:cancelled', deps(second) as never).performed).toBe(false)
    expect(first).toEqual([session_id])
    expect(second).toEqual([]) // no second kill, no second release
    const ledger = getDb()
      .prepare('SELECT COUNT(*) n FROM objective_job_teardowns WHERE objective_id = ?')
      .get(id) as { n: number }
    expect(ledger.n).toBe(1) // exactly once, provably
  })

  it('cancel touches ONLY the cancelled card — a concurrent neighbour keeps its session and leases', () => {
    const victim = seedObjective()
    const bystander = seedObjective()
    holdLeases(victim.id, victim.session_id)
    holdLeases(bystander.id, bystander.session_id)

    const killed: string[] = []
    teardownObjectiveJob(getDb(), victim.id, 'status:cancelled', deps(killed) as never)

    expect(killed).toEqual([victim.session_id])
    expect(killed).not.toContain(bystander.session_id)
    expect(cardOf(bystander.id).session_id).toBe(bystander.session_id)
    const stillHeld = getDb()
      .prepare('SELECT COUNT(*) n FROM session_leases WHERE objective_id = ? AND released_at IS NULL')
      .get(bystander.id) as { n: number }
    expect(stillHeld.n).toBe(1)
  })

  it('RESTART THEN CANCEL: ownership resolves from durable state, so an empty in-memory map changes nothing', () => {
    const { id, session_id } = seedObjective()
    holdLeases(id, session_id)
    // A restart leaves `activeSessions` empty. resolveOwnedJob never reads it.
    const owned = resolveOwnedJob(getDb(), id)
    expect(owned.sessionId).toBe(session_id)
    expect(owned.tmuxNames).toContain(session_id)

    const killed: string[] = []
    const r = teardownObjectiveJob(getDb(), id, 'status:cancelled', deps(killed) as never)
    expect(r.performed).toBe(true)
    expect(killed).toEqual([session_id])
  })

  it('a card that owns nothing tears down nothing (no blind kill)', () => {
    const { id } = seedObjective({ status: 'queue' })
    getDb().prepare('UPDATE objectives SET session_id = NULL WHERE id = ?').run(id)
    const killed: string[] = []
    const r = teardownObjectiveJob(getDb(), id, 'status:cancelled', deps(killed) as never)
    expect(killed).toEqual([])
    expect(r.killedTmux).toEqual([])
  })
})

// ───────────────────────────────────────────────────────────────────────────
// G12 — finite ceilings that survive a restart
// ───────────────────────────────────────────────────────────────────────────

describe('G12 — durable finite job ceilings (C4/C9)', () => {
  beforeEach(() => {
    getDb().exec("DELETE FROM settings WHERE key LIKE 'job_cost_ceiling%' OR key LIKE 'job_wallclock_ceiling%' OR key = 'job_ceiling_guard_enabled'")
  })

  it('NO numeric default is invented — an unconfigured card reports `absent`, not unlimited', () => {
    const { id } = seedObjective()
    const resolved = resolveConfiguredCeiling(getDb(), id, 'operationkit')
    expect(resolved).toEqual({ costUsd: null, wallclockMs: null, source: 'none' })
    const verdict = evaluateCeiling(getDb(), id, 'operationkit')
    expect(verdict.state).toBe('absent')
    expect(verdict.reason).toContain('No default was assumed')
  })

  it('a non-finite ceiling is REJECTED rather than coerced', () => {
    const { id } = seedObjective()
    expect(() => setObjectiveCeiling(getDb(), id, { costUsd: Infinity })).toThrow(/finite/)
    expect(() => setObjectiveCeiling(getDb(), id, { costUsd: NaN })).toThrow(/finite/)
    expect(() => setObjectiveCeiling(getDb(), id, { costUsd: 0 })).toThrow(/finite/)
    expect(() => setObjectiveCeiling(getDb(), id, { costUsd: -5 })).toThrow(/finite/)
  })

  it('spend accumulates and stops the job at the ceiling', () => {
    const { id } = seedObjective()
    setObjectiveCeiling(getDb(), id, { costUsd: 1.0 })
    recordSpend(getDb(), id, { usd: 0.4 })
    expect(evaluateCeiling(getDb(), id).state).toBe('ok')
    recordSpend(getDb(), id, { usd: 0.7 })
    const v = evaluateCeiling(getDb(), id)
    expect(v.state).toBe('exceeded')
    expect(v.reason).toContain('Cost ceiling reached')
  })

  it('THE RESTART CASE: spend and ceiling are re-read from SQLite, so a restart cannot reset the budget', async () => {
    const { id } = seedObjective()
    setObjectiveCeiling(getDb(), id, { costUsd: 2.0 })
    recordSpend(getDb(), id, { usd: 1.9 })

    // Re-open the SAME database file through a fresh connection — the closest
    // in-process analogue of a server restart, and the thing a module-level Map
    // could never survive.
    const Database = (await import('better-sqlite3')).default
    const fresh = new Database(process.env.DB_PATH!)
    try {
      const { evaluateCeiling: evalFresh, recordSpend: spendFresh } = await import('./job-accounting.js')
      expect(evalFresh(fresh as never, id).spentUsd).toBeCloseTo(1.9, 5)
      spendFresh(fresh as never, id, { usd: 0.2 })
      const after = evalFresh(fresh as never, id)
      expect(after.state).toBe('exceeded')   // 2.1 >= 2.0 — the retry did NOT reset it
      expect(after.spentUsd).toBeCloseTo(2.1, 5)
    } finally {
      fresh.close()
    }
  })

  it('a retry/continuation ADDS to the same total rather than starting a new one', () => {
    const { id } = seedObjective()
    setObjectiveCeiling(getDb(), id, { costUsd: 1.0, wallclockMs: 60_000 })
    recordSpend(getDb(), id, { usd: 0.6, ms: 30_000 })
    bumpAttempt(getDb(), id, 'turns_continue')          // a resume happens
    recordSpend(getDb(), id, { usd: 0.3, ms: 40_000 })  // the resume's own spend
    const v = evaluateCeiling(getDb(), id)
    expect(v.spentUsd).toBeCloseTo(0.9, 5)
    expect(v.elapsedMs).toBe(70_000)
    expect(v.state).toBe('exceeded')  // wall-clock ceiling crossed cumulatively
    expect(v.reason).toContain('Wall-clock ceiling reached')
  })

  it('attempt counters are durable and per-kind, and only an explicit reset clears them', () => {
    const { id } = seedObjective()
    expect(bumpAttempt(getDb(), id, 'overload_retry')).toBe(1)
    expect(bumpAttempt(getDb(), id, 'overload_retry')).toBe(2)
    expect(getAttempts(getDb(), id, 'turns_continue')).toBe(0) // kinds do not bleed
    resetAttempts(getDb(), id, 'overload_retry')
    expect(getAttempts(getDb(), id, 'overload_retry')).toBe(0)
  })

  it('AUTO-START IS REFUSED, explicitly, when no finite ceiling is configured', () => {
    const { id } = seedObjective()
    const v = guardAutoStartCeiling(getDb(), { id, workspace: 'operationkit' })
    expect(v.allowed).toBe(false)
    expect(v.reason).toContain('no finite job ceiling is configured')
    expect(v.reason).toContain('job_cost_ceiling_usd')      // names the remedy
    expect(v.reason).toContain('job_ceiling_guard_enabled') // names the kill switch
  })

  it('a workspace-scoped setting satisfies the guard; a global one does too', () => {
    const a = seedObjective({ workspace: 'operationkit' })
    getDb().prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('job_cost_ceiling_usd:operationkit', '5')").run()
    expect(guardAutoStartCeiling(getDb(), { id: a.id, workspace: 'operationkit' }).allowed).toBe(true)
    expect(resolveConfiguredCeiling(getDb(), a.id, 'operationkit').source).toBe('workspace:operationkit')

    const b = seedObjective({ workspace: 'example' })
    expect(guardAutoStartCeiling(getDb(), { id: b.id, workspace: 'example' }).allowed).toBe(false)
    getDb().prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('job_cost_ceiling_usd', '3')").run()
    expect(guardAutoStartCeiling(getDb(), { id: b.id, workspace: 'example' }).allowed).toBe(true)
  })

  it('an EXHAUSTED budget also refuses auto-start, and says the budget survives restarts', () => {
    const { id } = seedObjective()
    setObjectiveCeiling(getDb(), id, { costUsd: 1 })
    recordSpend(getDb(), id, { usd: 1.5 })
    const v = guardAutoStartCeiling(getDb(), { id, workspace: 'operationkit' })
    expect(v.allowed).toBe(false)
    expect(v.reason).toContain('Cost ceiling reached')
    expect(v.reason).toContain('survives restarts')
  })

  it('the kill switch turns the refusal off without inventing a number', () => {
    const { id } = seedObjective()
    getDb().prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('job_ceiling_guard_enabled', '0')").run()
    const v = guardAutoStartCeiling(getDb(), { id, workspace: 'operationkit' })
    expect(v.allowed).toBe(true)
    expect(v.ceiling).toEqual({ costUsd: null, wallclockMs: null, source: 'none' })
  })

  it('a garbage settings value is NOT a ceiling (no silent coercion to 0/NaN)', () => {
    const { id } = seedObjective({ workspace: 'operationkit' })
    getDb().prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('job_cost_ceiling_usd:operationkit', 'lots')").run()
    expect(resolveConfiguredCeiling(getDb(), id, 'operationkit').source).toBe('none')
    expect(guardAutoStartCeiling(getDb(), { id, workspace: 'operationkit' }).allowed).toBe(false)
  })
})

// ───────────────────────────────────────────────────────────────────────────
// Routine refusal — a recurring job that refused must not auto-complete
// ───────────────────────────────────────────────────────────────────────────

describe('routine refusal never reaches done (C3)', () => {
  const base = {
    type: 'task' as const, delegateMode: false, createPr: false,
    skipAi: false, hasDelegatorParent: false, isRoutine: true,
  }

  it('TODAY\'S BUG, pinned: a routine task that DID work still auto-completes', () => {
    expect(resolveWorkerEndStatus({ ...base })).toBe('done')
    expect(resolveWorkerEndStatus({ ...base, lane: 'green' })).toBe('done')
  })

  it('a routine task that produced NOTHING routes to review, not done', () => {
    expect(resolveWorkerEndStatus({ ...base, producedNothing: true })).toBe('review')
    // And on every lane — the green lane has its own routine carve-out.
    expect(resolveWorkerEndStatus({ ...base, lane: 'green', producedNothing: true })).toBe('review')
  })

  it('producedNothing also keeps a non-routine card off its auto paths', () => {
    expect(resolveWorkerEndStatus({ ...base, isRoutine: false, createPr: true, producedNothing: true })).toBe('review')
    expect(resolveWorkerEndStatus({ ...base, isRoutine: false, skipAi: true, type: 'bug', producedNothing: true })).toBe('review')
  })

  it('detectRefusal fires on a short decline and NOT on a long delivered answer', () => {
    expect(detectRefusal('I cannot help with that request.')).toContain('cannot help')
    expect(detectRefusal("I'm unable to proceed without credentials.")).toBeTruthy()
    expect(detectRefusal('SCOPE-SPLIT NEEDED: this belongs on another card')).toBeTruthy()
    // A real deliverable that merely contains the words is NOT a refusal.
    const essay = 'Here is the analysis. ' + 'The system behaves as follows. '.repeat(120) + "I can't see a defect."
    expect(detectRefusal(essay)).toBeNull()
    expect(detectRefusal('')).toBeNull()
    expect(detectRefusal('Done — wrote three files and opened PR #601.')).toBeNull()
  })

  it('a refusal with zero tools classifies as refused, while a real answer does not', () => {
    const refusalText = detectRefusal('I cannot complete this without the API key.')
    expect(classifyTerminalOutcome({
      hasResult: true, toolCalls: 0, filesCreated: 0, filesModified: 0,
      completedWithAnswer: true, refusalText,
    }).kind).toBe('refused')
    // An answer-only card (0 tools, real answer) is legitimate work.
    expect(classifyTerminalOutcome({
      hasResult: true, toolCalls: 0, filesCreated: 0, filesModified: 0,
      completedWithAnswer: true, refusalText: detectRefusal('The answer is 42, because ...'),
    }).kind).toBe('produced-output')
  })
})
