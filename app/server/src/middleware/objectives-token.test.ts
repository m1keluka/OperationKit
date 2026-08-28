// getObjectivesApiToken resolution order (obj 702304): env var wins; when unset,
// a file-based secret is read (Docker-secret style) so the token can be
// provisioned without a full container restart.
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const { getObjectivesApiToken, hasValidObjectivesToken } = await import('./objectives-token.js')

const tmpFile = path.join(os.tmpdir(), `obj-token-file-${process.pid}-${Date.now()}.secret`)

afterEach(() => {
  delete process.env.OBJECTIVES_API_TOKEN
  delete process.env.OBJECTIVES_API_TOKEN_FILE
  try { fs.unlinkSync(tmpFile) } catch { /* ignore */ }
})

describe('getObjectivesApiToken', () => {
  it('returns null when neither env nor file is set', () => {
    process.env.OBJECTIVES_API_TOKEN_FILE = path.join(os.tmpdir(), 'definitely-missing-xyz.secret')
    expect(getObjectivesApiToken()).toBeNull()
  })

  it('prefers the env var', () => {
    process.env.OBJECTIVES_API_TOKEN = '  env-wins  '
    fs.writeFileSync(tmpFile, 'file-loses')
    process.env.OBJECTIVES_API_TOKEN_FILE = tmpFile
    expect(getObjectivesApiToken()).toBe('env-wins') // trimmed
  })

  it('falls back to the file secret when env is unset', () => {
    fs.writeFileSync(tmpFile, 'from-file-secret\n')
    process.env.OBJECTIVES_API_TOKEN_FILE = tmpFile
    expect(getObjectivesApiToken()).toBe('from-file-secret') // trimmed
  })

  it('validates a Bearer header against the file secret', () => {
    fs.writeFileSync(tmpFile, 'file-tok-123')
    process.env.OBJECTIVES_API_TOKEN_FILE = tmpFile
    const mk = (auth?: string) => ({ header: (n: string) => (n.toLowerCase() === 'authorization' ? auth : undefined) }) as never
    expect(hasValidObjectivesToken(mk('Bearer file-tok-123'))).toBe(true)
    expect(hasValidObjectivesToken(mk('Bearer wrong'))).toBe(false)
    expect(hasValidObjectivesToken(mk(undefined))).toBe(false)
  })
})
