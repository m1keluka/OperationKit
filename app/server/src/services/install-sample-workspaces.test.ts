/**
 * The installer must not hide a business.
 *
 * `runBootstrap` used to archive EVERY workspace but the client's. On a fresh
 * install that only hides the seeded samples; on a box that already carries
 * real work, a bootstrap re-run silently removes thousands of cards from the
 * board — which is what happened on the live box (obj 900206): two populated
 * workspaces were un-archived by hand and were archived again a day later.
 *
 * Slugs here are deliberately brand-neutral: the OSS publish step rewrites
 * product brand names in-tree, and two different slugs that genericize to the
 * same string would collide on `workspaces.slug`.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { archiveSampleWorkspaces } from './install-sample-workspaces.js'

const CLIENT = 'client-co'
const BIG = 'big-business'      // 8,703 cards — the one that kept getting hidden
const SMALL = 'side-business'   // 403 cards
const LEFTOVER = 'installer-leftover' // 1 card
const SAMPLE = 'pristine-sample'      // 0 cards — the only thing that should be hidden

function db(): Database.Database {
  const d = new Database(':memory:')
  d.exec(`
    CREATE TABLE workspaces (slug TEXT PRIMARY KEY, name TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE objectives (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, workspace TEXT NOT NULL);
  `)
  const ws = d.prepare('INSERT INTO workspaces (slug, name) VALUES (?, ?)')
  for (const s of [CLIENT, BIG, SMALL, LEFTOVER, SAMPLE]) ws.run(s, s)
  const card = d.prepare('INSERT INTO objectives (title, workspace) VALUES (?, ?)')
  for (let i = 0; i < 8703; i++) card.run('card', BIG)
  for (let i = 0; i < 403; i++) card.run('card', SMALL)
  for (let i = 0; i < 16; i++) card.run('card', CLIENT)
  card.run('cancelled installer card', LEFTOVER)
  return d
}
const archivedSlugs = (d: Database.Database) =>
  (d.prepare('SELECT slug FROM workspaces WHERE archived = 1 ORDER BY slug').all() as Array<{ slug: string }>)
    .map(r => r.slug)

describe('archiveSampleWorkspaces', () => {
  let d: Database.Database
  beforeEach(() => { d = db() })

  it('archives only the EMPTY non-client workspaces', () => {
    expect(archiveSampleWorkspaces(d, CLIENT).archived).toEqual([SAMPLE])
    expect(archivedSlugs(d)).toEqual([SAMPLE])
  })

  it('leaves a workspace that holds cards visible, and reports why', () => {
    const r = archiveSampleWorkspaces(d, CLIENT)
    expect(r.kept).toEqual([
      { slug: BIG, cards: 8703 },
      { slug: SMALL, cards: 403 },
      { slug: LEFTOVER, cards: 1 },
    ])
    expect(archivedSlugs(d)).not.toContain(BIG)
    expect(archivedSlugs(d)).not.toContain(SMALL)
  })

  it('never touches the client workspace itself', () => {
    archiveSampleWorkspaces(d, CLIENT)
    expect(d.prepare('SELECT archived FROM workspaces WHERE slug = ?').get(CLIENT)).toEqual({ archived: 0 })
  })

  it('is idempotent — a re-run does not re-archive a workspace an operator restored', () => {
    archiveSampleWorkspaces(d, CLIENT)
    // Operator restores it by hand, and it starts carrying real work.
    d.prepare('UPDATE workspaces SET archived = 0 WHERE slug = ?').run(SAMPLE)
    d.prepare('INSERT INTO objectives (title, workspace) VALUES (?, ?)').run('real work', SAMPLE)
    expect(archiveSampleWorkspaces(d, CLIENT).archived).toEqual([])
    expect(archivedSlugs(d)).toEqual([])
  })

  it('still hides the samples on a genuinely fresh install', () => {
    const fresh = new Database(':memory:')
    fresh.exec(`
      CREATE TABLE workspaces (slug TEXT PRIMARY KEY, name TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE objectives (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, workspace TEXT NOT NULL);
      INSERT INTO workspaces (slug, name) VALUES ('acme','Acme'), ('seed-one','Seed One'), ('seed-two','Seed Two');
    `)
    expect(archiveSampleWorkspaces(fresh, 'acme').archived).toEqual(['seed-one', 'seed-two'])
    expect(archivedSlugs(fresh)).toEqual(['seed-one', 'seed-two'])
  })
})
