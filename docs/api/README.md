# OperationKit API

Remote HTTP API so a person — or a **third-party agent** (Claude, Grok, ChatGPT, a cron, a bot) — can project-manage the board without sitting in the UI.

Live machine spec: `GET https://cc.example.com/api/openapi.json`  
Discovery: `GET https://cc.example.com/api/agent`  
Portable agent prompt: [AGENT-PROMPT.md](./AGENT-PROMPT.md)  
MCP server: `POST https://cc.example.com/api/mcp` ([below](#mcp-server))
Standing Grok Bots (names must match exactly). Each has **its own agent key**; setup steps are in [bots/SETUP.md](./bots/SETUP.md):

| Bot | Prompt | Key label | Scopes | Workspaces |
| --- | --- | --- | --- | --- |
| **General** (starred) | [general.md](./bots/general.md) | `Grok: General` | board:read/write/start, vault:read/write | all |
| **Example** | [example.md](./bots/example.md) | `Grok: Example` | board:read/write/start, vault:read/write | `example` |
| **Example Project** | [example-project.md](./bots/example-project.md) | `Grok: Example Project` | board:read/write/start, vault:read/write | `example-project` |
| **example3** | [example2.md](./bots/example2.md) | `Grok: example3` | board:read/write/start, vault:read/write | `example2` |
| **Example Five** | [example5.md](./bots/example5.md) | `Grok: Example Five` | board:read/write/start, vault:read/write | `example5` |
| **Inbox** (peer) | [inbox.md](./bots/inbox.md) | `Grok: Inbox` (optional) | board:read/write | `example`, `operator` |

This is the **board / PM surface**. It is not the whole server. Admin, secrets, shell, deploy, and `/api/internal/*` (localhost sessions on the VPS) stay out of this contract on purpose.

## Auth

| Client | How |
| --- | --- |
| Browser UI | `POST /api/auth/login` → httpOnly cookie. Token is **not** in the JSON. |
| Agent / Grok Bot | Settings → You → **Agent keys** → *New agent key*: one named, scoped key per bot (below). Copy `cc_live_…`; it is never shown again. |
| Legacy full-access key | Settings → You → **Generate API key**. Acts as you everywhere. Kept working for existing integrations; retire it once every bot has its own key. |
| Password script | `POST /api/auth/token` → short-lived JWT (7 days) |

Every board call:

```
Authorization: Bearer cc_live_…
Content-Type: application/json
```

Rotate or revoke keys on the same Settings page. `GET /api/auth/me` is the identity check.

### Agent keys — one named, scoped key per bot

The key above is the **legacy full-access key**: it acts as you everywhere and keeps working exactly as before. For a Grok Bot, mint an **agent key** instead (Settings → You → **Agent keys** → *New agent key*, or `POST /api/auth/agent-keys` while logged in). Each agent key is its own principal:

- **Label** — e.g. `Grok: Example`. Cards it creates land with `origin: "agent_api"` and `agent_key_label: "Grok: Example"`, and the board chip shows the label. Its creates, status changes and messages are written to `objective_audit` with `actor = agent_key:<id>:<label>`.
- **Scopes** — enforced server-side on every call:

  | Scope | Allows |
  | --- | --- |
  | `board:read` | list / search / read cards, threads, briefing, workspaces, models, agents, **`/api/agent/changes`**, **`/api/agent/attention`** |
  | `board:write` | create, edit, `/message`, `/stop`, status moves other than the two below |
  | `board:start` | `PATCH …/status {"status":"working"}`, start/approve planning, **create with `"start": true`** (needs `board:write` too) |
  | `board:cancel` | `PATCH …/status {"status":"cancelled"}` — retire a duplicate (obj 718417: split out of `board:done`) |
  | `board:done` | `PATCH …/status {"status":"done"}` — the human signature |
  | `board:delete` | `DELETE /api/objectives/:id` |
  | `vault:read` / `vault:write` | `GET /api/docs/*` + `GET /api/files/search\|stat\|download` / `PUT /api/docs/file`, `POST /api/kb-wiki/answers` |

  New keys default to **everything except `board:done` and `board:delete`** — done is a human signature. A call the key is not scoped for returns `403 { "error": "…", "missing_scope": "board:done" }`. Anything outside this surface (admin, secrets, the secrets broker, internal, key management) returns `403` with `missing_scope: null` — an agent key can never mint itself another key.
- **Workspaces** — optional allowlist. A key pinned to `["example"]` only lists, reads, creates and edits cards in `example`; asking for another workspace returns `403 { "error": "…", "workspace": "example2" }`. A create with no `workspace` lands in the key's only workspace (a `?workspace=` query param now counts too — it used to be ignored and the card went to `example`). The changes feed and attention brief are filtered to the allowlist **in SQL**, so a pinned key never sees another workspace's events, counts or items. The allowlist covers board cards and the files API (an agent key must pass `workspace` there unless pinned to one, and cannot read system roots); markdown vault access is governed by `vault:read` / `vault:write`.
- **MCP** — `/api/mcp` itself only needs a valid key; every tool call is re-issued to the REST route it wraps **with the same key**, so it gets exactly the scope + workspace checks above. MCP write tools need a named agent key — the legacy key is read-only there (see [MCP server](#mcp-server)).
- **Last used** and **revoke** per key on the Settings card. A revoked key gets `401` immediately; other keys keep working.

`GET /api/auth/me` called with any key returns an `api_key` block — `{ kind: "agent"|"legacy", id, label, scopes, workspaces }` — so a bot can check who it is and what it may do before acting.

| Method | Path | Why |
| --- | --- | --- |
| GET | `/api/auth/agent-keys` | List your agent keys (no secrets) |
| POST | `/api/auth/agent-keys` | `{ label, scopes?, workspaces? }` → key + plaintext `token` (once) |
| DELETE | `/api/auth/agent-keys/:id` | Revoke one key |

## What a card is

An **objective** is a kanban card. One card, one coding-agent session (Claude / Grok / Codex in tmux). Status is the source of truth:

```
planning → queue → working → ai_review → review → done
                              ↘ cancelled
```

- `working` — session running
- `review` — Needs You (human gate)
- `done` / `cancelled` — parked. A follow-up message will not reopen them. PATCH `status=working` is the explicit reopen.
- `type`: `project` (planning + AI review + human sign-off), `bug` (AI review, no human gate), `task` (light)
- `workspace` — org slug (`example`, `example2`, …)
- `project` — git folder under `/home/operator/projects`

Default `GET /api/objectives` is the **live pipeline only** (excludes done + cancelled). Pass `?status=done` or `?status=cancelled` for those columns. List rows are slim; `GET /api/objectives/:id` is the full card.

**Default page for API keys.** With an agent key or the legacy key and no `?limit`, the list returns the **newest 50** rows and the header `X-Default-Limit: 50` (the unpaged board is ~100k tokens). Page with `?limit=` (max 200) and `&offset=`. Browser sessions are unchanged.

## Agent loop (the whole job)

An orchestrator (Grok Bot, an MCP client, a cron) should not re-read `/api/objectives` + `/api/briefing/briefing`
every turn. The loop is:

1. `GET /api/auth/me` — once per conversation: your key's label, scopes and workspaces.
2. `GET /api/agent/attention` — the cards that need a decision, one line each, most urgent first.
3. `GET /api/agent/changes?since=<stored cursor>` — only what moved. Store `next_cursor` and send it back next
   time; if `has_more` is true, call again immediately. No cursor yet → omit `since` (last 24h).
4. On an `entered_review` / `verdict` / `session_ended` / `pr_merged` event, fetch that one card
   (`GET /api/objectives/:id`). Do not re-pull the board.
5. `POST /api/objectives` with an **`Idempotency-Key`** header (always) — and `"start": true` to create + dispatch
   in one call. Without `start`, it lands in `queue` / `planning` and does not start a session.
6. `POST /api/objectives/:id/message` `{ "message": "…" }` (with an `Idempotency-Key`) — follow up in the thread.
7. `GET /api/objectives/:id/output` — read the thread (`?view=timeline` for the collapsed view).
   While it runs, `GET /api/objectives/:id/progress` answers "how's it going" without reading the whole thread.
8. `PATCH …/status` `{ "status": "done" }` — **the human** signs off. Bot keys lack `board:done` and get
   `403 missing_scope: board:done`.

Do **not** create a card to answer “what's the status?”. Read attention + changes.

Over MCP the loop is the same with typed tools: `whoami` → `get_attention` → `get_changes` → `get_objective` /
`get_progress` → `create_objective` / `send_message` / `start_objective`. See the [parity table](#parity-every-rest-action-a-bot-takes--its-mcp-tool).

## Endpoints (this surface)

| Method | Path | Why |
| --- | --- | --- |
| GET | `/api/health` | Liveness (no auth) |
| GET | `/api/agent` | Discovery (no auth) |
| GET | `/api/openapi.json` | This contract (no auth) |
| POST | `/api/auth/token` | Bearer JWT |
| GET | `/api/auth/me` | Who am I |
| GET | `/api/workspaces` | Orgs you can see |
| GET | `/api/models` | Enabled coding models |
| GET | `/api/objectives` | List cards |
| GET | `/api/objectives/search?q=` | Search including done |
| GET | `/api/objectives/strategies` | Strategy cards |
| GET | `/api/objectives/:id` | Full card |
| POST | `/api/objectives` | Create |
| PUT | `/api/objectives/:id` | Edit fields (not status) |
| PATCH | `/api/objectives/:id/status` | Move the card / start / reopen / done |
| DELETE | `/api/objectives/:id` | Delete |
| POST | `/api/objectives/:id/message` | Follow-up (starts/resumes worker) |
| GET | `/api/objectives/:id/output` | Thread |
| GET | `/api/objectives/:id/timeline` | Session events |
| GET | `/api/objectives/:id/progress?limit=&before=` | **How's it going** — latest worker snapshot, paged events, transcript fallback, children roll-up, session starts (who/what restarted it) |
| POST | `/api/objectives/:id/progress` | Write a snapshot (owner/admin) |
| GET | `/api/objectives/:id/artifacts` | Live partial outputs in the card memory dir (mid-run) |
| GET | `/api/objectives/:id/artifacts/file?path=&tail_bytes=` | Read one (secret-redacted, ≤1 MB per read) |
| POST | `/api/objectives/:id/stop` | Kill session, park in review |
| GET | `/api/briefing/briefing` | Working / blocked / needs-you |
| GET | `/api/agent/changes?since=` | Cursor-paged deltas (control layer) |
| GET | `/api/agent/attention` | Compact “needs a decision” brief (control layer) |
| POST | `/api/mcp` | Remote MCP server: knowledge + board tools in one connector ([below](#mcp-server)) |
| GET | `/api/docs/search?q=` | Second-brain search |
| GET | `/api/docs/file?path=` | Read a vault markdown file |
| PUT | `/api/docs/file` | Write a `.md` file |
| POST | `/api/kb-wiki/answers` | Save an answer into a workspace knowledge base as a wiki page `{workspace, question, answer, sources}` |
| GET | `/api/files/search?q=&ext=&type=&path_prefix=&modified_after=` | Find non-markdown files (pptx, pdf, key, images…) — read-only, workspace-scoped |
| GET | `/api/files/stat?path=&sha256=1` | One file's size, mime, mtime, created, optional sha256 |
| GET | `/api/files/download?path=` | Stream one file (`Range` supported; 413 over the cap, default 200 MB) |
| GET | `/api/files/search?system=1&content=` | Also search system roots (configs, logs, crontabs); `content` matches redacted text and returns snippets |
| GET | `/api/files/download?path=<system file>&tail_bytes=` | System files come back **redacted** (`X-Redacted: true`, `X-Redaction-Count`); `.env*` as `KEY=[REDACTED]` |
| GET | `/api/secrets-broker/list` | Secret **names**, scope and allowed hosts you can use — never values (not available to named agent keys) |
| POST | `/api/secrets-broker/http` | One HTTPS call with `{{secret:NAME}}` injected server-side to an allowlisted host; response redacted |

The vault is `/home/operator/second-brain`. Same API key as the board. Start at `workspaces/<slug>/active.md` (or `personal/active.md`), then `index.md`, then search. CoS writes **personal** memory; each company Bot writes that company’s `active.md` / `decisions/`. Nobody rewrites the vault on “what needs me?”. Do not clone the GitHub repo into Grok Bot — that copy goes stale.

Errors are `{ "error": "…" }` with 400 / 401 / 403 / 404 / 409 / 422 / 429. A scope refusal adds `missing_scope`; a workspace refusal adds `workspace` + `allowed_workspaces`.

409 on `/message` means the card is done or cancelled — reopen first. 409 on `/status` is a session cap, branch lease, or completion gate.

## Live progress (obj 715699)

`GET /api/objectives/:id/progress` is the cheap "how's it going" read. Same key, same workspace scoping as `GET /:id` (an unreadable card is a 404). Unknown query params are a 400.

| Field | What it is |
| --- | --- |
| `latest` | The worker's newest snapshot: `step` / `total_steps`, `label`, `note`, `result` (partial result), `artifacts` (refs), `created_at` |
| `events`, `total_events`, `next_before` | Newest-first event list; pass `?before=<next_before>` for the next page (`?limit=` 1–100, default 20) |
| `progress_source` | `worker` (it wrote snapshots), `transcript` (it didn't — use `transcript`), or `none` |
| `transcript` | Derived from the live transcript: `last_tool` {name, summary}, `last_assistant_message`, `assistant_turns`, `tool_calls`, `num_turns`, `elapsed_seconds`, `last_event_at` |
| `children` | For a parent that fanned out: each child's status, latest snapshot and (once past working) final `result`, plus `by_status` counts |
| `fanout` | The parallel group: `max_concurrency`, `child_ids`, `completed_at` |
| `session_starts` | Newest 10 spawns/resumes: `kind` (`spawn` / `resume` / `attach` = a second start folded into the live session / `rejected`), `reason` (`board`, `agent`, `follow_up`, `ci_failure_followup`, `resume_after_limit`, `routine`, `fanout`, …), `actor` |

`GET /api/objectives/:id/artifacts` lists what the worker has written to the card's memory dir so far (`ARTIFACT.md`, `live/…`, `work/…`). `GET …/artifacts/file?path=<rel>` reads one; `tail_bytes=` for a growing log. Text is secret-redacted (`X-Redaction-Count`), binaries are listed but not served, and the worker's private scratch file is never listed or served.

Everything in progress notes and artifacts passes through a redaction step (known secret values → `[REDACTED:NAME]`, credential shapes → `[REDACTED:FAMILY]`). It will switch to the fuller #715532 redactor once that merges.

### Worker side

Sessions on the box write progress with `scripts/cc-live.mjs` (zero-dep Node; hits the localhost-only `/api/internal/objectives/:id/progress`). The worker prompt tells every session to do this at each meaningful step:

```bash
node scripts/cc-live.mjs progress <id> --step 2 --of 5 --label "Scraping actor B" --note "120/400 rows" --artifact live/actor-b.csv
node scripts/cc-live.mjs fanout <id> --spec children.json --max 3   # N independent child cards, run in parallel
node scripts/cc-live.mjs children <id>                              # their progress + results
```

Fan-out creates the children through `POST /api/internal/objectives` (every delegation rail applies — 20 children per parent, nesting rules), then registers them with `POST /api/internal/objectives/:id/fanout {child_ids, max_concurrency}`. The server starts children up to the ceiling (default 3, max 10), never takes the board within 5 slots of the global session cap, starts nothing while no Claude account is available, and starts the rest as siblings finish. Delegator parents (`delegate_mode`) keep the existing create-time auto-start under the per-parent cap.

## Control layer: changes feed, attention brief, idempotency, create+start

### `GET /api/agent/changes?since=<cursor>&workspace=<slug>&limit=<1-500, default 100>`

```json
{ "events": [
    { "cursor": "18231", "at": "2026-10-04 20:12:40", "objective_id": 714091, "title": "Worker: control-layer endpoints",
      "workspace": "operationkit", "type": "entered_review", "from": "ai_review", "to": "review" },
    { "cursor": "18232", "at": "2026-10-04 20:12:41", "objective_id": 714091, "title": "…", "workspace": "operationkit",
      "type": "verdict", "to": "fail", "detail": "[criterion-2] no test for cursor paging" }
  ],
  "next_cursor": "18232", "has_more": false }
```

- `type`: `created` · `status` (`from`/`to`) · `entered_review` (moved into **Needs You**) · `verdict` (AI review landed,
  `to` = pass/fail, `detail` = first line of findings) · `session_ended` (`detail` = first line of the summary) ·
  `pr_opened` / `pr_merged` / `pr_closed` (`detail` = PR URL) · `deleted`.
- The cursor is the event id: strictly increasing, never reused, no gaps or duplicates across pages. Always send back
  `next_cursor` — it advances even when `events` is empty (past rows you cannot see), so an idle poll is cheap.
- Omit `since` on the very first call → the last 24h. `since=0` → everything retained (30 days).
- Events are recorded by database triggers, so every pathway (UI, API, state-poller, auto-merge) shows up — including
  the poller's `working → ai_review → review` moves that `objective_audit` never captured.
- Same visibility as the board list, narrowed to an agent key's workspace allowlist. Needs `board:read`. Unknown query params → 400.

### `GET /api/agent/attention?workspace=<slug>&stale_min=30&limit=15`

```json
{ "as_of": "2026-10-04T20:15:00.000Z", "workspace": "operationkit",
  "counts": { "failed_review": 1, "blocked": 0, "review": 4, "stuck": 1 },
  "items": [
    { "id": 714090, "kind": "failed_review", "title": "Worker: keys/scopes", "why": "AI review FAIL: [scopes] no 403 test", "age_min": 12 },
    { "id": 714088, "kind": "review", "title": "…", "why": "AI review passed — accept or reopen: Shipped PR 509", "age_min": 40 },
    { "id": 714092, "kind": "stuck", "title": "…", "why": "No activity for 95 min while working", "age_min": 95 }
  ],
  "truncated": false }
```

Ordered most-urgent first: `failed_review` → `blocked` → `review` → `stuck` (working with no activity ≥ `stale_min`).
Titles ≤70 chars, `why` one line ≤140 chars. `counts` are complete even when `items` is truncated. Without `?workspace=`,
each item carries `ws`. Needs `board:read`; a pinned key's items and counts cover only its workspaces. A typical
workspace is about 1–4 KB, against tens to hundreds of KB for `/api/briefing/briefing` + `/api/objectives`.

### `Idempotency-Key` header — `POST /api/objectives`, `POST /api/objectives/:id/message`

Send any unique string (≤255 printable ASCII) — a fresh UUID per intended card or message, reused verbatim on
retry. A repeat with the same key from the **same credential** within **24h** returns the stored response (same
status, same body, header `Idempotent-Replayed: true`) and does not run again, so a retried create returns the
**same card id**. Same key + different body → `422`. If the first request is still running → `409`. 5xx responses
are not stored.

The namespace is *(user, credential)*: each agent key, the legacy key and the browser session have their own. Two
Grok Bots of the same user that happen to pick the same key therefore create **two** cards, not one replay of the
other's. Over MCP, pass it as `create_objective(…, idempotency_key)`.

### `POST /api/objectives` with `"start": true`

Creates the card and moves it `queue → working` in one call, under the same session cap and lease gates as
`PATCH /status`. An agent key needs `board:start` as well as `board:write`; without it the whole create is refused
with `403 missing_scope: board:start` (nothing is created). The response is the card plus a `start` block:

| Outcome | HTTP | Body |
| --- | --- | --- |
| Started | 201 | `{ …card, "status": "working", "start": { "started": true } }` |
| Session cap reached | **409** | `{ "error": "Maximum 25 concurrent sessions reached — card #N created but left in queue", "objective": {…}, "start": { "started": false, "status": "queue", "reason": "session_cap" } }` |
| Branch/identity lease held | 409 | same shape, `reason: "lease_conflict"` |
| `type: project` (starts in planning) | 201 | `start.reason: "not_startable"` |
| Spawn error | 201 | `start.reason: "start_failed"` (card exists; PATCH status later) |

On 409 the card **exists** — do not create it again. Retry with `PATCH /api/objectives/:id/status {"status":"working"}`.

## Not this API

| Prefix | Who |
| --- | --- |
| `/api/internal/*` | Sessions **on the VPS** (localhost + secret). Bulk-create, deploy, Hermes. |
| `/api/admin/*` | Operators. Rebuild, accounts, users. |
| `/api/secrets` | Credential store. |
| `/ws` | Browser board live-tail. Cookie only — agents poll. |

## Quick curl

```bash
BASE=https://cc.example.com
KEY=cc_live_…   # an agent key from Settings → You → Agent keys

curl -s $BASE/api/auth/me -H "Authorization: Bearer $KEY" | jq .api_key
curl -s "$BASE/api/agent/attention?workspace=example" -H "Authorization: Bearer $KEY" | jq .
CURSOR=$(curl -s "$BASE/api/agent/changes" -H "Authorization: Bearer $KEY" | jq -r .next_cursor)
curl -s "$BASE/api/agent/changes?since=$CURSOR" -H "Authorization: Bearer $KEY" | jq .
curl -s -X POST $BASE/api/objectives -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{"title":"Fix footer link","description":"…","workspace":"example","type":"task","start":true}'
```

## MCP server

### Relaying a secret request (obj 719065)

When a worker needs a credential it emits `request_secret` (name, reason, suggested scope). The card shows
"Needs secret" plus a masked popup in its chat, and `get_attention` (kind `needs_secret`, with
`secret_requests[].request_id`), `get_progress` (`secret_requests`) and `list_secret_requests` all surface it.
A managing agent that holds `board:secrets_request` (never in the default set) can relay it without the value
entering any model context:

1. Ask Mike in your own chat with your masked secret card; keep the value in a host env var named `NAME`.
2. `fulfill_secret_request(request_id)` returns a one-time, write-only upload (`upload_url`, `upload_token`,
   ~15 min, single use, only for that NAME) and a ready `curl` that reads `$NAME`:
   `printf %s "$NAME" | curl -sS -X POST '<upload_url>' -H 'X-CC-Upload-Token: <token>' -H 'Content-Type: text/plain' --data-binary @-`
3. Your HOST runs it. The value lands in the existing secrets store (encrypted, versioned); the secret's History
   shows `via agent <label> (key #id) relayed the request on card #N`; the card resumes on its own.

A reused, expired or wrong-name token is refused (410 / 410 / 403). No tool ever returns a secret value. If your
host cannot run curl, send Mike the returned `owner_link` — the card shows the same popup.

**One connector, one URL, knowledge + board.** `POST /api/mcp` is the remote MCP server for Grok Bots and any other
MCP client. It is the same URL the read-only **command-center-knowledge** connector already uses (obj 716490). The
six knowledge tools keep their names and behaviour, and the board tools sit beside them (obj 718417). A connected
Bot gets the new tools at its next chat. Nothing about the URL changes.

| | |
| --- | --- |
| URL | `https://cc.example.com/api/mcp` |
| Transport | Streamable HTTP, **stateless**: `POST` only, JSON responses. `GET` is 405 (there is no SSE stream). |
| Auth | `Authorization: Bearer cc_live_…`: the bot's own agent key (a JWT also works). No header → `401` + `WWW-Authenticate: Bearer`. Cookies are ignored. |
| Writes | **Need a named agent key.** On the legacy full-access key the connector is read-only: write tools return a tool error that tells the bot to ask for a named key. That key can also set `done`, so it must not reach every bot that shares a connector. |
| Tool list | Filtered per key: a named key only sees tools whose scope it holds (Inbox never sees `start_objective`). The guard on the forwarded REST call remains the authority. |
| Discovery | `GET /api/agent` → `mcp` block (url, transport, tools, aliases) |
| Setup | [bots/SETUP.md](./bots/SETUP.md) |

Every tool runs **as the key**, through the REST route in the table below. The call is re-issued over loopback with
the same Bearer key, so the agent-key guard (scopes + workspace allowlist + audit), workspace membership, status
transitions, session cap and completion gate all apply exactly as on REST. MCP has no shortcut around them. Cards
created through MCP carry the same `origin: agent_api` + `agent_key_label` as REST. Only public `/api/*` routes are
wrapped: never `/api/internal/*`, `/api/admin/*`, `/api/secrets*`, the secrets broker or `/shell`. There is no
merge, deploy, spend or delete tool.

### Parity: every REST action a bot takes → its MCP tool

| Bot action | REST route | MCP tool | Scope (agent key) |
| --- | --- | --- | --- |
| Who am I / what may I do | `GET /api/auth/me` | `whoami` | any valid key |
| What needs a decision | `GET /api/agent/attention` | `get_attention(workspace?, stale_min?, limit?)` | board:read |
| What moved since last poll | `GET /api/agent/changes?since=` | `get_changes(since?, workspace?, limit?)` | board:read |
| Wider board snapshot | `GET /api/briefing/briefing` | `board_briefing` | board:read |
| List cards | `GET /api/objectives` | `list_objectives(workspace?, status?, limit?, offset?)` | board:read |
| Search cards (incl. done/cancelled) | `GET /api/objectives/search` | `search_objectives(q, workspace?, limit?)` · alias `search_cards` | board:read |
| Read one card (+ PR link) | `GET /api/objectives/:id` | `get_objective(id)` · alias `get_card`. Returns `pr_url` and card `url` | board:read |
| Create in a workspace | `POST /api/objectives` (+ `Idempotency-Key`) | `create_objective(title, workspace, …, idempotency_key?)`. **`workspace` is required** and validated against `list_workspaces` | board:write |
| Create + start | `POST /api/objectives {"start":true}` | `create_objective(…, start: true)`. A 409 (cap) still returns the created card | board:write + board:start |
| Start / restart | `PATCH /api/objectives/:id/status {"status":"working"}` | `start_objective(id)`. Retries **once** on a 5xx and re-reads the card first, so it never double-starts. 4xx is not retried | board:start |
| Park / reopen | `PATCH …/status {"status":"queue"\|"planning"}` | `update_status(id, status)` | board:write |
| Cancel a duplicate | `PATCH …/status {"status":"cancelled"}` | `update_status(id, "cancelled")` | **board:cancel** |
| Sign off (done) | `PATCH …/status {"status":"done"}` | `update_status(id, "done")` | **board:done** (no bot key has it) |
| Edit title / brief / goal | `PUT /api/objectives/:id` | `update_objective(id, title?, description?, completion_goal?, agent_context?, project?, model?, effort?)` | board:write |
| Follow-up message | `POST /api/objectives/:id/message` (+ `Idempotency-Key`) | `send_message(id, message, idempotency_key?)` | board:write |
| How's it going | `GET /api/objectives/:id/progress` | `get_progress(id, limit?)` | board:read |
| Thread / output | `GET /api/objectives/:id/output[?view=timeline]` | `get_output(id, view?, limit?)` | board:read |
| Deliverables mid-run | `GET /api/objectives/:id/artifacts[/file]` | `get_artifacts(id, path?, tail_bytes?)` | board:read |
| Stop a stuck worker | `POST /api/objectives/:id/stop` | `stop_objective(id)` | board:write |
| Open secret requests | `GET /api/agent/secret-requests` · `GET /api/objectives/:id/secret-requests` | `list_secret_requests(workspace?)` | board:read |
| Relay a secret request | `POST /api/objectives/:id/secret-requests/:request_id/upload-token` | `fulfill_secret_request(request_id, scope?)` | board:secrets_request |
| Workspaces / agents | `GET /api/workspaces` · `GET /api/agents` | `list_workspaces` · `list_agents` | board:read |
| Built-in chat agents (obj 719987) | `GET /api/agent-chat/agents` · `GET /api/agent-chat/agents/:slug` | `list_chat_agents` · `get_chat_agent(slug)`: the agent's instructions, knowledge folders and tools, to act as it from any MCP client. Chat history and drafts are never on this surface | vault:read |
| Knowledge base search | `GET /api/docs/search` | `search(q, workspace?, limit?)` | vault:read |
| Knowledge base browse | `GET /api/docs/tree` | `list_folders(root?)`: with no `root`, the ONE knowledge base tree (no source to pick); `root` = a folder inside it to go deeper. Response `{ root, label, folders[], tree }` | vault:read |
| Knowledge base read | `GET /api/docs/file` | `read_file(path)` (`.md`) | vault:read |
| Knowledge base write | `PUT /api/docs/file` | `write_doc(path, content)` | vault:write |
| Save an answer to the wiki | `POST /api/kb-wiki/answers` | `file_answer(workspace, question, answer, sources?)`: becomes `answers/<date>-<question>.md`, linked from the pages it used | vault:write |
| Knowledge-base connections | `GET /api/kb-wiki/graph/related` | `kb_related(workspace, page, depth?)`: pages linked to one page (path or name), each with kind (`related` / `mentions` / `cited_by` / `answer_used`) and label (`works for` …); depth ≤ 2 | vault:read |
| Who knows about a topic | `GET /api/kb-wiki/graph/who-knows` | `kb_who_knows(workspace, topic, limit?)`: people linked to a topic, ranked by number of citing sources then recency | vault:read |
| File search | `GET /api/files/search` | `search_files(q?, glob?, ext?, type?, path_prefix?, modified_*?, workspace?)` | vault:read |
| File details | `GET /api/files/stat` | `file_info(path, workspace?, sha256?)` | vault:read |
| File download | `GET /api/files/download` | `read_file(path, workspace?)`: text inline, binary base64 up to 300 KB, else metadata only | vault:read |
| Star / starred filter | — | — | No `starred` field exists on `main`, so there is nothing to wrap |
| Delete a card | `DELETE /api/objectives/:id` | **none on purpose** | board:delete (REST only) |

**Canonical names.** `get_objective` and `search_objectives` are canonical. `get_card` and `search_cards` are
aliases with identical output, kept because connectors were set up against them. #514's `vault_search` /
`vault_read` never shipped; `search` / `read_file` cover them.

**Agent keys on the files API** must name a `workspace`, except a key pinned to exactly one, which is filled in
automatically. They cannot use `system` / `root` / `content`, so the redacted system roots (configs, logs,
crontabs) stay a human surface.

Every **write** answers with a short receipt: `{ confirmation: "Created #1234 \"…\" in example and started it.", id,
url: "https://cc.example.com/o/1234", title, status, workspace }`. The base URL follows `APP_BASE_URL` if the app
moves hosts.

Outputs are trimmed to save tokens: slim rows, long prose clipped, and tool payloads stripped from thread output. A REST error comes back as a tool result with `isError: true` and text `Error <status>: <message>`, so the model can see a `409` and react to it. A scope refusal adds ` (missing_scope: board:done)` to that text and `structuredContent: { error, status, missing_scope }`. The server `instructions` and tool descriptions carry the bot rules: **attention → changes, not the board**, **always an idempotency_key on create**, **read before you write**, and **`done` is a human signature (Mike's)**.

### xAI API (Grok) — remote MCP tool

```json
{
  "model": "grok-4",
  "input": "What needs me on the example board?",
  "tools": [{
    "type": "mcp",
    "server_url": "https://cc.example.com/api/mcp",
    "server_label": "command_center",
    "authorization": "Bearer cc_live_…"
  }]
}
```

Python SDK: `mcp(server_url="https://cc.example.com/api/mcp", server_label="command_center", authorization="Bearer cc_live_…")`. A bare token (without `Bearer `) is accepted too. The scoped key is the real limit (a key without `board:write` cannot write, whatever tools are listed). Add `allowed_tools` (REST) / `allowed_tool_names` (SDK) to also hide tools from the model, e.g. read-only access without `create_objective`, `update_status`, `send_message` or `stop_objective`.

### Claude

Claude Code:

```bash
claude mcp add --transport http command-center https://cc.example.com/api/mcp \
  --header "Authorization: Bearer cc_live_…"
```

Messages API MCP connector (beta `mcp-client-2025-11-20`). This needs both halves: the server entry and a toolset that names it.

```json
{
  "model": "claude-opus-5",
  "max_tokens": 16000,
  "mcp_servers": [{
    "type": "url",
    "url": "https://cc.example.com/api/mcp",
    "name": "command-center",
    "authorization_token": "cc_live_…"
  }],
  "tools": [{ "type": "mcp_toolset", "mcp_server_name": "command-center" }],
  "messages": [{ "role": "user", "content": "Brief me on the board." }]
}
```

**Claude.ai custom connector** (Settings → Connectors → Add custom connector): set the URL to `https://cc.example.com/api/mcp`. Claude.ai connectors authenticate with OAuth or not at all. They cannot send a static `Authorization` header, so a Claude.ai connector gets `401` until the OAuth resource-server follow-up ships. Until then, use the Messages API or Claude Code snippets above.

### Raw JSON-RPC (debugging)

```bash
curl -s https://cc.example.com/api/mcp \
  -H "Authorization: Bearer $CC_KEY" -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | jq '.result.tools[].name'
```


## Secrets: use without reveal (obj 715532)

Bots never see a credential value. Two ways to use one:

1. **Broker call** — `GET /api/secrets-broker/list` shows the names you may use and the hosts each may go to.
   Then `POST /api/secrets-broker/http` with a placeholder:

   ```json
   {
     "method": "GET",
     "url": "https://abc.supabase.co/rest/v1/contacts?select=id&limit=1",
     "headers": { "apikey": "{{secret:SUPABASE_SERVICE_ROLE}}", "Authorization": "Bearer {{secret:SUPABASE_SERVICE_ROLE}}" }
   }
   ```

   The server injects the value, sends the request (https, port 443, no redirects), and returns
   `{ status, headers, body, redacted, redaction_count }` with every secret value and credential pattern
   replaced. A host not on that secret's allowlist is a `403`; a secret your key can't see is a `404`.

2. **Worker sessions** already get their workspace's secrets as environment variables. Anywhere a value
   would be stored — transcripts, card threads, follow-ups, session summaries, activity rows — it is
   replaced by `[REDACTED:<NAME>]`, where `NAME` is the env var to use instead.

Policy lives in the `settings` row `secrets_broker_policy` (JSON) or env `CC_SECRETS_BROKER_POLICY`:

```json
{
  "SUPABASE_SERVICE_ROLE": { "hosts": ["*.supabase.co"], "description": "example-platform service role", "workspaces": ["example"] },
  "GITHUB_TOKEN":          { "hosts": ["api.github.com"], "methods": ["GET"] }
}
```

`hosts`: exact host or `*.suffix` (subdomains only — not the apex, not look-alikes). `workspaces`: lets members of
those workspaces see/use a **global** secret (workspace-scoped secrets are already visible to their workspace).
`methods`: optional. A secret with no entry is listed but unusable.

Redaction markers: `[REDACTED:<SECRET_NAME>]` for a known configured value; `[REDACTED:<FAMILY>]` for a detected
shape (`OPENAI_KEY`, `ANTHROPIC_KEY`, `CC_API_KEY`, `GITHUB_TOKEN`, `SLACK_TOKEN`, `AWS_ACCESS_KEY`, `GOOGLE_API_KEY`,
`STRIPE_KEY`, `SUPABASE_KEY`, `JWT`, `PRIVATE_KEY`, `BEARER`, `ASSIGNMENT`, `CONN_PASSWORD`).
