/**
 * /api/files over SYSTEM roots (obj 715532): service configs, logs, crontabs
 * readable read-only with server-side redaction. Throwaway tree under tmpdir,
 * real router over HTTP, real cc_live_ keys.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import { createHash } from 'crypto'
import express from 'express'
import cookieParser from 'cookie-parser'
import bcrypt from 'bcrypt'

const TMP_DB = path.join(os.tmpdir(), `cc-files-sys-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB
process.env.JWT_SECRET = 'test-secret-files-sys-xxxx'
process.env.SECRETS_MASTER_KEY = Buffer.alloc(32, 3).toString('base64')
process.env.CC_REDACT_ENV_FILES = ''

const BASE = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-files-sys-')))
const VAULT = path.join(BASE, 'vault')
const CONF = path.join(BASE, 'etc-like')
const LOGS = path.join(BASE, 'logs')
const PROJECTS = path.join(BASE, 'projects')
const OUTSIDE = path.join(BASE, 'outside')
process.env.CC_FILE_ROOTS = JSON.stringify([{ id: 'vault', path: VAULT, kind: 'vault' }])
process.env.CC_FILE_SHARED_PATHS = ''
process.env.CC_SYSTEM_FILE_ROOTS = JSON.stringify([
  { id: 'conf', path: CONF, binary_allow: ['png'] },
  { id: 'logs', path: LOGS, workspaces: ['example2'] },
  { id: 'projects', path: PROJECTS, include: ['docker-compose*.yml', '.env*'], max_depth: 2 },
])
process.env.CC_FILES_RATE_PER_MIN = '1000'
process.env.CC_FILES_DOWNLOAD_RATE_PER_MIN = '1000'
process.env.CC_FILES_MAX_REDACT_BYTES = String(64 * 1024)

const { initDb, getDb } = await import('../db/index.js')
const { issueApiKey } = await import('../lib/api-keys.js')
const { setSecret } = await import('../services/secrets-store.js')
const { resetRateLimits } = await import('../services/file-access.js')
const { default: filesRouter } = await import('./files.js')

const SUPA = 'sbsr_live_value_0123456789abcdef'
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.c2lnbmF0dXJlLXRlc3Q'
const PEM = '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----\n'

const F = {
  compose: path.join(CONF, 'docker-compose.yml'),
  caddy: path.join(CONF, 'caddy', 'Caddyfile'),
  env: path.join(CONF, '.env'),
  privKey: path.join(CONF, 'server.key'),
  pemNamedConf: path.join(CONF, 'tls.conf'),
  ssh: path.join(CONF, '.ssh', 'config'),
  db: path.join(CONF, 'state.db'),
  binary: path.join(CONF, 'blob.bin'),
  png: path.join(CONF, 'logo.png'),
  escape: path.join(CONF, 'escape.conf'),
  log: path.join(LOGS, 'app.log'),
  bigLog: path.join(LOGS, 'big.log'),
  projCompose: path.join(PROJECTS, 'svc', 'docker-compose.yml'),
  projSrc: path.join(PROJECTS, 'svc', 'index.ts'),
  projEnv: path.join(PROJECTS, 'svc', '.env.local'),
  outside: path.join(OUTSIDE, 'shadow.txt'),
}

function write(p: string, data: string | Buffer): string {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, data)
  return p
}

let server: http.Server
let baseUrl: string
let adminKey: string
let memberKey: string
let exampleKey: string

async function get(p: string, token?: string) {
  return fetch(`${baseUrl}${p}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
}
const q = (p: string) => encodeURIComponent(p)

beforeAll(async () => {
  write(F.compose, [
    'services:',
    '  db:',
    '    environment:',
    `      SUPABASE_KEY: ${SUPA}`,
    '      POSTGRES_PASSWORD: hunter2hunter2',
    '      DATABASE_URL: postgres://app:pgpass12345@db:5432/app',
    '      GH: ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    '      PUBLIC: "nothing secret here"',
  ].join('\n'))
  write(F.caddy, 'ai.example.com {\n  reverse_proxy localhost:3002\n}\n')
  write(F.env, `# service env\nSUPABASE_SERVICE_ROLE=${SUPA}\nexport OPENAI_API_KEY="sk-proj-ABCDEFGHIJKLMNOPQRSTUVWX12"\nPORT=3002\n`)
  write(F.privKey, PEM)
  write(F.pemNamedConf, PEM)
  write(F.ssh, 'Host x\n')
  write(F.db, 'SQLite format 3\0')
  write(F.binary, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x01]))
  write(F.png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d]))
  write(F.outside, 'root:$6$hash')
  fs.symlinkSync(F.outside, F.escape)
  write(F.log, `2026-10-11 boot\n2026-10-11 auth header Authorization: Bearer ${JWT}\n2026-10-11 key ${SUPA} loaded\n2026-10-11 done\n`)
  write(F.bigLog, `${'x'.repeat(100)}\n`.repeat(1000) + `tail line with ${SUPA}\n`)
  write(F.projCompose, `services:\n  web:\n    environment:\n      TOKEN: ${SUPA}\n`)
  write(F.projSrc, `const k = '${SUPA}'\n`)
  write(F.projEnv, `API_TOKEN=${SUPA}\n`)
  write(path.join(VAULT, 'workspaces', 'example2', 'deck.pdf'), '%PDF')

  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
  setSecret({ scope: { scopeType: 'global' }, key: 'SUPABASE_SERVICE_ROLE', value: SUPA })
  const db = getDb()
  const hash = bcrypt.hashSync('pw', 4)
  const adminId = Number(db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run('mike', hash, 'admin').lastInsertRowid)
  const memberId = Number(db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run('bot', hash, 'member').lastInsertRowid)
  const exampleId = Number(db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run('examplebot', hash, 'member').lastInsertRowid)
  db.prepare(`INSERT INTO user_workspaces (user_id, workspace, role) VALUES (?, 'example2', 'member')`).run(memberId)
  db.prepare(`INSERT INTO user_workspaces (user_id, workspace, role) VALUES (?, 'example', 'member')`).run(exampleId)
  adminKey = issueApiKey(adminId).token
  memberKey = issueApiKey(memberId).token
  exampleKey = issueApiKey(exampleId).token

  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  app.use('/api/files', filesRouter)
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => resolve()) })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no address')
  baseUrl = `http://127.0.0.1:${addr.port}`
})

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
  try { getDb().close() } catch {}
  for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(`${TMP_DB}${s}`) } catch {} }
  fs.rmSync(BASE, { recursive: true, force: true })
})

beforeEach(() => resetRateLimits())

describe('auth', () => {
  it('401 without a key on system paths', async () => {
    expect((await get(`/api/files/download?path=${q(F.compose)}`)).status).toBe(401)
    expect((await get(`/api/files/stat?path=${q(F.compose)}`)).status).toBe(401)
    expect((await get('/api/files/search?system=1')).status).toBe(401)
  })
})

describe('download: redacted text', () => {
  it('redacts known values and every pattern family, with X-Redacted + count headers', async () => {
    const res = await get(`/api/files/download?path=${q(F.compose)}`, adminKey)
    expect(res.status).toBe(200)
    expect(res.headers.get('x-redacted')).toBe('true')
    expect(Number(res.headers.get('x-redaction-count'))).toBe(4)
    expect(res.headers.get('content-type')).toContain('charset=utf-8')
    const text = await res.text()
    expect(text).toContain('SUPABASE_KEY: [REDACTED:SUPABASE_SERVICE_ROLE]')
    expect(text).toContain('POSTGRES_PASSWORD: [REDACTED:ASSIGNMENT]')
    expect(text).toContain('postgres://app:[REDACTED:CONN_PASSWORD]@db:5432/app')
    expect(text).toContain('GH: [REDACTED:GITHUB_TOKEN]')
    expect(text).toContain('PUBLIC: "nothing secret here"')
    expect(text).not.toContain(SUPA)
    expect(text).not.toContain('hunter2hunter2')
    expect(text).not.toContain('pgpass12345')
  })

  it('logs: Bearer/JWT + known value redacted; tail_bytes reads only the end', async () => {
    const res = await get(`/api/files/download?path=${q(F.log)}`, adminKey)
    const text = await res.text()
    expect(text).not.toContain(JWT)
    expect(text).not.toContain(SUPA)
    expect(text).toContain('Bearer [REDACTED:')
    expect(text).toContain('key [REDACTED:SUPABASE_SERVICE_ROLE] loaded')

    const big = await get(`/api/files/download?path=${q(F.bigLog)}`, adminKey)
    expect(big.status).toBe(413)
    const tail = await get(`/api/files/download?path=${q(F.bigLog)}&tail_bytes=60`, adminKey)
    expect(tail.status).toBe(200)
    expect(tail.headers.get('x-tail-bytes')).toBe("60")
    const tailText = await tail.text()
    expect(tailText).toBe('tail line with [REDACTED:SUPABASE_SERVICE_ROLE]\n')
  })

  it('.env files are served names-only: KEY=[REDACTED]', async () => {
    const res = await get(`/api/files/download?path=${q(F.env)}`, adminKey)
    expect(res.status).toBe(200)
    expect(res.headers.get('x-redaction-mode')).toBe('env-names-only')
    const text = await res.text()
    expect(text).toBe('# service env\nSUPABASE_SERVICE_ROLE=[REDACTED]\nexport OPENAI_API_KEY=[REDACTED]\nPORT=[REDACTED]\n')
  })

  it('a plain config with nothing secret still says it was passed through redaction', async () => {
    const res = await get(`/api/files/download?path=${q(F.caddy)}`, adminKey)
    expect(res.headers.get('x-redacted')).toBe('true')
    expect(res.headers.get('x-redaction-count')).toBe('0')
    expect(await res.text()).toContain('reverse_proxy localhost:3002')
  })

  it('Range is not honoured on redacted bodies (offsets would not line up)', async () => {
    const res = await fetch(`${baseUrl}/api/files/download?path=${q(F.compose)}`, { headers: { Authorization: `Bearer ${adminKey}`, Range: 'bytes=0-10' } })
    expect(res.status).toBe(200)
    expect(res.headers.get('accept-ranges')).toBe('none')
  })
})

describe('never served, even with redaction', () => {
  it.each([
    ['private key file (.key, PEM)', () => F.privKey],
    ['PEM content under an innocent name', () => F.pemNamedConf],
    ['.ssh/ subtree', () => F.ssh],
    ['raw DB file', () => F.db],
  ])('%s → 403', async (_n, p) => {
    const res = await get(`/api/files/download?path=${q(p())}`, adminKey)
    expect(res.status).toBe(403)
    expect(await res.text()).not.toContain('MIIEow')
  })

  it('binary files are refused (415) unless on the root binary allowlist', async () => {
    expect((await get(`/api/files/download?path=${q(F.binary)}`, adminKey)).status).toBe(415)
    const png = await get(`/api/files/download?path=${q(F.png)}`, adminKey)
    expect(png.status).toBe(200)
    expect(png.headers.get('x-redacted')).toBeNull()
  })

  it('symlink escaping a system root is rejected (realpath)', async () => {
    expect((await get(`/api/files/download?path=${q(F.escape)}`, adminKey)).status).toBe(403)
    expect((await get(`/api/files/download?path=${q(path.join(CONF, '..', 'outside', 'shadow.txt'))}`, adminKey)).status).toBe(403)
  })

  it('include globs: only matching files under a filtered root are visible', async () => {
    expect((await get(`/api/files/download?path=${q(F.projCompose)}`, adminKey)).status).toBe(200)
    expect((await get(`/api/files/download?path=${q(F.projSrc)}`, adminKey)).status).toBe(403)
    const env = await (await get(`/api/files/download?path=${q(F.projEnv)}`, adminKey)).text()
    expect(env).toBe('API_TOKEN=[REDACTED]\n')
  })
})

describe('scope', () => {
  it('system roots are admin-only unless tagged for a workspace', async () => {
    expect((await get(`/api/files/download?path=${q(F.compose)}`, memberKey)).status).toBe(403)
    const log = await get(`/api/files/download?path=${q(F.log)}`, memberKey)
    expect(log.status).toBe(200)
    expect(await log.text()).not.toContain(SUPA)
    expect((await get(`/api/files/download?path=${q(F.log)}`, exampleKey)).status).toBe(403)
  })
})

describe('stat', () => {
  it('reports redaction, previews redacted text, and hashes the REDACTED bytes', async () => {
    const res = await get(`/api/files/stat?path=${q(F.compose)}&preview=1&sha256=1`, adminKey)
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body.redacted).toBe(true)
    expect(body.serve_mode).toBe('redact')
    expect(body.preview as string).toContain('[REDACTED:SUPABASE_SERVICE_ROLE]')
    expect(JSON.stringify(body)).not.toContain(SUPA)
    const download = await (await get(`/api/files/download?path=${q(F.compose)}`, adminKey)).text()
    expect(body.sha256).toBe(createHash('sha256').update(download).digest('hex'))
    expect(body.sha256_of).toBe('redacted_content')
    expect(body.redaction_count).toBe(4)
  })
})

describe('search', () => {
  type Body = { results: Array<{ path: string; redacted?: boolean; snippets?: Array<{ line: number; text: string }> }> }

  it('system roots are only walked on request (system=1 / root=)', async () => {
    const plain = await (await get('/api/files/search?q=docker', adminKey)).json() as Body
    expect(plain.results).toEqual([])
    const sys = await (await get('/api/files/search?q=docker&system=1', adminKey)).json() as Body
    expect(sys.results.map(r => r.path).sort()).toEqual([F.compose, F.projCompose].sort())
    expect(sys.results.every(r => r.redacted)).toBe(true)
    const byRoot = await (await get('/api/files/search?root=conf&q=docker', adminKey)).json() as Body
    expect(byRoot.results.map(r => r.path)).toEqual([F.compose])
  })

  it('never lists denied or unservable files', async () => {
    const body = await (await get('/api/files/search?system=1', adminKey)).json() as Body
    const listed = body.results.map(r => r.path)
    for (const p of [F.privKey, F.pemNamedConf, F.ssh, F.db, F.binary, F.projSrc, F.escape]) expect(listed).not.toContain(p)
    expect(listed).toContain(F.png)
    expect(listed).toContain(F.env)
  })

  it('content search returns redacted snippets', async () => {
    const body = await (await get('/api/files/search?content=SUPABASE_KEY', adminKey)).json() as Body
    expect(body.results).toHaveLength(1)
    expect(body.results[0].snippets![0]).toEqual({ line: 4, text: '      SUPABASE_KEY: [REDACTED:SUPABASE_SERVICE_ROLE]' })
  })

  it('content search matches the redacted text, so it is not a secret-value oracle', async () => {
    const body = await (await get(`/api/files/search?content=${q(SUPA.slice(0, 12))}`, adminKey)).json() as Body
    expect(body.results).toEqual([])
    const pw = await (await get('/api/files/search?content=hunter2', adminKey)).json() as Body
    expect(pw.results).toEqual([])
  })

  it('members only see system roots tagged for their workspace', async () => {
    const body = await (await get('/api/files/search?system=1', memberKey)).json() as Body
    const listed = body.results.map(r => r.path)
    expect(listed).toContain(F.log)
    expect(listed).not.toContain(F.compose)
  })
})
