/**
 * obj 900038 — a card with no project must not bind the bare operator home.
 *
 * The live failure: `general` (no project) resolved its workdir to HOME_DIR,
 * which on the Example OVH install is /opt/operationkit/state/home, mode 0750
 * root:root. The jail runs as uid 1000 and cannot enter it, so the wrapper's
 * `cd /workspace` failed and the session died in ~5s having logged nothing.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

import {
  resolveJailWorkspace,
  jailScratchPath,
  ensureJailScratchDir,
  isBareRoot,
  traversableBy,
  applyJailOwnership,
  JAIL_OWNED_MODE,
  JAIL_DEGRADED_MODE,
  JAIL_UID,
  JAIL_GID,
  __resetJailOwnershipWarningForTests,
  type JailOwnershipOps,
} from './jail-workspace.js'

const SCRATCH = '/tmp/scratch-root'
const base = { objectiveId: 900038, scratchRoot: SCRATCH, isTraversable: () => true }

describe('resolveJailWorkspace — what gets bound at /workspace', () => {
  it('binds the session worktree when there is one (every project card)', () => {
    const c = resolveJailWorkspace({ ...base, worktreeRoot: '/tmp/cc-worktree-900038', workdir: '/home/operator' })
    expect(c).toEqual({ source: '/tmp/cc-worktree-900038', reason: 'worktree', scratch: false })
  })

  it('THE BUG: a no-project card whose workdir is the bare operator home gets scratch, not the home', () => {
    const prevHome = process.env.USER_HOME
    try {
      // config.HOME_DIR is read at import time, so assert against the default
      // /home/operator AND against the generic bare roots.
      const c = resolveJailWorkspace({ ...base, workdir: '/home/operator' })
      expect(c.scratch).toBe(true)
      expect(c.reason).toBe('scratch:bare-root')
      expect(c.source).toBe(path.join(SCRATCH, '900038'))
      expect(c.source).not.toBe('/home/operator')
    } finally {
      if (prevHome === undefined) delete process.env.USER_HOME
      else process.env.USER_HOME = prevHome
    }
  })

  it('refuses /, /home, /root, /tmp, /opt and /srv as bind sources', () => {
    for (const root of ['/', '/home', '/root', '/tmp', '/opt', '/srv', '/tmp/']) {
      expect(isBareRoot(root)).toBe(true)
      const c = resolveJailWorkspace({ ...base, workdir: root })
      expect(c.scratch).toBe(true)
      expect(c.reason).toBe('scratch:bare-root')
    }
  })

  it('falls back to scratch when the jail uid cannot enter the workdir (the 0750 root case)', () => {
    const c = resolveJailWorkspace({
      ...base,
      workdir: '/opt/operationkit/state/home/work',
      isTraversable: () => false,
    })
    expect(c.scratch).toBe(true)
    expect(c.reason).toBe('scratch:not-traversable')
    expect(c.source).toBe(path.join(SCRATCH, '900038'))
  })

  it('keeps an ordinary, enterable workdir — cto-style cards are not regressed', () => {
    const c = resolveJailWorkspace({ ...base, workdir: '/home/operator/projects' })
    expect(c).toEqual({ source: '/home/operator/projects', reason: 'workdir', scratch: false })
  })

  it('an empty workdir is scratch, never the filesystem root', () => {
    for (const workdir of ['', '   ', undefined]) {
      const c = resolveJailWorkspace({ ...base, workdir })
      expect(c.scratch).toBe(true)
      expect(c.source).toBe(path.join(SCRATCH, '900038'))
    }
  })

  it('scratch is PER CARD, so two cards never share a /workspace', () => {
    const a = resolveJailWorkspace({ ...base, objectiveId: 1, workdir: '/home/operator' })
    const b = resolveJailWorkspace({ ...base, objectiveId: 2, workdir: '/home/operator' })
    expect(a.source).not.toBe(b.source)
  })

  it('rejects an objective id that would escape the scratch root', () => {
    for (const bad of ['../../etc', '/abs', 'a/b', '', '.hidden']) {
      expect(() => jailScratchPath(bad, SCRATCH)).toThrow(/invalid objective id/)
    }
  })
})

describe('traversableBy — can the jail uid actually cd in?', () => {
  const stat = (mode: number, uid: number, gid: number) => () => ({ mode, uid, gid })

  it('0750 root:root is NOT traversable by uid 1000 (the exact OVH failure)', () => {
    expect(traversableBy('/opt/operationkit/state/home', 1000, 1000, stat(0o750, 0, 0))).toBe(false)
  })
  it('0755 is traversable by anyone', () => {
    expect(traversableBy('/x', 1000, 1000, stat(0o755, 0, 0))).toBe(true)
  })
  it('0700 owned by the jail uid is traversable', () => {
    expect(traversableBy('/x', 1000, 1000, stat(0o700, 1000, 1000))).toBe(true)
  })
  it('0750 owned by root but group-matched is traversable', () => {
    expect(traversableBy('/x', 1000, 1000, stat(0o750, 0, 1000))).toBe(true)
  })
  it('an unstatable path fails CLOSED (scratch), it does not optimistically bind', () => {
    expect(traversableBy('/nope', 1000, 1000, () => null)).toBe(false)
  })
})

describe('applyJailOwnership — jail paths are 0700/0600, never 0777', () => {
  beforeEach(() => __resetJailOwnershipWarningForTests())

  function ops(isRoot: boolean, chownThrows = false) {
    const chmods: Array<[string, number]> = []
    const chowns: Array<[string, number, number]> = []
    const o: JailOwnershipOps = {
      isRoot: () => isRoot,
      chownSync: (p, u, g) => { if (chownThrows) throw new Error('EPERM'); chowns.push([p, u, g]) },
      chmodSync: (p, m) => { chmods.push([p, m]) },
    }
    return { o, chmods, chowns }
  }

  it('as root: chowns to the jail uid and sets 0700 for a dir / 0600 for a file', () => {
    for (const kind of ['dir', 'jail-read', 'jail-write'] as const) {
      const { o, chmods, chowns } = ops(true)
      expect(applyJailOwnership('/p', kind, o)).toBe(true)
      expect(chowns).toEqual([['/p', JAIL_UID, JAIL_GID]])
      expect(chmods).toEqual([['/p', JAIL_OWNED_MODE[kind]]])
      // The thing we are actually fixing: no world bits on the owned path.
      expect(JAIL_OWNED_MODE[kind] & 0o077).toBe(0)
    }
  })

  it('never produces the old 0777 / 0666, even in the non-root fallback', () => {
    for (const kind of ['dir', 'jail-read', 'jail-write'] as const) {
      const { o, chmods } = ops(false)
      expect(applyJailOwnership('/p', kind, o)).toBe(false)
      expect(chmods[0][1]).toBe(JAIL_DEGRADED_MODE[kind])
      expect(chmods[0][1] & 0o777).not.toBe(0o777)
      expect(chmods[0][1] & 0o777).not.toBe(0o666)
    }
  })

  it('a degraded DIRECTORY is still not listable or readable by other', () => {
    expect(JAIL_DEGRADED_MODE.dir & 0o004).toBe(0) // no other-read -> no listing
    expect(JAIL_DEGRADED_MODE.dir & 0o040).toBe(0) // no group-read
    expect(JAIL_DEGRADED_MODE.dir & 0o1000).toBe(0o1000) // sticky
  })

  it('a failed chown still tightens the mode instead of leaving it open', () => {
    const { o, chmods } = ops(true, true)
    expect(applyJailOwnership('/p', 'dir', o)).toBe(false)
    expect(chmods).toEqual([['/p', JAIL_DEGRADED_MODE.dir]])
  })
})

describe('ensureJailScratchDir', () => {
  let tmp: string
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-scratch-')) })
  afterEach(() => { try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {} })

  it('creates the per-card dir and is idempotent', () => {
    const a = ensureJailScratchDir(900038, tmp)
    fs.writeFileSync(path.join(a, 'keep.txt'), 'x')
    const b = ensureJailScratchDir(900038, tmp)
    expect(b).toBe(a)
    expect(fs.readFileSync(path.join(a, 'keep.txt'), 'utf8')).toBe('x')
  })

  it('the created dir is NOT world-readable (0777 is what this replaced)', () => {
    const d = ensureJailScratchDir(777, tmp)
    const mode = fs.statSync(d).mode & 0o777
    expect(mode & 0o004).toBe(0)
    expect(mode).not.toBe(0o777)
  })
})
