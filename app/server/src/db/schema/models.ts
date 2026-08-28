/**
 * Rolodex threads + model registry — extracted from db/index.ts (behavior frozen).
 */
import type Database from 'better-sqlite3'
import { notify } from '../../services/notifier.js'

export function initModelsSchema(db: Database.Database): void {
  // rolodex_threads — per-chat history for the telegram-rolodex sibling +
  // /api/internal/rolodex/history. Existed in prod (created out-of-band) but
  // was never in initDb, so fresh installs + the test DB 500'd on first use.
  // Schema mirrors the live prod table exactly; IF NOT EXISTS is a no-op there.
  db.exec(`
    CREATE TABLE IF NOT EXISTS rolodex_threads (
      chat_id     TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL,
      history     TEXT NOT NULL DEFAULT '[]',
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `)

  // ── Model registry (2026-06-13) ─────────────────────────────────────────
  // DB-backed source of truth for selectable models + the default/planner.
  // Replaces hardcoded 'claude-fable-5' literals across the spawn path. Fable 5
  // + Mythos 5 were disabled by Anthropic on 2026-06-12 (US Commerce/BIS
  // export-control directive); Opus 4.8 is the new default + planner. The
  // registry lets a model be toggled off from the UI without a code change.
  db.exec(`
    CREATE TABLE IF NOT EXISTS models (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      engine TEXT NOT NULL DEFAULT 'claude' CHECK(engine IN ('claude', 'codex', 'grok')),
      enabled INTEGER NOT NULL DEFAULT 1,
      is_default INTEGER NOT NULL DEFAULT 0,
      is_planner INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 100,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    -- At most one default and one planner, enforced at the DB level.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_models_one_default ON models(is_default) WHERE is_default = 1;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_models_one_planner ON models(is_planner) WHERE is_planner = 1;
  `)
  // Existing DBs may still have CHECK(engine IN ('claude','codex')). Rebuild
  // before any grok insert (including first-seed on an empty-but-preexisting table).
  const grokAllowed = (() => {
    try {
      db.prepare("INSERT INTO models (id,label,engine,enabled,is_default,is_planner,sort_order) VALUES ('__grok_probe__','x','grok',0,0,0,999)").run()
      db.prepare("DELETE FROM models WHERE id = '__grok_probe__'").run()
      return true
    } catch {
      return false
    }
  })()
  if (!grokAllowed) {
    db.pragma('foreign_keys = OFF')
    db.exec(`
      DROP INDEX IF EXISTS idx_models_one_default;
      DROP INDEX IF EXISTS idx_models_one_planner;
      CREATE TABLE models_grok_mig (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        engine TEXT NOT NULL DEFAULT 'claude' CHECK(engine IN ('claude', 'codex', 'grok')),
        enabled INTEGER NOT NULL DEFAULT 1,
        is_default INTEGER NOT NULL DEFAULT 0,
        is_planner INTEGER NOT NULL DEFAULT 0,
        sort_order INTEGER NOT NULL DEFAULT 100,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO models_grok_mig SELECT id, label, engine, enabled, is_default, is_planner, sort_order, created_at, updated_at FROM models;
      DROP TABLE models;
      ALTER TABLE models_grok_mig RENAME TO models;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_models_one_default ON models(is_default) WHERE is_default = 1;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_models_one_planner ON models(is_planner) WHERE is_planner = 1;
    `)
    db.pragma('foreign_keys = ON')
  }
  // First-seed + one-time Fable→Opus cutover. Tied to the empty-table check so a
  // restart never clobbers Mike's later toggles.
  const modelCount = (db.prepare('SELECT COUNT(*) AS n FROM models').get() as { n: number }).n
  if (modelCount === 0) {
    const seedModel = db.prepare(
      'INSERT INTO models (id, label, engine, enabled, is_default, is_planner, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    seedModel.run('claude-opus-4-8', 'Opus 4.8', 'claude', 1, 1, 1, 10)
    seedModel.run('claude-sonnet-4-6', 'Sonnet 4.6', 'claude', 1, 0, 0, 20)
    seedModel.run('grok-4.6', 'Grok 4.6', 'grok', 1, 0, 0, 25)
    seedModel.run('gpt-5.5', 'GPT-5.5 (Codex)', 'codex', 1, 0, 0, 30)
    seedModel.run('gpt-5.4', 'GPT-5.4 (Codex)', 'codex', 1, 0, 0, 31)
    seedModel.run('gpt-5.4-mini', 'GPT-5.4-mini (Codex)', 'codex', 1, 0, 0, 32)
    seedModel.run('claude-fable-5', 'Fable 5 (unavailable — US gov ban 2026-06-12)', 'claude', 0, 0, 0, 40)
    // Repoint everything off the dead model in one shot: live objectives and the
    // JSON templates of seeded routines.
    db.exec("UPDATE objectives SET model = 'claude-opus-4-8' WHERE model = 'claude-fable-5'")
    db.exec("UPDATE routines SET objective_template = REPLACE(objective_template, 'claude-fable-5', 'claude-opus-4-8') WHERE objective_template LIKE '%claude-fable-5%'")
  }

  // Codex multi-model expansion (2026-06-13). The original single 'codex' row
  // always ran gpt-5.5 (Codex's own default). Replace it with explicit per-model
  // rows so the registry + board UI can pick the Codex model. Idempotent —
  // guarded on the legacy row's presence, so it runs at most once.
  const legacyCodex = db.prepare(
    "SELECT enabled, is_default, is_planner FROM models WHERE id = 'codex'"
  ).get() as { enabled: number; is_default: number; is_planner: number } | undefined
  if (legacyCodex) {
    const insCodex = db.prepare(
      "INSERT OR IGNORE INTO models (id, label, engine, enabled, is_default, is_planner, sort_order) VALUES (?, ?, 'codex', ?, 0, 0, ?)"
    )
    insCodex.run('gpt-5.5', 'GPT-5.5 (Codex)', legacyCodex.enabled, 30)
    insCodex.run('gpt-5.4', 'GPT-5.4 (Codex)', 1, 31)
    insCodex.run('gpt-5.4-mini', 'GPT-5.4-mini (Codex)', 1, 32)
    // Repoint existing codex objectives at the explicit default model.
    db.exec("UPDATE objectives SET model = 'gpt-5.5' WHERE model = 'codex'")
    // Drop the generic row first (clears any default/planner flag it held, so the
    // partial unique indexes stay satisfied), then transfer the role to gpt-5.5.
    db.exec("DELETE FROM models WHERE id = 'codex'")
    if (legacyCodex.is_default) db.prepare("UPDATE models SET is_default = 1, enabled = 1 WHERE id = 'gpt-5.5'").run()
    if (legacyCodex.is_planner) db.prepare("UPDATE models SET is_planner = 1, enabled = 1 WHERE id = 'gpt-5.5'").run()
  }

  // Opus 5 promotion (2026-07-24). Claude Opus 5 (`claude-opus-5` — dateless ID,
  // verified against platform.claude.com) shipped as the successor to Opus 4.8:
  // same $5/$25 pricing, 1M context, adaptive thinking, positioned for complex
  // agentic coding + enterprise work, and the explicit migration target from
  // Opus 4.8. Make it selectable AND promote it to default + planner (Opus 4.8
  // held both roles as the single strongest model; Opus 5 inherits that mantle).
  // Guarded on the row's absence so it runs exactly once — a later manual
  // reassignment of default/planner is never re-clobbered on the next boot. The
  // insert respects the partial unique indexes (one default, one planner) by
  // clearing the incumbent roles inside the same transaction before setting them.
  db.prepare(
    "INSERT OR IGNORE INTO models (id, label, engine, enabled, is_default, is_planner, sort_order) VALUES ('grok-4.6', 'Grok 4.6', 'grok', 1, 0, 0, 25)"
  ).run()

  const hasOpus5 = db.prepare("SELECT 1 FROM models WHERE id = 'claude-opus-5'").get()
  if (!hasOpus5) {
    db.transaction(() => {
      db.prepare(
        "INSERT INTO models (id, label, engine, enabled, is_default, is_planner, sort_order) VALUES ('claude-opus-5', 'Opus 5', 'claude', 1, 0, 0, 5)"
      ).run()
      db.prepare('UPDATE models SET is_default = 0 WHERE is_default = 1').run()
      db.prepare('UPDATE models SET is_planner = 0 WHERE is_planner = 1').run()
      db.prepare("UPDATE models SET is_default = 1, is_planner = 1, enabled = 1, updated_at = datetime('now') WHERE id = 'claude-opus-5'").run()
    })()
  }

  // Disabled-model rescue (2026-06-19, bug #836). Defense-in-depth safety net.
  // The 2026-06-13 registry cutover repointed existing objective row VALUES off
  // the dead 'claude-fable-5' but left the objectives.model column DEFAULT as
  // 'claude-fable-5' on the legacy prod DB. Any INSERT that omitted `model`
  // (auto-created PR reviews, meeting-queue items) therefore minted rows on a
  // DISABLED model, which the spawner never launches — stranding them in queue
  // and parking their parent delegator forever. The insert sites are now
  // explicit, but this boot-time pass still handles any objective currently
  // sitting on a DISABLED model (future-proof, not fable-specific).
  //
  // Attribution guard (audit 2026-07-04): NON-terminal work is no longer silently
  // repointed. Silently rebasing an in-flight Fable objective onto Opus is exactly
  // the attribution hole this objective closes — if Fable is ever re-banned (the
  // same export-control scenario that created this registry), live Fable work
  // would quietly become Opus with only a `[db]` log line. So for non-terminal
  // objectives we now raise a HIGH-severity alert (AlertBell) and leave the model
  // untouched, letting an operator re-enable the model or reassign deliberately.
  // Terminal `done` rows never spawn, so they are left untouched to preserve their
  // historical model attribution.
  try {
    const def = (db.prepare('SELECT id FROM models WHERE is_default = 1 LIMIT 1').get() as { id: string } | undefined)?.id
    if (def) {
      const stranded = db.prepare(
        `SELECT id, model FROM objectives
         WHERE status != 'done'
           AND model IN (SELECT id FROM models WHERE enabled = 0)
         ORDER BY id`
      ).all() as { id: number; model: string }[]
      if (stranded.length > 0) {
        const ids = stranded.map(o => `#${o.id}`).join(', ')
        const models = [...new Set(stranded.map(o => o.model))].join(', ')
        console.warn(
          `[db] ${stranded.length} non-terminal objective(s) sit on a DISABLED model (${models}): ${ids}. ` +
          `NOT auto-repointed — raising a high-severity alert (audit 2026-07-04). ` +
          `Re-enable the model or reassign manually (would-be default: ${def}).`,
        )
        // Raise via the existing notifier alert mechanism (same path drift-guard
        // uses). notify() writes the alert row synchronously (before its first
        // await) and then best-effort emails/broadcasts; we don't await it. The
        // notifier↔db import cycle is safe: both only call each other at runtime,
        // never at module-eval, so the bindings are resolved by the time initDb runs.
        void notify({
          severity: 'high',
          source: 'disabled-model-rescue',
          title: `${stranded.length} in-flight objective(s) on a disabled model`,
          message:
            `Objectives ${ids} requested model(s) [${models}] which are now disabled in the registry. ` +
            `They were NOT auto-repointed (that would silently convert their work to a different model and ` +
            `corrupt attribution). Re-enable the model or reassign these objectives manually. ` +
            `Registry default is ${def}.`,
          dedup_key: 'disabled-model-rescue:in-flight',
          url: 'https://cc.example.com',
        })
      }
    }
  } catch (err) {
    console.error('[db] disabled-model rescue failed (non-fatal):', err)
  }

}
