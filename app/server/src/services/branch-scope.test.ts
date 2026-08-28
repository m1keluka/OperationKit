import { describe, it, expect } from 'vitest'
import { deriveBranchName, deriveWorktreeBranchName, slugifyTitle, detectBranchBleed, detectProjectBleed } from './branch-scope.js'
import type { Objective } from '@command-center/shared'

function obj(p: Partial<Objective>): Pick<Objective, 'id' | 'title' | 'project' | 'create_pr' | 'branch_name'> {
  return { id: 994, title: 'Guardrail thing', project: 'command-center-infra', create_pr: 1 as never, branch_name: null, ...p } as never
}

describe('deriveBranchName', () => {
  it('derives cc/obj-<id>-<slug> for a PR objective', () => {
    expect(deriveBranchName(obj({}))).toBe('cc/obj-994-guardrail-thing')
  })
  it('returns null for non-PR objectives (no lease taken — behavior preserved)', () => {
    expect(deriveBranchName(obj({ create_pr: 0 as never }))).toBeNull()
  })
  it('returns null when there is no project', () => {
    expect(deriveBranchName(obj({ project: null as never }))).toBeNull()
  })
  it('prefers a persisted branch_name (post pr-created)', () => {
    expect(deriveBranchName(obj({ branch_name: 'cc/obj-994-existing' }))).toBe('cc/obj-994-existing')
  })
  it('slug matches the prompt block derivation', () => {
    expect(slugifyTitle('Fix the Thing!! (now)')).toBe('fix-the-thing-now')
  })
})

describe('deriveWorktreeBranchName (obj 1059 — isolation, create_pr-independent)', () => {
  it('derives a branch for a PR objective', () => {
    expect(deriveWorktreeBranchName(obj({}))).toBe('cc/obj-994-guardrail-thing')
  })
  it('ALSO derives a branch for a NON-PR task worker (the key difference from deriveBranchName)', () => {
    expect(deriveWorktreeBranchName(obj({ create_pr: 0 as never }))).toBe('cc/obj-994-guardrail-thing')
  })
  it('returns null only when there is no project to scope to', () => {
    expect(deriveWorktreeBranchName(obj({ project: null as never }))).toBeNull()
    expect(deriveWorktreeBranchName(obj({ project: null as never, create_pr: 0 as never }))).toBeNull()
  })
  it('prefers a persisted branch_name', () => {
    expect(deriveWorktreeBranchName(obj({ create_pr: 0 as never, branch_name: 'cc/obj-994-existing' }))).toBe('cc/obj-994-existing')
  })
})

describe('detectBranchBleed', () => {
  const owned = 'cc/obj-994-guardrail-thing'
  it('passes ordinary commits/pushes on the owned branch', () => {
    expect(detectBranchBleed('git add -A && git commit -m wip && git push', owned)).toBeNull()
    expect(detectBranchBleed(`git push -u origin ${owned}`, owned)).toBeNull()
  })
  it('flags creating a foreign branch', () => {
    expect(detectBranchBleed('git checkout -b obj-loops-kanban', owned)).toBe('obj-loops-kanban')
    expect(detectBranchBleed('git switch -c feature/x', owned)).toBe('feature/x')
  })
  it('flags pushing a foreign branch', () => {
    expect(detectBranchBleed('git push origin obj-loops-kanban', owned)).toBe('obj-loops-kanban')
  })
  it('flags gh pr create off a foreign head', () => {
    expect(detectBranchBleed('gh pr create --head obj-loops-kanban --title x', owned)).toBe('obj-loops-kanban')
  })
  it('does not flag re-creating the owned branch', () => {
    expect(detectBranchBleed(`git checkout -b ${owned}`, owned)).toBeNull()
  })
  it('ignores HEAD', () => {
    expect(detectBranchBleed('git push origin HEAD', owned)).toBeNull()
  })
  it('does NOT flag a refspec-less owned-branch push carrying a 2>&1 redirect', () => {
    // regression: the `2` from `2>&1` was captured as a foreign branch (obj 704417/704512/704556)
    expect(detectBranchBleed('git push -q 2>&1 | tail -2; echo pushed', 'cto/704417-tracking-surface')).toBeNull()
    expect(detectBranchBleed('git push --force-with-lease 2>&1 | tail -3', owned)).toBeNull()
    expect(detectBranchBleed('git push origin 2>&1', owned)).toBeNull()
  })
  it('does NOT flag a second branch for the SAME objective id (hotfix/delta lane)', () => {
    const o = 'cto/704656-eb-dup-cleanup-indent'
    expect(detectBranchBleed('git checkout -B cto/704656-topup-guardrail-delta origin/main', o)).toBeNull()
    expect(detectBranchBleed('git push --force-with-lease origin cto/704656-topup-geo-wide-pull-coverage', o)).toBeNull()
    expect(detectBranchBleed('git checkout -b fix/704650-lead-geo-circular-import', 'cto/704650-w3-topup-max-miles-plumbing')).toBeNull()
    expect(detectBranchBleed('git checkout -q -b cc/obj-704562-hotfix-allocator', 'cc/obj-704562-w4-builder-landing-gate')).toBeNull()
  })
  it('STILL flags a DIFFERENT objective id (genuine cross-objective bleed)', () => {
    const o = 'cto/704656-eb-dup-cleanup-indent'
    expect(detectBranchBleed('gh pr create --head cto/704657-topup-geo-guardrails', o)).toBe('cto/704657-topup-geo-guardrails')
    expect(detectBranchBleed('git push -u origin cto/704650-w3-topup-max-miles-plumbing', o)).toBe('cto/704650-w3-topup-max-miles-plumbing')
  })
  it('does NOT flag integration-base refs (db-apply push / -B main reset)', () => {
    const o = 'cc/obj-704824-lead-notes-rls'
    expect(detectBranchBleed('git push origin origin/main:refs/heads/db-apply/20260807040000', o)).toBeNull()
    expect(detectBranchBleed('git checkout -q -B main origin/main', 'cc/obj-704825-r6-version-rename')).toBeNull()
  })
  it('STILL flags a genuinely foreign no-id branch', () => {
    expect(detectBranchBleed('git checkout -b obj-loops-kanban', 'cc/obj-994-guardrail-thing')).toBe('obj-loops-kanban')
  })
  it('does NOT flag a git FLAG token captured into the branch slot (obj 705532)', () => {
    // `git push origin --delete <branch>`: BRANCH_CHARS contains '-', so the name
    // slot swallowed `--delete` and the detector reported a branch called `--delete`.
    const o = 'cc/705532-w1-geofence-foundation'
    expect(detectBranchBleed('git push origin --delete cc/705532-WSLOT', o)).toBeNull()
    expect(detectBranchBleed('git push origin --delete cto/704650-w3-topup-max-miles-plumbing', o)).toBeNull()
    expect(detectBranchBleed('git push origin -d cc/705532-WSLOT', o)).toBeNull()
  })
})

describe('detectProjectBleed', () => {
  const root = '/home/operator/projects'
  const owned = '/home/operator/projects/command-center-infra'
  const wt = '/tmp/cc-worktree-994'
  it('flags editing a different project', () => {
    expect(detectProjectBleed('/home/operator/projects/example-project-platform/src/a.ts', owned, wt, root)).toBe(true)
  })
  it('does not flag edits inside the owned project', () => {
    expect(detectProjectBleed('/home/operator/projects/command-center-infra/app/x.ts', owned, wt, root)).toBe(false)
  })
  it('does not flag edits inside the worktree', () => {
    expect(detectProjectBleed('/tmp/cc-worktree-994/app/x.ts', owned, wt, root)).toBe(false)
  })
  it('does not flag paths outside the projects tree', () => {
    expect(detectProjectBleed('/home/operator/ai-workspace/notes.md', owned, wt, root)).toBe(false)
  })
})
