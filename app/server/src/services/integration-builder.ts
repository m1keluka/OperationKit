/**
 * The Integrations bot — "New Integration → Make my own" (obj 900682).
 *
 * Extends, does not re-implement:
 *   - Sprint 7 (#900499, PR #681): the connector catalog and its setup guides.
 *     The bot is told which integrations ALREADY have a guide, so it sends the
 *     person there instead of hand-building one.
 *   - Sprint 7.8 (#900620, PR #713): "connect any MCP server". When the vendor
 *     publishes a remote MCP server, the bot connects it through the exact same
 *     code path (`detectResponse` / `connectMcpServer` in routes/mcp-servers.ts:
 *     SSRF guard, server-side OAuth re-detect, credential in the secrets store).
 *   - OperationKit Tools (`okit new tool --kind http-api`): for a plain REST API
 *     the bot scaffolds a Tool whose frontmatter names the key by ENV VAR only.
 *   - In-chat secret request (#719065, being restyled by companion card #900670):
 *     the bot asks for keys with `POST /api/objectives/:id/request-secret`, which
 *     opens the masked form in the card chat. A value never passes through the
 *     bot: the MCP path resolves the key by NAME server-side.
 *
 * "Make my own" creates a normal board card (this file) whose brief makes its
 * session the Integrations bot, then starts it; the person talks to it in the
 * card chat. Every card made here is registered in `integration_builder_cards`,
 * and ONLY those cards' session tokens may call the builder routes.
 */
import type Database from 'better-sqlite3'
import type { IntegrationBuildKind, IntegrationBuildSummary } from '@operationkit/shared'

export const BUILDER_TARGET_MAX = 200
export const BUILDER_DOCS_MAX = 8000

const initialised = new WeakSet<Database.Database>()

export function initIntegrationBuilderSchema(db: Database.Database): void {
  if (initialised.has(db)) return
  db.exec(`
    CREATE TABLE IF NOT EXISTS integration_builder_cards (
      objective_id INTEGER PRIMARY KEY,
      workspace TEXT NOT NULL,
      target TEXT,
      docs TEXT,
      created_by_user_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE TABLE IF NOT EXISTS integration_builds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      objective_id INTEGER NOT NULL,
      workspace TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('mcp_server', 'tool')),
      ref TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      secret_names_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      UNIQUE (workspace, kind, ref)
    );
    CREATE INDEX IF NOT EXISTS idx_integration_builds_ws ON integration_builds (workspace);
  `)
  initialised.add(db)
}

// ── builder cards ───────────────────────────────────────────────────────────

export interface BuilderCardRow {
  objective_id: number
  workspace: string
  target: string | null
  docs: string | null
  created_by_user_id: number | null
}

export function getBuilderCard(db: Database.Database, objectiveId: number): BuilderCardRow | null {
  initIntegrationBuilderSchema(db)
  const row = db.prepare('SELECT objective_id, workspace, target, docs, created_by_user_id FROM integration_builder_cards WHERE objective_id = ?')
    .get(objectiveId) as BuilderCardRow | undefined
  return row ?? null
}

// ── builds (what the bot made) ──────────────────────────────────────────────

interface BuildRow {
  id: number
  objective_id: number
  workspace: string
  kind: IntegrationBuildKind
  ref: string
  name: string
  description: string | null
  secret_names_json: string
  created_at: string
}

function toBuildSummary(r: BuildRow): IntegrationBuildSummary {
  let names: string[] = []
  try {
    const parsed = JSON.parse(r.secret_names_json)
    if (Array.isArray(parsed)) names = parsed.filter((n): n is string => typeof n === 'string')
  } catch { /* tolerate a bad row */ }
  return {
    id: r.id, objective_id: r.objective_id, workspace: r.workspace, kind: r.kind, ref: r.ref, name: r.name,
    description: r.description, secret_names: names, created_at: r.created_at,
  }
}

/** Upsert: re-building the same thing (same workspace/kind/ref) updates it instead of duplicating. */
export function recordBuild(
  db: Database.Database,
  b: { objectiveId: number; workspace: string; kind: IntegrationBuildKind; ref: string; name: string; description?: string | null; secretNames?: string[] },
): IntegrationBuildSummary {
  initIntegrationBuilderSchema(db)
  db.prepare(
    `INSERT INTO integration_builds (objective_id, workspace, kind, ref, name, description, secret_names_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (workspace, kind, ref) DO UPDATE SET
       objective_id = excluded.objective_id, name = excluded.name, description = excluded.description,
       secret_names_json = excluded.secret_names_json`,
  ).run(b.objectiveId, b.workspace, b.kind, b.ref, b.name, b.description ?? null, JSON.stringify(b.secretNames ?? []))
  const row = db.prepare('SELECT * FROM integration_builds WHERE workspace = ? AND kind = ? AND ref = ?').get(b.workspace, b.kind, b.ref) as BuildRow
  return toBuildSummary(row)
}

export function listBuilds(db: Database.Database, workspace: string): IntegrationBuildSummary[] {
  initIntegrationBuilderSchema(db)
  return (db.prepare('SELECT * FROM integration_builds WHERE workspace = ? ORDER BY created_at DESC, id DESC').all(workspace) as BuildRow[])
    .map(toBuildSummary)
}

/** An MCP server was disconnected in Settings: forget the build record too. */
export function forgetMcpBuild(db: Database.Database, serverId: number): void {
  try {
    initIntegrationBuilderSchema(db)
    db.prepare("DELETE FROM integration_builds WHERE kind = 'mcp_server' AND ref = ?").run(String(serverId))
  } catch { /* best-effort */ }
}

// ── the brief ───────────────────────────────────────────────────────────────

export interface BriefCatalogEntry {
  id: string
  name: string
  /** Has a remote MCP endpoint in the catalog (connect it via Browse → MCP). */
  mcp: boolean
  setup_guide: string | null
}

export interface BriefMcpServer {
  name: string
  slug: string
  status: string
}

export interface IntegrationBriefInput {
  objectiveId: number
  workspace: string
  target: string | null
  docs: string | null
  catalog: BriefCatalogEntry[]
  connectedMcp: BriefMcpServer[]
  secretFormEnabled: boolean
}

// Backslash first, so a `\` already in the text cannot un-escape the `\|` we add.
export const md = (s: string) => s.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')

export function integrationBuilderBrief(b: IntegrationBriefInput): string {
  const api = `http://localhost:3002/api/integrations/builder/${b.objectiveId}`
  const req = `http://localhost:3002/api/objectives/${b.objectiveId}/request-secret`
  const auth = '-H "X-CC-Session-Token: $CC_SESSION_TOKEN" -H "Content-Type: application/json"'
  const L: string[] = []
  L.push(
    `You are the **Integrations bot** for the workspace \`${b.workspace}\` (card #${b.objectiveId}).`,
    'The person opened you from **Settings → Integrations → New Integration → Make my own**. Your job: connect ONE outside system',
    `so agents and chat bots in \`${b.workspace}\` can use it — then it shows up on the Integrations page as connected.`,
    'You talk to the person in this card\'s chat. They are not engineers: short messages, one question at a time.',
    '',
    '## What they told us',
    '',
    `- **What to integrate:** ${b.target ? b.target : '_not given yet — ask_'}`,
    `- **API docs:** ${b.docs ? '' : '_not given yet — ask_'}`,
  )
  if (b.docs) {
    L.push('', '```text', b.docs.replace(/```/g, "'''"), '```')
  }
  L.push(
    '',
    '## Step 1 — ask for what is missing',
    '',
    'If either line above says "ask", your FIRST reply is the question(s) — "What do you want to connect?" and/or',
    '"Paste a link to its API docs (or the docs text)". Then end your turn and wait: their answer arrives as the next chat message.',
    'Do not guess a vendor, a URL or an auth scheme.',
    '',
    '## Step 2 — is there already a setup guide?',
    '',
    'These integrations already have a guided setup on **New Integration → Browse**. If the target is one of them, tell the',
    'person to use that (name it) and stop — do not hand-build a second copy.',
    '',
  )
  if (b.catalog.length === 0) {
    L.push('_No catalog integrations are installed on this server._')
  } else {
    L.push('| id | name | how |', '|---|---|---|')
    for (const c of b.catalog) L.push(`| \`${c.id}\` | ${md(c.name)} | ${c.mcp ? 'remote MCP server' : 'account (setup guide)'} |`)
  }
  L.push('', `Already connected MCP servers in \`${b.workspace}\`:`, '')
  if (b.connectedMcp.length === 0) L.push('_none_')
  else for (const s of b.connectedMcp) L.push(`- ${md(s.name)} (\`${s.slug}\`, ${s.status})`)
  L.push(
    '',
    '## Step 3 — read the docs and pick the path',
    '',
    'Read the API docs (fetch the URL). Find: the base URL, how it authenticates (API key header, bearer token, OAuth), and',
    'whether the vendor publishes a **remote MCP server** (an `https://…/mcp` or `/sse` URL).',
    '',
    '- **A. Remote MCP server exists** → connect it as an MCP server (step 5A). Preferred: agents get typed tools.',
    '- **B. Plain HTTP/REST API** → build an OperationKit Tool (step 5B): a TOOL.md that tells agents the endpoints and which',
    '  env var holds the key.',
    '',
    'Tell the person in one or two sentences which path you picked and what you will need from them.',
    '',
    '## Step 4 — collect keys with the secure form (never in chat)',
    '',
    'Choose an UPPER_SNAKE_CASE name (e.g. `ACME_API_KEY`). Ask for it with the masked in-chat secret form:',
    '',
    '```bash',
    `curl -s -X POST ${req} ${auth} \\`,
    `  -d '{"name":"ACME_API_KEY","reason":"API key for Acme (Settings → API in Acme)","scope":"workspace"}'`,
    '```',
    '',
    'Say where in the vendor\'s app they find the key, then end your turn. A masked form appears in this chat; the value goes',
    `straight into the encrypted secrets store for \`${b.workspace}\` and the card wakes you when it is saved.`,
    '- **Never** ask the person to type or paste a key as a chat message, and never print, echo or log a value.',
    '- If they paste one anyway, the server moves it into the store and shows `[REDACTED:NAME]` — use it by NAME.',
  )
  if (!b.secretFormEnabled) {
    L.push(
      '- **The secret form is OFF on this install** (`settings.session_secret_access`), so the request above answers 404.',
      `  Instead ask the person to add the key in **Settings → Secrets** (workspace \`${b.workspace}\`) under that exact NAME`,
      '  and to reply "done". Still never take the value in chat.',
    )
  } else {
    L.push('- If the request answers 404 the form is switched off: ask them to add it in **Settings → Secrets** under that NAME instead.')
  }
  L.push(
    '',
    '## Step 5A — connect a remote MCP server (same path as Settings → Connect an MCP server, #900620)',
    '',
    '```bash',
    `curl -s -X POST ${api}/detect ${auth} -d '{"url":"https://mcp.example.com/mcp"}'`,
    '# → {ok, auth: "none" | "api_key" | "oauth", …}',
    `curl -s -X POST ${api}/mcp-server ${auth} \\`,
    `  -d '{"name":"Acme","url":"https://mcp.example.com/mcp","auth_type":"api_key","api_key_secret":"ACME_API_KEY","auth_header_name":"Authorization"}'`,
    '```',
    '',
    '- `api_key_secret` is the NAME of the workspace secret from step 4; the server reads the value itself. Never send `api_key`.',
    '- `auth_type: "none"` needs no key. `auth_type: "oauth"` creates the server; the person then presses **Sign in** on it in',
    '  Settings → Integrations (you cannot do the browser sign-in). Tell them exactly that.',
    '- The answer carries `test` (`ok`, or `kind` + `error`) and the server\'s `tools`. Fix and retry on a failed test.',
    '',
    '## Step 5B — build an OperationKit Tool for a REST API',
    '',
    '```bash',
    `curl -s -X POST ${api}/tool ${auth} -d '{`,
    '  "name": "acme", "description": "Read and update Acme CRM contacts and deals.",',
    '  "base_url": "https://api.acme.com/v2", "docs_url": "https://docs.acme.com/api",',
    '  "secrets": [{"env": "ACME_API_KEY", "header": "Authorization: Bearer $ACME_API_KEY"}],',
    '  "body": "## Endpoints\\n…", "dry_run": true }\'',
    '```',
    '',
    '- `body` is markdown for agents: the main endpoints, request/response examples using `$ACME_API_KEY` (by name), rate',
    '  limits, gotchas. Drop `dry_run` once the preview validates; a 422 lists schema errors.',
    '- A Tool file carries env-var NAMES only — never a value.',
    `- Check it works with ONE cheap read-only call using \`$ACME_API_KEY\` from your env (secrets saved to \`${b.workspace}\``,
    '  are injected when your session resumes). If it is not in your env yet, say so instead of guessing.',
    '',
    '## Step 6 — finish',
    '',
    'Reply with: what is connected, the secret NAME(s) it uses, the tools/endpoints agents now have, and that it is listed on',
    '**Settings → Integrations**. Then end the session so the card goes to review.',
    '',
    '## Rules',
    '',
    `- Only workspace \`${b.workspace}\`. The builder routes refuse any other workspace and any card but this one.`,
    '- Use the routes above; do not write MCP server rows or secrets any other way.',
    '- No secret value in chat, in a file, in a command you print, or in your summary.',
  )
  return L.join('\n')
}

export const INTEGRATION_BUILDER_COMPLETION_GOAL =
  'The requested system is connected for this workspace — a remote MCP server whose connection test passes (or is waiting only on the person pressing Sign in), or an OperationKit Tool that validated — and it is listed on Settings → Integrations. Keys were collected only through the in-chat secret form or Settings → Secrets; no key value appears in the chat, a file or the summary.'

// ── create ──────────────────────────────────────────────────────────────────

export interface CreateBuilderInput {
  workspace: string
  target?: string | null
  docs?: string | null
  createdByUserId: number | null
  catalog: BriefCatalogEntry[]
  connectedMcp: BriefMcpServer[]
  secretFormEnabled: boolean
}

export function builderTitle(target: string | null | undefined): string {
  const t = (target ?? '').trim().replace(/\s+/g, ' ')
  if (!t) return 'Integrations bot: new integration'
  return `Integrations bot: ${t.length > 80 ? `${t.slice(0, 77).trimEnd()}…` : t}`
}

/** Insert the card (status `queue`) and register it as a builder card, in one transaction. */
export function createIntegrationBuilderCard(db: Database.Database, input: CreateBuilderInput): { objectiveId: number } {
  initIntegrationBuilderSchema(db)
  const target = input.target?.trim().slice(0, BUILDER_TARGET_MAX) || null
  const docs = input.docs?.trim().slice(0, BUILDER_DOCS_MAX) || null
  return db.transaction(() => {
    const r = db.prepare(
      `INSERT INTO objectives (title, description, completion_goal, agent_context, workspace, category, type, status, created_by)
       VALUES (?, ?, ?, 'general', ?, 'general', 'task', 'queue', ?)`,
    ).run(
      builderTitle(target), 'pending', INTEGRATION_BUILDER_COMPLETION_GOAL, input.workspace,
      input.createdByUserId && input.createdByUserId > 0 ? input.createdByUserId : null,
    )
    const objectiveId = Number(r.lastInsertRowid)
    const description = integrationBuilderBrief({
      objectiveId, workspace: input.workspace, target, docs, catalog: input.catalog,
      connectedMcp: input.connectedMcp, secretFormEnabled: input.secretFormEnabled,
    })
    db.prepare('UPDATE objectives SET description = ? WHERE id = ?').run(description, objectiveId)
    db.prepare('INSERT INTO integration_builder_cards (objective_id, workspace, target, docs, created_by_user_id) VALUES (?, ?, ?, ?, ?)')
      .run(objectiveId, input.workspace, target, docs, input.createdByUserId)
    return { objectiveId }
  })()
}
