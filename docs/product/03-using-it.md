# Using it

Pictures of the same product: [flowchart](./01-what-it-is.md), [loop](./02-how-it-works.md), [tables](./07-data.md).

## Board

The Board is a workspace-grouped card view. Cards open as popup overlays; click **Expand** (or the external-link icon) to open the full card page in a new tab.

Create a card: **title** + **description** are required. The create form also offers **model** (when the registry has enabled models), **assign to** + **delegate mode** (admins only), and **attach files** (anyone). Everything else (organization, project folder, linked repo, PR flag) is set after creation via the edit drawer. Move a card to Working (or press Start) to launch the session. Open the card popup to see the live session and send follow-ups — drag a file or paste a screenshot to attach it.

Column order on desktop: Queue → Working → Needs You → Done. On mobile the columns stack vertically as Needs You → Working → Queue → Done so the human gate is always visible first.

A thin banner appears above the board when the host is low on disk (orange) or critically full (red, new messages refused until cleanup frees space). It polls every 5 minutes and shows nothing the rest of the time.

Manual cards in queue still wait for Start. Approving a project plan starts the worker. A passing AI review on a task or bug marks it done. Green lightweight PRs merge themselves. Projects still sit in Needs You for a look.

## How it talks to you

Sessions write like a colleague. They do the work (APIs, Playwright, Google, GitHub, the filesystem) and only stop you for a decision, a missing secret, or a click they cannot reach. They do not ask “want me to?” for a commit, a PR, or a shell command. Worker-finished pings collapse into one line in the thread so a busy parent card stays readable. Ask in the composer if you want the technical dump.

## Chat

When the agent chat page is installed, **Chat** is the first item in the top bar. It is where most people talk to their agents day to day; the board is where the work shows up. The older built-in assistant ("Assistant") has been removed. Its old links (`/assistant`, `/mentor`, `/assistant`) open Chat, or the board if Chat is not installed.

## Another assistant (Claude / Grok / ChatGPT)

OperationKit has a remote HTTP API so a Project, custom GPT, or any bot can sit *beside* the board and project-manage: brief, create cards, follow up, mark done. It does not replace the coding agent on the card.

Paste [the portable prompt](../api/AGENT-PROMPT.md), give it an API key from **Settings → You** as `Authorization: Bearer cc_live_…`. The same key unlocks board management plus vault docs search (`GET /api/docs/search`, `GET/PUT /api/docs/file`). Spec: `GET /api/openapi.json`. Human doc: [API](../api/README.md).

Not to be confused with the **LLM gateway** (`/api/llm/v1`), which lets other apps such as Twenty CRM borrow a Claude seat for plain chat completions and never touches cards — see [How it works](./02-how-it-works.md#llm-gateway-for-other-apps-not-for-cards).

## Jobs

Routines on a cron. Each fire is a board card. Lanes: running, needs review, complete. This is the scheduler, not a second to-do list.

## Knowledge base

Your business's shared memory: plain markdown files on your own server that you and every agent read and edit. Open it from **Knowledge base** in the top bar (`/knowledge`; old `/docs` links still work). There is one knowledge base and one page list: each workspace is a folder in it, and imports (files, chat exports, call transcripts) land in the workspace's folder. Pick a page to read or edit it. Agent instructions and skills are on **Agents**, code repos on **Development**; they are not part of the knowledge base. Agents reach the same files over the API and MCP (`GET /api/docs/search`, `GET/PUT /api/docs/file`), so what you write here is what they know. Product docs for OperationKit live in this repo at `docs/product/`. Linked repos keep the same folder (see [Living docs](./LIVING.md)).

## Dashboard

Operator view: how many Claude seats are free, Grok/Codex connected, models on/off, spend, host CPU/disk. Connect a SuperGrok or Claude seat here — not in Settings.

## Settings

| Tab | Who | What |
| --- | --- | --- |
| You | everyone | API key (`cc_live_`), agent keys, personal secrets |
| Connectors | everyone | your GitHub and Google Workspace (Gmail, Calendar, Drive) accounts, and which agents and workspaces may use them — see [Connectors](./04-you.md#connectors) |
| Secrets | workspace/global admin | org/global keys, reviewer test logins |
| Org | global admin | organizations, users, **linked repos** |
| Agents | global admin | agent roster, assignments, skill graph |
| Platform | global admin | host cron |

## ⌘K

Jump to any chrome item, Settings slices, and parked pages (Contacts, Strategies, Development, Notes, Status, Feed) that are hidden from the bar on purpose.
