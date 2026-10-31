import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

// Live artifacts (obj 715699): read-only mid-run access to objective memory with
// NOTES.md masked, dotfiles/symlinks hidden, traversal refused, text redacted.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-live-artifacts-'))
const ROOT = path.join(TMP, 'memory')
const OUTSIDE = path.join(TMP, 'outside-secret.txt')
const ID = 9001
const SECRET = 'zz-artifact-secret-value-123'
process.env.OBJECTIVE_MEMORY_ROOT = ROOT

const { listArtifacts, readArtifact, resolveArtifactPath, ArtifactError } = await import('./live-artifacts.js')

function expectArtifactError(fn: () => unknown, status: number): void {
  let caught: unknown
  try { fn() } catch (e) { caught = e }
  expect(caught).toBeInstanceOf(ArtifactError)
  expect((caught as InstanceType<typeof ArtifactError>).status).toBe(status)
}

beforeAll(() => {
  process.env.TEST_ARTIFACT_SECRET_TOKEN = SECRET
  const dir = path.join(ROOT, String(ID))
  fs.mkdirSync(path.join(dir, 'live'), { recursive: true })
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'ARTIFACT.md'), `# Deliverable\ntoken ${SECRET} here\n`)
  fs.writeFileSync(path.join(dir, 'NOTES.md'), 'private scratch\n')
  fs.writeFileSync(path.join(dir, 'live', 'partial.csv'), '0123456789'.repeat(10)) // 100 bytes
  fs.writeFileSync(path.join(dir, '.hidden'), 'hidden\n')
  fs.writeFileSync(path.join(dir, '.git', 'config'), 'x\n')
  fs.writeFileSync(path.join(dir, 'blob.bin'), Buffer.from([0x89, 0x50, 0x00, 0x01, 0x02, 0x00]))
  fs.writeFileSync(OUTSIDE, 'outside the card dir\n')
  fs.symlinkSync(OUTSIDE, path.join(dir, 'link.txt'))
  fs.symlinkSync(TMP, path.join(dir, 'linkdir'))
})

afterAll(() => {
  delete process.env.TEST_ARTIFACT_SECRET_TOKEN
  fs.rmSync(TMP, { recursive: true, force: true })
})

describe('listArtifacts', () => {
  it('lists deliverables + partial outputs, masking NOTES.md, dotfiles and symlinks', () => {
    const { entries, truncated } = listArtifacts(ID)
    expect(truncated).toBe(false)
    const paths = entries.map(e => e.path).sort()
    expect(paths).toEqual(['ARTIFACT.md', 'blob.bin', 'live/partial.csv'])
    expect(entries.find(e => e.path === 'blob.bin')!.kind).toBe('binary')
    expect(entries.find(e => e.path === 'ARTIFACT.md')!.kind).toBe('text')
    expect(entries.find(e => e.path === 'live/partial.csv')!.size).toBe(100)
  })

  it('returns an empty list for a card with no memory dir', () => {
    expect(listArtifacts(424242)).toEqual({ entries: [], truncated: false })
  })
})

describe('resolveArtifactPath / readArtifact — refusals', () => {
  it('NOTES.md → 403', () => {
    expectArtifactError(() => readArtifact(ID, 'NOTES.md'), 403)
    expectArtifactError(() => readArtifact(ID, './NOTES.md'), 403)
  })

  it('traversal / absolute / backslash → 400', () => {
    expectArtifactError(() => readArtifact(ID, '../outside-secret.txt'), 400)
    expectArtifactError(() => readArtifact(ID, 'live/../../x'), 400)
    expectArtifactError(() => readArtifact(ID, OUTSIDE), 400)
    expectArtifactError(() => readArtifact(ID, 'live\\partial.csv'), 400)
    expectArtifactError(() => resolveArtifactPath(ID, ''), 400)
    expectArtifactError(() => resolveArtifactPath(ID, undefined), 400)
  })

  it('symlinks (file or dir) → 404, never followed', () => {
    expectArtifactError(() => readArtifact(ID, 'link.txt'), 404)
    expectArtifactError(() => readArtifact(ID, 'linkdir/outside-secret.txt'), 404)
  })

  it('dotfiles and missing files → 404; a directory → 400', () => {
    expectArtifactError(() => readArtifact(ID, '.hidden'), 404)
    expectArtifactError(() => readArtifact(ID, '.git/config'), 404)
    expectArtifactError(() => readArtifact(ID, 'nope.txt'), 404)
    expectArtifactError(() => readArtifact(ID, 'live'), 400)
  })

  it('binary → 415', () => {
    expectArtifactError(() => readArtifact(ID, 'blob.bin'), 415)
  })
})

describe('readArtifact — content', () => {
  it('redacts known secret values in text', () => {
    const r = readArtifact(ID, 'ARTIFACT.md')
    expect(r.content).toContain('[REDACTED:TEST_ARTIFACT_SECRET_TOKEN]')
    expect(r.content).not.toContain(SECRET)
    expect(r.redaction_count).toBe(1)
    expect(r.truncated).toBe(false)
    expect(r.path).toBe('ARTIFACT.md')
  })

  it('max_bytes truncates from the start', () => {
    const r = readArtifact(ID, 'live/partial.csv', { maxBytes: 10 })
    expect(r.content).toBe('0123456789')
    expect(r.offset).toBe(0)
    expect(r.bytes).toBe(10)
    expect(r.size).toBe(100)
    expect(r.truncated).toBe(true)
  })

  it('offset reads a mid-file window', () => {
    const r = readArtifact(ID, 'live/partial.csv', { offset: 95 })
    expect(r.content).toBe('56789')
    expect(r.offset).toBe(95)
    expect(r.truncated).toBe(false)
  })

  it('tail_bytes reads the end of a growing file and overrides offset', () => {
    const r = readArtifact(ID, 'live/partial.csv', { tailBytes: 4, offset: 0 })
    expect(r.content).toBe('6789')
    expect(r.offset).toBe(96)
    expect(r.truncated).toBe(false)
  })

  it('offset past EOF yields empty content', () => {
    const r = readArtifact(ID, 'live/partial.csv', { offset: 500 })
    expect(r.bytes).toBe(0)
    expect(r.content).toBe('')
  })
})
