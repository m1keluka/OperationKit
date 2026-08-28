/**
 * Alerts, mentor threads, and assistant configs — extracted from db/index.ts
 * (behavior frozen). Additive CREATE TABLE + column ALTERs only.
 */
import type Database from 'better-sqlite3'

export function initMentorSchema(db: Database.Database): void {
  // Alerts — ingested from cron scripts and external monitors
  db.exec(`
    CREATE TABLE IF NOT EXISTS alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      severity TEXT NOT NULL DEFAULT 'normal' CHECK(severity IN ('normal', 'high', 'emergency')),
      source TEXT NOT NULL,
      title TEXT NOT NULL,
      message TEXT NOT NULL DEFAULT '',
      dedup_key TEXT,
      url TEXT,
      email_sent_at TEXT,
      acked_at TEXT,
      acked_by TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_alerts_acked ON alerts(acked_at);
    CREATE INDEX IF NOT EXISTS idx_alerts_created ON alerts(created_at);
    CREATE INDEX IF NOT EXISTS idx_alerts_dedup ON alerts(dedup_key);
  `)

  // Mentor chat tables. Phase 2.5 swap: each thread is backed by a Claude Code
  // subprocess (see services/mentor-session.ts), so the JSONL log on disk is the
  // source of truth for messages — no mentor_messages table.
  db.exec(`
    CREATE TABLE IF NOT EXISTS thread_folders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS mentor_threads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL DEFAULT 'Untitled',
      tags TEXT NOT NULL DEFAULT '[]',
      pinned INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0,
      account_id TEXT,
      session_id TEXT,
      last_active_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS mentor_summaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id INTEGER NOT NULL REFERENCES mentor_threads(id) ON DELETE CASCADE,
      content TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `)

  // Backfill columns for upgrades from the Phase 1 schema (Phase 1 had only
  // title/tags/pinned/archived/timestamps; the new columns landed in Phase 2.5).
  // SQLite ignores ADD COLUMN if the column already exists, but the wrapper
  // doesn't — we have to introspect.
  type MentorThreadColumn = { name: string }
  const mentorThreadCols = db.prepare('PRAGMA table_info(mentor_threads)').all() as MentorThreadColumn[]
  const haveMentorCols = new Set(mentorThreadCols.map(c => c.name))
  if (!haveMentorCols.has('account_id')) db.exec('ALTER TABLE mentor_threads ADD COLUMN account_id TEXT')
  if (!haveMentorCols.has('session_id')) db.exec('ALTER TABLE mentor_threads ADD COLUMN session_id TEXT')
  if (!haveMentorCols.has('last_active_at')) db.exec('ALTER TABLE mentor_threads ADD COLUMN last_active_at TEXT')
  if (!haveMentorCols.has('last_message_role')) db.exec('ALTER TABLE mentor_threads ADD COLUMN last_message_role TEXT')
  if (!haveMentorCols.has('done')) db.exec('ALTER TABLE mentor_threads ADD COLUMN done INTEGER NOT NULL DEFAULT 0')
  if (!haveMentorCols.has('workspace')) {
    db.exec("ALTER TABLE mentor_threads ADD COLUMN workspace TEXT NOT NULL DEFAULT 'example'")
  }
  if (!haveMentorCols.has('created_by')) {
    db.exec('ALTER TABLE mentor_threads ADD COLUMN created_by INTEGER REFERENCES users(id) ON DELETE SET NULL')
  }
  try {
    db.exec('ALTER TABLE mentor_threads ADD COLUMN folder_id INTEGER REFERENCES thread_folders(id) ON DELETE SET NULL')
  } catch {
    // column already exists — safe to ignore
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_mentor_threads_workspace ON mentor_threads(workspace)")

  // Phase 6: thread_folders gains a workspace column so folder visibility can
  // be scoped per workspace membership, matching mentor_threads.
  type FolderColumn = { name: string }
  const folderCols = db.prepare('PRAGMA table_info(thread_folders)').all() as FolderColumn[]
  const haveFolderCols = new Set(folderCols.map(c => c.name))
  if (!haveFolderCols.has('workspace')) {
    db.exec("ALTER TABLE thread_folders ADD COLUMN workspace TEXT NOT NULL DEFAULT 'example'")
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_thread_folders_workspace ON thread_folders(workspace)")

  // ── Personal Assistant configs (obj 701700, Phase 1) ──────────────────────
  // Per-(user, workspace) assistant config that replaces the hardcoded
  // single-user ("Mike"/Jarvis) path in services/mentor-session.ts. Grain
  // mirrors user_workspaces (PK user_id, workspace). Nested persona/autonomy/
  // arrays are stored as JSON-in-TEXT, matching mentor_threads.tags. Defaults
  // are fail-closed (read_only, no capabilities/connectors) at the column level;
  // the resolver's create-on-read writes a sensible confirm_external default.
  db.exec(`
    CREATE TABLE IF NOT EXISTS assistant_configs (
      user_id              INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      workspace            TEXT    NOT NULL,
      display_name         TEXT    NOT NULL DEFAULT 'Assistant',
      tagline              TEXT,
      system_prompt        TEXT    NOT NULL DEFAULT '',
      manual_source        TEXT,
      model                TEXT,
      autonomy             TEXT    NOT NULL DEFAULT '{"level":"read_only"}',
      enabled_capabilities TEXT    NOT NULL DEFAULT '[]',
      enabled_connectors   TEXT    NOT NULL DEFAULT '[]',
      connector_bindings   TEXT    NOT NULL DEFAULT '{}',
      knowledge_sources    TEXT    NOT NULL DEFAULT '[]',
      enabled              INTEGER NOT NULL DEFAULT 1,
      created_at           TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at           TEXT    NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, workspace)
    );
  `)
  // PRAGMA-guarded ALTERs for forward-compatible column additions (idempotent;
  // re-running init is safe). None yet beyond the initial create, but the guard
  // block matches the repo's mentor_threads upgrade pattern.
  type AssistantConfigColumn = { name: string }
  const assistantCfgCols = db.prepare('PRAGMA table_info(assistant_configs)').all() as AssistantConfigColumn[]
  const haveAssistantCfgCols = new Set(assistantCfgCols.map(c => c.name))
  if (!haveAssistantCfgCols.has('model')) db.exec('ALTER TABLE assistant_configs ADD COLUMN model TEXT')

  // Lossless seed for the assistant owner (obj 701700): reproduce TODAY's Jarvis
  // behavior through the generic config path so the owner's assistant is
  // preserved byte-equivalent in its rule-bearing content. Idempotent — only
  // seeds when the owner user exists AND has no config row yet. The persona
  // systemPrompt carries the assistant.md pointer + capability map + the
  // hardcoded google email (all now DATA, not code constants), matching the
  // pre-change buildJarvisDirective body in mentor-session.ts.
  try {
    const ownerUsername = process.env.MENTOR_TELEGRAM_OWNER_USERNAME || 'mike'
    const owner = db
      .prepare('SELECT id FROM users WHERE username = ?')
      .get(ownerUsername) as { id: number } | undefined
    if (owner) {
      const ownerWorkspace = 'example'
      const existing = db
        .prepare('SELECT 1 FROM assistant_configs WHERE user_id = ? AND workspace = ?')
        .get(owner.id, ownerWorkspace)
      if (!existing) {
        const ASSISTANT_AGENT_PATH = '/home/operator/ai-workspace/agents/assistant.md'
        const systemPrompt = [
          `Read ${ASSISTANT_AGENT_PATH} NOW as your complete operating manual. It is your`,
          'persona, capability map, and rules. It SUPERSEDES the mentor-workspace CLAUDE.md',
          'and any chief-of-staff persona — when they conflict, assistant.md wins.',
          '',
          'Capabilities (assistant.md documents these in full):',
          '- Google Workspace (Gmail/Calendar/Drive/Docs/Sheets/Slides) via the',
          '  `google-workspace` MCP server, already wired into this session. Always pass',
          '  user_google_email: "dev@example.com"; never start an OAuth flow.',
          '- The Command Center board internal API at http://localhost:3002/api/internal/...',
          '  (briefing, objectives read, objective create — create is confirmation-gated).',
          '- Vault retrieval over /home/operator/second-brain (active.md → index.md → kb_search).',
        ].join('\n')
        db.prepare(
          `INSERT INTO assistant_configs
             (user_id, workspace, display_name, tagline, system_prompt, manual_source,
              model, autonomy, enabled_capabilities, enabled_connectors, connector_bindings,
              knowledge_sources, enabled)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`
        ).run(
          owner.id,
          ownerWorkspace,
          'Jarvis',
          "Mike's personal admin assistant",
          systemPrompt,
          JSON.stringify({ id: 'assistant-md', kind: 'file', locator: ASSISTANT_AGENT_PATH, label: 'Operating manual', writable: false }),
          null,
          JSON.stringify({ level: 'confirm_external' }),
          JSON.stringify(['read-inbox', 'send-email', 'create-document', 'set-up-job', 'send-report']),
          JSON.stringify(['google-workspace']),
          JSON.stringify({ 'google-workspace': { identity: 'dev@example.com', credentialRef: 'env:GOOGLE_CREDENTIALS_DIR' } }),
          JSON.stringify([{ id: 'vault', kind: 'vault', locator: '/home/operator/second-brain', label: 'Second brain' }]),
        )
      }
    }
  } catch (err) {
    console.warn('[db] assistant owner seed skipped:', (err as Error).message)
  }

  // Drop the old mentor_messages table if it still exists from Phase 1. The
  // JSONL transcripts on disk now hold the conversation history.
  db.exec('DROP TABLE IF EXISTS mentor_messages')

}
