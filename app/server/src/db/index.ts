import Database from 'better-sqlite3'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { backfillAllDepths } from '../lib/objective-depth.js'
import { initDevelopmentSchema, seedDevelopmentRegistry } from './schema/development.js'
import { initCoreSchema } from './schema/core.js'
import { initKitchenLoopSchema } from './schema/kitchen.js'
import { initSecretsSchema } from './schema/secrets.js'
import { initDsrSchema } from './schema/dsr.js'
import { initAuditSchema } from './schema/audit.js'
import { initSessionTablesSchema } from './schema/session.js'
import { initMentorSchema } from './schema/mentor.js'
import { initWorkspacesSchema } from './schema/workspaces.js'
import { initReviewsSchema } from './schema/reviews.js'
import { initGatesSchema } from './schema/gates.js'
import { initRuntimeSchema } from './schema/runtime.js'
import { initLeasesSchema } from './schema/leases.js'
import { initModelsSchema } from './schema/models.js'
import { initTokensSchema } from './schema/tokens.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../../data/command-center.db')

let db: Database.Database

export function getDb(): Database.Database {
  if (!db) {
    throw new Error('Database not initialized. Call initDb() first.')
  }
  return db
}

/** Canonical production database file (mounted in the container). */
const PROD_DB_PATH = '/app/data/command-center.db'

export function initDb(): Database.Database {
  // HARD SAFETY (incident 2026-06-30): never let a test runner open the production
  // database. Production sets DB_PATH=/app/data/command-center.db in the container env;
  // a `vitest run` that inherits it would open the live DB, and suite teardowns
  // (`DELETE FROM objectives`, …) would wipe it. Under a test runner, refuse the
  // canonical production path outright — tests must use a throwaway DB (vitest.setup.ts
  // assigns one globally; individual suites may set their own via DB_PATH before import).
  if ((process.env.VITEST || process.env.NODE_ENV === 'test') &&
      path.resolve(DB_PATH) === PROD_DB_PATH) {
    throw new Error(
      `[db] Refusing to open the production database under a test runner (DB_PATH=${DB_PATH}). ` +
      `Set process.env.DB_PATH to a throwaway temp file before importing the db module.`,
    )
  }

  const dir = path.dirname(DB_PATH)
  fs.mkdirSync(dir, { recursive: true })

  db = new Database(DB_PATH)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')

  initCoreSchema(db)

  // Fix agent_context CHECK constraint for existing DBs — old constraint only allowed 5 values,
  // but we now support 8 (added designer, hr, general-counsel). SQLite can't ALTER CHECK constraints,
  // so we drop and recreate the constraint by rebuilding the table if the old constraint is detected.
  try {
    // Test if the old constraint blocks new values
    db.exec("INSERT INTO objectives (title, agent_context) VALUES ('__constraint_test__', 'designer')")
    db.exec("DELETE FROM objectives WHERE title = '__constraint_test__'")
  } catch {
    // Old constraint is blocking — need to rebuild the table
    console.log('[db] Rebuilding objectives table to expand agent_context CHECK constraint...')
    db.exec(`
      CREATE TABLE objectives_new AS SELECT * FROM objectives;
      DROP TABLE objectives;
      CREATE TABLE objectives (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'queue' CHECK(status IN ('queue', 'working', 'review', 'done')),
        agent_context TEXT NOT NULL DEFAULT 'general' CHECK(agent_context IN ('cto', 'cmo', 'coo', 'cfo', 'general', 'designer', 'hr', 'general-counsel')),
        assigned_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        session_id TEXT,
        transcript_path TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO objectives SELECT id, title, description, status, agent_context, assigned_user_id, session_id, transcript_path, created_at, updated_at FROM objectives_new;
      DROP TABLE objectives_new;
      CREATE INDEX IF NOT EXISTS idx_objectives_status ON objectives(status);
    `)
  }

  // Status CHECK constraint management. The current allowed set is:
  //   planning, queue, working, ai_review, review, done, cancelled
  // SQLite can't ALTER a CHECK constraint, so we probe three ways:
  //   (a) 'planning' rejected  → old schema (pre AI Review); rebuild.
  //   (b) 'human_review' accepted → legacy schema (pre 2026-06-08 consolidation);
  //       rewrite rows to 'review' and rebuild to drop the literal.
  //   (c) 'cancelled' rejected → pre-obj-700595 schema; rebuild to add the
  //       soft-retire terminal state.
  let statusConstraintNeedsRebuild = false
  try {
    db.exec("INSERT INTO objectives (title, agent_context, status) VALUES ('__status_constraint_probe__', 'general', 'planning')")
    db.exec("DELETE FROM objectives WHERE title = '__status_constraint_probe__'")
  } catch {
    statusConstraintNeedsRebuild = true
  }
  if (!statusConstraintNeedsRebuild) {
    try {
      db.exec("INSERT INTO objectives (title, agent_context, status) VALUES ('__status_constraint_probe_cancelled__', 'general', 'cancelled')")
      db.exec("DELETE FROM objectives WHERE title = '__status_constraint_probe_cancelled__'")
    } catch {
      // 'cancelled' rejected — schema predates obj 700595; rebuild to add it.
      statusConstraintNeedsRebuild = true
    }
  }
  if (!statusConstraintNeedsRebuild) {
    try {
      db.exec("INSERT INTO objectives (title, agent_context, status) VALUES ('__status_constraint_probe_hr__', 'general', 'human_review')")
      // If the insert succeeded, the legacy literal is still allowed — flag rebuild.
      db.exec("DELETE FROM objectives WHERE title = '__status_constraint_probe_hr__'")
      statusConstraintNeedsRebuild = true
    } catch {
      // 'human_review' rejected — schema already matches the new constraint.
    }
  }
  if (statusConstraintNeedsRebuild) {
    // Rewrite any legacy human_review rows to review BEFORE rebuilding, so the
    // new CHECK doesn't reject them during the data copy.
    db.exec("UPDATE objectives SET status = 'review' WHERE status = 'human_review'")
    console.log('[db] Rebuilding objectives table to apply current status CHECK (planning/queue/working/ai_review/review/done)...')
    const cols = db.prepare("PRAGMA table_info(objectives)").all() as { name: string; type: string; dflt_value: string | null; notnull: number; pk: number }[]
    const colNames = cols.map(c => c.name)
    const colList = colNames.join(', ')

    // Build CREATE statement with the expanded CHECK constraint. Keep every
    // existing column with its current type/default — we only touch the
    // status constraint; everything else passes through unchanged.
    const colDefs = cols.map(c => {
      if (c.name === 'status') {
        return `status TEXT NOT NULL DEFAULT 'queue' CHECK(status IN ('planning','queue','working','ai_review','review','done','cancelled'))`
      }
      // The status-rebuild path used to drop the agent_context CHECK because the
      // generic branch below only re-emits type/NOT NULL/DEFAULT. Restate it.
      if (c.name === 'agent_context') {
        return `agent_context TEXT NOT NULL DEFAULT 'general' CHECK(agent_context IN ('cto', 'cmo', 'coo', 'cfo', 'general', 'designer', 'hr', 'general-counsel'))`
      }
      if (c.name === 'id') return `id INTEGER PRIMARY KEY AUTOINCREMENT`
      const notNull = c.notnull ? ' NOT NULL' : ''
      // PRAGMA strips outer parens from expression defaults (e.g. `(datetime('now'))` → `datetime('now')`).
      // SQLite requires compound-expression defaults to be parenthesized, so re-wrap anything that
      // isn't a bare literal (string-literal starting with `'`, plain number, NULL, or CURRENT_*).
      let dflt = ''
      if (c.dflt_value !== null) {
        const v = String(c.dflt_value)
        const isLiteral = /^'.*'$/.test(v) || /^-?\d+(\.\d+)?$/.test(v) || /^(NULL|CURRENT_TIMESTAMP|CURRENT_DATE|CURRENT_TIME)$/i.test(v)
        dflt = isLiteral ? ` DEFAULT ${v}` : ` DEFAULT (${v})`
      }
      return `${c.name} ${c.type}${notNull}${dflt}`
    }).join(',\n        ')

    db.exec(`
      BEGIN;
      CREATE TABLE objectives_new (
        ${colDefs}
      );
      INSERT INTO objectives_new (${colList}) SELECT ${colList} FROM objectives;
      DROP TABLE objectives;
      ALTER TABLE objectives_new RENAME TO objectives;
      CREATE INDEX IF NOT EXISTS idx_objectives_status ON objectives(status);
      COMMIT;
    `)
  }

  // Migrations: add columns if they don't exist (safe for existing DBs)
  const cols = db.prepare("PRAGMA table_info(objectives)").all() as { name: string }[]
  const colNames = new Set(cols.map(c => c.name))

  if (!colNames.has('workspace')) {
    db.exec("ALTER TABLE objectives ADD COLUMN workspace TEXT NOT NULL DEFAULT 'example'")
  }
  if (!colNames.has('category')) {
    db.exec("ALTER TABLE objectives ADD COLUMN category TEXT NOT NULL DEFAULT 'general'")
  }
  if (!colNames.has('parent_id')) {
    db.exec("ALTER TABLE objectives ADD COLUMN parent_id INTEGER REFERENCES objectives(id) ON DELETE SET NULL")
  }
  if (!colNames.has('depth')) {
    db.exec("ALTER TABLE objectives ADD COLUMN depth INTEGER NOT NULL DEFAULT 0")
  }
  // TRANSITIVE depth backfill (obj 707003, P0-2). This REPLACES the Strategy
  // Layer P0 one-shot (`UPDATE objectives SET depth = 1 WHERE parent_id IS NOT
  // NULL AND depth = 0`), whose own comment said it was "safe because the old
  // nesting guard never permitted any tree deeper than one level". The Strategy
  // tier removed that guard: the live board carries chains reaching depth 3, but
  // flattening every child to 1 meant the STORED column only ever held {0, 1} —
  // measured 4,527/3,835 across 8,362 rows, with every grandchild mislabelled a
  // child.
  //
  // backfillAllDepths() walks the same recursive definition of truth the runtime
  // write paths use, so boot and steady state cannot disagree on what a root is.
  // Still idempotent — it recomputes rather than patches — so a NON-ZERO count
  // after a clean boot is a signal: something wrote depth without maintaining it.
  {
    const fixed = backfillAllDepths(db)
    if (fixed > 0) console.log(`[db] transitive depth backfill: corrected ${fixed} row(s)`)
  }

  db.exec("CREATE INDEX IF NOT EXISTS idx_objectives_workspace ON objectives(workspace)")

  // Per-workspace permission flags (additive migrations — idempotent)
  const uwCols = db.prepare("PRAGMA table_info(user_workspaces)").all() as { name: string }[]
  const uwNames = new Set(uwCols.map(c => c.name))
  if (!uwNames.has('can_use_jarvis')) {
    db.exec("ALTER TABLE user_workspaces ADD COLUMN can_use_jarvis INTEGER NOT NULL DEFAULT 1")
  }
  if (!uwNames.has('objective_visibility')) {
    // SQLite ADD COLUMN can't add a CHECK constraint after creation, so we just
    // store the text and enforce the enum at the application layer.
    db.exec("ALTER TABLE user_workspaces ADD COLUMN objective_visibility TEXT NOT NULL DEFAULT 'own'")
  }

  // Session intel columns on objectives
  if (!colNames.has('project')) {
    db.exec("ALTER TABLE objectives ADD COLUMN project TEXT")
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_objectives_project ON objectives(project)")

  if (!colNames.has('last_session_summary')) {
    db.exec("ALTER TABLE objectives ADD COLUMN last_session_summary TEXT")
  }
  if (!colNames.has('session_count')) {
    db.exec("ALTER TABLE objectives ADD COLUMN session_count INTEGER NOT NULL DEFAULT 0")
  }
  if (!colNames.has('total_cost_usd')) {
    db.exec("ALTER TABLE objectives ADD COLUMN total_cost_usd REAL NOT NULL DEFAULT 0")
  }
  if (!colNames.has('total_tokens')) {
    db.exec("ALTER TABLE objectives ADD COLUMN total_tokens INTEGER NOT NULL DEFAULT 0")
  }
  if (!colNames.has('has_blockers')) {
    db.exec("ALTER TABLE objectives ADD COLUMN has_blockers INTEGER NOT NULL DEFAULT 0")
  }
  if (!colNames.has('task_count')) {
    db.exec("ALTER TABLE objectives ADD COLUMN task_count INTEGER NOT NULL DEFAULT 0")
  }
  if (!colNames.has('tasks_passed')) {
    db.exec("ALTER TABLE objectives ADD COLUMN tasks_passed INTEGER NOT NULL DEFAULT 0")
  }
  if (!colNames.has('create_pr')) {
    db.exec("ALTER TABLE objectives ADD COLUMN create_pr INTEGER NOT NULL DEFAULT 0")
  }
  if (!colNames.has('branch_name')) {
    db.exec("ALTER TABLE objectives ADD COLUMN branch_name TEXT")
  }
  if (!colNames.has('pr_url')) {
    db.exec("ALTER TABLE objectives ADD COLUMN pr_url TEXT")
  }
  if (!colNames.has('pr_number')) {
    db.exec("ALTER TABLE objectives ADD COLUMN pr_number INTEGER")
  }
  if (!colNames.has('completion_goal')) {
    db.exec("ALTER TABLE objectives ADD COLUMN completion_goal TEXT")
  }
  if (!colNames.has('workflow_hint')) {
    db.exec("ALTER TABLE objectives ADD COLUMN workflow_hint TEXT")
  }
  if (!colNames.has('effort')) {
    db.exec("ALTER TABLE objectives ADD COLUMN effort TEXT NOT NULL DEFAULT 'normal'")
  }
  if (!colNames.has('model')) {
    db.exec("ALTER TABLE objectives ADD COLUMN model TEXT NOT NULL DEFAULT 'claude-opus-4-8'")
  }

  // Objective type — drives workflow routing (planning step + review gates).
  // Defaults to 'task' for existing rows so the lightest path is the upgrade
  // default; Hermes / users override per-objective.
  if (!colNames.has('type')) {
    db.exec("ALTER TABLE objectives ADD COLUMN type TEXT NOT NULL DEFAULT 'task'")
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_objectives_type ON objectives(type)")
  // Planning + AI review state — additive, nullable.
  if (!colNames.has('approved_plan')) {
    db.exec("ALTER TABLE objectives ADD COLUMN approved_plan TEXT")
  }
  if (!colNames.has('plan_approved_at')) {
    db.exec("ALTER TABLE objectives ADD COLUMN plan_approved_at TEXT")
  }
  if (!colNames.has('planning_session_id')) {
    db.exec("ALTER TABLE objectives ADD COLUMN planning_session_id TEXT")
  }
  if (!colNames.has('ai_review_verdict')) {
    db.exec("ALTER TABLE objectives ADD COLUMN ai_review_verdict TEXT")
  }
  if (!colNames.has('ai_review_findings')) {
    db.exec("ALTER TABLE objectives ADD COLUMN ai_review_findings TEXT")
  }
  if (!colNames.has('ai_review_session_id')) {
    db.exec("ALTER TABLE objectives ADD COLUMN ai_review_session_id TEXT")
  }

  // AI Review Stage (2026-06-06) — additive nullable columns. The state-poller
  // routes objectives through `ai_review` when `skip_ai_review` is 0; the
  // reviewer session writes its verdict into `objective_reviews` (below) and
  // the poller transitions accordingly. See
  // 2026-06-06-cc-ai-review-stage-architecture.md for the full design.
  if (!colNames.has('skip_ai_review')) {
    db.exec("ALTER TABLE objectives ADD COLUMN skip_ai_review INTEGER NOT NULL DEFAULT 0")
  }
  if (!colNames.has('acceptance_criteria')) {
    // JSON: [{id, criterion, type:'functional'|'visual'|'data', method:'browser'|'api'|'doc'}]
    // Reviewer generates on iteration 1, locks for iterations 2–3.
    db.exec("ALTER TABLE objectives ADD COLUMN acceptance_criteria TEXT")
  }
  if (!colNames.has('ai_review_iteration')) {
    db.exec("ALTER TABLE objectives ADD COLUMN ai_review_iteration INTEGER NOT NULL DEFAULT 0")
  }
  if (!colNames.has('test_cred_slug')) {
    db.exec("ALTER TABLE objectives ADD COLUMN test_cred_slug TEXT")
  }
  // KL-21 gate-rejection memory (obj-2509) — additive, nullable. `rejected_tree_sha`
  // records the head tree SHA of the objective's branch at the moment it was last
  // rejected (ai_review_verdict='fail'); `not_mergeable` is set when a re-review is
  // short-circuited because the tree is byte-identical to that rejection (so the LLM
  // auditor is never re-spawned on an unchanged-but-rejected tree). Behavior is
  // gated by the `gate_rejection_memory_enabled` flag (default OFF) — these columns
  // are inert until the flag is on. See services/governance.ts.
  if (!colNames.has('rejected_tree_sha')) {
    db.exec("ALTER TABLE objectives ADD COLUMN rejected_tree_sha TEXT")
  }
  if (!colNames.has('not_mergeable')) {
    db.exec("ALTER TABLE objectives ADD COLUMN not_mergeable INTEGER NOT NULL DEFAULT 0")
  }
  if (!colNames.has('delegate_mode')) {
    // Orchestration mode (2026-06-14): when 1, the owning agent acts as a
    // DELEGATOR — it decomposes the objective into worker objectives it spawns
    // and manages, rather than implementing directly. Orthogonal to
    // agent_context (a CTO/CFO/etc. objective can run in delegator mode and
    // keeps its agent persona).
    db.exec("ALTER TABLE objectives ADD COLUMN delegate_mode INTEGER NOT NULL DEFAULT 0")
  }
  if (!colNames.has('is_strategy')) {
    // Stored Strategy marker (obj 2383, 2026-06-28). A "Strategy" is the canonical
    // top tier of the hierarchy (Strategy > Objective > Sub-objective): a
    // persistent, top-level delegator that owns sub-objectives + jobs and re-wakes
    // to decide next steps. Until now "strategy" was INFERRED at query time
    // (parent_id IS NULL AND delegate_mode = 1), which collided with the
    // orthogonal `type` tag and made provenance/queries brittle. Promote it to a
    // stored marker written at creation so "all strategies" is a single-column
    // query. Kept SEPARATE from `type` (project/bug/task) on purpose: `type` is an
    // orthogonal kind-of-work tag, NOT a tier. See docs/terminology-glossary.md.
    db.exec("ALTER TABLE objectives ADD COLUMN is_strategy INTEGER NOT NULL DEFAULT 0")
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_objectives_is_strategy ON objectives(is_strategy)")
  if (!colNames.has('trust_stage')) {
    // Strategy progressive-trust ladder (obj 2511, 2026-06-29). Per-strategy
    // autonomy stage on the 4-rung ladder from the gating framework
    // (architecture/strategy-layer-gating-review-framework.md §2):
    //   0 = full-gate (every strategic decision parks for Operator — the safe default)
    //   1 = partial-autonomy   2 = supervised-autonomy   3 = autonomous
    // What is auto-allowed vs gated at each stage is a PURE function of this
    // column (decideTrustStageAction in services/strategy-governance.ts); the
    // column is inert scaffolding until the Stage-1+ wiring lands, so it is NOT
    // read in any hot path while CC_STRATEGY_TIER is off.
    //
    // DEFAULT 0 is the whole safety story: every pre-existing row AND every new
    // row starts fully gated, so adding the column changes no behavior. Unlike
    // the `depth` backfill above, NO row-UPDATE backfill is needed — 0 is already
    // the correct, safe value for every existing objective (none has earned
    // autonomy). The `colNames.has` guard makes the migration idempotent: a
    // re-run finds the column present and is a no-op.
    db.exec("ALTER TABLE objectives ADD COLUMN trust_stage INTEGER NOT NULL DEFAULT 0")
  }
  // Corrective one-time reset (obj 2835). obj 2383 shipped a backfill that stamped
  // is_strategy=1 on every top-level delegator (`delegate_mode=1 AND parent_id IS
  // NULL`) AND inferred the marker ungated at create/update time. Since nearly every
  // objective Operator runs is a top-level delegator, his entire history got wrongly
  // stamped is_strategy=1 and showed the STRATEGY badge. is_strategy is now an
  // EXPLICIT opt-in marker only (set at creation, never inferred). To clear the
  // bad historical data we reset is_strategy=0 for ALL currently-stamped rows.
  //
  // This is safe because the explicit-create path did not exist before this deploy,
  // so at migration time EVERY is_strategy=1 row is a wrongly-inferred one. We guard
  // the reset behind a one-time marker in `schema_meta` so it runs EXACTLY ONCE, on
  // the deploy that lands this fix. Strategies created EXPLICITLY after this point
  // are never touched (the reset has already run and never runs again), so the
  // marker becomes purely explicit going forward. Flag-independent: this corrects
  // stored data regardless of CC_STRATEGY_TIER.
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_meta (
      key TEXT PRIMARY KEY,
      value TEXT,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `)
  const RESET_KEY = 'is_strategy_explicit_reset_2835'
  const alreadyReset = db.prepare('SELECT 1 FROM schema_meta WHERE key = ?').get(RESET_KEY)
  if (!alreadyReset) {
    const reset = db.prepare('UPDATE objectives SET is_strategy = 0 WHERE is_strategy = 1').run()
    db.prepare('INSERT INTO schema_meta (key, value) VALUES (?, ?)').run(RESET_KEY, String(reset.changes))
  }
  if (!colNames.has('reconcile_sig')) {
    // Durable wake-storm guard (2026-06-21): the per-delegator child-state
    // "signature" the reconcile safety net (state-poller.reconcileDelegators)
    // last nudged for. Persisting it across restarts stops an all-done delegator
    // parked in `review` (awaiting Operator's accept) from being spuriously re-woken
    // on every server restart — each spurious wake spawned a ~$7 [child-complete]
    // session. NULL until the reconcile pass first records a signature; cleared
    // when the delegator reaches `done`. See
    // 2026-06-21-durable-reconcile-wake-storm-guard.md.
    db.exec("ALTER TABLE objectives ADD COLUMN reconcile_sig TEXT")
  }
  if (!colNames.has('backstop_sig')) {
    // Durable no-progress circuit breaker for the delegator liveness backstop
    // (obj 707460). Sibling of `reconcile_sig` above, for the OTHER sweep:
    // `sweepWedgedDelegators` is time-throttled and deliberately NOT
    // signature-gated, so it had no convergence condition and re-nudged a
    // permanently-stuck delegator every DELEGATOR_BACKSTOP_MS forever (obj
    // 706967: 82 sessions / 61 no-ops / ~31-min metronome for 33+ hours).
    // `backstop_sig` is the child-state + durable-write signature observed at the
    // last backstop wake; `backstop_noprogress` counts consecutive wakes where it
    // did not change. Both live on the ROW, not in a Map, because the loop
    // outlives any single server process. See lib/backstop-progress.ts.
    db.exec("ALTER TABLE objectives ADD COLUMN backstop_sig TEXT")
  }
  if (!colNames.has('backstop_noprogress')) {
    db.exec("ALTER TABLE objectives ADD COLUMN backstop_noprogress INTEGER NOT NULL DEFAULT 0")
  }
  // Objective-lifecycle hardening (obj 700415).
  // `terminal_by_human`: set to 1 when a HUMAN ends an objective via the public
  //   surface (PATCH → done/review); cleared to 0 when a human explicitly reopens.
  //   Machine reactivation pathways consult it under CC_HUMAN_TERMINAL_GUARD
  //   (default OFF → dry-run). DEFAULT 0 = adding the column changes no behavior.
  // `deleted_at`: soft-delete tombstone (NULL = live). Only written when
  //   settings.soft_delete_enabled is on; list/tree endpoints hide non-null rows
  //   unless ?include_deleted=1. Default hard-delete behavior is unchanged.
  if (!colNames.has('terminal_by_human')) {
    db.exec("ALTER TABLE objectives ADD COLUMN terminal_by_human INTEGER NOT NULL DEFAULT 0")
  }
  if (!colNames.has('deleted_at')) {
    db.exec("ALTER TABLE objectives ADD COLUMN deleted_at TEXT")
  }
  // NOTE: The reviewer's session id is stored in `ai_review_session_id`
  // (the canonical, pre-existing column added earlier in this same migration
  // block). A short-lived duplicate `reviewer_session_id` column on objectives
  // was removed — the per-iteration `objective_reviews.reviewer_session_id`
  // column (below) is unrelated and remains correct.

  initAuditSchema(db)

  if (!colNames.has('created_by')) {
    db.exec("ALTER TABLE objectives ADD COLUMN created_by INTEGER REFERENCES users(id) ON DELETE SET NULL")
    // Backfill: assign all existing objectives to the first admin user
    const admin = db.prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1").get() as { id: number } | undefined
    if (admin) {
      db.exec(`UPDATE objectives SET created_by = ${admin.id} WHERE created_by IS NULL`)
    }
  }

  initSessionTablesSchema(db)

  // session_events CHECK expansion (2026-06-12): 'warning' added for AI-review
  // cap-out escalations. SQLite can't ALTER a CHECK constraint, so probe with
  // an insert and rebuild the table if the old constraint rejects 'warning'.
  let seNeedsRebuild = false
  try {
    db.exec("INSERT INTO session_events (session_id, objective_id, event_type, description) VALUES ('__warning_probe__', 0, 'warning', 'probe')")
    db.exec("DELETE FROM session_events WHERE session_id = '__warning_probe__'")
  } catch {
    seNeedsRebuild = true
  }
  if (seNeedsRebuild) {
    console.log("[db] Rebuilding session_events table to allow event_type 'warning'...")
    db.exec(`
      BEGIN;
      CREATE TABLE session_events_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        objective_id INTEGER NOT NULL,
        event_type TEXT NOT NULL CHECK(event_type IN ('decision','blocker','follow_up','error','milestone','warning')),
        description TEXT NOT NULL,
        metadata TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO session_events_new (id, session_id, objective_id, event_type, description, metadata, created_at)
        SELECT id, session_id, objective_id, event_type, description, metadata, created_at FROM session_events;
      DROP TABLE session_events;
      ALTER TABLE session_events_new RENAME TO session_events;
      CREATE INDEX IF NOT EXISTS idx_events_objective ON session_events(objective_id);
      CREATE INDEX IF NOT EXISTS idx_events_type ON session_events(event_type);
      CREATE INDEX IF NOT EXISTS idx_events_created ON session_events(created_at);
      COMMIT;
    `)
  }

  initMentorSchema(db)

  initWorkspacesSchema(db)

  initReviewsSchema(db)

  // ── Strategy decision gate (obj 2385, 2026-06-28) ──────────────────────────
  // Broaden objective_reviews to store a strategy node's Stage-0 Decision
  // Request as a review row: mode='decision' (a fourth review surface alongside
  // browser/api/doc/noop) with verdict='pending' while it awaits Operator's
  // confirm/deny, then 'pass' (approved) / 'fail' (denied). This REUSES the
  // reviews table per the strategy-layer gating design (decision history,
  // review history, and the false-pass join all stay in one place) instead of a
  // parallel table. getFalsePassRate is unaffected — it counts verdict='pass'
  // only, and approved-decision rows on strategy objectives are a deliberate,
  // negligible addition to that denominator. SQLite cannot ALTER a CHECK, so
  // detect (the table's stored SQL lacks the new literals) and rebuild, mirroring
  // the objectives status rebuild above. Runs after every objective_reviews
  // column migration so the rebuild preserves the full current column set.
  {
    const reviewSql = (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='objective_reviews'").get() as { sql: string } | undefined)?.sql || ''
    if (!reviewSql.includes("'decision'") || !reviewSql.includes("'pending'")) {
      console.log('[db] Rebuilding objective_reviews to allow decision mode + pending verdict (obj 2385)...')
      const rcols = db.prepare("PRAGMA table_info(objective_reviews)").all() as { name: string; type: string; dflt_value: string | null; notnull: number; pk: number }[]
      const rNames2 = rcols.map(c => c.name)
      const rList = rNames2.join(', ')
      const rDefs = rcols.map(c => {
        if (c.name === 'id') return 'id INTEGER PRIMARY KEY AUTOINCREMENT'
        if (c.name === 'mode') return "mode TEXT NOT NULL CHECK(mode IN ('browser','api','doc','noop','decision'))"
        if (c.name === 'verdict') return "verdict TEXT NOT NULL CHECK(verdict IN ('pass','fail','blocked','pending'))"
        const notNull = c.notnull ? ' NOT NULL' : ''
        let dflt = ''
        if (c.dflt_value !== null) {
          const v = String(c.dflt_value)
          const isLiteral = /^'.*'$/.test(v) || /^-?\d+(\.\d+)?$/.test(v) || /^(NULL|CURRENT_TIMESTAMP|CURRENT_DATE|CURRENT_TIME)$/i.test(v)
          dflt = isLiteral ? ` DEFAULT ${v}` : ` DEFAULT (${v})`
        }
        return `${c.name} ${c.type}${notNull}${dflt}`
      }).join(',\n        ')
      db.exec(`
        BEGIN;
        CREATE TABLE objective_reviews_new (
          ${rDefs}
        );
        INSERT INTO objective_reviews_new (${rList}) SELECT ${rList} FROM objective_reviews;
        DROP TABLE objective_reviews;
        ALTER TABLE objective_reviews_new RENAME TO objective_reviews;
        CREATE INDEX IF NOT EXISTS idx_reviews_objective ON objective_reviews(objective_id);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_reviews_obj_iter ON objective_reviews(objective_id, iteration);
        COMMIT;
      `)
    }
  }

  // `gate_false_pass` — one row per FALSE PASS event (ROADMAP ST2, 2026-06-17).
  // When a `pass`-gated objective (most-recent objective_reviews verdict = 'pass')
  // is reopened out of `done`, we record that the AI-review gate let through work
  // that turned out to be incomplete. Each row links the reopen back to the prior
  // passing review (`review_id`), making the gate's false-pass rate MEASURABLE per
  // workspace — the baseline metric every later loop-engineering wave proves against.
  // Append-only; never updated. Insert is guarded to fire once per reopen event.
  //
  // obj-2376 (Rec #2): a `source` discriminator distinguishes how a false pass was
  // detected — 'reopen' (a HUMAN reopened a done objective; the original cold,
  // reactive signal) vs 'canary' (the anti-signal canary harness fed a KNOWN-BAD
  // Tier-1 fixture through the real gate and it was NOT rejected — a proactive
  // escape). `objective_id`/`review_id` are NULLABLE because a canary escape has no
  // real objective/review to link; `canary_id` names the fixture instead. The
  // human-reopen false-pass RATE (false-pass.ts) filters to source='reopen' so
  // canary rows can never corrupt the reactive metric.
  db.exec(`
    CREATE TABLE IF NOT EXISTS gate_false_pass (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      objective_id INTEGER REFERENCES objectives(id) ON DELETE CASCADE,
      review_id INTEGER REFERENCES objective_reviews(id) ON DELETE CASCADE,
      workspace TEXT NOT NULL,
      agent_context TEXT,
      source TEXT NOT NULL DEFAULT 'reopen' CHECK(source IN ('reopen','canary')),
      canary_id TEXT,
      reopened_at TEXT NOT NULL DEFAULT (datetime('now')),
      prior_verdict_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_false_pass_objective ON gate_false_pass(objective_id);
    CREATE INDEX IF NOT EXISTS idx_false_pass_workspace ON gate_false_pass(workspace);
  `)
  // NOTE: the index on `source` is intentionally NOT created here. On a PRE-2376 DB
  // the table already exists WITHOUT a `source` column, so `CREATE TABLE IF NOT
  // EXISTS` above is a no-op and creating an index on `source` in this same block
  // throws `SQLITE_ERROR: no such column: source` — which crash-loops the server on
  // boot (incident 2026-06-29: the running platform was down on exactly this). The
  // source index is created UNCONDITIONALLY after the add-`source` migration below,
  // so it works for both fresh DBs and rebuilt pre-2376 DBs.

  // Migration (obj-2376): rebuild gate_false_pass to add `source`/`canary_id` and
  // drop the NOT NULL on objective_id/review_id for pre-2376 DBs. SQLite can't
  // ALTER a column's NOT NULL, so we rebuild via the codebase's standard
  // create-new → copy → rename pattern. Existing rows are all human reopens, so
  // they get source='reopen'. (Prod currently has 0 rows; the copy is a no-op there
  // but the migration is correct for any populated DB.)
  {
    const fpCols = db.prepare('PRAGMA table_info(gate_false_pass)').all() as { name: string }[]
    if (!fpCols.some(c => c.name === 'source')) {
      console.log("[db] Rebuilding gate_false_pass to add source/canary_id (obj-2376)...")
      db.exec(`
        DROP TABLE IF EXISTS gate_false_pass_new;
        CREATE TABLE gate_false_pass_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          objective_id INTEGER REFERENCES objectives(id) ON DELETE CASCADE,
          review_id INTEGER REFERENCES objective_reviews(id) ON DELETE CASCADE,
          workspace TEXT NOT NULL,
          agent_context TEXT,
          source TEXT NOT NULL DEFAULT 'reopen' CHECK(source IN ('reopen','canary')),
          canary_id TEXT,
          reopened_at TEXT NOT NULL DEFAULT (datetime('now')),
          prior_verdict_at TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        INSERT INTO gate_false_pass_new
          (id, objective_id, review_id, workspace, agent_context, source, canary_id, reopened_at, prior_verdict_at, created_at)
          SELECT id, objective_id, review_id, workspace, agent_context, 'reopen', NULL, reopened_at, prior_verdict_at, created_at
            FROM gate_false_pass;
        DROP TABLE gate_false_pass;
        ALTER TABLE gate_false_pass_new RENAME TO gate_false_pass;
        CREATE INDEX IF NOT EXISTS idx_false_pass_objective ON gate_false_pass(objective_id);
        CREATE INDEX IF NOT EXISTS idx_false_pass_workspace ON gate_false_pass(workspace);
      `)
    }
  }
  // The `source` index is created here — AFTER the column is guaranteed to exist
  // (either from the fresh-DB CREATE TABLE above, or from the rebuild migration just
  // run for a pre-2376 DB). Unconditional + idempotent. Splitting it out of the
  // initial CREATE block is the fix for the boot-crash incident (2026-06-29).
  db.exec('CREATE INDEX IF NOT EXISTS idx_false_pass_source ON gate_false_pass(source)')

  initGatesSchema(db)

  initKitchenLoopSchema(db)

  // routines.strategy_objective_id (obj 2384) — nullable link making a routine
  // OWNED & STEERED by a Strategy node (a delegate_mode objective). When set,
  // fireRoutine spawns the run-objective as a CHILD of that strategy (parent_id),
  // and on completion the run's summary is appended to the strategy's rolling
  // NOTES.md context (see services/delegation.ts appendChildResult, reused via the
  // continuation seam). Plain INTEGER (no hard FK) to mirror routine_id and keep the
  // status-rebuild path clean. NULL ⇒ a standalone routine — byte-identical to the
  // pre-2384 cron→one-off-objective behavior.
  {
    const routineCols = new Set(
      (db.prepare('PRAGMA table_info(routines)').all() as { name: string }[]).map(c => c.name),
    )
    if (!routineCols.has('strategy_objective_id')) {
      db.exec('ALTER TABLE routines ADD COLUMN strategy_objective_id INTEGER')
    }
    db.exec('CREATE INDEX IF NOT EXISTS idx_routines_strategy ON routines(strategy_objective_id)')
  }

  initRuntimeSchema(db)

  // objectives.routine_id — traceability link from routine-spawned objectives
  // back to their routine. Plain INTEGER (no FK) so the status-rebuild path
  // above re-emits it cleanly.
  if (!colNames.has('routine_id')) {
    db.exec('ALTER TABLE objectives ADD COLUMN routine_id INTEGER')
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_objectives_routine ON objectives(routine_id)')

  // objectives.job_disposition / job_review_note — the Jobs surface's disposition
  // layer. A "job" is a routine-spawned objective (routine_id IS NOT NULL). When
  // a job session finishes it POSTs its disposition to
  // /api/internal/objectives/:id/job-disposition. 'complete' (the default, so
  // un-instrumented legacy runs land sanely) or 'needs_review' (the run has a
  // question or surfaced a system-improvement opportunity). job_review_note is a
  // short operator-facing reason shown on Needs-Review cards. Orthogonal to
  // status — disposition describes the *outcome*, status the worker lifecycle.
  if (!colNames.has('job_disposition')) {
    db.exec('ALTER TABLE objectives ADD COLUMN job_disposition TEXT')
  }
  if (!colNames.has('job_review_note')) {
    db.exec('ALTER TABLE objectives ADD COLUMN job_review_note TEXT')
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_objectives_job_disposition ON objectives(job_disposition)')

  // objectives.source_job_id — backlink from a board objective to the job
  // (routine-spawned objective) that created it via an in-thread reply handoff.
  // Lets the Jobs board show "spawned objective #N" on the originating job card.
  if (!colNames.has('source_job_id')) {
    db.exec('ALTER TABLE objectives ADD COLUMN source_job_id INTEGER')
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_objectives_source_job ON objectives(source_job_id)')

  // objectives.origin + objectives.strategy_id — explicit provenance (obj 2386,
  // 2026-06-29). Until now provenance was INFERRED: a delegator-spawned
  // sub-objective and a human-linked sub-objective were indistinguishable (both
  // had a parent_id whose parent.delegate_mode=1), and created_by/routine_id/
  // source_job_id did not discriminate manual-vs-auto. Promote provenance to two
  // stored, additive columns written at INSERT:
  //   - origin: how the objective was created (manual|strategy|routine|job_reply).
  //   - strategy_id: the Strategy (is_strategy=1) this objective belongs to /
  //     is associated with. Inherited from the parent chain at insert, OR set
  //     explicitly on a MANUAL objective (even when parent_id IS NULL) so Operator
  //     can associate a hand-created objective with a strategy and still see it.
  // Both default such that absence preserves prior behavior (origin='manual',
  // strategy_id=NULL). See docs/terminology-glossary.md.
  if (!colNames.has('origin')) {
    db.exec("ALTER TABLE objectives ADD COLUMN origin TEXT NOT NULL DEFAULT 'manual'")
  }
  if (!colNames.has('strategy_id')) {
    db.exec('ALTER TABLE objectives ADD COLUMN strategy_id INTEGER')
  }
  // One-time idempotent backfill of origin. Guarded on origin='manual' (the
  // column default), so each branch only stamps rows not yet classified and
  // re-running is a no-op. Precedence routine > job_reply > strategy > manual:
  //   - routine_id IS NOT NULL          => 'routine'   (routine-spawned job)
  //   - source_job_id IS NOT NULL       => 'job_reply' (spawned from a job reply)
  //   - parent is a delegator           => 'strategy'  (delegator-decomposed)
  //   - else                            => 'manual'    (already the default)
  db.exec("UPDATE objectives SET origin = 'routine' WHERE origin = 'manual' AND routine_id IS NOT NULL")
  db.exec("UPDATE objectives SET origin = 'job_reply' WHERE origin = 'manual' AND source_job_id IS NOT NULL")
  db.exec(`UPDATE objectives SET origin = 'strategy'
           WHERE origin = 'manual' AND parent_id IN (
             SELECT id FROM objectives WHERE delegate_mode = 1
           )`)
  // Backfill strategy_id: associate each objective with its nearest Strategy
  // ancestor (is_strategy=1) by walking the parent chain. Idempotent — only
  // fills rows where strategy_id IS NULL. Done in JS for the recursive walk.
  backfillStrategyIds(db)
  db.exec('CREATE INDEX IF NOT EXISTS idx_objectives_strategy ON objectives(strategy_id)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_objectives_origin ON objectives(origin)')

  // Composite indexes backing the slimmed board LIST (obj 700512): the default
  // list filters `status != 'done'` (and the on-demand path `status = 'done'`)
  // then sorts `updated_at DESC`; the workspace-scoped board adds `workspace = ?`.
  // These cover the filter+sort so neither query full-scans the 2k-row table.
  db.exec('CREATE INDEX IF NOT EXISTS idx_objectives_status_updated ON objectives(status, updated_at DESC)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_objectives_workspace_updated ON objectives(workspace, updated_at DESC)')

  // PARTIAL index for the DEFAULT board list (obj 700585, updated obj 700872).
  // The default query is now
  //   `WHERE status NOT IN ('done', 'cancelled') AND deleted_at IS NULL ORDER BY updated_at DESC`
  // — cancelled joined done as hidden-by-default on the board (obj 700872), so the
  // default payload excludes both terminal sinks (~2350 done + 62 cancelled rows).
  // The partial-index predicate MUST byte-match the query's WHERE for SQLite to
  // select it; the PRIOR predicate (`status != 'done'`) no longer matches, so a
  // stale index would silently regress the default query to `SCAN objectives |
  // USE TEMP B-TREE FOR ORDER BY` (a full scan + temp sort on every board load).
  // We therefore DROP the old index and materialize the new active-set predicate,
  // pre-sorted by updated_at DESC, so the planner reads it directly with no temp
  // sort and never touches a done/cancelled row (verified via EXPLAIN QUERY PLAN:
  // `SCAN objectives USING INDEX idx_obj_active_updated`, ~7ms → ~0.1ms). The DROP
  // + CREATE IF NOT EXISTS pair is idempotent. Preferred over a raw != so future
  // hidden terminal states can extend the IN-list in lockstep with the query.
  db.exec('DROP INDEX IF EXISTS idx_obj_active_updated')
  db.exec("CREATE INDEX IF NOT EXISTS idx_obj_active_updated ON objectives(updated_at DESC) WHERE status NOT IN ('done', 'cancelled') AND deleted_at IS NULL")

  // Poller hot-path indexes (2026-08-17 event-loop starvation). reconcileDelegators
  // runs `WHERE parent_id = ?` for every delegator and every child-reconciliation
  // pass on each poll tick, and `WHERE delegate_mode = 1` once per tick. Neither
  // column was indexed, so both did a full SCAN of the objectives table (~8k rows)
  // — dozens of full scans per tick, synchronously blocking HTTP accept (verified
  // via EXPLAIN QUERY PLAN: SCAN objectives → SEARCH USING INDEX). The delegate_mode
  // index is PARTIAL (delegate_mode = 1 is rare) so it stays tiny.
  db.exec('CREATE INDEX IF NOT EXISTS idx_objectives_parent ON objectives(parent_id)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_objectives_delegate ON objectives(delegate_mode) WHERE delegate_mode = 1')

  // Member board list + live-session poller (2026-08-23). Member visibility is
  // `created_by = ? OR assigned_user_id = ? OR id IN (objective_assignees)` and
  // the poller ticks `session_id IS NOT NULL` / `ai_review_session_id IS NOT NULL`.
  // None of those columns were indexed — full SCANs on the same table the
  // parent/delegate indexes already proved can starve the event loop.
  db.exec('CREATE INDEX IF NOT EXISTS idx_objectives_created_by ON objectives(created_by)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_objectives_assigned_user ON objectives(assigned_user_id)')
  db.exec("CREATE INDEX IF NOT EXISTS idx_objectives_live_session ON objectives(session_id) WHERE session_id IS NOT NULL")
  db.exec("CREATE INDEX IF NOT EXISTS idx_objectives_ai_review_session ON objectives(ai_review_session_id) WHERE ai_review_session_id IS NOT NULL")

  // objectives.scope_flags — running count of scope-bleed warnings raised against
  // this objective's session (obj 994). Surfaced on the board as a badge; advisory.
  if (!colNames.has('scope_flags')) {
    db.exec('ALTER TABLE objectives ADD COLUMN scope_flags INTEGER NOT NULL DEFAULT 0')
  }

  // objectives.ran_on_fallback — durable Fable→Opus fallback attribution marker
  // (audit 2026-07-04). Set to 1 by scanStreamTelemetry when a session that
  // requested a non-fallback model (e.g. claude-fable-5) actually ran on the
  // hard-coded --fallback-model (claude-opus-4-8). Previously detection was
  // warn-only and lived in an in-memory Set, so it was lost on restart and a
  // Fable objective could complete + pass review while `model` still said Fable.
  // This column survives restart and drives the card badge + correct cost/model
  // attribution; fallback_detected_at stamps the first detection.
  if (!colNames.has('ran_on_fallback')) {
    db.exec('ALTER TABLE objectives ADD COLUMN ran_on_fallback INTEGER NOT NULL DEFAULT 0')
  }
  if (!colNames.has('fallback_detected_at')) {
    db.exec('ALTER TABLE objectives ADD COLUMN fallback_detected_at TEXT')
  }
  // objectives.ran_model — positive, transcript-derived model attribution
  // (obj 701053). Comma-joined main-loop model ids observed across the
  // objective's sessions (e.g. 'claude-fable-5' or
  // 'claude-fable-5,claude-opus-4-8'), written by scanStreamTelemetry.
  // Complements ran_on_fallback: users can CONFIRM the requested model ran,
  // not just be warned when it didn't.
  if (!colNames.has('ran_model')) {
    db.exec('ALTER TABLE objectives ADD COLUMN ran_model TEXT')
  }

  initLeasesSchema(db)

  // Seed routines — both DISABLED (enabled=0); Operator flips them on after review.
  const seedRoutines: Array<{ name: string; cron_expr: string; template: Record<string, unknown>; enabled?: number }> = [
    {
      name: 'morning-briefing',
      cron_expr: '3 6 * * *',
      template: {
        title: 'Morning briefing',
        description: [
          'Compose the daily morning brief.',
          '',
          '1. GET http://localhost:3002/api/jarvis/briefing for board state and open loops.',
          '2. Write a concise brief covering: board state (working / blocked / needs-review), stale items, and account/budget status.',
          "3. Write it to /home/operator/ai-workspace/briefings/YYYY-MM-DD.md using today's date (create the directory if needed).",
          '4. If a Telegram/Hermes send path is available, send the brief there too; otherwise the file is enough.',
        ].join('\n'),
        agent_context: 'cto',
        workspace: 'example',
        project: 'command-center-infra',
        category: 'operations',
        completion_goal: 'Briefing file exists at /home/operator/ai-workspace/briefings/<today>.md covering board state, stale items, and account/budget status.',
        workflow_hint: null,
        effort: 'normal',
        model: 'claude-opus-4-8',
        type: 'task',
      },
    },
    {
      name: 'docs-breathe',
      cron_expr: '15 6 * * *',
      template: {
        title: 'Living product docs — breathe',
        description: [
          'Keep product docs true. Do not write a changelog. Do not touch architecture catalogs unless a user-visible behavior moved.',
          '',
          'Convention: docs/product/README.md (sentence + paragraph + TOC), 01-what-it-is.md (one page + overview mermaid), 02-how-it-works.md (loop mermaid), 07-data.md (ER mermaid + table inventory). Spec: docs/product/LIVING.md.',
          '',
          '1. GET http://localhost:3002/api/internal/repos?living=1 — linked repos with living docs on and a disk path.',
          '2. For THIS repo (command-center-infra): git log --since=yesterday.0:00 --oneline; also note Board cards with project=command-center-infra that moved to done since yesterday.',
          '3. Diff SQLite tables: rg -o "CREATE TABLE IF NOT EXISTS ([a-z_]+)" app/server/src/db/schema -r "$1" | sort -u  vs the inventory in docs/product/07-data.md.',
          '4. If nothing product-facing changed AND the table inventory matches: make no file edits, say so, finish.',
          '5. If nav/auth/engines/a user flow/tables changed: edit docs/product/ so a visual person and a language person both get the truth. Always keep the mermaid in 01 and 02 and the ER + inventory in 07-data.md current. Open/update the PR (create_pr is on).',
          '6. For every OTHER living repo in the list whose docs/product exists: spawn a sibling Board card via POST http://localhost:3002/api/internal/objectives with workspace, project=repo name, create_pr=true, model claude-sonnet-4-6, title "Living docs — {name}", description pointing at that checkout and LIVING.md (flowchart + 07-data required). Do not edit those live checkouts from this session.',
          '7. If a living repo has a path but no docs/product yet, spawn the same sibling to stub README.md + 01-what-it-is.md (with mermaid) + 07-data.md only — do not invent a novel wiki.',
        ].join('\n'),
        agent_context: 'cto',
        workspace: 'example',
        project: 'command-center-infra',
        category: 'operations',
        completion_goal: 'Product docs in docs/product/ match yesterday’s user-visible product, or an explicit no-op if nothing changed. Other living repos either skipped or have a sibling PR card.',
        workflow_hint: null,
        effort: 'normal',
        model: 'claude-sonnet-4-6',
        type: 'task',
        create_pr: true,
      },
      enabled: 1,
    },
    {
      name: 'board-hygiene',
      cron_expr: '7 * * * *',
      template: {
        title: 'Board hygiene sweep',
        description: [
          'Audit the Command Center board for hygiene issues.',
          '',
          '1. List objectives via GET http://localhost:3002/api/internal/objectives.',
          '2. Flag: queue items idle >3 days (updated_at), review items unattended >24h, and working objectives whose session is dead.',
          '3. Write a short digest to /home/operator/ai-workspace/briefings/hygiene-latest.md (overwrite; create the directory if needed).',
        ].join('\n'),
        agent_context: 'general',
        workspace: 'example',
        project: 'command-center-infra',
        category: 'operations',
        completion_goal: 'hygiene-latest.md is overwritten with a current digest of stale queue items, unattended reviews, and dead working sessions.',
        workflow_hint: null,
        effort: 'normal',
        model: 'claude-opus-4-8',
        type: 'task',
      },
    },
  ]
  const insertRoutine = db.prepare(
    'INSERT OR IGNORE INTO routines (name, cron_expr, objective_template, enabled) VALUES (?, ?, ?, ?)'
  )
  for (const r of seedRoutines) {
    insertRoutine.run(r.name, r.cron_expr, JSON.stringify(r.template), r.enabled ?? 0)
  }
  // Keep the living-docs Job prompt aligned with this repo (INSERT OR IGNORE
  // would leave a stale template from the first boot). Does not flip enabled.
  const breathe = seedRoutines.find(r => r.name === 'docs-breathe')
  if (breathe) {
    db.prepare('UPDATE routines SET objective_template = ?, cron_expr = ? WHERE name = ?')
      .run(JSON.stringify(breathe.template), breathe.cron_expr, 'docs-breathe')
  }

  initModelsSchema(db)

  initTokensSchema(db)

  initSecretsSchema(db)

  // ── Universal Development — Phase 0 (obj-704214) ─────────────────────────
  // The canonical, cross-platform store for development items (bugs / features
  // / improvements / chores) and the curated changelog. Collapses Weight
  // Supply's `portal_feedback` and Example3's `dev_feedback` into ONE table in
  // CC, so every platform's Development board is served from here.
  //
  // Spec: ~/second-brain/workspaces/personal/projects/universal-development-schema.md
  // (§2.1-§2.6). Phase-0 plan: universal-development-migration.md §1.1-§1.2.
  //
  // Purely additive. Nothing below drops, renames or rewrites an existing
  // table; the 5 changelog_entries columns are PRAGMA-guarded ALTERs in the
  // same idiom as the objectives columns at :193-206, so a re-boot is a no-op.
  reconcileWorkspaceIntegrationsShape(db)
  initDevelopmentSchema(db)
  seedDevelopmentRegistry(db)
  initDsrSchema(db)

  // ── Projects (obj-708808) ────────────────────────────────────────────────
  // A "project" is a named subfolder INSIDE a workspace that objectives belong
  // to — it is the board's third-level organizer (org → project → objective).
  // IMPORTANT: this is ENTIRELY DISTINCT from `objectives.project` (the REPO
  // LINK column, e.g. 'command-center-infra') — do not confuse the two.
  // The new column is `objectives.project_id` referencing `projects.id`.
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace   TEXT    NOT NULL,
      name        TEXT    NOT NULL,
      description TEXT,
      color       TEXT,
      sort_order  INTEGER NOT NULL DEFAULT 0,
      archived    INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_workspace_name ON projects(workspace, name);
    CREATE INDEX        IF NOT EXISTS idx_projects_workspace_archived ON projects(workspace, archived);
  `)
  // objectives.project_id — nullable FK to projects.id. ON DELETE SET NULL keeps
  // the objective alive; it just loses its project association when a project is
  // deleted (the DELETE endpoint null-outs manually before dropping the row, so
  // the FK behaviour is a safety belt).
  if (!colNames.has('project_id')) {
    db.exec('ALTER TABLE objectives ADD COLUMN project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL')
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_objectives_workspace_project ON objectives(workspace, project_id)')

  return db
}

/**
 * Reconcile `workspace_integrations` to the shape this repo already declares.
 *
 * WHY THIS EXISTS. The CREATE TABLE at :1079-1091 declares
 * `(kind, config, status, error, UNIQUE(workspace,kind))`, and
 * `services/workspace-integrations.ts:81-136` queries `kind` and `error`. But
 * `CREATE TABLE IF NOT EXISTS` never alters an existing table, so the LIVE
 * production database still carries the ORIGINAL shape it was created with:
 *
 *   provider TEXT NOT NULL CHECK(provider IN ('github','posthog')),
 *   secret, last_error, last_validated_at,
 *   status TEXT DEFAULT 'connected' CHECK(status IN ('connected','invalid')),
 *   UNIQUE(workspace, provider)
 *
 * Verified 2026-08-03 by reading a read-only copy of /app/data/command-center.db
 * and confirmed by src/__fixtures__/prod-schema-snapshot.sql. Consequences:
 *  - the pre-existing integrations service is ALREADY latently broken on prod
 *    (it selects a `kind` column that does not exist there);
 *  - the `kind='development'` seed below would throw at boot and CRASH-LOOP the
 *    server on deploy — which is exactly the failure the obj-1955 prod-schema
 *    guard test exists to catch, and it did catch it;
 *  - even writing to `provider` would fail, because 'development' violates that
 *    column's CHECK and 'disconnected' violates the status CHECK.
 *
 * NOTE the schema design doc asserts the column "is `kind`, not `provider`
 * (prior survey said `provider` — corrected here)". That correction is wrong
 * about production; the prior survey was right. This function is the bridge.
 *
 * SAFETY. Both `workspace_integrations` and `workspace_repos` are count(*)=0 on
 * prod (the Config-page UI that writes them has never been used), so the
 * rebuild moves no data — but rows are copied anyway rather than assumed empty.
 * It uses the same drop-and-recreate idiom already used for the `objectives`
 * CHECK-constraint rebuild at :80-107. Idempotent: once `kind` exists this is a
 * no-op, so a fresh DB (every test DB) never enters the branch at all.
 */
export function reconcileWorkspaceIntegrationsShape(db: Database.Database): void {
  const cols = (db.prepare('PRAGMA table_info(workspace_integrations)').all() as { name: string }[]).map(
    c => c.name,
  )
  if (cols.length === 0 || cols.includes('kind')) return // fresh/already-correct
  if (!cols.includes('provider')) return // unknown third shape — do not guess

  console.log('[db] Reconciling workspace_integrations: provider/last_error -> kind/error...')
  const carriesSecret = cols.includes('secret')
  db.exec(`
    CREATE TABLE workspace_integrations_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace TEXT NOT NULL REFERENCES workspaces(slug) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      config TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'disconnected',
      error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(workspace, kind)
    );
    INSERT INTO workspace_integrations_new (id, workspace, kind, config, status, error, created_at, updated_at)
      SELECT id, workspace, provider, config, status, last_error, created_at, updated_at
        FROM workspace_integrations;
    DROP TABLE workspace_integrations;
    ALTER TABLE workspace_integrations_new RENAME TO workspace_integrations;
    CREATE INDEX IF NOT EXISTS idx_workspace_integrations_workspace ON workspace_integrations(workspace);
  `)
  if (carriesSecret) {
    // `secret` and `last_validated_at` are dropped: neither appears in this
    // repo's declared table nor in any query, and both are empty on prod. The
    // ingest credential deliberately does NOT use them — only sha256(token)
    // in config.ingest_token_hash is ever persisted (schema §2.6).
    console.log('[db] workspace_integrations: dropped unused legacy columns secret/last_validated_at')
  }
}

/**
 * Backfill objectives.strategy_id (obj 2386). For every objective with a NULL
 * strategy_id, walk up the parent chain to find the nearest Strategy ancestor
 * (is_strategy=1) and stamp its id. Idempotent: only NULL rows are filled, and
 * the walk is read-only per-row, so re-running after new rows exist is safe.
 * Done in JS rather than recursive SQL to keep the parent walk explicit and to
 * avoid relying on SQLite recursive-CTE availability in the bundled build.
 */
function backfillStrategyIds(database: Database.Database): void {
  const rows = database
    .prepare('SELECT id, parent_id, is_strategy FROM objectives')
    .all() as Array<{ id: number; parent_id: number | null; is_strategy: number }>
  const byId = new Map<number, { id: number; parent_id: number | null; is_strategy: number }>()
  for (const r of rows) byId.set(r.id, r)

  const nearestStrategy = (start: { id: number; parent_id: number | null; is_strategy: number }): number | null => {
    // A Strategy's own strategy_id is itself; an objective whose ancestor is a
    // Strategy gets that ancestor. Guard against cycles with a visited set.
    let cur: { id: number; parent_id: number | null; is_strategy: number } | undefined = start
    const seen = new Set<number>()
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id)
      if (cur.is_strategy === 1) return cur.id
      cur = cur.parent_id != null ? byId.get(cur.parent_id) : undefined
    }
    return null
  }

  const update = database.prepare('UPDATE objectives SET strategy_id = ? WHERE id = ? AND strategy_id IS NULL')
  const tx = database.transaction((items: typeof rows) => {
    for (const r of items) {
      const sid = nearestStrategy(r)
      if (sid != null) update.run(sid, r.id)
    }
  })
  tx(rows)
}

/**
 * Resolve the strategy_id to stamp on a NEW objective at insert (obj 2386).
 * Precedence:
 *   1. An explicit strategyId (e.g. a manual objective the user associated with
 *      a Strategy) wins — but only if it references a real is_strategy=1 row.
 *   2. Otherwise inherit from the parent: if the parent IS a Strategy, the
 *      parent's id; else the parent's own strategy_id (chain inheritance).
 *   3. Otherwise NULL (unassociated).
 * Returns null on any invalid/dangling reference so a bad input degrades to
 * "unassociated" rather than throwing.
 */
export function resolveStrategyId(
  database: Database.Database,
  explicitStrategyId: number | null | undefined,
  parentId: number | null | undefined,
): number | null {
  if (explicitStrategyId != null) {
    const s = database
      .prepare('SELECT id FROM objectives WHERE id = ? AND is_strategy = 1')
      .get(explicitStrategyId) as { id: number } | undefined
    if (s) return s.id
    // Explicit but invalid — fall through to inheritance / null.
  }
  if (parentId != null) {
    const p = database
      .prepare('SELECT id, is_strategy, strategy_id FROM objectives WHERE id = ?')
      .get(parentId) as { id: number; is_strategy: number; strategy_id: number | null } | undefined
    if (p) return p.is_strategy === 1 ? p.id : p.strategy_id ?? null
  }
  return null
}

export { initDevelopmentSchema, seedDevelopmentRegistry } from './schema/development.js'
