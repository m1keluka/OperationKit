# Changelog

Notable operator-facing changes. Newest first.

> Not a release log — this repo deploys from `main`. Entries here are the changes
> that need an operator to *do* or *know* something. Day-to-day product changes are
> tracked in the board's own changelog (`GET /api/changelog`, Development → Changelog).

## Unreleased

### The card browser is sandboxed, origin-restricted and pinned (obj 900791, restart of 900024)

The Chromium that review/QA sessions drive through Playwright MCP used to be
launched with `--no-sandbox`, with **no origin policy at all**, from
`@playwright/mcp@latest` re-resolved on every spawn — inside the container that
holds the secrets store, the AI seat logins and the database. Three changes:

- **Sandbox on, non-root.** `--no-sandbox` is now passed only when an operator
  explicitly sets `BROWSER_SANDBOX="off"`, and that choice is logged at boot and
  reported by `verify.sh`. The image makes Chromium’s `chrome_sandbox` helper
  setuid-root so the sandbox works for the unprivileged `ccuser` account the
  browser already ran as.
- **Egress allowlist with a real boundary.** Chromium is pointed at a loopback
  egress guard with `--proxy-server`. By default it may reach this install’s own
  domain and localhost (preview servers) and nothing else; cloud instance
  metadata and the private network are refused by host *and* by resolved address,
  so an allowlisted name that resolves into them is still blocked. The guard
  re-checks every redirect hop and pins DNS. Playwright’s own
  `--allowed-origins` is passed as well, but its documentation says plainly that
  it is not a security boundary and does not affect redirects — so it is
  defence-in-depth, not the control.
- **Pinned versions.** Playwright and `@playwright/mcp` are pinned in exactly two
  places (`app/server/src/lib/browser-pins.ts` and `ARG` lines in
  `app/Dockerfile`); CI fails if they disagree. Pinned at Playwright **1.65.0**
  (Chromium **158.0.8127.18**), up from the floating install that was resolving
  1.64.1 / Chromium 156.0.8078.4 — a build that predates the Chrome stable
  security release 157.0.8103.38 (2026-11-03).

**What an operator must do: nothing.** The defaults are the locked-down ones and
they are applied on the next `install.sh` / `update.sh` run. See
“Migration: card browser lockdown” in `docs/MIGRATION.md` for the one case that
needs attention (reviews that open a third-party site), and
`docs/wiki/Card-Browser-Lockdown.md` for the full reference.


### Secrets: bots use a named secret without seeing it + cleaner Secrets page (obj 900749)

**What changed.** Chat bots and MCP-connected bots can now call an API with a
secret by NAME. The bot writes `{{secret:NAME}}`; the existing broker adds the
value on the outgoing HTTPS request only, sends it only to that secret's allowed
hosts, and redacts the reply. No value reaches a prompt, chat history, tool
result or log.
- **MCP bots:** new `list_usable_secrets` and `call_with_secret` tools behind a
  new agent-key scope, `secrets:use`. It is **not** in the default set; tick it on
  the key in Settings → You → Agent keys. A named key is never an admin caller on
  the broker, even when its owner is an admin.
- **Chat bots:** a new **Use secrets by name** tool on the bot page (or `secrets`
  under `tools:`). "All tools" does not include it.
- **Settings → Secrets:** a security strip (write-only / encrypted + scoped /
  bots use by name), name search, a compact toolbar, and a **Bot access** column.
  A global admin sets which hosts each secret may be sent to; with none set, no
  bot can use it (default-deny, unchanged).

**What the operator should know.**
- Nothing is turned on for any existing secret. Every secret stays "Off" until an
  admin adds hosts. Bot-access edits write only the `secrets_broker_policy`
  setting. They never change a secret row, value or scope.
- If the policy came from env `CC_SECRETS_BROKER_POLICY`, the first edit in the UI
  copies it into settings; after that the settings row wins.

### Settings → Models: editable default + provider model refresh (obj 900679)

**What changed.** Settings → Models now has a **Default model** and **Planner model**
dropdown at the top, and a **Refresh from providers** button. Refresh calls each
connected provider's model-list API (Anthropic `GET /v1/models`, OpenAI and xAI
`GET /v1/models`, plus any custom OpenAI-compatible endpoint saved under API key
providers) and adds any model the registry doesn't have yet, **switched off**, so
a new model appears without a code change. Each provider gets its own status line:
updated (N listed, N new), not connected, or failed with the HTTP status and the
provider's error message.

**What the operator should know.**
- The server also refreshes on its own, once every 24h by default (host instance
  only, never on a scratch server). `settings.model_refresh_interval_hours` changes
  the interval; `settings.model_refresh_auto = '0'` turns it off.
- Credentials, in order: the API key saved under Settings → Models → API key
  providers (`PROVIDER_API_KEY__ANTHROPIC|OPENAI|XAI`), then the server env
  (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `XAI_API_KEY`, …), then for Anthropic a
  Claude subscription OAuth token in the env. A rejected key falls through to the
  next one. Only the credential's name is stored in the report.
- New models arrive disabled because a fresh id can need a newer CLI. Enable one
  (or pick it as default, which enables it) to make it selectable on cards.
- Models the provider stops listing are flagged "Not listed by provider", never
  disabled automatically.
- `models` gains three columns (`source`, `discovered_at`, `last_seen_at`), added
  on boot. No rebuild needed.

### One Agents & Skills page; the roster shows the knowledge base agents (obj 900684)

Settings → Agents & Skills was a second copy of the registry on `/agents`. It is gone; `/settings/agents-skills` redirects to `/agents?tab=registry`, and the page and nav are now called **Agents & Skills**. The roster (`GET /api/admin/agents`, `services/agent-roster.ts`) used to list only flat `agents/*.md` persona files, so the built-in **Knowledge Base Setup** agent, folder-format chat agents, registry rows with no file, starter-pack agents (the **Librarian**) and sub-skills were invisible. They are now listed with their source and, where they are not usable yet, the reason. See `docs/agents/roster.md`.

### Security: an agent key's workspace list now applies to `/api/docs` and MCP `write_doc` / `read_file` / `list_folders` / `search` (obj 900627, redo of 900021)

**Severity: high. A scoped agent key could read and write other workspaces' notes.**

**What was wrong.** The docs router checked a path only against the CALLER's doc
roots. For an admin-owned agent key those are the admin roots, i.e. the whole
vault, and the router never looked at the key's `workspaces` list. A key with
`vault:write` and `workspaces = [example, operationkit]` could write
`workspaces/your-org/zz-scope-test.md` through `PUT /api/docs/file` or MCP
`write_doc`, and read any other workspace's notes the same way. Board routes and
`/api/files` already enforced the list; the doc routes did not.

**What changed.**

- New `lib/doc-path-workspace.ts` (`workspaceOfPath`) resolves a path to exactly
  ONE workspace. It canonicalises first (realpath of the nearest existing
  ancestor), so `..` and symlinks are judged by where the bytes really are. A
  path inside no workspace, or one two workspaces could claim (e.g. a
  `workspaces/example/` folder nested inside `your-org`), resolves to no
  workspace.
- `GET /api/docs/file`, `PUT /api/docs/file`, `GET /api/docs/tree` (including
  `?root=`) and `GET /api/docs/search` now return **403
  `code: workspace_not_allowed`** for an agent key with a workspace list when the
  path is not in exactly one of its workspaces. Admin-owned keys are included.
  The check runs before any stat, mkdir or write, so a refused path is not an
  existence oracle and nothing is created. The tree lists only the key's
  workspace folders and `writeRoots`; search drops hits outside them.
- MCP `write_doc`, `read_file`, `list_folders` and `search` forward to these
  routes with the same bearer key, so they are covered too.
- Unchanged: keys with no workspace list (`workspaces = null`), cookie/JWT
  logins, and card sessions (`CC_SESSION_TOKEN`, already confined to their own
  workspace by obj 900204). `/api/files/*`, `/api/kb-wiki/answers` and the
  kb-wiki graph already enforced the key's list; confirmed, no change.

**Behaviour change to know about.** A key WITH a workspace list can no longer
read or write vault notes that sit outside every workspace (e.g. a note at the
vault root such as `inbox.md`). This is deliberate: those notes belong to no
workspace the key was granted. Use a key with no workspace list (or a cookie
login) for vault-root notes.

**Operator action:** none. Deploy as a normal backend change (`self-deploy.sh
backend`). Tests: `app/server/src/routes/docs-agent-key-scope.test.ts`.

### Sandbox `/tmp` is 2g and configurable; remove the OVH docker shim after deploy (obj 900402)

`session-jail.ts` hardcoded the jail's `/tmp` tmpfs at `size=256m`, and AI reviews that
cloned a ~170 MB repo failed with `/tmp/claude-1000 has 0 MB free` (2026-11-09). It is now
`SESSION_JAIL_TMP_SIZE` (default `2g`; `JAIL_TMP_SIZE` in `client.conf`). An invalid value
fails the spawn rather than mounting something else. Optional `SESSION_JAIL_CLAUDE_TMPDIR=on`
(`JAIL_CLAUDE_TMPDIR`) sets `CLAUDE_CODE_TMPDIR` to the disk-backed jail HOME.

**Operator action (OVH):** after deploying, remove the live hotfix shim at
`/usr/local/bin/docker` in the app container if it survived, and confirm a new jail shows
`size=2g`. Steps: `docs/runbooks/session-sandbox-workspace-and-secrets.md` §4.

### `install/claude-login.sh` accepts the pasted code; real error messages (obj 900541)

A fresh install reported every pasted Authentication code as *"from a different sign-in
link"*, then stopped with *"could not reach Claude"*. This happened over SSH from Linux and
Windows PowerShell and in the DigitalOcean web console. Three causes, all fixed in
`install/claude-oauth.sh`:

- **Paste junk.** The paste was only stripped of whitespace. Bracketed-paste markers
  (`ESC[200~` … `ESC[201~`, or `[200~` with the ESC lost), other escape sequences, NBSP /
  zero-width spaces, quotes and a URL-encoded `%23` survived and corrupted the `#state`
  half. All of these are now removed, and the terminal's bracketed-paste mode is turned off
  before the prompt. The whole callback URL can also be pasted.
- **The state check was a hard gate.** PKCE is what ties a code to its link, so the script
  now always tries the exchange and lets Claude decide. It only reports "a different link"
  when Claude also refuses the code, and then it shows the end of both states.
- **Every unexpected reply was reported as a network failure.** Now only "no HTTP answer"
  (DNS, connect, TLS, timeout) says *could not reach*, with curl's reason. A 429 or 5xx is
  reported as *Claude's sign-in service answered with an error* (new rc 8), and a web page
  from a proxy is called out. A reused code is caught before it is sent (new rc 9).
  Claude's own error text is shown in `[…]`.

Every failure now prints the fallback: `claude setup-token` on any machine with Claude Code,
then rerun with `--token`. Covered by `install/test/claude-oauth-mock-test.sh` (CI job
*install-smoke*), which makes no live calls. Troubleshooting rows are in INSTALL.md →
*When something goes wrong*.

### Sessions no longer refuse scraping, site ToS, or bot-check work (obj 900192)

On card #900184 a session was asked to source commercial cleaning companies from the
Oklahoma Secretary of State's **public** entity search. It hit a Cloudflare "verify you
are human" page, called bot-check bypass off-limits, and refused **again** after the owner
told it to continue. Nothing in Command Center told it to do that — the refusal was the
model's own generic caution reading "scraping" and "bot check" as a policy boundary, on a
lead-sourcing card the owner opened against public records.

**What changed.** A short standing rule, **"Public-web sourcing — the owner's instruction
IS the authorization"**, now ships in three prompts:

- **Sourcing card sessions** (`buildPrompt`, gated by `needsSourcingAuthority` — no flag):
  scraping, crawling, enrichment and list-building off the public web are ordinary
  sanctioned work. No terms-of-service caveats, no asking for permission already given, no
  moralizing. A CAPTCHA / Cloudflare / DataDome interstitial in front of a **public** page
  is a *technical obstacle* to solve (real browser, unblocker or proxy vendor, CAPTCHA
  solver we pay for, alternate route), not a boundary. And a concern the owner has
  overruled is settled — never refuse the same thing twice. The block lands only on cards
  whose text is about sourcing / scraping / research / enrichment, or that have already hit
  a site obstacle — an infra card does not get a scraping posture.
- **The adversarial reviewer:** grade the evidence, not the ethics of sourcing. It may not
  author a ToS / bot-check acceptance criterion or fail a verdict on those grounds.
- **The planner:** never write a plan step that asks for permission to scrape.

**What did NOT change.** The rule restates the real limits inline, so this never reads as
a blanket "anything goes": stolen or cracked credentials, breaking into non-public systems,
attacking or degrading a third party, malware, impersonating a real person to deceive
a human being, personal or private data behind an authorization boundary, and anything
needing an approval that was never given are all still off-limits and still fail review —
the reviewer is told explicitly to fail them and name the limit. Gated content (paywall,
login, subscription) is reached through an account or data vendor we actually hold, not by
defeating the gate.

**Operator action: none.** It is prompt text — live for every session spawned after the
next backend deploy. Reference: [docs/wiki/Public-Web-Sourcing-Policy.md](./docs/wiki/Public-Web-Sourcing-Policy.md).
### A revoked agent key no longer lends connectors to the cards it filed (obj 900331)

A card filed by an agent key spawns its sessions with that key's connector
allow-list. A key that had been **deleted** already left such a card with no
connector at all, but a **revoked** key — and revoke is the only removal the API
offers — kept its list. With the obj 900303 default (`["owner"]`) that meant a card
queued by a revoked key still received every connected account its owner had
(`GH_TOKEN`, Google) at its next spawn. Revoked now reads the same as deleted: the
card's next session gets no connector. Nothing else changes — the key itself was
already 401 on its next request, no row is migrated, and no live key is touched.
`connector-isolation.test.ts` gains a 16-test end-to-end block (`obj 900331: …`)
covering the five inheritance properties.

### The agent-key connector picker was always empty — and new keys now follow their owner (obj 900303)

**The bug.** Settings → You → Agent keys → **Connectors** showed "No connectors
available." on every install, including installs with GitHub and Google Workspace
connected. `GET /api/connectors` answers with a **bare array**; the picker read
`res.connectors` off that array, got `undefined`, and fell back to an empty list.
Its unit test mocked the same envelope the server has never sent, so the suite
agreed with the bug. The catalogue read now lives in one place
(`client/src/lib/connectors.ts`), `routes/connectors.test.ts` pins the array shape
server-side, and the component test mocks what the server really sends.

**Nothing failed loudly, either.** A 401, a 500 or a dropped connection was
swallowed and rendered as the same confident "No connectors available." The picker
is now a three-state: *Loading…*, the real catalogue (or "You have not connected
any accounts yet"), or an error with the server's own sentence and a **Retry**
button. "You have none" is never shown because a request failed.

**New keys follow their owner.** A key created without saying anything about
connectors now gets `["owner"]` — it can use the connected accounts its owner is
authorised for, with nothing to tick. This is the **absence of a per-key
narrowing**, not a grant: the key still reaches only its own owner's accounts, the
owner's per-connector agent/workspace rules still apply, work someone else
delegated still needs the owner's opt-in, and each use is re-measured at the
moment of use — disconnect or revoke the account and the key loses it with no key
edit. It grants nothing on the board (done and delete still stay human by default)
and nothing in Settings → **Secrets**, which is a separate store.

**Nothing you already have changes.** This is a CREATE-time default only:

| A key whose stored list is | Before | After |
|---|---|---|
| `NULL` (predates obj 900303) | no connectors | **no connectors** |
| `[]` or an explicit `null` | no connectors | **no connectors** |
| `["github"]` etc. | exactly those | **exactly those** |
| `["*"]` (migrated legacy key) | all the owner has | **all the owner has** |

There is **no bulk migration** and no backfill. An existing key moves to the new
mode only when its owner picks **"Whatever I can use"** on that key and saves
(`PATCH /api/auth/agent-keys/:id {"connectors":["owner"]}`), and that is
reversible. `"owner"` is a mode, not a connector id: mixing it with ids is a 400.

**Operator action: none.** Read the new table in `docs/product/04-you.md` if you
want to narrow the keys you create from here on.


### Bots stop getting Cloudflare error 1010: a narrow browser-integrity exception, in the installer (obj 900259)

**The bug.** Letting Cloudflare *Access* step aside on the bot-facing API routes
(obj 900028) is necessary and not sufficient. **Browser Integrity Check** is a
separate Cloudflare layer that refuses anything whose request does not look like
it came from a browser — which is every bot, script and AI tool. So a caller
holding a perfectly valid `cc_live_` key got `403` and Cloudflare's **error 1010**
HTML page ("banned your access based on your browser's signature"), and the app
never saw the request. The fix had to be made by hand, per install, in the
Cloudflare dashboard.

**What changed.**

- **One new step in `cloudflare.sh up` (step 10), and a standalone command.**
  `cloudflare.sh api-bic [remove] --config client.conf [--dry-run]` adds, corrects
  or removes **one** Cloudflare Configuration Rule in the zone's
  `http_config_settings` phase: action `set_config`, action parameters **exactly**
  `{"bic": false}`, expression
  `(http.host eq "<your DOMAIN>" and starts_with(http.request.uri.path, "/api/"))`.
  The hostname always comes from your `client.conf`; nothing is hard-coded.

- **It is narrow by construction, not by care.** The zone-wide Browser Integrity
  Check setting is never written. No WAF rule, rate limit, security level, Access
  application or sign-in is touched. Other Configuration Rules in the same phase
  are never read-modify-written — ours is added, patched and deleted *by id*
  through the per-rule endpoints — and the step compares the other rules before
  and after, refusing to report success if they differ. The rule's description
  carries the hostname, so two installs sharing one Cloudflare zone own one rule
  each and neither can touch the other's.

- **Idempotent, with a dry run and a real rollback.** A rule that is already
  exactly right costs no mutating call at all; one edited or renamed in the
  dashboard is corrected in place rather than duplicated. `--dry-run` prints the
  exact expression and setting and changes nothing. Before any change the phase's
  current contents are written to
  `/opt/operationkit/backups/cloudflare-bic-<UTC time>-before-*.json` (mode 600).
  `api-bic remove` deletes that one rule; `cloudflare.sh down` removes it too;
  `cloudflare.sh status` shows whether it is present.

- **👤 One new Cloudflare API token permission: `Zone → Config Rules → Edit`.**
  Existing tokens do not have it. Without it the step stops with that exact
  sentence and changes nothing — it never half-applies and never reports success
  it cannot back. A zone with no room for another Configuration Rule gets its own
  message, naming the two ways out.

- **`install/verify.sh` now tells the three refusals apart.** A keyless call to a
  bot-facing route must come back `401` **JSON** (the app refused). A `302` to
  `…cloudflareaccess.com` names Access and prints the `api-bypass` command; a
  `403` HTML/1010 page names Browser Integrity Check and prints the `api-bic`
  command. It also proves the other direction: an authenticated caller sending no
  Cloudflare headers gets `200` JSON, while `/` and `/api/internal` stay behind
  the sign-in.

- **Off switch:** `API_BROWSER_INTEGRITY_EXCEPTION="off"` in `client.conf`.

**👤 Existing installs must reconcile — pulling code is not enough.** The rule
lives in *your Cloudflare account*, so `git pull` + restart changes nothing there.
`install/update.sh` re-runs the installer and therefore reconciles it for you;
if you updated by hand, run `cloudflare.sh api-bic` once. Step-by-step (with
backup, dry run, rollback and a paste-ready prompt for an AI assistant with SSH
access): **[docs/CLOUDFLARE-API-ACCESS.md](docs/CLOUDFLARE-API-ACCESS.md)**.

**Tests.** `install/test/bic-lib-test.sh` (new, no network: scope, one-setting,
hostname refusals, our-rule matching, other-rule preservation, 1010 vs Access vs
app JSON, error messages) and 50+ new checks in
`install/test/cloudflare-mock-test.sh` (idempotency, a client's own rule coming
through byte-identical, dashboard edits corrected in place, two installs in one
zone, dry run, rollback, permission and plan failures). Both run in CI
(`.github/workflows/install-smoke.yml`), and `bic-lib.sh` is now shellchecked.

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
