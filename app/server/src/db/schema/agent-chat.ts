/**
 * Built-in agent chat (obj 719987). One ongoing chat per (person, agent); the
 * history lives only in this install's own database. Additive CREATE TABLEs only.
 *
 * Side threads / concurrent task lanes (obj 900370). A (person, bot) pair is no
 * longer ONE conversation: it is the MAIN conversation plus any number of named
 * side threads, each with its own history and its own model context, which can
 * run at the same time. The lane a message belongs to is
 * `agent_chat_messages.thread_id`:
 *
 *   thread_id IS NULL  ->  the MAIN conversation
 *   thread_id = N      ->  side thread N (a row in `agent_chat_threads`)
 *
 * NULL-means-main is the whole back-compat story: every row written before this
 * change, and every row `bot-thread-delivery` writes, already satisfies it, so
 * the main conversation keeps behaving exactly as it did. The thread table
 * deliberately mirrors `mentor_threads` (title / pinned / archived /
 * last_active_at) rather than inventing a third threading model for this install.
 */
import type Database from 'better-sqlite3'

export function initAgentChatSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      agent_slug TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'tool', 'error')),
      content TEXT NOT NULL DEFAULT '',
      provider TEXT,
      model TEXT,
      tool_name TEXT,
      meta TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_agent_chat_messages_thread ON agent_chat_messages(user_id, agent_slug, id);

    -- Side threads / concurrent task lanes (obj 900370). Column shape follows
    -- mentor_threads; the grain follows agent_chat_messages (person + bot).
    CREATE TABLE IF NOT EXISTS agent_chat_threads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      agent_slug TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT 'Untitled',
      pinned INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0,
      last_active_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_agent_chat_threads_owner ON agent_chat_threads(user_id, agent_slug, archived, id);

    CREATE TABLE IF NOT EXISTS agent_chat_attachments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      agent_slug TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT 'image',
      media_type TEXT NOT NULL,
      size INTEGER NOT NULL DEFAULT 0,
      bytes BLOB NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_agent_chat_attachments_msg ON agent_chat_attachments(message_id);

    CREATE TABLE IF NOT EXISTS agent_chat_drafts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      agent_slug TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('email', 'event')),
      connector TEXT NOT NULL DEFAULT 'demo',
      payload TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft', 'sent', 'added', 'discarded')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_agent_chat_drafts_user ON agent_chat_drafts(user_id, agent_slug);

    CREATE TABLE IF NOT EXISTS agent_chat_cards (
      objective_id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL,
      agent_slug TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_agent_chat_cards_user ON agent_chat_cards(user_id, agent_slug);

    -- Per-bot settings edited on the bot's page (obj 900671): an admin's
    -- override of the agent file's provider, model and tools. NULL = use the
    -- file's value; deleting the row resets the bot to its file.
    CREATE TABLE IF NOT EXISTS agent_chat_bot_config (
      slug TEXT PRIMARY KEY,
      provider TEXT,
      model TEXT,
      tools TEXT,
      all_tools INTEGER NOT NULL DEFAULT 0,
      updated_by TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- The bot's auto-generated About text (obj 900747): a model-written summary,
    -- how-to and example prompts, cached per bot and keyed by input_hash (a
    -- digest of the bot's instructions, tools and reach). A row whose hash no
    -- longer matches the bot is never shown; the rules-based About is shown
    -- until a fresh one is written. attempted_* records the last try so a
    -- failing model is not re-asked on every page load.
    CREATE TABLE IF NOT EXISTS agent_chat_bot_about (
      slug TEXT PRIMARY KEY,
      input_hash TEXT,
      summary TEXT NOT NULL DEFAULT '',
      how_to_use TEXT NOT NULL DEFAULT '',
      example_prompts TEXT NOT NULL DEFAULT '[]',
      model TEXT,
      generated_at TEXT,
      attempted_hash TEXT,
      attempted_at TEXT,
      last_error TEXT
    );

    -- High Agency (obj 900748): an admin's per-bot "wake me on a cadence and
    -- move my area forward" switch. Its own table, not columns on
    -- agent_chat_bot_config, because "Reset to file" deletes that row and must
    -- not silently switch a bot's wakes off. No row = off (the default), so no
    -- existing bot starts waking. The schedule itself is a managed routine
    -- (routine_id, named high-agency:<slug>) derived from this row.
    -- obj 900794: level (1-10) replaced times_per_day/first_hour as the
    -- schedule; those two columns stay only so an older row still loads.
    CREATE TABLE IF NOT EXISTS agent_chat_high_agency (
      slug TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 0,
      level INTEGER NOT NULL DEFAULT 1,
      times_per_day INTEGER NOT NULL DEFAULT 1,
      first_hour INTEGER NOT NULL DEFAULT 9,
      workspace TEXT,
      allow_cards INTEGER NOT NULL DEFAULT 1,
      allow_workflows INTEGER NOT NULL DEFAULT 1,
      run_as_user_id INTEGER,
      routine_id INTEGER,
      updated_by TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Per-bot workspace access (obj 900797). Bots stay global; each one gets an
    -- explicit list of the workspaces it may read, write and be woken in
    -- (services/agent-chat/bot-workspaces.ts). mode 'unrestricted' is written
    -- only by the one-time boot migration for bots that already existed, so
    -- they keep today's access until an admin restricts them. A bot with no row
    -- (added later) is restricted with an empty list: fail-closed. Its own
    -- tables, so "Reset to file" on the bot's model/tools never touches access.
    CREATE TABLE IF NOT EXISTS agent_chat_bot_access (
      slug TEXT PRIMARY KEY,
      mode TEXT NOT NULL DEFAULT 'restricted' CHECK (mode IN ('restricted', 'unrestricted')),
      updated_by TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS agent_chat_bot_workspaces (
      slug TEXT NOT NULL,
      workspace TEXT NOT NULL,
      granted_by TEXT,
      granted_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (slug, workspace)
    );

    -- The Bots sidebar (obj 900798): each person's OWN arrangement of the bot
    -- list. Sections are named groups ("Development", "Marketing") in the
    -- person's order; a bot sits in at most one of them (section_id NULL =
    -- "Other bots"). Pinned bots sit in the avatar rail at the top, in
    -- pin_position order. hidden = left out of the sidebar (still reachable by
    -- its URL and the "Hidden" filter). Unread = an assistant message newer than
    -- BOTH last_read_message_id and the person's own last message in that lane,
    -- or marked_unread = 1 ("Mark as unread"). No row = the defaults, which is
    -- why every existing person's sidebar looks unchanged until they arrange it.
    CREATE TABLE IF NOT EXISTS agent_chat_sidebar_sections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      collapsed INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_agent_chat_sidebar_sections_user ON agent_chat_sidebar_sections(user_id, position);

    CREATE TABLE IF NOT EXISTS agent_chat_sidebar_bots (
      user_id INTEGER NOT NULL,
      agent_slug TEXT NOT NULL,
      pinned INTEGER NOT NULL DEFAULT 0,
      pin_position INTEGER NOT NULL DEFAULT 0,
      section_id INTEGER REFERENCES agent_chat_sidebar_sections(id) ON DELETE SET NULL,
      hidden INTEGER NOT NULL DEFAULT 0,
      marked_unread INTEGER NOT NULL DEFAULT 0,
      last_read_message_id INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, agent_slug)
    );
  `)

  // An admin's display-name override for a bot (obj 900798, the sidebar's
  // Rename). NULL = the agent file's name; "Reset to file" clears it with the
  // rest of the row. PRAGMA-guarded like the thread_id columns below.
  const configCols = db.prepare('PRAGMA table_info(agent_chat_bot_config)').all() as { name: string }[]
  if (!configCols.some(c => c.name === 'name')) {
    db.exec('ALTER TABLE agent_chat_bot_config ADD COLUMN name TEXT')
  }

  // The side-thread column on the existing message table (obj 900370).
  // PRAGMA-guarded because the better-sqlite3 wrapper does NOT ignore a
  // duplicate ADD COLUMN — the same upgrade pattern mentor_threads uses.
  // Deliberately NULLable with no default: NULL IS the main conversation, so
  // every pre-existing row is already correctly placed and no backfill is
  // needed or wanted.
  type Column = { name: string }
  const messageCols = db.prepare('PRAGMA table_info(agent_chat_messages)').all() as Column[]
  if (!messageCols.some(c => c.name === 'thread_id')) {
    db.exec('ALTER TABLE agent_chat_messages ADD COLUMN thread_id INTEGER REFERENCES agent_chat_threads(id) ON DELETE CASCADE')
  }
  // The bytes follow their message into its lane. Carrying the lane on the
  // attachment row as well (rather than deriving it through message_id) is what
  // lets "clear THIS conversation" delete exactly one lane's images in one
  // statement, and keeps an orphaned attachment deletable at all.
  const attachmentCols = db.prepare('PRAGMA table_info(agent_chat_attachments)').all() as Column[]
  if (!attachmentCols.some(c => c.name === 'thread_id')) {
    db.exec('ALTER TABLE agent_chat_attachments ADD COLUMN thread_id INTEGER REFERENCES agent_chat_threads(id) ON DELETE CASCADE')
  }
  // obj 900794: High Agency levels 1-10 replace the 1/2/3/4/6 cadence. A row
  // saved under the cadence picker keeps at least as many wakes a day: the
  // lowest level whose runs/day (1, 4, 6, …) covers its old times_per_day.
  const haCols = db.prepare('PRAGMA table_info(agent_chat_high_agency)').all() as Column[]
  if (!haCols.some(c => c.name === 'level')) {
    db.exec('ALTER TABLE agent_chat_high_agency ADD COLUMN level INTEGER NOT NULL DEFAULT 1')
    db.exec('UPDATE agent_chat_high_agency SET level = CASE WHEN times_per_day <= 1 THEN 1 WHEN times_per_day <= 4 THEN 2 ELSE 3 END')
  }
  // The lane is part of every history read, so it belongs in the covering index.
  db.exec('CREATE INDEX IF NOT EXISTS idx_agent_chat_messages_lane ON agent_chat_messages(user_id, agent_slug, thread_id, id)')
}
