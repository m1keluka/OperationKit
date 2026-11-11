import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

// Point initDb at a throwaway DB before importing it (same pattern as the other
// service tests). We test the GATING logic only — never triggerAutoDeploy(), which
// would spawn a real self-deploy.
const TMP_DB = path.join(os.tmpdir(), `cc-autodeploy-test-${process.pid}.db`)
process.env.DB_PATH = TMP_DB

const { initDb, getDb } = await import('../db/index.js')
const { shouldAutoDeploy, isAutoDeployEnabled, SELF_REPO } = await import('./auto-deploy.js')

beforeAll(() => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
})

afterAll(() => {
  try { getDb().close() } catch { /* noop */ }
  for (const s of ['', '-wal', '-shm']) {
    const f = `${TMP_DB}${s}`
    if (fs.existsSync(f)) fs.unlinkSync(f)
  }
})

beforeEach(() => {
  getDb().exec("UPDATE settings SET value = '0' WHERE key = 'auto_deploy_enabled'")
})

describe('shouldAutoDeploy', () => {
  it('is true ONLY for the self repo merged to main', () => {
    expect(shouldAutoDeploy({ repo: SELF_REPO, baseRef: 'main' })).toBe(true)
    expect(shouldAutoDeploy({ repo: SELF_REPO, baseRef: 'dev' })).toBe(false)
    expect(shouldAutoDeploy({ repo: 'your-org/example-platform', baseRef: 'main' })).toBe(false)
    expect(shouldAutoDeploy({ repo: null, baseRef: 'main' })).toBe(false)
    expect(shouldAutoDeploy({ repo: SELF_REPO, baseRef: null })).toBe(false)
  })
})

describe('isAutoDeployEnabled', () => {
  it('defaults OFF (seeded auto_deploy_enabled = 0)', () => {
    expect(isAutoDeployEnabled(getDb(), {})).toBe(false)
  })
  it('is ON when settings.auto_deploy_enabled = 1', () => {
    getDb().exec("UPDATE settings SET value = '1' WHERE key = 'auto_deploy_enabled'")
    expect(isAutoDeployEnabled(getDb(), {})).toBe(true)
  })
  it('env CC_AUTO_DEPLOY forces ON even when the settings flag is off', () => {
    expect(isAutoDeployEnabled(getDb(), { CC_AUTO_DEPLOY: 'true' })).toBe(true)
    expect(isAutoDeployEnabled(getDb(), { CC_AUTO_DEPLOY: '1' })).toBe(true)
  })
  it('stays off for a non-truthy env value + off setting', () => {
    expect(isAutoDeployEnabled(getDb(), { CC_AUTO_DEPLOY: 'no' })).toBe(false)
  })
})
