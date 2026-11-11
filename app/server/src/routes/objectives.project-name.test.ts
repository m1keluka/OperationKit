/**
 * Server test: project_name + project_color fields in LIST + GET /:id (obj 710597).
 *
 * Verifies:
 *  1. An objective with a project_id returns project_name / project_color from the JOIN.
 *  2. An objective with project_id = NULL returns project_name = null / project_color = null.
 *  3. Slim projection (LIST) still withholds the heavy TEXT columns after the JOIN.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'
import cookieParser from 'cookie-parser'
import jwt from 'jsonwebtoken'

const TMP_DB = path.join(os.tmpdir(), `cc-project-name-test-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB
process.env.JWT_SECRET = 'test-secret-project-name'

const { initDb, getDb } = await import('../db/index.js')
const { default: objectivesRouter } = await import('./objectives.js')

let server: http.Server
let baseUrl: string
let cookie: string
let idWithProject: number
let idNoProject: number
let projectId: number

function makeApp(): express.Express {
  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  app.use('/api/objectives', objectivesRouter)
  return app
}

async function get(pathPart: string) {
  const res = await fetch(`${baseUrl}${pathPart}`, { headers: { Cookie: cookie } })
  const json = await res.json().catch(() => null)
  return { status: res.status, json }
}

const HEAVY = ['description', 'last_session_summary', 'approved_plan', 'ai_review_findings', 'acceptance_criteria'] as const

beforeAll(async () => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
  const db = getDb()

  // Insert a project
  const proj = db.prepare(
    `INSERT INTO projects (workspace, name, color) VALUES (?, ?, ?)`
  ).run('testws', 'Alpha Project', '#6366f1')
  projectId = Number(proj.lastInsertRowid)

  // Objective associated with the project
  const fat = 'x'.repeat(4000)
  const withProj = db.prepare(
    `INSERT INTO objectives (title, description, last_session_summary, approved_plan, ai_review_findings, acceptance_criteria, status, workspace, project_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run('with-project', fat, fat, fat, fat, '[]', 'queue', 'testws', projectId)
  idWithProject = Number(withProj.lastInsertRowid)

  // Objective with no project
  const noProj = db.prepare(
    `INSERT INTO objectives (title, description, last_session_summary, approved_plan, ai_review_findings, acceptance_criteria, status, workspace, project_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run('no-project', fat, fat, fat, fat, '[]', 'queue', 'testws', null)
  idNoProject = Number(noProj.lastInsertRowid)

  const app = makeApp()
  await new Promise<void>(resolve => { server = app.listen(0, () => resolve()) })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('server has no address')
  baseUrl = `http://127.0.0.1:${addr.port}`
  cookie = `token=${jwt.sign({ id: 1, username: 'tester', role: 'admin' }, process.env.JWT_SECRET as string, { expiresIn: '1h' })}`
})

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
})

describe('project_name / project_color on objectives LIST + GET (obj 710597)', () => {
  it('LIST: objective with project_id resolves project_name and project_color', async () => {
    const { status, json } = await get('/api/objectives?workspace=testws')
    expect(status).toBe(200)
    const row = (json as any[]).find((o: any) => o.id === idWithProject)
    expect(row).toBeTruthy()
    expect(row.project_name).toBe('Alpha Project')
    expect(row.project_color).toBe('#6366f1')
  })

  it('LIST: objective without project_id has project_name = null and project_color = null', async () => {
    const { status, json } = await get('/api/objectives?workspace=testws')
    expect(status).toBe(200)
    const row = (json as any[]).find((o: any) => o.id === idNoProject)
    expect(row).toBeTruthy()
    expect(row.project_name).toBeNull()
    expect(row.project_color).toBeNull()
  })

  it('LIST: slim projection still withholds heavy text columns after JOIN', async () => {
    const { json } = await get('/api/objectives?workspace=testws')
    const row = (json as any[]).find((o: any) => o.id === idWithProject)
    expect(row).toBeTruthy()
    // acceptance_criteria is normalised to null by mapObjective
    expect(row.acceptance_criteria).toBeNull()
    for (const f of HEAVY) {
      if (f === 'acceptance_criteria') expect(row[f]).toBeNull()
      else expect(row[f]).toBeUndefined()
    }
  })

  it('GET /:id: objective with project_id resolves project_name and project_color', async () => {
    const { status, json } = await get(`/api/objectives/${idWithProject}`)
    expect(status).toBe(200)
    expect((json as any).project_name).toBe('Alpha Project')
    expect((json as any).project_color).toBe('#6366f1')
  })

  it('GET /:id: objective without project_id has project_name = null and project_color = null', async () => {
    const { status, json } = await get(`/api/objectives/${idNoProject}`)
    expect(status).toBe(200)
    expect((json as any).project_name).toBeNull()
    expect((json as any).project_color).toBeNull()
  })
})
