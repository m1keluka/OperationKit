/**
 * Workspaces, integrations, gmail/granola/contacts — extracted from db/index.ts
 * (behavior frozen). Additive CREATE TABLE + seed + column ALTERs only.
 */
import type Database from 'better-sqlite3'

export function initWorkspacesSchema(db: Database.Database): void {
  // Workspaces: promoted from the hard-coded `Workspace` literal union to a
  // real table so new businesses can be added without touching code.
  db.exec(`
    CREATE TABLE IF NOT EXISTS workspaces (
      slug TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      short_label TEXT,
      badge_color TEXT,
      vault_path TEXT,
      doc_read_roots TEXT NOT NULL DEFAULT '[]',
      doc_write_roots TEXT NOT NULL DEFAULT '[]',
      default_agent_pool TEXT NOT NULL DEFAULT '[]',
      archived INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `)

  // Seed the three workspaces that were hard-coded in shared/types.ts and
  // docs.ts. Idempotent: INSERT OR IGNORE skips rows that already exist.
  const seedWorkspaces = [
    {
      slug: 'example',
      name: 'Example',
      short_label: 'Example',
      badge_color: 'bg-blue-500/20 text-blue-400',
      vault_path: '/home/operator/second-brain/workspaces/example',
      doc_read_roots: [
        '/home/operator/second-brain/workspaces/example',
        '/home/operator/second-brain/shared',
        '/home/operator/ai-workspace/agents',
        '/home/operator/ai-workspace/skills',
      ],
      doc_write_roots: ['/home/operator/second-brain/workspaces/example'],
      default_agent_pool: ['cto', 'cmo', 'coo', 'cfo', 'general'],
      sort_order: 1,
    },
    {
      slug: 'example-project',
      name: 'Example Project',
      short_label: 'WS',
      badge_color: 'bg-green-500/20 text-green-400',
      vault_path: '/home/operator/second-brain/workspaces/example-project',
      doc_read_roots: [
        '/home/operator/second-brain/workspaces/example-project',
        '/home/operator/second-brain/shared',
        '/home/operator/ai-workspace/agents',
        '/home/operator/ai-workspace/skills',
      ],
      doc_write_roots: ['/home/operator/second-brain/workspaces/example-project'],
      default_agent_pool: ['cto', 'cmo', 'coo', 'cfo', 'general'],
      sort_order: 2,
    },
    {
      slug: 'personal',
      name: 'Mike Luka',
      short_label: 'ML',
      badge_color: 'bg-purple-500/20 text-purple-400',
      vault_path: '/home/operator/second-brain/workspaces/personal',
      doc_read_roots: [
        '/home/operator/second-brain/workspaces/personal',
        '/home/operator/second-brain/personal',
        '/home/operator/second-brain/shared',
        '/home/operator/ai-workspace/agents',
        '/home/operator/ai-workspace/skills',
      ],
      doc_write_roots: [
        '/home/operator/second-brain/workspaces/personal',
        '/home/operator/second-brain/personal',
      ],
      default_agent_pool: ['cto', 'cmo', 'coo', 'cfo', 'general'],
      sort_order: 3,
    },
    {
      // Shabo Dental Lab — a dental-lab client of Example. Modeled on the `example2`
      // client workspace (seeded separately in seedDevelopmentRegistry).
      slug: 'shabo-dl',
      name: 'Shabo Dental Lab',
      short_label: 'SHABO',
      badge_color: 'bg-teal-500/20 text-teal-400',
      vault_path: '/home/operator/second-brain/workspaces/shabo-dl',
      doc_read_roots: [
        '/home/operator/second-brain/workspaces/shabo-dl',
        '/home/operator/second-brain/shared',
        '/home/operator/ai-workspace/agents',
        '/home/operator/ai-workspace/skills',
      ],
      doc_write_roots: ['/home/operator/second-brain/workspaces/shabo-dl'],
      default_agent_pool: ['cto', 'cmo', 'coo', 'cfo', 'general'],
      sort_order: 5,
    },
  ]
  const insertWs = db.prepare(
    `INSERT OR IGNORE INTO workspaces
       (slug, name, short_label, badge_color, vault_path,
        doc_read_roots, doc_write_roots, default_agent_pool, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  for (const w of seedWorkspaces) {
    insertWs.run(
      w.slug,
      w.name,
      w.short_label,
      w.badge_color,
      w.vault_path,
      JSON.stringify(w.doc_read_roots),
      JSON.stringify(w.doc_write_roots),
      JSON.stringify(w.default_agent_pool),
      w.sort_order,
    )
  }

  // workspace_repos — admin-managed repos/projects attached to a workspace via
  // the Config page. Persisted separately from the legacy read-only
  // workspaces.json `projects[]` (which remain the seed roster). Cascades when
  // a workspace row is removed.
  db.exec(`
    CREATE TABLE IF NOT EXISTS workspace_repos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace TEXT NOT NULL REFERENCES workspaces(slug) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT,
      github TEXT,
      repo_path TEXT,
      stack TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_workspace_repos_workspace ON workspace_repos(workspace);
  `)
  const repoCols = new Set(
    (db.prepare('PRAGMA table_info(workspace_repos)').all() as { name: string }[]).map(c => c.name),
  )
  if (!repoCols.has('docs_path')) {
    db.exec("ALTER TABLE workspace_repos ADD COLUMN docs_path TEXT NOT NULL DEFAULT 'docs/product'")
  }
  if (!repoCols.has('docs_enabled')) {
    db.exec('ALTER TABLE workspace_repos ADD COLUMN docs_enabled INTEGER NOT NULL DEFAULT 1')
  }

  // workspace_integrations — per-workspace connections to external platforms
  // (GitHub org, PostHog project). `config` holds the RAW secrets (PAT / project
  // + personal API keys) as JSON and is SERVER-ONLY: it is never returned by any
  // API response (routes mask to a last-4 fingerprint) and never logged. One row
  // per (workspace, kind). Cascades when the workspace row is removed.
  db.exec(`
    CREATE TABLE IF NOT EXISTS workspace_integrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace TEXT NOT NULL REFERENCES workspaces(slug) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      config TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'disconnected',
      error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(workspace, kind)
    );
    CREATE INDEX IF NOT EXISTS idx_workspace_integrations_workspace ON workspace_integrations(workspace);
  `)

  // Gmail triage: stores per-message classification results
  db.exec(`
    CREATE TABLE IF NOT EXISTS gmail_triage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id TEXT NOT NULL UNIQUE,
      thread_id TEXT,
      from_address TEXT,
      subject TEXT,
      snippet TEXT,
      label TEXT NOT NULL CHECK(label IN ('live', 'junk')),
      classified_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_gmail_triage_label ON gmail_triage(label);
    CREATE INDEX IF NOT EXISTS idx_gmail_triage_classified_at ON gmail_triage(classified_at);
  `)

  // Granola tables: mirror what scripts/granola-ingest.ts already creates so the
  // server side can rely on them being present at startup (Phase 1 of personal CRM).
  db.exec(`
    CREATE TABLE IF NOT EXISTS granola_processed_meetings (
      id TEXT PRIMARY KEY,
      title TEXT,
      meeting_date TEXT,
      -- NOTE: this CHECK list must be kept in sync with scripts/granola-ingest.ts
      -- (validWorkspaces + its own copy of this DDL). SQLite cannot ALTER a
      -- CHECK constraint, so widening it here only affects FRESH databases; an
      -- existing prod DB keeps whatever list it was created with until the
      -- table is rebuilt.
      workspace TEXT CHECK(workspace IN ('example', 'example-project', 'personal', 'personal', 'example2', 'shabo-dl')),
      vault_path TEXT,
      processed_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS granola_action_items (
      id TEXT PRIMARY KEY,
      meeting_id TEXT REFERENCES granola_processed_meetings(id),
      status TEXT NOT NULL DEFAULT 'pending-review'
        CHECK(status IN ('pending-review', 'approved', 'dismissed')),
      title TEXT,
      description TEXT,
      workspace TEXT,
      priority INTEGER NOT NULL DEFAULT 2,
      owner TEXT,
      deadline TEXT,
      source_excerpt TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      reviewed_at TEXT
    );
  `)

  // related_contacts on granola_action_items: JSON array of contact vault_paths
  // populated by Phase 3 attendee resolver. Add idempotently.
  const aiCols = db.prepare('PRAGMA table_info(granola_action_items)').all() as { name: string }[]
  const aiNames = new Set(aiCols.map(c => c.name))
  if (!aiNames.has('related_contacts')) {
    db.exec("ALTER TABLE granola_action_items ADD COLUMN related_contacts TEXT NOT NULL DEFAULT '[]'")
  }

  // contacts_index: derived from vault contact frontmatter. Rebuilt on demand.
  // vault_path is the canonical PK so the same file in two scans always lands
  // on the same row.
  db.exec(`
    CREATE TABLE IF NOT EXISTS contacts_index (
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
    CREATE INDEX IF NOT EXISTS idx_contacts_next_touchpoint ON contacts_index(next_touchpoint);
    CREATE INDEX IF NOT EXISTS idx_contacts_email ON contacts_index(email);
    CREATE INDEX IF NOT EXISTS idx_contacts_name ON contacts_index(name);
  `)

  // Phase 8: additive hygiene migrations. All idempotent — guarded by introspection.

  // users.email — nullable column for invites / display. Existing rows stay NULL
  // until backfilled out-of-band; admin-users CRUD will write it for new users.
  const userCols = db.prepare('PRAGMA table_info(users)').all() as { name: string }[]
  const userColNames = new Set(userCols.map(c => c.name))
  if (!userColNames.has('email')) {
    db.exec('ALTER TABLE users ADD COLUMN email TEXT')
  }
  // Per-user Command Center API key (Agent API / Grok Bot). Hash only — the
  // plaintext is shown once in Settings → You and never stored.
  if (!userColNames.has('api_token_hash')) {
    db.exec('ALTER TABLE users ADD COLUMN api_token_hash TEXT')
  }
  if (!userColNames.has('api_token_last4')) {
    db.exec('ALTER TABLE users ADD COLUMN api_token_last4 TEXT')
  }
  if (!userColNames.has('api_token_created_at')) {
    db.exec('ALTER TABLE users ADD COLUMN api_token_created_at TEXT')
  }
  db.exec(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_users_api_token_hash ON users(api_token_hash) WHERE api_token_hash IS NOT NULL',
  )

  // Backfill NULL created_by on legacy rows (pre-Phase-2 inserts). Assigns to
  // first admin so subsequent ownership checks resolve cleanly. Idempotent.
  const firstAdmin = db
    .prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1")
    .get() as { id: number } | undefined
  if (firstAdmin) {
    db.prepare('UPDATE objectives SET created_by = ? WHERE created_by IS NULL')
      .run(firstAdmin.id)
    db.prepare('UPDATE mentor_threads SET created_by = ? WHERE created_by IS NULL')
      .run(firstAdmin.id)
  }

  // Delete orphan user_workspaces rows that reference a workspace slug no
  // longer present in the `workspaces` table (e.g. pre-rename "personal" rows
  // left behind after the personal rename). Members can never see these — they
  // just clutter membership queries and confuse the admin UI.
  db.exec(`
    DELETE FROM user_workspaces
    WHERE workspace NOT IN (SELECT slug FROM workspaces)
  `)

}
