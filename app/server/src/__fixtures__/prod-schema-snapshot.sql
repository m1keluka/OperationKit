-- Production schema snapshot (command-center.db), schema-only, NO DATA.
-- Regenerate: docker exec -w /app/server command-center node -e "<dump sqlite_master>" (see ci-prod-schema docs).
-- Used by db/prod-schema-initdb.test.ts to run initDb() against the real prod shape.
CREATE TABLE activity_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL,
      workspace TEXT NOT NULL DEFAULT 'example',
      objective_id INTEGER REFERENCES objectives(id) ON DELETE SET NULL,
      task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
      session_id TEXT,
      event_type TEXT NOT NULL CHECK(event_type IN (
        'session_start', 'session_end', 'task_start', 'task_pass', 'task_fail',
        'progress', 'decision', 'blocker', 'file_change', 'milestone', 'error'
      )),
      title TEXT NOT NULL,
      detail TEXT,
      metadata TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
CREATE TABLE alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      severity TEXT NOT NULL DEFAULT 'normal' CHECK(severity IN ('normal', 'high', 'emergency')),
      source TEXT NOT NULL,
      title TEXT NOT NULL,
      message TEXT NOT NULL DEFAULT '',
      dedup_key TEXT,
      url TEXT,
      email_sent_at TEXT,
      acked_at TEXT,
      acked_by TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
CREATE TABLE blocked_objectives (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      objective_pattern TEXT NOT NULL,
      reason TEXT NOT NULL,
      since TEXT NOT NULL DEFAULT (datetime('now')),
      unblock_ticket TEXT,
      expires_at TEXT,
      resolved_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
CREATE TABLE branch_leases (
      branch_name  TEXT PRIMARY KEY,
      objective_id INTEGER NOT NULL,
      session_id   TEXT,
      tmux_name    TEXT,
      acquired_at  TEXT NOT NULL DEFAULT (datetime('now')),
      heartbeat_at TEXT NOT NULL DEFAULT (datetime('now')),
      released_at  TEXT
    );
CREATE TABLE canary_runs (
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
CREATE TABLE changelog_entries (
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
CREATE TABLE contacts_index (
      vault_path        TEXT PRIMARY KEY,
      name              TEXT NOT NULL,
      email             TEXT,
      phone             TEXT,
      company           TEXT,
      role              TEXT,
      tags              TEXT NOT NULL DEFAULT '[]',
      follow_up_days    INTEGER,
      last_interaction  TEXT,
      next_touchpoint   TEXT,
      confidence        TEXT NOT NULL DEFAULT 'high',
      workspace         TEXT,
      updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
    );
CREATE TABLE doppler_scoped_tokens (
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
CREATE TABLE external_check_remediations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      objective_id INTEGER NOT NULL,
      repo TEXT NOT NULL,
      pr_number INTEGER NOT NULL,
      check_name TEXT NOT NULL,
      head_sha TEXT NOT NULL,
      attempt INTEGER NOT NULL,
      escalated INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(repo, pr_number, check_name, head_sha)
    );
CREATE TABLE file_shares (
      token TEXT PRIMARY KEY,
      objective_id INTEGER NOT NULL,
      filename TEXT NOT NULL,
      label TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT,
      revoked INTEGER NOT NULL DEFAULT 0,
      hits INTEGER NOT NULL DEFAULT 0,
      last_accessed_at TEXT
    );
CREATE TABLE gate_false_pass (
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
CREATE TABLE gmail_triage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id TEXT NOT NULL UNIQUE,
      thread_id TEXT,
      from_address TEXT,
      subject TEXT,
      snippet TEXT,
      label TEXT NOT NULL CHECK(label IN ('live', 'junk')),
      classified_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
CREATE TABLE granola_action_items (
      id TEXT PRIMARY KEY,
      meeting_id TEXT REFERENCES granola_processed_meetings(id),
      status TEXT NOT NULL DEFAULT 'pending-review'
        CHECK(status IN ('pending-review', 'approved', 'dismissed')),
      title TEXT,
      description TEXT,
      workspace TEXT,
      priority INTEGER NOT NULL DEFAULT 3,
      owner TEXT,
      deadline TEXT,
      source_excerpt TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      reviewed_at TEXT
    , related_contacts TEXT NOT NULL DEFAULT '[]');
CREATE TABLE granola_processed_meetings (
      id TEXT PRIMARY KEY,
      title TEXT,
      meeting_date TEXT,
      workspace TEXT CHECK(workspace IN ('example', 'example-project', 'personal')),
      vault_path TEXT,
      processed_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
CREATE TABLE knowledge_health (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      computed_at TEXT NOT NULL DEFAULT (datetime('now')),
      decision_freshness REAL,
      followup_completion REAL,
      blocker_persistence REAL,
      capture_gap_rate REAL,
      overall_score REAL,
      details TEXT
    );
CREATE TABLE mentor_summaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id INTEGER NOT NULL REFERENCES mentor_threads(id) ON DELETE CASCADE,
      content TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
CREATE TABLE mentor_threads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL DEFAULT 'Untitled',
      tags TEXT NOT NULL DEFAULT '[]',
      pinned INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0,
      account_id TEXT,
      session_id TEXT,
      last_active_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    , last_message_role TEXT, done INTEGER NOT NULL DEFAULT 0, folder_id INTEGER REFERENCES thread_folders(id) ON DELETE SET NULL, workspace TEXT NOT NULL DEFAULT 'example', created_by INTEGER REFERENCES users(id) ON DELETE SET NULL);
CREATE TABLE models (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      engine TEXT NOT NULL DEFAULT 'claude' CHECK(engine IN ('claude', 'codex')),
      enabled INTEGER NOT NULL DEFAULT 1,
      is_default INTEGER NOT NULL DEFAULT 0,
      is_planner INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 100,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
CREATE TABLE objective_assignees (
      objective_id INTEGER NOT NULL REFERENCES objectives(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      PRIMARY KEY (objective_id, user_id)
    );
CREATE TABLE objective_floor_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      objective_id INTEGER NOT NULL REFERENCES objectives(id) ON DELETE CASCADE,
      iteration INTEGER NOT NULL DEFAULT 0,
      outcome TEXT NOT NULL CHECK(outcome IN ('pass','fail','open')),
      commands_json TEXT NOT NULL DEFAULT '[]',
      failed_command TEXT,
      open_reason TEXT,
      cwd TEXT,
      resolved_status TEXT,
      llm_would_have_run INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    , project TEXT, passed INTEGER, exit_code INTEGER, command TEXT, layer4_outcome TEXT);
CREATE TABLE objective_learnings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      objective_id INTEGER NOT NULL REFERENCES objectives(id) ON DELETE CASCADE,
      task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
      session_id TEXT,
      content TEXT NOT NULL,
      learning_type TEXT NOT NULL DEFAULT 'summary'
        CHECK(learning_type IN ('decision', 'pattern', 'gotcha', 'summary')),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
CREATE TABLE objective_prs (
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
CREATE TABLE "objective_reviews" (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
        objective_id INTEGER NOT NULL,
        iteration INTEGER NOT NULL,
        reviewer_session_id TEXT NOT NULL,
        mode TEXT NOT NULL CHECK(mode IN ('browser','api','doc','noop','decision')),
        verdict TEXT NOT NULL CHECK(verdict IN ('pass','fail','blocked','pending')),
        criteria_results TEXT NOT NULL DEFAULT '[]',
        screenshot_paths TEXT NOT NULL DEFAULT '[]',
        markdown_body TEXT NOT NULL DEFAULT '',
        cost_usd REAL NOT NULL DEFAULT 0,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        feature_brief TEXT NOT NULL DEFAULT ''
        );
CREATE TABLE objective_uat_runs (
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
CREATE TABLE "objectives" (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'queue' CHECK(status IN ('planning','queue','working','ai_review','review','done')),
        agent_context TEXT NOT NULL DEFAULT 'general',
        assigned_user_id INTEGER,
        session_id TEXT,
        transcript_path TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        workspace TEXT NOT NULL DEFAULT 'example',
        category TEXT NOT NULL DEFAULT 'general',
        parent_id INTEGER,
        depth INTEGER NOT NULL DEFAULT 0,
        project TEXT,
        last_session_summary TEXT,
        session_count INTEGER NOT NULL DEFAULT 0,
        total_cost_usd REAL NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        has_blockers INTEGER NOT NULL DEFAULT 0,
        task_count INTEGER NOT NULL DEFAULT 0,
        tasks_passed INTEGER NOT NULL DEFAULT 0,
        create_pr INTEGER NOT NULL DEFAULT 0,
        branch_name TEXT,
        pr_url TEXT,
        pr_number INTEGER,
        completion_goal TEXT,
        workflow_hint TEXT,
        effort TEXT NOT NULL DEFAULT 'normal',
        created_by INTEGER,
        type TEXT NOT NULL DEFAULT 'task',
        approved_plan TEXT,
        plan_approved_at TEXT,
        planning_session_id TEXT,
        ai_review_verdict TEXT,
        ai_review_findings TEXT,
        ai_review_session_id TEXT,
        skip_ai_review INTEGER NOT NULL DEFAULT 0,
        acceptance_criteria TEXT,
        ai_review_iteration INTEGER NOT NULL DEFAULT 0,
        test_cred_slug TEXT
      , model TEXT NOT NULL DEFAULT 'claude-fable-5', routine_id INTEGER, delegate_mode INTEGER NOT NULL DEFAULT 0, job_disposition TEXT, job_review_note TEXT, source_job_id INTEGER, scope_flags INTEGER NOT NULL DEFAULT 0, reconcile_sig TEXT, is_strategy INTEGER NOT NULL DEFAULT 0, rejected_tree_sha TEXT, not_mergeable INTEGER NOT NULL DEFAULT 0, trust_stage INTEGER NOT NULL DEFAULT 0, origin TEXT NOT NULL DEFAULT 'manual', strategy_id INTEGER);
CREATE TABLE planning_conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      objective_id INTEGER NOT NULL REFERENCES objectives(id) ON DELETE CASCADE,
      session_id TEXT,
      role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
      content TEXT NOT NULL,
      metadata TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    , seq INTEGER);
CREATE TABLE resource_assignments (
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
CREATE TABLE rolodex_threads (
      chat_id     TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL,
      history     TEXT NOT NULL DEFAULT '[]',
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
CREATE TABLE routines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      cron_expr TEXT NOT NULL,
      objective_template TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 0,
      max_queue_depth INTEGER NOT NULL DEFAULT 1,
      last_run_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    , strategy_objective_id INTEGER);
CREATE TABLE schema_meta (
      key TEXT PRIMARY KEY,
      value TEXT,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
CREATE TABLE secret_access_log (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      actor_user_id INTEGER,
      action        TEXT NOT NULL,
      scope         TEXT NOT NULL,
      key           TEXT NOT NULL,
      at            TEXT NOT NULL DEFAULT (datetime('now'))
    );
CREATE TABLE secret_versions (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      secret_id       INTEGER NOT NULL REFERENCES secrets(id) ON DELETE CASCADE,
      version         INTEGER NOT NULL,
      value_encrypted TEXT    NOT NULL,
      changed_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
      changed_at      TEXT    NOT NULL DEFAULT (datetime('now')),
      UNIQUE(secret_id, version)
    );
CREATE TABLE secrets (
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
CREATE TABLE session_account_override (
  session_id TEXT PRIMARY KEY, account_id TEXT NOT NULL, reason TEXT );
CREATE TABLE session_corrections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      objective_id INTEGER NOT NULL REFERENCES objectives(id) ON DELETE CASCADE,
      session_id TEXT,
      workspace TEXT,
      agent_context TEXT,
      label TEXT NOT NULL,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
CREATE TABLE "session_events" (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        objective_id INTEGER NOT NULL,
        event_type TEXT NOT NULL CHECK(event_type IN ('decision','blocker','follow_up','error','milestone','warning')),
        description TEXT NOT NULL,
        metadata TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
CREATE TABLE session_file_ops (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      objective_id INTEGER NOT NULL,
      file_path TEXT NOT NULL,
      operation TEXT NOT NULL CHECK(operation IN ('create','modify','read')),
      timestamp TEXT NOT NULL
    );
CREATE TABLE session_intel (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      objective_id INTEGER NOT NULL REFERENCES objectives(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL UNIQUE,
      account_id TEXT,
      started_at TEXT NOT NULL,
      ended_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      total_cost_usd REAL NOT NULL DEFAULT 0,
      files_created TEXT NOT NULL DEFAULT '[]',
      files_modified TEXT NOT NULL DEFAULT '[]',
      commands_run INTEGER NOT NULL DEFAULT 0,
      tool_calls INTEGER NOT NULL DEFAULT 0,
      errors TEXT NOT NULL DEFAULT '[]',
      exit_code INTEGER,
      summary TEXT,
      decisions TEXT DEFAULT '[]',
      blockers TEXT DEFAULT '[]',
      follow_ups TEXT DEFAULT '[]',
      skills_used TEXT DEFAULT '[]',
      outcome TEXT CHECK(outcome IN ('success','partial','failed','blocked')),
      extraction_status TEXT NOT NULL DEFAULT 'pending'
        CHECK(extraction_status IN ('pending','parsed','summarized','failed')),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    , model_usage TEXT, agents_invoked TEXT DEFAULT '[]', subagents_spawned TEXT DEFAULT '[]');
CREATE TABLE session_leases (
      lease_key    TEXT PRIMARY KEY,
      objective_id INTEGER NOT NULL,
      session_id   TEXT,
      tmux_name    TEXT,
      acquired_at  TEXT NOT NULL DEFAULT (datetime('now')),
      heartbeat_at TEXT NOT NULL DEFAULT (datetime('now')),
      released_at  TEXT
    );
CREATE TABLE session_runtime (
      session_id TEXT PRIMARY KEY,
      claude_session_id TEXT,
      account_id TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    , engine TEXT);
CREATE TABLE session_usage_daily (
      session_id   TEXT NOT NULL,
      day          TEXT NOT NULL,          -- Eastern YYYY-MM-DD
      model        TEXT NOT NULL,
      account_id   TEXT,
      objective_id INTEGER,
      cost_usd     REAL NOT NULL DEFAULT 0,
      tokens       INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (session_id, day, model)
    );
CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
CREATE TABLE tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      objective_id INTEGER NOT NULL REFERENCES objectives(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      acceptance_criteria TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'running', 'passed', 'failed')),
      priority INTEGER NOT NULL DEFAULT 1,
      dependencies TEXT NOT NULL DEFAULT '[]',
      session_id TEXT,
      session_outcome TEXT,
      learnings TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    , retry_count INTEGER NOT NULL DEFAULT 0, is_verification INTEGER NOT NULL DEFAULT 0);
CREATE TABLE test_credentials (
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
    , is_primary INTEGER NOT NULL DEFAULT 0);
CREATE TABLE thread_folders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    , workspace TEXT NOT NULL DEFAULT 'example');
CREATE TABLE uptime_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      received_at TEXT NOT NULL,
      event_at TEXT NOT NULL,
      monitor_id TEXT NOT NULL,
      monitor_name TEXT,
      monitor_url TEXT,
      alert_type INTEGER,
      alert_type_friendly_name TEXT,
      alert_details TEXT,
      alert_duration INTEGER,
      response_time INTEGER,
      payload_raw TEXT NOT NULL
    );
CREATE TABLE user_github_tokens (
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
CREATE TABLE user_workspaces (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      workspace TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('admin', 'member')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')), can_use_assistant INTEGER NOT NULL DEFAULT 1, objective_visibility TEXT NOT NULL DEFAULT 'own',
      UNIQUE(user_id, workspace)
    );
CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('admin', 'member')),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    , email TEXT);
CREATE TABLE workspace_integrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace TEXT NOT NULL REFERENCES workspaces(slug) ON DELETE CASCADE,
      provider TEXT NOT NULL CHECK(provider IN ('github', 'posthog')),
      config TEXT NOT NULL DEFAULT '{}',
      secret TEXT,
      status TEXT NOT NULL DEFAULT 'connected' CHECK(status IN ('connected', 'invalid')),
      last_error TEXT,
      last_validated_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(workspace, provider)
    );
CREATE TABLE workspace_repos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace TEXT NOT NULL REFERENCES workspaces(slug) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT,
      github TEXT,
      repo_path TEXT,
      stack TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
CREATE TABLE workspaces (
      slug TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      short_label TEXT,
      badge_color TEXT,
      vault_path TEXT,
      doc_read_roots TEXT NOT NULL DEFAULT '[]',
      doc_write_roots TEXT NOT NULL DEFAULT '[]',
      default_agent_pool TEXT NOT NULL DEFAULT '[]',
      archived INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
CREATE INDEX idx_activity_created ON activity_log(created_at);
CREATE INDEX idx_activity_objective ON activity_log(objective_id);
CREATE INDEX idx_activity_project ON activity_log(project);
CREATE INDEX idx_activity_workspace ON activity_log(workspace);
CREATE INDEX idx_alerts_acked ON alerts(acked_at);
CREATE INDEX idx_alerts_created ON alerts(created_at);
CREATE INDEX idx_alerts_dedup ON alerts(dedup_key);
CREATE INDEX idx_assignees_user ON objective_assignees(user_id);
CREATE INDEX idx_blocked_objectives_active ON blocked_objectives(resolved_at, expires_at);
CREATE INDEX idx_branch_leases_objective ON branch_leases(objective_id);
CREATE INDEX idx_canary_runs_created ON canary_runs(created_at);
CREATE INDEX idx_changelog_platform ON changelog_entries(platform);
CREATE INDEX idx_changelog_status_merged ON changelog_entries(status, merged_at DESC);
CREATE INDEX idx_contacts_email ON contacts_index(email);
CREATE INDEX idx_contacts_name ON contacts_index(name);
CREATE INDEX idx_contacts_next_touchpoint ON contacts_index(next_touchpoint);
CREATE INDEX idx_corrections_objective ON session_corrections(objective_id);
CREATE INDEX idx_corrections_ws_agent ON session_corrections(workspace, agent_context);
CREATE INDEX idx_doppler_scoped_tokens_workspace ON doppler_scoped_tokens(workspace);
CREATE INDEX idx_events_created ON session_events(created_at);
CREATE INDEX idx_events_objective ON session_events(objective_id);
CREATE INDEX idx_events_type ON session_events(event_type);
CREATE INDEX idx_ext_remediation_pr ON external_check_remediations(repo, pr_number);
CREATE INDEX idx_false_pass_objective ON gate_false_pass(objective_id);
CREATE INDEX idx_false_pass_source ON gate_false_pass(source);
CREATE INDEX idx_false_pass_workspace ON gate_false_pass(workspace);
CREATE INDEX idx_file_ops_path ON session_file_ops(file_path);
CREATE INDEX idx_file_ops_session ON session_file_ops(session_id);
CREATE INDEX idx_floor_runs_objective ON objective_floor_runs(objective_id);
CREATE INDEX idx_floor_runs_outcome ON objective_floor_runs(outcome);
CREATE INDEX idx_gmail_triage_classified_at ON gmail_triage(classified_at);
CREATE INDEX idx_gmail_triage_label ON gmail_triage(label);
CREATE INDEX idx_granola_action_items_meeting ON granola_action_items(meeting_id);
CREATE INDEX idx_granola_action_items_status ON granola_action_items(status);
CREATE INDEX idx_learnings_objective ON objective_learnings(objective_id);
CREATE INDEX idx_mentor_threads_workspace ON mentor_threads(workspace);
CREATE UNIQUE INDEX idx_models_one_default ON models(is_default) WHERE is_default = 1;
CREATE UNIQUE INDEX idx_models_one_planner ON models(is_planner) WHERE is_planner = 1;
CREATE INDEX idx_objective_prs_objective ON objective_prs(objective_id);
CREATE INDEX idx_objective_prs_repo_pr ON objective_prs(repo, pr_number);
CREATE INDEX idx_objectives_is_strategy ON objectives(is_strategy);
CREATE INDEX idx_objectives_job_disposition ON objectives(job_disposition);
CREATE INDEX idx_objectives_origin ON objectives(origin);
CREATE INDEX idx_objectives_project ON objectives(project);
CREATE INDEX idx_objectives_routine ON objectives(routine_id);
CREATE INDEX idx_objectives_source_job ON objectives(source_job_id);
CREATE INDEX idx_objectives_status ON objectives(status);
CREATE INDEX idx_objectives_strategy ON objectives(strategy_id);
CREATE INDEX idx_objectives_type ON objectives(type);
CREATE INDEX idx_objectives_workspace ON objectives(workspace);
CREATE INDEX idx_planning_created ON planning_conversations(created_at);
CREATE UNIQUE INDEX idx_planning_obj_session_seq ON planning_conversations(objective_id, session_id, seq) WHERE seq IS NOT NULL;
CREATE INDEX idx_planning_objective ON planning_conversations(objective_id);
CREATE INDEX idx_resource_assignments_lookup
      ON resource_assignments(resource_type, scope_type, workspace, project, user_id);
CREATE UNIQUE INDEX idx_reviews_obj_iter ON objective_reviews(objective_id, iteration);
CREATE INDEX idx_reviews_objective ON objective_reviews(objective_id);
CREATE INDEX idx_routines_strategy ON routines(strategy_objective_id);
CREATE INDEX idx_secret_access_log_actor ON secret_access_log(actor_user_id);
CREATE INDEX idx_secret_access_log_at ON secret_access_log(at DESC);
CREATE INDEX idx_secret_versions_secret ON secret_versions(secret_id);
CREATE INDEX idx_secrets_key ON secrets(key);
CREATE INDEX idx_secrets_scope ON secrets(scope_type, workspace, user_id);
CREATE INDEX idx_session_intel_objective ON session_intel(objective_id);
CREATE INDEX idx_session_intel_session ON session_intel(session_id);
CREATE INDEX idx_session_intel_started ON session_intel(started_at);
CREATE INDEX idx_session_intel_status ON session_intel(extraction_status);
CREATE INDEX idx_session_leases_objective ON session_leases(objective_id);
CREATE INDEX idx_tasks_objective ON tasks(objective_id);
CREATE INDEX idx_tasks_status ON tasks(status);
CREATE UNIQUE INDEX idx_testcred_primary ON test_credentials(workspace, project) WHERE is_primary = 1;
CREATE INDEX idx_testcred_project ON test_credentials(project);
CREATE INDEX idx_testcred_workspace ON test_credentials(workspace);
CREATE INDEX idx_thread_folders_workspace ON thread_folders(workspace);
CREATE INDEX idx_uat_runs_objective ON objective_uat_runs(objective_id);
CREATE INDEX idx_uat_runs_verdict ON objective_uat_runs(verdict);
CREATE INDEX idx_uptime_events_event_at ON uptime_events(event_at);
CREATE INDEX idx_uptime_events_monitor ON uptime_events(monitor_id, event_at);
CREATE INDEX idx_usage_daily_account ON session_usage_daily(account_id, day);
CREATE INDEX idx_usage_daily_day ON session_usage_daily(day);
CREATE INDEX idx_user_workspaces_user ON user_workspaces(user_id);
CREATE INDEX idx_workspace_integrations_workspace ON workspace_integrations(workspace);
CREATE INDEX idx_workspace_repos_workspace ON workspace_repos(workspace);
