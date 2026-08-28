# Per-user Google Workspace connections (obj-706070)

Command Center's Google access used to be **one shared credential** — Mike's stored
OAuth grant, reused by every session regardless of who the work was for (vault:
`2026-06-12-hermes-google-suite-shared-credential`). A session drafting a Doc for Ava
wrote it as Mike, attribution was unanswerable, and revoking one person's access
revoked everyone's.

This replaces that with **one OAuth grant per Command Center user**, stored encrypted
and injected into a spawn as the *acting user's* credential.

---

## 1. Architecture: why a dedicated table, not the generic secrets store

The connection lives in its own table, `user_google_connections`
(`app/server/src/db/index.ts`), one row per user:

| column | purpose |
|---|---|
| `user_id` (PK, FK→users, ON DELETE CASCADE) | one connection per CC user |
| `google_email` | identity, resolved from userinfo at connect |
| `google_sub` | stable Google account id (identity, not a secret) |
| `refresh_token_encrypted` | offline-access refresh token, never returned raw |
| `access_token_encrypted` | cached short-lived access token, never returned raw |
| `access_token_expires_at` | ISO expiry the refresh path **rewrites in place** |
| `scopes` | space-separated granted scopes |
| `client_id` | which OAuth client the grant belongs to (provenance) |
| `connected_at`, `last_refreshed_at` | timestamps |
| `last_error` | last refresh failure — connection *health*, surfaced in the UI |

Command Center already has a generic per-user/per-workspace secrets store (the
scoped-secrets machinery merged into `buildSpawnEnv`). It was **not** used here
because it is an opaque key→value blob designed to be *injected into a child env*
and never read back structurally. A Google connection is not a blob — it is a
**structured record with server-side lifecycle**:

- **identity** (`google_email`, `google_sub`) must be readable to render "connected as
  ava@example.com";
- **granted scopes** must be readable to tell a user their grant is missing Slides;
- the **access token has an expiry that the server rewrites** on every refresh — a KV
  store has no place to put "expires at", so every refresh would be a read-modify-write
  of an opaque JSON payload;
- **`last_error`** is health state written by a *background* refresh, read by the UI;
- the connect/settings UI reads all of this as **typed columns** into
  `UserGoogleConnectionSummary` (`app/shared/types.ts`), a masked shape that
  structurally *cannot* carry a token.

It does reuse `app/server/src/services/crypto.ts` — the **same AES-256-GCM primitive
and the same key** (`TEST_CRED_ENCRYPTION_KEY`, with the
`/home/operator/projects/.test-cred-encryption-key` host-file fallback) that
`user_github_tokens` uses. Format: `base64(iv).base64(authTag).base64(ciphertext)`.
The pattern is deliberately a mirror of `services/user-github-tokens.ts`.

**Decryption seams — exactly two:**

1. `getDecryptedRefreshToken(userId)` — spawn-env injection, straight into a child env.
2. `getAccessTokenForUser(userId)` — server-side refresh.

Everything else that can reach an HTTP response goes through `getForUser()` →
`UserGoogleConnectionSummary`. No token is ever logged.

---

## 2. The OAuth flow, end to end

Routes: `app/server/src/routes/user-google.ts`, mounted at `/api/user/google`.

```
POST /api/user/google/connect      (requireAuth)
      → getOAuthClient()  — 503 if the server has no client configured
      → buildAuthUrl(userId, client)
      → { auth_url }                       ← the browser navigates here

  accounts.google.com/o/oauth2/v2/auth?…&state=<signed JWT>
      → user consents

GET  /api/user/google/callback?code=…&state=…        (NOT behind requireAuth)
      → verifyState(state)      → userId, or redirect ?google=error&…=invalid_state
      → exchangeCode(code)      → refresh_token + access_token + expires_in + scope
      → fetchUserInfo(access)   → { email, sub }
      → upsert(userId, …)       → encrypted at rest
      → 302 {APP_BASE_URL}/settings/account?google=connected

DELETE /api/user/google            (requireAuth)
      → POST oauth2.googleapis.com/revoke, then delete the row
        (the row is deleted even if the remote revoke fails)
```

**Why the callback is not behind `requireAuth`.** Google performs a *top-level
cross-site redirect* back to us. The auth cookie is not guaranteed to ride along
(SameSite), so gating the callback on the session cookie would break the flow
intermittently. Instead the acting user is carried in the `state` parameter: a
**15-minute JWT signed with `JWT_SECRET`** containing `{ uid }` (`signState` /
`verifyState`). The callback derives the user id from *that signature only* — never
from a query param — so **the signed state IS the CSRF binding**. A forged or expired
state cannot name a victim user, and the code is useless without it.

### Scopes

`GOOGLE_SCOPES` in `services/user-google-connections.ts` — 15 scopes:

```
openid
https://www.googleapis.com/auth/userinfo.email
https://www.googleapis.com/auth/userinfo.profile
https://www.googleapis.com/auth/gmail.modify
https://www.googleapis.com/auth/gmail.compose
https://www.googleapis.com/auth/gmail.send
https://www.googleapis.com/auth/gmail.labels
https://www.googleapis.com/auth/gmail.settings.basic
https://www.googleapis.com/auth/drive
https://www.googleapis.com/auth/drive.file
https://www.googleapis.com/auth/documents
https://www.googleapis.com/auth/spreadsheets
https://www.googleapis.com/auth/presentations
https://www.googleapis.com/auth/calendar
https://www.googleapis.com/auth/calendar.events
```

The consent URL sends `access_type=offline` **and** `prompt=consent`. Together these
guarantee a refresh token: `offline` asks for one at all, and `prompt=consent` forces
a fresh consent screen — without it Google omits `refresh_token` when re-consenting to
an already-granted client, which would silently break every reconnect.
`exchangeCode()` treats a missing `refresh_token` as a hard error with an actionable
message (remove the app at `myaccount.google.com/permissions`, then reconnect).

### Token refresh

`getAccessTokenForUser(userId)`:

1. If a cached access token exists and is **more than 60 seconds** from expiry, decrypt
   and return it (a decrypt failure falls through to a refresh rather than throwing).
2. Otherwise POST `grant_type=refresh_token` to `oauth2.googleapis.com/token`, then
   store the new `access_token_encrypted` + `access_token_expires_at`, stamp
   `last_refreshed_at`, and clear `last_error`.
3. **Every failure path records `last_error` and returns `null` — it never throws.**
   A dead grant is *connection health* to be shown in the UI, not an exception that
   takes out a request handler.

---

## 3. Acting-user resolution (the important part)

`userGoogleCredentialEnv(ownerId)` in `services/session-manager.ts`, wired into
`buildSpawnEnv` after the git-identity block. The acting user is
**`objective.created_by`** — the objective's owner. There is no cross-user path; the
lookup is keyed on `ownerId` and nothing else.

**Connected** ⇒ the owner's grant:

| env key | value |
|---|---|
| `GOOGLE_WORKSPACE_CONNECTION` | `user` |
| `USER_GOOGLE_EMAIL` | the connected Google account |
| `GOOGLE_REFRESH_TOKEN` | the owner's decrypted refresh token |
| `GOOGLE_OAUTH_CLIENT_ID` | the server's OAuth client id |
| `GOOGLE_OAUTH_CLIENT_SECRET` | the server's OAuth client secret |

**Not connected** — no row, *or* the server OAuth client is unconfigured, *or* the
decrypt throws, *or* `ownerId` is null ⇒ **explicit absence**:

| env key | value |
|---|---|
| `GOOGLE_WORKSPACE_CONNECTION` | `absent` |

…and **zero token keys**. This is the whole point of the change:

> There is **never** a silent fallback to Mike's credential. Absence is announced, not
> papered over.

Mike is not special-cased. His credential is migrated onto his own user row (§4), so
he takes the connected branch like everyone else.

Like `userGitIdentityEnv`, the resolver is pure (DB reads only), **must not throw**
(any failure degrades to `absent`, never blocking a spawn), and never logs token
material.

### What a session should do when it sees `absent`

```
GOOGLE_WORKSPACE_CONNECTION=absent
```

Do **not** hunt for another credential on disk (`~/assistant/google-credentials/*`,
`~/.google_workspace_mcp/credentials/*`, a service account) — acting as somebody else
is exactly the failure this replaced. Stop the Google work and tell the user:

> I don't have a Google Workspace connection for your account. Connect it at
> **Settings → Account → Connect Google Workspace**, then re-run this.

When the marker is `user`, act as `USER_GOOGLE_EMAIL` and mint an access token from
`GOOGLE_REFRESH_TOKEN` + `GOOGLE_OAUTH_CLIENT_ID`/`SECRET`
(`POST https://oauth2.googleapis.com/token`, `grant_type=refresh_token`).

> **UI status:** the API (`/api/user/google`) is in place and `/settings/account` is a
> real route (`app/client/src/App.tsx` → `components/AccountSettings.tsx`), but the
> Google connect/disconnect **section has not been added to `AccountSettings.tsx` yet**.
> Until it is, a connection is established either by the migration script below or by
> driving `POST /api/user/google/connect` directly.

---

## 4. Migrating the existing on-disk credentials

`scripts/migrate-google-credential.ts` registers an existing google-auth style
credential JSON as a user's connection, so Mike and Ava keep working without an
interactive re-consent the moment the fail-closed contract ships.

Source files (`{ token, refresh_token, client_id, client_secret, scopes[], account }`):

- `/home/operator/assistant/google-credentials/<email>.json` (gauth / google-collab)
- `/home/ccuser-c/.google_workspace_mcp/credentials/<email>.json` (workspace-mcp)

`google_email` comes from the JSON `account` field, falling back to the **filename
stem** — which is the only source for Mike, whose file has `account: ""`.

```bash
# 1. see what's on disk (no DB access)
docker exec command-center /app/node_modules/.bin/tsx \
  /home/operator/projects/command-center-infra/scripts/migrate-google-credential.ts --list

# 2. DRY RUN (default) — opens the DB read-only, writes nothing
docker exec command-center /app/node_modules/.bin/tsx \
  /home/operator/projects/command-center-infra/scripts/migrate-google-credential.ts \
  --file /home/operator/assistant/google-credentials/dev@example.com.json --user mike

# 3. APPLY — encrypt + store, then mint a real access token to prove it works
docker exec command-center bash -lc 'doppler run --project command-center-infra --config prd -- \
  /app/node_modules/.bin/tsx /home/operator/projects/command-center-infra/scripts/migrate-google-credential.ts \
  --file /home/operator/assistant/google-credentials/dev@example.com.json --user mike --apply'
```

Same for Ava with `--user ava`. The script is idempotent (`upsert` replaces the row),
encrypts through the same `upsert()` seam as the OAuth callback, and **never prints a
refresh token, access token, or client secret** — only email, scope count, user, and a
client-id prefix.

`--apply` needs `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` (for the live
verification) and the encryption key — hence `doppler run`. It runs inside the
container because it imports the deployed server modules from `/app/server/src`
(override with `CC_SERVER_SRC`) so their own dependencies resolve.

---

## 5. Operator setup (Mike-gated)

### 5a. Environment variables

| variable | where | status |
|---|---|---|
| `GOOGLE_OAUTH_CLIENT_ID` | Doppler `command-center-infra` / `prd` | **exists** |
| `GOOGLE_OAUTH_CLIENT_SECRET` | Doppler `command-center-infra` / `prd` | **exists** |
| `GOOGLE_OAUTH_REDIRECT_URI` | Doppler `command-center-infra` / `prd` | **NEW — not set**; code defaults to `https://cc.example.com/api/user/google/callback`, so it only needs setting to override |
| `APP_BASE_URL` | Doppler `command-center-infra` / `prd` | **NEW — does not exist anywhere in the repo or in Doppler.** It is referenced only by `routes/user-google.ts` (`settingsUrl()`), where an unset value yields a *relative* redirect `"/settings/account?google=connected"`. That happens to work for a same-origin browser redirect, but set it to `https://cc.example.com` to make the post-consent redirect explicit. |
| `TEST_CRED_ENCRYPTION_KEY` | Doppler `command-center-infra` / `prd` | **exists** (already used by the GitHub-token store) |
| `JWT_SECRET` | server env | already in use for auth; signs the OAuth `state` |

### 5b. OAuth client identity — **verified, and it is not what the objective assumed**

Checked live against Google on 2026-08-14 (read-only probes; nothing was changed):

| client | source | probe result |
|---|---|---|
| `395825981984-7or7cnil…` | Doppler `GOOGLE_OAUTH_CLIENT_ID` / `_SECRET` | refreshing Mike's existing refresh token against it → **HTTP 401 `unauthorized_client`** |
| `281080251349-vbi7anlf…` | Doppler `GMAIL_CLIENT_ID` / `GMAIL_CLIENT_SECRET`, and the `client_id` inside **every** on-disk `google-credentials` / `workspace-mcp` JSON | refreshing Mike's token → **HTTP 200**, valid access token |

**These are two different OAuth clients in two different Google Cloud projects**
(the numeric prefix *is* the project number). The client the server is configured with
today (`395825981984-…`) is **not** the client that issued the existing credentials, so
a migrated token cannot be refreshed until that is reconciled. The migration script
detects this and prints a loud `WARNING: client mismatch`.

Two further live findings:

1. **Neither client has the web redirect URI registered.** An authorize probe with
   `redirect_uri=https://cc.example.com/api/user/google/callback` returns
   `redirect_uri_mismatch` for *both*.
2. **Both clients behave as "Desktop app" (installed app) clients** — both accept an
   arbitrary loopback redirect (`http://localhost:59123/`), which only installed-app
   clients get, and both reject `https://` redirects. Google Cloud Console does **not**
   let you change an existing client's application type, so this cannot be "converted";
   a **new Web application client must be created**.
3. **The Slides scope is already granted on the `281080251349` project.** Mike's live
   grant returns 16 scopes including `…/auth/presentations` — a superset of all 15
   `GOOGLE_SCOPES` (extra: `gmail.readonly`). The stale `scopes` array inside his JSON
   file (2 entries) does *not* reflect the real grant. So the consent screen in project
   **281080251349** already lists everything this feature needs; project
   **395825981984** has not been verified and would have to be checked scope by scope.

### 5c. What Mike must click

**In Google Cloud Console, in project `281080251349`** (the project the existing
credentials and the already-approved Slides scope live in — using this project avoids
re-verifying the consent screen):

1. **APIs & Services → Credentials → Create credentials → OAuth client ID.**
   Application type: **Web application**. Name it e.g. `Command Center (web)`.
   *(Do not try to edit `281080251349-vbi7anlf…` — it is a Desktop client and its type
   cannot be changed.)*
2. Under **Authorized redirect URIs**, add exactly:
   ```
   https://cc.example.com/api/user/google/callback
   ```
   (Optionally also a localhost URI if the flow is ever exercised from a dev server.)
3. **APIs & Services → OAuth consent screen → Data access (scopes):** confirm all 15
   scopes in §2 are listed. The live grant proves `presentations`, Gmail, Drive, Docs,
   Sheets and Calendar are already approved in this project; only re-check if the
   console shows a narrower set. If the app is still in *Testing*, make sure
   `dev@example.com` and `ava@example.com` are test users (Internal/Workspace
   publishing removes that constraint).
4. Copy the new client's id + secret into Doppler:
   ```
   doppler secrets set GOOGLE_OAUTH_CLIENT_ID=<new web client id> \
     GOOGLE_OAUTH_CLIENT_SECRET=<new secret> \
     APP_BASE_URL=https://cc.example.com \
     --project command-center-infra --config prd
   ```
   then restart the container so the server picks them up.
5. Enable the APIs in that project if they are not already: Gmail, Drive, Docs, Sheets,
   Slides, Calendar, People/userinfo.

**Consequence for the migration.** A refresh token is only valid for the client that
issued it, so tokens migrated from the on-disk files (client `281080251349-vbi7anlf…`)
will **not** refresh under a brand-new web client. Pick one:

- **Continuity first (stopgap):** point `GOOGLE_OAUTH_CLIENT_ID`/`_SECRET` at the
  existing `GMAIL_CLIENT_ID`/`GMAIL_CLIENT_SECRET` values and run the migration — this
  is verified working today. The browser Connect flow stays broken until a Web client
  exists, but nobody loses Google access.
- **Clean cut (destination):** create the Web client, set Doppler to it, and have Mike
  and Ava each click **Connect Google Workspace** once. No migration needed; every
  grant is then minted by the client the server actually holds.

The migration script exists to make the first option safe and the transition
non-breaking; the second is where this should land.

---

## 6. Files

| file | role |
|---|---|
| `app/server/src/services/user-google-connections.ts` | storage, crypto, OAuth calls, refresh |
| `app/server/src/routes/user-google.ts` | `/api/user/google` connect / callback / disconnect |
| `app/server/src/db/index.ts` | `user_google_connections` table |
| `app/server/src/services/session-manager.ts` | `userGoogleCredentialEnv` + `buildSpawnEnv` wiring |
| `app/shared/types.ts` | `UserGoogleConnectionSummary` (masked shape) |
| `scripts/migrate-google-credential.ts` | one-time migration of on-disk credentials |
