/**
 * workspace-merge: the merge must be total (nothing left behind), safe (nothing
 * the target already owns is overwritten) and reversible (nothing deleted).
 *
 * These run against hand-built databases that reproduce the exact shapes on the
 * live box — the `secrets` upsert key, the `user_workspaces` composite PK, and
 * `granola_processed_meetings`' un-ALTERable CHECK — because the whole point of
 * the tool is what it does to an EXISTING database, not a pristine one.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import {
  listWorkspaceColumns,
  checkConstraintRejects,
  collidingKeySets,
  findConflicts,
  planMerge,
  planMemberships,
  unionMembership,
  applyMerge,
  unarchiveWorkspace,
} from './workspace-merge.js'

function db(): Database.Database {
  const d = new Database(':memory:')
  d.exec(`
    CREATE TABLE workspaces (
      slug TEXT PRIMARY KEY, name TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL);
    CREATE TABLE user_workspaces (
      user_id INTEGER NOT NULL, workspace TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member',
      can_use_assistant INTEGER NOT NULL DEFAULT 1,
      objective_visibility TEXT NOT NULL DEFAULT 'own',
      PRIMARY KEY (user_id, workspace)
    );
    CREATE TABLE objectives (
      id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL,
      workspace TEXT NOT NULL, parent_id INTEGER, assigned_user_id INTEGER, status TEXT
    );
    CREATE TABLE secrets (
      id INTEGER PRIMARY KEY AUTOINCREMENT, scope_type TEXT NOT NULL,
      workspace TEXT NOT NULL DEFAULT '', user_id INTEGER NOT NULL DEFAULT 0,
      key TEXT NOT NULL, value_encrypted TEXT NOT NULL,
      UNIQUE(scope_type, workspace, user_id, key)
    );
    CREATE TABLE granola_processed_meetings (
      id TEXT PRIMARY KEY, title TEXT,
      workspace TEXT CHECK(workspace IN ('example','example-project','personal','operator','example2','example5'))
    );
    CREATE TABLE token_usage (id INTEGER PRIMARY KEY AUTOINCREMENT, workspace TEXT NOT NULL, tokens INTEGER);
    CREATE TABLE no_workspace_here (id INTEGER PRIMARY KEY, note TEXT);
    INSERT INTO workspaces (slug, name) VALUES ('example','Example'), ('your-org','Example Growth'), ('operationkit','Operation Kit');
    INSERT INTO users (id, username) VALUES (1,'operator'), (2,'jess'), (3,'sam');
  `)
  return d
}

describe('discovery', () => {
  it('finds every slug column by introspection and skips the registry + memberships', () => {
    const d = db()
    const refs = listWorkspaceColumns(d).map(r => `${r.table}.${r.column}`)
    expect(refs).toContain('objectives.workspace')
    expect(refs).toContain('secrets.workspace')
    expect(refs).toContain('token_usage.workspace')
    expect(refs).toContain('granola_processed_meetings.workspace')
    // The registry row and memberships are handled explicitly, never swept.
    expect(refs).not.toContain('workspaces.slug')
    expect(refs.some(r => r.startsWith('user_workspaces.'))).toBe(false)
    // A table with no slug column is not invented.
    expect(refs.some(r => r.startsWith('no_workspace_here.'))).toBe(false)
  })

  it('picks up a table added after the tool was written', () => {
    const d = db()
    d.exec('CREATE TABLE brand_new_feature (id INTEGER PRIMARY KEY, workspace TEXT NOT NULL)')
    expect(listWorkspaceColumns(d).map(r => r.table)).toContain('brand_new_feature')
  })
})

describe('CHECK constraint detection', () => {
  it('reports a CHECK that excludes the target and leaves the rows alone', () => {
    const d = db()
    expect(checkConstraintRejects(d, 'granola_processed_meetings', 'workspace', 'your-org')).toBe(true)
    expect(checkConstraintRejects(d, 'granola_processed_meetings', 'workspace', 'example2')).toBe(false)
    expect(checkConstraintRejects(d, 'objectives', 'workspace', 'your-org')).toBe(false)

    d.prepare('INSERT INTO granola_processed_meetings (id, title, workspace) VALUES (?,?,?)').run('m1', 'Q2', 'example')
    d.prepare("INSERT INTO objectives (title, workspace) VALUES ('c','example')").run()
    const plan = planMerge(d, 'example', 'your-org')
    const g = plan.tables.find(t => t.table === 'granola_processed_meetings')!
    expect(g.blocked).toBe('check-constraint')
    expect(g.rows).toBe(1)
    expect(g.moving).toBe(0)
    expect(plan.warnings.join(' ')).toMatch(/CHECK.*excludes 'your-org'/)

    applyMerge(d, 'example', 'your-org')
    // Still on the source, and the merge did not abort.
    expect(d.prepare("SELECT workspace FROM granola_processed_meetings WHERE id='m1'").get())
      .toEqual({ workspace: 'example' })
  })
})

describe('conflicts: the target always wins and is never modified', () => {
  let d: Database.Database
  beforeEach(() => {
    d = db()
    const s = d.prepare('INSERT INTO secrets (scope_type, workspace, user_id, key, value_encrypted) VALUES (?,?,?,?,?)')
    s.run('workspace', 'example', 0, 'SHARED_KEY', 'enc:example-old')
    s.run('workspace', 'your-org', 0, 'SHARED_KEY', 'enc:growth-newer')
    s.run('workspace', 'example', 0, 'ONLY_ON_EXAMPLE', 'enc:example-only')
    // Per-user connector scope: same key, two different users — must stay apart.
    s.run('workspace_user', 'example', 1, 'GOOGLE_REFRESH_TOKEN', 'enc:operator')
    s.run('workspace_user', 'example', 2, 'GOOGLE_REFRESH_TOKEN', 'enc:jess')
    d.prepare("INSERT INTO objectives (title, workspace) VALUES ('c','example')").run()
  })

  it('names the colliding key without naming the value', () => {
    expect(collidingKeySets(d, 'secrets', 'workspace').some(k => k.includes('key'))).toBe(true)
    const keys = findConflicts(d, 'secrets', 'workspace', 'example', 'your-org', collidingKeySets(d, 'secrets', 'workspace'))
    expect(keys).toHaveLength(1)
    expect(keys[0]).toContain('SHARED_KEY')
    expect(keys.join(' ')).not.toContain('enc:')
  })

  it('moves the non-colliding secret, leaves the collision on the source, never overwrites', () => {
    applyMerge(d, 'example', 'your-org')
    const get = (ws: string, key: string, uid = 0) =>
      d.prepare('SELECT value_encrypted v FROM secrets WHERE workspace=? AND key=? AND user_id=?').get(ws, key, uid) as
        | { v: string }
        | undefined
    // The target's newer value is untouched...
    expect(get('your-org', 'SHARED_KEY')?.v).toBe('enc:growth-newer')
    // ...and the source's loser is still there, in place, for Operator to inspect.
    expect(get('example', 'SHARED_KEY')?.v).toBe('enc:example-old')
    // The one with no counterpart simply moves.
    expect(get('your-org', 'ONLY_ON_EXAMPLE')?.v).toBe('enc:example-only')
    expect(get('example', 'ONLY_ON_EXAMPLE')).toBeUndefined()
  })

  it('keeps per-user connector rows isolated across the move', () => {
    applyMerge(d, 'example', 'your-org')
    const rows = d
      .prepare("SELECT user_id, value_encrypted v FROM secrets WHERE workspace='your-org' AND key='GOOGLE_REFRESH_TOKEN' ORDER BY user_id")
      .all()
    expect(rows).toEqual([
      { user_id: 1, v: 'enc:operator' },
      { user_id: 2, v: 'enc:jess' },
    ])
  })
})

describe('cards move whole, keeping identity', () => {
  it('preserves ids, parent edges and assignments, and heals a cross-workspace edge', () => {
    const d = db()
    const ins = d.prepare('INSERT INTO objectives (id, title, workspace, parent_id, assigned_user_id, status) VALUES (?,?,?,?,?,?)')
    ins.run(900199, 'OpKit Outreach', 'your-org', null, 1, 'review')
    ins.run(900205, 'Worker: Rank connections', 'example', 900199, 2, 'done')
    ins.run(1, 'ancient card', 'example', null, null, 'done')
    ins.run(710312, 'Linear', 'operationkit', null, null, 'done')
    ins.run(710314, 'Worker: purge Linear', 'example', 710312, null, 'done')

    const plan = planMerge(d, 'example', 'your-org')
    expect(plan.objectives).toEqual({ from: 3, to: 1, expectedAfter: 4 })

    const report = applyMerge(d, 'example', 'your-org')
    expect(report.verified).toEqual({ from: 0, to: 4, ok: true })

    const rows = d.prepare('SELECT id, workspace, parent_id, assigned_user_id, status FROM objectives ORDER BY id').all()
    expect(rows).toEqual([
      { id: 1, workspace: 'your-org', parent_id: null, assigned_user_id: null, status: 'done' },
      { id: 710312, workspace: 'operationkit', parent_id: null, assigned_user_id: null, status: 'done' },
      { id: 710314, workspace: 'your-org', parent_id: 710312, assigned_user_id: null, status: 'done' },
      { id: 900199, workspace: 'your-org', parent_id: null, assigned_user_id: 1, status: 'review' },
      { id: 900205, workspace: 'your-org', parent_id: 900199, assigned_user_id: 2, status: 'done' },
    ])
    // operationkit is untouched by a merge it is not part of.
    expect(d.prepare("SELECT COUNT(*) n FROM objectives WHERE workspace='operationkit'").get()).toEqual({ n: 1 })
  })
})

describe('memberships are a union, and nobody loses access', () => {
  it('raises the target row to the most permissive of the two', () => {
    const src = { user_id: 1, workspace: 'example', role: 'admin', can_use_assistant: 1, objective_visibility: 'all' }
    const weak = { user_id: 1, workspace: 'your-org', role: 'member', can_use_assistant: 0, objective_visibility: 'own' }
    expect(unionMembership(src, weak)).toEqual({ role: 'admin', can_use_assistant: 1, objective_visibility: 'all' })
    // Already dominant → no write.
    expect(unionMembership(weak, src)).toBeNull()
  })

  it('adds missing members, upgrades overlapping ones, and clears the source roster', () => {
    const d = db()
    const m = d.prepare('INSERT INTO user_workspaces (user_id, workspace, role, can_use_assistant, objective_visibility) VALUES (?,?,?,?,?)')
    m.run(1, 'example', 'admin', 1, 'all')
    m.run(1, 'your-org', 'member', 0, 'own')
    m.run(2, 'example', 'member', 1, 'own')
    m.run(3, 'your-org', 'admin', 1, 'all')
    d.prepare("INSERT INTO objectives (title, workspace) VALUES ('c','example')").run()

    expect(planMemberships(d, 'example', 'your-org')).toEqual({ added: [2], merged: [1], upgraded: [1] })

    applyMerge(d, 'example', 'your-org')
    expect(d.prepare('SELECT user_id, role, can_use_assistant, objective_visibility FROM user_workspaces WHERE workspace=? ORDER BY user_id').all('your-org'))
      .toEqual([
        { user_id: 1, role: 'admin', can_use_assistant: 1, objective_visibility: 'all' },
        { user_id: 2, role: 'member', can_use_assistant: 1, objective_visibility: 'own' },
        { user_id: 3, role: 'admin', can_use_assistant: 1, objective_visibility: 'all' },
      ])
    expect(d.prepare("SELECT COUNT(*) n FROM user_workspaces WHERE workspace='example'").get()).toEqual({ n: 0 })
  })
})

describe('archive, never delete; verify before archiving', () => {
  it('archives the source row and keeps it in the table', () => {
    const d = db()
    d.prepare("INSERT INTO objectives (title, workspace) VALUES ('c','example')").run()
    const r = applyMerge(d, 'example', 'your-org')
    expect(r.archivedSource).toBe(true)
    expect(d.prepare("SELECT archived FROM workspaces WHERE slug='example'").get()).toEqual({ archived: 1 })
    // Still present: deleting it would cascade integrations/repos and make the
    // boot-time orphan sweep destroy memberships.
    expect(d.prepare("SELECT COUNT(*) n FROM workspaces WHERE slug='example'").get()).toEqual({ n: 1 })
  })

  it('rolls the whole merge back when the counts do not reconcile', () => {
    const d = db()
    d.prepare("INSERT INTO objectives (title, workspace) VALUES ('c','example')").run()
    d.prepare("INSERT INTO secrets (scope_type, workspace, user_id, key, value_encrypted) VALUES ('workspace','example',0,'K','enc:v')").run()
    // A trigger that re-stamps a card back onto the source makes verification fail.
    d.exec(`CREATE TRIGGER sabotage AFTER UPDATE ON objectives BEGIN
              UPDATE objectives SET workspace='example' WHERE id=NEW.id; END;`)
    expect(() => applyMerge(d, 'example', 'your-org')).toThrow(/verification failed/)
    expect(d.prepare("SELECT COUNT(*) n FROM objectives WHERE workspace='example'").get()).toEqual({ n: 1 })
    expect(d.prepare("SELECT archived FROM workspaces WHERE slug='example'").get()).toEqual({ archived: 0 })
    // The secrets move is rolled back with it — all-or-nothing.
    expect(d.prepare("SELECT COUNT(*) n FROM secrets WHERE workspace='example'").get()).toEqual({ n: 1 })
  })

  it('refuses nonsense inputs', () => {
    const d = db()
    expect(() => planMerge(d, 'example', 'example')).toThrow(/into itself/)
    expect(() => planMerge(d, 'nope', 'your-org')).toThrow(/not in the workspaces table/)
    expect(() => planMerge(d, 'example', 'nope')).toThrow(/not in the workspaces table/)
  })
})

describe('unarchive is surgical', () => {
  it('flips archived and touches nothing else', () => {
    const d = db()
    d.prepare("UPDATE workspaces SET archived=1 WHERE slug='operationkit'").run()
    d.prepare("INSERT INTO objectives (id, title, workspace) VALUES (707149,'ok card','operationkit')").run()
    expect(unarchiveWorkspace(d, 'operationkit')).toEqual({ slug: 'operationkit', wasArchived: true })
    expect(d.prepare("SELECT archived FROM workspaces WHERE slug='operationkit'").get()).toEqual({ archived: 0 })
    expect(d.prepare("SELECT id, workspace FROM objectives WHERE id=707149").get())
      .toEqual({ id: 707149, workspace: 'operationkit' })
    // Idempotent.
    expect(unarchiveWorkspace(d, 'operationkit')).toEqual({ slug: 'operationkit', wasArchived: false })
  })
})
