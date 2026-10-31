/**
 * Built-in agent chat (obj 719987). One ongoing chat per (person, agent); the
 * history lives only in this install's own database. Additive CREATE TABLEs only.
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
  `)
}
