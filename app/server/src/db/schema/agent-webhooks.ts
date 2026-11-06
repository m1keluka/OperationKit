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
  `)
  try {
    db.prepare(`DELETE FROM agent_webhook_deliveries WHERE created_at < datetime('now', ?)`)
      .run(`-${AGENT_WEBHOOK_DELIVERY_RETENTION_DAYS} days`)
    // A hard-deleted card never produces another event to clear its need row.
    db.prepare('DELETE FROM agent_webhook_need_state WHERE objective_id NOT IN (SELECT id FROM objectives)').run()
  } catch (err) {
    console.error('[agent-webhooks] prune failed:', (err as Error).message)
  }
}
