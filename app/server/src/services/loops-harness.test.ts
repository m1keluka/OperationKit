import { describe, it, expect, beforeAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

// Point the loops engine at a throwaway vault BEFORE importing it (the module reads
// VAULT_PATH at import time). Keeps these tests off Mike's real second-brain.
let loops: typeof import('./loops.js')
let buildNudgeText: (typeof import('./jarvis-nudge.js'))['buildNudgeText']
let LOOPS_DIR: string

beforeAll(async () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'loops-vault-'))
  process.env.VAULT_PATH = vault
  process.env.GRANOLA_WORKSPACE = 'personal'
  LOOPS_DIR = path.join(vault, 'workspaces', 'personal', 'loops')
  loops = await import('./loops.js')
  ;({ buildNudgeText } = await import('./jarvis-nudge.js'))
})

describe('loops service — create / list / archive', () => {
  it('createLoop lands a new loop in the queued lane, created today, with project + due', () => {
    const r = loops.createLoop({ party: 'Colin', title: 'Send Colin the pricing breakdown', project: 'example', due: '2026-06-25' })
    expect(r.ok).toBe(true)
    const all = loops.listLoops()
    const made = all.find(l => l.title === 'Send Colin the pricing breakdown')
    expect(made).toBeTruthy()
    expect(made!.status).toBe('queued')
    expect(made!.project).toBe('example')
    expect(made!.due).toBe('2026-06-25')
    expect(made!.party).toBe('Colin')
  })

  it('archiveLoop removes the loop from the active list and moves the file to loops-archive/ (reversible, no hard delete)', () => {
    const r = loops.createLoop({ party: '', title: 'Throwaway loop to archive' })
    expect(r.ok).toBe(true)
    const slug = r.loop!.slug
    expect(fs.existsSync(path.join(LOOPS_DIR, `${slug}.md`))).toBe(true)

    const ar = loops.archiveLoop(slug)
    expect(ar.ok).toBe(true)
    // Gone from the active list...
    expect(loops.listLoops().some(l => l.slug === slug)).toBe(false)
    // ...and gone from the active dir...
    expect(fs.existsSync(path.join(LOOPS_DIR, `${slug}.md`))).toBe(false)
    // ...but recoverable in the archive dir.
    const archiveDir = path.join(LOOPS_DIR, '..', 'loops-archive')
    expect(fs.existsSync(path.join(archiveDir, `${slug}.md`))).toBe(true)
  })

  it('archiveLoop on a missing slug returns not found (no throw)', () => {
    const ar = loops.archiveLoop('does-not-exist')
    expect(ar.ok).toBe(false)
    expect(ar.error).toBe('loop not found')
  })

  it('patchLoopStatus to done stamps a done-date; round-trips through the frontmatter', () => {
    const r = loops.createLoop({ party: '', title: 'Loop to complete' })
    const slug = r.loop!.slug
    const pr = loops.patchLoopStatus(slug, 'done')
    expect(pr.ok).toBe(true)
    expect(pr.loop!.status).toBe('done')
    expect(pr.loop!.closed).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    // re-read from disk to confirm serialization round-trip
    const reread = loops.listLoops().find(l => l.slug === slug)
    expect(reread!.status).toBe('done')
    expect(reread!.closed).toBe(pr.loop!.closed)
  })
})

describe('jarvis-nudge — buildNudgeText (deterministic fallback)', () => {
  const L = (over: Partial<import('./loops.js').Loop>): import('./loops.js').Loop => ({
    slug: 's', title: 't', status: 'queued', project: '', party: '', party_type: '',
    due: '', tags: [], source_meeting: '', source_note: '', opened: '2026-06-01', closed: '', body: '', ...over,
  })

  it('reports open count, flags overdue first, and ends with a call to action', () => {
    const today = '2026-06-20'
    const text = buildNudgeText([
      L({ slug: 'a', title: 'Overdue thing', status: 'working', due: '2026-06-10' }),
      L({ slug: 'b', title: 'Queued thing', status: 'queued', opened: '2026-05-01' }),
    ], today)
    expect(text).toContain('2 open loop')
    expect(text).toContain('OVERDUE')
    expect(text).toContain('Overdue thing')
    expect(text.toLowerCase()).toContain('today')
  })

  it('done loops are excluded from the open count', () => {
    const text = buildNudgeText([
      L({ slug: 'a', title: 'Open', status: 'working' }),
      L({ slug: 'b', title: 'Closed', status: 'done', closed: '2026-06-19' }),
    ], '2026-06-20')
    expect(text).toContain('1 open loop')
  })

  it('returns an inbox-zero message when there are no open loops', () => {
    const text = buildNudgeText([L({ status: 'done', closed: '2026-06-19' })], '2026-06-20')
    expect(text.toLowerCase()).toContain('nothing open')
  })
})
