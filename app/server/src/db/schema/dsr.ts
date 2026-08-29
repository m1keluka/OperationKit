/**
 * Daily Session Retrospective tables — extracted from db/index.ts
 * (behavior frozen). Additive CREATE TABLE + shipped-OFF settings flags.
 */
import type Database from 'better-sqlite3'

export function initDsrSchema(db: Database.Database): void {
  // ── Daily Session Retrospective (DSR), obj 705052 ────────────────────────
  // Additive ONLY (CREATE TABLE / INDEX IF NOT EXISTS, no ALTER of any existing
  // table) so this migration is a byte-for-byte no-op on an existing prod DB
  // apart from five new, initially-empty tables. Spec §D.2 of
  // ~/second-brain/workspaces/personal/decisions/
  // 2026-08-08-cc-daily-session-retrospective-loop-design.md
  //
  //   dsr_runs         — one row per retro run: the observability surface that
  //                      kitchen-loop conspicuously lacks after 9,262 iterations.
  //   dsr_candidates   — every detected candidate + its three lens verdicts.
  //   dsr_fingerprints — the never-re-propose ledger (proposed-ever, not posted-ever).
  //   dsr_signal_stats — per-signal precision + the self-tuned threshold (§C.6).
  //   dsr_lens_misses  — false positives attributed to a lens; ≥10 for one lens
  //                      raises ONE human-reviewed [retro-meta] objective rather
  //                      than self-editing a prompt (automated prompt mutation is
  //                      unreviewable drift).
  db.exec(`
    CREATE TABLE IF NOT EXISTS dsr_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      ended_at TEXT,
      mode TEXT NOT NULL DEFAULT 'shadow' CHECK(mode IN ('shadow','live')),
      target_day TEXT NOT NULL,
      watermark_at TEXT,
      sessions_scanned INTEGER NOT NULL DEFAULT 0,
      raw_signals INTEGER NOT NULL DEFAULT 0,
      above_floor INTEGER NOT NULL DEFAULT 0,
      lens_killed INTEGER NOT NULL DEFAULT 0,
      created INTEGER NOT NULL DEFAULT 0,
      held INTEGER NOT NULL DEFAULT 0,
      dropped_by_cap INTEGER NOT NULL DEFAULT 0,
      unclassified_followups INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0,
      notes TEXT
    );

    CREATE TABLE IF NOT EXISTS dsr_candidates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL REFERENCES dsr_runs(id) ON DELETE CASCADE,
      fingerprint TEXT NOT NULL,
      signal_type TEXT NOT NULL,
      confidence REAL NOT NULL,
      recurrence INTEGER NOT NULL DEFAULT 1,
      source_objective_id INTEGER,
      source_session_id TEXT,
      transcript_path TEXT,
      excerpt TEXT NOT NULL DEFAULT '',
      lens_l1 TEXT, lens_l2 TEXT, lens_l3 TEXT,
      verdict TEXT NOT NULL DEFAULT 'pending'
        CHECK(verdict IN ('pending','promoted','killed','held','routed_correction','dropped_cap')),
      created_objective_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_dsr_cand_fp   ON dsr_candidates(fingerprint);
    CREATE INDEX IF NOT EXISTS idx_dsr_cand_obj  ON dsr_candidates(created_objective_id);

    CREATE TABLE IF NOT EXISTS dsr_fingerprints (
      fingerprint TEXT PRIMARY KEY,
      signal_type TEXT NOT NULL,
      first_seen_run INTEGER,
      last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
      times_seen INTEGER NOT NULL DEFAULT 1,
      disposition TEXT NOT NULL CHECK(disposition IN ('promoted','killed','routed_correction'))
    );

    CREATE TABLE IF NOT EXISTS dsr_signal_stats (
      signal_type TEXT PRIMARY KEY,
      window_start TEXT NOT NULL,
      tp INTEGER NOT NULL DEFAULT 0,
      fp INTEGER NOT NULL DEFAULT 0,
      stale INTEGER NOT NULL DEFAULT 0,
      precision REAL,
      current_threshold REAL NOT NULL DEFAULT 0.60,
      threshold_updated_at TEXT,
      note TEXT
    );

    CREATE TABLE IF NOT EXISTS dsr_lens_misses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lens TEXT NOT NULL CHECK(lens IN ('L1','L2','L3')),
      candidate_id INTEGER REFERENCES dsr_candidates(id) ON DELETE CASCADE,
      board_outcome TEXT NOT NULL,
      detail TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      consumed_at TEXT
    );
  `)

  // DSR flags — shipped OFF (§D.3). `dsr_enabled` arms detection + the lens
  // gate in SHADOW; `dsr_live` is the objective-creation cutover and is Operator's
  // flip, not a worker's. `dsr_killed` is the instant disarm checked first.
  // Env (CC_DSR_*) overrides settings, fail-closed — the kitchen-loop idiom.
  db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('dsr_enabled', '0')").run()
  db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('dsr_live', '0')").run()
  db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('dsr_killed', '0')").run()

}
