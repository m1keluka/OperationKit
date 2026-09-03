/**
 * Agent registry: seeding, idempotency, and the agent_context CHECK drop.
 *
 * These exercise initAgentsSchema against a hand-built DB carrying the OLD
 * 8-value CHECK — the exact shape a pre-refactor install has on disk — rather
 * than against a fresh schema, because the whole point of the migration is what
 * it does to an existing database.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  initAgentsSchema,
  objectivesHasAgentContextCheck,
  loadAgentSeed,
  resolveAgentSeedPath,
  DEFAULT_AGENT_SEED,
} from './agents.js'

const OLD_CHECK =
  "agent_context TEXT NOT NULL DEFAULT 'general' CHECK(agent_context IN ('cto', 'cmo', 'coo', 'cfo', 'general', 'designer', 'hr', 'general-counsel'))"

const tmpFiles: string[] = []
function tmpDb(): Database.Database {
  const f = path.join(os.tmpdir(), `cc-agents-test-${process.pid}-${tmpFiles.length}.db`)
  tmpFiles.push(f)
  return new Database(f)
}
afterAll(() => { for (const f of tmpFiles) { try { fs.unlinkSync(f) } catch { /* ignore */ } } })

/** A DB shaped like a pre-refactor install: objectives with the 8-value CHECK,
 *  several indexes, and rows spanning both executive and routing-only slugs. */
function legacyDb(): Database.Database {
  const db = tmpDb()
  db.exec(`
    CREATE TABLE objectives (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'queue',
      ${OLD_CHECK},
      workspace TEXT NOT NULL DEFAULT 'acme',
      deleted_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX idx_objectives_status ON objectives(status);
    CREATE INDEX idx_objectives_workspace ON objectives(workspace);
    CREATE INDEX idx_objectives_title ON objectives(title);
    CREATE INDEX idx_obj_active ON objectives(created_at) WHERE status NOT IN ('done', 'cancelled');
  `)
  const ins = db.prepare('INSERT INTO objectives (title, agent_context) VALUES (?, ?)')
  ins.run('a cto card', 'cto')
  ins.run('a general card', 'general')
  ins.run('another cto card', 'cto')
  ins.run('a designer card', 'designer')
  return db
}

describe('agent seed loading', () => {
  it('resolves a seed file and every default row carries a workdir + a label', () => {
    const seedPath = resolveAgentSeedPath()
    expect(seedPath).toBeTruthy()
    const seed = loadAgentSeed()
    expect(seed.length).toBeGreaterThan(0)
    for (const row of seed) {
      expect(row.slug).toBeTruthy()
      expect(row.label).toBeTruthy()
      expect(['projects', 'workspace', 'home', 'custom']).toContain(row.workdir_kind)
      expect(['executive', 'routing-only']).toContain(row.kind)
    }
  })

  it('SEED_AGENTS_PATH takes precedence over the on-disk seeds', () => {
    const f = path.join(os.tmpdir(), `cc-agents-seed-${process.pid}.json`)
    tmpFiles.push(f)
    fs.writeFileSync(f, JSON.stringify([{ slug: 'zzz-custom', label: 'Custom' }]))
    const prev = process.env.SEED_AGENTS_PATH
    process.env.SEED_AGENTS_PATH = f
    try {
      expect(resolveAgentSeedPath()).toBe(f)
      expect(loadAgentSeed().map(r => r.slug)).toEqual(['zzz-custom'])
    } finally {
      if (prev === undefined) delete process.env.SEED_AGENTS_PATH
      else process.env.SEED_AGENTS_PATH = prev
    }
  })

  it('falls back to the five generic defaults when the seed file is unusable', () => {
    const f = path.join(os.tmpdir(), `cc-agents-bad-${process.pid}.json`)
    tmpFiles.push(f)
    fs.writeFileSync(f, 'not json at all')
    const prev = process.env.SEED_AGENTS_PATH
    process.env.SEED_AGENTS_PATH = f
    try {
      expect(loadAgentSeed()).toEqual(DEFAULT_AGENT_SEED)
    } finally {
      if (prev === undefined) delete process.env.SEED_AGENTS_PATH
      else process.env.SEED_AGENTS_PATH = prev
    }
    expect(DEFAULT_AGENT_SEED.map(r => r.slug)).toEqual(['cto', 'cmo', 'coo', 'cfo', 'general'])
  })

  it('the TRACKED example seed contains only the five generic executives', () => {
    const example = path.resolve(__dirname, '..', '..', '..', 'seed.agents.example.json')
    const rows = JSON.parse(fs.readFileSync(example, 'utf-8')) as { slug: string }[]
    expect(rows.map(r => r.slug).sort()).toEqual(['cfo', 'cmo', 'coo', 'cto', 'general'])
  })
})

describe('initAgentsSchema — table + seeding', () => {
  let db: Database.Database
  beforeEach(() => { db = legacyDb() })

  it('creates the agents table with the audit §1 schema', () => {
    initAgentsSchema(db)
    const cols = (db.prepare('PRAGMA table_info(agents)').all() as { name: string }[]).map(c => c.name)
    expect(cols).toEqual([
      'slug', 'label', 'kind', 'assignable', 'prompt_file', 'workdir_kind',
      'workdir_path', 'mono', 'badge_hex', 'badge_tw', 'archived', 'sort_order',
      'created_at', 'updated_at',
    ])
    const idx = (db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='agents'").all() as { name: string }[]).map(i => i.name)
    expect(idx).toContain('idx_agents_sort')
  })

  it('seeds via INSERT OR IGNORE and never overwrites an operator edit', () => {
    initAgentsSchema(db)
    db.prepare("UPDATE agents SET label = 'MY CTO' WHERE slug = 'cto'").run()
    initAgentsSchema(db)
    expect((db.prepare("SELECT label FROM agents WHERE slug = 'cto'").get() as { label: string }).label).toBe('MY CTO')
  })

  it('re-running the migration is a no-op (row count and content stable)', () => {
    initAgentsSchema(db)
    const before = db.prepare('SELECT * FROM agents ORDER BY slug').all()
    const objBefore = db.prepare('SELECT * FROM objectives ORDER BY id').all()
    initAgentsSchema(db)
    initAgentsSchema(db)
    expect(db.prepare('SELECT * FROM agents ORDER BY slug').all()).toEqual(before)
    expect(db.prepare('SELECT * FROM objectives ORDER BY id').all()).toEqual(objBefore)
  })

  it('backfills any slug the board already uses so no card is orphaned', () => {
    // Pin the seed to the TRACKED five-row example so this asserts the backfill
    // and not whatever roster happens to sit on the host running the suite.
    const example = path.resolve(__dirname, '..', '..', '..', 'seed.agents.example.json')
    const prev = process.env.SEED_AGENTS_PATH
    process.env.SEED_AGENTS_PATH = example
    try {
      initAgentsSchema(db)
    } finally {
      if (prev === undefined) delete process.env.SEED_AGENTS_PATH
      else process.env.SEED_AGENTS_PATH = prev
    }
    const rows = db.prepare('SELECT slug, kind, sort_order FROM agents').all() as
      { slug: string; kind: string; sort_order: number }[]
    const slugs = rows.map(r => r.slug)
    // 'designer' is NOT one of the five seeds but IS on an existing card.
    expect(slugs).toContain('designer')
    const designer = rows.find(r => r.slug === 'designer')!
    expect(designer.kind).toBe('routing-only')
    expect(designer.sort_order).toBe(999)
    // Seeded rows keep their seeded metadata — the backfill runs after, so it loses.
    expect(rows.find(r => r.slug === 'cto')!.kind).toBe('executive')
    for (const row of db.prepare('SELECT DISTINCT agent_context AS c FROM objectives').all() as { c: string }[]) {
      expect(slugs).toContain(row.c)
    }
  })

  it('contains no DELETE — existing board rows can never be pruned by the migration', () => {
    const src = fs.readFileSync(path.resolve(__dirname, 'agents.ts'), 'utf-8')
    expect(/\bDELETE\s+FROM\b/i.test(src)).toBe(false)
    expect(/INSERT\s+OR\s+REPLACE/i.test(src)).toBe(false)
  })
})

describe('initAgentsSchema — dropping the objectives.agent_context CHECK', () => {
  it('a pre-migration DB rejects `rolodex`; after the migration it is insertable', () => {
    const db = legacyDb()
    expect(objectivesHasAgentContextCheck(db)).toBe(true)
    expect(() =>
      db.prepare('INSERT INTO objectives (title, agent_context) VALUES (?, ?)').run('pre', 'rolodex'),
    ).toThrow(/CHECK constraint failed/)

    initAgentsSchema(db)

    expect(objectivesHasAgentContextCheck(db)).toBe(false)
    db.prepare('INSERT INTO objectives (title, agent_context) VALUES (?, ?)').run('post', 'rolodex')
    expect(
      (db.prepare("SELECT agent_context AS c FROM objectives WHERE title = 'post'").get() as { c: string }).c,
    ).toBe('rolodex')
  })

  it('every pre-existing row survives with an identical agent_context', () => {
    const db = legacyDb()
    const before = db.prepare('SELECT id, title, agent_context FROM objectives ORDER BY id').all()
    const countsBefore = db.prepare('SELECT agent_context AS c, COUNT(*) AS n FROM objectives GROUP BY 1 ORDER BY 1').all()

    initAgentsSchema(db)

    expect(db.prepare('SELECT id, title, agent_context FROM objectives ORDER BY id').all()).toEqual(before)
    expect(db.prepare('SELECT agent_context AS c, COUNT(*) AS n FROM objectives GROUP BY 1 ORDER BY 1').all()).toEqual(countsBefore)
  })

  it('restores ALL indexes, not just idx_objectives_status (the latent rebuild defect)', () => {
    const db = legacyDb()
    const before = (db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='objectives' AND sql IS NOT NULL")
      .all() as { name: string }[]).map(i => i.name).sort()
    expect(before.length).toBe(4)

    initAgentsSchema(db)

    const after = (db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='objectives' AND sql IS NOT NULL")
      .all() as { name: string }[]).map(i => i.name).sort()
    expect(after).toEqual(before)
  })

  it('is a no-op on a DB that never had the CHECK (fresh install)', () => {
    const db = tmpDb()
    db.exec(`
      CREATE TABLE objectives (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queue',
        agent_context TEXT NOT NULL DEFAULT 'general',
        deleted_at TEXT
      );
    `)
    expect(objectivesHasAgentContextCheck(db)).toBe(false)
    initAgentsSchema(db)
    expect(objectivesHasAgentContextCheck(db)).toBe(false)
    expect((db.prepare('SELECT COUNT(*) AS n FROM agents').get() as { n: number }).n).toBeGreaterThan(0)
  })
})

describe('initAgentsSchema — the out-of-band legacy `agents` table (found on the LIVE board)', () => {
  /** Reproduces production: an unrelated 8-row `agents` table (id/name/role/…)
   *  created by a mis-targeted OperationKit migration, plus the two triggers that
   *  ABORT any objectives write whose agent_context is not in it. */
  function legacyOkitDb(): Database.Database {
    const db = legacyDb()
    db.exec(`
      CREATE TABLE agents (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        role        TEXT NOT NULL DEFAULT '',
        is_builtin  INTEGER NOT NULL DEFAULT 0
      );
      CREATE TRIGGER trg_objectives_agent_context_ins
        BEFORE INSERT ON objectives
        WHEN NEW.agent_context NOT IN (SELECT id FROM agents)
        BEGIN SELECT RAISE(ABORT, 'agent_context does not match any registered agent'); END;
      CREATE TRIGGER trg_objectives_agent_context_upd
        BEFORE UPDATE OF agent_context ON objectives
        WHEN NEW.agent_context NOT IN (SELECT id FROM agents)
        BEGIN SELECT RAISE(ABORT, 'agent_context does not match any registered agent'); END;
    `)
    const ins = db.prepare('INSERT INTO agents (id, name, role, is_builtin) VALUES (?, ?, ?, 1)')
    for (const [id, name] of [['cto', 'CTO'], ['cmo', 'CMO'], ['coo', 'COO'], ['cfo', 'CFO'],
                              ['general', 'General'], ['designer', 'Designer'],
                              ['hr', 'HR'], ['general-counsel', 'General Counsel'],
                              ['legacy-only', 'Legacy Only']]) {
      ins.run(id, name, '')
    }
    return db
  }

  it('the legacy trigger really does block an unregistered slug before migration', () => {
    const db = legacyOkitDb()
    expect(() =>
      db.prepare('INSERT INTO objectives (title, agent_context) VALUES (?, ?)').run('pre', 'rolodex'),
    ).toThrow()
  })

  it('renames the legacy table aside without losing a row, and drops the roster triggers', () => {
    const db = legacyOkitDb()
    initAgentsSchema(db)

    // Old rows preserved verbatim — nothing deleted.
    expect((db.prepare('SELECT COUNT(*) AS n FROM agents_legacy_okit').get() as { n: number }).n).toBe(9)
    // Triggers gone.
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='trigger' AND tbl_name='objectives'").get() as { n: number },
    ).toEqual({ n: 0 })
    // The real registry now occupies the `agents` name.
    const cols = (db.prepare('PRAGMA table_info(agents)').all() as { name: string }[]).map(c => c.name)
    expect(cols).toContain('slug')
    expect(cols).not.toContain('is_builtin')
  })

  it('adopts legacy slugs the seed does not cover, so no card can be orphaned', () => {
    const db = legacyOkitDb()
    initAgentsSchema(db)
    const slugs = (db.prepare('SELECT slug FROM agents').all() as { slug: string }[]).map(r => r.slug)
    expect(slugs).toContain('legacy-only')
    expect(slugs).toContain('hr')
  })

  it('after migration a previously-blocked slug inserts and existing rows survive', () => {
    const db = legacyOkitDb()
    const before = db.prepare('SELECT id, title, agent_context FROM objectives ORDER BY id').all()
    initAgentsSchema(db)
    db.prepare('INSERT INTO objectives (title, agent_context) VALUES (?, ?)').run('post', 'rolodex')
    expect(db.prepare('SELECT id, title, agent_context FROM objectives ORDER BY id LIMIT 4').all()).toEqual(before)
  })

  it('re-running against an already-migrated DB is a no-op', () => {
    const db = legacyOkitDb()
    initAgentsSchema(db)
    const agentsBefore = db.prepare('SELECT * FROM agents ORDER BY slug').all()
    const legacyBefore = db.prepare('SELECT * FROM agents_legacy_okit ORDER BY id').all()
    initAgentsSchema(db)
    expect(db.prepare('SELECT * FROM agents ORDER BY slug').all()).toEqual(agentsBefore)
    expect(db.prepare('SELECT * FROM agents_legacy_okit ORDER BY id').all()).toEqual(legacyBefore)
  })
})
