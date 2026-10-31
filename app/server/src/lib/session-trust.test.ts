/**
 * obj 718944 — per-session token + flag-gated spawn env.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const TMP_DB = path.join(os.tmpdir(), `cc-session-trust-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB
process.env.JWT_SECRET = 'test-secret-session-trust-xx'

const { initDb, getDb } = await import('../db/index.js')
const trust = await import('./session-trust.js')
const { applySessionTrustEnv } = await import('../services/session-spawn-env.js')

function setFlag(key: string, on: boolean) {
  getDb().prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, on ? '1' : '0')
}

beforeAll(() => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
})

beforeEach(() => {
  setFlag(trust.VERIFIED_SENDER_FLAG, false)
  setFlag(trust.SESSION_SECRET_ACCESS_FLAG, false)
})

describe('session token', () => {
  it('round-trips claims', () => {
    const t = trust.mintSessionToken({ objectiveId: 42, workspace: 'example', actingUserId: 1 })
    expect(t.startsWith('ccs_')).toBe(true)
    expect(trust.verifySessionToken(t)).toEqual({ objectiveId: 42, workspace: 'example', actingUserId: 1 })
  })

  it('rejects a tampered payload (cannot re-point the token at another card/workspace)', () => {
    const t = trust.mintSessionToken({ objectiveId: 42, workspace: 'example', actingUserId: 1 })
    const [payload, mac] = t.slice(4).split('.')
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url').toString()), o: 43, w: 'example2' })).toString('base64url')
    expect(trust.verifySessionToken(`ccs_${forged}.${mac}`)).toBeNull()
  })

  it('rejects expired tokens and junk', () => {
    const t = trust.mintSessionToken({ objectiveId: 1, workspace: 'w', actingUserId: null }, 1000, 10)
    expect(trust.verifySessionToken(t, 2000)).toBeNull()
    expect(trust.verifySessionToken('ccs_nope')).toBeNull()
    expect(trust.verifySessionToken('cc_live_x')).toBeNull()
  })

  it('reads the token from X-CC-Session-Token or Bearer ccs_', () => {
    expect(trust.sessionTokenFromHeaders({ 'x-cc-session-token': 'ccs_a.b' })).toBe('ccs_a.b')
    expect(trust.sessionTokenFromHeaders({ authorization: 'Bearer ccs_a.b' })).toBe('ccs_a.b')
    expect(trust.sessionTokenFromHeaders({ authorization: 'Bearer cc_live_x' })).toBeNull()
  })
})

describe('applySessionTrustEnv', () => {
  const obj = { id: 9, workspace: 'example' }

  it('flags off: env is untouched (JWT_SECRET stays, no token)', () => {
    const env: Record<string, string> = { JWT_SECRET: 'x', A: '1' }
    applySessionTrustEnv(env, obj, 1)
    expect(env).toEqual({ JWT_SECRET: 'x', A: '1' })
  })

  it('stamps flag: drops the signing key so a session cannot mint an owner cookie', () => {
    setFlag(trust.VERIFIED_SENDER_FLAG, true)
    const env: Record<string, string> = { JWT_SECRET: 'x', CC_JWT_SECRET: 'y', A: '1' }
    applySessionTrustEnv(env, obj, 1)
    expect(env.JWT_SECRET).toBeUndefined()
    expect(env.CC_JWT_SECRET).toBeUndefined()
    expect(env.CC_STRIP_SIGNING_SECRETS).toBe('1')
    expect(env.CC_SESSION_TOKEN).toBeUndefined()
  })

  it('secret-access flag: mints a token scoped to this card + workspace', () => {
    setFlag(trust.SESSION_SECRET_ACCESS_FLAG, true)
    const env: Record<string, string> = { JWT_SECRET: 'x' }
    applySessionTrustEnv(env, obj, 3)
    expect(env.JWT_SECRET).toBeUndefined()
    expect(env.CC_OBJECTIVE_ID).toBe('9')
    expect(trust.verifySessionToken(env.CC_SESSION_TOKEN)).toEqual({ objectiveId: 9, workspace: 'example', actingUserId: 3 })
  })
})
