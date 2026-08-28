// Convergence-gap coverage for the external-remediation loop (obj 704698, W2).
//
// The loop was ARMED but never CONVERGED — a red PR could stay red forever. Four gaps,
// one describe block each:
//   A. unfixable/environmental/advisory/scheduled checks burned the attempt cap
//   B. `cancelled` conclusions were ignored entirely → gate-cancelled jobs stayed red
//   C. PRs with no derivable objective (dependabot) had nobody responsible
//   D. nudges aimed at `done`-past-grace objectives were dropped, orphaning the PR
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { Objective } from '@command-center/shared'

const TMP_DB = path.join(os.tmpdir(), `cc-extrem-conv-test-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB

const { initDb, getDb } = await import('../db/index.js')
const {
  DEFAULT_CHECK_CLASS_RULES,
  classifyCheckFixability,
  loadCheckClassRules,
  classifyCancelledEvent,
} = await import('./external-remediation-classify.js')
const { resolveOwnerObjective } = await import('./external-remediation-resolve.js')
const { handleExternalCheckEvent } = await import('./external-remediation-act.js')

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

const REPO = 'EXAMPLE2/example3-platform'
const ENV = { AUTO_REMEDIATION_ENABLED: '1' } as NodeJS.ProcessEnv

let nextId = 704600
function insertObjective(fields: Partial<Objective> & { title?: string }): number {
  const id = fields.id ?? nextId++
  getDb()
    .prepare(
      `INSERT INTO objectives (id, title, status, session_id, pr_number, pr_url, branch_name, workspace, terminal_by_human, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))`,
    )
    .run(
      id,
      fields.title || 'test obj',
      fields.status || 'working',
      fields.session_id ?? 'cc-sess-1',
      fields.pr_number ?? null,
      fields.pr_url ?? null,
      fields.branch_name ?? null,
      fields.workspace ?? 'example2',
      fields.terminal_by_human ? 1 : 0,
      fields.updated_at ?? null,
    )
  return id
}

/** Recorder deps: nothing real is called. */
function makeDeps(overrides: Record<string, unknown> = {}) {
  const nudges: string[] = []
  const execCalls: string[][] = []
  const deps = {
    db: getDb(),
    sendFollowUp: (sessionId: string, message: string) => { nudges.push(message); return sessionId },
    broadcast: () => {},
    exec: async (file: string, args: string[]) => { execCalls.push([file, ...args]); return '' },
    env: ENV,
    ...overrides,
  }
  return { deps: deps as never, nudges, execCalls }
}

function checkRunPayload(name: string, conclusion: string, prNumber: number | null, sha = 'sha-aaa', branch = 'feat/x') {
  return {
    repository: { full_name: REPO },
    check_run: {
      status: 'completed',
      conclusion,
      name,
      head_sha: sha,
      id: 5551,
      details_url: 'https://github.com/x/runs/9',
      pull_requests: prNumber ? [{ number: prNumber }] : [],
      check_suite: { head_branch: branch },
    },
    branches: [{ name: branch }],
  }
}

function workflowRunPayload(name: string, conclusion: string, opts: { pr?: number | null; sha?: string; branch?: string; event?: string; runId?: number } = {}) {
  return {
    repository: { full_name: REPO },
    workflow_run: {
      status: 'completed',
      conclusion,
      name,
      head_sha: opts.sha ?? 'sha-bbb',
      head_branch: opts.branch ?? 'feat/y',
      id: opts.runId ?? 77771,
      event: opts.event ?? 'pull_request',
      html_url: 'https://github.com/x/actions/runs/77771',
      pull_requests: opts.pr ? [{ number: opts.pr }] : [],
    },
  }
}

beforeEach(() => {
  const db = getDb()
  db.exec('DELETE FROM external_check_remediations')
  db.exec('DELETE FROM objectives')
})

// ── GAP A ──────────────────────────────────────────────────────────────────────
describe('gap A — check fixability classifier', () => {
  it('classifies the real not-code-fixable checks seen in external_check_remediations', () => {
    expect(classifyCheckFixability('Verify migrations applied to prod')).toMatchObject({ class: 'environmental', fixable: false })
    expect(classifyCheckFixability('Vercel')).toMatchObject({ class: 'environmental', fixable: false })
    expect(classifyCheckFixability('Claude security review (advisory)')).toMatchObject({ class: 'advisory', fixable: false })
    expect(classifyCheckFixability('ReadyMode dialer-performance 6pm ET')).toMatchObject({ class: 'scheduled', fixable: false })
    expect(classifyCheckFixability('ReadyMode dialer data-freshness check')).toMatchObject({ class: 'scheduled', fixable: false })
    expect(classifyCheckFixability('ReadyMode recordings delta ingest')).toMatchObject({ class: 'scheduled', fixable: false })
  })

  it('leaves genuine code checks fixable', () => {
    for (const name of ['Vitest Suite', 'Typecheck', 'Migration gate', 'gitleaks', 'E2E Smoke (Playwright)', 'tsc --noEmit (full repo incl. tests/e2e)', 'Scan for secrets', 'Adversarial RLS suite (8th config)', 'security-review']) {
      expect(classifyCheckFixability(name), name).toMatchObject({ class: 'code-fixable', fixable: true })
    }
  })

  it('treats any schedule-triggered workflow_run as scheduled regardless of name', () => {
    expect(classifyCheckFixability('Vitest Suite', { triggerEvent: 'schedule' })).toMatchObject({ class: 'scheduled', fixable: false })
  })

  it('is data-driven: rules come from a table and are overridable via env JSON', () => {
    expect(Array.isArray(DEFAULT_CHECK_CLASS_RULES)).toBe(true)
    expect(DEFAULT_CHECK_CLASS_RULES.length).toBeGreaterThan(3)
    const custom = JSON.stringify([{ id: 'x', pattern: '^Vitest Suite$', class: 'environmental', reason: 'operator override' }])
    const rules = loadCheckClassRules({ env: { REMEDIATION_CHECK_CLASS_RULES: custom } as NodeJS.ProcessEnv })
    expect(classifyCheckFixability('Vitest Suite', { rules })).toMatchObject({ class: 'environmental', fixable: false, reason: 'operator override' })
    // malformed config must not break classification
    const safe = loadCheckClassRules({ env: { REMEDIATION_CHECK_CLASS_RULES: '{{{not json' } as NodeJS.ProcessEnv })
    expect(safe.length).toBe(DEFAULT_CHECK_CLASS_RULES.length)
  })

  it('escalates a non-fixable check once instead of nudging a worker', async () => {
    const id = insertObjective({ pr_number: 646, branch_name: 'feat/x', status: 'review' })
    const { deps, nudges } = makeDeps()
    const r = await handleExternalCheckEvent('check_run', checkRunPayload('Verify migrations applied to prod', 'failure', 646), deps)
    expect(r.reason).toBe('not-code-fixable')
    expect(r.objectiveId).toBe(id)
    expect(nudges).toHaveLength(0)
    const obj = getDb().prepare('SELECT has_blockers, last_session_summary, status FROM objectives WHERE id = ?').get(id) as { has_blockers: number; last_session_summary: string; status: string }
    expect(obj.has_blockers).toBe(1)
    expect(obj.last_session_summary).toMatch(/environmental|no code push/i)
    expect(obj.status).toBe('review') // untouched — no session was resumed for it
  })

  it('does NOT let non-fixable checks consume the code-fixable attempt budget', async () => {
    insertObjective({ pr_number: 646, branch_name: 'feat/x' })
    const { deps, nudges } = makeDeps()
    for (const [name, sha] of [['Vercel', 's1'], ['Verify migrations applied to prod', 's2'], ['Claude security review (advisory)', 's3']] as const) {
      await handleExternalCheckEvent('check_run', checkRunPayload(name, 'failure', 646, sha), deps)
    }
    expect(nudges).toHaveLength(0)
    const r = await handleExternalCheckEvent('check_run', checkRunPayload('Vitest Suite', 'failure', 646, 's4'), deps)
    expect(r.reason).toBe('remediated')
    expect(r.attempt).toBe(1) // NOT 4 — the three environmental rows are excluded
  })

  it('is idempotent on webhook re-delivery of a non-fixable check', async () => {
    insertObjective({ pr_number: 646, branch_name: 'feat/x' })
    const { deps } = makeDeps()
    const p = checkRunPayload('Vercel', 'failure', 646)
    expect((await handleExternalCheckEvent('check_run', p, deps)).reason).toBe('not-code-fixable')
    expect((await handleExternalCheckEvent('check_run', p, deps)).reason).toBe('not-code-fixable-duplicate')
  })
})

// ── GAP B ──────────────────────────────────────────────────────────────────────
describe('gap B — cancelled runs are re-dispatched, bounded', () => {
  it('classifyCheckEvent contract is unchanged: cancelled is not a failure', async () => {
    const { classifyCheckEvent } = await import('./external-remediation-classify.js')
    expect(classifyCheckEvent('workflow_run', workflowRunPayload('Vitest Suite', 'cancelled', { pr: 700 }))).toBeNull()
    expect(classifyCancelledEvent('workflow_run', workflowRunPayload('Vitest Suite', 'cancelled', { pr: 700 }))).toMatchObject({ checkName: 'Vitest Suite', outcome: 'cancelled' })
    expect(classifyCancelledEvent('workflow_run', workflowRunPayload('Vitest Suite', 'failure', { pr: 700 }))).toBeNull()
  })

  it('re-runs the cancelled workflow instead of messaging a worker', async () => {
    insertObjective({ pr_number: 700, branch_name: 'feat/y' })
    const { deps, nudges, execCalls } = makeDeps()
    const r = await handleExternalCheckEvent('workflow_run', workflowRunPayload('Vitest Suite', 'cancelled', { pr: 700, runId: 4242 }), deps)
    expect(r.reason).toBe('cancelled-rerun')
    expect(nudges).toHaveLength(0)
    expect(execCalls.some(c => c[0] === 'gh' && c[1] === 'run' && c[2] === 'rerun' && c[3] === '4242')).toBe(true)
  })

  it('caps re-runs per (repo, pr, head_sha) so it can never loop', async () => {
    insertObjective({ pr_number: 700, branch_name: 'feat/y' })
    const { deps, execCalls } = makeDeps()
    const first = await handleExternalCheckEvent('workflow_run', workflowRunPayload('Vitest Suite', 'cancelled', { pr: 700, sha: 'same-sha', runId: 1 }), deps)
    expect(first.reason).toBe('cancelled-rerun')
    // a DIFFERENT cancelled check on the SAME head sha must not compound
    const second = await handleExternalCheckEvent('workflow_run', workflowRunPayload('Typecheck', 'cancelled', { pr: 700, sha: 'same-sha', runId: 2 }), deps)
    expect(second.reason).toBe('cancelled-rerun-capped')
    const third = await handleExternalCheckEvent('workflow_run', workflowRunPayload('Vitest Suite', 'cancelled', { pr: 700, sha: 'same-sha', runId: 3 }), deps)
    expect(third.reason).toBe('cancelled-rerun-capped')
    expect(execCalls.filter(c => c[2] === 'rerun')).toHaveLength(1)
    // a new head sha (a real push) gets its own single re-run
    const push = await handleExternalCheckEvent('workflow_run', workflowRunPayload('Vitest Suite', 'cancelled', { pr: 700, sha: 'new-sha', runId: 4 }), deps)
    expect(push.reason).toBe('cancelled-rerun')
    expect(execCalls.filter(c => c[2] === 'rerun')).toHaveLength(2)
  })

  // Regression from the LIVE event that nudged this very objective: run 31123994413
  // reported conclusion 'failure' while both jobs were 'cancelled' with zero steps —
  // they never got a runner. The run-level conclusion alone is not enough.
  it("treats a workflow_run that concluded 'failure' with only CANCELLED jobs as a cancellation", async () => {
    insertObjective({ pr_number: 246, branch_name: 'obj-704698-ci-convergence' })
    const execCalls: string[][] = []
    const nudges: string[] = []
    const deps = {
      db: getDb(),
      sendFollowUp: (s: string, m: string) => { nudges.push(m); return s },
      broadcast: () => {},
      exec: async (file: string, args: string[]) => {
        execCalls.push([file, ...args])
        return args.includes('--jq') && args.some(a => a.includes('/jobs')) ? '["cancelled","cancelled"]' : ''
      },
      env: ENV,
    } as never
    const r = await handleExternalCheckEvent('workflow_run', workflowRunPayload('test', 'failure', { pr: 246, branch: 'obj-704698-ci-convergence', runId: 31123994413 }), deps)
    expect(r.reason).toBe('cancelled-rerun')
    expect(nudges).toHaveLength(0) // the false nudge this objective actually received
    expect(execCalls.some(c => c[2] === 'rerun')).toBe(true)
  })

  it('still nudges normally when a job genuinely FAILED alongside cancelled ones', async () => {
    const id = insertObjective({ pr_number: 247, branch_name: 'feat/z' })
    const nudges: string[] = []
    const deps = {
      db: getDb(),
      sendFollowUp: (s: string, m: string) => { nudges.push(m); return s },
      broadcast: () => {},
      exec: async (_f: string, args: string[]) =>
        args.some(a => a.includes('/jobs')) ? '["failure","cancelled"]' : '',
      env: ENV,
    } as never
    const r = await handleExternalCheckEvent('workflow_run', workflowRunPayload('test', 'failure', { pr: 247, branch: 'feat/z', runId: 99 }), deps)
    expect(r.reason).toBe('remediated')
    expect(r.objectiveId).toBe(id)
    expect(nudges).toHaveLength(1)
  })

  it('falls through to the normal failure path when the jobs API is unreadable', async () => {
    const id = insertObjective({ pr_number: 248, branch_name: 'feat/w' })
    const nudges: string[] = []
    const deps = {
      db: getDb(),
      sendFollowUp: (s: string, m: string) => { nudges.push(m); return s },
      broadcast: () => {},
      exec: async (_f: string, args: string[]) => (args.some(a => a.includes('/jobs')) ? 'not json at all' : ''),
      env: ENV,
    } as never
    const r = await handleExternalCheckEvent('workflow_run', workflowRunPayload('test', 'failure', { pr: 248, branch: 'feat/w', runId: 98 }), deps)
    expect(r.reason).toBe('remediated')
    expect(r.objectiveId).toBe(id)
    expect(nudges).toHaveLength(1)
  })

  it('ignores cancelled events with no PR handle rather than guessing', async () => {
    const { deps, execCalls } = makeDeps()
    const r = await handleExternalCheckEvent('workflow_run', workflowRunPayload('Nightly cron', 'cancelled', { pr: null, branch: 'main' }), deps)
    expect(r.reason).toBe('cancelled-ignored')
    expect(execCalls).toHaveLength(0)
  })
})

// ── GAP C ──────────────────────────────────────────────────────────────────────
describe('gap C — PRs with no objective still get an owner', () => {
  it('gives dependabot PRs a single reused maintenance objective', async () => {
    const { deps, nudges } = makeDeps()
    const r1 = await handleExternalCheckEvent('check_run', checkRunPayload('Vitest Suite', 'failure', 331, 'sha-1', 'dependabot/npm_and_yarn/vite-5'), deps)
    expect(r1.reason).toBe('unowned-pr-owned')
    expect(r1.objectiveId).toBeGreaterThan(0)
    const r2 = await handleExternalCheckEvent('check_run', checkRunPayload('Typecheck', 'failure', 338, 'sha-2', 'dependabot/npm_and_yarn/zod-4'), deps)
    expect(r2.reason).toBe('unowned-pr-owned')
    expect(r2.objectiveId).toBe(r1.objectiveId) // ONE maintenance objective, not one per PR
    expect(nudges).toHaveLength(0)
    const card = getDb().prepare('SELECT title, description, status, origin FROM objectives WHERE id = ?').get(r1.objectiveId!) as { title: string; description: string; status: string; origin: string }
    expect(card.origin).toBe('dependency-maintenance')
    expect(card.description).toContain('#331')
    expect(card.description).toContain('#338')
    expect(['queue', 'working']).toContain(card.status)
  })

  it('gives a non-dependabot unowned PR an owner too (never a silent drop)', async () => {
    const { deps } = makeDeps()
    const r = await handleExternalCheckEvent('check_run', checkRunPayload('Vitest Suite', 'failure', 999, 'sha-9', 'someones/manual-branch'), deps)
    expect(r.reason).toBe('unowned-pr-owned')
    const card = getDb().prepare('SELECT origin, description FROM objectives WHERE id = ?').get(r.objectiveId!) as { origin: string; description: string }
    expect(card.origin).toBe('unowned-pr-maintenance')
    expect(card.description).toContain('#999')
  })

  it('is idempotent on re-delivery for the same (pr, check, sha)', async () => {
    const { deps } = makeDeps()
    const p = checkRunPayload('Vitest Suite', 'failure', 331, 'sha-1', 'dependabot/npm_and_yarn/vite-5')
    expect((await handleExternalCheckEvent('check_run', p, deps)).reason).toBe('unowned-pr-owned')
    expect((await handleExternalCheckEvent('check_run', p, deps)).reason).toBe('unowned-pr-duplicate')
    const n = getDb().prepare("SELECT COUNT(*) n FROM objectives WHERE origin = 'dependency-maintenance'").get() as { n: number }
    expect(n.n).toBe(1)
  })
})

// ── GAP D ──────────────────────────────────────────────────────────────────────
describe('gap D — done-past-grace objectives hand the PR to a live owner', () => {
  it('resolveOwnerObjective surfaces the ineligible owner and why', () => {
    const id = insertObjective({ pr_number: 555, status: 'done', updated_at: '2020-01-01 00:00:00' })
    const got = resolveOwnerObjective(getDb(), { prNumberHint: 555, headSha: 'x', repoFullName: REPO }, null)
    expect(got.objective?.id).toBe(id)
    expect(got.eligible).toBe(false)
    expect(got.blockedBy).toBe('done-past-grace')
  })

  it('spawns a fresh inheritor objective that carries the PR', async () => {
    const doneId = insertObjective({ pr_number: 555, pr_url: `https://github.com/${REPO}/pull/555`, branch_name: 'feat/old', status: 'done', updated_at: '2020-01-01 00:00:00' })
    const { deps, nudges } = makeDeps()
    const r = await handleExternalCheckEvent('check_run', checkRunPayload('Vitest Suite', 'failure', 555, 'sha-d', 'feat/old'), deps)
    expect(r.reason).toBe('orphan-inherited')
    expect(r.objectiveId).not.toBe(doneId)
    expect(nudges).toHaveLength(0)
    const heir = getDb().prepare('SELECT * FROM objectives WHERE id = ?').get(r.objectiveId!) as Objective & { origin: string }
    expect(heir.pr_number).toBe(555)
    expect(heir.branch_name).toBe('feat/old')
    expect(heir.origin).toBe('ci-orphan-inherit')
    expect(['queue', 'working']).toContain(heir.status)
    // the done objective is NOT resurrected
    const old = getDb().prepare('SELECT status FROM objectives WHERE id = ?').get(doneId) as { status: string }
    expect(old.status).toBe('done')
    // only one heir ever
    const again = await handleExternalCheckEvent('check_run', checkRunPayload('Typecheck', 'failure', 555, 'sha-e', 'feat/old'), deps)
    expect(['remediated', 'orphan-duplicate']).toContain(again.reason)
    const heirs = getDb().prepare("SELECT COUNT(*) n FROM objectives WHERE origin = 'ci-orphan-inherit'").get() as { n: number }
    expect(heirs.n).toBe(1)
  })

  it('HARD STOP: terminal_by_human is never resurrected and never inherited', async () => {
    const id = insertObjective({ pr_number: 556, branch_name: 'feat/parked', status: 'done', terminal_by_human: 1 as never, updated_at: '2020-01-01 00:00:00' })
    const { deps, nudges } = makeDeps()
    const r = await handleExternalCheckEvent('check_run', checkRunPayload('Vitest Suite', 'failure', 556, 'sha-t', 'feat/parked'), deps)
    expect(r.reason).toBe('terminal-by-human')
    expect(nudges).toHaveLength(0)
    const old = getDb().prepare('SELECT status FROM objectives WHERE id = ?').get(id) as { status: string }
    expect(old.status).toBe('done')
    const heirs = getDb().prepare("SELECT COUNT(*) n FROM objectives WHERE origin IN ('ci-orphan-inherit','unowned-pr-maintenance','dependency-maintenance')").get() as { n: number }
    expect(heirs.n).toBe(0)
  })

  it('a fresh done objective inside the grace window still remediates directly', async () => {
    const id = insertObjective({ pr_number: 557, branch_name: 'feat/fresh', status: 'done' })
    const { deps, nudges } = makeDeps()
    const r = await handleExternalCheckEvent('check_run', checkRunPayload('Vitest Suite', 'failure', 557, 'sha-f', 'feat/fresh'), deps)
    expect(r.reason).toBe('remediated')
    expect(r.objectiveId).toBe(id)
    expect(nudges).toHaveLength(1)
  })
})

// ── invariants ─────────────────────────────────────────────────────────────────
describe('invariants still hold on the new paths', () => {
  it('never throws to the webhook route, whatever the payload', async () => {
    const { deps } = makeDeps()
    for (const p of [null, undefined, {}, { repository: null }, { check_run: { status: 'completed', conclusion: 'cancelled' } }]) {
      await expect(handleExternalCheckEvent('check_run', p as never, deps)).resolves.toBeTruthy()
    }
  })

  it('stays inert when the flag is off, on every new path', async () => {
    const { deps, nudges, execCalls } = makeDeps({ env: {} as NodeJS.ProcessEnv })
    for (const ev of [
      ['check_run', checkRunPayload('Vercel', 'failure', 646)],
      ['workflow_run', workflowRunPayload('Vitest Suite', 'cancelled', { pr: 700 })],
      ['check_run', checkRunPayload('Vitest Suite', 'failure', 331, 'sha-1', 'dependabot/npm_and_yarn/vite-5')],
    ] as const) {
      const r = await handleExternalCheckEvent(ev[0], ev[1] as never, deps)
      expect(r.reason).toBe('disabled')
    }
    expect(nudges).toHaveLength(0)
    expect(execCalls).toHaveLength(0)
    const n = getDb().prepare('SELECT COUNT(*) n FROM objectives').get() as { n: number }
    expect(n.n).toBe(0)
  })

  it('never remediates or re-runs a harness/* check', async () => {
    insertObjective({ pr_number: 646, branch_name: 'feat/x' })
    const { deps, nudges, execCalls } = makeDeps()
    expect((await handleExternalCheckEvent('check_run', checkRunPayload('harness/test-agent', 'failure', 646), deps)).handled).toBe(false)
    expect((await handleExternalCheckEvent('workflow_run', workflowRunPayload('harness/test-agent', 'cancelled', { pr: 646 }), deps)).handled).toBe(false)
    expect(nudges).toHaveLength(0)
    expect(execCalls).toHaveLength(0)
  })
})
