/**
 * Native secrets store + resource assignments — extracted from db/index.ts
 * (behavior frozen). Additive CREATE TABLE only.
 */
import type Database from 'better-sqlite3'
import { SERVICE_ONLY_BY_DEFAULT } from '../../services/secrets-store-keys.js'

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

  // ── Service-only secrets ─────────────────────────────────────────────────
  // A secret at global scope is shared by definition, so injecting every one of
  // them into every spawned session handed each session the server's own
  // credentials — including the OAuth client secret and the shared mailbox
  // tokens behind the per-user connectors. Those exist for server-side jobs and
  // for nothing else.
  //
  // service_only = 1 means "server process only": still hydrated into the
  // server's own env at boot, never injected into a session. Default 0, so
  // nothing an operator stored for their agents changes.
  //
  // Migration is automatic and reversible from the UI: the shared credentials
  // the per-user connectors are built on (SERVICE_ONLY_BY_DEFAULT in
  // services/secrets-store.ts) are flipped once, when the column is created.
  // No install has to edit data by hand, and a key that is NOT on that list is
  // left exactly as it was.
  const secretCols = new Set(
    (db.prepare('PRAGMA table_info(secrets)').all() as { name: string }[]).map(c => c.name),
  )
  if (!secretCols.has('service_only')) {
    db.exec('ALTER TABLE secrets ADD COLUMN service_only INTEGER NOT NULL DEFAULT 0')
    const list = SERVICE_ONLY_BY_DEFAULT.map(() => '?').join(',')
    db.prepare(
      `UPDATE secrets SET service_only = 1 WHERE scope_type = 'global' AND key IN (${list})`,
    ).run(...SERVICE_ONLY_BY_DEFAULT)
  }

  initSecretsHardeningSchema(db)
  initSecretsSessionEnvSchema(db)

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

/**
 * Sprint 6 secrets hardening (obj 900498). Additive only: no stored value,
 * ciphertext or key is read, rewritten or re-encrypted here.
 *
 *   secrets.description   operator note ("Stripe live key, billing worker").
 *                         Metadata only, shown in Settings, never part of a value.
 *   secrets.last_used_at  stamped when the server decrypts the value for a real
 *                         use (session injection, broker use, server-side read).
 *
 *   secret_access_log gains secret_id / source / detail so the log can be
 *   filtered per secret and says HOW something happened (ui / api / broker /
 *   spawn / chat). It never stores a value.
 *
 * APPEND-ONLY: two BEFORE triggers abort any UPDATE or DELETE on
 * secret_access_log. Nothing in the server mutates past rows, so this changes
 * no behaviour; it turns "we never edit the audit trail" from a convention into
 * a database guarantee. The ONLY sanctioned prune is the D5 retention job
 * (services/secrets-audit-retention.ts, obj 900540): rows older than one year
 * are exported and verified first, then removed inside one transaction that
 * re-creates this guard and records an `audit_prune` row (docs/security.md →
 * "Audit log retention").
 */
export const SECRET_AUDIT_TRIGGERS = [
  'trg_secret_access_log_no_update',
  'trg_secret_access_log_no_delete',
] as const

/**
 * The append-only DELETE guard, as one statement. Shared with the D5 retention
 * job (services/secrets-audit-retention.ts), which drops it, prunes exported
 * rows and re-creates it inside ONE transaction — so the guard can never be
 * left missing, and both places always install the identical trigger.
 */
export const SECRET_AUDIT_NO_DELETE_TRIGGER_SQL = `
    CREATE TRIGGER IF NOT EXISTS trg_secret_access_log_no_delete
      BEFORE DELETE ON secret_access_log
      BEGIN SELECT RAISE(ABORT, 'secret_access_log is append-only'); END;`

export function initSecretsHardeningSchema(db: Database.Database): void {
  const cols = (table: string) =>
    new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(c => c.name))

  const sc = cols('secrets')
  if (!sc.has('description')) db.exec('ALTER TABLE secrets ADD COLUMN description TEXT')
  if (!sc.has('last_used_at')) db.exec('ALTER TABLE secrets ADD COLUMN last_used_at TEXT')

  const lc = cols('secret_access_log')
  if (!lc.has('secret_id')) db.exec('ALTER TABLE secret_access_log ADD COLUMN secret_id INTEGER')
  if (!lc.has('source')) db.exec('ALTER TABLE secret_access_log ADD COLUMN source TEXT')
  if (!lc.has('detail')) db.exec('ALTER TABLE secret_access_log ADD COLUMN detail TEXT')

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_secret_access_log_secret ON secret_access_log(secret_id, id DESC);
    CREATE INDEX IF NOT EXISTS idx_secret_access_log_key ON secret_access_log(key, id DESC);

    CREATE TRIGGER IF NOT EXISTS trg_secret_access_log_no_update
      BEFORE UPDATE ON secret_access_log
      BEGIN SELECT RAISE(ABORT, 'secret_access_log is append-only'); END;

  `)
  db.exec(SECRET_AUDIT_NO_DELETE_TRIGGER_SQL)
}

/**
 * Sprint 6b, decision D4 (obj 900540): sessions get only ALLOWLISTED secrets in
 * their environment; everything else goes through the broker.
 *
 *   secret_env_allowlist  one row = "sessions run by agent X / able to use skill
 *                         Y receive KEY in their env". subject '*' with
 *                         subject_type 'agent' = every session (a baseline).
 *                         Names only, never a value.
 *   secret_env_usage      MIGRATION LOG: one row per (session, key) for a store
 *                         secret the session referenced in a tool call while
 *                         that key was NOT on its allowlist. `mode` says whether
 *                         the key was still passed (migration) or withheld
 *                         (enforce). Names and counts only.
 *
 * The mode lives in settings.secrets_session_env_mode ('migration' | 'enforce').
 * A missing row reads as 'migration', so every EXISTING install keeps its
 * current env and starts logging; a fresh install is set to 'enforce' by
 * scripts/install-bootstrap.ts.
 */
export function initSecretsSessionEnvSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS secret_env_allowlist (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      subject_type TEXT    NOT NULL CHECK(subject_type IN ('agent','skill')),
      subject      TEXT    NOT NULL,
      key          TEXT    NOT NULL,
      created_by   INTEGER,
      created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
      UNIQUE(subject_type, subject, key)
    );
    CREATE INDEX IF NOT EXISTS idx_secret_env_allowlist_subject ON secret_env_allowlist(subject_type, subject);

    CREATE TABLE IF NOT EXISTS secret_env_usage (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      objective_id  INTEGER,
      session_id    TEXT    NOT NULL,
      workspace     TEXT    NOT NULL DEFAULT '',
      agent         TEXT    NOT NULL DEFAULT '',
      key           TEXT    NOT NULL,
      mode          TEXT    NOT NULL CHECK(mode IN ('migration','enforce')),
      uses          INTEGER NOT NULL DEFAULT 1,
      first_seen_at TEXT    NOT NULL DEFAULT (datetime('now')),
      last_seen_at  TEXT    NOT NULL DEFAULT (datetime('now')),
      UNIQUE(session_id, key)
    );
    CREATE INDEX IF NOT EXISTS idx_secret_env_usage_agent ON secret_env_usage(agent, key);
    CREATE INDEX IF NOT EXISTS idx_secret_env_usage_seen ON secret_env_usage(last_seen_at DESC);
  `)
}
