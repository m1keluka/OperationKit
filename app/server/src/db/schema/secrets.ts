/**
 * Native secrets store + resource assignments — extracted from db/index.ts
 * (behavior frozen). Additive CREATE TABLE only.
 */
import type Database from 'better-sqlite3'

export function initSecretsSchema(db: Database.Database): void {
  // ── Native scoped secrets store (obj-2353 / W1 foundation) ───────────────
  // The Doppler-replacement store. `secrets` holds one row per
  // (scope_type, workspace, user_id, key); `value_encrypted` is AES-256-GCM
  // (services/secrets-crypto.ts) under the DEDICATED SECRETS_MASTER_KEY — NO
  // plaintext secret ever lands in the DB. Resolution at injection is
  // most-specific-wins: global < workspace < user < workspace_user.
  //
  // The UNIQUE(scope_type, workspace, user_id, key) constraint is the upsert
  // key. SQLite treats NULLs as DISTINCT in UNIQUE indexes, which would let two
  // global rows (workspace=NULL, user_id=NULL) for the same key coexist — so
  // the columns are NOT NULL with sentinels ('' for workspace, 0 for user_id)
  // when a scope dimension doesn't apply. The service layer owns the sentinel
  // mapping; nothing reads these columns raw.
  db.exec(`
    CREATE TABLE IF NOT EXISTS secrets (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      scope_type      TEXT    NOT NULL CHECK(scope_type IN ('global','workspace','user','workspace_user')),
      workspace       TEXT    NOT NULL DEFAULT '',   -- '' sentinel for global/user scope
      user_id         INTEGER NOT NULL DEFAULT 0,    -- 0 sentinel for global/workspace scope
      key             TEXT    NOT NULL,              -- e.g. OPENAI_API_KEY
      value_encrypted TEXT    NOT NULL,              -- secrets-crypto.encryptSecret(value); NEVER returned raw
      version         INTEGER NOT NULL DEFAULT 1,
      created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
      updated_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at      TEXT    NOT NULL DEFAULT (datetime('now')),
      UNIQUE(scope_type, workspace, user_id, key)
    );
    CREATE INDEX IF NOT EXISTS idx_secrets_scope ON secrets(scope_type, workspace, user_id);
    CREATE INDEX IF NOT EXISTS idx_secrets_key ON secrets(key);

    -- Version history for rollback (R8). One row per historical value of a
    -- secret, written on every create + update. value_encrypted is carried so a
    -- prior version can be restored without losing it.
    CREATE TABLE IF NOT EXISTS secret_versions (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      secret_id       INTEGER NOT NULL REFERENCES secrets(id) ON DELETE CASCADE,
      version         INTEGER NOT NULL,
      value_encrypted TEXT    NOT NULL,
      changed_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
      changed_at      TEXT    NOT NULL DEFAULT (datetime('now')),
      UNIQUE(secret_id, version)
    );
    CREATE INDEX IF NOT EXISTS idx_secret_versions_secret ON secret_versions(secret_id);

    -- Audit trail (R8): who did what to which scope/key. action ∈
    -- create|update|delete|read|inject|rollback. NEVER stores the value. scope
    -- is the resolved scope label (e.g. 'workspace:example' / 'global'). actor
    -- null/0 = system/non-user (e.g. session-injection at spawn). The FK to
    -- users is intentionally omitted so the audit trail survives user deletion.
    CREATE TABLE IF NOT EXISTS secret_access_log (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      actor_user_id INTEGER,
      action        TEXT NOT NULL,
      scope         TEXT NOT NULL,
      key           TEXT NOT NULL,
      at            TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_secret_access_log_at ON secret_access_log(at DESC);
    CREATE INDEX IF NOT EXISTS idx_secret_access_log_actor ON secret_access_log(actor_user_id);
  `)

  // ── Scoped agent/skill assignment (obj-2388) ─────────────────────────────
  // One row = "resource R (an agent or a skill) is assigned at scope S". Reuses
  // the obj-2353/1731 credential scope model (global/workspace/user) and adds a
  // `project` tier. Like `secrets`, scope dimensions that don't apply use
  // sentinels ('' for workspace/project, 0 for user_id) so the UNIQUE index
  // collapses correctly (SQLite treats NULLs as DISTINCT). The service layer
  // (services/resource-assignments.ts) owns sentinel mapping + resolution;
  // nothing reads these columns raw. Generalizes Phase-7 `default_agent_pool`
  // from workspace→{global,workspace,user,project} and agents→{agents,skills}.
  db.exec(`
    CREATE TABLE IF NOT EXISTS resource_assignments (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      resource_type TEXT    NOT NULL CHECK(resource_type IN ('agent','skill')),
      resource_id   TEXT    NOT NULL,                -- agent name or skill name
      scope_type    TEXT    NOT NULL CHECK(scope_type IN ('global','workspace','user','project')),
      workspace     TEXT    NOT NULL DEFAULT '',     -- '' sentinel for global/user scope
      project       TEXT    NOT NULL DEFAULT '',     -- '' sentinel unless scope_type='project'
      user_id       INTEGER NOT NULL DEFAULT 0,      -- 0 sentinel unless scope_type='user'
      created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
      UNIQUE(resource_type, resource_id, scope_type, workspace, project, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_resource_assignments_lookup
      ON resource_assignments(resource_type, scope_type, workspace, project, user_id);
  `)

}
