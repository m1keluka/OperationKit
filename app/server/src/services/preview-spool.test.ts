import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  enqueuePreviewDeploy,
  enqueuePreviewTeardown,
  previewSpoolDir,
  kickHostDrain,
  logPreviewSpoolHealth,
  type PreviewJob,
} from './preview-spool.js'

// obj 1452: the spool is how the in-container server hands privileged
// deploy/teardown work to the host runner. These guard the contract the runner
// parses: a deploy job needs a positive pr_number AND a branch; a teardown
// needs only a positive pr_number; both land as a single complete JSON file.

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-spool-test-'))
  process.env.PREVIEW_SPOOL_DIR = tmpDir
})

afterEach(() => {
  delete process.env.PREVIEW_SPOOL_DIR
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function readJob(name: string): PreviewJob {
  return JSON.parse(fs.readFileSync(path.join(tmpDir, name), 'utf8')) as PreviewJob
}

describe('enqueuePreviewDeploy', () => {
  it('writes a complete deploy job with pr_number and branch', () => {
    expect(enqueuePreviewDeploy(102, 'cc/obj-1452-fix', 1452)).toBe(true)
    const job = readJob('deploy-pr102.json')
    expect(job.action).toBe('deploy')
    expect(job.pr_number).toBe(102)
    expect(job.branch_name).toBe('cc/obj-1452-fix')
    expect(job.objective_id).toBe(1452)
    expect(typeof job.requested_at).toBe('string')
  })

  it('uses a stable filename so a re-request overwrites rather than piles up', () => {
    enqueuePreviewDeploy(102, 'branch-a')
    enqueuePreviewDeploy(102, 'branch-b')
    const files = fs.readdirSync(tmpDir).filter((f) => f.endsWith('.json'))
    expect(files).toEqual(['deploy-pr102.json'])
    expect(readJob('deploy-pr102.json').branch_name).toBe('branch-b')
  })

  it('refuses (no-op, false) without a branch — the runner needs it to check out', () => {
    expect(enqueuePreviewDeploy(102, null)).toBe(false)
    expect(enqueuePreviewDeploy(102, '')).toBe(false)
    expect(fs.readdirSync(tmpDir).filter((f) => f.endsWith('.json'))).toHaveLength(0)
  })

  it('refuses (no-op, false) without a positive pr_number', () => {
    expect(enqueuePreviewDeploy(null, 'b')).toBe(false)
    expect(enqueuePreviewDeploy(0, 'b')).toBe(false)
    expect(enqueuePreviewDeploy(-3, 'b')).toBe(false)
    expect(fs.readdirSync(tmpDir).filter((f) => f.endsWith('.json'))).toHaveLength(0)
  })

  it('writes no partial files — only the final renamed job remains', () => {
    enqueuePreviewDeploy(7, 'b')
    const leftovers = fs.readdirSync(tmpDir).filter((f) => f.endsWith('.tmp'))
    expect(leftovers).toHaveLength(0)
  })
})

describe('enqueuePreviewTeardown', () => {
  it('writes a teardown job with just the pr_number', () => {
    expect(enqueuePreviewTeardown(102, 1452)).toBe(true)
    const job = readJob('teardown-pr102.json')
    expect(job.action).toBe('teardown')
    expect(job.pr_number).toBe(102)
    expect(job.objective_id).toBe(1452)
  })

  it('refuses (no-op, false) without a positive pr_number', () => {
    expect(enqueuePreviewTeardown(null)).toBe(false)
    expect(enqueuePreviewTeardown(0)).toBe(false)
    expect(fs.readdirSync(tmpDir).filter((f) => f.endsWith('.json'))).toHaveLength(0)
  })

  it('deploy and teardown for the same PR are distinct files', () => {
    enqueuePreviewDeploy(5, 'b')
    enqueuePreviewTeardown(5)
    const files = fs.readdirSync(tmpDir).filter((f) => f.endsWith('.json')).sort()
    expect(files).toEqual(['deploy-pr5.json', 'teardown-pr5.json'])
  })
})

describe('previewSpoolDir', () => {
  it('honors PREVIEW_SPOOL_DIR override', () => {
    expect(previewSpoolDir()).toBe(tmpDir)
  })
})

describe('kickHostDrain', () => {
  afterEach(() => {
    delete process.env.PREVIEW_SPOOL_HOST_KICK
  })

  it('is a no-op (returns false, spawns nothing) when disabled', () => {
    process.env.PREVIEW_SPOOL_HOST_KICK = '0'
    expect(kickHostDrain()).toBe(false)
  })
})

describe('logPreviewSpoolHealth', () => {
  it('does not throw and leaves no probe file behind on a writable spool', () => {
    expect(() => logPreviewSpoolHealth()).not.toThrow()
    const probes = fs.readdirSync(tmpDir).filter((f) => f.startsWith('.health-'))
    expect(probes).toHaveLength(0)
  })

  it('does not throw when the spool dir is unwritable', () => {
    // Point the spool at a dir path nested UNDER a regular file: the recursive
    // mkdir fails fast with ENOTDIR. (A /proc/... path makes mkdirSync block the
    // event loop indefinitely on the CI kernel — a hard hang, not a throw.)
    const blocker = path.join(tmpDir, 'not-a-dir')
    fs.writeFileSync(blocker, '')
    process.env.PREVIEW_SPOOL_DIR = path.join(blocker, 'spool')
    expect(() => logPreviewSpoolHealth()).not.toThrow()
  })
})
