import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  parseFrontmatter,
  parseContactFile,
  computeNextTouchpoint,
  scanContactsDir,
  rebuildContactsIndex,
  seedLastInteractionFromMeetings,
  seedLastInteractionFromGmail,
  listContacts,
  getContactByPath,
  createContact,
  patchContact,
  applyExtractDiff,
  serializeFrontmatter,
  splitContactFile,
} from './contacts.js'

let vaultRoot: string
let db: Database.Database

/**
 * `YYYY-MM-DD`, n days before today. The seed-last-interaction suites below are
 * lookback-window sensitive (`sinceDays: 90`), so hardcoded calendar dates are a
 * time bomb: they pass when written and silently start failing the day they age
 * past the window. Three of them did exactly that (2026-05-10 / 2026-05-12 fell
 * outside 90 days on 2026-08-11) and turned CI red on every open PR. Anchor every
 * in-window fixture date to `now` instead.
 */
function daysAgo(n: number): string {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

function applySchema(d: Database.Database): void {
  d.exec(`
    CREATE TABLE contacts_index (
      vault_path        TEXT PRIMARY KEY,
      name              TEXT NOT NULL,
      email             TEXT,
      phone             TEXT,
      company           TEXT,
      role              TEXT,
      tags              TEXT NOT NULL DEFAULT '[]',
      follow_up_days    INTEGER,
      last_interaction  TEXT,
      next_touchpoint   TEXT,
      confidence        TEXT NOT NULL DEFAULT 'high',
      workspace         TEXT,
      updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE granola_processed_meetings (
      id TEXT PRIMARY KEY,
      title TEXT,
      meeting_date TEXT,
      workspace TEXT,
      vault_path TEXT,
      processed_at TEXT
    );
    CREATE TABLE gmail_triage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id TEXT UNIQUE,
      thread_id TEXT,
      from_address TEXT,
      subject TEXT,
      snippet TEXT,
      label TEXT,
      classified_at TEXT,
      created_at TEXT
    );
  `)
}

function writeFile(rel: string, content: string): void {
  const full = path.join(vaultRoot, rel)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, content)
}

beforeEach(() => {
  vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'contacts-test-'))
  db = new Database(':memory:')
  applySchema(db)
})

afterEach(() => {
  fs.rmSync(vaultRoot, { recursive: true, force: true })
  db.close()
})

describe('parseFrontmatter', () => {
  it('returns null when document has no frontmatter', () => {
    expect(parseFrontmatter('no frontmatter here')).toBeNull()
    expect(parseFrontmatter('# Just a heading\n\nbody')).toBeNull()
  })

  it('parses simple key/value pairs', () => {
    const fm = parseFrontmatter('---\nname: Alex\ntype: contact\n---\nbody')
    expect(fm).toEqual({ name: 'Alex', type: 'contact' })
  })

  it('strips wrapping double quotes from values', () => {
    const fm = parseFrontmatter('---\nname: "Alex Rivera"\n---\nbody')
    expect(fm?.name).toBe('Alex Rivera')
  })

  it('parses inline arrays', () => {
    const fm = parseFrontmatter('---\ntags: [a, b, c]\n---\nbody')
    expect(fm?.tags).toEqual(['a', 'b', 'c'])
  })

  it('parses block-style arrays', () => {
    const src = '---\nattendees:\n  - "Alice"\n  - "Bob"\n---\nbody'
    const fm = parseFrontmatter(src)
    expect(fm?.attendees).toEqual(['Alice', 'Bob'])
  })

  it('parses integers as numbers', () => {
    const fm = parseFrontmatter('---\nfollow_up_days: 30\n---\nbody')
    expect(fm?.follow_up_days).toBe(30)
  })

  it('parses dates as ISO strings', () => {
    const fm = parseFrontmatter('---\nlast_interaction: 2026-03-11\n---\nbody')
    expect(fm?.last_interaction).toBe('2026-03-11')
  })
})

describe('computeNextTouchpoint', () => {
  it('returns null when last_interaction is missing', () => {
    expect(computeNextTouchpoint(null, 30)).toBeNull()
  })

  it('returns null when follow_up_days is missing', () => {
    expect(computeNextTouchpoint('2026-05-01', null)).toBeNull()
  })

  it('adds days correctly', () => {
    expect(computeNextTouchpoint('2026-05-01', 30)).toBe('2026-05-31')
  })

  it('handles month rollover', () => {
    expect(computeNextTouchpoint('2026-05-20', 14)).toBe('2026-06-03')
  })

  it('handles year rollover', () => {
    expect(computeNextTouchpoint('2026-12-15', 30)).toBe('2027-01-14')
  })
})

describe('parseContactFile', () => {
  it('parses existing-schema contact file (no email/follow_up_days)', () => {
    writeFile('workspaces/example/contacts/alex.md',
      '---\ntype: contact\nname: "Alex Rivera"\ncategory: client\nlast_interaction: 2026-03-11\nworkspace: example\ntags: [example4, m-and-a]\n---\n## About\nbody')
    const row = parseContactFile(vaultRoot, path.join(vaultRoot, 'workspaces/example/contacts/alex.md'))
    expect(row).toMatchObject({
      vault_path: 'workspaces/example/contacts/alex.md',
      name: 'Alex Rivera',
      last_interaction: '2026-03-11',
      workspace: 'example',
      follow_up_days: null,
      next_touchpoint: null,
      email: null,
      confidence: 'high',
    })
    expect(JSON.parse(row!.tags)).toEqual(['example4', 'm-and-a'])
  })

  it('computes next_touchpoint when both fields present', () => {
    writeFile('contacts/sarah.md',
      '---\ntype: contact\nname: "Sarah"\nlast_interaction: 2026-05-01\nfollow_up_days: 30\nemail: sarah@example.com\n---')
    const row = parseContactFile(vaultRoot, path.join(vaultRoot, 'contacts/sarah.md'))
    expect(row?.next_touchpoint).toBe('2026-05-31')
    expect(row?.email).toBe('sarah@example.com')
  })

  it('returns null when type is not contact', () => {
    writeFile('contacts/note.md', '---\ntype: note\nname: "Foo"\n---')
    const row = parseContactFile(vaultRoot, path.join(vaultRoot, 'contacts/note.md'))
    expect(row).toBeNull()
  })

  it('returns null when name is missing', () => {
    writeFile('contacts/no-name.md', '---\ntype: contact\n---')
    const row = parseContactFile(vaultRoot, path.join(vaultRoot, 'contacts/no-name.md'))
    expect(row).toBeNull()
  })

  it('preserves confidence=low for stubs', () => {
    writeFile('personal/contacts/stub.md',
      '---\ntype: contact\nname: "Stub Person"\nconfidence: low\n---')
    const row = parseContactFile(vaultRoot, path.join(vaultRoot, 'personal/contacts/stub.md'))
    expect(row?.confidence).toBe('low')
  })
})

describe('scanContactsDir', () => {
  it('finds files across multiple contact directories', () => {
    writeFile('workspaces/example/contacts/a.md', '---\ntype: contact\nname: A\n---')
    writeFile('workspaces/example-project/contacts/b.md', '---\ntype: contact\nname: B\n---')
    writeFile('personal/contacts/c.md', '---\ntype: contact\nname: C\n---')
    writeFile('contacts/d.md', '---\ntype: contact\nname: D\n---')
    const found = scanContactsDir(vaultRoot)
    expect(found.map(r => r.name).sort()).toEqual(['A', 'B', 'C', 'D'])
  })

  it('ignores non-contact .md files in the same dirs', () => {
    writeFile('workspaces/example/contacts/c.md', '---\ntype: contact\nname: C\n---')
    writeFile('workspaces/example/contacts/readme.md', '# Not a contact')
    writeFile('workspaces/example/contacts/note.md', '---\ntype: note\nname: N\n---')
    const found = scanContactsDir(vaultRoot)
    expect(found.map(r => r.name)).toEqual(['C'])
  })
})

describe('rebuildContactsIndex', () => {
  it('inserts rows from disk into contacts_index', () => {
    writeFile('contacts/a.md', '---\ntype: contact\nname: Alice\nlast_interaction: 2026-05-01\nfollow_up_days: 7\n---')
    writeFile('contacts/b.md', '---\ntype: contact\nname: Bob\nemail: bob@x.com\n---')
    const result = rebuildContactsIndex(db, vaultRoot)
    expect(result.indexed).toBe(2)
    expect(result.errors).toEqual([])
    const rows = db.prepare('SELECT name, email, next_touchpoint FROM contacts_index ORDER BY name').all()
    expect(rows).toEqual([
      { name: 'Alice', email: null, next_touchpoint: '2026-05-08' },
      { name: 'Bob', email: 'bob@x.com', next_touchpoint: null },
    ])
  })

  it('replaces stale rows on re-run', () => {
    writeFile('contacts/a.md', '---\ntype: contact\nname: Alice\n---')
    rebuildContactsIndex(db, vaultRoot)
    fs.rmSync(path.join(vaultRoot, 'contacts/a.md'))
    writeFile('contacts/c.md', '---\ntype: contact\nname: Cara\n---')
    rebuildContactsIndex(db, vaultRoot)
    const rows = db.prepare('SELECT name FROM contacts_index').all() as { name: string }[]
    expect(rows.map(r => r.name)).toEqual(['Cara'])
  })

  it('supports dry-run (returns plan, writes nothing)', () => {
    writeFile('contacts/a.md', '---\ntype: contact\nname: Alice\n---')
    const result = rebuildContactsIndex(db, vaultRoot, { dryRun: true })
    expect(result.indexed).toBe(1)
    const count = (db.prepare('SELECT COUNT(*) as n FROM contacts_index').get() as { n: number }).n
    expect(count).toBe(0)
  })
})

describe('seedLastInteractionFromMeetings', () => {
  beforeEach(() => {
    // 21 indexed contacts (just two for the test, that's enough)
    db.prepare(
      'INSERT INTO contacts_index (vault_path, name, email) VALUES (?, ?, ?)'
    ).run('contacts/alice.md', 'Alice Chen', 'alice@example.com')
    db.prepare(
      'INSERT INTO contacts_index (vault_path, name, email) VALUES (?, ?, ?)'
    ).run('contacts/bob.md', 'Bob Smith', null)
  })

  function seedMeeting(rel: string, body: string, meetingDate: string): void {
    writeFile(rel, body)
    db.prepare(
      'INSERT INTO granola_processed_meetings (id, title, meeting_date, workspace, vault_path, processed_at) VALUES (?, ?, ?, ?, ?, datetime(\'now\'))'
    ).run(rel, 'Sync', meetingDate, 'example', rel)
  }

  it('bumps last_interaction when attendee email matches', () => {
    const d30 = daysAgo(30)
    seedMeeting(
      `workspaces/example/meetings/${d30}-sync.md`,
      `---\ntype: meeting\ndate: ${d30}\nattendees:\n  - "alice@example.com"\n---\nbody`,
      d30
    )
    const r = seedLastInteractionFromMeetings(db, vaultRoot, { sinceDays: 90 })
    expect(r.matches).toBe(1)
    const alice = db.prepare('SELECT last_interaction FROM contacts_index WHERE name = ?').get('Alice Chen') as { last_interaction: string }
    expect(alice.last_interaction).toBe(d30)
  })

  it('bumps last_interaction when attendee name matches (case-insensitive)', () => {
    const d25 = daysAgo(25)
    seedMeeting(
      `workspaces/example/meetings/${d25}-sync.md`,
      `---\ntype: meeting\ndate: ${d25}\nattendees:\n  - "bob smith"\n---\nbody`,
      d25
    )
    const r = seedLastInteractionFromMeetings(db, vaultRoot, { sinceDays: 90 })
    expect(r.matches).toBe(1)
    const bob = db.prepare('SELECT last_interaction FROM contacts_index WHERE name = ?').get('Bob Smith') as { last_interaction: string }
    expect(bob.last_interaction).toBe(d25)
  })

  it('keeps the most recent date when multiple meetings match', () => {
    const older = daysAgo(60)
    const newer = daysAgo(20)
    seedMeeting(`workspaces/example/meetings/${older}-old.md`,
      `---\ntype: meeting\ndate: ${older}\nattendees:\n  - "alice@example.com"\n---\nbody`, older)
    seedMeeting(`workspaces/example/meetings/${newer}-newer.md`,
      `---\ntype: meeting\ndate: ${newer}\nattendees:\n  - "alice@example.com"\n---\nbody`, newer)
    seedLastInteractionFromMeetings(db, vaultRoot, { sinceDays: 90 })
    const alice = db.prepare('SELECT last_interaction FROM contacts_index WHERE name = ?').get('Alice Chen') as { last_interaction: string }
    expect(alice.last_interaction).toBe(newer)
  })

  it('skips meetings outside the lookback window', () => {
    const oldDate = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
    seedMeeting('workspaces/example/meetings/old.md',
      `---\ntype: meeting\ndate: ${oldDate}\nattendees:\n  - "alice@example.com"\n---\nbody`, oldDate)
    const r = seedLastInteractionFromMeetings(db, vaultRoot, { sinceDays: 90 })
    expect(r.matches).toBe(0)
  })

  it('dry-run reports matches without writing', () => {
    const d30 = daysAgo(30)
    seedMeeting(`workspaces/example/meetings/${d30}-sync.md`,
      `---\ntype: meeting\ndate: ${d30}\nattendees:\n  - "alice@example.com"\n---\nbody`, d30)
    const r = seedLastInteractionFromMeetings(db, vaultRoot, { sinceDays: 90, dryRun: true })
    expect(r.matches).toBe(1)
    const alice = db.prepare('SELECT last_interaction FROM contacts_index WHERE name = ?').get('Alice Chen') as { last_interaction: string | null }
    expect(alice.last_interaction).toBeNull()
  })
})

// ── Phase 2 ──────────────────────────────────────────────────────────────────

describe('listContacts', () => {
  beforeEach(() => {
    // Seed three rows with distinct cadence + workspace + tag shapes
    db.prepare(
      'INSERT INTO contacts_index (vault_path, name, email, tags, follow_up_days, last_interaction, next_touchpoint, workspace) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run('workspaces/example/contacts/alex.md', 'Alex Rivera', 'alex@example4.com', JSON.stringify(['example4', 'm-and-a']), 30, '2026-03-11', '2026-04-10', 'example')
    db.prepare(
      'INSERT INTO contacts_index (vault_path, name, email, tags, follow_up_days, last_interaction, next_touchpoint, workspace) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run('personal/contacts/zane.md', 'Zane Smith', null, JSON.stringify(['friend']), 60, '2026-05-01', '2026-06-30', 'personal')
    db.prepare(
      'INSERT INTO contacts_index (vault_path, name, email, tags, follow_up_days, last_interaction, next_touchpoint, workspace) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run('workspaces/example/contacts/bea.md', 'Bea Lee', null, JSON.stringify(['friend', 'sf']), null, '2026-04-20', null, 'example')
  })

  it('default sort puts earliest next_touchpoint first, NULL last', () => {
    const rows = listContacts(db)
    expect(rows.map(r => r.name)).toEqual(['Alex Rivera', 'Zane Smith', 'Bea Lee'])
  })

  it('sort=name orders alphabetically (case-insensitive)', () => {
    const rows = listContacts(db, { sort: 'name' })
    expect(rows.map(r => r.name)).toEqual(['Alex Rivera', 'Bea Lee', 'Zane Smith'])
  })

  it('sort=recent puts the most recent interaction first', () => {
    const rows = listContacts(db, { sort: 'recent' })
    expect(rows.map(r => r.name)).toEqual(['Zane Smith', 'Bea Lee', 'Alex Rivera'])
  })

  it('filter by workspace narrows to one segment', () => {
    const rows = listContacts(db, { workspace: 'personal' })
    expect(rows).toHaveLength(1)
    expect(rows[0].name).toBe('Zane Smith')
  })

  it('filter by tag matches contacts whose JSON tags include it', () => {
    const rows = listContacts(db, { tag: 'friend' })
    expect(rows.map(r => r.name).sort()).toEqual(['Bea Lee', 'Zane Smith'])
  })

  it('tag filter is case-insensitive', () => {
    const rows = listContacts(db, { tag: 'EXAMPLE4' })
    expect(rows).toHaveLength(1)
    expect(rows[0].name).toBe('Alex Rivera')
  })

  it('parses tags from the JSON column into a string array', () => {
    const [alex] = listContacts(db, { tag: 'example4' })
    expect(alex.tags).toEqual(['example4', 'm-and-a'])
  })
})

describe('serializeFrontmatter', () => {
  it('round-trips simple key/value pairs through the parser', () => {
    const fm = { type: 'contact', name: 'Alice Chen', follow_up_days: 30 }
    const yaml = serializeFrontmatter(fm)
    const parsed = parseFrontmatter(`${yaml}\nbody here`)
    expect(parsed).toMatchObject(fm)
  })

  it('quotes strings with colons and renders arrays inline', () => {
    const fm = { name: 'Alex Rivera', tags: ['example4', 'm-and-a'], note: 'role: senior' }
    const yaml = serializeFrontmatter(fm)
    expect(yaml).toContain('tags: [example4, m-and-a]')
    expect(yaml).toContain('"role: senior"')
    const parsed = parseFrontmatter(`${yaml}\nbody`)
    expect(parsed?.tags).toEqual(['example4', 'm-and-a'])
    expect(parsed?.note).toBe('role: senior')
  })
})

describe('splitContactFile', () => {
  it('separates frontmatter from body', () => {
    const content = '---\ntype: contact\nname: "Alice"\n---\n\n## About\n\nBody text.\n'
    const { frontmatter, body } = splitContactFile(content)
    expect(frontmatter.type).toBe('contact')
    expect(frontmatter.name).toBe('Alice')
    expect(body.trim().startsWith('## About')).toBe(true)
  })

  it('returns full content as body when no frontmatter present', () => {
    const { frontmatter, body } = splitContactFile('just body')
    expect(frontmatter).toEqual({})
    expect(body).toBe('just body')
  })
})

describe('createContact', () => {
  it('writes a slugged .md file under workspaces/<ws>/contacts/ and indexes it', () => {
    const res = createContact(db, vaultRoot, {
      name: 'Casey Chen',
      workspace: 'example',
      email: 'casey@example.com',
      tags: ['investor', 'sf'],
      follow_up_days: 45,
    })
    expect(res.vault_path).toBe('workspaces/example/contacts/casey-chen.md')
    expect(fs.existsSync(res.absolute_path)).toBe(true)
    const row = getContactByPath(db, res.vault_path)
    expect(row?.name).toBe('Casey Chen')
    expect(row?.email).toBe('casey@example.com')
    expect(row?.tags).toEqual(['investor', 'sf'])
    expect(row?.follow_up_days).toBe(45)
    expect(row?.workspace).toBe('example')
  })

  it('routes personal workspace into personal/contacts/', () => {
    const res = createContact(db, vaultRoot, { name: 'Pat Jones', workspace: 'personal' })
    expect(res.vault_path).toBe('personal/contacts/pat-jones.md')
    expect(fs.existsSync(res.absolute_path)).toBe(true)
  })

  it('throws 409-style error when the file already exists', () => {
    createContact(db, vaultRoot, { name: 'Casey Chen', workspace: 'example' })
    expect(() => createContact(db, vaultRoot, { name: 'Casey Chen', workspace: 'example' }))
      .toThrow(/already exists/)
  })

  it('rejects empty name', () => {
    expect(() => createContact(db, vaultRoot, { name: '   ', workspace: 'example' }))
      .toThrow(/name is required/)
  })

  it('persists extra frontmatter keys the caller supplies', () => {
    const res = createContact(db, vaultRoot, {
      name: 'Drew',
      workspace: 'example',
      extra: { relationship: 'angel investor', category: 'client' },
    })
    const content = fs.readFileSync(res.absolute_path, 'utf-8')
    expect(content).toContain('relationship:')
    expect(content).toContain('category: client')
    // Round-trip: the writer + parser must agree on the values
    const parsed = parseFrontmatter(content)
    expect(parsed?.relationship).toBe('angel investor')
    expect(parsed?.category).toBe('client')
  })
})

describe('patchContact', () => {
  beforeEach(() => {
    createContact(db, vaultRoot, {
      name: 'Erin Park',
      workspace: 'example',
      email: 'erin@old.com',
      tags: ['founder'],
      follow_up_days: 30,
    })
  })

  it('merges scalar updates into the frontmatter and reindexes', () => {
    const updated = patchContact(db, vaultRoot, 'workspaces/example/contacts/erin-park.md', {
      email: 'erin@new.com',
      follow_up_days: 60,
    })
    expect(updated.email).toBe('erin@new.com')
    expect(updated.follow_up_days).toBe(60)
    const row = getContactByPath(db, 'workspaces/example/contacts/erin-park.md')
    expect(row?.email).toBe('erin@new.com')
  })

  it('replaces tags rather than concatenating', () => {
    patchContact(db, vaultRoot, 'workspaces/example/contacts/erin-park.md', {
      tags: ['investor'],
    })
    const row = getContactByPath(db, 'workspaces/example/contacts/erin-park.md')
    expect(row?.tags).toEqual(['investor'])
  })

  it('appends to the body when body_append is provided', () => {
    patchContact(db, vaultRoot, 'workspaces/example/contacts/erin-park.md', {
      body_append: '## 2026-05-30: lunch in SF',
    })
    const content = fs.readFileSync(
      path.join(vaultRoot, 'workspaces/example/contacts/erin-park.md'),
      'utf-8'
    )
    expect(content).toContain('## 2026-05-30: lunch in SF')
  })

  it('recomputes next_touchpoint when last_interaction changes', () => {
    patchContact(db, vaultRoot, 'workspaces/example/contacts/erin-park.md', {
      last_interaction: '2026-05-30',
    })
    const row = getContactByPath(db, 'workspaces/example/contacts/erin-park.md')
    expect(row?.last_interaction).toBe('2026-05-30')
    expect(row?.next_touchpoint).toBe('2026-06-29')
  })

  it('throws when the contact does not exist', () => {
    expect(() => patchContact(db, vaultRoot, 'workspaces/example/contacts/missing.md', { email: 'x@y.com' }))
      .toThrow(/not found/)
  })
})

describe('applyExtractDiff', () => {
  it('creates new contacts from the diff', () => {
    const res = applyExtractDiff(db, vaultRoot, {
      creates: [{
        name: 'Olivia Sun',
        workspace: 'personal',
        vault_path: 'personal/contacts/olivia-sun.md',
        frontmatter: { email: 'olivia@example.com', tags: ['sf', 'engineer'] },
        body: '## About\n\nMet at a dinner.',
        confidence: 'medium',
      }],
      updates: [],
    })
    expect(res.created).toHaveLength(1)
    expect(res.errors).toHaveLength(0)
    const row = getContactByPath(db, 'personal/contacts/olivia-sun.md')
    expect(row?.email).toBe('olivia@example.com')
    expect(row?.tags).toEqual(['sf', 'engineer'])
  })

  it('updates existing contacts referenced by vault_path', () => {
    createContact(db, vaultRoot, { name: 'Theo Wu', workspace: 'example', tags: ['vc'] })
    const res = applyExtractDiff(db, vaultRoot, {
      creates: [],
      updates: [{
        vault_path: 'workspaces/example/contacts/theo-wu.md',
        name: 'Theo Wu',
        patch: { email: 'theo@vc.com', tags: ['vc', 'lead-investor'] },
        confidence: 'high',
      }],
    })
    expect(res.updated).toHaveLength(1)
    const row = getContactByPath(db, 'workspaces/example/contacts/theo-wu.md')
    expect(row?.email).toBe('theo@vc.com')
    expect(row?.tags).toEqual(['vc', 'lead-investor'])
  })

  it('collects per-entry errors without aborting siblings', () => {
    createContact(db, vaultRoot, { name: 'Reggie', workspace: 'example' })
    const res = applyExtractDiff(db, vaultRoot, {
      creates: [
        // 1st: duplicate — should error
        { name: 'Reggie', workspace: 'example', vault_path: 'workspaces/example/contacts/reggie.md', frontmatter: {}, body: '', confidence: 'low' },
        // 2nd: fresh — should succeed
        { name: 'Quinn', workspace: 'example', vault_path: 'workspaces/example/contacts/quinn.md', frontmatter: {}, body: '', confidence: 'low' },
      ],
      updates: [
        // missing target — should error
        { vault_path: 'workspaces/example/contacts/ghost.md', name: 'Ghost', patch: { email: 'x@y.com' }, confidence: 'low' },
      ],
    })
    expect(res.created.map(r => r.vault_path)).toEqual(['workspaces/example/contacts/quinn.md'])
    expect(res.errors.length).toBe(2)
  })
})

describe('seedLastInteractionFromGmail', () => {
  beforeEach(() => {
    db.prepare(
      'INSERT INTO contacts_index (vault_path, name, email) VALUES (?, ?, ?)'
    ).run('contacts/alice.md', 'Alice Chen', 'alice@example.com')
  })

  function seedGmail(messageId: string, fromAddress: string, label: string, classifiedAt: string): void {
    db.prepare(
      "INSERT INTO gmail_triage (message_id, from_address, label, classified_at, created_at) VALUES (?, ?, ?, ?, datetime('now'))"
    ).run(messageId, fromAddress, label, classifiedAt)
  }

  it('bumps last_interaction from live label match', () => {
    const d30 = daysAgo(30)
    seedGmail('m1', 'alice@example.com', 'live', `${d30}T10:00:00Z`)
    const r = seedLastInteractionFromGmail(db, { sinceDays: 90 })
    expect(r.matches).toBe(1)
    const alice = db.prepare('SELECT last_interaction FROM contacts_index WHERE name = ?').get('Alice Chen') as { last_interaction: string }
    expect(alice.last_interaction).toBe(d30)
  })

  it('ignores junk-labeled emails', () => {
    seedGmail('m2', 'alice@example.com', 'junk', `${daysAgo(30)}T10:00:00Z`)
    const r = seedLastInteractionFromGmail(db, { sinceDays: 90 })
    expect(r.matches).toBe(0)
  })

  it('extracts email when from_address is "Name <email>"', () => {
    const d25 = daysAgo(25)
    seedGmail('m3', 'Alice Chen <alice@example.com>', 'live', `${d25}T10:00:00Z`)
    const r = seedLastInteractionFromGmail(db, { sinceDays: 90 })
    expect(r.matches).toBe(1)
    const alice = db.prepare('SELECT last_interaction FROM contacts_index WHERE name = ?').get('Alice Chen') as { last_interaction: string }
    expect(alice.last_interaction).toBe(d25)
  })

  it('does not overwrite a newer last_interaction with an older gmail event', () => {
    const recent = daysAgo(10)
    db.prepare('UPDATE contacts_index SET last_interaction = ? WHERE name = ?').run(recent, 'Alice Chen')
    seedGmail('m4', 'alice@example.com', 'live', `${daysAgo(30)}T10:00:00Z`)
    seedLastInteractionFromGmail(db, { sinceDays: 90 })
    const alice = db.prepare('SELECT last_interaction FROM contacts_index WHERE name = ?').get('Alice Chen') as { last_interaction: string }
    expect(alice.last_interaction).toBe(recent)
  })
})
