import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { WORKTREE_GUARD_SCRIPT } from './session-manager.js'

/**
 * obj 1059 — exercises the ACTUAL PreToolUse guard artifact (the bash script the
 * server installs and `claude --settings` runs). The guard is the hard pre-write
 * block that stops any isolated session editing the live checkout, so it gets a
 * direct subprocess test against representative tool-call payloads.
 */
describe('worktree-guard.sh (PreToolUse block)', () => {
  let guardPath: string
  const WT = '/tmp/cc-worktree-9999'
  const PROT = '/home/operator/projects'

  beforeAll(() => {
    guardPath = path.join(os.tmpdir(), `worktree-guard-test-${process.pid}.sh`)
    fs.writeFileSync(guardPath, WORKTREE_GUARD_SCRIPT)
    fs.chmodSync(guardPath, 0o755)
  })
  afterAll(() => {
    try { fs.unlinkSync(guardPath) } catch {}
  })

  /** Run the guard with a tool-call payload; return its exit code (0 allow, 2 block). */
  function runGuard(toolInput: Record<string, unknown>, opts: { cwd?: string; worktreeRoot?: string | null } = {}): number {
    const payload = JSON.stringify({ tool_name: 'Write', tool_input: toolInput, cwd: opts.cwd || WT })
    const env: Record<string, string> = {
      PATH: process.env.PATH || '/usr/bin:/bin',
      CC_PROTECTED_ROOT: PROT,
    }
    const root = opts.worktreeRoot === undefined ? WT : opts.worktreeRoot
    if (root) env.CC_WORKTREE_ROOT = root
    try {
      execFileSync('bash', [guardPath], { input: payload, env, stdio: ['pipe', 'pipe', 'pipe'] })
      return 0
    } catch (err: any) {
      return typeof err.status === 'number' ? err.status : -1
    }
  }

  it('ALLOWS an edit inside the worktree', () => {
    expect(runGuard({ file_path: `${WT}/app/server/src/index.ts` })).toBe(0)
  })

  it('BLOCKS an edit to the live checkout (the obj-841 hazard)', () => {
    expect(runGuard({ file_path: `${PROT}/command-center-infra/app/server/src/index.ts` })).toBe(2)
  })

  it('BLOCKS an edit to a DIFFERENT live project checkout (cross-project)', () => {
    expect(runGuard({ file_path: `${PROT}/example-project-platform/src/x.ts` })).toBe(2)
  })

  it('ALLOWS edits outside the protected root (vault / NOTES / home)', () => {
    expect(runGuard({ file_path: '/home/operator/second-brain/workspaces/x/decisions/d.md' })).toBe(0)
    expect(runGuard({ file_path: '/home/operator/ai-workspace/objective-memory/1/NOTES.md' })).toBe(0)
  })

  it('handles NotebookEdit (notebook_path) the same way', () => {
    expect(runGuard({ notebook_path: `${PROT}/command-center-infra/x.ipynb` })).toBe(2)
    expect(runGuard({ notebook_path: `${WT}/x.ipynb` })).toBe(0)
  })

  it('ALLOWS a relative path when cwd is the worktree', () => {
    expect(runGuard({ file_path: 'app/server/src/index.ts' }, { cwd: WT })).toBe(0)
  })

  it('BLOCKS a relative path that resolves into the live checkout', () => {
    expect(runGuard({ file_path: 'app/server/src/index.ts' }, { cwd: `${PROT}/command-center-infra` })).toBe(2)
  })

  it('BLOCKS a ".." escape out of the worktree into the live checkout', () => {
    expect(runGuard(
      { file_path: `${WT}/../../home/operator/projects/command-center-infra/app/x.ts` },
    )).toBe(2)
  })

  it('is a no-op (allows everything) when CC_WORKTREE_ROOT is unset (non-isolated session)', () => {
    expect(runGuard({ file_path: `${PROT}/command-center-infra/app/x.ts` }, { worktreeRoot: null })).toBe(0)
  })

  it('does not block when there is no file path in the payload', () => {
    expect(runGuard({})).toBe(0)
  })
})
