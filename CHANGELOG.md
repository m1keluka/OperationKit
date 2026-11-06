# Changelog

Notable operator-facing changes. Newest first.

> Not a release log — this repo deploys from `main`. Entries here are the changes
> that need an operator to *do* or *know* something. Day-to-day product changes are
> tracked in the board's own changelog (`GET /api/changelog`, Development → Changelog).

## Unreleased

### Card sessions can read their own workspace's knowledge base again (obj 900204)

**The bug.** With `SESSION_ISOLATION=docker` a session runs in a sibling container whose
only bind mounts are its own worktree (`/workspace`) and its own HOME (`/home/jailuser`).
The spawn prompt nevertheless told every session "Knowledge base is at `~/second-brain/`"
and "write a decision doc to `~/second-brain/workspaces/<ws>/decisions/`". Neither path
exists inside the jail. Cards therefore reported knowledge-base files "missing" when they
were plainly there (the LinkedIn `Connections.csv` report that opened this card), and the
MANDATORY vault-capture step failed silently on every jailed run.

**What changed.**

- **Nothing new serves bytes.** `/api/files` (non-markdown: csv, xlsx, pdf, pptx, images —
  read-only) and `/api/docs` (markdown: tree / file / search, and `PUT /file`) already
  implemented workspace-scoped, permission-checked file access. They were simply unreachable
  without a login. They now also accept a card's spawn-minted `CC_SESSION_TOKEN`
  (`X-CC-Session-Token:` or `Authorization: Bearer ccs_…`), which a jailed session can
  present over its existing loopback forwarder at `http://localhost:3002`.

- **The scope is the card's ONE workspace**, read from the objective row at request time —
  never from the token claim, never from `?workspace=`. An admin acting user grants no
  admin-wide access: the principal is de-escalated to `member` and system roots (service
  configs, logs, crontabs, `.env*`) are stripped from it. Admin endpoints hard-deny the
  principal. A card whose acting user is not a member of that workspace is refused.

- **The spawn prompt now tells the truth.** In `docker` isolation it prints the curl
  recipes above instead of `~/second-brain/`, says out loud that no vault path exists, and
  teaches the error codes: **404** = inside your workspace and genuinely absent; **403** =
  out of scope, and NOT evidence about whether the file exists. Vault capture writes through
  `PUT /api/docs/file` (with `create_dirs: true`). In `tmux` isolation both blocks are
  byte-identical to before.

- **Two bugs fixed on the way.** (1) `/api/files`' vault root was the hard-coded
  `/home/operator/second-brain` instead of `knowledgeBaseRoot()`, so on any install whose
  vault lives elsewhere — or has none — the scope contained zero vault entries and the route
  could not see a single knowledge-base file. It now follows the one knowledge base, and
  handles the flat `/app/data/knowledge-base/<slug>` layout. (2) `/api/docs` compared paths
  lexically, so a symlink planted inside a doc root was read and **written** through. Both
  sides are now realpath'd, matching what `/api/files` already did.

**Operator notes.**

- **ON by default.** A card that cannot read its own workspace's KB is the bug. Turn it off
  with the `session_kb_access` settings row set to `0`, or `CC_SESSION_KB_ACCESS=0`.

- **The spawn env changed.** Because the token is now minted for every spawn, every session
  env gains `CC_SESSION_TOKEN`, `CC_OBJECTIVE_ID` and `CC_STRIP_SIGNING_SECRETS`, and
  **loses `JWT_SECRET` / `CC_JWT_SECRET`**. Dropping the signing key is not optional: a
  session that still held it could mint itself a token for any workspace and the scoping
  would be decorative. If some script of yours read `JWT_SECRET` from a session env, it
  must move to `scripts/mint-service-token.sh` on the host.

- **How already-running sessions get the change.** They do not. Both halves are baked in at
  spawn time: the prompt text is written into the session's prompt file, and
  `CC_SESSION_TOKEN` into its `--env-file` (which `docker run` reads once, at container
  create). A session that started before the deploy has the old prompt and no token, and
  will keep looking for `~/second-brain`. **Re-run the card** (or send a follow-up, which
  re-spawns through `sendFollowUp` → `buildPrompt`) to pick it up. Sessions spawned after
  the backend restart get it automatically; no re-login, no re-upload, no migration.

- **Deploy is two steps and neither is automatic here.** Merging this PR does not make it
  live: the live checkout must be at `origin/main` AND the Node process must have restarted
  after the merge (`tsx` does not hot-reload). Verify both, then
  `POST /api/internal/deploy {"mode":"both"}`. Client installs additionally need the public
  `m1keluka/OperationKit` sync plus their own `install/update.sh`.

### Signing in through Cloudflare Access never asks for a password change (obj 900108)

On an install where people sign in at the Cloudflare Access door (an email one-time PIN,
Google or Microsoft), the app could still stop them on its "choose a new password" page —
for a password they have never had. Three separate things caused it, and all three are fixed.

**What changed.**

- **A leftover session no longer traps anyone.** If a person had ever used the installer's
  one-time setup password, their browser session was marked "must change password" and stayed
  that way. The app now accepts Cloudflare's signed identity on the request itself: when it
  verifies and the email belongs to that same user, the session is treated as an Access
  session and the prompt is gone. The browser also trades the old session for an Access-backed
  one, so it does not come back.

- **The stored flag no longer blocks API keys or the live board.** `must_change_password` on the
  user row is only ever cleared by an actual password change, so someone who signs in through
  Access could never clear it — and it was refusing their API keys with
  `password_change_required` and refusing their websocket. Both now allow a request that
  carries a verified Access identity for that user.

- **The installer stops forcing a change that cannot happen.** When the install is set up for
  Access sign-in *and* the first admin is linked to an Access email, that admin is no longer
  created with a forced password change. The one-time setup password stays as a **break-glass**
  login and **still expires** (72 hours by default, re-issued with
  `install/admin-password.sh`). If the email cannot be linked, the forced change is kept —
  nobody ends up with a credential that never has to be replaced.

**What did not change.** An install without Access configured behaves exactly as before: the
first admin must replace the setup password before anything else works, and the setup password
expires. Nothing here can sign anybody in — a missing, expired, wrongly-signed, wrong-audience
or wrong-issuer token, an email no user has, and an email two users share all leave the old
behaviour in place. No user is ever created or altered from a token.

**Action for existing installs:** none required for the app, the API keys or the live board —
an admin already stuck on the password page can simply reload after updating. One leftover is
worth clearing on a one-login install whose first admin was created *before* one login was
switched on: their row still carries the forced change, so exchanging their username and
password for a bearer token (`POST /api/auth/token`) is still refused. `install/verify.sh`
reports this by name, and `bash install/admin-password.sh --config client.conf` issues a fresh
break-glass password and clears it.

### A connected account belongs to one person — owner-scoped credentials and a per-key connector list (obj 900089)

When someone connects their Google or GitHub account in **Settings → Connectors**, that connection
is now usable only by them, and by the API keys and card sessions acting for them. Cross-user
access is refused by default rather than permitted by accident.

**What changed, and what you may need to do.**

- **An administrator role no longer reaches another person's connected account.** Administering the
  install and being every user are different things. Nothing a person connects is readable by an
  admin through any route, key or card. If an install was relying on an admin reading a colleague's
  connection, it must now be that colleague's own key or a separate connection.

- **Every API key is granted connectors one at a time, and gets none by default.** A newly created
  key reaches no connected account until its owner ticks one in *Settings → You → Agent keys →
  Connectors*. A ticked connector grants only that key owner's own connection.

  **Action for existing installs:** keys that existed before this change kept their previous reach
  and are listed as **"all connectors (legacy)"**. Nothing breaks, but each one is worth opening and
  narrowing to the connectors it actually needs. New keys do not get the legacy marker.

- **Assigning work no longer lends out the assignee's accounts.** A non-admin can only assign cards
  to themselves. An admin can still route a card to anyone — that is ordinary — but the session
  then runs as the assignee with their connections marked **absent**, unless the assignee has
  ticked *"let cards someone else assigned to me use this connection"* for that connector in
  Settings → Connectors. It is off by default. A job that needs a connection it cannot see says so
  rather than silently acting as somebody else.

- **Shared server credentials stop reaching AI jobs.** Credentials the install itself needs for
  background work (the OAuth client behind the per-user connectors, service-account and shared
  mailbox tokens) are now marked **server-only**: still loaded by the server, never injected into a
  session's environment. The flag is applied automatically to those names at global scope on first
  start; no data edit is needed, and an operator can clear it per secret in Settings → Secrets if
  their install genuinely needs one in sessions. Secrets stored for agents are untouched.

- **Every refusal is recorded.** A withheld credential writes an entry naming who asked, whose
  connection, which connector, the key's label and the reason — never a value. Admins read the
  tail at `GET /api/secrets/connector-denials`, beside the existing secrets access log.

**For anyone writing a connector:** credential reads go through one check
(`services/connector-guard.ts`) and the connector contract now carries `readCredential`, called
only after that check passes. See [docs/connectors/README.md](docs/connectors/README.md).

No configuration is required and no manual migration step exists; both schema changes apply on
first start.


### Installer: the API bypass steps around paths another Access app owns, and verify stops colliding with itself (obj 900069)

Two bugs found while deploying the step below on a client install.

**1. One pre-existing Access app stopped the whole Cloudflare step.** Cloudflare
refuses an Access application whose destination already belongs to a different
application on the same hostname (*"the destination … belongs to another
application"*, error code `12132`). An install that had been patched by hand
before `api-bypass` existed already had a separate MCP bypass app owning
`/api/mcp` — so `cloudflare.sh api-bypass` died there, and `update.sh` stopped
with it. It only completed with an `OK_API_BYPASS_CONF` override that edited the
route list out.

Now the step lists the account's Access applications first and splits the two
cases that look alike:

- the owning app is **itself a bypass / key-auth app** (it has a `Bypass`
  policy) → the path is **skipped with a warning naming the app and its id**,
  the rest of the list is applied, and `update.sh` completes with no override.
  A bot already reaches the app on that path, so nothing is lost.
- the owning app is **anything else** → those paths would stay behind the
  sign-in, so the step **stops and names the app** instead of shipping a
  half-open install.

**The other application is never created, edited or deleted** in either case.
The step stays idempotent: our own app is still looked up by name and updated
in place, never duplicated.

**The Bypass policy is now matched by what it does** — decision `bypass` with
include *Everyone* — and not only by our name for it. An install whose policy
had been renamed in the Cloudflare dashboard used to collect a **second**
Bypass/Everyone policy on every re-run.

**2. `install/verify.sh` failed with "could not create the test card (409)".**
Check 8 posted a card titled exactly `Install check: say hello` every time, and
the board's duplicate-title guard refuses a second open card with the same
normalized title in the same workspace inside its 24h window. So the first
verify after an install passed and every verify that day failed. The title now
carries the run's unique marker and the create sends `force: true`; verify also
**deletes its own throw-away card on the way out**, pass or fail, so nothing
piles up on the client's board. (This is the bug card #900022 describes.)

**Operator action: none.** Re-run `install/cloudflare.sh api-bypass` and
`install/verify.sh` as usual. If you had an install pinned to a trimmed
`OK_API_BYPASS_CONF` to get past the clash, you can drop the override.

**Tests.** `install/test/cloudflare-mock.mjs` now enforces Cloudflare's
duplicate-destination rule (`12132`), so `install/test/cloudflare-mock-test.sh`
reproduces the real failure and proves the skip, the refusal, the
other-app-untouched guarantee and the single-policy result;
`install/test/api-bypass-paths-test.sh` unit-tests the two new pure helpers in
`install/api-bypass-lib.sh`.

### Installer: bots can reach the board API with their key (obj 900028)

**What was wrong.** `install/cloudflare.sh` put ONE Cloudflare Access
application in front of the whole host. A bot calling the board API sends
exactly one credential — its Operation Kit `cc_live_` key — which Cloudflare
knows nothing about, so it answered with its HTML sign-in page and the key was
never checked. Every install had to be patched by hand in the Cloudflare
dashboard (the Example OVH host had a hand-made app, "Operation Kit API (key
auth)", doing exactly this).

**What changed.**

- **New installer step, on by default.** `cloudflare.sh up` now also creates a
  second, path-limited Access application named **"Operation Kit API (key
  auth)"** whose only policy is Bypass / Everyone. Cloudflare matches the most
  specific application first, so the listed API routes go straight to the app
  and everything else still hits the host-wide sign-in. It is idempotent: the
  app is looked up BY NAME and updated in place.
- **One route list**, `install/api-bypass-paths.conf`: `prefix /api/objectives`
  opens `/api/objectives` and `/api/objectives/*`; `exact /api/health` opens
  one address. Covers `/api/mcp`, `/api/agent`, `/api/agents`,
  `/api/agent-chat/agents`, `/api/objectives`, `/api/projects`,
  `/api/workspaces`, `/api/feed`, `/api/briefing`, `/api/docs`, `/api/kb-wiki`,
  `/api/files`, `/api/models` plus the exact `/api/health`,
  `/api/openapi.json`, `/api/auth/me` — 29 paths, no blanket `/api/*`.
- **A guard you cannot talk past.** `install/api-bypass-lib.sh` REFUSES any path
  under `/api/internal`, `/api/admin`, `/api/secrets`, `/api/secret-upload`,
  `/api/webhooks`, `/api/auth` (except the exact `/api/auth/me`), `/api/public`,
  `/api/llm`, `/api/alerts`, `/api/costs`, `/api/intel`, `/api/status`, and any
  blanket or wildcard entry. The step stops and changes nothing in Cloudflare.
- **verify.sh checks it both ways:** a keyless `GET /api/objectives` must come
  back `401` **as JSON from the app** (not a Cloudflare redirect), while
  `/api/internal`, `/api/admin/seats`, `/api/secrets` and `/api/auth/token`
  with no key must still be stopped by Cloudflare. `/` still redirects to the
  sign-in (existing check).
- **New standalone command + rollback:** `cloudflare.sh api-bypass` re-runs just
  this step after editing the list; `cloudflare.sh api-bypass remove` deletes
  the app and its policy, putting every API route back behind the sign-in.
  `cloudflare.sh down` removes it too. `API_KEY_AUTH_BYPASS="off"` in
  `client.conf` skips the step; `cloudflare.sh status` shows whether it exists.

**Operator action.** None for a fresh install. **Existing installs pick it up on
the next `install/update.sh`** (it re-runs `cloudflare.sh up`). To apply it
without a full update:

```bash
sudo bash /opt/operationkit-src/install/cloudflare.sh api-bypass --config /opt/operationkit-src/client.conf
sudo bash /opt/operationkit-src/install/verify.sh --config /opt/operationkit-src/client.conf
```

Why it is safe, how to add a route a bot needs, and the rollback:
[INSTALL.md → Letting bots reach the API with their key](INSTALL.md#letting-bots-reach-the-api-with-their-key).

### Sandbox: no-project cards start again; jail homes no longer leave secrets on disk (obj 900038)

Only affects installs running `SESSION_ISOLATION=docker` (the client-installer default).

**What changed.**

- **A card with no project starts again.** Such a card resolves its workdir to the operator home, which the
  installer creates mode `0750 root:root`. That path was bind-mounted at `/workspace`, the sandbox user could
  not enter it, and the session died at `cd` — card shows started, 0 tools, 0 tokens, dead in ~5s, then review.
  A card with no worktree now gets a **per-card scratch directory** (`/tmp/cc-jail-scratch/<objectiveId>`,
  `0700`, owned by the sandbox uid). The bare home, `/`, `/home`, `/root`, `/tmp`, `/opt` and `/srv` are
  never bind sources, and any workdir the sandbox uid cannot enter falls back to scratch instead of dying.
- **A session that dies before the agent starts now says so on the card.** The wrapper logs before it `cd`s,
  and on failure writes the exit code (78), the failing path and the `ls -ld`/`id` diagnostic to the log and a
  `startup_failure` event to the transcript. The card goes to review `blocked` with that text, plus an
  `activity_log` `error` row. It is **not** re-spawned — an environment fault repeats, so the old no-op
  retry loop just multiplied dead cards.
- **Session secrets no longer sit in a world-readable directory.** Per-session jail homes were `drwxrwxrwx`
  on the shared `/tmp` and kept `<session>.env` (the docker `--env-file`: every injected secret in plaintext)
  and the wrapper script after the session ended. Now: homes and files are `0700`/`0600` owned by the sandbox
  uid; the env file is deleted the moment `docker run` returns; every session end — including an early death,
  a crash and an operator stop — scrubs the credential files and removes the home (transcripts are preserved
  first); and a sweeper removes orphaned homes older than 2 hours.

**What to do.**

- Nothing on upgrade. Existing leftovers under `/tmp/cc-jail-homes/` are removed by the new sweeper within a
  couple of hours. To clear them immediately: `rm -rf /tmp/cc-jail-homes/*` while no session is running.
- Any secret that was present in a `/tmp/cc-jail-homes/*/.cc/*.env` on a shared host should be considered
  exposed to other local accounts and rotated (Settings → Secrets).
- New guide: [docs/runbooks/session-sandbox-workspace-and-secrets.md](docs/runbooks/session-sandbox-workspace-and-secrets.md)
  — what `/workspace` is bound to, how to read a startup failure, and how to check a host.

### Security: `/api/internal/*` could be reached from the internet with a forged `X-Forwarded-For` (obj 900027)

**Severity: high. Unauthenticated remote access to the internal API.**

**What was wrong.** The server set `trust proxy: true`, which tells Express to
derive `req.ip` from the client-supplied `X-Forwarded-For` chain. The
internal-route origin check (`lib/is-localhost.ts`) read `req.ip` first, so any
remote client could send `X-Forwarded-For: 127.0.0.1` and be treated as a
first-party on-box caller. Confirmed from outside the host:
`GET /api/internal/pr-health`, `GET /api/internal/objectives` and
`GET /api/internal/reviews/:id/criteria` all returned **200 with no
credentials**. On the OVH host these sit behind Cloudflare Access, which limited
exposure there; a host that publishes port 3002, or any Access misconfiguration,
was fully exposed. Reachable data included the whole objectives board (titles,
summaries, review findings) and PR-health state.

**What changed.**

- **The origin check is socket-based and ignores forwarded headers.**
  `isLocalhost()` now reads `req.socket.remoteAddress` (never `req.ip`) and
  additionally **refuses any request carrying a proxy-forwarding header**
  (`X-Forwarded-For`, `X-Forwarded-Proto`, `X-Real-IP`, `Forwarded`,
  `CF-Connecting-IP`, …). Caddy and cloudflared terminate on the host and dial
  `localhost:3002`, so proxied traffic also arrives on a loopback peer —
  header presence is what distinguishes it from a genuine on-box caller, and a
  remote client cannot strip a header the proxy adds downstream of it. A forged
  header can now only make a request *less* trusted, never more.
- **One gate in front of every internal router.** `middleware/internal-api-gate.ts`
  is mounted once at `/api/internal` ahead of all internal routers: a request
  must be a genuine local caller **or** present `X-Internal-Secret`
  (`INTERNAL_API_SECRET`) or the scoped `OBJECTIVES_API_TOKEN`. A new internal
  route can no longer ship ungated. Per-route `isLocalhost` checks remain behind
  it as defense in depth.
- **`trust proxy` is now an allowlist, not `true`** —
  `loopback, uniquelocal` (override with `CC_TRUST_PROXY`). `req.ip` is still
  correct behind Caddy/cloudflared, but it is no longer forgeable by a direct
  caller — which also hardens IP-keyed login rate limiting.
- **In-repo callers now send the secret**: the server's own loopback calls
  (`fanout-runtime`, `kitchen-loop`, `ci-feedback-bridge`, `dev-feedback-bridge`,
  `routine-scheduler`, `posthog-signals`, `daily-retro-gate`), plus
  `scripts/cc-live.mjs`, `scripts/run-gmail-triage.sh` and
  `scripts/security/weekly-security-review.sh`.

**What to do.** Nothing is required — local callers keep working unchanged.
Optionally set **`INTERNAL_API_REQUIRE_SECRET=1`** to drop the bare-localhost
allowance entirely, so `X-Internal-Secret` is required from *every* caller
including on-box ones. It is off by default because roughly 60 call sites in
prompts, docs and shell scripts still call `/api/internal` without a secret;
turn it on once those are migrated.


### Recommended stack guide, off-site backup setup, restore test, retention 7/4/6 (obj 84)

**What changed.**

- **New guide: [docs/RECOMMENDED-STACK.md](docs/RECOMMENDED-STACK.md)**: an end-to-end walk-through on the stack we run
  (OVHcloud Rise + Backblaze B2 + Cloudflare): a server sizing table with measured numbers, ordering, SSH keys,
  Cloudflare, the installer, B2 backups, seats, GitHub tokens and repositories, updates, and monthly checks.
  README and INSTALL now give the real repository URL, consistent minimum sizes (8 threads / 16 GB / 150 GB), and say
  plainly that Operation Kit updates are manual (the automatic updates are Ubuntu security patches only).
- **`install/b2-setup.sh` (new, optional).** Interactive Backblaze B2 setup: reads the application key hidden, checks it
  with Backblaze (bucket-limited, list/read/write/delete), writes `BACKUP_TARGET` to `client.conf` and the keys to
  `secrets/stack.env` (600), sends the first snapshot and runs the restore test. `install.sh` offers it at the end of
  an install run in a terminal while `BACKUP_TARGET` is empty (Enter skips; never asked without a terminal, or with
  `--no-backup-prompt`). It re-writes the same `/etc/cron.d/operationkit-backup` job: still one nightly backup.
- **`install/backup.sh verify` (new).** The restore test: restores the newest off-server snapshot (or the newest local
  backup) into a scratch folder, checks MANIFEST checksums, archives, `PRAGMA integrity_check` and row counts, prints
  `RESTORE TEST: PASS`/`FAIL` and exits 1 on FAIL.
- **Off-server retention is now a setting, and shorter by default:** `BACKUP_KEEP_DAILY` / `BACKUP_KEEP_WEEKLY` /
  `BACKUP_KEEP_MONTHLY`, default **7 / 4 / 6** (was a fixed 14 / 8 / 12).

**What to do.**

- **Existing installs with `BACKUP_TARGET` set:** after the next update, the nightly job keeps 7 / 4 / 6, so older
  snapshots beyond that are removed at the next Sunday prune. To keep the old retention, add
  `BACKUP_KEEP_DAILY="14"`, `BACKUP_KEEP_WEEKLY="8"`, `BACKUP_KEEP_MONTHLY="12"` to `client.conf` before updating.
- Run the restore test once: `sudo bash install/backup.sh verify --config client.conf`.
- If you set up off-site backups with your own systemd timer or cron job, switch to the built-in one
  (`install/b2-setup.sh`) and disable yours, so backups do not run twice. `b2-setup.sh` warns when it sees one.
- The installer now also installs `sqlite3` on the host (used by the restore test; `python3` is the fallback).

### Built-in agent chat — one chat per person per agent (obj 719987)

**What changed.** A new **Chat** tab (`/chat`): pick an agent (one file, `agents/<slug>/agent.yaml`) and talk to it in
one ongoing chat stored in this install's own database. Agents read/write only their `knowledge_folders`, prepare
email/calendar **drafts only** (a signed-in person presses Send), and hand bigger jobs to the board as cards whose
status shows back in the chat. Every reply records which provider + model answered. Two new MCP tools,
`list_chat_agents` / `get_chat_agent` (scope `vault:read`), expose the same agents to Claude, ChatGPT or Grok.

**What to know.** Providers are picked by name from the secret store: Claude (subscription / installer token),
`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `XAI_API_KEY`, or a custom OpenAI-style endpoint; with none, a scripted demo
answers. Admins switch on a fake-data demo assistant from the Chat page (or `AGENT_CHAT_DEMO=1`). On mobile, Jobs moved
into More so the bottom bar stays at five. Guides: `docs/product/09-agent-chat.md`, `docs/product/10-agents-from-other-ai.md`.

### Board-level Agents tab — the layer a project's sessions actually run on (obj 712044)

**What changed.** A new top-level **Agents** tab (`/agents`) renders the live
OperationKit layer — agent persona → workspace overlay → skills → tools — scoped
to one board project via `?project=<id>`. Server half: `GET /api/agents/board-layer`
and `GET /api/agents/layer-file` (both `requireAuth`, not localhost-only), built on
the existing `services/skill-graph.ts`. Client half reuses the SkillGraph
`GraphCanvas` for the Graph view and `MarkdownEditor` in `readOnly` mode to render
each file in place, so there is no second markdown renderer and no accidental
write surface.

**What an operator needs to know.**

- **Agent usage is derived from objectives, not configured.** `projects` has no
  agent column, so "which agents does project 16 use" is answered by counting
  `objectives.agent_context` in that project. The per-agent badge (`1 objective`,
  `146 objectives`) is that count. An agent that has never been given work in a
  project simply does not appear — that is correct, not a bug.
- **A declared-but-missing file is never silently dropped.** Any edge an agent or
  skill declares whose target has no file on disk still renders as a node, carries
  a red `file missing` chip, and is listed in the alarm banner at the top
  (`N declared files missing`). Clicking it opens a "File missing on disk" panel
  with the resolved path. The live sweep currently surfaces exactly one:
  `skills/supercut` declares `tools/supercut`, which does not exist.
- **The tab needs a single workspace.** The layer is per-workspace, so with the
  board selector on *all* the tab shows "Pick a single workspace" rather than a
  blank page (obj 712134).
- **Deploy note.** The client half is bundled, so merging alone does not make the
  tab appear — the tab requires a `self-deploy.sh both` (frontend rebuild + backend
  restart), since the server half adds routes too.
- **`layer-file` does not use a workspace's `doc_read_roots`.** `~/ai-workspace/tools`
  is in no workspace's document read roots, so routing the file reader through the
  docs route would 404 every tool node — and widening `doc_read_roots` to fix that
  would open the whole tools tree to the generic docs reader for an unrelated
  reason. Instead `GET /api/agents/layer-file` carries its own narrower allowlist
  (the three `~/ai-workspace` layer roots plus `workspaces/<ws>/agent-profiles`)
  with a post-resolve containment assert that also follows `realpath`, so a symlink
  cannot escape. Verified live: `kind=tool&slug=command-center` returns HTTP 200
  with `/home/operator/ai-workspace/tools/command-center/TOOL.md`. If you add a fourth
  layer tier, extend `LAYER_ROOTS` in `app/server/src/services/board-layer.ts` —
  the assert fails closed, so a forgotten root degrades to a 400, not a path escape.

### Agent roster is now data (obj 709939 + 709956)

**What changed.** The 17-persona roster used to be a closed TypeScript union
(`AgentContext`) duplicated across six tracked files. `AGENT_META`,
`AGENT_CONTEXTS`, `AGENT_MAP` and `WORKDIR_MAP` are **deleted**; `AgentContext`
is now `string`, and the roster lives in an `agents` table seeded from a
gitignored `app/server/seed.agents.json`. A fresh install ships five generic
executives — `cto`, `cmo`, `coo`, `cfo`, `general` — and nothing else. The
`objectives.agent_context` CHECK constraint is dropped.

**Operator action.**

- *Adding your own agents:* copy `app/server/seed.agents.example.json` to
  `app/server/seed.agents.json` (gitignored) and edit it before first boot, or
  use `POST /api/admin/agents-registry` on a running install. Full field
  reference and both flows: [`docs/MIGRATION.md`](docs/MIGRATION.md).
- *Existing databases are untouched.* The seed is `INSERT OR IGNORE`; no row is
  updated or deleted. A pre-existing out-of-band `agents` table is renamed to
  `agents_legacy_okit` with its rows preserved.
- *If you use the mentor/assistant surface:* it no longer hardcodes an
  `assistant` slug or an `<ai-workspace>/agents/assistant.md` path. Set
  `ASSISTANT_AGENT_SLUG` to a slug in your registry to keep the persona-backed
  behaviour on a fresh DB. Leaving it unset is fully supported — the assistant
  degrades to generic wording rather than crashing.

**Integrations.** `agent_context` is a free-form string in the OpenAPI schema.
Read the live roster from `GET /api/agents` instead of hardcoding slugs.

### OSS publish gate hardened (obj 709956)

`scripts/oss-sync-gate.sh` gained two checks that close the hole through which
the roster shipped in the first place:

- **check 0 — pre-genericize denylist.** The denylist now also runs against the
  assembled tree *before* `scripts/oss-genericize.sh` rewrites it. The old
  single post-genericize pass could only prove "no raw business string
  survived", never "no business entity was here"; a renamed persona slug
  would pass the post-genericize check green because the genericizer rewrote
  its business-identity prefix. CI sets `PREGEN_DIR`; the gate warns loudly
  when it is unset.
- **check 4 — roster conformance.** Every agent slug the published tree would
  seed must appear in `scripts/oss-agent-allowlist.txt`. Fails closed on
  anything else.
- **check 3** additionally asserts `seed.agents.json` is absent from the
  published tree while `seed.agents.example.json` is present.

`scripts/oss-gate-roster-test.sh` proves all three against a throwaway fixture
(clean → PASS, injected private slug → FAIL).

The `app/telegram-contactbook/` sibling process is now stripped from the public cut
— see [`docs/oss/RELEASE-MANIFEST.md`](docs/oss/RELEASE-MANIFEST.md).
