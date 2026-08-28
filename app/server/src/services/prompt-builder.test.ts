import { describe, it, expect, beforeAll } from 'vitest'
import os from 'os'
import path from 'path'
import fs from 'fs'

// buildPrompt → buildContext → getDb(), so the DB must be initialized first.
// Point it at a throwaway temp file before importing the modules that read DB_PATH.
// Use pid + timestamp (matching strategy-governance.test / false-pass.test) so a
// stale DB from a prior run with an older schema can never be reused — a fixed
// per-pid path collides across runs in a shared host and re-inits a half-built
// gate_false_pass, surfacing as a spurious "no such column: source".
const TMP_DB = path.join(os.tmpdir(), `cc-prompt-builder-test-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB

import { initDb, getDb } from '../db/index.js'
import { buildPrompt, resolveWorkdir, loadWorkspacesConfig, resolveGithubRepo } from './prompt-builder.js'
import { HOME_DIR, PROJECTS_DIR, WORKSPACES_JSON } from '../config.js'
import type { Objective, AcceptanceCriterion } from '@command-center/shared'

beforeAll(() => {
  initDb()
})

// Minimal-but-complete Objective. Defaults chosen so the QW2 (unconditional
// self-verify) assertion is meaningful: create_pr=false AND project=null means
// the conditional Git-Workflow block is NOT emitted, so the self-verify line can
// only come from the unconditional Operating Principles injection.
function makeObjective(overrides: Partial<Objective> = {}): Objective {
  return {
    id: 999999,
    title: 'Sample worker objective',
    description: 'A sample objective for prompt-builder tests.',
    status: 'working',
    agent_context: 'cto',
    workspace: 'personal',
    project: null,
    category: 'build',
    parent_id: null,
    depth: 0,
    assigned_user_id: null,
    routine_id: null,
    created_by: null,
    session_id: null,
    transcript_path: null,
    last_session_summary: null,
    session_count: 0,
    total_cost_usd: 0,
    total_tokens: 0,
    has_blockers: false,
    delegate_mode: false,
    create_pr: false,
    branch_name: null,
    pr_url: null,
    pr_number: null,
    completion_goal: null,
    workflow_hint: null,
    effort: 'medium',
    model: 'default',
    type: 'task',
    approved_plan: null,
    plan_approved_at: null,
    planning_session_id: null,
    ai_review_verdict: null,
    ai_review_findings: null,
    ai_review_session_id: null,
    skip_ai_review: false,
    acceptance_criteria: null,
    ai_review_iteration: 0,
    test_cred_slug: null,
    created_at: '2026-06-16T00:00:00Z',
    updated_at: '2026-06-16T00:00:00Z',
    ...overrides,
  } as Objective
}

const CRITERIA: AcceptanceCriterion[] = [
  { id: 'criteria-block-present', criterion: 'The worker prompt lists each acceptance criterion verbatim', type: 'functional', method: 'doc' },
  { id: 'self-verify-line', criterion: 'The worker is told to run tests and paste output before done', type: 'functional', method: 'doc' },
]

describe('buildPrompt — QW1 (inject acceptance_criteria)', () => {
  it('renders the criteria block with each criterion id, text, type, and method', () => {
    const prompt = buildPrompt(makeObjective({ acceptance_criteria: CRITERIA }))
    expect(prompt).toContain('## The bar you are graded against (acceptance criteria)')
    for (const c of CRITERIA) {
      expect(prompt).toContain(`[${c.id}] ${c.criterion} (type: ${c.type}, verify via: ${c.method})`)
    }
  })

  // obj 706866 (distill 2026-08-19): three objectives (706759/706763/706766) failed
  // adversarial review for the same root cause — correct code, but the runtime PROOF
  // ARTIFACT the criterion named was never produced (and in one case one screenshot
  // was reused byte-identically across five roles). The criteria block must carry the
  // artifact-vs-correctness rule, and only when criteria are actually rendered.
  it('carries the artifact-discipline rule inside the criteria block', () => {
    const prompt = buildPrompt(makeObjective({ acceptance_criteria: CRITERIA }))
    expect(prompt).toContain('satisfy it by PRODUCING that artifact')
    expect(prompt).toContain('byte-identical')
    // it belongs to the criteria block: after the header, before the first criterion
    const header = prompt.indexOf('## The bar you are graded against (acceptance criteria)')
    const rule = prompt.indexOf('satisfy it by PRODUCING that artifact')
    const firstCriterion = prompt.indexOf(`[${CRITERIA[0].id}] ${CRITERIA[0].criterion}`)
    expect(header).toBeGreaterThanOrEqual(0)
    expect(rule).toBeGreaterThan(header)
    expect(firstCriterion).toBeGreaterThan(rule)
  })

  it('omits the artifact-discipline rule when there are no criteria to grade', () => {
    expect(buildPrompt(makeObjective({ acceptance_criteria: null }))).not.toContain('satisfy it by PRODUCING that artifact')
  })

  it('emits no criteria block when acceptance_criteria is empty', () => {
    expect(buildPrompt(makeObjective({ acceptance_criteria: [] }))).not.toContain('## The bar you are graded against')
  })

  it('emits no criteria block when acceptance_criteria is null', () => {
    expect(buildPrompt(makeObjective({ acceptance_criteria: null }))).not.toContain('## The bar you are graded against')
  })

  // obj 1180 regression: raw DB rows (startSession / sendFollowUp) pass
  // acceptance_criteria as the JSON STRING stored in SQLite, not a parsed array.
  // A string passes a `.length` truthy check but `.map()` throws TypeError, which
  // — inside an async route handler with no try/catch — was crash-looping the
  // whole server (502s + blank logs). buildPrompt must parse the string and still
  // render the block, never throw.
  it('parses a raw JSON-string acceptance_criteria without throwing and renders the block', () => {
    const raw = JSON.stringify(CRITERIA)
    const obj = makeObjective({ acceptance_criteria: raw as unknown as AcceptanceCriterion[] })
    let prompt = ''
    expect(() => { prompt = buildPrompt(obj) }).not.toThrow()
    expect(prompt).toContain('## The bar you are graded against (acceptance criteria)')
    for (const c of CRITERIA) {
      expect(prompt).toContain(`[${c.id}] ${c.criterion} (type: ${c.type}, verify via: ${c.method})`)
    }
  })

  it('does not throw or render the block on a malformed acceptance_criteria string', () => {
    const obj = makeObjective({ acceptance_criteria: '{not valid json' as unknown as AcceptanceCriterion[] })
    let prompt = ''
    expect(() => { prompt = buildPrompt(obj) }).not.toThrow()
    expect(prompt).not.toContain('## The bar you are graded against')
  })
})

describe('buildPrompt — checkpoint the file deliverable to disk EARLY', () => {
  it('reaches a plain research worker (no PR, no project)', () => {
    const prompt = buildPrompt(makeObjective({ create_pr: false, project: null }))
    expect(prompt).toContain('write it to its FINAL target path EARLY')
    expect(prompt).toContain('Do NOT hold the whole artifact in context for one single final write')
  })

  it('reaches a PR-building code worker too', () => {
    const prompt = buildPrompt(makeObjective({ create_pr: true, project: 'command-center' }))
    expect(prompt).toContain('write it to its FINAL target path EARLY')
  })
})

describe('buildPrompt — sibling artifact guard', () => {
  it('tells workers the proof must be theirs on their branch when criteria exist', () => {
    const prompt = buildPrompt(makeObjective({
      acceptance_criteria: [{ id: 'x', criterion: 'ship a file', type: 'functional', method: 'doc' }],
    }))
    expect(prompt).toContain('The proof must be YOURS and land on YOUR branch')
  })
})

describe('buildPrompt — async-gated evidence', () => {
  it('is present for execution sessions and absent for delegators', () => {
    const worker = buildPrompt(makeObjective({ delegate_mode: false }))
    expect(worker).toContain('Async-gated evidence')
    const delegator = buildPrompt(makeObjective({ delegate_mode: true }))
    expect(delegator).not.toContain('Async-gated evidence')
    expect(delegator).toContain('Do NOT write a criterion whose proof is a FUTURE wall-clock event')
  })
})

describe('buildPrompt — acting-user identity', () => {
  it('tells the session to send mail only as USER_GOOGLE_EMAIL and not invent another account', () => {
    const prompt = buildPrompt(makeObjective({ create_pr: false, project: null }))
    expect(prompt).toContain('## Identity (this session — do not improvise)')
    expect(prompt).toContain('USER_GOOGLE_EMAIL')
    expect(prompt).toContain('GOOGLE_WORKSPACE_CONNECTION=absent')
    expect(prompt).toContain('CC_ACTING_USER_ID')
  })
})

describe('buildPrompt — token-conservation wording', () => {
  it('does not tell workers they have ample context or to sub-agent every chunk', () => {
    const prompt = buildPrompt(makeObjective({ create_pr: false, project: null }))
    expect(prompt).not.toContain('You have ample context remaining')
    expect(prompt).not.toContain('spawn a sub-agent for any self-contained chunk')
    expect(prompt).toContain('If you are looping without new evidence, stop')
    expect(prompt).toContain('Nested sub-agents bill the same account')
  })

  it('tells delegators to omit model so workers land on Sonnet', () => {
    const prompt = buildPrompt(makeObjective({ delegate_mode: true }))
    expect(prompt).toContain('Omit "model" to use Sonnet for workers')
  })
})

describe('buildPrompt — Talking to the human', () => {
  it('injects the human-voice block and high-agency pause rule', () => {
    const prompt = buildPrompt(makeObjective({ create_pr: false, project: null }))
    expect(prompt).toContain('## Talking to the human')
    expect(prompt).toContain('Write like a colleague sitting next to them')
    expect(prompt).toContain('Anything you can do with an API, Playwright, Google, GitHub, or the filesystem')
    expect(prompt).toContain('Pause for the human only when Talking to the human says so')
    expect(prompt).toContain('Do not ask "Want me to…?" for reversible work')
    expect(prompt).toContain('Never ask them to run a shell command or paste a secret')
    expect(prompt).not.toContain('Talking to Mike')
    expect(prompt.indexOf('## Talking to the human')).toBeLessThan(prompt.indexOf('## Operating Principles'))
  })
})

describe('buildPrompt — QW2 (unconditional self-verify)', () => {
  it('includes the self-verify instruction even when create_pr is false and no project is linked', () => {
    const prompt = buildPrompt(makeObjective({ create_pr: false, project: null }))
    expect(prompt).toContain('Before declaring done, run the relevant tests/build/typecheck')
    expect(prompt).toContain('paste the ACTUAL command output into NOTES.md')
    // The conditional Git Workflow block must NOT be the source of this line.
    expect(prompt).not.toContain('## Git Workflow')
  })

  it('still includes the self-verify instruction in a PR worker too', () => {
    const prompt = buildPrompt(makeObjective({ create_pr: true, project: 'command-center' }))
    expect(prompt).toContain('Before declaring done, run the relevant tests/build/typecheck')
  })
})

describe('resolveGithubRepo + gh pr create --repo', () => {
  beforeAll(() => {
    getDb().prepare(
      `INSERT INTO workspace_repos (workspace, name, github, repo_path)
       VALUES ('example', 'factory-align-test', 'your-org/command-center-infra', '/tmp/factory-align-test')`,
    ).run()
  })

  it('resolves owner/repo from workspace_repos by project name', () => {
    expect(resolveGithubRepo({ project: 'factory-align-test' })).toBe('your-org/command-center-infra')
    expect(resolveGithubRepo({ project: 'your-org/command-center-infra' })).toBe('your-org/command-center-infra')
    expect(resolveGithubRepo({ project: 'command-center-infra' })).toBe('your-org/command-center-infra')
    expect(resolveGithubRepo({ project: null })).toBeNull()
  })

  it('tells a PR worker to open against the linked GitHub repo and wait on gate', () => {
    const prompt = buildPrompt(makeObjective({ create_pr: true, project: 'factory-align-test' }))
    expect(prompt).toContain('gh pr create --repo your-org/command-center-infra --base main')
    expect(prompt).toContain('gated by GitHub Actions job `gate`')
    expect(prompt).not.toContain('harness/test-agent')
  })
})

// Distillation 2026-08-12 P1 — a worker must BLOCK on its own background jobs and
// capture the post-exit measured artifact before routing to review. Five intern-churn
// objectives (705594/705601/705602/705605/705608) routed while their sharded
// `--apply` release jobs were still alive, so the required live re-count could not
// exist yet; the review loop thrashed to its iteration cap at ≈$137 of review spend.
describe('buildPrompt — distill 2026-08-12 P1 (block on your own background jobs)', () => {
  it('injects the background-job blocking principle unconditionally', () => {
    const prompt = buildPrompt(makeObjective({ create_pr: false, project: null }))
    expect(prompt).toContain('you MUST block until they EXIT before you route to review')
    expect(prompt).toContain('Measure after exit; report after measuring.')
    // It rides in Operating Principles, not the conditional Git Workflow block.
    expect(prompt).not.toContain('## Git Workflow')
  })

  it('injects it for a PR worker too', () => {
    const prompt = buildPrompt(makeObjective({ create_pr: true, project: 'command-center' }))
    expect(prompt).toContain('you MUST block until they EXIT before you route to review')
  })
})

// Distillation 2026-08-03 P1 — worker completion must be EVIDENCE-GATED.
// Three parent incidents (703812/703806, 703815/703808, 703882/703876) had a
// worker end with an uncommitted worktree while its summary claimed a PR was
// opened. Both integration modes must hand the worker a verification gate.
describe('Git Workflow — evidence gate on completion (both integration modes)', () => {
  it('emits the PROVE-the-PR-exists gate in `pr` mode', () => {
    const prompt = buildPrompt(
      makeObjective({ id: 704167001, create_pr: true, project: 'command-center-infra' }),
    )
    expect(prompt).toContain('**Before you report done — PROVE the PR actually exists')
    expect(prompt).toContain('git status --porcelain')
    expect(prompt).toContain('git rev-list --count origin/main..HEAD')
    expect(prompt).toContain('gh pr view --json url -q .url')
    // The false-completion prohibition, and the BLOCKED-not-success escape hatch.
    expect(prompt).toContain('NEVER write "PR opened"')
    expect(prompt).toContain('do NOT report success')
    // The gate must precede the callback, so a worker reads it before signing off.
    expect(prompt.indexOf('PROVE the PR actually exists')).toBeLessThan(
      prompt.indexOf('**Then report the PR URL back:**'),
    )
  })

  it('emits the PROVE-the-branch-carries-your-work gate in `merge-back` mode', () => {
    // merge-back requires a PR-building parent row in the DB to derive its branch.
    const parentId = 704167900
    getDb()
      .prepare(
        `INSERT OR REPLACE INTO objectives (id, title, status, agent_context, workspace, project, create_pr)
         VALUES (?, 'Parent delegator', 'working', 'cto', 'example', 'command-center-infra', 1)`,
      )
      .run(parentId)

    const prompt = buildPrompt(
      makeObjective({
        id: 704167901,
        create_pr: false,
        parent_id: parentId,
        project: 'command-center-infra',
      }),
    )
    expect(prompt).toContain("### Integration — fold into your parent's PR")
    expect(prompt).toContain('**Before you report done — PROVE the branch actually carries your work')
    expect(prompt).toContain('git status --porcelain')
    // Base is the PARENT's branch here, never origin/main.
    expect(prompt).toContain(`git rev-list --count cc/obj-${parentId}-`)
    expect(prompt).not.toContain('git rev-list --count origin/main..HEAD')
    expect(prompt).toContain('do NOT report success')
  })
})

// obj 1451 — resolveWorkdir must search EVERY workspace for a project-linked
// objective and FAIL CLOSED (never the bare projects root) when it can't resolve.
describe('resolveWorkdir — obj 1451 (cross-workspace resolution + fail-closed)', () => {
  // Mirrors the production registry shape that caused the bug:
  // command-center-infra is registered ONLY under 'personal'; the 'example'
  // workspace has projects but NOT command-center-infra.
  const CC_PATH = `${HOME_DIR}/projects/command-center-infra`
  const fixtureWorkspaces = {
    example: { projects: [{ name: 'example-platform', path: '~/projects/example-platform' }] },
    'personal': {
      projects: [{ name: 'command-center-infra', path: '~/projects/command-center-infra' }],
    },
  }

  it('resolves an EXAMPLE-tagged command-center-infra objective to the real repo path (the exact regression)', () => {
    const obj = makeObjective({
      id: 1451,
      workspace: 'example', // tagged example, but project lives under personal
      project: 'command-center-infra',
    })
    const resolved = resolveWorkdir(obj, {
      workspaces: fixtureWorkspaces,
      existsSync: (p) => p === CC_PATH,
    })
    expect(resolved).toBe(CC_PATH)
  })

  it('never returns the bare projects root for a project-linked objective', () => {
    const obj = makeObjective({ id: 1451, workspace: 'example', project: 'command-center-infra' })
    const resolved = resolveWorkdir(obj, {
      workspaces: fixtureWorkspaces,
      existsSync: (p) => p === CC_PATH,
    })
    expect(resolved).not.toBe(PROJECTS_DIR)
    expect(resolved).not.toBe(`${PROJECTS_DIR}/`)
  })

  it('still resolves when the project lives in the objective’s own workspace', () => {
    const obj = makeObjective({ id: 7, workspace: 'personal', project: 'command-center-infra' })
    const resolved = resolveWorkdir(obj, {
      workspaces: fixtureWorkspaces,
      existsSync: (p) => p === CC_PATH,
    })
    expect(resolved).toBe(CC_PATH)
  })

  it('FAILS CLOSED (throws, never bare root) when the project is registered in NO workspace', () => {
    const obj = makeObjective({ id: 8, workspace: 'example', project: 'ghost-project' })
    expect(() =>
      resolveWorkdir(obj, { workspaces: fixtureWorkspaces, existsSync: () => true }),
    ).toThrow(/fail-closed|UNGUARDED|not.*map/i)
  })

  it('FAILS CLOSED when the registered path does not exist on disk', () => {
    const obj = makeObjective({ id: 9, workspace: 'example', project: 'command-center-infra' })
    expect(() =>
      resolveWorkdir(obj, { workspaces: fixtureWorkspaces, existsSync: () => false }),
    ).toThrow(/UNGUARDED|fail-closed/i)
  })

  it('non-project objective still falls back to the agent workdir (unchanged behaviour)', () => {
    const obj = makeObjective({ project: null, agent_context: 'cto' })
    // No project link → no fail-closed; cto maps to PROJECTS_DIR by design.
    const resolved = resolveWorkdir(obj, { workspaces: fixtureWorkspaces, existsSync: () => true })
    expect(resolved).toBe(PROJECTS_DIR)
  })

  // Integration-flavoured guard: if the real registry + checkout are present
  // (they are in the deploy container/harness), an example-tagged command-center-infra
  // objective must resolve to the actual on-disk repo — not throw, not bare root.
  it('resolves against the REAL workspaces.json when command-center-infra is registered + checked out', () => {
    const realWorkspaces = loadWorkspacesConfig()
    const ccPath = `${HOME_DIR}/projects/command-center-infra`
    const registeredSomewhere =
      !!realWorkspaces &&
      Object.values(realWorkspaces).some((ws) =>
        ws.projects?.some((p) => p.name === 'command-center-infra'),
      )
    if (!fs.existsSync(WORKSPACES_JSON) || !registeredSomewhere || !fs.existsSync(ccPath)) {
      // Registry/checkout not present in this environment — the hermetic tests
      // above already cover the logic; skip the on-disk assertion.
      return
    }
    const obj = makeObjective({ id: 1451, workspace: 'example', project: 'command-center-infra' })
    const resolved = resolveWorkdir(obj)
    expect(resolved).toBe(ccPath)
    expect(resolved).not.toBe(PROJECTS_DIR)
  })
})
