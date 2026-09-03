/**
 * Usage, changelog, GitHub/Doppler/Google tokens, objective_prs —
 * extracted from db/index.ts (behavior frozen). Additive CREATE TABLE only.
 */
import type Database from 'better-sqlite3'

export function initTokensSchema(db: Database.Database): void {
  // Per-day usage attribution (2026-06-14). A session's cost/tokens split across
  // the Eastern calendar days its turns actually ran on — so multi-day sessions
  // don't dump their whole cost onto a single day (start or end). Populated from
  // transcript per-turn timestamps by session-intel; the cost dashboard +
  // account "today" stats aggregate this for exact per-period arbitrage figures.
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_usage_daily (
      session_id   TEXT NOT NULL,
      day          TEXT NOT NULL,          -- Eastern YYYY-MM-DD
      model        TEXT NOT NULL,
      account_id   TEXT,
      objective_id INTEGER,
      cost_usd     REAL NOT NULL DEFAULT 0,
      tokens       INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (session_id, day, model)
    );
    CREATE INDEX IF NOT EXISTS idx_usage_daily_day ON session_usage_daily(day);
    CREATE INDEX IF NOT EXISTS idx_usage_daily_account ON session_usage_daily(account_id, day);
  `)

  // Manual account attribution for sessions whose real account was never durably
  // recorded (historical sessions predating account capture). The cost is real
  // and counted in the totals regardless; this table only decides which account
  // column it lands in. backfillDailyUsage consults it as a fallback after
  // session_intel, so it survives every idempotent rebuild. Explicit + auditable
  // (the `reason` says why) + reversible (DELETE the rows + re-backfill → 'unknown').
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_account_override (
      session_id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      reason     TEXT
    );
  `)

  // ── Stakeholder changelog (obj 937) ─────────────────────────────────────
  // `changelog_entries` — the normalized "What's Shipping" feed. One row per
  // merged PR that is stakeholder-worthy, collected from an org-level GitHub
  // webhook (pull_request closed+merged) across your-org (+EXAMPLE2) repos.
  // Rich context (feature_brief, screenshots) is joined from objective_reviews
  // when the PR was audited by this command-center's harness loop; otherwise it
  // falls back to the PR body "What's shipping" field + an LLM translation pass.
  //   status: 'published' (live on the changelog) | 'draft' (collected, awaiting
  //   translation/screenshots) | 'skipped' (pure refactor/chore — not audience-worthy).
  //   category: feature | fix | improvement | infra (from conventional-commit / labels).
  //   screenshots / criteria: JSON arrays. body_stakeholder: translated plain-English copy.
  db.exec(`
    CREATE TABLE IF NOT EXISTS changelog_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo TEXT NOT NULL,                       -- owner/name e.g. your-org/command-center-infra
      pr_number INTEGER NOT NULL,
      pr_url TEXT NOT NULL,
      merge_commit_sha TEXT,
      platform TEXT NOT NULL,                   -- brand/platform label e.g. 'Command Center'
      author TEXT,                              -- GitHub login of the PR author
      merged_at TEXT NOT NULL,                  -- ISO timestamp the PR merged
      category TEXT NOT NULL DEFAULT 'feature', -- feature | fix | improvement | infra
      status TEXT NOT NULL DEFAULT 'draft',     -- published | draft | skipped
      title_eng TEXT NOT NULL DEFAULT '',       -- original engineering PR title
      headline TEXT NOT NULL DEFAULT '',        -- stakeholder-facing headline
      body_stakeholder TEXT NOT NULL DEFAULT '',-- plain-English description (translated)
      overview TEXT NOT NULL DEFAULT '',         -- how-it-works overview (translated)
      feature_brief TEXT NOT NULL DEFAULT '',   -- raw brief JSON from objective_reviews (audit source)
      screenshots TEXT NOT NULL DEFAULT '[]',    -- JSON array of public screenshot URLs
      objective_id INTEGER,                      -- linked cc objective (if audited here)
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(repo, pr_number)
    );
    CREATE INDEX IF NOT EXISTS idx_changelog_status_merged ON changelog_entries(status, merged_at DESC);
    CREATE INDEX IF NOT EXISTS idx_changelog_platform ON changelog_entries(platform);

    -- Per-user GitHub PAT for PR attribution (obj-2200 / W1).
    -- One token per user (PK=user_id). The PAT lives ONLY in token_encrypted
    -- (AES-256-GCM via services/crypto.ts); every API response exposes the
    -- masked last-4 + resolved identity, never the raw token. The decrypted
    -- value is read server-side at session spawn (W4) and at save-time
    -- validation. token_type leaves room for a future GitHub App ('app').
    CREATE TABLE IF NOT EXISTS user_github_tokens (
      user_id           INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      token_encrypted   TEXT    NOT NULL,                      -- crypto.encryptField(PAT); NEVER returned raw
      token_last4       TEXT    NOT NULL,                      -- masked display, e.g. "a1B2"
      github_login      TEXT    NOT NULL,                      -- resolved from GitHub /user at save
      github_user_id    INTEGER,                               -- numeric id; builds noreply email
      github_email      TEXT    NOT NULL,                      -- author/committer email (verified or noreply)
      scopes            TEXT,                                  -- observed scopes (csv) for diagnostics
      token_type        TEXT    NOT NULL DEFAULT 'pat_fine',   -- 'pat_fine' | 'pat_classic' | future 'app'
      created_at        TEXT    NOT NULL DEFAULT (datetime('now')),
      last_validated_at TEXT
    );

    -- Scoped, read-only Doppler service tokens for the spawn-env cutover
    -- (obj-2411 / Phase 0 of #1731). The blanket-admin-token model injects ONE
    -- personal admin Doppler token into every session; this map replaces it with
    -- ONE read-only service token per (workspace, config), selected by the spawning
    -- objective workspace. token_encrypted is AES-256-GCM via services/crypto.ts
    -- (same primitive as user_github_tokens) — the raw service token NEVER lands in
    -- the DB. token_last4 is for masked display/audit only. UNIQUE(workspace,config)
    -- is the upsert key. Rows are populated out-of-band by
    -- scripts/provision-scoped-doppler-tokens.ts (DRY-RUN by default, Mike-gated to
    -- mint live). The resolver getScopedDopplerTokenForWorkspace fails CLOSED (empty)
    -- when no row matches — a member session then simply gets no DOPPLER_TOKEN,
    -- never the admin token. This table is consulted ONLY when
    -- USE_SCOPED_DOPPLER_TOKENS is ON and a member-tier session spawns.
    CREATE TABLE IF NOT EXISTS doppler_scoped_tokens (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace       TEXT    NOT NULL,                          -- objective.workspace (e.g. 'example', 'example2')
      config          TEXT    NOT NULL DEFAULT 'prd',            -- Doppler config the token was minted from (provenance)
      token_encrypted TEXT    NOT NULL,                          -- crypto.encryptField(read-only service token); NEVER returned raw
      token_last4     TEXT    NOT NULL,                          -- masked display, e.g. "a1B2"
      doppler_project TEXT,                                      -- Doppler project the token is scoped to (provenance)
      note            TEXT,                                      -- optional human note (e.g. who minted, ticket)
      created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at      TEXT    NOT NULL DEFAULT (datetime('now')),
      UNIQUE(workspace, config)
    );
    CREATE INDEX IF NOT EXISTS idx_doppler_scoped_tokens_workspace ON doppler_scoped_tokens(workspace);

    -- Per-user Google Workspace OAuth connections (obj-706070). Replaces the
    -- single shared Mike credential (vault: 2026-06-12-hermes-google-suite-shared-
    -- credential) with one row per Command Center user: when a session runs for
    -- user X, X's Google credential is injected, never someone else's.
    --
    -- Deliberately a DEDICATED table mirroring user_github_tokens rather than a
    -- row in the generic "secrets" store: a Google connection is a STRUCTURED
    -- record (identity, granted scopes, an access token with an expiry that the
    -- refresh path rewrites, a last_error health field) that the connect UI reads
    -- as typed columns, not an opaque KV string. See docs/per-user-google-workspace.md.
    --
    -- refresh_token_encrypted / access_token_encrypted are AES-256-GCM via
    -- services/crypto.ts — the same primitive and key as user_github_tokens. No
    -- token material EVER leaves the server: routes return only the masked
    -- UserGoogleConnectionSummary.
    CREATE TABLE IF NOT EXISTS user_google_connections (
      user_id                 INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      google_email            TEXT    NOT NULL,                      -- resolved from the id_token / userinfo at connect
      google_sub              TEXT,                                  -- stable Google account id (identity, not a secret)
      refresh_token_encrypted TEXT    NOT NULL,                      -- offline-access refresh token; NEVER returned raw
      access_token_encrypted  TEXT,                                  -- cached short-lived access token; NEVER returned raw
      access_token_expires_at TEXT,                                  -- ISO expiry of the cached access token
      scopes                  TEXT    NOT NULL DEFAULT '',           -- space-separated granted scopes
      client_id               TEXT    NOT NULL DEFAULT '',           -- OAuth client the grant belongs to (provenance)
      connected_at            TEXT    NOT NULL DEFAULT (datetime('now')),
      last_refreshed_at       TEXT,
      last_error              TEXT                                   -- last refresh failure, surfaced as connection health
    );
  `)

  // objective_prs — per-objective PR log (obj 2300). An objective may open MANY
  // PRs over its life; objectives.pr_url/pr_number/branch_name stay as the
  // "latest/current" pointer (downstream remediation/preview-deploy/review depend
  // on them), while THIS table is the full history surfaced in the detail drawer.
  // UNIQUE(objective_id, pr_number) makes a re-report an upsert, not a duplicate.
  // `state` is freshened by the GitHub pull_request webhook (merged/closed).
  db.exec(`
    CREATE TABLE IF NOT EXISTS objective_prs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      objective_id INTEGER NOT NULL REFERENCES objectives(id) ON DELETE CASCADE,
      repo TEXT,
      pr_number INTEGER NOT NULL,
      pr_url TEXT,
      branch_name TEXT,
      title TEXT,
      state TEXT NOT NULL DEFAULT 'open',  -- open | merged | closed
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(objective_id, pr_number)
    );
    CREATE INDEX IF NOT EXISTS idx_objective_prs_objective ON objective_prs(objective_id);
    CREATE INDEX IF NOT EXISTS idx_objective_prs_repo_pr ON objective_prs(repo, pr_number);
  `)

  // Backfill: seed objective_prs from existing objectives that already carry a
  // linked PR (pr_number present) so past objectives' history isn't empty. Idempotent
  // via INSERT OR IGNORE against the UNIQUE(objective_id, pr_number) constraint — a
  // re-run inserts nothing new. State left at the 'open' default; the webhook
  // freshens merged/closed going forward. `repo` is parsed from pr_url when shaped
  // like github.com/<owner>/<name>/pull/<n>, else NULL.
  db.exec(`
    INSERT OR IGNORE INTO objective_prs (objective_id, repo, pr_number, pr_url, branch_name, title)
    SELECT
      o.id,
      CASE
        WHEN o.pr_url LIKE '%github.com/%/pull/%'
        THEN substr(
               o.pr_url,
               instr(o.pr_url, 'github.com/') + length('github.com/'),
               instr(o.pr_url, '/pull/') - (instr(o.pr_url, 'github.com/') + length('github.com/'))
             )
        ELSE NULL
      END,
      o.pr_number,
      o.pr_url,
      o.branch_name,
      o.title
    FROM objectives o
    WHERE o.pr_number IS NOT NULL
  `)

}
