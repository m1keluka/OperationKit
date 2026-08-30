import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { Objective, ServerMessage } from '@operationkit/shared'

// Real SQLite against the actual schema (incl. the external_check_remediations
// migration) — mirrors changelog.test.ts. The remediation guards (dedup UNIQUE key,
// per-PR attempt count, escalation flag) are SQL-backed, so an in-memory mock would
// not exercise the thing that actually protects prod.
const TMP_DB = path.join(os.tmpdir(), `cc-extrem-test-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB

const { initDb, getDb } = await import('../db/index.js')
const {
  classifyCheckEvent,
  isHarnessCheck,
  isRemediableObjective,
  isRemediationEnabled,
  maxRemediationAttempts,
} = await import('./external-remediation-classify.js')
const { resolveObjective } = await import('./external-remediation-resolve.js')
const {
  clipContext,
  fetchFailureContext,
  handleExternalCheckEvent,
} = await import('./external-remediation-act.js')

beforeAll(() => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
})

afterAll(() => {
  try { getDb().close() } catch { /* noop */ }
  for (const suffix of ['', '-wal', '-shm']) {
    const f = `${TMP_DB}${suffix}`
    if (fs.existsSync(f)) fs.unlinkSync(f)
  }
})

const REPO = 'your-org/command-center-infra'

function insertObjective(fields: Partial<Objective> & { title?: string }): number {
  const db = getDb()
  const info = db
    .prepare(
      `INSERT INTO objectives (title, status, session_id, pr_number, pr_url, branch_name, has_blockers, create_pr)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      fields.title || 'test obj',
      fields.status || 'review',
      fields.session_id ?? 'cc-sess-1',
      fields.pr_number ?? null,
      fields.pr_url ?? null,
      fields.branch_name ?? null,
      fields.has_blockers ? 1 : 0,
      fields.create_pr ? 1 : 0,
    )
  return Number(info.lastInsertRowid)
}

beforeEach(() => {
  const db = getDb()
  db.exec('DELETE FROM external_check_remediations')
  db.exec("DELETE FROM objectives WHERE title LIKE 'test%' OR title LIKE 'obj%'")
  // Auto-created owners (obj 704698: inherited/maintenance cards) carry '[Auto] …'
  // titles, so clear them by origin or they leak their PR linkage into the next test.
  db.exec("DELETE FROM objectives WHERE origin IN ('ci-orphan-inherit','dependency-maintenance','unowned-pr-maintenance','trunk-failure')")
})

// ── 1. Event filtering ──────────────────────────────────────────────────────────
describe('classifyCheckEvent — event filtering', () => {
  const wrFail = {
    repository: { full_name: REPO },
    workflow_run: { id: 999, name: 'Vitest', status: 'completed', conclusion: 'failure', head_sha: 'abc123', pull_requests: [{ number: 42 }], html_url: 'https://x/run/999' },
  }

  it('catches a failing workflow_run', () => {
    const c = classifyCheckEvent('workflow_run', wrFail)
    expect(c).not.toBeNull()
    expect(c!.kind).toBe('workflow_run')
    expect(c!.checkName).toBe('Vitest')
    expect(c!.runId).toBe(999)
    expect(c!.headSha).toBe('abc123')
    expect(c!.prNumberHint).toBe(42)
  })

  it('catches a failing check_run with annotations id', () => {
    const c = classifyCheckEvent('check_run', {
      repository: { full_name: REPO },
      check_run: { id: 7, name: 'build', status: 'completed', conclusion: 'timed_out', head_sha: 'def', pull_requests: [{ number: 9 }] },
    })
    expect(c!.kind).toBe('check_run')
    expect(c!.checkRunId).toBe(7)
    expect(c!.outcome).toBe('timed_out')
  })

  it('catches a Vercel-style failing status event', () => {
    const c = classifyCheckEvent('status', {
      repository: { full_name: REPO },
      state: 'failure', context: 'vercel', sha: 'shaX', target_url: 'https://vercel.com/x',
      branches: [{ name: 'cc/obj-1-foo' }],
    })
    expect(c!.kind).toBe('status')
    expect(c!.targetUrl).toBe('https://vercel.com/x')
    expect(c!.checkName).toBe('vercel')
  })

  it('IGNORES success conclusions and states', () => {
    expect(classifyCheckEvent('workflow_run', { ...wrFail, workflow_run: { ...wrFail.workflow_run, conclusion: 'success' } })).toBeNull()
    expect(classifyCheckEvent('status', { repository: { full_name: REPO }, state: 'success', context: 'vercel', sha: 's' })).toBeNull()
    expect(classifyCheckEvent('status', { repository: { full_name: REPO }, state: 'pending', context: 'vercel', sha: 's' })).toBeNull()
  })

  it('IGNORES in-progress / non-completed checks', () => {
    expect(classifyCheckEvent('workflow_run', { ...wrFail, workflow_run: { ...wrFail.workflow_run, status: 'in_progress', conclusion: null } })).toBeNull()
  })

  it('IGNORES unhandled and non-PR events (pull_request, push, ping)', () => {
    expect(classifyCheckEvent('pull_request', { action: 'opened' })).toBeNull()
    expect(classifyCheckEvent('push', {})).toBeNull()
    expect(classifyCheckEvent('ping', {})).toBeNull()
    expect(classifyCheckEvent('', null)).toBeNull()
  })

  it('IGNORES our own harness/test-agent gate (no double-driving the harness loop)', () => {
    expect(isHarnessCheck('harness/test-agent')).toBe(true)
    expect(isHarnessCheck('harness/anything')).toBe(true)
    expect(isHarnessCheck('Vitest')).toBe(false)
    expect(classifyCheckEvent('status', { repository: { full_name: REPO }, state: 'failure', context: 'harness/test-agent', sha: 's' })).toBeNull()
    expect(classifyCheckEvent('check_run', { repository: { full_name: REPO }, check_run: { id: 1, name: 'harness/test-agent', status: 'completed', conclusion: 'failure', head_sha: 's' } })).toBeNull()
  })
})

// ── 2. Objective resolution ─────────────────────────────────────────────────────
describe('resolveObjective', () => {
  it('resolves by explicit pr_number hint', () => {
    const id = insertObjective({ pr_number: 42, pr_url: `https://github.com/${REPO}/pull/42`, status: 'review' })
    const obj = resolveObjective(getDb(), { prNumberHint: 42, headSha: 'x', repoFullName: REPO })
    expect(obj?.id).toBe(id)
  })

  it('FALLBACK: resolves a row whose pr_number is NULL via pr_url derivation (obj-1138 hole)', () => {
    const id = insertObjective({ pr_number: null, pr_url: `https://github.com/${REPO}/pull/77`, status: 'working' })
    const obj = resolveObjective(getDb(), { prNumberHint: 77, headSha: 'x', repoFullName: REPO })
    expect(obj?.id).toBe(id)
    // pr_number is back-derived for downstream consumers.
    expect(obj?.pr_number).toBe(77)
  })

  it('resolves by branch_name when the event carries no PR number (status events)', () => {
    const id = insertObjective({ pr_number: 5, branch_name: 'cc/obj-5-feature', status: 'review' })
    const obj = resolveObjective(getDb(), { prNumberHint: null, headSha: 'x', repoFullName: REPO }, 'cc/obj-5-feature')
    expect(obj?.id).toBe(id)
  })

  it('skips objectives whose PR is no longer open (status=done)', () => {
    insertObjective({ pr_number: 99, status: 'done' })
    const obj = resolveObjective(getDb(), { prNumberHint: 99, headSha: 'x', repoFullName: REPO })
    expect(obj).toBeNull()
  })

  it('returns null when no objective is linked', () => {
    const obj = resolveObjective(getDb(), { prNumberHint: 123456, headSha: 'x', repoFullName: REPO })
    expect(obj).toBeNull()
  })
})

describe('isRemediableObjective', () => {
  it('true for an open PR-linked objective, false when done or unlinked', () => {
    expect(isRemediableObjective({ status: 'review', pr_number: 1, pr_url: null })).toBe(true)
    expect(isRemediableObjective({ status: 'working', pr_number: null, pr_url: 'https://x/pull/1' })).toBe(true)
    expect(isRemediableObjective({ status: 'done', pr_number: 1, pr_url: null })).toBe(false)
    expect(isRemediableObjective({ status: 'review', pr_number: null, pr_url: null })).toBe(false)
  })
})

// ── 3. Token discipline ─────────────────────────────────────────────────────────
describe('fetchFailureContext — token discipline', () => {
  it('Actions: uses gh run view --log-failed and never asks for the full log', async () => {
    const calls: string[][] = []
    const exec = async (file: string, args: string[]) => { calls.push([file, ...args]); return 'FAIL: expected 3 got 4\n  at foo.ts:10' }
    const out = await fetchFailureContext(
      { kind: 'workflow_run', checkName: 'Vitest', headSha: 's', repoFullName: REPO, prNumberHint: 1, runId: 555, checkRunId: null, targetUrl: null, outcome: 'failure' },
      null,
      exec,
    )
    expect(calls[0]).toContain('--log-failed')
    expect(calls[0]).not.toContain('--log') // the full-log flag is never used
    expect(out).toContain('expected 3 got 4')
  })

  it('check_run: pulls ONLY annotations, not logs', async () => {
    const exec = async (_f: string, args: string[]) => {
      expect(args.join(' ')).toContain('/annotations')
      return JSON.stringify([{ annotation_level: 'failure', path: 'a.ts', start_line: 4, message: 'boom' }])
    }
    const out = await fetchFailureContext(
      { kind: 'check_run', checkName: 'build', headSha: 's', repoFullName: REPO, prNumberHint: 1, runId: null, checkRunId: 7, targetUrl: null, outcome: 'failure' },
      null,
      exec,
    )
    expect(out).toContain('a.ts:4')
    expect(out).toContain('boom')
  })

  it('Vercel/status: does NOT fetch any log — only surfaces description + URL', async () => {
    let called = false
    const exec = async () => { called = true; return 'should not be called' }
    const out = await fetchFailureContext(
      { kind: 'status', checkName: 'vercel', headSha: 's', repoFullName: REPO, prNumberHint: null, runId: null, checkRunId: null, targetUrl: 'https://vercel/x', outcome: 'error' },
      'Build failed: type error',
      exec,
    )
    expect(called).toBe(false)
    expect(out).toContain('Build failed: type error')
    expect(out).toContain('https://vercel/x')
    expect(out).toContain('NOT fetched')
  })

  it('clipContext caps line count for token discipline', () => {
    const big = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n')
    const clipped = clipContext(big)
    expect(clipped.split('\n').length).toBeLessThan(120)
    expect(clipped).toContain('trimmed')
  })
})

// ── 4. Ships dark ───────────────────────────────────────────────────────────────
describe('ships dark (AUTO_REMEDIATION_ENABLED)', () => {
  it('flag defaults OFF', () => {
    expect(isRemediationEnabled({})).toBe(false)
    expect(isRemediationEnabled({ AUTO_REMEDIATION_ENABLED: 'false' })).toBe(false)
    expect(isRemediationEnabled({ AUTO_REMEDIATION_ENABLED: '1' })).toBe(true)
    expect(isRemediationEnabled({ AUTO_REMEDIATION_ENABLED: 'true' })).toBe(true)
  })

  it('the settings.auto_remediation_enabled toggle arms it with no env var', () => {
    const db = getDb()
    // seeded default is OFF
    expect(isRemediationEnabled({})).toBe(false)
    // owner flips the switch → armed, no env var needed (read at call time)
    db.prepare("UPDATE settings SET value = '1' WHERE key = 'auto_remediation_enabled'").run()
    expect(isRemediationEnabled({})).toBe(true)
    // and disarming is immediate
    db.prepare("UPDATE settings SET value = '0' WHERE key = 'auto_remediation_enabled'").run()
    expect(isRemediationEnabled({})).toBe(false)
  })

  it('a failing check does NOTHING (no sendFollowUp, no DB row) when the flag is off', async () => {
    const id = insertObjective({ pr_number: 42, status: 'review' })
    let spawned = 0
    const res = await handleExternalCheckEvent(
      'workflow_run',
      { repository: { full_name: REPO }, workflow_run: { id: 1, name: 'Vitest', status: 'completed', conclusion: 'failure', head_sha: 'sha', pull_requests: [{ number: 42 }] } },
      { db: getDb(), sendFollowUp: () => { spawned++; return 'x' }, broadcast: () => {}, env: {} },
    )
    expect(res.reason).toBe('disabled')
    expect(spawned).toBe(0)
    const rows = getDb().prepare('SELECT COUNT(*) AS n FROM external_check_remediations').get() as { n: number }
    expect(rows.n).toBe(0)
    expect(id).toBeGreaterThan(0)
  })
})

// ── 5. Idempotency + bounded loop + escalation ──────────────────────────────────
describe('handleExternalCheckEvent — dedup, cap, escalation', () => {
  const ENV = { AUTO_REMEDIATION_ENABLED: '1', MAX_REMEDIATION_ATTEMPTS: '3' }
  const noExec = async () => '' // no log fetch in these tests

  function event(sha: string, pr = 42, check = 'Vitest') {
    return { repository: { full_name: REPO }, workflow_run: { id: 1, name: check, status: 'completed', conclusion: 'failure', head_sha: sha, pull_requests: [{ number: pr }] } }
  }

  it('idempotency: re-delivery of the SAME (repo,pr,check,sha) remediates once, dups after', async () => {
    insertObjective({ pr_number: 42, status: 'review', session_id: 'cc-s' })
    let spawned = 0
    const deps = { db: getDb(), sendFollowUp: () => { spawned++; return 'cc-s' }, broadcast: () => {}, exec: noExec, env: ENV }

    const r1 = await handleExternalCheckEvent('workflow_run', event('sha-1'), deps)
    expect(r1.reason).toBe('remediated')
    expect(r1.attempt).toBe(1)

    const r2 = await handleExternalCheckEvent('workflow_run', event('sha-1'), deps)
    expect(r2.reason).toBe('duplicate')
    expect(spawned).toBe(1) // not re-spawned
  })

  it('bounded: caps at MAX attempts then escalates to a human-visible state exactly once', async () => {
    const id = insertObjective({ pr_number: 42, status: 'review', session_id: 'cc-s' })
    let spawned = 0
    const broadcasts: ServerMessage[] = []
    const deps = { db: getDb(), sendFollowUp: () => { spawned++; return 'cc-s' }, broadcast: (m: ServerMessage) => broadcasts.push(m), exec: noExec, env: ENV }

    // Each new commit SHA is a fresh attempt (the fix→push→new-sha→new-failure loop).
    const a1 = await handleExternalCheckEvent('workflow_run', event('s1'), deps)
    const a2 = await handleExternalCheckEvent('workflow_run', event('s2'), deps)
    const a3 = await handleExternalCheckEvent('workflow_run', event('s3'), deps)
    expect([a1.reason, a2.reason, a3.reason]).toEqual(['remediated', 'remediated', 'remediated'])
    expect(spawned).toBe(3)

    // 4th attempt exceeds cap=3 → escalate, no spawn.
    const a4 = await handleExternalCheckEvent('workflow_run', event('s4'), deps)
    expect(a4.reason).toBe('cap-exhausted')
    expect(spawned).toBe(3)

    const obj = getDb().prepare('SELECT has_blockers, last_session_summary FROM objectives WHERE id = ?').get(id) as { has_blockers: number; last_session_summary: string }
    expect(obj.has_blockers).toBe(1)
    expect(obj.last_session_summary).toContain('cap')

    // 5th attempt: already escalated → no re-escalation, no spawn.
    const a5 = await handleExternalCheckEvent('workflow_run', event('s5'), deps)
    expect(a5.reason).toBe('cap-exhausted-already-escalated')
    expect(spawned).toBe(3)
  })

  it('RELAXED (obj 702632 gap C): a FRESHLY-done objective still remediates — done-grace', async () => {
    // Objectives flip `done` minutes before their checks finish; the old strict
    // done-drop silently ate the failure. Fresh done (updated_at=now) → remediate.
    const id = insertObjective({ pr_number: 42, status: 'done', session_id: 'cc-s' })
    let spawned = 0
    const res = await handleExternalCheckEvent('workflow_run', event('s1'), { db: getDb(), sendFollowUp: () => { spawned++; return 'cc-s' }, broadcast: () => {}, exec: noExec, env: ENV })
    expect(res.reason).toBe('remediated')
    expect(res.objectiveId).toBe(id)
    expect(spawned).toBe(1)
  })

  it('done-grace EXPIRES: the done objective is NEVER resumed — the PR is inherited instead (obj 704698 gap D)', async () => {
    // Deliberate behaviour CHANGE. The invariant "a done-past-grace objective is not
    // resumed" still holds exactly (spawned stays 0, its status stays `done`); what
    // changes is that dropping the event used to orphan the red PR with nobody
    // responsible. It now gets a live owner.
    const id = insertObjective({ pr_number: 42, status: 'done', session_id: 'cc-s' })
    getDb().prepare("UPDATE objectives SET updated_at = datetime('now', '-10 days') WHERE id = ?").run(id)
    let spawned = 0
    const res = await handleExternalCheckEvent('workflow_run', event('s1'), { db: getDb(), sendFollowUp: () => { spawned++; return 'x' }, broadcast: () => {}, exec: noExec, env: ENV })
    expect(res.reason).toBe('orphan-inherited')
    expect(spawned).toBe(0)
    expect(res.objectiveId).not.toBe(id)
    const old = getDb().prepare('SELECT status FROM objectives WHERE id = ?').get(id) as { status: string }
    expect(old.status).toBe('done')
    const heir = getDb().prepare('SELECT pr_number, origin FROM objectives WHERE id = ?').get(res.objectiveId!) as { pr_number: number; origin: string }
    expect(heir).toMatchObject({ pr_number: 42, origin: 'ci-orphan-inherit' })
  })

  it('terminal_by_human is a HARD STOP — never resumed, and never re-homed to a new owner', async () => {
    const id = insertObjective({ pr_number: 42, status: 'done', session_id: 'cc-s' })
    getDb().prepare('UPDATE objectives SET terminal_by_human = 1 WHERE id = ?').run(id)
    let spawned = 0
    const res = await handleExternalCheckEvent('workflow_run', event('s1'), { db: getDb(), sendFollowUp: () => { spawned++; return 'x' }, broadcast: () => {}, exec: noExec, env: ENV })
    expect(res.reason).toBe('terminal-by-human')
    expect(spawned).toBe(0)
    const old = getDb().prepare('SELECT status FROM objectives WHERE id = ?').get(id) as { status: string }
    expect(old.status).toBe('done')
    // …and CI must not route around the human by inheriting the PR to a new owner.
    const heirs = getDb().prepare("SELECT COUNT(*) AS n FROM objectives WHERE origin IN ('ci-orphan-inherit','dependency-maintenance','unowned-pr-maintenance')").get() as { n: number }
    expect(heirs.n).toBe(0)
  })

  it('resolves + remediates a pr_number-NULL objective via pr_url (end-to-end fallback)', async () => {
    insertObjective({ pr_number: null, pr_url: `https://github.com/${REPO}/pull/42`, status: 'working', session_id: 'cc-s' })
    let prompt = ''
    const res = await handleExternalCheckEvent('workflow_run', event('s9'), {
      db: getDb(), sendFollowUp: (_s, m) => { prompt = m; return 'cc-s' }, broadcast: () => {}, exec: noExec, env: ENV,
    })
    expect(res.reason).toBe('remediated')
    expect(prompt).toContain('Vitest')
    expect(prompt).toContain('attempt 1/3')
  })

  it('never throws on a malformed payload (crash-safe)', async () => {
    const res = await handleExternalCheckEvent('workflow_run', { garbage: true } as Record<string, unknown>, {
      db: getDb(), sendFollowUp: () => 'x', broadcast: () => {}, env: ENV,
    })
    expect(res.handled).toBe(false)
  })
})

describe('maxRemediationAttempts', () => {
  it('defaults to 5 and is env-overridable', () => {
    expect(maxRemediationAttempts({})).toBe(5)
    expect(maxRemediationAttempts({ MAX_REMEDIATION_ATTEMPTS: '3' })).toBe(3)
    expect(maxRemediationAttempts({ MAX_REMEDIATION_ATTEMPTS: 'garbage' })).toBe(5)
  })
})
