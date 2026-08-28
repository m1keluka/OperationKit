import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'
import cookieParser from 'cookie-parser'
import jwt from 'jsonwebtoken'
import type { ResourceAssignment } from '@command-center/shared'

// Isolated DB + JWT secret BEFORE importing modules.
process.env.JWT_SECRET = 'test-secret-resource-assignments'
const TMP_DB = path.join(os.tmpdir(), `cc-resource-assign-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB

const { initDb, getDb } = await import('../db/index.js')
const { default: router } = await import('./resource-assignments.js')
const { resolveAvailable, isResourceAvailable } = await import('../services/resource-assignments.js')

let server: http.Server
let baseUrl: string

// Users: 1 = global admin, 2 = member of 'example', 3 = member of 'example4'.
const ADMIN = 1
const EXAMPLE_MEMBER = 2
const OTHER_MEMBER = 3

function cookieFor(id: number, role: 'admin' | 'member'): string {
  return `token=${jwt.sign({ id, username: `u${id}`, role }, process.env.JWT_SECRET as string, { expiresIn: '1h' })}`
}
const ADMIN_C = () => cookieFor(ADMIN, 'admin')
const EXAMPLE_C = () => cookieFor(EXAMPLE_MEMBER, 'member')
const OTHER_C = () => cookieFor(OTHER_MEMBER, 'member')

async function call(method: string, p: string, body?: unknown, cookie?: string) {
  const res = await fetch(`${baseUrl}/api/resource-assignments${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let json: unknown = null
  try { json = text ? JSON.parse(text) : null } catch {}
  return { status: res.status, json, text }
}

beforeAll(async () => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
  const db = getDb()
  db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (1, 'admin', 'x', 'admin')`).run()
  db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (2, 'examplemem', 'x', 'member')`).run()
  db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (3, 'othermem', 'x', 'member')`).run()
  db.prepare(`INSERT INTO user_workspaces (user_id, workspace, role) VALUES (2, 'example', 'member')`).run()
  db.prepare(`INSERT INTO user_workspaces (user_id, workspace, role) VALUES (3, 'example4', 'member')`).run()

  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  app.use('/api/resource-assignments', router)
  await new Promise<void>(resolve => { server = app.listen(0, () => resolve()) })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no address')
  baseUrl = `http://127.0.0.1:${addr.port}`
})

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
  try { getDb().close() } catch {}
  for (const s of ['', '-wal', '-shm']) { const f = `${TMP_DB}${s}`; if (fs.existsSync(f)) fs.unlinkSync(f) }
})

beforeEach(() => {
  getDb().exec('DELETE FROM resource_assignments;')
})

describe('resource-assignments — auth', () => {
  it('rejects without auth (401)', async () => {
    expect((await call('GET', '/')).status).toBe(401)
    expect((await call('POST', '/', { resourceType: 'agent', resourceId: 'cmo', scopeType: 'global' })).status).toBe(401)
  })
})

describe('resource-assignments — global scope (admin only)', () => {
  it('admin can create/list/delete a global assignment; member cannot write', async () => {
    const created = await call('POST', '/', { resourceType: 'skill', resourceId: 'deep-research', scopeType: 'global' }, ADMIN_C())
    expect(created.status).toBe(201)
    const a = created.json as ResourceAssignment
    expect(a.resourceType).toBe('skill')
    expect(a.resourceId).toBe('deep-research')
    expect(a.scopeType).toBe('global')
    expect(a.workspace).toBeNull()
    expect(a.project).toBeNull()
    expect(a.userId).toBeNull()

    // idempotent re-assert returns the same row id, still 201
    const again = await call('POST', '/', { resourceType: 'skill', resourceId: 'deep-research', scopeType: 'global' }, ADMIN_C())
    expect(again.status).toBe(201)
    expect((again.json as ResourceAssignment).id).toBe(a.id)

    // member cannot write global
    expect((await call('POST', '/', { resourceType: 'skill', resourceId: 'x', scopeType: 'global' }, EXAMPLE_C())).status).toBe(403)

    const del = await call('DELETE', '/?resourceType=skill&resourceId=deep-research&scopeType=global', undefined, ADMIN_C())
    expect(del.status).toBe(204)
  })
})

describe('resource-assignments — workspace scope (org tier)', () => {
  it('a ws member can manage that ws; a non-member gets 403', async () => {
    const created = await call('POST', '/', { resourceType: 'agent', resourceId: 'cmo', scopeType: 'workspace', workspace: 'example' }, EXAMPLE_C())
    expect(created.status).toBe(201)

    // non-member of example denied
    expect((await call('POST', '/', { resourceType: 'agent', resourceId: 'cfo', scopeType: 'workspace', workspace: 'example' }, OTHER_C())).status).toBe(403)
    // other member does not see example's assignment in unfiltered list
    const otherList = await call('GET', '/', undefined, OTHER_C())
    expect((otherList.json as ResourceAssignment[]).some(x => x.workspace === 'example')).toBe(false)
    // member sees it
    const list = await call('GET', '/', undefined, EXAMPLE_C())
    expect((list.json as ResourceAssignment[]).some(x => x.scopeType === 'workspace' && x.workspace === 'example')).toBe(true)
  })
})

describe('resource-assignments — project scope (NEW tier)', () => {
  it('project assignment requires workspace+project and is gated by ws membership', async () => {
    // missing project → 400
    expect((await call('POST', '/', { resourceType: 'skill', resourceId: 'campaign-audit', scopeType: 'project', workspace: 'example' }, EXAMPLE_C())).status).toBe(400)
    // valid project assignment by ws member
    const ok = await call('POST', '/', { resourceType: 'skill', resourceId: 'campaign-audit', scopeType: 'project', workspace: 'example', project: 'example-platform' }, EXAMPLE_C())
    expect(ok.status).toBe(201)
    const a = ok.json as ResourceAssignment
    expect(a.scopeType).toBe('project')
    expect(a.workspace).toBe('example')
    expect(a.project).toBe('example-platform')
    // non-member of the workspace denied at project scope
    expect((await call('POST', '/', { resourceType: 'skill', resourceId: 'x', scopeType: 'project', workspace: 'example', project: 'example-platform' }, OTHER_C())).status).toBe(403)
    // admin can manage it too
    expect((await call('GET', '/?resourceType=skill', undefined, ADMIN_C())).status).toBe(200)
  })
})

describe('resource-assignments — user scope', () => {
  it('only the user themselves (or admin) can manage their assignment', async () => {
    const created = await call('POST', '/', { resourceType: 'agent', resourceId: 'designer', scopeType: 'user', userId: EXAMPLE_MEMBER }, EXAMPLE_C())
    expect(created.status).toBe(201)
    // another user cannot
    expect((await call('POST', '/', { resourceType: 'agent', resourceId: 'designer', scopeType: 'user', userId: EXAMPLE_MEMBER }, OTHER_C())).status).toBe(403)
    // admin can
    expect((await call('GET', '/?resourceType=agent', undefined, ADMIN_C())).status).toBe(200)
  })
})

describe('resource-assignments — validation + not-found', () => {
  it('400 on bad inputs', async () => {
    expect((await call('POST', '/', { resourceType: 'bogus', resourceId: 'x', scopeType: 'global' }, ADMIN_C())).status).toBe(400)
    expect((await call('POST', '/', { resourceType: 'agent', resourceId: '', scopeType: 'global' }, ADMIN_C())).status).toBe(400)
    expect((await call('POST', '/', { resourceType: 'agent', resourceId: 'cmo', scopeType: 'workspace' }, ADMIN_C())).status).toBe(400) // no workspace
    expect((await call('POST', '/', { resourceType: 'agent', resourceId: 'cmo', scopeType: 'user' }, ADMIN_C())).status).toBe(400) // no userId
    expect((await call('GET', '/resolve?resourceType=skill', undefined, ADMIN_C())).status).toBe(400) // no workspace
  })

  it('404 on delete of a missing assignment', async () => {
    expect((await call('DELETE', '/?resourceType=agent&resourceId=ghost&scopeType=global', undefined, ADMIN_C())).status).toBe(404)
  })
})

describe('resource-assignments — /resolve gate (availability semantics)', () => {
  it('unrestricted when nothing is scoped to the context', async () => {
    const r = await call('GET', '/resolve?resourceType=skill&workspace=example', undefined, ADMIN_C())
    expect(r.status).toBe(200)
    expect((r.json as { restricted: boolean }).restricted).toBe(false)
    // service-level gate agrees: any skill is available when unrestricted
    expect(isResourceAvailable('skill', 'anything', { workspace: 'example' })).toBe(true)
  })

  it('workspace assignment turns on the allow-list (incl. global baseline)', async () => {
    await call('POST', '/', { resourceType: 'skill', resourceId: 'deep-research', scopeType: 'global' }, ADMIN_C())
    await call('POST', '/', { resourceType: 'skill', resourceId: 'campaign-audit', scopeType: 'workspace', workspace: 'example' }, ADMIN_C())

    const r = await call('GET', '/resolve?resourceType=skill&workspace=example', undefined, ADMIN_C())
    const body = r.json as { restricted: boolean; allowed: string[] }
    expect(body.restricted).toBe(true)
    expect(body.allowed.sort()).toEqual(['campaign-audit', 'deep-research'])
    // a different workspace with no assignment stays unrestricted
    const other = await call('GET', '/resolve?resourceType=skill&workspace=example4', undefined, ADMIN_C())
    expect((other.json as { restricted: boolean }).restricted).toBe(false)
  })

  it('project assignment narrows availability to that project only', async () => {
    await call('POST', '/', { resourceType: 'skill', resourceId: 'campaign-audit', scopeType: 'project', workspace: 'example', project: 'example-platform' }, ADMIN_C())
    // matching project → restricted to the project skill
    const match = resolveAvailable('skill', { workspace: 'example', project: 'example-platform' })
    expect(match.restricted).toBe(true)
    expect(match.allowed).toEqual(['campaign-audit'])
    // same workspace, different project → not restricted by this project assignment
    const otherProj = resolveAvailable('skill', { workspace: 'example', project: 'other-repo' })
    expect(otherProj.restricted).toBe(false)
  })

  it('user-scoped grant is additive and only applies to that user', async () => {
    await call('POST', '/', { resourceType: 'agent', resourceId: 'hr', scopeType: 'workspace', workspace: 'example' }, ADMIN_C())
    await call('POST', '/', { resourceType: 'agent', resourceId: 'designer', scopeType: 'user', userId: EXAMPLE_MEMBER }, ADMIN_C())
    // user 2 in example: gets ws agent + their user grant
    const forUser = resolveAvailable('agent', { workspace: 'example', userId: EXAMPLE_MEMBER })
    expect(forUser.restricted).toBe(true)
    expect(forUser.allowed.sort()).toEqual(['designer', 'hr'])
    // user 3 in example: only the ws agent, not user 2's grant
    const forOther = resolveAvailable('agent', { workspace: 'example', userId: OTHER_MEMBER })
    expect(forOther.allowed).toEqual(['hr'])
  })

  it('non-member cannot resolve a workspace they do not belong to (403)', async () => {
    expect((await call('GET', '/resolve?resourceType=skill&workspace=example', undefined, OTHER_C())).status).toBe(403)
    expect((await call('GET', '/resolve?resourceType=skill&workspace=example4', undefined, OTHER_C())).status).toBe(200)
  })
})
