/**
 * Universal Development DDL + registry seed — extracted from db/index.ts
 * (behavior frozen). Called from the same initDb(). Probe-INSERT CHECK
 * rebuilds stay in db/index.ts.
 */
import type Database from 'better-sqlite3'

/**
 * Phase-0 DDL for Universal Development (schema doc §2.1-§2.5).
 *
 * Table creation order matters: `dev_items` references `workspaces(slug)` and
 * `objectives(id)`, and `changelog_entries.dev_item_id` references
 * `dev_items(id)` — so dev_items must exist before the ALTERs. Every statement
 * is `IF NOT EXISTS` or PRAGMA-guarded; calling this twice is a no-op.
 *
 * NOTE on `duplicate_of_id` / `objective_id` / `changelog_entry_id`: these are
 * real FKs with ON DELETE SET NULL, and `foreign_keys = ON` is set at :42.
 */
export function initDevelopmentSchema(db: Database.Database): void {
  // ── dev_items — the canonical item table (schema §2.1) ──────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS dev_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,

      -- platform scoping (reuses the existing CC registry)
      workspace TEXT NOT NULL REFERENCES workspaces(slug) ON DELETE CASCADE,
      project TEXT,                       -- matches workspace_repos.name; NULL = workspace-wide

      -- core content
      type TEXT NOT NULL DEFAULT 'bug'
        CHECK(type IN ('bug','feature','improvement','chore')),
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      steps_to_repro TEXT,

      -- triage (nullable until a human triages)
      status TEXT NOT NULL DEFAULT 'new'
        CHECK(status IN ('new','triaged','planned','in_progress','shipped','declined','duplicate')),
      severity TEXT
        CHECK(severity IS NULL OR severity IN ('blocker','high','medium','low')),
      impact INTEGER CHECK(impact IS NULL OR impact BETWEEN 1 AND 3),
      effort INTEGER CHECK(effort IS NULL OR effort BETWEEN 1 AND 3),
      priority_rank REAL,                 -- fractional; drag-reorder midpoint insert
      area TEXT,                          -- free-text subsystem tag e.g. 'checkout','dialer'
      duplicate_of_id INTEGER REFERENCES dev_items(id) ON DELETE SET NULL,

      -- submitter (opaque platform identity; NOT a CC users FK — schema D11)
      submitter_platform_user_id TEXT,
      submitter_email TEXT,
      submitter_label TEXT,
      submitted_via TEXT NOT NULL DEFAULT 'widget'
        CHECK(submitted_via IN ('widget','admin','api','import')),

      -- session enrichment: all 6 fields survive from both platforms
      posthog_session_id TEXT,
      posthog_replay_url TEXT,
      console_log TEXT,
      route_history TEXT NOT NULL DEFAULT '[]',  -- JSON array of {path, ts}
      client_meta TEXT NOT NULL DEFAULT '{}',    -- JSON {viewport, userAgent, url, role}
      screenshot_path TEXT,               -- storage object path, NOT a signed URL
      route TEXT,                         -- pathname at submit time (schema D5)
      loom_url TEXT,
      loom_transcript TEXT,

      -- work linkage
      objective_id INTEGER REFERENCES objectives(id) ON DELETE SET NULL,
      promoted_at TEXT,                   -- supersedes example2 bridged_at (D7)
      changelog_entry_id INTEGER,         -- -> changelog_entries(id); see note below

      -- provenance / lossless migration (schema §1.3)
      source_system TEXT NOT NULL DEFAULT 'native',
      source_table TEXT,
      source_id TEXT,
      legacy_ref TEXT NOT NULL DEFAULT '{}',

      -- audit
      triaged_by TEXT,
      triaged_at TEXT,
      closed_at TEXT,
      deleted_at TEXT,                    -- soft delete, mirrors objectives.deleted_at
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_dev_items_ws_status   ON dev_items(workspace, status);
    CREATE INDEX IF NOT EXISTS idx_dev_items_ws_project  ON dev_items(workspace, project);
    CREATE INDEX IF NOT EXISTS idx_dev_items_type        ON dev_items(type);
    CREATE INDEX IF NOT EXISTS idx_dev_items_objective   ON dev_items(objective_id);
    CREATE INDEX IF NOT EXISTS idx_dev_items_rank        ON dev_items(workspace, priority_rank);
    CREATE INDEX IF NOT EXISTS idx_dev_items_route       ON dev_items(workspace, route);
    CREATE UNIQUE INDEX IF NOT EXISTS uq_dev_items_source
      ON dev_items(source_system, source_id) WHERE source_id IS NOT NULL;
  `)
  // `changelog_entry_id` is declared WITHOUT an inline REFERENCES clause on
  // purpose: the link is bidirectional (changelog_entries.dev_item_id points
  // back), and SQLite resolves FK targets at statement time. Declaring both
  // directions as hard FKs makes the pair mutually undroppable and makes the
  // ALTER below order-dependent. The dev_items -> changelog_entries direction
  // is enforced in the service layer (dev-items.ts); the changelog_entries ->
  // dev_items direction below is a real FK, which is the one that matters
  // (it is the side that gets ON DELETE SET NULL).

  // ── dev_item_notes — threaded comments (schema §2.2) ────────────────────
  // Generalises WS `feedback_notes`; example2 gains the capability for free.
  // visibility='submitter' is the mechanism for "we fixed your bug" replies
  // surfacing back through the platform embed (P3).
  db.exec(`
    CREATE TABLE IF NOT EXISTS dev_item_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dev_item_id INTEGER NOT NULL REFERENCES dev_items(id) ON DELETE CASCADE,
      author_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,  -- CC user
      author_label TEXT,                  -- for platform-side or agent authors
      body TEXT NOT NULL,
      visibility TEXT NOT NULL DEFAULT 'internal'
        CHECK(visibility IN ('internal','submitter')),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_dev_item_notes_item ON dev_item_notes(dev_item_id, created_at);
  `)

  // ── dev_item_attachments (schema §2.3) ──────────────────────────────────
  // storage_provider is the zero-copy rule: existing WS/example2 screenshots stay
  // in their platform's `feedback-attachments` bucket and are ADDRESSED here,
  // never re-uploaded. New CC-native uploads default to 'local' disk storage
  // under /app/data/dev-item-uploads/<item_id>/ (mentor.ts multer pattern).
  db.exec(`
    CREATE TABLE IF NOT EXISTS dev_item_attachments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dev_item_id INTEGER NOT NULL REFERENCES dev_items(id) ON DELETE CASCADE,
      storage_provider TEXT NOT NULL DEFAULT 'local'
        CHECK(storage_provider IN ('local','supabase')),
      storage_bucket TEXT,
      storage_path TEXT NOT NULL,
      file_name TEXT,
      mime_type TEXT,
      size_bytes INTEGER,
      uploaded_by TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_dev_item_attachments_item ON dev_item_attachments(dev_item_id);
  `)

  // ── dev_item_prs (schema §2.4) ──────────────────────────────────────────
  // Scope discipline: this does NOT duplicate objective_prs. When an item has
  // an objective_id its PR list IS objective_prs (read through the join). This
  // table holds only PRs linked directly to an item with no objective — a
  // drive-by fix, or a `Fixes DEV-123` whose branch matched no objective. A2
  // unions the two and dedupes on (repo, pr_number); rows are never copied.
  db.exec(`
    CREATE TABLE IF NOT EXISTS dev_item_prs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dev_item_id INTEGER NOT NULL REFERENCES dev_items(id) ON DELETE CASCADE,
      repo TEXT NOT NULL,                 -- 'owner/repo', joins workspace_repos.github
      pr_number INTEGER NOT NULL,
      pr_url TEXT,
      state TEXT NOT NULL DEFAULT 'open' CHECK(state IN ('open','merged','closed')),
      link_source TEXT NOT NULL DEFAULT 'manual'
        CHECK(link_source IN ('manual','pr_body','objective')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(dev_item_id, repo, pr_number)
    );
    CREATE INDEX IF NOT EXISTS idx_dev_item_prs_repo_pr ON dev_item_prs(repo, pr_number);
  `)

  // ── dev_ingest_idempotency (api doc §3.6) ───────────────────────────────
  // 7-day replay window for the public ingest endpoints. The widget mints the
  // key client-side and keeps it in its localStorage queue, so a submit that
  // was queued during a CC outage and retried three times still produces
  // exactly ONE row. Same key + same body_sha256 -> the stored response
  // verbatim; same key + different body -> 409 conflict.
  db.exec(`
    CREATE TABLE IF NOT EXISTS dev_ingest_idempotency (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT NOT NULL,
      workspace TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      body_sha256 TEXT NOT NULL,
      response_json TEXT NOT NULL DEFAULT '{}',
      status INTEGER NOT NULL DEFAULT 201,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(workspace, endpoint, key)
    );
    CREATE INDEX IF NOT EXISTS idx_dev_ingest_idem_created ON dev_ingest_idempotency(created_at);
  `)
  // Sweep entries past the 7-day retention window on boot. Cheap (indexed) and
  // keeps the table from growing without bound; there is no cron for this.
  db.exec("DELETE FROM dev_ingest_idempotency WHERE created_at < datetime('now','-7 days')")

  // ── changelog_entries: 5 ADDITIVE columns (schema §2.5) ─────────────────
  // Purely additive to the live table at :2167-2190. Every pre-existing column
  // is untouched, so collectFromMergedPR(), the public feed at
  // routes/changelog.ts:204-207 and the HTML page at :210-229 keep working
  // unmodified. SQLite ADD COLUMN throws on a duplicate, so each is guarded by
  // a PRAGMA table_info check — the same idiom as the objectives columns above.
  const clCols = new Set(
    (db.prepare('PRAGMA table_info(changelog_entries)').all() as { name: string }[]).map(c => c.name),
  )
  if (!clCols.has('workspace')) {
    // FK-by-convention to workspaces.slug (no hard FK: legacy rows predate the
    // registry and must not fail the ALTER). This is the field that makes ONE
    // changelog table serve N platforms; `platform` stays the display label.
    db.exec('ALTER TABLE changelog_entries ADD COLUMN workspace TEXT')
  }
  if (!clCols.has('how_to')) {
    db.exec("ALTER TABLE changelog_entries ADD COLUMN how_to TEXT NOT NULL DEFAULT ''")
  }
  if (!clCols.has('published_at')) {
    db.exec('ALTER TABLE changelog_entries ADD COLUMN published_at TEXT')
  }
  if (!clCols.has('notified_at')) {
    db.exec('ALTER TABLE changelog_entries ADD COLUMN notified_at TEXT')
  }
  if (!clCols.has('dev_item_id')) {
    db.exec('ALTER TABLE changelog_entries ADD COLUMN dev_item_id INTEGER REFERENCES dev_items(id) ON DELETE SET NULL')
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_changelog_workspace_status
      ON changelog_entries(workspace, status, merged_at DESC);
  `)
  // Backfill: every pre-existing entry was collected from THIS repo's PRs, so
  // it belongs to the command-center workspace. Without this the new
  // workspace-filtered index is useless and CC's own changelog silently
  // disappears from any workspace-scoped query (migration §1.1). Idempotent —
  // only NULL rows are filled, so a re-boot writes nothing.
  db.exec("UPDATE changelog_entries SET workspace = 'command-center' WHERE workspace IS NULL")
}

/**
 * Platform registry seed for Universal Development (migration doc §1.2).
 *
 * VERIFIED at design time: `workspace_repos` and `workspace_integrations` are
 * both count(*)=0 in prod even though `workspaces` has rows — the Config-page
 * UI that writes them has never been used. So this is a real seed, not a
 * verification no-op: without it `dev_items.project` resolves to nothing and
 * the GitHub webhook cannot map a repo back to a workspace.
 *
 * Idempotency discipline, and the ONE deliberate deviation from migration §1.2:
 * the spec's `ON CONFLICT(workspace,kind) DO UPDATE SET config = excluded.config`
 * would re-run on EVERY boot (initDb is called at every server start) and would
 * therefore WIPE the minted `ingest_token_hash` and any admin-edited
 * allowed_origins every time the process restarts. We use INSERT OR IGNORE
 * instead: the seed establishes the row once, and the row is thereafter owned
 * by the admin/mint path (scripts/mint-dev-ingest-token.ts). Seeding is
 * "create if absent", never "reset to defaults".
 */
export function seedDevelopmentRegistry(db: Database.Database): void {
  // `example2` is NOT in the workspaces seed at :963-1091 (only example,
  // example-project, personal are), and `dev_items.workspace` is a hard FK to
  // workspaces(slug) with foreign_keys=ON. Seeding the repo/integration rows
  // below — and every later dev_items insert — would fail on a fresh DB
  // without this. INSERT OR IGNORE leaves a pre-existing prod row untouched.
  db.prepare(
    `INSERT OR IGNORE INTO workspaces (slug, name, short_label, badge_color, sort_order)
     VALUES (?, ?, ?, ?, ?)`,
  ).run('example2', 'Example3', 'EXAMPLE2', 'bg-emerald-500/20 text-emerald-400', 4)

  // workspace_repos — the join key between changelog_entries.repo, GitHub
  // webhook payloads (repository.full_name) and dev_items.project.
  //
  // `github` is CORRECTED against the live git remotes rather than copied from
  // migration §1.2: that doc says `example-org/example-project-platform`, but
  // `git remote get-url origin` in /home/operator/projects/example-project-platform
  // is `Example-Project/example-project-platform`. This column is matched verbatim
  // against the webhook's `repository.full_name`, so the doc's value would have
  // silently failed EVERY repo->workspace resolution. example2's
  // `EXAMPLE2/example3-platform` was verified the same way and does match.
  //
  // Idempotency note: `workspace_repos` has NO unique constraint (only the
  // `id` PK and a NON-unique index on `workspace` at :1060-1071), so
  // `INSERT OR IGNORE` — which migration §1.2 prescribes — has nothing to
  // conflict on and appends a duplicate pair on EVERY boot. Verified: rows grew
  // 2 -> 4 -> 6 across three initDb() calls. We therefore guard with an
  // existence check instead of adding a UNIQUE index, which would be a
  // constraint change to a pre-existing table (out of scope: additive only).
  const repoExists = db.prepare(
    'SELECT 1 FROM workspace_repos WHERE workspace = ? AND name = ? LIMIT 1',
  )
  const insertRepo = db.prepare(
    `INSERT INTO workspace_repos (workspace, name, github, repo_path, stack)
     VALUES (?, ?, ?, ?, ?)`,
  )
  const repos: Array<[string, string, string, string, string[]]> = [
    [
      'example',
      'command-center-infra',
      'your-org/command-center-infra',
      '/home/operator/projects/command-center-infra',
      ['react', 'express', 'sqlite'],
    ],
    [
      'example-project',
      'example-project-platform',
      'Example-Project/example-project-platform',
      '/home/operator/projects/example-project-platform',
      ['vite', 'react', 'supabase'],
    ],
    [
      'example2',
      'example3-platform',
      'EXAMPLE2/example3-platform',
      '/home/operator/projects/example3-platform',
      ['next', 'react', 'supabase'],
    ],
  ]
  for (const [workspace, name, github, repoPath, stack] of repos) {
    if (repoExists.get(workspace, name)) continue
    insertRepo.run(workspace, name, github, repoPath, JSON.stringify(stack))
  }

  // workspace_integrations kind='development' (schema §2.6 config shape).
  //
  // `ingest_token_hash` is seeded EMPTY on purpose — no raw token is ever
  // generated, stored or logged by initDb. A token is minted out-of-band by
  // scripts/mint-dev-ingest-token.ts, which prints the raw value ONCE and
  // persists only sha256(token) into this config. An empty hash means the
  // middleware rejects every presented token (401), which is the correct
  // fail-closed default for a freshly seeded platform.
  //
  // `feed_public: false` for BOTH platforms is a deliberate decision for this
  // wave (overriding migration §1.2's `feed_public: true` for WS): the public
  // changelog feed is implemented and testable, but no platform's feed is
  // world-readable until someone explicitly opts in.
  const insertIntegration = db.prepare(
    `INSERT OR IGNORE INTO workspace_integrations (workspace, kind, config, status)
     VALUES (?, 'development', ?, ?)`,
  )
  const devConfigs: Array<[string, Record<string, unknown>, string]> = [
    [
      'example-project',
      {
        enabled: true,
        display_name: 'Example Project',
        repo: 'Example-Project/example-project-platform',
        ingest_token_hash: '',
        ingest_token_prefix: 'dvi_example-project_',
        allowed_origins: ['https://app.example.com'],
        allow_anonymous: false,
        feed_public: false,
        feed_categories: ['feature', 'improvement', 'fix'],
        attachment_storage: {
          provider: 'supabase',
          bucket: 'feedback-attachments',
          project_url: 'https://oftsdmfngqasevrfbwel.supabase.co',
        },
        notify: { provider: 'resend', from: 'notifications@notify.example.com' },
      },
      'connected',
    ],
    [
      'example2',
      {
        enabled: true,
        display_name: 'Example3',
        repo: 'EXAMPLE2/example3-platform',
        ingest_token_hash: '',
        ingest_token_prefix: 'dvi_example2_',
        allowed_origins: [],
        allow_anonymous: false,
        feed_public: false,
        feed_categories: ['feature', 'improvement', 'fix'],
        attachment_storage: {
          provider: 'supabase',
          bucket: 'feedback-attachments',
          project_url: 'https://gaomuvxsybezkmykrkfm.supabase.co',
        },
        notify: { provider: 'none' },
      },
      'connected',
    ],
  ]
  for (const [workspace, config, status] of devConfigs) {
    insertIntegration.run(workspace, JSON.stringify(config), status)
  }
}
