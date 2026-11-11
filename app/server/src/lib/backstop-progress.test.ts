// Durable no-progress circuit breaker for the delegator liveness backstop
// (obj 707460).
//
// THE BUG THESE PIN. `sweepWedgedDelegators` re-nudges a delegator wedged in
// `working` every DELEGATOR_BACKSTOP_MS. It is time-throttled and deliberately
// NOT signature-gated, which means it had no convergence condition whatsoever:
// obj 706967 accrued 82 sessions / 61 sub-35s no-ops / ~$53 on a ~31-minute
// metronome across 33+ hours and was still going. The pre-existing
// MAX_NOOP_RESPAWNS guard could not stop it — it is gated on `!delegate_mode`
// (the victims are delegators) and its counter is an in-memory Map documented as
// "cleared on restart", so a loop that outlives the process outlives the guard.
//
// The tests below therefore do two things a pure-function test cannot:
//   1. REPRODUCE the loop by running the poller's actual per-wake state machine
//      against a real SQLite database, and prove it terminates.
//   2. Prove it still terminates when the process RESTARTS mid-loop — modelled
//      with `vi.resetModules()` + a fresh dynamic import, which discards every
//      byte of module-level memory exactly as a restart does. This is the
//      property the old in-memory Map lacked.

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const TMP_DB = path.join(os.tmpdir(), `cc-backstop-progress-test-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB

const { initDb, getDb } = await import('../db/index.js')
const backstop = await import('./backstop-progress.js')

initDb()
const db = getDb()

const MAX = backstop.BACKSTOP_MAX_NOPROGRESS

function addObjective(title: string, parent: number | null = null, status = 'working'): number {
  return Number(
    db
      .prepare(
        `INSERT INTO objectives (title, status, agent_context, workspace, parent_id, delegate_mode)
         VALUES (?, ?, 'cto', 'example', ?, 1)`,
      )
      .run(title, status, parent).lastInsertRowid,
  )
}

/** Record a session for an objective, with the file lists the intel pipeline writes. */
function addSession(
  objectiveId: number,
  opts: { created?: string[]; modified?: string[]; toolCalls?: number } = {},
) {
  db.prepare(
    `INSERT INTO session_intel
       (objective_id, session_id, started_at, ended_at, files_created, files_modified, tool_calls)
     VALUES (?, ?, datetime('now'), datetime('now'), ?, ?, ?)`,
  ).run(
    objectiveId,
    `cc-${objectiveId}-${Math.random().toString(36).slice(2)}`,
    JSON.stringify(opts.created ?? []),
    JSON.stringify(opts.modified ?? []),
    opts.toolCalls ?? 0,
  )
}

afterAll(() => {
  for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) {
    try {
      fs.unlinkSync(f)
    } catch {
      /* not present */
    }
  }
})

// ── The pure branch ─────────────────────────────────────────────────────────

describe('classifyBackstopProgress', () => {
  it('first wake always proceeds (no baseline to compare against)', () => {
    const d = backstop.classifyBackstopProgress('kids=[]', { sig: null, noProgress: 0 })
    expect(d.action).toBe('proceed')
    expect(d.stalled).toBe(false)
    expect(d.noProgress).toBe(0)
  })

  it('a changed signature resets the counter even at the cap', () => {
    const d = backstop.classifyBackstopProgress('kids=[1:review]', {
      sig: 'kids=[1:queue]',
      noProgress: MAX - 1,
    })
    expect(d.action).toBe('proceed')
    expect(d.noProgress).toBe(0)
    expect(d.stalled).toBe(false)
  })

  it('an unchanged signature increments, and parks on reaching the cap', () => {
    const sig = 'kids=[1:review]'
    let state = { sig, noProgress: 0 }
    for (let i = 1; i < MAX; i++) {
      const d = backstop.classifyBackstopProgress(sig, state)
      expect(d.action).toBe('proceed')
      expect(d.stalled).toBe(true)
      expect(d.noProgress).toBe(i)
      state = { sig, noProgress: d.noProgress }
    }
    const final = backstop.classifyBackstopProgress(sig, state)
    expect(final.action).toBe('park')
    expect(final.noProgress).toBe(MAX)
  })
})

// ── The signature: what counts as progress ─────────────────────────────────

describe('computeProgressSig', () => {
  it('counts durable writes but IGNORES objective-memory scratch churn', () => {
    // This is the load-bearing exclusion. A worker is *instructed* to rewrite
    // NOTES.md/ARTIFACT.md on every wake, so if scratch counted as progress the
    // signature would change on every no-op wake and the breaker could never
    // trip — it would be inert against the exact bug it exists to fix.
    const id = addObjective('scratch-only worker')
    addSession(id, {
      created: ['/home/operator/ai-workspace/objective-memory/999/NOTES.md'],
      modified: ['/home/operator/ai-workspace/objective-memory/999/ARTIFACT.md'],
      toolCalls: 47, // a busy dead-end investigation
    })
    expect(backstop.countDurableWrites(id)).toBe(0)
    expect(backstop.computeProgressSig(id, [])).toBe('kids=[]')

    addSession(id, { modified: ['/tmp/cc-worktree-999/app/server/src/index.ts'] })
    expect(backstop.countDurableWrites(id)).toBe(1)
    // Writes must NOT enter the signature — that reset the breaker on every
    // no-op wake that listed a non-scratch file (obj 707614's 29-nudge loop).
    expect(backstop.computeProgressSig(id, [])).toBe('kids=[]')
  })

  it('is stable under child ordering and changes when a child advances', () => {
    const id = addObjective('parent')
    const a = addObjective('kid a', id, 'queue')
    const b = addObjective('kid b', id, 'review')
    const forward = backstop.computeProgressSig(id, [
      { id: a, status: 'queue' },
      { id: b, status: 'review' },
    ])
    const reversed = backstop.computeProgressSig(id, [
      { id: b, status: 'review' },
      { id: a, status: 'queue' },
    ])
    expect(forward).toBe(reversed)

    const advanced = backstop.computeProgressSig(id, [
      { id: a, status: 'done' },
      { id: b, status: 'review' },
    ])
    expect(advanced).not.toBe(forward)
  })

  it('survives a malformed JSON column instead of throwing inside the sweep', () => {
    const id = addObjective('corrupt intel')
    addSession(id)
    db.prepare("UPDATE session_intel SET files_created = 'not json' WHERE objective_id = ?").run(id)
    expect(() => backstop.countDurableWrites(id)).not.toThrow()
    expect(backstop.countDurableWrites(id)).toBe(0)
  })
})

// ── Reproducing the loop, and proving it terminates ────────────────────────

/**
 * One backstop wake, exactly as `sweepWedgedDelegators` executes it: read the
 * durable state off the row, classify, persist, then either nudge or park.
 * `mod` is passed in so a test can hand in a FRESHLY IMPORTED module to model a
 * server restart.
 */
function runWake(
  mod: typeof backstop,
  objectiveId: number,
  kids: { id: number; status: string }[],
): 'nudge' | 'park' {
  const sig = mod.computeProgressSig(objectiveId, kids)
  const decision = mod.classifyBackstopProgress(sig, mod.readBackstopState(objectiveId))
  mod.persistBackstopState(objectiveId, sig, decision.noProgress)
  if (decision.action === 'park') {
    db.prepare(
      "UPDATE objectives SET status = 'review', ai_review_verdict = 'blocked', has_blockers = 1 WHERE id = ?",
    ).run(objectiveId)
    mod.clearBackstopState(objectiveId)
    return 'park'
  }
  // A no-op nudge: the session runs, burns tool calls, writes only scratch.
  addSession(objectiveId, {
    modified: [`/home/operator/ai-workspace/objective-memory/${objectiveId}/NOTES.md`],
    toolCalls: 12,
  })
  return 'nudge'
}

describe('the 30-minute wake loop terminates', () => {
  let objId: number
  let kids: { id: number; status: string }[]

  beforeEach(() => {
    // Reproduce obj 706967's shape: a top-level delegator stuck in `working`
    // with one child parked in review and a blocker no agent can clear (it
    // cannot read a human-attached screenshot), so every wake is a no-op.
    objId = addObjective('Missing MLS events')
    const kid = addObjective('investigate', objId, 'review')
    kids = [{ id: kid, status: 'review' }]
  })

  it('parks after the cap instead of nudging forever', () => {
    const actions: string[] = []
    // 61 = the number of no-op sessions obj 706967 actually accrued. Pre-fix,
    // all 61 would be a nudge. Post-fix the loop must be dead long before then.
    for (let wake = 0; wake < 61; wake++) {
      const objective = db.prepare('SELECT status FROM objectives WHERE id = ?').get(objId) as {
        status: string
      }
      // The sweep's own select clause: only `working` rows are candidates.
      if (objective.status !== 'working') break
      actions.push(runWake(backstop, objId, kids))
    }

    expect(actions[actions.length - 1]).toBe('park')
    // MAX + 1 wakes total: wake 1 only establishes the baseline signature (there
    // is nothing to compare it against yet), then MAX stalled wakes carry the
    // counter to the cap. So the loop costs MAX no-op sessions, not 61.
    expect(actions).toHaveLength(MAX + 1)
    expect(actions.filter(a => a === 'nudge')).toHaveLength(MAX)

    const row = db
      .prepare('SELECT status, ai_review_verdict, has_blockers FROM objectives WHERE id = ?')
      .get(objId) as { status: string; ai_review_verdict: string; has_blockers: number }
    expect(row.status).toBe('review')
    expect(row.ai_review_verdict).toBe('blocked')
    expect(row.has_blockers).toBe(1)
  })

  it('still terminates when the server RESTARTS mid-loop', async () => {
    // One wake, then the process dies. This is precisely where the old
    // in-memory `noopRespawnCounts` Map lost its budget and the loop restarted
    // from zero — forever, because a restart-storm is more frequent than the
    // cap.
    expect(runWake(backstop, objId, kids)).toBe('nudge')
    expect(backstop.readBackstopState(objId).sig).not.toBeNull()

    const actions: string[] = []
    for (let restart = 0; restart < 61; restart++) {
      // A genuine restart: drop every module-level binding and re-import. Any
      // state held in a module-scoped Map is gone after this line — which is
      // exactly what killed the old in-memory guard. The re-import of db/index
      // starts with a null handle and needs initDb(), just as a real boot does;
      // only state that reached SQLite can survive this.
      vi.resetModules()
      const freshDb = await import('../db/index.js')
      freshDb.initDb()
      const fresh = (await import('./backstop-progress.js')) as typeof backstop

      const objective = db.prepare('SELECT status FROM objectives WHERE id = ?').get(objId) as {
        status: string
      }
      if (objective.status !== 'working') break
      actions.push(runWake(fresh, objId, kids))
    }

    // The counter survived every restart, so the loop still converged.
    expect(actions[actions.length - 1]).toBe('park')
    expect(actions.length).toBeLessThan(MAX + 1)
    const row = db.prepare('SELECT status FROM objectives WHERE id = ?').get(objId) as {
      status: string
    }
    expect(row.status).toBe('review')
  })

  it('does NOT park a delegator that is making real progress', () => {
    // The counterweight: the breaker must not kill a slow-but-live delegator.
    // Progress is a child advancing (queue → working → review → done), not a
    // file write — writes no longer enter the signature.
    const kidId = kids[0].id
    const cycle = ['queue', 'working', 'review', 'done']
    for (let wake = 0; wake < MAX * 4; wake++) {
      const currentKids = [{ id: kidId, status: cycle[wake % cycle.length] }]
      const sig = backstop.computeProgressSig(objId, currentKids)
      const d = backstop.classifyBackstopProgress(sig, backstop.readBackstopState(objId))
      expect(d.action).toBe('proceed')
      backstop.persistBackstopState(objId, sig, d.noProgress)
    }
    const row = db.prepare('SELECT status FROM objectives WHERE id = ?').get(objId) as {
      status: string
    }
    expect(row.status).toBe('working')
    expect(backstop.readBackstopState(objId).noProgress).toBe(0)
  })
})
