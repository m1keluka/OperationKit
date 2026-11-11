/**
 * obj 900493 — the content-engine owner seed is CONFIG, not source.
 *
 * The two real owners (full names included) used to be a literal in
 * schema/content.ts and shipped to the public OSS mirror. They now come from the
 * gitignored seed.content-owners.json (or SEED_CONTENT_OWNERS_PATH); no file means
 * no seed, which is the correct blank-slate behaviour for a fresh install.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadContentOwnerSeeds } from './content.js'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'content-owner-seed-'))
const write = (name: string, body: string) => {
  const p = path.join(tmp, name)
  fs.writeFileSync(p, body)
  return p
}

afterEach(() => {
  delete process.env.SEED_CONTENT_OWNERS_PATH
})

describe('loadContentOwnerSeeds', () => {
  it('returns [] when no seed file is configured (blank-slate install)', () => {
    process.env.SEED_CONTENT_OWNERS_PATH = path.join(tmp, 'does-not-exist.json')
    expect(loadContentOwnerSeeds()).toEqual([])
  })

  it('reads well-formed rows from SEED_CONTENT_OWNERS_PATH', () => {
    process.env.SEED_CONTENT_OWNERS_PATH = write(
      'ok.json',
      JSON.stringify([{ username: 'pat', vault: 'pat-vault', founder: 'pat', display: 'Pat Example' }]),
    )
    expect(loadContentOwnerSeeds()).toEqual([
      { username: 'pat', vault: 'pat-vault', founder: 'pat', display: 'Pat Example' },
    ])
  })

  it('drops malformed rows instead of seeding half a row', () => {
    process.env.SEED_CONTENT_OWNERS_PATH = write(
      'mixed.json',
      JSON.stringify([
        { username: 'pat', vault: 'v', founder: 'f', display: 'Pat' },
        { username: 'no-vault', founder: 'f', display: 'x' },
        null,
        'nope',
      ]),
    )
    expect(loadContentOwnerSeeds().map((r) => r.username)).toEqual(['pat'])
  })

  it('treats unreadable JSON / a non-array as no seed (never throws at boot)', () => {
    process.env.SEED_CONTENT_OWNERS_PATH = write('bad.json', '{not json')
    expect(loadContentOwnerSeeds()).toEqual([])
    process.env.SEED_CONTENT_OWNERS_PATH = write('obj.json', '{"username":"pat"}')
    expect(loadContentOwnerSeeds()).toEqual([])
  })

  it('carries no hardcoded owner list in source', () => {
    const src = fs.readFileSync(new URL('./content.ts', import.meta.url), 'utf-8')
    expect(src).not.toMatch(/const seeds = \[/)
    expect(src).not.toMatch(/display:\s*'[A-Z][a-z]+ [A-Z][a-z]+'/)
  })
})
