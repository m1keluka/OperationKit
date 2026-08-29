# Command Center API

Remote HTTP API so a person — or a **third-party agent** (Claude, Grok, ChatGPT, a cron, a bot) — can project-manage the board without sitting in the UI.

Live machine spec: `GET https://cc.example.com/api/openapi.json`  
Discovery: `GET https://cc.example.com/api/agent`  
Portable agent prompt: [AGENT-PROMPT.md](./AGENT-PROMPT.md)  
Standing bots: run one assistant per area of work, each named to match a workspace on
your board, all sharing the same `cc_live_` key and the portable prompt above. A typical
set is a starred **Chief of Staff** for intake and routing, one bot per company or client
workspace, and an **Inbox** bot for mail triage.

This is the **board / PM surface**. It is not the whole server. Admin, secrets, shell, deploy, and `/api/internal/*` (localhost sessions on the VPS) stay out of this contract on purpose.

## Auth

| Client | How |
| --- | --- |
| Browser UI | `POST /api/auth/login` → httpOnly cookie. Token is **not** in the JSON. |
| Agent / Grok Bot | Settings → **You** → **Generate API key**. Copy `cc_live_…`. Never shown again. |
| Password script | `POST /api/auth/token` → short-lived JWT (7 days) |

Every board call:

```
Authorization: Bearer cc_live_…
Content-Type: application/json
```

Rotate or revoke the key on the same Settings card. `GET /api/auth/me` is the identity check.

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

## Agent loop (the whole job)

1. `GET /api/jarvis/briefing` — what is working / blocked / needs you
2. `GET /api/objectives?workspace=<slug>` — the live board
3. `POST /api/objectives` — create work (lands in `queue` or `planning`; does **not** start a session)
4. `PATCH /api/objectives/:id/status` `{ "status": "working" }` — start the coding agent
5. `POST /api/objectives/:id/message` `{ "message": "…" }` — follow up in the thread
6. `GET /api/objectives/:id/output` — read the thread (`?view=timeline` for the collapsed view)
7. `PATCH …/status` `{ "status": "done" }` — you are signing off, not the coding agent

Do **not** create a card to answer “what's the status?”. Read the board.

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
| POST | `/api/objectives/:id/stop` | Kill session, park in review |
| GET | `/api/jarvis/briefing` | Working / blocked / needs-you |
| GET | `/api/docs/search?q=` | Second-brain search |
| GET | `/api/docs/file?path=` | Read a vault markdown file |
| PUT | `/api/docs/file` | Write a `.md` file |

The vault is `/home/operator/second-brain`. Same API key as the board. Start at `workspaces/<slug>/active.md` (or `personal/active.md`), then `index.md`, then search. CoS writes **personal** memory; each company Bot writes that company’s `active.md` / `decisions/`. Nobody rewrites the vault on “what needs me?”. Do not clone the GitHub repo into Grok Bot — that copy goes stale.

Errors are `{ "error": "…" }` with 400 / 401 / 403 / 404 / 409 / 429.

409 on `/message` means the card is done or cancelled — reopen first. 409 on `/status` is a session cap, branch lease, or completion gate.

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
TOKEN=$(curl -s -X POST $BASE/api/auth/token \
  -H 'Content-Type: application/json' \
  -d '{"username":"YOU","password":"YOU"}' | jq -r .token)

curl -s $BASE/api/jarvis/briefing -H "Authorization: Bearer $TOKEN" | jq .board
curl -s "$BASE/api/objectives?workspace=example&limit=20" -H "Authorization: Bearer $TOKEN"
```
