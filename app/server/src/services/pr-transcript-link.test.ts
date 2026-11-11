import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { Objective } from '@operationkit/shared'

// obj 712954 — session-end PR linkage from the worker's own transcript. Real
// SQLite (objectives, objective_prs, objective_audit); `gh` is faked.
const TMP_DB = path.join(os.tmpdir(), `cc-prtranscript-test-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB

const { initDb, getDb } = await import('../db/index.js')
const { extractPrCandidates, decidePrLink, relinkPrFromTranscript, namesObjective } = await import('./pr-transcript-link.js')

const WS_REPO = 'Example-Project/example-project-platform'
const url = (n: number, repo = WS_REPO) => `https://github.com/${repo}/pull/${n}`
const J = (o: unknown) => JSON.stringify(o)

/** A Bash `gh pr create` call and its stdout, as the CLI writes them. */
function ghPrCreate(toolId: string, stdout: string): string[] {
  return [
    J({ type: 'assistant', message: { content: [{ type: 'tool_use', id: toolId, name: 'Bash', input: { command: `cd /tmp/wt && gh pr create --repo ${WS_REPO} --base main --title "x" --body "y"` } }] } }),
    J({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: toolId, content: stdout, is_error: false }] } }),
  ]
}
const codeChange = (u: string) =>
  J({ type: 'system', subtype: 'code_change_published', provider: 'github', url: u, repo: WS_REPO, action: 'pushed' })

function makeObjective(over: Partial<Objective> = {}): Objective {
  const db = getDb()
  const id = Number(db.prepare(
    "INSERT INTO objectives (title, description, status, agent_context, workspace) VALUES (?, '', 'working', 'cto', 'example-project')",
  ).run(over.title ?? 'Abner ledger').lastInsertRowid)
  db.prepare('UPDATE objectives SET create_pr = ?, pr_url = ?, pr_number = ?, branch_name = ?, session_id = ? WHERE id = ?')
    .run(over.create_pr ? 1 : 0, over.pr_url ?? null, over.pr_number ?? null, over.branch_name ?? null, over.session_id ?? `cc-${id}-1`, id)
  return db.prepare('SELECT * FROM objectives WHERE id = ?').get(id) as Objective
}
const row = (id: number) => getDb().prepare('SELECT pr_url, pr_number, branch_name FROM objectives WHERE id = ?').get(id) as { pr_url: string | null; pr_number: number | null; branch_name: string | null }
const audits = (id: number) => getDb().prepare("SELECT event_type, actor, pathway FROM objective_audit WHERE objective_id = ? AND event_type = 'pr_link'").all(id) as Array<{ event_type: string; actor: string; pathway: string }>

/** Fake gh: `pr view <n> --repo <repo>` → the configured state. */
function fakeGh(prs: Record<string, { state: string; headRefName: string; title: string }>) {
  const calls: string[][] = []
  const gh = async (args: string[]) => {
    calls.push(args)
    if (args[0] === 'pr' && args[1] === 'view') {
      const key = `${args[4]}@${args[2]}`
      const pr = prs[key]
      if (!pr) throw new Error(`no such PR ${key}`)
      return JSON.stringify(pr)
    }
    throw new Error(`unexpected gh ${args.join(' ')}`)
  }
  return { gh, calls }
}

beforeAll(() => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
})
afterAll(() => {
  try { getDb().close() } catch {}
  for (const s of ['', '-wal', '-shm']) { const f = `${TMP_DB}${s}`; if (fs.existsSync(f)) fs.unlinkSync(f) }
})
beforeEach(() => {
  const db = getDb()
  db.prepare('DELETE FROM objective_prs').run()
  db.prepare('DELETE FROM objective_audit').run()
  db.prepare('DELETE FROM objectives').run()
})

describe('extractPrCandidates', () => {
  it('reads the URL printed by `gh pr create` and code_change_published events, oldest → newest', () => {
    const lines = [
      ...ghPrCreate('t1', `Warning: 1 uncommitted change\n${url(715)}\n`),
      codeChange(url(715)),
      'garbage {',
      ...ghPrCreate('t2', `Creating pull request for ws-712923-round2 into main\n\n${url(716)}`),
    ]
    const c = extractPrCandidates(lines)
    expect(c.map(x => x.number)).toEqual([715, 716])
    expect(c[1]).toMatchObject({ repo: WS_REPO, source: 'gh-pr-create', url: url(716) })
    // The 715 mention via code_change keeps its stronger gh-pr-create provenance.
    expect(c[0].source).toBe('gh-pr-create')
  })

  it('ignores PR URLs in unrelated tool results and failed gh pr create calls', () => {
    const lines = [
      J({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'r', name: 'Bash', input: { command: 'gh pr view 99' } }] } }),
      J({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'r', content: url(99) }] } }),
      J({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'f', name: 'Bash', input: { command: 'gh pr create --title x' } }] } }),
      J({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'f', content: `a pull request already exists: ${url(12)}`, is_error: true }] } }),
    ]
    expect(extractPrCandidates(lines)).toEqual([])
  })
})

describe('namesObjective', () => {
  it('matches obj<id> / obj-<id> / ws-<id> but not a longer id', () => {
    expect(namesObjective(712937, 'feat/obj712937-finance-reconciliation')).toBe(true)
    expect(namesObjective(712923, 'ws-712923-round2-abner-credit-fixes')).toBe(true)
    expect(namesObjective(712954, 'cc/obj-712954-runner')).toBe(true)
    expect(namesObjective(71295, 'cc/obj-712954-runner')).toBe(false)
    expect(namesObjective(1, null, undefined)).toBe(false)
  })
})

describe('decidePrLink (pure)', () => {
  const c715 = { url: url(715), repo: WS_REPO, number: 715, source: 'gh-pr-create' as const }
  const c716 = { url: url(716), repo: WS_REPO, number: 716, source: 'gh-pr-create' as const }
  const info = (state: string) => () => ({ state: state as 'OPEN', headRefName: 'ws-712923-round2', title: 't' })

  it('never replaces an OPEN current link', () => {
    const d = decidePrLink({ objectiveId: 1, current: { pr_number: 715, pr_url: url(715) }, currentState: 'OPEN', candidates: [c715, c716], info: info('OPEN') })
    expect(d).toEqual({ action: 'skip', reason: 'current-open' })
  })

  it('does not guess when the current state is unknown', () => {
    const d = decidePrLink({ objectiveId: 1, current: { pr_number: 715, pr_url: url(715) }, currentState: null, candidates: [c716], info: info('OPEN') })
    expect(d).toEqual({ action: 'skip', reason: 'current-state-unknown' })
  })

  it('does not relink to an older or closed-unmerged PR', () => {
    const older = { ...c715, number: 700, url: url(700) }
    expect(decidePrLink({ objectiveId: 1, current: { pr_number: 715, pr_url: url(715) }, currentState: 'MERGED', candidates: [older], info: info('OPEN') }).action).toBe('skip')
    expect(decidePrLink({ objectiveId: 1, current: { pr_number: 715, pr_url: url(715) }, currentState: 'MERGED', candidates: [c716], info: info('CLOSED') }).action).toBe('skip')
  })

  it('requires a code_change-only candidate to name the objective', () => {
    const cc = { ...c716, source: 'code-change' as const }
    const foreign = () => ({ state: 'OPEN' as const, headRefName: 'someone-else', title: 'other work' })
    expect(decidePrLink({ objectiveId: 712923, current: { pr_number: null, pr_url: null }, currentState: null, candidates: [cc], info: foreign }).action).toBe('skip')
    const ours = () => ({ state: 'OPEN' as const, headRefName: 'ws-712923-round2-abner-credit-fixes', title: 'x' })
    expect(decidePrLink({ objectiveId: 712923, current: { pr_number: null, pr_url: null }, currentState: null, candidates: [cc], info: ours }).action).toBe('link')
  })
})

describe('relinkPrFromTranscript (session end)', () => {
  it('obj 712923 shape: card on MERGED PR 715, transcript opened PR 716 → relinked to PR 716 with an audit row', async () => {
    const obj = makeObjective({ pr_number: 715, pr_url: url(715), branch_name: 'ws-712923-abner-credit-ledger' })
    const { gh } = fakeGh({
      [`${WS_REPO}@715`]: { state: 'MERGED', headRefName: 'ws-712923-abner-credit-ledger', title: 'round 1' },
      [`${WS_REPO}@716`]: { state: 'OPEN', headRefName: 'ws-712923-round2-abner-credit-fixes', title: 'round 2' },
    })
    const lines = ghPrCreate('t', url(716))
    const r = await relinkPrFromTranscript(getDb(), obj, lines, gh)
    expect(r).toMatchObject({ linked: true, reason: 'relink-newer', pr_number: 716 })
    expect(row(obj.id)).toEqual({ pr_url: url(716), pr_number: 716, branch_name: 'ws-712923-round2-abner-credit-fixes' })
    const prs = getDb().prepare('SELECT repo, pr_number FROM objective_prs WHERE objective_id = ?').all(obj.id)
    expect(prs).toEqual([{ repo: WS_REPO, pr_number: 716 }])
    const a = audits(obj.id)
    expect(a).toHaveLength(1)
    expect(a[0].pathway).toContain(`${url(715)} -> ${url(716)}`)
  })

  it('obj 712937 shape: create_pr = 0 card with no link gets the PR from its transcript', async () => {
    const obj = makeObjective({ create_pr: false })
    const { gh } = fakeGh({
      [`${WS_REPO}@717`]: { state: 'OPEN', headRefName: 'feat/obj712937-finance-reconciliation', title: 'finance' },
    })
    const r = await relinkPrFromTranscript(getDb(), obj, [...ghPrCreate('t', url(717)), codeChange(url(717))], gh)
    expect(r).toMatchObject({ linked: true, reason: 'unlinked', pr_number: 717 })
    expect(row(obj.id)).toEqual({ pr_url: url(717), pr_number: 717, branch_name: 'feat/obj712937-finance-reconciliation' })
    expect(audits(obj.id)).toHaveLength(1)
  })

  it('links a gh-pr-create URL even when gh cannot see the repo (branch left as is)', async () => {
    const obj = makeObjective({ create_pr: false })
    const { gh } = fakeGh({})
    const r = await relinkPrFromTranscript(getDb(), obj, ghPrCreate('t', url(717)), gh)
    expect(r.linked).toBe(true)
    expect(row(obj.id)).toEqual({ pr_url: url(717), pr_number: 717, branch_name: null })
  })

  it('is a no-op (and makes no gh call) when the newest PR is already linked', async () => {
    const obj = makeObjective({ pr_number: 716, pr_url: url(716) })
    const { gh, calls } = fakeGh({})
    expect(await relinkPrFromTranscript(getDb(), obj, ghPrCreate('t', url(716)), gh)).toEqual({ linked: false, reason: 'already-linked' })
    expect(calls).toEqual([])
    expect(audits(obj.id)).toEqual([])
  })

  it('no PR in the transcript → nothing happens', async () => {
    const obj = makeObjective({})
    const { gh, calls } = fakeGh({})
    expect(await relinkPrFromTranscript(getDb(), obj, ['{"type":"result"}'], gh)).toEqual({ linked: false, reason: 'no-candidates' })
    expect(calls).toEqual([])
  })
})
