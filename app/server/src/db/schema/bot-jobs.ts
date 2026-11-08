/**
 * Bot jobs: the durable state behind the bounded chat → board → thread MVP
 * (obj 900323). Additive CREATE TABLEs only; nothing here rewrites an existing
 * table or changes an existing column.
 *
 * Four tables, one job each:
 *
 *  - `bot_job_origins` — the CONTINUATION record. A card created from a bot
 *    thread remembers which thread asked for it, which bot owns it, and the
 *    idempotency key that created it. This is what makes "answer in the thread
 *    it came from" a lookup rather than a guess, and it is the reason a
 *    chat-created card has a reliable destination with NO filing API key:
 *    `agent_webhook_deliveries` joins `objectives.agent_key_id`, which is NULL
 *    for every chat-created card, so that path can never reach one.
 *
 *  - `bot_thread_deliveries` — the outbox for thread-bound completion /
 *    clarification messages. Deduped by a deterministic `delivery_id` behind a
 *    PRIMARY KEY, exactly like obj 900309's `agent_webhook_deliveries(event_id)`
 *    contract: a replayed event, a reopen→done cycle and two overlapping ticks
 *    all collapse to one message.
 *
 *  - `bot_action_approvals` — the DURABLE approval/block record that must exist
 *    before a consequential action (a send, a post, a purchase, a destructive
 *    write). Durable means it survives a restart, names the operation AND its
 *    inputs, and an approval authorises that one proposed action only. The
 *    read-only MVP never executes such an action; it records the request and
 *    stops, which is the behaviour this table is here to make observable.
 *
 *  - `bot_credential_revocations` — the controlled revocation ledger the
 *    fail-closed gate reads. Authorization is snapshotted at spawn today (C7);
 *    this gives the next authorized tool call something live to check.
 */
import type Database from 'better-sqlite3'

export function initBotJobsSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS bot_job_origins (
      objective_id INTEGER PRIMARY KEY,
      -- The originating persistent thread: (person, bot). Same identity the
      -- agent_chat_messages / agent_chat_cards tables already key on.
      thread_user_id INTEGER NOT NULL,
      thread_agent_slug TEXT NOT NULL,
      -- The VALIDATED owner, resolved through the bot registry. Never derived
      -- from a credential or a key label.
      owner_bot TEXT NOT NULL,
      owner_user_id INTEGER NOT NULL,
      workspace TEXT NOT NULL,
      -- What the job is permitted to do. The MVP supports 'read_only' only.
      job_mode TEXT NOT NULL DEFAULT 'read_only' CHECK(job_mode IN ('read_only')),
      idempotency_key TEXT NOT NULL,
      -- 'auto' when the bounded guard started it, 'manual' when a human must.
      start_mode TEXT NOT NULL DEFAULT 'manual',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uq_bot_job_origins_idem
      ON bot_job_origins(thread_user_id, thread_agent_slug, idempotency_key);
    CREATE INDEX IF NOT EXISTS idx_bot_job_origins_thread
      ON bot_job_origins(thread_user_id, thread_agent_slug);

    CREATE TABLE IF NOT EXISTS bot_thread_deliveries (
      delivery_id TEXT PRIMARY KEY,
      objective_id INTEGER NOT NULL,
      thread_user_id INTEGER NOT NULL,
      thread_agent_slug TEXT NOT NULL,
      kind TEXT NOT NULL,
      body TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'delivered', 'failed')),
      message_id INTEGER,
      last_error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      delivered_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_bot_thread_deliveries_pending
      ON bot_thread_deliveries(status, delivery_id);
    CREATE INDEX IF NOT EXISTS idx_bot_thread_deliveries_obj
      ON bot_thread_deliveries(objective_id);

    CREATE TABLE IF NOT EXISTS bot_action_approvals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      objective_id INTEGER,
      thread_user_id INTEGER NOT NULL,
      thread_agent_slug TEXT NOT NULL,
      action_kind TEXT NOT NULL,
      -- SHA-256 over (kind + canonical inputs). An approval is bound to this
      -- fingerprint, so approving a $10 purchase cannot authorise a $1000 one.
      action_fingerprint TEXT NOT NULL,
      inputs_json TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending'
        CHECK(state IN ('pending', 'approved', 'blocked', 'consumed')),
      decided_by INTEGER,
      decided_at TEXT,
      consumed_at TEXT,
      note TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_bot_action_approvals_fp
      ON bot_action_approvals(action_fingerprint, state);
    CREATE INDEX IF NOT EXISTS idx_bot_action_approvals_obj
      ON bot_action_approvals(objective_id);

    CREATE TABLE IF NOT EXISTS bot_credential_revocations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      -- Scope of the revocation: a connector id, a secret NAME, or '*'.
      scope TEXT NOT NULL,
      subject TEXT NOT NULL,
      reason TEXT,
      revoked_at TEXT NOT NULL DEFAULT (datetime('now')),
      restored_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_bot_credential_revocations_live
      ON bot_credential_revocations(scope, subject, restored_at);
  `)
}
