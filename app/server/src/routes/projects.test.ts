/**
 * Tests for the projects CRUD API (obj 708808).
 * Covers: create/rename/archive/delete project, delete detaches objectives,
 * cross-workspace project_id rejected, child inherits parent project_id,
 * list filtering by project_id.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'
import cookieParser from 'cookie-parser'
import jwt from 'jsonwebtoken'

const TMP_DB = path.join(os.tmpdir(), `cc-projects-test-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB
process.env.JWT_SECRET = 'test-secret-projects'

const { initDb, getDb } = await import('../db/index.js')
const { default: projectsRouter } = await import('./projects.js')
const { default: objectivesRouter } = await import('./objectives.js')

function makeApp(): express.Express {
  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  app.use('/api/projects', projectsRouter)
  app.use('/api/objectives', objectivesRouter)
  return app
}

let server: http.Server
let baseUrl: string
let adminCookie: string
let memberCookie: string

async function req(method: string, path: string, body?: unknown, cookie = adminCookie) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: body ? JSON.stringify(body) : undefined,
  })
  const json = await res.json().catch(() => null)
  return { status: res.status, json }
}

beforeAll(async () => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
  const db = getDb()

  // Seed users first (user_workspaces has user_id FK → users).
  db.exec(`
    INSERT OR IGNORE INTO users (id, username, password_hash, role) VALUES (1, 'admin', 'x', 'admin');
    INSERT OR IGNORE INTO users (id, username, password_hash, role) VALUES (2, 'member', 'x', 'member');
  `)
  // Seed workspaces (user_workspaces.workspace has no FK in core schema, but
  // initWorkspacesSchema may enforce one; use INSERT OR IGNORE to be safe).
  db.exec(`
    INSERT OR IGNORE INTO workspaces (slug, name) VALUES ('ws-a', 'Workspace A');
    INSERT OR IGNORE INTO workspaces (slug, name) VALUES ('ws-b', 'Workspace B');
  `)
  // Seed memberships.
  db.exec(`
    INSERT OR IGNORE INTO user_workspaces (user_id, workspace) VALUES (1, 'ws-a');
    INSERT OR IGNORE INTO user_workspaces (user_id, workspace) VALUES (1, 'ws-b');
    INSERT OR IGNORE INTO user_workspaces (user_id, workspace) VALUES (2, 'ws-a');
  `)

  const app = makeApp()
  await new Promise<void>(resolve => { server = app.listen(0, () => resolve()) })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('server has no address')
  baseUrl = `http://127.0.0.1:${addr.port}`

  adminCookie = `token=${jwt.sign({ id: 1, username: 'admin', role: 'admin' }, process.env.JWT_SECRET as string, { expiresIn: '1h' })}`
  memberCookie = `token=${jwt.sign({ id: 2, username: 'member', role: 'member' }, process.env.JWT_SECRET as string, { expiresIn: '1h' })}`
})

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
})

describe('GET /api/projects', () => {
  it('requires workspace param', async () => {
    const { status } = await req('GET', '/api/projects')
    expect(status).toBe(400)
  })

  it('returns empty list for new workspace', async () => {
    const { status, json } = await req('GET', '/api/projects?workspace=ws-a')
    expect(status).toBe(200)
    expect(Array.isArray(json)).toBe(true)
    expect(json.length).toBe(0)
  })
})

describe('POST /api/projects', () => {
  it('creates a project', async () => {
    const { status, json } = await req('POST', '/api/projects', { workspace: 'ws-a', name: 'Alpha', color: '#ff0000' })
    expect(status).toBe(201)
    expect(json.name).toBe('Alpha')
    expect(json.workspace).toBe('ws-a')
    expect(json.archived).toBe(false)
    expect(typeof json.id).toBe('number')
  })

  it('rejects duplicate name in same workspace', async () => {
    const { status } = await req('POST', '/api/projects', { workspace: 'ws-a', name: 'Alpha' })
    expect(status).toBe(409)
  })

  it('rejects missing name', async () => {
    const { status } = await req('POST', '/api/projects', { workspace: 'ws-a', name: '' })
    expect(status).toBe(400)
  })

  it('member cannot create in workspace they do not belong to', async () => {
    const { status } = await req('POST', '/api/projects', { workspace: 'ws-b', name: 'MemberTest' }, memberCookie)
    expect(status).toBe(403)
  })

  it('member can create in their own workspace', async () => {
    const { status, json } = await req('POST', '/api/projects', { workspace: 'ws-a', name: 'MemberOwn' }, memberCookie)
    expect(status).toBe(201)
    expect(json.workspace).toBe('ws-a')
  })
})

describe('PATCH /api/projects/:id (rename/archive)', () => {
  let projectId: number

  beforeAll(async () => {
    const { json } = await req('POST', '/api/projects', { workspace: 'ws-a', name: 'PatchMe' })
    projectId = json.id
  })

  it('renames a project', async () => {
    const { status, json } = await req('PATCH', `/api/projects/${projectId}`, { name: 'PatchMeRenamed' })
    expect(status).toBe(200)
    expect(json.name).toBe('PatchMeRenamed')
  })

  it('archives a project', async () => {
    const { status, json } = await req('PATCH', `/api/projects/${projectId}`, { archived: true })
    expect(status).toBe(200)
    expect(json.archived).toBe(true)
  })

  it('unarchives a project', async () => {
    const { status, json } = await req('PATCH', `/api/projects/${projectId}`, { archived: false })
    expect(status).toBe(200)
    expect(json.archived).toBe(false)
  })

  it('rejects rename to a name already used in same workspace', async () => {
    // Create another project first
    await req('POST', '/api/projects', { workspace: 'ws-a', name: 'Existing' })
    const { status } = await req('PATCH', `/api/projects/${projectId}`, { name: 'Existing' })
    expect(status).toBe(409)
  })

  it('returns 404 for unknown id', async () => {
    const { status } = await req('PATCH', '/api/projects/999999', { name: 'X' })
    expect(status).toBe(404)
  })

  it('archived projects appear with include_archived=1', async () => {
    await req('PATCH', `/api/projects/${projectId}`, { archived: true })
    const { json: withoutArchived } = await req('GET', '/api/projects?workspace=ws-a')
    const { json: withArchived } = await req('GET', '/api/projects?workspace=ws-a&include_archived=1')
    const withoutIds = (withoutArchived as { id: number }[]).map(p => p.id)
    const withIds = (withArchived as { id: number }[]).map(p => p.id)
    expect(withoutIds).not.toContain(projectId)
    expect(withIds).toContain(projectId)
    // Unarchive for cleanliness
    await req('PATCH', `/api/projects/${projectId}`, { archived: false })
  })
})

describe('DELETE /api/projects/:id (detaches objectives)', () => {
  it('deletes a project and nulls objectives.project_id', async () => {
    // Create project
    const { json: proj } = await req('POST', '/api/projects', { workspace: 'ws-a', name: 'ToDelete' })
    const projId = proj.id

    // Create an objective assigned to this project
    const db = getDb()
    const r = db.prepare(
      `INSERT INTO objectives (title, workspace, project_id, status) VALUES (?, ?, ?, 'queue')`
    ).run('Detach me', 'ws-a', projId)
    const objId = r.lastInsertRowid

    // Confirm project_id is set
    const before = db.prepare('SELECT project_id FROM objectives WHERE id = ?').get(objId) as { project_id: number }
    expect(before.project_id).toBe(projId)

    // Delete the project
    const { status, json } = await req('DELETE', `/api/projects/${projId}`)
    expect(status).toBe(200)
    expect(json.deleted).toBe(true)
    expect(json.detached_objectives).toBe(1)

    // Objective must still exist with project_id nulled out
    const after = db.prepare('SELECT id, project_id FROM objectives WHERE id = ?').get(objId) as { id: number; project_id: number | null }
    expect(after).toBeTruthy()
    expect(after.project_id).toBeNull()

    // Project is gone
    const gone = db.prepare('SELECT id FROM projects WHERE id = ?').get(projId)
    expect(gone).toBeUndefined()
  })
})

describe('workspace authz on project_id in objectives', () => {
  it('rejects project_id from a different workspace on objective create', async () => {
    // Create a project in ws-b
    const { json: proj } = await req('POST', '/api/projects', { workspace: 'ws-b', name: 'WSBProj' })
    const wsBProjId = proj.id

    // Try to create an objective in ws-a referencing ws-b's project
    const { status, json } = await req('POST', '/api/objectives', {
      title: 'Cross-ws test',
      workspace: 'ws-a',
      project_id: wsBProjId,
    })
    expect(status).toBe(400)
    expect(json.error).toContain('ws-b')
  })

  it('accepts valid project_id in same workspace', async () => {
    const { json: proj } = await req('POST', '/api/projects', { workspace: 'ws-a', name: 'ValidProj' })
    const projId = proj.id

    const { status, json } = await req('POST', '/api/objectives', {
      title: 'Valid project_id test',
      workspace: 'ws-a',
      project_id: projId,
    })
    expect(status).toBe(201)
    expect(json.project_id).toBe(projId)
  })
})

describe('child inherits parent project_id', () => {
  it('a child objective inherits parent project_id when not specified', async () => {
    // Create project
    const { json: proj } = await req('POST', '/api/projects', { workspace: 'ws-a', name: 'InheritProj' })
    const projId = proj.id

    // Create parent objective with project_id
    const { json: parent } = await req('POST', '/api/objectives', {
      title: 'Parent with project',
      workspace: 'ws-a',
      project_id: projId,
    })
    expect(parent.project_id).toBe(projId)

    // Create child without project_id — should inherit
    const { status, json: child } = await req('POST', '/api/objectives', {
      title: 'Child inherits project',
      workspace: 'ws-a',
      parent_id: parent.id,
      // project_id NOT set
    })
    expect(status).toBe(201)
    expect(child.project_id).toBe(projId)
  })

  it('explicit null project_id on child does NOT inherit', async () => {
    const { json: proj } = await req('POST', '/api/projects', { workspace: 'ws-a', name: 'NoInheritProj' })
    const projId = proj.id

    const { json: parent } = await req('POST', '/api/objectives', {
      title: 'Parent for no-inherit',
      workspace: 'ws-a',
      project_id: projId,
    })

    const { status, json: child } = await req('POST', '/api/objectives', {
      title: 'Child explicit null',
      workspace: 'ws-a',
      parent_id: parent.id,
      project_id: null,
    })
    expect(status).toBe(201)
    expect(child.project_id).toBeNull()
  })
})

describe('objective list filtering by project_id', () => {
  let projAId: number
  let objInProj: number
  let objNoProj: number

  beforeAll(async () => {
    const db = getDb()
    const { json: p } = await req('POST', '/api/projects', { workspace: 'ws-a', name: 'FilterProj' })
    projAId = p.id

    const r1 = db.prepare(
      `INSERT INTO objectives (title, workspace, project_id, status) VALUES ('In proj', 'ws-a', ?, 'queue')`
    ).run(projAId)
    objInProj = r1.lastInsertRowid as number

    const r2 = db.prepare(
      `INSERT INTO objectives (title, workspace, project_id, status) VALUES ('No proj', 'ws-a', NULL, 'queue')`
    ).run()
    objNoProj = r2.lastInsertRowid as number
  })

  it('filters to objectives in a specific project', async () => {
    const { json } = await req('GET', `/api/objectives?workspace=ws-a&project_id=${projAId}`)
    const ids = (json as { id: number }[]).map(o => o.id)
    expect(ids).toContain(objInProj)
    expect(ids).not.toContain(objNoProj)
  })

  it('filters to unassigned objectives (project_id=unassigned)', async () => {
    const { json } = await req('GET', '/api/objectives?workspace=ws-a&project_id=unassigned')
    const ids = (json as { id: number }[]).map(o => o.id)
    expect(ids).toContain(objNoProj)
    expect(ids).not.toContain(objInProj)
  })

  it('no project_id filter returns all objectives', async () => {
    const { json } = await req('GET', '/api/objectives?workspace=ws-a')
    const ids = (json as { id: number }[]).map(o => o.id)
    expect(ids).toContain(objInProj)
    expect(ids).toContain(objNoProj)
  })

  it('list includes project_id field on objectives', async () => {
    const { json } = await req('GET', `/api/objectives?workspace=ws-a&project_id=${projAId}`)
    const obj = (json as { id: number; project_id: number }[]).find(o => o.id === objInProj)
    expect(obj).toBeTruthy()
    expect(obj!.project_id).toBe(projAId)
  })
})

describe('objective_count on project list', () => {
  it('returns correct objective count per project', async () => {
    const db = getDb()
    const { json: p } = await req('POST', '/api/projects', { workspace: 'ws-a', name: 'CountProj' })
    const pId = p.id

    db.prepare(`INSERT INTO objectives (title, workspace, project_id, status) VALUES ('X', 'ws-a', ?, 'queue')`).run(pId)
    db.prepare(`INSERT INTO objectives (title, workspace, project_id, status) VALUES ('Y', 'ws-a', ?, 'queue')`).run(pId)

    const { json: list } = await req('GET', '/api/projects?workspace=ws-a')
    const proj = (list as { id: number; objective_count: number }[]).find(p => p.id === pId)
    expect(proj).toBeTruthy()
    expect(proj!.objective_count).toBe(2)
  })
})
