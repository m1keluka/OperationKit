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
      'Auth: Settings → You → Generate API key, then `Authorization: Bearer cc_live_…`.',
      'The browser UI uses httpOnly cookies via POST /api/auth/login.',
      'POST /api/auth/token still issues a short-lived JWT if a password is available.',
      'Default list excludes done and cancelled; pass ?status=done or ?status=cancelled to fetch those columns.',
      'Do not message a done/cancelled card — reopen with PATCH status=working first.',
      'WebSocket /ws is cookie-only; agents should poll list + /output instead.',
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
  ],
  security: [{ bearerAuth: [] }],
  components: {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'API key (cc_live_) or JWT' },
    },
    schemas: {
      Error: {
        type: 'object',
        required: ['error'],
        properties: { error: { type: 'string' } },
      },
      User: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          username: { type: 'string' },
          role: { type: 'string', enum: ['admin', 'member'] },
          created_at: { type: 'string' },
          workspaces: { type: 'array', items: { type: 'object' } },
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
        enum: [
          'cto', 'cmo', 'coo', 'cfo', 'general', 'designer', 'hr', 'general-counsel',
          'chief-of-staff', 'assistant', 'campaign-auditor', 'campaign-launcher',
          'data-sourcing', 'fundraising-advisor', 'example2-campaign-ops', 'ma-advisor', 'rolodex',
        ],
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
        description: 'Default: active pipeline only (not done/cancelled). Slim columns — use GET /:id for prose.',
        parameters: [
          { name: 'workspace', in: 'query', schema: { type: 'string' } },
          { name: 'workspaces', in: 'query', schema: { type: 'string' }, description: 'Comma-separated slugs' },
          { name: 'status', in: 'query', schema: { $ref: '#/components/schemas/ObjectiveStatus' } },
          { name: 'limit', in: 'query', schema: { type: 'integer', maximum: 200 } },
          { name: 'offset', in: 'query', schema: { type: 'integer' } },
        ],
        responses: { '200': { content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Objective' } } } } } },
      },
      post: {
        tags: ['board'],
        summary: 'Create a card',
        description: 'project → status planning; bug/task → queue. Creating does not start a session until status is working.',
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/CreateObjectiveRequest' } } } },
        responses: {
          '201': { content: { 'application/json': { schema: { $ref: '#/components/schemas/Objective' } } } },
          '400': { description: 'Validation' },
          '403': { description: 'Workspace or skip_ai_review forbidden' },
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
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
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
    '/api/jarvis/briefing': {
      get: {
        tags: ['briefing'],
        summary: 'Working / blocked / needs-you snapshot',
        responses: { '200': { description: '{ asOf, board: { inProgress, blocked, needsReview }, openLoops }' } },
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
    obtain: 'Settings → You → Generate API key (or POST /api/auth/api-key while logged in)',
    header: 'Authorization: Bearer cc_live_…',
    expires_in: null,
  },
  surface: 'board',
  note: 'This is the remote PM API. /api/internal/* is localhost-only (sessions on the VPS). Admin/secrets/shell are not part of this surface.',
} as const
