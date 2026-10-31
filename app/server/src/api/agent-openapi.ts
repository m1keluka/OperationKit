/**
 * Command Center Agent API — OpenAPI 3.1.
 * Served at GET /api/openapi.json. Curated board/PM surface for third-party
 * agents. Admin, secrets, internal, and shell routes are intentionally omitted.
 */
export const AGENT_OPENAPI = {
  openapi: '3.1.0',
  info: {
    title: 'Command Center Agent API',
    version: '1.0.0',
    summary: 'Project-manage Command Center from any HTTP agent',
    description: [
      'Remote API for listing, creating, updating, and talking to board cards (objectives).',
      // Auth (obj 714090)
      'Auth: one NAMED, SCOPED agent key per bot — Settings → You → Agent keys — sent as `Authorization: Bearer cc_live_…`.',
      'Scopes: board:read, board:write, board:start, board:cancel, board:done, board:delete, vault:read, vault:write, board:secrets_request;',
      'new keys default to everything except board:done and board:delete (done is Mike\'s signature). A key may also be pinned to a workspace allowlist.',
      'A call the key is not scoped for returns 403 { error, missing_scope }; a workspace outside the allowlist returns 403 { error, workspace }.',
      'Cards created with an agent key (REST or MCP) carry origin=agent_api and agent_key_label. GET /api/auth/me returns api_key { kind, id, label, scopes, workspaces }.',
      'The legacy per-user key (Settings → You → Generate API key) keeps full access. The browser uses an httpOnly cookie (POST /api/auth/login); POST /api/auth/token issues a short-lived JWT.',
      // Control layer (obj 714091 + 714100)
      'Orchestrator loop: GET /api/agent/attention for what needs a decision, then GET /api/agent/changes?since=<stored next_cursor> for deltas — do not re-read the board.',
      'GET /api/objectives with an API key and no ?limit returns the newest 50 rows (header X-Default-Limit: 50); page with ?limit=&offset=.',
      'Default list excludes done and cancelled; pass ?status=done or ?status=cancelled to fetch those columns.',
      'POST /api/objectives and POST /api/objectives/{id}/message accept an Idempotency-Key header (24h replay, namespaced per key).',
      'POST /api/objectives {start:true} creates and starts in one call (needs board:start).',
      'Do not message a done/cancelled card — reopen with PATCH status=working first.',
      // MCP (obj 714092)
      'The same surface is a remote MCP server at POST /api/mcp (Streamable HTTP, stateless); each tool call is checked exactly like its REST route.',
      'WebSocket /ws is cookie-only; agents should poll list + /output instead.',
      'While a card runs, GET /api/objectives/{id}/progress answers "how is it going" (worker snapshots, transcript fallback, children roll-up); /artifacts lists partial outputs.',
    ].join(' '),
  },
  servers: [
    { url: 'https://cc.example.com', description: 'Production' },
    { url: 'http://localhost:3002', description: 'Local / in-container' },
  ],
  tags: [
    { name: 'meta', description: 'Discovery, health, spec' },
    { name: 'auth', description: 'Tokens and identity' },
    { name: 'board', description: 'Objectives (cards)' },
    { name: 'thread', description: 'Session conversation on a card' },
    { name: 'briefing', description: 'What needs you now' },
    { name: 'vault', description: 'Second-brain knowledge base' },
    { name: 'files', description: 'Read-only, workspace-scoped search/stat/download of non-markdown files (pptx, pdf, key, images…), plus redacted system configs/logs/crontabs' },
    { name: 'secrets-broker', description: 'Use secrets without seeing them: list names, proxy an HTTPS call with server-side {{secret:NAME}} injection to an allowlisted host' },
    { name: 'control', description: 'Orchestrator polling: changes feed + attention brief' },
  ],
  security: [{ bearerAuth: [] }],
  components: {
    parameters: {
      IdempotencyKey: {
        name: 'Idempotency-Key',
        in: 'header',
        required: false,
        schema: { type: 'string', minLength: 1, maxLength: 255 },
        description:
          'Optional. A repeat with the same key from the same caller within 24h replays the stored response ' +
          '(the namespace is user + credential: each agent key, the legacy key and the browser session are separate, ' +
          'so two bots never collide) ' +
          '— header Idempotent-Replayed: true — instead of running again. Same key + different body → 422; ' +
          'while the first is still running → 409. 5xx responses are not stored.',
      },
    },
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'API key (cc_live_) or JWT' },
    },
    schemas: {
      ProgressEvent: {
        type: 'object',
        description: 'One structured progress snapshot written by the worker (or a bot). Text fields are secret-redacted.',
        properties: {
          id: { type: 'integer', description: 'Event id — pass as ?before= to page older events' },
          objective_id: { type: 'integer' },
          session_id: { type: ['string', 'null'] },
          step: { type: ['integer', 'null'] },
          total_steps: { type: ['integer', 'null'] },
          label: { type: ['string', 'null'], description: 'Current step label (≤200 chars)' },
          note: { type: ['string', 'null'], description: 'Short note (≤2000 chars)' },
          result: { type: ['string', 'null'], description: 'Partial result, text or JSON text (≤4000 chars)' },
          artifacts: { type: 'array', items: { type: 'string' }, description: 'Artifact refs — paths under the card memory dir (read via /artifacts/file) or URLs' },
          source: { type: 'string', enum: ['worker', 'api'] },
          created_at: { type: 'string', format: 'date-time' },
        },
      },
      ProgressWriteRequest: {
        type: 'object',
        description: 'At least one of step, label, note, result, artifacts.',
        properties: {
          step: { type: 'integer', minimum: 0 },
          total_steps: { type: 'integer', minimum: 0 },
          label: { type: 'string', maxLength: 200 },
          note: { type: 'string', maxLength: 2000 },
          result: { description: 'String or any JSON value (stored as JSON text)' },
          artifacts: { type: 'array', maxItems: 20, items: { type: 'string', maxLength: 300 } },
          session_id: { type: 'string' },
        },
      },
      TranscriptProgress: {
        type: 'object',
        description: 'Coarse progress derived from the live transcript — the fallback when a worker writes nothing.',
        properties: {
          source: { type: 'string', enum: ['transcript'] },
          session_id: { type: 'string' },
          last_tool: { type: ['object', 'null'], properties: { name: { type: 'string' }, summary: { type: ['string', 'null'] } } },
          last_assistant_message: { type: ['string', 'null'] },
          assistant_turns: { type: 'integer' },
          tool_calls: { type: 'integer' },
          num_turns: { type: ['integer', 'null'], description: 'From the last CLI result event, when one exists' },
          last_event_at: { type: ['string', 'null'], format: 'date-time' },
          elapsed_seconds: { type: ['integer', 'null'] },
          scanned_bytes: { type: 'integer' },
          truncated: { type: 'boolean', description: 'Only the transcript tail was scanned' },
        },
      },
      SessionStart: {
        type: 'object',
        description: 'Who or what started/resumed a session on the card.',
        properties: {
          id: { type: 'integer' },
          session_id: { type: ['string', 'null'] },
          kind: { type: 'string', enum: ['spawn', 'resume', 'attach', 'rejected'], description: 'attach = a second start was folded into the already-live session; rejected = refused duplicate' },
          reason: { type: 'string', description: 'board | agent | follow_up | delegator_wake | merge_lane | ci_failure_followup | resume_after_limit | resume_after_overload | turns_continue | queue_drain | routine | fanout | reopen | ai_review_fail | completion_gate | plan_approved | decision_resolved | noop_respawn | unattributed' },
          actor: { type: ['string', 'null'] },
          detail: { type: ['string', 'null'] },
          created_at: { type: 'string', format: 'date-time' },
        },
      },
      ProgressView: {
        type: 'object',
        properties: {
          objective_id: { type: 'integer' },
          status: { $ref: '#/components/schemas/ObjectiveStatus' },
          session_id: { type: ['string', 'null'] },
          progress_source: { type: 'string', enum: ['worker', 'transcript', 'none'], description: 'Which source answers "how is it going"' },
          latest: { oneOf: [{ $ref: '#/components/schemas/ProgressEvent' }, { type: 'null' }] },
          events: { type: 'array', items: { $ref: '#/components/schemas/ProgressEvent' }, description: 'Newest first' },
          total_events: { type: 'integer' },
          next_before: { type: ['integer', 'null'], description: 'Cursor for the next (older) page; null when exhausted' },
          transcript: { oneOf: [{ $ref: '#/components/schemas/TranscriptProgress' }, { type: 'null' }] },
          children: {
            type: ['object', 'null'],
            description: 'Fan-out roll-up: each child card with its latest progress and, once past working, its final result',
            properties: {
              total: { type: 'integer' },
              done: { type: 'integer' },
              by_status: { type: 'object', additionalProperties: { type: 'integer' } },
              items: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'integer' },
                    title: { type: 'string' },
                    status: { type: 'string' },
                    ai_review_verdict: { type: ['string', 'null'] },
                    pr_url: { type: ['string', 'null'] },
                    updated_at: { type: 'string' },
                    latest: { oneOf: [{ $ref: '#/components/schemas/ProgressEvent' }, { type: 'null' }] },
                    result: { type: ['string', 'null'] },
                  },
                },
              },
            },
          },
          fanout: {
            type: ['object', 'null'],
            description: 'Present when this card fanned out a parallel group',
            properties: {
              max_concurrency: { type: 'integer' },
              child_ids: { type: 'array', items: { type: 'integer' } },
              completed_at: { type: ['string', 'null'] },
            },
          },
          session_starts: { type: 'array', items: { $ref: '#/components/schemas/SessionStart' }, description: 'Newest 10' },
        },
      },
      ArtifactEntry: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative to the card memory dir' },
          size: { type: 'integer' },
          modified_at: { type: 'string', format: 'date-time' },
          kind: { type: 'string', enum: ['text', 'binary'] },
        },
      },
      FileHit: {
        type: 'object',
        required: ['path', 'name', 'size', 'mime', 'mtime', 'workspace', 'root'],
        properties: {
          path: { type: 'string', description: 'Absolute real path (pass back to /stat and /download)' },
          name: { type: 'string' },
          size: { type: 'integer', description: 'Bytes' },
          mime: { type: 'string' },
          mtime: { type: 'string', format: 'date-time' },
          workspace: { type: ['string', 'null'], description: "Owning workspace slug, 'shared', or null" },
          root: { type: 'string', description: 'Configured root id (vault, uploads, or a system root id)' },
          redacted: { type: 'boolean', description: 'true for system-root files: every read is redacted server-side' },
          snippets: {
            type: 'array',
            description: 'Only with ?content=: matching lines of the REDACTED text',
            items: { type: 'object', properties: { line: { type: 'integer' }, text: { type: 'string' } } },
          },
        },
      },
      FileStat: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          name: { type: 'string' },
          size: { type: 'integer' },
          mime: { type: 'string' },
          mtime: { type: 'string', format: 'date-time' },
          ctime: { type: 'string', format: 'date-time' },
          created: { type: ['string', 'null'], format: 'date-time', description: 'Birth time when the filesystem reports it' },
          workspace: { type: ['string', 'null'] },
          root: { type: 'string' },
          downloadable: { type: 'boolean', description: 'false when size exceeds the download cap (or, for redacted files, the redacted-read cap)' },
          sha256: { type: ['string', 'null'], description: 'Present only with ?sha256=1; null if over the cap. For redacted files this hashes the REDACTED content (see sha256_of)' },
          sha256_of: { type: 'string', enum: ['redacted_content'], description: 'Present when the hash is of the redacted bytes' },
          redacted: { type: 'boolean', description: 'true when reads of this file are redacted (system roots)' },
          serve_mode: { type: 'string', enum: ['raw', 'redact', 'env'], description: 'raw = bytes as-is; redact = known values + patterns replaced; env = .env names only (KEY=[REDACTED])' },
          preview: { type: 'string', description: 'Only with ?preview=1 on redacted files: first ~4 KB, redacted, whole lines' },
          redaction_count: { type: 'integer', description: 'With ?preview=1: replacements in the whole file' },
        },
      },
      BrokerSecret: {
        type: 'object',
        required: ['name', 'scope', 'allowed_hosts', 'usable'],
        description: 'Secret metadata. There is deliberately no value field.',
        properties: {
          name: { type: 'string', example: 'SUPABASE_SERVICE_ROLE' },
          description: { type: ['string', 'null'] },
          scope: { type: 'string', enum: ['global', 'workspace', 'user', 'workspace_user'] },
          workspace: { type: ['string', 'null'] },
          allowed_hosts: { type: 'array', items: { type: 'string' }, description: 'Exact hosts or `*.suffix` (subdomains only)' },
          allowed_methods: { type: ['array', 'null'], items: { type: 'string' }, description: 'null = any method' },
          usable: { type: 'boolean', description: 'false until a host allowlist is configured for this secret' },
        },
      },
      Error: {
        type: 'object',
        required: ['error'],
        properties: { error: { type: 'string' } },
      },
      // obj 714090 — named, scoped agent API keys.
      AgentScope: {
        type: 'string',
        enum: ['board:read', 'board:write', 'board:start', 'board:cancel', 'board:done', 'board:delete', 'vault:read', 'vault:write', 'board:secrets_request'],
      },
      ScopeError: {
        type: 'object',
        description: '403 from the agent-key guard. missing_scope is null when the route is off the agent surface entirely.',
        required: ['error', 'missing_scope'],
        properties: {
          error: { type: 'string' },
          missing_scope: { oneOf: [{ $ref: '#/components/schemas/AgentScope' }, { type: 'null' }] },
        },
      },
      AgentApiKey: {
        type: 'object',
        description: 'Never carries the secret except on create (token).',
        properties: {
          id: { type: 'integer' },
          label: { type: 'string', examples: ['Grok: Example'] },
          last4: { type: 'string' },
          scopes: { type: 'array', items: { $ref: '#/components/schemas/AgentScope' } },
          workspaces: { type: ['array', 'null'], items: { type: 'string' }, description: 'null = every workspace the user can see' },
          created_at: { type: 'string' },
          last_used_at: { type: ['string', 'null'] },
          revoked_at: { type: ['string', 'null'] },
          token: { type: 'string', description: 'Plaintext cc_live_ key — POST response only, shown once' },
        },
      },
      ApiKeyIdentity: {
        type: 'object',
        description: 'GET /api/auth/me `api_key` block, present only when called with an API key.',
        properties: {
          kind: { type: 'string', enum: ['agent', 'legacy'] },
          id: { type: ['integer', 'null'] },
          label: { type: 'string' },
          scopes: { type: 'array', items: { $ref: '#/components/schemas/AgentScope' } },
          workspaces: { type: ['array', 'null'], items: { type: 'string' } },
        },
      },
      User: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          username: { type: 'string' },
          role: { type: 'string', enum: ['admin', 'member'] },
          created_at: { type: 'string' },
          workspaces: { type: 'array', items: { type: 'object' } },
          api_key: { $ref: '#/components/schemas/ApiKeyIdentity' },
        },
      },
      TokenResponse: {
        type: 'object',
        required: ['token', 'token_type', 'expires_in', 'user'],
        properties: {
          token: { type: 'string' },
          token_type: { type: 'string', enum: ['Bearer'] },
          expires_in: { type: 'integer', description: 'Seconds until the JWT expires (7 days)' },
          user: { $ref: '#/components/schemas/User' },
        },
      },
      ObjectiveStatus: {
        type: 'string',
        enum: ['planning', 'queue', 'working', 'ai_review', 'review', 'done', 'cancelled'],
      },
      ObjectiveType: { type: 'string', enum: ['project', 'bug', 'task'] },
      AgentContext: {
        type: 'string',
        description:
          'Agent slug, validated at runtime against the DB-backed agent registry (GET /api/agents) ' +
          'rather than a fixed enum — an install may add, rename or archive personas. The values ' +
          'below are the conventional defaults a fresh install ships with.',
        examples: ['cto', 'cmo', 'coo', 'cfo', 'general'],
      },
      Objective: {
        type: 'object',
        description: 'A board card. List payloads omit heavy prose; GET /:id is the full row.',
        properties: {
          id: { type: 'integer' },
          title: { type: 'string' },
          status: { $ref: '#/components/schemas/ObjectiveStatus' },
          type: { $ref: '#/components/schemas/ObjectiveType' },
          workspace: { type: 'string' },
          project: { type: ['string', 'null'] },
          agent_context: { $ref: '#/components/schemas/AgentContext' },
          category: { type: 'string' },
          parent_id: { type: ['integer', 'null'] },
          depth: { type: 'integer' },
          session_id: { type: ['string', 'null'] },
          has_blockers: { type: 'boolean' },
          create_pr: { type: 'boolean' },
          delegate_mode: { type: 'boolean' },
          is_strategy: { type: 'boolean' },
          model: { type: ['string', 'null'] },
          effort: { type: 'string', enum: ['normal', 'high', 'ultracode'] },
          ai_review_verdict: { type: ['string', 'null'] },
          last_session_summary: { type: ['string', 'null'] },
          description: { type: 'string' },
          completion_goal: { type: ['string', 'null'] },
          origin: { type: 'string', enum: ['manual', 'strategy', 'routine', 'job_reply'] },
          created_at: { type: 'string' },
          updated_at: { type: 'string' },
        },
      },
      CreateObjectiveRequest: {
        type: 'object',
        required: ['title'],
        properties: {
          title: { type: 'string' },
          description: { type: 'string' },
          agent_context: { $ref: '#/components/schemas/AgentContext' },
          workspace: { type: 'string', description: 'Org slug. Defaults to example.' },
          project: { type: ['string', 'null'], description: 'Git repo folder name under /home/operator/projects (DISTINCT from project_id)' },
          project_id: { type: ['integer', 'null'], description: 'Board-Project FK (projects.id). Omit to inherit from parent; null to detach.' },
          category: { type: 'string', enum: ['development', 'operations', 'marketing', 'finance', 'legal', 'general'] },
          type: { $ref: '#/components/schemas/ObjectiveType' },
          parent_id: { type: ['integer', 'null'] },
          assigned_user_id: { type: ['integer', 'null'] },
          assigned_user_ids: { type: 'array', items: { type: 'integer' } },
          create_pr: { type: 'boolean' },
          delegate_mode: { type: 'boolean', description: 'Orchestrator that fans out child cards' },
          is_strategy: { type: 'boolean', description: 'Explicit Strategy marker. Never inferred.' },
          strategy_id: { type: ['integer', 'null'] },
          completion_goal: { type: ['string', 'null'] },
          effort: { type: 'string', enum: ['normal', 'high', 'ultracode'] },
          model: { type: 'string' },
          skip_ai_review: { type: 'boolean', description: 'Admin only' },
          start: {
            type: 'boolean',
            description:
              'Create AND start (queue → working) in one call, under the same session cap / lease gates as PATCH status. ' +
              'Response gains a `start` block; on the session cap the card is created, left in queue, and the call returns 409.',
          },
        },
      },
      StartOutcome: {
        type: 'object',
        required: ['requested', 'started', 'status'],
        properties: {
          requested: { type: 'boolean' },
          started: { type: 'boolean' },
          status: { $ref: '#/components/schemas/ObjectiveStatus' },
          reason: { type: 'string', enum: ['session_cap', 'lease_conflict', 'not_startable', 'start_failed'] },
          detail: { type: 'string' },
        },
      },
      ChangeEvent: {
        type: 'object',
        required: ['cursor', 'at', 'objective_id', 'type'],
        properties: {
          cursor: { type: 'string', description: 'This event\'s position; monotonic' },
          at: { type: 'string', description: 'UTC, YYYY-MM-DD HH:MM:SS' },
          objective_id: { type: 'integer' },
          title: { type: ['string', 'null'] },
          workspace: { type: ['string', 'null'] },
          type: {
            type: 'string',
            enum: ['created', 'status', 'entered_review', 'verdict', 'session_ended', 'pr_opened', 'pr_merged', 'pr_closed', 'deleted'],
            description: 'entered_review = moved into review (Needs You). verdict = AI review landed (to=pass|fail).',
          },
          from: { type: 'string' },
          to: { type: 'string' },
          detail: { type: 'string', description: 'One line: findings / summary snippet / PR URL' },
        },
      },
      ChangesPage: {
        type: 'object',
        required: ['events', 'next_cursor', 'has_more'],
        properties: {
          events: { type: 'array', items: { $ref: '#/components/schemas/ChangeEvent' } },
          next_cursor: { type: 'string', description: 'Pass as ?since= on the next poll. Always returned, even when events is empty.' },
          has_more: { type: 'boolean', description: 'true → call again immediately with next_cursor' },
        },
      },
      AttentionItem: {
        type: 'object',
        required: ['id', 'kind', 'title', 'why', 'age_min'],
        properties: {
          id: { type: 'integer' },
          kind: { type: 'string', enum: ['needs_secret', 'failed_review', 'blocked', 'review', 'stuck'] },
          title: { type: 'string', description: '≤70 chars' },
          why: { type: 'string', description: 'One line, ≤140 chars' },
          age_min: { type: 'integer', description: 'Minutes since last activity' },
          ws: { type: 'string', description: 'Only when no ?workspace filter' },
        },
      },
      AttentionBrief: {
        type: 'object',
        required: ['as_of', 'workspace', 'counts', 'items', 'truncated'],
        properties: {
          as_of: { type: 'string' },
          workspace: { type: ['string', 'null'] },
          counts: {
            type: 'object',
            properties: {
              failed_review: { type: 'integer' },
              blocked: { type: 'integer' },
              review: { type: 'integer' },
              stuck: { type: 'integer' },
            },
          },
          items: { type: 'array', items: { $ref: '#/components/schemas/AttentionItem' } },
          truncated: { type: 'boolean', description: 'More items than limit; counts are always complete' },
        },
      },
      StatusChangeRequest: {
        type: 'object',
        required: ['status'],
        properties: { status: { $ref: '#/components/schemas/ObjectiveStatus' } },
      },
      MessageRequest: {
        type: 'object',
        required: ['message'],
        properties: {
          message: { type: 'string' },
          filePaths: { type: 'array', items: { type: 'string' }, description: 'Absolute paths already on the VPS' },
        },
      },
    },
  },
  paths: {
    '/api/health': {
      get: {
        tags: ['meta'],
        security: [],
        summary: 'Liveness',
        responses: { '200': { description: '{ status, timestamp }' } },
      },
    },
    '/api/agent': {
      get: {
        tags: ['meta'],
        security: [],
        summary: 'Agent API discovery',
        responses: { '200': { description: 'Name, version, spec URL, auth how-to' } },
      },
    },
    '/api/openapi.json': {
      get: {
        tags: ['meta'],
        security: [],
        summary: 'This OpenAPI document',
        responses: { '200': { description: 'OpenAPI 3.1 JSON' } },
      },
    },
    '/api/auth/api-key': {
      get: {
        tags: ['auth'],
        summary: 'Whether this user has an API key (never the secret)',
        responses: { '200': { description: '{ configured, last4, created_at }' } },
      },
      post: {
        tags: ['auth'],
        summary: 'Generate (or rotate) an API key. Plaintext returned once.',
        responses: { '201': { description: '{ token, last4, created_at }' } },
      },
      delete: {
        tags: ['auth'],
        summary: 'Revoke the API key',
        responses: { '200': { description: '{ ok: true }' } },
      },
    },
    '/api/auth/token': {
      post: {
        tags: ['auth'],
        security: [],
        summary: 'Issue a Bearer JWT for agents',
        description: 'Same username/password as the browser login. Returns JSON token, no cookie. Rate-limited like /login.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['username', 'password'],
                properties: { username: { type: 'string' }, password: { type: 'string' } },
              },
            },
          },
        },
        responses: {
          '200': { description: 'Token issued', content: { 'application/json': { schema: { $ref: '#/components/schemas/TokenResponse' } } } },
          '401': { description: 'Invalid credentials' },
          '429': { description: 'Too many attempts' },
        },
      },
    },
    '/api/auth/me': {
      get: {
        tags: ['auth'],
        summary: 'Current user + workspace memberships',
        responses: {
          '200': { content: { 'application/json': { schema: { $ref: '#/components/schemas/User' } } } },
          '401': { description: 'Missing or expired token' },
        },
      },
    },
    // obj 714090 — agent key management (human session or legacy key only;
    // an agent key gets 403 here so a bot can never mint itself more power).
    '/api/auth/agent-keys': {
      get: {
        tags: ['auth'],
        summary: 'List your named agent keys (never the secret)',
        responses: { '200': { description: '{ keys: AgentApiKey[], scopes: AgentScope[] }' } },
      },
      post: {
        tags: ['auth'],
        summary: 'Mint a named, scoped agent key. Plaintext returned once.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['label'],
                properties: {
                  label: { type: 'string', maxLength: 80, examples: ['Grok: General'] },
                  scopes: {
                    type: 'array',
                    items: { $ref: '#/components/schemas/AgentScope' },
                    description: 'Default: every scope except board:done and board:delete',
                  },
                  workspaces: { type: ['array', 'null'], items: { type: 'string' }, description: 'Allowlist; null/omitted = all' },
                },
              },
            },
          },
        },
        responses: {
          '201': { content: { 'application/json': { schema: { $ref: '#/components/schemas/AgentApiKey' } } } },
          '400': { description: 'Bad label / scope / workspace' },
          '403': { description: 'Called with an agent key, or a workspace you are not in' },
        },
      },
    },
    '/api/auth/agent-keys/{id}': {
      delete: {
        tags: ['auth'],
        summary: 'Revoke one agent key (it gets 401 immediately; other keys keep working)',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
        responses: { '200': { description: '{ ok: true }' }, '404': { description: 'Not your key' } },
      },
    },
    '/api/workspaces': {
      get: {
        tags: ['board'],
        summary: 'Organizations visible to the caller',
        responses: { '200': { description: 'Array of { slug, name, ... }' } },
      },
    },
    '/api/models': {
      get: {
        tags: ['board'],
        summary: 'Enabled coding models + default id',
        responses: { '200': { description: '{ models, default }' } },
      },
    },
    '/api/objectives': {
      get: {
        tags: ['board'],
        summary: 'List cards',
        description:
          'Default: active pipeline only (not done/cancelled). Slim columns — use GET /:id for prose. ' +
          'API-key callers (agent or legacy key) that omit limit get the newest 50 rows and header X-Default-Limit: 50; ' +
          'browser sessions are unpaged unless they pass limit.',
        parameters: [
          { name: 'workspace', in: 'query', schema: { type: 'string' } },
          { name: 'workspaces', in: 'query', schema: { type: 'string' }, description: 'Comma-separated slugs' },
          { name: 'status', in: 'query', schema: { $ref: '#/components/schemas/ObjectiveStatus' } },
          { name: 'limit', in: 'query', schema: { type: 'integer', maximum: 200 }, description: 'Default 50 for API keys; unpaged for browser sessions' },
          { name: 'offset', in: 'query', schema: { type: 'integer' } },
        ],
        responses: { '200': { content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Objective' } } } } } },
      },
      post: {
        tags: ['board'],
        summary: 'Create a card',
        description:
          'project → status planning; bug/task → queue. Creating does not start a session until status is working — ' +
          'or pass start:true to create and start in one call. Send an Idempotency-Key so a retried create cannot duplicate the card.',
        parameters: [{ $ref: '#/components/parameters/IdempotencyKey' }],
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/CreateObjectiveRequest' } } } },
        responses: {
          '201': {
            description: 'Created. With start:true the body also carries `start` (StartOutcome).',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Objective' } } },
          },
          '400': { description: 'Validation' },
          '403': { description: 'Workspace or skip_ai_review forbidden, or missing_scope (board:write; board:start too when start:true)' },
          '409': {
            description:
              'start:true only — card WAS created but not started (session cap or lease). Body: { error, objective, start }.',
          },
          '422': { description: 'Idempotency-Key reused with a different body' },
        },
      },
    },
    '/api/objectives/search': {
      get: {
        tags: ['board'],
        summary: 'Keyword search across all statuses including done',
        parameters: [
          { name: 'q', in: 'query', required: true, schema: { type: 'string' } },
          { name: 'workspace', in: 'query', schema: { type: 'string' } },
          { name: 'limit', in: 'query', schema: { type: 'integer', maximum: 100 } },
        ],
        responses: { '200': { description: '{ results: [{ id, title, status, snippet, score }] }' } },
      },
    },
    '/api/objectives/strategies': {
      get: {
        tags: ['board'],
        summary: 'List Strategy cards (is_strategy=1)',
        parameters: [{ name: 'workspace', in: 'query', schema: { type: 'string' } }],
        responses: { '200': { description: 'Strategies with rollup' } },
      },
    },
    '/api/objectives/{id}': {
      get: {
        tags: ['board'],
        summary: 'Full card detail (includes description, findings, plan)',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
        responses: { '200': { content: { 'application/json': { schema: { $ref: '#/components/schemas/Objective' } } } }, '404': { description: 'Not found' } },
      },
      put: {
        tags: ['board'],
        summary: 'Update fields (not status — use PATCH /status)',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
        requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/CreateObjectiveRequest' } } } },
        responses: { '200': { description: 'Updated card' } },
      },
      delete: {
        tags: ['board'],
        summary: 'Delete a card',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
        responses: { '200': { description: 'Deleted' } },
      },
    },
    '/api/objectives/{id}/status': {
      patch: {
        tags: ['board'],
        summary: 'Move a card. working starts a session; done/cancelled parks it.',
        description: 'Transitions are type-aware. done → working is the explicit reopen. A machine cannot clobber done.',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/StatusChangeRequest' } } } },
        responses: {
          '200': { description: 'New state' },
          '400': { description: 'Illegal transition' },
          '409': { description: 'Cap, lease, or completion gate' },
        },
      },
    },
    '/api/objectives/{id}/message': {
      post: {
        tags: ['thread'],
        summary: 'Send a follow-up into the card thread (starts/resumes the worker)',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
          { $ref: '#/components/parameters/IdempotencyKey' },
        ],
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/MessageRequest' } } } },
        responses: {
          '200': { description: 'Card now working' },
          '409': { description: 'Card is done/cancelled — reopen first' },
        },
      },
    },
    '/api/objectives/{id}/output': {
      get: {
        tags: ['thread'],
        summary: 'Conversation on the card (all worker sessions concatenated)',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
          { name: 'view', in: 'query', schema: { type: 'string', enum: ['timeline'] } },
          { name: 'after', in: 'query', schema: { type: 'integer' }, description: 'Incremental: only messages after this index' },
        ],
        responses: { '200': { description: '{ messages, total, status } or timeline segments' } },
      },
    },
    '/api/objectives/{id}/progress': {
      get: {
        tags: ['thread'],
        summary: 'Live progress: latest snapshot, paged events, transcript fallback, children roll-up, session starts',
        description: 'Answer "how is it going" while a card runs. Workers write snapshots as they go; when they write nothing, `transcript` carries coarse progress (last tool call, last assistant message, turn count, elapsed). A parent card lists its children with their latest progress and results. Workspace-scoped: an unreadable card is 404. Unknown query params are 400.',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } },
          { name: 'before', in: 'query', schema: { type: 'integer' }, description: 'Event id cursor (exclusive) — use next_before from the previous page' },
        ],
        responses: {
          '200': { content: { 'application/json': { schema: { $ref: '#/components/schemas/ProgressView' } } } },
          '400': { description: 'Bad or unsupported query param' },
          '404': { description: 'Not found or not visible to the caller' },
        },
      },
      post: {
        tags: ['thread'],
        summary: 'Write a progress snapshot (card owner or admin)',
        description: 'Workers on the box use POST /api/internal/objectives/{id}/progress (scripts/cc-live.mjs); this is the bot-key equivalent for an agent driving a card. Text is secret-redacted before storage.',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/ProgressWriteRequest' } } } },
        responses: {
          '201': { content: { 'application/json': { schema: { $ref: '#/components/schemas/ProgressEvent' } } } },
          '400': { description: 'Validation' },
          '403': { description: 'Not the owner' },
          '404': { description: 'Not found or not visible' },
        },
      },
    },
    '/api/objectives/{id}/artifacts': {
      get: {
        tags: ['thread'],
        summary: 'List live artifacts in the card memory dir (readable mid-run)',
        description: 'Progress files and partial outputs a worker writes while running (ARTIFACT.md, live/, work/…). The worker scratch file NOTES.md, dotfiles and symlinks are never listed. Binaries are listed but not served.',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
        responses: {
          '200': {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    objective_id: { type: 'integer' },
                    status: { type: 'string' },
                    entries: { type: 'array', items: { $ref: '#/components/schemas/ArtifactEntry' } },
                    truncated: { type: 'boolean' },
                  },
                },
              },
            },
          },
          '404': { description: 'Not found or not visible' },
        },
      },
    },
    '/api/objectives/{id}/artifacts/file': {
      get: {
        tags: ['thread'],
        summary: 'Read one live artifact (secret-redacted, ≤1 MB per read)',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
          { name: 'path', in: 'query', required: true, schema: { type: 'string' }, description: 'Relative path from the /artifacts list' },
          { name: 'offset', in: 'query', schema: { type: 'integer', minimum: 0 } },
          { name: 'max_bytes', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 1000000 } },
          { name: 'tail_bytes', in: 'query', schema: { type: 'integer', minimum: 1 }, description: 'Read the last N bytes (overrides offset) — for growing logs' },
        ],
        responses: {
          '200': {
            description: 'X-Redacted / X-Redaction-Count headers set',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    path: { type: 'string' },
                    size: { type: 'integer' },
                    modified_at: { type: 'string', format: 'date-time' },
                    offset: { type: 'integer' },
                    bytes: { type: 'integer' },
                    truncated: { type: 'boolean' },
                    redaction_count: { type: 'integer' },
                    content: { type: 'string' },
                  },
                },
              },
            },
          },
          '400': { description: 'Invalid path / params' },
          '403': { description: 'NOTES.md (worker scratch) is never served' },
          '404': { description: 'Not found, not visible, symlink, or outside the card dir' },
          '415': { description: 'Binary file' },
        },
      },
    },
    '/api/objectives/{id}/timeline': {
      get: {
        tags: ['thread'],
        summary: 'Session events (warnings, milestones) newest first, cap 50',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
        responses: { '200': { description: 'Array of session_events' } },
      },
    },
    '/api/objectives/{id}/stop': {
      post: {
        tags: ['thread'],
        summary: 'Stop the live session and park the card in review',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
        responses: { '200': { description: 'Parked' } },
      },
    },
    '/api/briefing/briefing': {
      get: {
        tags: ['briefing'],
        summary: 'Working / blocked / needs-you snapshot',
        responses: { '200': { description: '{ asOf, board: { inProgress, blocked, needsReview }, openLoops }' } },
      },
    },
    '/api/files/search': {
      get: {
        tags: ['files'],
        summary: 'Find files by name, glob, extension/type, path prefix, and mtime (read-only, workspace-scoped)',
        description:
          'Searches only the configured root allowlist (second-brain vault + objective uploads by default). ' +
          'Admin keys see every root; member keys see their workspaces\' subtrees plus shared ones. ' +
          'Secrets/system paths (.env*, *.pem, private keys, id_rsa*, .ssh/, .git/, node_modules, *credential*/*secret*/*token*, DB files) are never listed. ' +
          'Sorted newest-first. Rate limited (429 + Retry-After).',
        parameters: [
          { name: 'q', in: 'query', schema: { type: 'string' }, description: 'Case-insensitive filename substring' },
          { name: 'glob', in: 'query', schema: { type: 'string' }, description: 'Filename glob, e.g. `*deck*.pptx` (* and ?)' },
          { name: 'ext', in: 'query', schema: { type: 'string' }, description: 'Comma list of extensions, e.g. `pptx,pdf,key`' },
          { name: 'type', in: 'query', schema: { type: 'string' }, description: 'Comma list of groups: presentation, document, spreadsheet, image, video, audio, archive (or a bare extension)' },
          { name: 'path_prefix', in: 'query', schema: { type: 'string' }, description: 'Absolute directory to search under (must be inside your scope)' },
          { name: 'modified_after', in: 'query', schema: { type: 'string', format: 'date-time' } },
          { name: 'modified_before', in: 'query', schema: { type: 'string', format: 'date-time' } },
          { name: 'workspace', in: 'query', schema: { type: 'string' }, description: 'Narrow to one workspace (403 if not a member)' },
          { name: 'system', in: 'query', schema: { type: 'string', enum: ['1', 'true'] }, description: 'Also walk the system roots you can see (service configs, logs, crontabs). Off by default.' },
          { name: 'root', in: 'query', schema: { type: 'string' }, description: 'Comma list of root ids to search (e.g. `cc-config,cc-logs`); naming a system root implies system=1 for it' },
          { name: 'content', in: 'query', schema: { type: 'string', minLength: 3 }, description: 'Case-insensitive match over the REDACTED text of system-root files; returns `snippets`. Matching never runs on raw bytes, so it cannot confirm a secret value.' },
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 50, maximum: 200 } },
          { name: 'offset', in: 'query', schema: { type: 'integer', default: 0 } },
        ],
        responses: {
          '200': {
            description: 'Page of matches',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    results: { type: 'array', items: { $ref: '#/components/schemas/FileHit' } },
                    total: { type: 'integer' },
                    limit: { type: 'integer' },
                    offset: { type: 'integer' },
                    next_offset: { type: ['integer', 'null'] },
                    truncated: { type: 'boolean', description: 'true if the walk hit its scan cap; narrow with path_prefix' },
                  },
                },
              },
            },
          },
          '400': { description: 'Bad date, path_prefix, or a content query under 3 characters' },
          '401': { description: 'No / invalid key' },
          '403': { description: 'Workspace or path_prefix outside your scope' },
          '429': { description: 'Rate limited' },
        },
      },
    },
    '/api/files/stat': {
      get: {
        tags: ['files'],
        summary: 'Metadata for one file (size, mime, mtime, created, optional sha256)',
        parameters: [
          { name: 'path', in: 'query', required: true, schema: { type: 'string' }, description: 'Absolute path (as returned by /search)' },
          { name: 'sha256', in: 'query', schema: { type: 'string', enum: ['1', 'true'] }, description: 'Compute the SHA-256 of the content (of the redacted content for system files)' },
          { name: 'preview', in: 'query', schema: { type: 'string', enum: ['1', 'true'] }, description: 'System files only: include a redacted preview of the first ~4 KB' },
          { name: 'workspace', in: 'query', schema: { type: 'string' } },
        ],
        responses: {
          '200': { description: 'File metadata', content: { 'application/json': { schema: { $ref: '#/components/schemas/FileStat' } } } },
          '400': { description: 'Not an absolute path / not a regular file' },
          '401': { description: 'No / invalid key' },
          '403': { description: 'Outside your scope, escapes a root (traversal/symlink), or denylisted' },
          '404': { description: 'Not found' },
          '429': { description: 'Rate limited' },
        },
      },
    },
    '/api/files/download': {
      get: {
        tags: ['files'],
        summary: 'Stream one file (Content-Type + Content-Disposition: attachment; single Range supported)',
        description:
          'Files larger than the server cap (default 200 MB, CC_FILES_MAX_DOWNLOAD_BYTES) return 413. Every download is written to the activity log (path, user, key last4, workspace, bytes). ' +
          'System-root files (configs, logs, crontabs) come back as REDACTED text: known secret values become `[REDACTED:<NAME>]`, credential shapes ' +
          '(sk-/sk-ant-, cc_live_, ghp_/github_pat_, xox*, AKIA/ASIA, AIza, sb_secret_, sk_live_, JWTs, PEM private keys, Bearer tokens, password=/secret=/token= assignments, scheme://user:pass@) become `[REDACTED:<FAMILY>]`, ' +
          'and `.env*` files are served as `KEY=[REDACTED]`. Those responses carry `X-Redacted: true`, `X-Redaction-Count`, `X-Redaction-Mode`, ignore Range, and accept `?tail_bytes=` for logs. ' +
          'Private keys, .ssh/, DB files are never served; binaries under a system root return 415 unless that root allowlists the extension.',
        parameters: [
          { name: 'path', in: 'query', required: true, schema: { type: 'string' } },
          { name: 'workspace', in: 'query', schema: { type: 'string' } },
          { name: 'tail_bytes', in: 'query', schema: { type: 'integer', minimum: 1 }, description: 'Redacted (system) files only: read just the last N bytes, starting at the next whole line' },
          { name: 'Range', in: 'header', schema: { type: 'string', example: 'bytes=0-1048575' } },
        ],
        responses: {
          '200': {
            description: 'Full file bytes (or redacted text for system files)',
            headers: {
              'X-Redacted': { schema: { type: 'string', enum: ['true'] }, description: 'Present when the body was redacted' },
              'X-Redaction-Count': { schema: { type: 'integer' } },
              'X-Redaction-Mode': { schema: { type: 'string', enum: ['values-and-patterns', 'env-names-only'] } },
            },
            content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } },
          },
          '206': { description: 'Partial content for a Range request' },
          '400': { description: 'Not an absolute path / not a regular file' },
          '401': { description: 'No / invalid key' },
          '403': { description: 'Outside your scope, escapes a root (traversal/symlink), or denylisted' },
          '404': { description: 'Not found' },
          '413': { description: 'File exceeds the download cap (redacted files: use ?tail_bytes=)' },
          '415': { description: 'Binary file under a system root (cannot be redacted)' },
          '416': { description: 'Range not satisfiable' },
          '429': { description: 'Rate limited' },
        },
      },
    },
    '/api/secrets-broker/list': {
      get: {
        tags: ['secrets-broker'],
        summary: 'List secret NAMES you can use (never values)',
        description: 'Workspace keys see secrets scoped to their workspaces plus global secrets whose policy tags one of their workspaces; admin keys see every name.',
        parameters: [{ name: 'workspace', in: 'query', schema: { type: 'string' } }],
        responses: {
          '200': {
            description: 'Secret metadata',
            content: { 'application/json': { schema: { type: 'object', properties: { secrets: { type: 'array', items: { $ref: '#/components/schemas/BrokerSecret' } } } } } },
          },
          '401': { description: 'No / invalid key' },
          '403': { description: 'Workspace outside your scope' },
          '429': { description: 'Rate limited' },
        },
      },
    },
    '/api/secrets-broker/http': {
      post: {
        tags: ['secrets-broker'],
        summary: 'Make one HTTPS call using a secret you never see',
        description:
          'Put `{{secret:NAME}}` in the url (path/query), a header value, or a string anywhere in the body. The server checks the secret is visible to your key and that the destination host is on that secret\'s allowlist, ' +
          'injects the value, sends the request (https only, port 443, no redirects followed, 30 s timeout), and returns the response with every secret value and credential pattern redacted. ' +
          'Requests without a placeholder are rejected (this is not an open proxy). Binary responses are withheld. Every call (allowed or rejected) is audited by secret name, key, workspace, host and status — never the value.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['url'],
                properties: {
                  method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'], default: 'GET' },
                  url: { type: 'string', example: 'https://abc.supabase.co/rest/v1/contacts?select=id&limit=1' },
                  headers: { type: 'object', additionalProperties: { type: 'string' }, example: { apikey: '{{secret:SUPABASE_SERVICE_ROLE}}', Authorization: 'Bearer {{secret:SUPABASE_SERVICE_ROLE}}' } },
                  body: { description: 'String, or any JSON value (sent as application/json)' },
                  workspace: { type: 'string', description: 'Pick the workspace-scoped copy of a secret when several exist' },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Upstream response, redacted',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    status: { type: 'integer' },
                    status_text: { type: 'string' },
                    headers: { type: 'object', additionalProperties: { type: 'string' } },
                    body: { type: ['string', 'null'] },
                    body_truncated: { type: 'boolean' },
                    body_omitted: { type: 'string' },
                    redacted: { type: 'boolean' },
                    redaction_count: { type: 'integer' },
                    secrets_used: { type: 'array', items: { type: 'string' } },
                  },
                },
              },
            },
          },
          '400': { description: 'Bad request: not https, non-443 port, placeholder in host/header name, credentials in URL, no placeholder, bad body' },
          '401': { description: 'No / invalid key' },
          '403': { description: 'Destination host or method not allowed for that secret, no host policy, or workspace outside your scope' },
          '404': { description: 'Secret does not exist or is not visible to this key' },
          '413': { description: 'Request body too large' },
          '429': { description: 'Rate limited' },
          '502': { description: 'Upstream request failed (detail redacted)' },
        },
      },
    },
    '/api/agent/changes': {
      get: {
        tags: ['control'],
        summary: 'Cursor-paged board changes since your last poll',
        description:
          'Events: card created, status transitions (entered_review = Needs You), AI review verdicts, session ended ' +
          '(summary snippet), PR opened/merged/closed, deleted. Ascending, no gaps or duplicates across pages. ' +
          'Omit since on the first call (last 24h), then always pass the returned next_cursor. Retention 30 days.',
        parameters: [
          { name: 'since', in: 'query', schema: { type: 'string' }, description: 'next_cursor from the previous call; 0 = everything retained' },
          { name: 'workspace', in: 'query', schema: { type: 'string' } },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 500, default: 100 } },
        ],
        responses: {
          '200': { content: { 'application/json': { schema: { $ref: '#/components/schemas/ChangesPage' } } } },
          '400': { description: 'Unknown query param or malformed cursor' },
          '403': { description: 'missing_scope board:read, or workspace outside the agent key allowlist. A pinned key only ever sees its own workspaces.' },
        },
      },
    },
    '/api/agent/attention': {
      get: {
        tags: ['control'],
        summary: 'Compact list of cards that need a human/orchestrator decision',
        description:
          'failed_review (AI review FAIL, parked), blocked (worker raised a blocker), review (Needs You), stuck ' +
          '(working, no activity ≥ stale_min). Most urgent first, one-line why each; a few KB for a typical workspace.',
        parameters: [
          { name: 'workspace', in: 'query', schema: { type: 'string' } },
          { name: 'stale_min', in: 'query', schema: { type: 'integer', default: 30 } },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 50, default: 15 } },
        ],
        responses: {
          '200': { content: { 'application/json': { schema: { $ref: '#/components/schemas/AttentionBrief' } } } },
          '400': { description: 'Unknown query param' },
          '403': { description: 'missing_scope board:read, or workspace outside the agent key allowlist' },
        },
      },
    },
    '/api/agent/seats': {
      get: {
        tags: ['control'],
        summary: 'Subscription seat pool state (read-only, no secrets)',
        description:
          'Per engine (claude, codex, grok): seat count, how many can take work now, how many are cooling down or parked, ' +
          'and next_reset_at (earliest cooldown end). Plus each seat: id, label, health, available, cooldown_until. ' +
          'Never includes a credential, a secret name or a path.',
        responses: {
          '200': { description: '{ engines: [{ kind, seats, available, cooling_down, parked, next_reset_at }], seats: [{ id, label, kind, health, available, cooldown_until }] }' },
          '400': { description: 'Unknown query param' },
          '403': { description: 'missing_scope board:read' },
        },
      },
    },
    '/api/docs/search': {
      get: {
        tags: ['vault'],
        summary: 'Search the second-brain vault',
        parameters: [
          { name: 'q', in: 'query', required: true, schema: { type: 'string' } },
          { name: 'workspace', in: 'query', schema: { type: 'string' } },
          { name: 'limit', in: 'query', schema: { type: 'integer', maximum: 20 } },
        ],
        responses: { '200': { description: '{ results: [{ path, snippet }] }' } },
      },
    },
    '/api/docs/file': {
      get: {
        tags: ['vault'],
        summary: 'Read a markdown file from the vault',
        parameters: [
          { name: 'path', in: 'query', required: true, schema: { type: 'string' }, description: 'Absolute path under /home/operator/second-brain' },
        ],
        responses: { '200': { description: '{ path, content, writable }' } },
      },
      put: {
        tags: ['vault'],
        summary: 'Write a .md file (must already have a parent directory)',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['path', 'content'],
                properties: { path: { type: 'string' }, content: { type: 'string' } },
              },
            },
          },
        },
        responses: { '200': { description: '{ ok, path }' } },
      },
    },
    '/api/kb-wiki/answers': {
      post: {
        tags: ['vault'],
        summary: 'Save an answer into a workspace knowledge base as a wiki page, linked from the pages it used (vault:write)',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['workspace', 'question', 'answer'],
                properties: {
                  workspace: { type: 'string' },
                  question: { type: 'string' },
                  answer: { type: 'string' },
                  sources: { type: 'array', items: { type: 'string' }, description: 'Knowledge-base-relative page paths' },
                },
              },
            },
          },
        },
        responses: { '201': { description: '{ rel, title }' }, '404': { description: 'Knowledge base switched off' } },
      },
    },
    '/api/kb-wiki/graph/related': {
      get: {
        tags: ['vault'],
        summary: 'Pages linked to one knowledge-base page, with how they connect: related (label like "works for"), mentions, cited_by, answer_used (vault:read)',
        parameters: [
          { name: 'workspace', in: 'query', required: true, schema: { type: 'string' } },
          { name: 'page', in: 'query', required: true, schema: { type: 'string' }, description: 'Knowledge-base-relative path, or a page title / alias' },
          { name: 'depth', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 2, default: 1 } },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 } },
        ],
        responses: { '200': { description: '{ page, related: [{ rel, title, kind, depth, via: [{ from, to, kind, label }] }], truncated }' }, '404': { description: 'No such page, or the knowledge base is switched off' } },
      },
    },
    '/api/kb-wiki/graph/who-knows': {
      get: {
        tags: ['vault'],
        summary: 'People linked to a topic in a knowledge base, ranked by number of citing sources, then recency (vault:read)',
        parameters: [
          { name: 'workspace', in: 'query', required: true, schema: { type: 'string' } },
          { name: 'topic', in: 'query', required: true, schema: { type: 'string' }, description: 'A page name, or plain words such as "the supplier"' },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 50, default: 10 } },
        ],
        responses: { '200': { description: '{ topic, matched: [{ rel, title, kind }], people: [{ rel, title, sources, latest, links, cited_in }] }' } },
      },
    },
    '/api/mcp': {
      post: {
        tags: ['control'],
        summary: 'Remote MCP server — knowledge + board in one connector (stateless Streamable HTTP, JSON-RPC 2.0)',
        description:
          'initialize / ping / tools/list / tools/call. Bearer only (cookies ignored). Each tools/call re-issues the REST ' +
          'route it wraps with the same key, so scopes, workspace allowlist, transitions and the session cap apply ' +
          'unchanged; a refused call returns isError with structuredContent { error, status, missing_scope }. ' +
          'Write tools need a named agent key (the legacy full-access key is read-only over MCP). ' +
          'tools/list hides tools whose scope a named key lacks. GET → 405. Tool ↔ REST parity table: docs/api/README.md#mcp-server.',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', description: 'JSON-RPC 2.0 message or batch' } } } },
        responses: {
          '200': { description: 'JSON-RPC response (or batch)' },
          '202': { description: 'Notification(s) only — no body' },
          '401': { description: 'No / invalid Bearer token (WWW-Authenticate: Bearer)' },
          '403': { description: 'Origin not allowed (DNS-rebinding guard)' },
          '405': { description: 'Method other than POST' },
        },
      },
    },
  },
} as const

export const AGENT_DISCOVERY = {
  name: 'Command Center Agent API',
  version: '1.0.0',
  spec: '/api/openapi.json',
  docs: '/docs/api/README.md',
  prompt: '/docs/api/AGENT-PROMPT.md',
  auth: {
    type: 'http',
    scheme: 'bearer',
    obtain: 'Settings → You → Agent keys → New agent key (one per bot). Legacy full-access key: Settings → You → Generate API key.',
    header: 'Authorization: Bearer cc_live_…',
    expires_in: null,
    // obj 714090
    agent_keys: 'Settings → You → Agent keys: one named, scoped key per bot. 403 { missing_scope } when a call is out of scope.',
    scopes: ['board:read', 'board:write', 'board:start', 'board:cancel', 'board:done', 'board:delete', 'vault:read', 'vault:write', 'board:secrets_request'],
    default_scopes: ['board:read', 'board:write', 'board:start', 'board:cancel', 'vault:read', 'vault:write'],
  },
  surface: 'board',
  // Orchestrator contract (obj 714091 + 714100): poll these instead of re-reading the board.
  control: {
    attention: 'GET /api/agent/attention — what needs a decision (board:read)',
    changes: 'GET /api/agent/changes?since=<next_cursor> — deltas since your stored cursor (board:read)',
    seats: 'GET /api/agent/seats — which subscription seats can take work and when the next resets (board:read)',
    idempotency: 'Idempotency-Key header on POST /api/objectives and /api/objectives/{id}/message — 24h, per key',
    create_and_start: 'POST /api/objectives {"start": true} (board:write + board:start)',
    default_list_limit: 50,
  },
  note: 'This is the remote PM API. /api/internal/* is localhost-only (sessions on the VPS). Admin/secrets/shell are not part of this surface.',
  // Remote MCP server (obj 716490 knowledge + obj 714092 board, unified obj 718417).
  // One URL, one connector: see routes/agent-mcp.ts.
  mcp: {
    url: '/api/mcp',
    transport: 'streamable-http',
    mode: 'stateless (POST only, JSON responses; GET is 405)',
    auth: 'Authorization: Bearer cc_live_… (same key or JWT as the REST API). Write tools need a named agent key.',
    docs: '/docs/api/README.md#mcp-server',
    tools: [
      'search', 'search_files', 'list_folders', 'read_file', 'get_card', 'search_cards', 'file_info',
      'write_doc', 'file_answer', 'kb_related', 'kb_who_knows', 'whoami', 'get_attention', 'get_seat_pool', 'get_changes', 'board_briefing', 'list_objectives', 'search_objectives',
      'get_objective', 'get_progress', 'get_output', 'get_artifacts', 'list_workspaces', 'list_agents', 'list_chat_agents',
      'get_chat_agent', 'create_objective',
      'update_objective', 'update_status', 'start_objective', 'send_message', 'list_secret_requests',
      'fulfill_secret_request', 'stop_objective',
    ],
    aliases: { get_card: 'get_objective', search_cards: 'search_objectives' },
  },
} as const
