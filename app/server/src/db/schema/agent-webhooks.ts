/**
 * Agent-key webhooks (obj 719278) — wake the managing bot when a card it
 * created/started changes status, instead of it polling get_changes.
 *
 * agent_key_webhooks — one outbound target per agent key. The sender key is NOT
 * a column: it lives in the Secrets store (user scope, CC_AGENT_WEBHOOK_KEY_<id>)
 * and is never returned after save.
 *
 * agent_webhook_deliveries — the outbox + delivery log. `event_id` is UNIQUE, so
 * the dispatcher can re-scan the same objective_events rows (crash between
 * enqueue and cursor save) without ever sending one change twice. The payload
 * is stored as sent: card id/title/status/pr_url only — no secret, no transcript.
 */
import type Database from 'better-sqlite3'

/** Delivery rows older than this are pruned at boot. */
export const AGENT_WEBHOOK_DELIVERY_RETENTION_DAYS = 30
/** settings key marking the one-time per-key → per-card need-state carry-over. */
export const CARD_NEED_MIGRATED_SETTING = 'agent_webhook_card_need_migrated'

export function initAgentWebhooksSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_key_webhooks (
      key_id        INTEGER PRIMARY KEY REFERENCES agent_api_keys(id) ON DELETE CASCADE,
      user_id       INTEGER NOT NULL,
      url           TEXT NOT NULL,
      header_name   TEXT NOT NULL DEFAULT 'Authorization',
      header_prefix TEXT NOT NULL DEFAULT 'Bearer ',
      events        TEXT NOT NULL,            -- JSON array of AgentWebhookEvent
      enabled       INTEGER NOT NULL DEFAULT 1,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS agent_webhook_deliveries (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id         TEXT NOT NULL UNIQUE,
      key_id           INTEGER NOT NULL,
      objective_id     INTEGER,
      source_event_id  INTEGER,
      event            TEXT NOT NULL,
      payload          TEXT NOT NULL,
      status           TEXT NOT NULL DEFAULT 'pending',   -- pending | delivered | failed
      attempts         INTEGER NOT NULL DEFAULT 0,
      last_status_code INTEGER,
      last_error       TEXT,
      next_attempt_at  TEXT,
      created_at       TEXT NOT NULL DEFAULT (datetime('now')),
      delivered_at     TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_agent_webhook_deliveries_due ON agent_webhook_deliveries(status, next_attempt_at);
    CREATE INDEX IF NOT EXISTS idx_agent_webhook_deliveries_key ON agent_webhook_deliveries(key_id, id);

    -- obj 900214 (needs_agent pilot): the need we last woke this key for, per card.
    -- One wake per need: a row is written when a wake is queued, re-woken only when
    -- the card escalates to a different need, and cleared when the card stops
    -- needing the agent (so the NEXT time it does, it wakes again).
    CREATE TABLE IF NOT EXISTS agent_webhook_need_state (
      key_id       INTEGER NOT NULL,
      objective_id INTEGER NOT NULL,
      kind         TEXT NOT NULL,
      updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (key_id, objective_id)
    );

    -- obj 900270: the same state, keyed per CARD. One need = one wake no matter
    -- which (or how many) keys could see the card. key_id records who got it.
    -- The per-key table above is no longer read; it stays so a rollback to the
    -- previous build finds its table.
    CREATE TABLE IF NOT EXISTS agent_webhook_card_need_state (
      objective_id INTEGER PRIMARY KEY,
      kind         TEXT NOT NULL,
      key_id       INTEGER,
      updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `)
  // Carry the pilot's per-key state over ONCE (marker in settings), so a card the
  // CoS key was already woken for is not woken a second time just because the
  // deploy changed tables — and a stale per-key row never re-arms later.
  try {
    db.transaction(() => {
      const done = db.prepare('SELECT 1 FROM settings WHERE key = ?').get(CARD_NEED_MIGRATED_SETTING)
      if (done) return
      db.prepare(
        `INSERT OR IGNORE INTO agent_webhook_card_need_state (objective_id, kind, key_id, updated_at)
         SELECT objective_id, kind, key_id, updated_at FROM agent_webhook_need_state ORDER BY updated_at DESC`,
      ).run()
      db.prepare("INSERT INTO settings (key, value) VALUES (?, '1') ON CONFLICT(key) DO NOTHING").run(CARD_NEED_MIGRATED_SETTING)
    })()
  } catch (err) {
    console.error('[agent-webhooks] need-state carry-over failed:', (err as Error).message)
  }
  try {
    db.prepare(`DELETE FROM agent_webhook_deliveries WHERE created_at < datetime('now', ?)`)
      .run(`-${AGENT_WEBHOOK_DELIVERY_RETENTION_DAYS} days`)
    // A hard-deleted card never produces another event to clear its need row.
    db.prepare('DELETE FROM agent_webhook_need_state WHERE objective_id NOT IN (SELECT id FROM objectives)').run()
    db.prepare('DELETE FROM agent_webhook_card_need_state WHERE objective_id NOT IN (SELECT id FROM objectives)').run()
  } catch (err) {
    console.error('[agent-webhooks] prune failed:', (err as Error).message)
  }
}
