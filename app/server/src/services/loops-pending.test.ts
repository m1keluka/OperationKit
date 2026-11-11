import { describe, it, expect } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

// Point the loops engine at a throwaway vault BEFORE importing it (VAULT_PATH is read
// at import time). The /api/loops route (and its UI) were removed in obj 900543; the
// engine stays because the daily nudge (services/briefing-nudge.ts) still reads it.
const VAULT = fs.mkdtempSync(path.join(os.tmpdir(), 'loops-pending-vault-'))
process.env.VAULT_PATH = VAULT
process.env.GRANOLA_WORKSPACE = 'operator'
const LOOPS_DIR = path.join(VAULT, 'workspaces', 'operator', 'loops')

const loops = await import('./loops.js')

// Write a raw loop file with an arbitrary stored status (mirrors what loops-add.mjs
// or a legacy file looks like on disk) so we can assert how normalizeStatus reads it.
function writeRawLoop(slug: string, status: string) {
  fs.mkdirSync(LOOPS_DIR, { recursive: true })
  const fm = [
    '---',
    `title: ${JSON.stringify(slug)}`,
    `status: ${status}`,
    'party: ""',
    'tags: []',
    'opened: 2026-07-11',
    '---',
    '',
    'body',
    '',
  ].join('\n')
  fs.writeFileSync(path.join(LOOPS_DIR, `${slug}.md`), fm, 'utf8')
}

describe('loops — pending review lane', () => {
  it('pending is a valid loop status', () => {
    expect((loops.LOOP_STATUSES as readonly string[])).toContain('pending')
  })

  it('a file stamped status: pending reads as pending', () => {
    writeRawLoop('auto-detected-thing', 'pending')
    const l = loops.listLoops().find(x => x.slug === 'auto-detected-thing')
    expect(l).toBeTruthy()
    expect(l!.status).toBe('pending')
  })

  it('EXISTING-LOOPS-SAFE: legacy status: open still reads as queued, not pending', () => {
    writeRawLoop('legacy-open-loop', 'open')
    writeRawLoop('already-queued-loop', 'queued')
    const all = loops.listLoops()
    expect(all.find(x => x.slug === 'legacy-open-loop')!.status).toBe('queued')
    expect(all.find(x => x.slug === 'already-queued-loop')!.status).toBe('queued')
    // None of the non-pending files flipped into the review lane.
    expect(all.filter(x => x.status === 'pending').map(x => x.slug)).toEqual(['auto-detected-thing'])
  })

  it('patchLoopStatus accepts pending as a valid target (service level)', () => {
    const r = loops.createLoop({ party: '', title: 'move me to pending' })
    const moved = loops.patchLoopStatus(r.loop!.slug, 'pending')
    expect(moved.ok).toBe(true)
    expect(moved.loop!.status).toBe('pending')
  })

})
