import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'
import cookieParser from 'cookie-parser'
import jwt from 'jsonwebtoken'

// obj 712954 — PUT /api/objectives/:id used to drop pr_url / pr_number /
// branch_name silently (200, nothing written; seen on obj 712923 2026-09-28).
// They are now an admin-only, validated override that writes an audit row.
// Exercised over HTTP against the real objectives router.
const TMP_DB = path.join(os.tmpdir(), `cc-prlinkput-test-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB
process.env.JWT_SECRET = 'test-secret-prlinkput'

const { initDb, getDb } = await import('../db/index.js')
const { default: objectivesRouter } = await import('./objectives.js')

const ADMIN_ID = 1
const MEMBER_ID = 2
const WS = 'test-ws'

let server: http.Server
let baseUrl: string

function makeApp(): express.Express {
  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  app.use('/api/objectives', objectivesRouter)
  return app
}

function token(role: 'admin' | 'member'): string {
  const id = role === 'admin' ? ADMIN_ID : MEMBER_ID
  return jwt.sign({ id, username: role, role }, process.env.JWT_SECRET as string, { expiresIn: '1h' })
}

async function put(role: 'admin' | 'member', id: number, body: unknown) {
  const res = await fetch(`${baseUrl}/api/objectives/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: `token=${token(role)}` },
    body: JSON.stringify(body),
  })
  return { status: res.status, json: await res.json() as Record<string, unknown> }
}

beforeAll(async () => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
  // Seed the two users referenced by the JWTs (user_workspaces has an FK to users).
  const ins = getDb().prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, 'x', ?)`)
  ins.run(ADMIN_ID, 'admin', 'admin')
  ins.run(MEMBER_ID, 'member', 'member')
  // Member must have workspace access so the workspace-gate isn't what rejects
  // them — we want to prove the skip_ai_review gate specifically.
  getDb().prepare(`INSERT INTO user_workspaces (user_id, workspace, role) VALUES (?, ?, 'member')`).run(MEMBER_ID, WS)
  const app = makeApp()
  await new Promise<void>(resolve => { server = app.listen(0, () => resolve()) })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('server has no address')
  baseUrl = `http://127.0.0.1:${addr.port}`
})

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
  try { getDb().close() } catch {}
  for (const suffix of ['', '-wal', '-shm']) {
    const f = `${TMP_DB}${suffix}`
    if (fs.existsSync(f)) fs.unlinkSync(f)
  }
})

beforeEach(() => {
  getDb().prepare('DELETE FROM objective_audit').run()
  getDb().prepare('DELETE FROM objective_prs').run()
  getDb().prepare('DELETE FROM objectives').run()
})

const PR = (n: number) => `https://github.com/Example-Project/example-project-platform/pull/${n}`

function seedLinked(): number {
  const r = getDb().prepare(
    `INSERT INTO objectives (title, agent_context, workspace, created_by, status, pr_url, pr_number, branch_name)
     VALUES ('Abner ledger', 'cto', ?, ?, 'review', ?, 715, 'ws-712923-abner-credit-ledger')`
  ).run(WS, MEMBER_ID, PR(715))
  return Number(r.lastInsertRowid)
}
const link = (id: number) => getDb().prepare('SELECT pr_url, pr_number, branch_name FROM objectives WHERE id = ?').get(id)
const audit = (id: number) => getDb().prepare("SELECT actor, pathway FROM objective_audit WHERE objective_id = ? AND event_type = 'pr_link'").all(id) as Array<{ actor: string; pathway: string }>

describe('PUT /api/objectives/:id — admin PR-link override (obj 712954)', () => {
  it('ADMIN: sets pr_url + pr_number + branch_name and writes an audit row', async () => {
    const id = seedLinked()
    const { status, json } = await put('admin', id, { pr_url: PR(716), pr_number: 716, branch_name: 'ws-712923-round2-abner-credit-fixes' })
    expect(status).toBe(200)
    expect(json.pr_number).toBe(716)
    expect(link(id)).toEqual({ pr_url: PR(716), pr_number: 716, branch_name: 'ws-712923-round2-abner-credit-fixes' })
    const a = audit(id)
    expect(a).toHaveLength(1)
    expect(a[0].actor).toBe('user:admin')
    expect(a[0].pathway).toContain(`${PR(715)} [ws-712923-abner-credit-ledger] -> ${PR(716)} [ws-712923-round2-abner-credit-fixes]`)
    const prs = getDb().prepare('SELECT pr_number, repo FROM objective_prs WHERE objective_id = ?').all(id)
    expect(prs).toEqual([{ pr_number: 716, repo: 'Example-Project/example-project-platform' }])
  })

  it('ADMIN: pr_url alone derives pr_number; branch_name is left as is', async () => {
    const id = seedLinked()
    const { status } = await put('admin', id, { pr_url: PR(716) })
    expect(status).toBe(200)
    expect(link(id)).toEqual({ pr_url: PR(716), pr_number: 716, branch_name: 'ws-712923-abner-credit-ledger' })
  })

  it('ADMIN: pr_url null clears the link', async () => {
    const id = seedLinked()
    expect((await put('admin', id, { pr_url: null })).status).toBe(200)
    expect(link(id)).toEqual({ pr_url: null, pr_number: null, branch_name: 'ws-712923-abner-credit-ledger' })
    expect(audit(id)).toHaveLength(1)
  })

  it('REJECTS a non-admin (403) and writes nothing — including the other fields in the body', async () => {
    const id = seedLinked()
    const { status, json } = await put('member', id, { title: 'renamed', pr_url: PR(716), pr_number: 716 })
    expect(status).toBe(403)
    expect(json.error).toMatch(/admin/i)
    expect(link(id)).toEqual({ pr_url: PR(715), pr_number: 715, branch_name: 'ws-712923-abner-credit-ledger' })
    expect((getDb().prepare('SELECT title FROM objectives WHERE id = ?').get(id) as { title: string }).title).toBe('Abner ledger')
    expect(audit(id)).toEqual([])
  })

  it.each([
    [{ pr_url: PR(716), pr_number: 717 }, /does not match/],
    [{ pr_url: 'https://gitlab.com/x/y/merge_requests/3' }, /github\.com/],
    [{ pr_url: `${PR(716)}/files` }, /github\.com/],
    [{ pr_number: 716 }, /requires pr_url/],
    [{ pr_url: PR(716), pr_number: -1 }, /positive integer/],
    [{ pr_url: PR(716), branch_name: 'bad branch; rm -rf' }, /branch/],
    [{ pr_url: 42 }, /GitHub PR URL/],
  ])('REJECTS invalid input %j (400) and writes nothing', async (body, err) => {
    const id = seedLinked()
    const { status, json } = await put('admin', id, body)
    expect(status).toBe(400)
    expect(String(json.error)).toMatch(err)
    expect(link(id)).toEqual({ pr_url: PR(715), pr_number: 715, branch_name: 'ws-712923-abner-credit-ledger' })
    expect(audit(id)).toEqual([])
  })

  it('control: a PUT without PR fields is unaffected for a non-admin and writes no pr_link audit', async () => {
    const id = seedLinked()
    const { status } = await put('member', id, { title: 'renamed' })
    expect(status).toBe(200)
    expect(link(id)).toEqual({ pr_url: PR(715), pr_number: 715, branch_name: 'ws-712923-abner-credit-ledger' })
    expect(audit(id)).toEqual([])
  })
})
