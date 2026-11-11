import { describe, it, expect } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync } from 'child_process'
import {
  objectiveIdFromWorktreePath,
  parseWorktreePorcelain,
  selectReapable,
  safetyVerdict,
  isPathInside,
  isReaperEnabled,
  isReaperDryRun,
  sweepFinishedWorktrees,
  reapObjectiveWorktrees,
  type WorktreeEntry,
} from './worktree-reaper.js'

const P = '/home/operator/projects'

describe('objectiveIdFromWorktreePath', () => {
  it('recognizes /tmp/cc-worktree-<id>', () => {
    expect(objectiveIdFromWorktreePath('/tmp/cc-worktree-718070', P)).toBe(718070)
    expect(objectiveIdFromWorktreePath('/tmp/cc-worktree-42/', P)).toBe(42)
  })

  it('recognizes <projects>/.cc-worktree-<id>', () => {
    expect(objectiveIdFromWorktreePath(`${P}/.cc-worktree-1059`, P)).toBe(1059)
  })

  it('recognizes <projects>/<name>-wt-<id> with or without a suffix', () => {
    expect(objectiveIdFromWorktreePath(`${P}/example-platform-wt-704785`, P)).toBe(704785)
    expect(objectiveIdFromWorktreePath(`${P}/example-platform-wt-704785-fix-login`, P)).toBe(704785)
    expect(objectiveIdFromWorktreePath(`${P}/cc-wt-9-a`, P)).toBe(9)
  })

  it('returns null for main checkouts and unknown names', () => {
    expect(objectiveIdFromWorktreePath(`${P}/example-platform`, P)).toBeNull()
    expect(objectiveIdFromWorktreePath(`${P}/operationkit`, P)).toBeNull()
    expect(objectiveIdFromWorktreePath(`${P}/example-platform-wt-abc`, P)).toBeNull()
    expect(objectiveIdFromWorktreePath(`${P}/-wt-12`, P)).toBeNull()
    expect(objectiveIdFromWorktreePath(`${P}/example-platform-wt-12x`, P)).toBeNull()
    expect(objectiveIdFromWorktreePath('/tmp/cc-worktree-', P)).toBeNull()
    expect(objectiveIdFromWorktreePath('/tmp/cc-worktree-0', P)).toBeNull()
    expect(objectiveIdFromWorktreePath('/tmp/cc-worktree-12/nested', P)).toBeNull()
    expect(objectiveIdFromWorktreePath('/tmp/other-12', P)).toBeNull()
    expect(objectiveIdFromWorktreePath(`/elsewhere/repo-wt-12`, P)).toBeNull()
    expect(objectiveIdFromWorktreePath(`${P}/sub/repo-wt-12`, P)).toBeNull()
    expect(objectiveIdFromWorktreePath('', P)).toBeNull()
  })
})

const PORCELAIN = [
  `worktree ${P}/example-platform`,
  'HEAD 1111111111111111111111111111111111111111',
  'branch refs/heads/main',
  '',
  'worktree /tmp/cc-worktree-101',
  'HEAD 2222222222222222222222222222222222222222',
  'branch refs/heads/obj-101-fix',
  '',
  `worktree ${P}/example-platform-wt-102-hotfix`,
  'HEAD 3333333333333333333333333333333333333333',
  'detached',
  '',
  'worktree /tmp/cc-worktree-103',
  'HEAD 4444444444444444444444444444444444444444',
  'branch refs/heads/obj-103',
  'locked reason here',
  '',
  'worktree /tmp/cc-worktree-104',
  'HEAD 5555555555555555555555555555555555555555',
  'branch refs/heads/obj-104',
  'prunable gitdir file points to non-existent location',
  '',
].join('\n')

describe('parseWorktreePorcelain', () => {
  it('parses main + linked worktrees with flags', () => {
    const wts = parseWorktreePorcelain(PORCELAIN)
    expect(wts).toHaveLength(5)
    expect(wts[0]).toMatchObject({ path: `${P}/example-platform`, branch: 'main', isMain: true })
    expect(wts[1]).toMatchObject({ path: '/tmp/cc-worktree-101', branch: 'obj-101-fix', isMain: false, detached: false })
    expect(wts[2]).toMatchObject({ detached: true, branch: null })
    expect(wts[3].locked).toBe(true)
    expect(wts[4].prunable).toBe(true)
  })

  it('handles empty output and a missing trailing blank line', () => {
    expect(parseWorktreePorcelain('')).toEqual([])
    const wts = parseWorktreePorcelain(`worktree /a\nHEAD x\nbranch refs/heads/m\n\nworktree /tmp/cc-worktree-5\nHEAD y\ndetached`)
    expect(wts.map(w => w.path)).toEqual(['/a', '/tmp/cc-worktree-5'])
    expect(wts[1].detached).toBe(true)
  })

  it('parses a bare main repo', () => {
    const wts = parseWorktreePorcelain('worktree /srv/repo.git\nbare\n')
    expect(wts[0]).toMatchObject({ bare: true, isMain: true })
  })
})

function wt(p: string, over: Partial<WorktreeEntry> = {}): WorktreeEntry {
  return { path: p, head: 'abc', branch: 'b', bare: false, detached: false, locked: false, prunable: false, isMain: false, ...over }
}

describe('selectReapable', () => {
  const lookupOf = (m: Record<number, string>) => (id: number) => m[id]

  it('reaps exactly done and cancelled', () => {
    const { reap } = selectReapable(
      [wt('/tmp/cc-worktree-1'), wt('/tmp/cc-worktree-2')],
      lookupOf({ 1: 'done', 2: 'cancelled' }),
      P,
    )
    expect(reap.map(r => [r.objectiveId, r.status])).toEqual([[1, 'done'], [2, 'cancelled']])
  })

  for (const status of ['planning', 'queue', 'working', 'ai_review', 'review']) {
    it(`never reaps a ${status} card`, () => {
      const { reap, skip } = selectReapable([wt('/tmp/cc-worktree-7')], lookupOf({ 7: status }), P)
      expect(reap).toEqual([])
      expect(skip[0].reason).toBe(`status=${status}`)
    })
  }

  it('never reaps an unknown status (incl. near-misses of done)', () => {
    for (const status of ['DONE', 'done ', 'canceled', 'archived', 'human_review', '']) {
      const { reap } = selectReapable([wt('/tmp/cc-worktree-7')], () => status, P)
      expect(reap).toEqual([])
    }
  })

  it('never reaps when the card is missing', () => {
    const { reap, skip } = selectReapable([wt('/tmp/cc-worktree-8')], () => undefined, P)
    expect(reap).toEqual([])
    expect(skip[0].reason).toBe('card missing')
    expect(selectReapable([wt('/tmp/cc-worktree-8')], () => null, P).reap).toEqual([])
  })

  it('never reaps when the status lookup throws', () => {
    const { reap } = selectReapable([wt('/tmp/cc-worktree-8')], () => { throw new Error('db gone') }, P)
    expect(reap).toEqual([])
  })

  it('never reaps the main worktree, even if its path parses and the card is done', () => {
    const { reap, skip } = selectReapable([wt('/tmp/cc-worktree-9', { isMain: true })], () => 'done', P)
    expect(reap).toEqual([])
    expect(skip[0].reason).toBe('main worktree')
    expect(selectReapable([wt(`${P}/x-wt-9`, { bare: true })], () => 'done', P).reap).toEqual([])
  })

  it('never reaps an unparseable path', () => {
    const { reap, skip } = selectReapable([wt(`${P}/example-platform`), wt('/tmp/scratch')], () => 'done', P)
    expect(reap).toEqual([])
    expect(skip.map(s => s.reason)).toEqual(['unrecognized path', 'unrecognized path'])
  })

  it('keeps locked and prunable worktrees', () => {
    const { reap, skip } = selectReapable(
      [wt('/tmp/cc-worktree-3', { locked: true }), wt('/tmp/cc-worktree-4', { prunable: true })],
      () => 'done',
      P,
    )
    expect(reap).toEqual([])
    expect(skip.map(s => s.reason)).toEqual(['locked', 'prunable (dir missing)'])
  })

  it('works on parsed porcelain end-to-end', () => {
    const { reap } = selectReapable(
      parseWorktreePorcelain(PORCELAIN),
      lookupOf({ 101: 'done', 102: 'working', 103: 'done', 104: 'cancelled' }),
      P,
    )
    expect(reap.map(r => r.objectiveId)).toEqual([101])
  })
})

describe('safetyVerdict', () => {
  it('ok only when clean and fully pushed', () => {
    expect(safetyVerdict({ dirtyTracked: '', unpushed: '' })).toEqual({ ok: true })
    expect(safetyVerdict({ dirtyTracked: '\n', unpushed: '  ' })).toEqual({ ok: true })
  })
  it('refuses dirty tracked files', () => {
    expect(safetyVerdict({ dirtyTracked: ' M src/a.ts', unpushed: '' })).toEqual({ ok: false, reason: 'dirty' })
  })
  it('refuses unpushed commits', () => {
    expect(safetyVerdict({ dirtyTracked: '', unpushed: 'abc123' })).toEqual({ ok: false, reason: 'unpushed' })
  })
  it('refuses both', () => {
    expect(safetyVerdict({ dirtyTracked: 'M a', unpushed: 'abc' })).toEqual({ ok: false, reason: 'dirty+unpushed' })
  })
  it('refuses when a probe failed', () => {
    expect(safetyVerdict({ dirtyTracked: null, unpushed: '' }).ok).toBe(false)
    expect(safetyVerdict({ dirtyTracked: '', unpushed: null }).ok).toBe(false)
  })
})

describe('isPathInside / env flags', () => {
  it('matches the root and descendants only', () => {
    expect(isPathInside('/tmp/cc-worktree-1', '/tmp/cc-worktree-1')).toBe(true)
    expect(isPathInside('/tmp/cc-worktree-1/app', '/tmp/cc-worktree-1/')).toBe(true)
    expect(isPathInside('/tmp/cc-worktree-10', '/tmp/cc-worktree-1')).toBe(false)
  })
  it('kill switch + dry run', () => {
    expect(isReaperEnabled({})).toBe(true)
    expect(isReaperEnabled({ CC_WORKTREE_REAPER: 'false' })).toBe(false)
    expect(isReaperDryRun({})).toBe(false)
    expect(isReaperDryRun({ CC_WORKTREE_REAPER_DRY_RUN: 'true' })).toBe(true)
  })
})

// ── Imperative layer against real throwaway git repos ───────────────────────

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf-8',
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
  })
}

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-reaper-'))
  const projects = path.join(root, 'projects')
  const remote = path.join(root, 'remote.git')
  const repo = path.join(projects, 'demo')
  fs.mkdirSync(projects)
  execFileSync('git', ['init', '-q', '--bare', remote])
  execFileSync('git', ['init', '-q', '-b', 'main', repo])
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-qm', 'init')
  git(repo, 'remote', 'add', 'origin', remote)
  git(repo, 'push', '-q', 'origin', 'main')
  const add = (name: string, branch: string) => {
    const p = path.join(projects, name)
    git(repo, 'worktree', 'add', '-q', '-b', branch, p, 'origin/main')
    return p
  }
  return { root, projects, repo, add }
}

describe('sweepFinishedWorktrees (real git)', () => {
  it('removes clean+pushed done/cancelled worktrees and keeps everything else', async () => {
    const { root, projects, repo, add } = setup()
    try {
      const done = add('demo-wt-1', 'b1')
      const cancelled = add('.cc-worktree-2', 'b2')
      const working = add('demo-wt-3-x', 'b3')
      const dirty = add('demo-wt-4', 'b4')
      fs.writeFileSync(path.join(dirty, 'a.txt'), 'changed\n')
      const unpushed = add('demo-wt-5', 'b5')
      fs.writeFileSync(path.join(unpushed, 'n.txt'), 'n\n')
      git(unpushed, 'add', '.')
      git(unpushed, 'commit', '-qm', 'local only')
      const untrackedOnly = add('demo-wt-6', 'b6')
      fs.writeFileSync(path.join(untrackedOnly, 'notes.md'), 'never committed\n')
      // Ignored output (node_modules) is what fills the disk; it must not block reaping.
      fs.appendFileSync(path.join(repo, '.git', 'info', 'exclude'), 'node_modules/\n')
      const ignoredOnly = add('demo-wt-10', 'b10')
      fs.mkdirSync(path.join(ignoredOnly, 'node_modules', 'pkg'), { recursive: true })
      fs.writeFileSync(path.join(ignoredOnly, 'node_modules', 'pkg', 'index.js'), 'x\n')
      const busy = add('demo-wt-7', 'b7')
      const missingCard = add('demo-wt-8', 'b8')
      const odd = add('scratch-copy', 'b9')

      const statuses: Record<number, string> = { 1: 'done', 2: 'cancelled', 3: 'working', 4: 'done', 5: 'done', 6: 'done', 7: 'done', 10: 'done' }
      const logs: string[] = []
      const report = await sweepFinishedWorktrees({
        projectsDir: projects,
        readStatus: id => statuses[id],
        processCwds: () => [path.join(busy, 'sub')],
        dryRun: false,
        log: m => logs.push(m),
      })

      expect(report.repos).toBe(1)
      expect(fs.existsSync(done)).toBe(false)
      expect(fs.existsSync(cancelled)).toBe(false)
      expect(fs.existsSync(ignoredOnly)).toBe(false) // ignored files (node_modules) are not "dirty"
      for (const kept of [working, dirty, unpushed, untrackedOnly, busy, missingCard, odd, repo]) {
        expect(fs.existsSync(kept)).toBe(true)
      }
      expect(logs.some(l => l.includes('kept: dirty/unpushed #4') && l.includes('(dirty)'))).toBe(true)
      expect(logs.some(l => l.includes('kept: dirty/unpushed #5') && l.includes('(unpushed)'))).toBe(true)
      expect(logs.some(l => l.includes('kept: dirty/unpushed #6') && l.includes('(dirty)'))).toBe(true)
      expect(logs.some(l => l.includes('kept: in use #7'))).toBe(true)
      const listed = git(repo, 'worktree', 'list', '--porcelain')
      expect(listed).not.toContain('demo-wt-1\n')
      expect(listed).toContain('demo-wt-3-x')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('dry run logs but removes nothing', async () => {
    const { root, projects, add } = setup()
    try {
      const done = add('demo-wt-11', 'b11')
      const logs: string[] = []
      const report = await sweepFinishedWorktrees({
        projectsDir: projects, readStatus: () => 'done', processCwds: () => [], dryRun: true, log: m => logs.push(m),
      })
      expect(fs.existsSync(done)).toBe(true)
      expect(report.results.map(r => r.outcome)).toEqual(['would-remove'])
      expect(logs.some(l => l.includes('DRY RUN would remove #11'))).toBe(true)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('re-reads status right before removal (reopen race keeps the worktree)', async () => {
    const { root, projects, add } = setup()
    try {
      const p = add('demo-wt-12', 'b12')
      let calls = 0
      // First read (selection) says done; the re-read says the card was reopened.
      const report = await sweepFinishedWorktrees({
        projectsDir: projects, readStatus: () => (++calls === 1 ? 'done' : 'working'), processCwds: () => [], dryRun: false, log: () => {},
      })
      expect(fs.existsSync(p)).toBe(true)
      expect(report.results[0]).toMatchObject({ outcome: 'kept', reason: 'status=working' })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('never throws when the projects dir is missing or git fails', async () => {
    await expect(sweepFinishedWorktrees({ projectsDir: '/nonexistent-wt-reaper', log: () => {} })).resolves.toMatchObject({ repos: 0 })
    const { root, projects, add } = setup()
    try {
      add('demo-wt-13', 'b13')
      const report = await sweepFinishedWorktrees({
        projectsDir: projects, readStatus: () => 'done', git: async () => { throw new Error('boom') }, log: () => {},
      })
      expect(report.results).toEqual([])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('reapObjectiveWorktrees (real git)', () => {
  it('removes the objective worktree and drops its fully-pushed local branch', async () => {
    const { root, projects, repo, add } = setup()
    try {
      const p = add('demo-wt-21-feature', 'obj-21')
      const other = add('demo-wt-210', 'obj-210')
      const res = await reapObjectiveWorktrees(
        21,
        { projectDir: repo, branch: 'obj-21' },
        { projectsDir: projects, readStatus: () => 'done', processCwds: () => [], dryRun: false, log: () => {} },
      )
      expect(res.map(r => r.outcome)).toEqual(['removed'])
      expect(fs.existsSync(p)).toBe(false)
      expect(fs.existsSync(other)).toBe(true)
      expect(git(repo, 'branch', '--list', 'obj-21').trim()).toBe('')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps a dirty worktree and its branch for a done card', async () => {
    const { root, projects, repo, add } = setup()
    try {
      const p = add('demo-wt-22', 'obj-22')
      fs.writeFileSync(path.join(p, 'a.txt'), 'wip\n')
      const res = await reapObjectiveWorktrees(
        22,
        { projectDir: repo, branch: 'obj-22' },
        { projectsDir: projects, readStatus: () => 'done', processCwds: () => [], dryRun: false, log: () => {} },
      )
      expect(res[0]).toMatchObject({ outcome: 'kept', reason: 'dirty' })
      expect(fs.existsSync(p)).toBe(true)
      expect(git(repo, 'branch', '--list', 'obj-22')).toContain('obj-22')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps the worktree when the card is not done/cancelled', async () => {
    const { root, projects, add } = setup()
    try {
      const p = add('demo-wt-23', 'obj-23')
      const res = await reapObjectiveWorktrees(23, {}, { projectsDir: projects, readStatus: () => 'review', processCwds: () => [], log: () => {} })
      expect(res).toEqual([])
      expect(fs.existsSync(p)).toBe(true)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
