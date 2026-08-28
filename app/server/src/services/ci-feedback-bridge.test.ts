import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

// Real SQLite against the actual schema (incl. the external_check_remediations dedupe
// table this bridge shares with the webhook engine). The loop guard is SQL-backed, so an
// in-memory mock would not exercise what actually protects prod. Mirrors external-remediation.test.ts.
const TMP_DB = path.join(os.tmpdir(), `cc-cibridge-test-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB

const { initDb, getDb } = await import('../db/index.js')
const {
  extractObjectiveId,
  extractVitestFailureSummary,
  extractRunId,
  maxCiBridgeNudges,
  isCiBridgeEnabled,
  buildNudgeMessage,
  runCiFeedbackBridgeOnce,
} = await import('./ci-feedback-bridge.js')

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

const REPO = 'your-org/example-platform'

function insertObjective(id: number, status = 'done'): void {
  const db = getDb()
  db.prepare(`INSERT INTO objectives (id, title, status, session_id) VALUES (?, ?, ?, ?)`)
    .run(id, `test obj ${id}`, status, `cc-${id}-1`)
}

beforeEach(() => {
  const db = getDb()
  db.exec('DELETE FROM external_check_remediations')
  db.exec("DELETE FROM objectives WHERE title LIKE 'test obj%'")
})

// ── objid extraction ──────────────────────────────────────────────────────────
describe('extractObjectiveId', () => {
  it('extracts from a worker/<id>- branch', () => {
    expect(extractObjectiveId('worker/701604-email-validation', 'anything')).toBe(701604)
  })
  it('extracts from a title (obj <id>)', () => {
    expect(extractObjectiveId('feature/foo', 'fix(dialer): stuff (obj 701604)')).toBe(701604)
  })
  it('extracts from "objective #<id>" in title', () => {
    expect(extractObjectiveId(null, 'something objective #2384 blah')).toBe(2384)
  })
  it('prefers the branch id when both are present (branch is machine-generated)', () => {
    expect(extractObjectiveId('worker/999-x', 'title (obj 111)')).toBe(999)
  })
  it('returns null when no id is derivable — caller SKIPS, never guesses', () => {
    expect(extractObjectiveId('sec/phase1-hygiene', 'chore(security): Phase 1 hygiene floor')).toBeNull()
    expect(extractObjectiveId('', '')).toBeNull()
    expect(extractObjectiveId(null, null)).toBeNull()
  })
  it('does not match a bare number that is not an objective reference', () => {
    expect(extractObjectiveId('release/v2', 'bump to 3.14')).toBeNull()
  })
})

// ── run id + summary extraction ─────────────────────────────────────────────────
describe('extractRunId', () => {
  it('pulls the run id from an actions job link', () => {
    expect(extractRunId('https://github.com/your-org/example-platform/actions/runs/29116646793/job/86441584687')).toBe(29116646793)
  })
  it('returns null for a non-actions link', () => {
    expect(extractRunId('https://vercel.com/github')).toBeNull()
    expect(extractRunId(null)).toBeNull()
  })
})

describe('extractVitestFailureSummary', () => {
  // A realistic slice of `gh run view --log-failed`: ANSI codes + the
  // `<job>\t<step>\t<ISO ts> ` prefix, mixed pass/fail lines.
  const RAW = [
    'vitest (app suite)\tRun vitest\t2026-07-10T19:03:19.822Z  \x1b[32m✓\x1b[39m src/foo/passes.test.ts \x1b[2m(16 tests)\x1b[22m',
    'vitest (app suite)\tRun vitest\t2026-07-10T19:05:00.000Z \x1b[31m×\x1b[39m (b2) booked suppression blocks for 90d',
    'vitest (app suite)\tRun vitest\t2026-07-10T19:05:01.000Z \x1b[31m⎯⎯⎯\x1b[39m\x1b[1m Failed Tests 3 \x1b[22m\x1b[31m⎯⎯⎯\x1b[39m',
    'vitest (app suite)\tRun vitest\t2026-07-10T19:05:02.000Z \x1b[41m FAIL \x1b[49m src/lib/eligibility/contact-campaign-eligibility.integration.test.ts > (b2) booked suppression',
    'vitest (app suite)\tRun vitest\t2026-07-10T19:05:03.000Z \x1b[2m Test Files \x1b[22m 2 failed | 140 passed | 1 skipped (143)',
    'vitest (app suite)\tRun vitest\t2026-07-10T19:05:04.000Z \x1b[2m   Tests \x1b[22m 3 failed | 900 passed (903)',
  ].join('\n')

  it('keeps the failure skeleton and drops passing/noise lines', () => {
    const out = extractVitestFailureSummary(RAW)
    const norm = out.replace(/[ \t]+/g, ' ')
    expect(norm).toContain('Failed Tests 3')
    expect(norm).toMatch(/FAIL src\/lib\/eligibility\/contact-campaign-eligibility\.integration\.test\.ts/)
    expect(norm).toContain('Test Files 2 failed | 140 passed | 1 skipped (143)')
    expect(norm).toContain('Tests 3 failed | 900 passed (903)')
    expect(norm).toContain('× (b2) booked suppression')
    // passing line dropped
    expect(out).not.toContain('passes.test.ts')
    // ANSI stripped
    expect(out).not.toContain('\x1b')
    // gh prefix stripped
    expect(out).not.toContain('Run vitest')
  })
  it('returns empty string for no matching lines', () => {
    expect(extractVitestFailureSummary('all good\nno failures here')).toBe('')
    expect(extractVitestFailureSummary('')).toBe('')
  })
})

describe('maxCiBridgeNudges', () => {
  it('defaults to 5, honors a valid override, ignores garbage', () => {
    expect(maxCiBridgeNudges({})).toBe(5)
    expect(maxCiBridgeNudges({ MAX_CI_BRIDGE_NUDGES: '3' })).toBe(3)
    expect(maxCiBridgeNudges({ MAX_CI_BRIDGE_NUDGES: 'nope' })).toBe(5)
    expect(maxCiBridgeNudges({ MAX_CI_BRIDGE_NUDGES: '0' })).toBe(5)
  })
})

describe('isCiBridgeEnabled', () => {
  it('is OFF by default (settings seeded to 0)', () => {
    expect(isCiBridgeEnabled({}, getDb())).toBe(false)
  })
  it('an env truthy value wins', () => {
    expect(isCiBridgeEnabled({ CI_FEEDBACK_BRIDGE_ENABLED: 'true' }, getDb())).toBe(true)
  })
  it('reads the settings flag', () => {
    const db = getDb()
    db.prepare("UPDATE settings SET value = '1' WHERE key = 'ci_feedback_bridge_enabled'").run()
    expect(isCiBridgeEnabled({}, db)).toBe(true)
    db.prepare("UPDATE settings SET value = '0' WHERE key = 'ci_feedback_bridge_enabled'").run()
    expect(isCiBridgeEnabled({}, db)).toBe(false)
  })
})

describe('buildNudgeMessage', () => {
  it('includes the summary, attempt/cap, and a do-not-merge instruction', () => {
    const msg = buildNudgeMessage({ pr: 355, repo: REPO, headSha: 'f347a19', checkName: 'vitest (app suite)', link: 'http://x', summary: 'FAIL foo', attempt: 1, cap: 5 })
    expect(msg).toContain('attempt 1/5')
    expect(msg).toContain('FAIL foo')
    expect(msg).toContain('Do NOT')
    expect(msg).toContain('#355')
  })
})

// ── orchestration (injected exec + postMessage + real DB) ────────────────────────
type Posted = { objectiveId: number; message: string }

function makeDeps(prs: unknown[], checksByPr: Record<number, unknown[]>, logByRun: Record<number, string>, opts: { force?: boolean; env?: NodeJS.ProcessEnv } = {}) {
  const posted: Posted[] = []
  const exec = async (_file: string, args: string[]): Promise<string> => {
    if (args[0] === 'pr' && args[1] === 'list') return JSON.stringify(prs)
    if (args[0] === 'pr' && args[1] === 'checks') {
      const pr = Number(args[2])
      return JSON.stringify(checksByPr[pr] ?? [])
    }
    if (args[0] === 'run' && args[1] === 'view') {
      const runId = Number(args[2])
      return logByRun[runId] ?? ''
    }
    return ''
  }
  const postMessage = async (objectiveId: number, message: string) => {
    posted.push({ objectiveId, message })
    return { ok: true, status: 200, body: '{}' }
  }
  return {
    posted,
    deps: { db: getDb(), exec, postMessage, repo: REPO, force: opts.force, env: opts.env || {} },
  }
}

const failLog = 'j\ts\t2026-07-10T19:05:03.000Z \x1b[41m FAIL \x1b[49m src/x.test.ts > breaks\nj\ts\t2026-07-10T19:05:04.000Z  Tests 1 failed | 2 passed (3)'

describe('runCiFeedbackBridgeOnce — orchestration', () => {
  it('nudges the originating objective on a vitest FAILURE (force-enabled)', async () => {
    insertObjective(701604)
    const { posted, deps } = makeDeps(
      [{ number: 355, title: 'fix (obj 701604)', headRefName: 'worker/701604-email', headRefOid: 'sha-aaa' }],
      { 355: [{ name: 'vitest (app suite)', state: 'FAILURE', link: 'https://github.com/o/r/actions/runs/99/job/1' }] },
      { 99: failLog },
      { force: true },
    )
    const outs = await runCiFeedbackBridgeOnce(deps)
    expect(outs[0].action).toBe('nudged')
    expect(outs[0].objectiveId).toBe(701604)
    expect(posted).toHaveLength(1)
    expect(posted[0].objectiveId).toBe(701604)
    expect(posted[0].message.replace(/[ \t]+/g, ' ')).toContain('FAIL src/x.test.ts')
    // dedupe row persisted
    const n = (getDb().prepare('SELECT COUNT(*) AS n FROM external_check_remediations WHERE pr_number = 355').get() as { n: number }).n
    expect(n).toBe(1)
  })

  it('no-ops when vitest PASSES', async () => {
    insertObjective(701604)
    const { posted, deps } = makeDeps(
      [{ number: 355, title: 'x (obj 701604)', headRefName: 'worker/701604-email', headRefOid: 'sha-bbb' }],
      { 355: [{ name: 'vitest (app suite)', state: 'SUCCESS', link: 'l' }] },
      {},
      { force: true },
    )
    const outs = await runCiFeedbackBridgeOnce(deps)
    expect(outs[0].action).toBe('vitest-pass')
    expect(posted).toHaveLength(0)
  })

  it('SKIPS a PR with no derivable objective id (never guesses)', async () => {
    const { posted, deps } = makeDeps(
      [{ number: 239, title: 'chore(security): hygiene', headRefName: 'sec/phase1-hygiene', headRefOid: 'sha-ccc' }],
      { 239: [{ name: 'vitest', state: 'FAILURE', link: 'l' }] },
      {},
      { force: true },
    )
    const outs = await runCiFeedbackBridgeOnce(deps)
    expect(outs[0].action).toBe('no-objid')
    expect(posted).toHaveLength(0)
  })

  it('dedupes: the same failing SHA is nudged only once', async () => {
    insertObjective(701604)
    const mk = () => makeDeps(
      [{ number: 355, title: 'x (obj 701604)', headRefName: 'worker/701604-email', headRefOid: 'sha-DUP' }],
      { 355: [{ name: 'vitest', state: 'FAILURE', link: 'https://github.com/o/r/actions/runs/99/job/1' }] },
      { 99: failLog },
      { force: true },
    )
    const first = mk(); const out1 = await runCiFeedbackBridgeOnce(first.deps)
    expect(out1[0].action).toBe('nudged')
    const second = mk(); const out2 = await runCiFeedbackBridgeOnce(second.deps)
    expect(out2[0].action).toBe('duplicate')
    expect(second.posted).toHaveLength(0)
  })

  it('caps nudges per PR and escalates once (has_blockers)', async () => {
    insertObjective(701604)
    const db = getDb()
    // Pre-load the cap (5) worth of attempts on DIFFERENT shas so the next one exceeds it.
    for (let i = 0; i < 5; i++) {
      db.prepare(`INSERT INTO external_check_remediations (objective_id, repo, pr_number, check_name, head_sha, attempt) VALUES (?,?,?,?,?,?)`)
        .run(701604, REPO, 355, 'vitest', `old-sha-${i}`, i + 1)
    }
    const { posted, deps } = makeDeps(
      [{ number: 355, title: 'x (obj 701604)', headRefName: 'worker/701604-email', headRefOid: 'sha-NEW' }],
      { 355: [{ name: 'vitest', state: 'FAILURE', link: 'l' }] },
      {},
      { force: true },
    )
    const outs = await runCiFeedbackBridgeOnce(deps)
    expect(outs[0].action).toBe('cap-exhausted')
    expect(posted).toHaveLength(0)
    const blocked = (db.prepare('SELECT has_blockers FROM objectives WHERE id = 701604').get() as { has_blockers: number }).has_blockers
    expect(blocked).toBe(1)
  })

  it('DARK mode (flag off): logs intent, posts nothing, leaves no dedupe row', async () => {
    insertObjective(701604)
    const { posted, deps } = makeDeps(
      [{ number: 355, title: 'x (obj 701604)', headRefName: 'worker/701604-email', headRefOid: 'sha-dark' }],
      { 355: [{ name: 'vitest', state: 'FAILURE', link: 'https://github.com/o/r/actions/runs/99/job/1' }] },
      { 99: failLog },
      { force: false, env: {} }, // not forced, settings default 0 → disabled
    )
    const outs = await runCiFeedbackBridgeOnce(deps)
    expect(outs[0].action).toBe('disabled-dry-run')
    expect(posted).toHaveLength(0)
    const n = (getDb().prepare('SELECT COUNT(*) AS n FROM external_check_remediations WHERE head_sha = ?').get('sha-dark') as { n: number }).n
    expect(n).toBe(0)
  })
})
