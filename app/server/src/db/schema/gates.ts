/**
 * Canary, UAT, test-credentials, and settings — extracted from db/index.ts
 * (behavior frozen). Additive CREATE TABLE + settings seed flags only.
 * gate_false_pass CHECK rebuild stays in initDb().
 */
import type Database from 'better-sqlite3'

export function initGatesSchema(db: Database.Database): void {
  // `canary_runs` (obj-2376) — one summary row per anti-signal canary harness run.
  // The canary catch-rate is itself a tracked metric (the verifier-of-the-verifier
  // made PROACTIVE): if it ever drops below 100% on Tier-1, a known-bad input
  // escaped the gate — a critical alarm. Append-only.
  db.exec(`
    CREATE TABLE IF NOT EXISTS canary_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      total INTEGER NOT NULL,
      caught INTEGER NOT NULL,
      escaped INTEGER NOT NULL,
      opened INTEGER NOT NULL,
      catch_rate REAL NOT NULL,
      trigger TEXT NOT NULL DEFAULT 'manual',
      detail TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_canary_runs_created ON canary_runs(created_at);
  `)

  // ── Adversarial UAT gate (Rec #3 of the obj-2319 Kitchen-Loop roadmap, 2026-06-29) ──
  // `objective_uat_runs` — one row per UAT-gate evaluation. The gate EXECUTES the
  // worker's sealed test card in an isolated worktree and grades by exact exit codes,
  // then mechanically anti-cheats via `git diff`. Coupled table (NOT objective_reviews,
  // whose verdict CHECK is pass/fail/blocked) so shadow runs never perturb the live
  // review row or transitions. `criteria_results` holds the SAME JSON shape as
  // objective_reviews.criteria_results (consumed by prompt-builder.ts:382), so a failing
  // UAT run can feed the worker its failing steps. `shadow=1` ⇒ recorded, not blocking.
  // `source` discriminates real objective runs from canary-regression proof runs.
  db.exec(`
    CREATE TABLE IF NOT EXISTS objective_uat_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      objective_id INTEGER,
      source TEXT NOT NULL DEFAULT 'objective',
      verdict TEXT NOT NULL CHECK(verdict IN ('PASS','PRODUCT_FAIL','UAT_SPEC_FAIL','EVAL_CHEAT_FAIL')),
      shadow INTEGER NOT NULL DEFAULT 1,
      card_json TEXT NOT NULL DEFAULT '{}',
      criteria_results TEXT NOT NULL DEFAULT '[]',
      evidence_json TEXT NOT NULL DEFAULT '{}',
      cheat_paths TEXT,
      worktree TEXT,
      workspace TEXT NOT NULL DEFAULT 'operator',
      session_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_uat_runs_objective ON objective_uat_runs(objective_id);
    CREATE INDEX IF NOT EXISTS idx_uat_runs_verdict ON objective_uat_runs(verdict);
  `)

  // `test_credentials` — encrypted at rest (AES-256-GCM via services/crypto.ts).
  // The `fields_encrypted` column holds a JSON map `{fieldName: encryptedValue}`
  // so each value is independently decryptable. The reviewer session reads via
  // the localhost-only internal route and injects fields as TESTCRED_* env vars.
  db.exec(`
    CREATE TABLE IF NOT EXISTS test_credentials (
      slug TEXT PRIMARY KEY,
      workspace TEXT NOT NULL,
      project TEXT,
      label TEXT NOT NULL,
      login_url TEXT NOT NULL,
      fields_encrypted TEXT NOT NULL,
      notes TEXT,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_testcred_workspace ON test_credentials(workspace);
    CREATE INDEX IF NOT EXISTS idx_testcred_project ON test_credentials(project);
  `)

  // obj-2391 (per-project TEST credentials + testing links): additive
  // specialization on the EXISTING test_credentials store — no new secrets
  // store, no parallel scope engine. `is_primary` marks the ONE canonical QA
  // login for a (workspace, project), so a Playwright/QA run can deterministically
  // resolve "the test creds + testing link for project X" instead of guessing a
  // slug. Idempotent ADD COLUMN (PRAGMA-guarded, mirrors the objectives/
  // user_workspaces additive-column pattern above) keeps existing rows valid
  // (default 0). The partial unique index enforces at most one primary per
  // (workspace, project); NULL-project rows are workspace-level and exempt.
  const tcCols = db.prepare('PRAGMA table_info(test_credentials)').all() as { name: string }[]
  if (!tcCols.some(c => c.name === 'is_primary')) {
    db.exec('ALTER TABLE test_credentials ADD COLUMN is_primary INTEGER NOT NULL DEFAULT 0')
  }
  db.exec(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_testcred_primary ON test_credentials(workspace, project) WHERE is_primary = 1',
  )

  // ── Routines engine (2026-06-12) ───────────────────────────────────────
  // `settings` — tiny generic KV store. First consumer: the routines global
  // kill switch (`routines_enabled`, '1'/'0'). No other settings mechanism
  // existed in this DB before this table.
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `)
  db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('routines_enabled', '1')").run()
  // Global kill switch for the deterministic floor (ST1) — OFF by default so the
  // worker→done transition path is byte-for-byte identical to today until
  // explicitly enabled. The env var CC_DETERMINISTIC_FLOOR_ENABLED overrides this.
  db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('deterministic_floor_enabled', '0')").run()
  // Auto-merge-on-green (obj-1150) — wired into reviewer-PASS. Default ON so
  // green+approved lightweight PRs ship without a human merge click. Operators
  // can still set '0'. See services/auto-merge.ts.
  db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('auto_merge_enabled', '1')").run()
  const AUTO_MERGE_ON_KEY = 'auto_merge_enabled_on_2026_08_24'
  try {
    const already = db.prepare('SELECT 1 FROM schema_meta WHERE key = ?').get(AUTO_MERGE_ON_KEY)
    if (!already) {
      db.prepare("UPDATE settings SET value = '1' WHERE key = 'auto_merge_enabled'").run()
      db.prepare('INSERT INTO schema_meta (key, value) VALUES (?, ?)').run(AUTO_MERGE_ON_KEY, '1')
    }
  } catch {
    // schema_meta may not exist yet on a brand-new init ordering; INSERT OR IGNORE above still defaults ON.
  }
  // Auto-remediation of external-CI failures (obj-1960/1955) — OFF by default. The
  // owner flips this to '1' to arm the self-heal loop (a failing PR check is routed
  // back into its objective's session to diagnose→fix→revalidate). It stays PR-only
  // and never auto-merges. See services/external-remediation.ts (isRemediationEnabled).
  db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('auto_remediation_enabled', '0')").run()
  // CI → objective feedback bridge, POLLER variant (obj 701617) — OFF by default. The
  // owner flips this to '1' to arm the pull-based loop: a droplet-side poller reads open
  // example-platform PRs' vitest check and, on FAILURE, POSTs a concise failing-test summary
  // to the originating objective's /message endpoint so the worker re-opens and iterates.
  // Read-only against GitHub; posts only to localhost. Shares the external_check_remediations
  // dedupe table with the webhook engine. See services/ci-feedback-bridge.ts (isCiBridgeEnabled).
  db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('ci_feedback_bridge_enabled', '0')").run()
  // Soft-delete (obj 700415) — OFF by default = hard-delete behavior preserved.
  // When '1', DELETE /api/objectives/:id sets deleted_at instead of removing the
  // row (writes a delete_soft audit row); list/tree endpoints hide deleted rows
  // unless ?include_deleted=1. Env CC_SOFT_DELETE overrides. See
  // services/objective-audit.isSoftDeleteEnabled.
  db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('soft_delete_enabled', '0')").run()
  // Human-terminal reactivation guard (obj 700415) — OFF by default = dry-run
  // (log "WOULD block" + proceed). When '1', a machine reactivation of a
  // terminal_by_human objective is skipped. Env CC_HUMAN_TERMINAL_GUARD overrides.
  db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('human_terminal_guard_enabled', '0')").run()
  // Auto-deploy on merge (obj-1955) — OFF by default. When '1', a PR merged to the
  // command-center's OWN main fires a health-gated self-deploy (so changes ship in
  // small self-verifying batches instead of piling up behind a manual deploy). The
  // deploy auto-rolls-back on failure. Env CC_AUTO_DEPLOY overrides. See
  // services/auto-deploy.ts. While '0', a merge is logged as a dry-run.
  db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('auto_deploy_enabled', '0')").run()
  // Board-hygiene sweeps (obj 700595) — all OFF by default (safe). The orphan-child
  // cleanup on parent-terminal (event-driven) and the stale-review digest (read-only)
  // are always live and need no flag; these three gate the AUTONOMOUS mutating sweeps:
  //  - hygiene_queue_drainer_enabled: start queue children a live delegator forgot to
  //    PATCH, past QUEUE_ORPHAN_TTL (never touches manual/no-parent queue cards).
  //  - hygiene_auto_accept_enabled: advance review + verdict='pass' rows to done after
  //    REVIEW_PASS_TTL (never touches verdict IS NULL — those need a human).
  //  - hygiene_review_hard_expiry_enabled: soft-close verdict=null review items older
  //    than REVIEW_HARD_EXPIRY to done (digest-visible). Mike wants digest-only by
  //    default, so this stays OFF until explicitly armed.
  // Env overrides: CC_HYGIENE_QUEUE_DRAINER / CC_HYGIENE_AUTO_ACCEPT /
  // CC_HYGIENE_REVIEW_HARD_EXPIRY. See lib/hygiene-config.ts.
  db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('hygiene_queue_drainer_enabled', '0')").run()
  db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('hygiene_auto_accept_enabled', '0')").run()
  db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('hygiene_review_hard_expiry_enabled', '0')").run()
  // KL-21 gate-rejection memory (obj-2509) — OFF by default. When '1', the
  // state-poller skips the LLM auditor for a rejected objective whose head tree
  // SHA is byte-identical to the tree it was rejected on (no re-grade of an
  // unchanged tree). Env CC_GATE_REJECTION_MEMORY_ENABLED overrides; kill switch
  // CC_GATE_REJECTION_MEMORY_KILLED / settings.gate_rejection_memory_killed. See
  // services/governance.ts.
  db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('gate_rejection_memory_enabled', '0')").run()
  // KL-11 blocked-combos registry (obj-2509) — OFF by default. When '1', the
  // objective-generation path (POST /api/internal/objectives) skips items whose
  // title matches an active `blocked_objectives` rule. Env
  // CC_BLOCKED_REGISTRY_ENABLED overrides; kill CC_BLOCKED_REGISTRY_KILLED.
  db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('blocked_registry_enabled', '0')").run()
  // Strategy tier (obj 700030) — OFF by default. The runtime owner toggle for the
  // Strategy Layer, mirroring auto_merge_enabled. When '1' (OR env CC_STRATEGY_TIER='1'),
  // isStrategyTierEnabled() is true and the strategy spawn path + stage-0 human gate
  // activate. While off (env unset AND this '0'/absent), the platform is byte-identical
  // to the pre-Strategy-Layer behavior. See services/strategy-governance.ts.
  db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('strategy_tier_enabled', '0')").run()
  // Kitchen Loop Phase-0 SHADOW (obj 700099) — OFF by default. The driver service
  // services/kitchen-loop.ts is a COMPLETE no-op while this is '0' (or env
  // CC_KITCHEN_LOOP_ENABLED is unset): startKitchenLoop() returns before arming any
  // timer, so server boot + the existing test suite are byte-for-byte unchanged.
  // When '1', the six-phase machine ticks in SHADOW only — Ideate is dry-run (logs
  // the tickets it WOULD post, writes none), the oracle runs read-only, a
  // loop_drift_metrics snapshot is written each Regress, and the three pause gates
  // are evaluated-and-LOGGED but take no action. `kitchen_loop_killed` is the
  // instant disarm (mirrors the governance.ts isXEnabled/isXKilled pattern). Flipping
  // emission ON / a single-repo pilot is a SEPARATE Mike-gated step, not this flag.
  db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('kitchen_loop_enabled', '0')").run()
  db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('kitchen_loop_killed', '0')").run()
  // Kitchen Loop Stage-C live-execution flags (obj 700315) — ALL default OFF. These
  // arm the OFFENSIVE half of the loop, each independently; with every one OFF the
  // loop is byte-for-byte identical to the Phase-0 SHADOW behavior above.
  //   • kitchen_loop_ideate_live   — ON ⇒ ideate POSTs computed tickets to the board
  //       (command-center pilot scope only, WIP-capped, deduped, created in 'queue'
  //       so a human must approve before any session spawns). OFF ⇒ dry-run.
  //   • kitchen_loop_gates_enforce — ON ⇒ a tripped pause gate sets the loop phase to
  //       'paused'. OFF ⇒ gates log-only.
  //   • kitchen_loop_oracle_gate / kitchen_loop_review_enforce — Stage-C flags READ
  //       by the sibling defensive-half services (deterministic-floor / canary /
  //       uat-gate / false-pass); seeded here so that block stays single-owner.
  //   • kitchen_loop_wip_cap — ideate live-emit WIP ceiling (open objectives in
  //       planning/queue/working/ai_review/review). Default '8'.
  db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('kitchen_loop_ideate_live', '0')").run()
  db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('kitchen_loop_gates_enforce', '0')").run()
  db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('kitchen_loop_oracle_gate', '0')").run()
  db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('kitchen_loop_review_enforce', '0')").run()
  db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('kitchen_loop_wip_cap', '8')").run()

}
