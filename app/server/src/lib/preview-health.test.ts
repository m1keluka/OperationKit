import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const TMP_DB = path.join(os.tmpdir(), `cc-preview-health-test-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB
process.env.JWT_SECRET = 'test-secret-preview-health'

const { initDb, getDb } = await import('../db/index.js')
const { pickPreviewCanary, previewHostFor, derivePreviewStatus, PREVIEW_CANARY_PROJECT } = await import('./preview-health.js')

beforeAll(() => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
})

afterAll(() => {
  try { getDb().close() } catch {}
  for (const suffix of ['', '-wal', '-shm']) {
    const f = `${TMP_DB}${suffix}`
    if (fs.existsSync(f)) fs.unlinkSync(f)
  }
})

beforeEach(() => {
  getDb().exec('DELETE FROM objectives')
})

function insertObjective(over: {
  title?: string
  project?: string | null
  prNumber?: number | null
  status?: string
}): number {
  const info = getDb()
    .prepare(
      "INSERT INTO objectives (title, status, project, pr_number, updated_at) VALUES (?, ?, ?, ?, datetime('now', ?))",
    )
    .run(
      over.title ?? 'A PR objective',
      over.status ?? 'working',
      over.project ?? PREVIEW_CANARY_PROJECT,
      over.prNumber ?? null,
      '+0 seconds',
    )
  return Number(info.lastInsertRowid)
}

describe('pickPreviewCanary', () => {
  it('returns null when nothing is open against this repo', () => {
    expect(pickPreviewCanary(getDb())).toBeNull()
  })

  it('ignores objectives with no pr_number', () => {
    insertObjective({ prNumber: null })
    expect(pickPreviewCanary(getDb())).toBeNull()
  })

  it('ignores objectives from a different project', () => {
    insertObjective({ project: 'example-project-platform', prNumber: 42 })
    expect(pickPreviewCanary(getDb())).toBeNull()
  })

  it('ignores done/cancelled objectives', () => {
    insertObjective({ prNumber: 42, status: 'done' })
    insertObjective({ prNumber: 43, status: 'cancelled' })
    expect(pickPreviewCanary(getDb())).toBeNull()
  })

  it('picks the most recently updated eligible PR', () => {
    const olderId = insertObjective({ prNumber: 100, title: 'Older PR' })
    getDb().prepare("UPDATE objectives SET updated_at = datetime('now', '-1 hour') WHERE id = ?").run(olderId)
    const newerId = insertObjective({ prNumber: 200, title: 'Newer PR' })

    const canary = pickPreviewCanary(getDb())
    expect(canary?.objectiveId).toBe(newerId)
    expect(canary?.prNumber).toBe(200)
    expect(canary?.title).toBe('Newer PR')
  })
})

describe('previewHostFor', () => {
  it('builds the pr-N hostname', () => {
    expect(previewHostFor(586)).toBe('pr-586.cc.example.com')
  })
})

describe('derivePreviewStatus', () => {
  const canary = { objectiveId: 1, prNumber: 586, title: 'x', updatedAt: 'now' }

  it('is unknown with no canary', () => {
    expect(derivePreviewStatus(null, { ok: true, httpCode: 200, ms: 10, error: null })).toBe('unknown')
  })

  it('is unknown with no probe result', () => {
    expect(derivePreviewStatus(canary, null)).toBe('unknown')
  })

  it('is up when the probe succeeds', () => {
    expect(derivePreviewStatus(canary, { ok: true, httpCode: 200, ms: 10, error: null })).toBe('up')
  })

  it('is down when the probe fails (TLS error or non-2xx)', () => {
    expect(derivePreviewStatus(canary, { ok: false, httpCode: null, ms: null, error: 'tlsv1 alert internal error' })).toBe(
      'down',
    )
  })
})
