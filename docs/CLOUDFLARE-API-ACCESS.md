# Cloudflare and your API: the three ways a call gets refused

Your bots, your AI tools and your own scripts call this install over the public
internet, with an Operation Kit API key (`cc_live_…`). Three different things
sit between them and an answer, and all three answer with a `4xx`. Reading the
refusal correctly is most of the work, because each one has a different fix.

> Everything on this page is about **your own** domain, your own Cloudflare zone
> and your own API token. No hostname, zone id, account id or token belonging to
> anyone else appears here or in the tooling: every value comes from the `DOMAIN`
> and `ZONE` you wrote in `client.conf`.

## Telling the three apart

| What you get back | Who refused you | Fix |
|---|---|---|
| `302` to `https://<team>.cloudflareaccess.com/…`, or an HTML sign-in page | **Cloudflare Access** — it wants a human to sign in, and never looks at your key | `cloudflare.sh api-bypass` |
| `403` + HTML containing **error 1010** / "banned your access based on your browser's signature" | **Cloudflare Browser Integrity Check** — your caller is a script, not a browser | `cloudflare.sh api-bic` |
| `401` + **JSON** | **Operation Kit** — no key, a wrong key, or an expired one | issue a key in *Settings → You* and send it as `Authorization: Bearer cc_live_…` |
| `403` + **JSON** | **Operation Kit** — the key is valid but is not scoped to that workspace or that ability | widen the key's scopes in *Settings → You* |

**The rule of thumb: Operation Kit always answers JSON. Cloudflare never does.**
If the body is JSON, the request reached the app and the app made the decision.

One command that shows you which one you are looking at:

```bash
curl -si "https://<DOMAIN>/api/objectives" | head -20
```

## What the installer puts in place, and how narrow it is

Two separate objects, for the two separate Cloudflare layers.

### 1. Access steps aside on the bot-facing routes

A second Access application, **"Operation Kit API (key auth)"**, with a single
*Bypass / Everyone* policy, covering only the routes listed in
[`install/api-bypass-paths.conf`](../install/api-bypass-paths.conf). The
operator surface (`/api/internal`, `/api/admin`, `/api/secrets`,
`/api/secret-upload`, `/api/webhooks`, `/api/public`, `/api/llm`, `/api/alerts`,
`/api/costs`, `/api/intel`, `/api/status`, and all of `/api/auth` except the
exact `/api/auth/me`) can never be added — the installer refuses the whole step
rather than opening one. Full detail: [INSTALL.md → Letting bots reach the API
with their key](../INSTALL.md#letting-bots-reach-the-api-with-their-key).

### 2. Browser Integrity Check stops refusing your own API

**One** Cloudflare *Configuration Rule*, in your zone's `http_config_settings`
phase:

| | |
|---|---|
| action | `set_config` |
| action parameters | `{"bic": false}` — **one key, nothing else** |
| expression | `(http.host eq "<your DOMAIN>" and starts_with(http.request.uri.path, "/api/"))` |
| description | `Operation Kit: API key auth for <your DOMAIN>/api/ (no browser integrity check)` |

What is **not** touched, by construction:

- your **zone-wide Browser Integrity Check** setting (the rule is an exception
  on one hostname's `/api/` paths; the switch itself is never written);
- any **WAF rule, rate limit or security level** — the rule sets `bic` and
  nothing else, and `install/test/bic-lib-test.sh` asserts the action parameters
  are exactly `["bic"]`;
- **other Configuration Rules** in the same phase — the rule is added, patched
  and deleted through the per-rule endpoints *by id*, so the rest of your list
  is never read-modify-written. The installer compares the other rules before
  and after and refuses to report success if they differ;
- **Access**, the sign-in, the tunnel, DNS and your UI — a browser going to
  `https://<DOMAIN>/` is unaffected and still signs in;
- **any other hostname in the zone.** The expression names one host. Two
  Operation Kit installs sharing a zone get one rule each, and neither can find,
  correct or delete the other's — the description carries the hostname too.

The hostname is read from `DOMAIN` in your `client.conf`. Nothing is hard-coded.

## Setting it up

Pick the path that matches you.

### A fresh install

Nothing to do. `install.sh` runs `cloudflare.sh up`, which does both steps.
Confirm with `install/verify.sh`.

### An existing install — **this is not automatic**

**Pulling new code changes nothing in your Cloudflare account.** `git pull`,
`git checkout` and a container restart only move code; the Access application
and the Configuration Rule live in Cloudflare and are only written when a
Cloudflare step actually runs. An install made before this shipped therefore
keeps getting error 1010 until you reconcile it. See
[Reconciling an existing install](#reconciling-an-existing-install).

### Local-only installs (`--skip-cloudflare`)

Not applicable: there is no Cloudflare in front of the app at all.

## What you need, and nothing more

- **Your own domain and zone**, already on Cloudflare, with `DOMAIN` and `ZONE`
  set in `client.conf` (`DOMAIN` must sit under `ZONE`).
- **Your own Cloudflare API token**, in
  `/opt/operationkit/secrets/cloudflare-api-token` (one line, mode 600). It is
  sent in a header file, never on a command line, and never printed. The token
  needs **only** these, scoped to your zone and your account:

  | Type | Permission | Access | Needed for |
  |---|---|---|---|
  | Zone | Zone | Read | find the zone and its account id |
  | Zone | DNS | Edit | the proxied CNAME to the tunnel |
  | Zone | **Config Rules** | **Edit** | **the browser-integrity exception** |
  | Account | Cloudflare Tunnel | Edit | the tunnel |
  | Account | Access: Apps and Policies | Edit | the sign-in app and the key-auth app |
  | Account | Access: Organizations, Identity Providers, and Groups | Edit | the login method |
  | Account | Access: Service Tokens | Edit | the verify robot and agent passes |

  Nothing here needs a Global API Key, an account-wide token, or any permission
  on a zone that is not yours. If the token is missing **Config Rules → Edit**,
  the browser-integrity step stops with that exact sentence and changes nothing.

## Reconciling an existing install

Four steps, in order. They are all idempotent, so running them on an install
that is already correct changes nothing.

```bash
# 0. Back up first (database, seat logins, secrets, client.conf).
sudo bash /opt/operationkit-src/install/backup.sh run \
  --label pre-cloudflare-reconcile --config /opt/operationkit-src/client.conf

# 1. Move the code to the version that has the fix.
sudo bash /opt/operationkit-src/install/update.sh \
  --config /opt/operationkit-src/client.conf
#    update.sh re-runs install.sh, which re-runs the Cloudflare steps for you.

# 2. If you only pulled code by hand, or you skipped Cloudflare, run the two
#    Cloudflare steps on their own. --dry-run first; it changes nothing.
sudo bash /opt/operationkit-src/install/cloudflare.sh api-bic \
  --config /opt/operationkit-src/client.conf --dry-run
sudo bash /opt/operationkit-src/install/cloudflare.sh api-bic \
  --config /opt/operationkit-src/client.conf
sudo bash /opt/operationkit-src/install/cloudflare.sh api-bypass \
  --config /opt/operationkit-src/client.conf

# 3. Prove it.
sudo bash /opt/operationkit-src/install/cloudflare.sh status \
  --config /opt/operationkit-src/client.conf
sudo bash /opt/operationkit-src/install/verify.sh \
  --config /opt/operationkit-src/client.conf
```

`status` prints `browser-integrity exception   present (<DOMAIN>/api/* only, bic:false)`
when it is in place, and `MISSING` with the command to run when it is not.

### Rolling back

```bash
# Remove just the browser-integrity exception (one rule, by id).
sudo bash /opt/operationkit-src/install/cloudflare.sh api-bic remove \
  --config /opt/operationkit-src/client.conf

# Put every API route back behind the Cloudflare sign-in as well.
sudo bash /opt/operationkit-src/install/cloudflare.sh api-bypass remove \
  --config /opt/operationkit-src/client.conf
```

Neither touches the tunnel, DNS, your other Cloudflare rules or the app. Before
either change, the current contents of the Configuration-Rules phase are written
to `/opt/operationkit/backups/cloudflare-bic-<UTC time>-before-*.json` (mode
600) so a hand rollback in the dashboard is always possible. To stop the
installer adding the rule at all, set `API_BROWSER_INTEGRITY_EXCEPTION="off"` in
`client.conf`.

To go back to the previous *code*, `update.sh` prints the exact checkout, image
and database-restore commands at the end of every run.

## Verifying it, by hand

Three calls, three expected answers. Run them from a machine that is **not**
signed in — a server, not your browser.

```bash
D=<your DOMAIN>
K=cc_live_…            # a key from Settings → You, scoped to one workspace

# 1. An authenticated, permitted call gets a real answer.
curl -si -H "Authorization: Bearer $K" "https://$D/api/objectives" | head -1
#    want: HTTP/2 200   with a JSON body

# 2. No key (or a wrong one) is refused BY THE APP, in JSON.
curl -si "https://$D/api/objectives" | head -1
#    want: HTTP/2 401   with a JSON body
#    403 + HTML  -> Browser Integrity Check: run cloudflare.sh api-bic
#    302 to …cloudflareaccess.com -> Access: run cloudflare.sh api-bypass

# 3. The UI, and the operator API, are still protected by Cloudflare.
curl -si "https://$D/" | head -1
curl -si "https://$D/api/internal/objectives" | head -1
#    want: both 302 to …cloudflareaccess.com (or 401/403 with an HTML body)
```

`install/verify.sh` runs all of these for you and names which layer refused.

## A prompt you can paste into an AI agent

If you run your install through an AI assistant with SSH access (Claude Code,
Codex, Grok…), paste this. It does the backup, the update, the reconcile and the
proof, and it stops rather than guessing.

> **Note on versions.** This repo deploys from `main`; there are no release
> numbers. "The version with the fix" means a checkout of `main` that contains
> `install/bic-lib.sh` and a `cloudflare.sh` that accepts `api-bic` — the prompt
> below checks for exactly that, so it works whatever commit you land on. To pin
> a specific commit instead, pass `--ref <sha>` to `update.sh`.

```text
You have SSH access to the server running my Operation Kit install. The code is
at /opt/operationkit-src and the install at /opt/operationkit, with the config
at /opt/operationkit-src/client.conf. Do not print or paste any secret value.

Goal: my bots get Cloudflare error 1010 (or a Cloudflare sign-in page) when they
call my API with their Operation Kit key. Reconcile the install so they reach
the app and the key is what decides.

1. BACK UP FIRST.
   sudo bash /opt/operationkit-src/install/backup.sh run \
     --label pre-cloudflare-reconcile --config /opt/operationkit-src/client.conf
   Report where the backup landed. If it fails, STOP and tell me.

2. CONFIRM THE CODE HAS THE FIX.
   ls /opt/operationkit-src/install/bic-lib.sh
   If it is missing, update the code:
   sudo bash /opt/operationkit-src/install/update.sh \
     --config /opt/operationkit-src/client.conf
   (update.sh re-runs the installer, which reconciles Cloudflare too.)
   Note: pulling code alone changes NOTHING in Cloudflare — the rule is only
   written when a Cloudflare step actually runs. Do not report success from a
   git pull.

3. SHOW ME THE PLAN BEFORE CHANGING ANYTHING.
   sudo bash /opt/operationkit-src/install/cloudflare.sh api-bic \
     --config /opt/operationkit-src/client.conf --dry-run
   Paste the output. It must name exactly one rule, with action_parameters
   {"bic": false} and an expression naming MY hostname and /api/ only. If it
   names anything else, STOP.

4. APPLY IT.
   sudo bash /opt/operationkit-src/install/cloudflare.sh api-bic \
     --config /opt/operationkit-src/client.conf
   sudo bash /opt/operationkit-src/install/cloudflare.sh api-bypass \
     --config /opt/operationkit-src/client.conf
   If either stops because my Cloudflare API token lacks a permission, tell me
   the exact permission to add and STOP — do not work around it.

5. PROVE IT, with pasted output, not a summary.
   sudo bash /opt/operationkit-src/install/cloudflare.sh status \
     --config /opt/operationkit-src/client.conf
   sudo bash /opt/operationkit-src/install/verify.sh \
     --config /opt/operationkit-src/client.conf
   Then, with D set to my domain and K to a key I give you:
     curl -si -H "Authorization: Bearer $K" "https://$D/api/objectives" | head -1   # expect 200 JSON
     curl -si "https://$D/api/objectives" | head -1                                 # expect 401 JSON
     curl -si "https://$D/" | head -1                                               # expect 302 to cloudflareaccess.com
   A 403 with an HTML body on the second call means the rule is not live yet.

6. IF IT NEEDS UNDOING:
   sudo bash /opt/operationkit-src/install/cloudflare.sh api-bic remove \
     --config /opt/operationkit-src/client.conf
   That deletes one rule by id and leaves every other Cloudflare rule alone.

Report: what you backed up, what you changed, the three curl status lines, and
anything you did NOT do. Do not claim success for a step you did not run.
```

## Where this lives in the code

| | |
|---|---|
| the pure logic (scope, matching, 1010 detection, error messages) | [`install/bic-lib.sh`](../install/bic-lib.sh) |
| the Cloudflare calls, snapshot and verification | `api_bic_up` / `api_bic_down` in [`install/cloudflare.sh`](../install/cloudflare.sh) |
| the switch | `API_BROWSER_INTEGRITY_EXCEPTION` in [`install/client.conf.example`](../install/client.conf.example) |
| unit tests (no network) | [`install/test/bic-lib-test.sh`](../install/test/bic-lib-test.sh) |
| end-to-end against a mock Cloudflare | [`install/test/cloudflare-mock-test.sh`](../install/test/cloudflare-mock-test.sh) |
| the Access half | [`install/api-bypass-lib.sh`](../install/api-bypass-lib.sh), [`install/api-bypass-paths.conf`](../install/api-bypass-paths.conf) |
