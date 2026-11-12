# Optional: a shared third-party OAuth app (Sprint 7.7)

**You do not need this.** It is off on every install and Operation Kit never turns it on.
A normal install connects each integration on its own, with no shared app:

1. **`dcr_mcp`** — the install registers itself with the provider (DCR/CIMD), where the provider supports it.
2. **`oauth_guided`** — otherwise, you register your own OAuth app with the provider, guided by the setup wizard.
3. **`api_key`** — otherwise, you paste a key or token.

This page covers a fourth, **optional** route: option (e) in
[`INTEGRATIONS-PROPOSAL.md`](INTEGRATIONS-PROPOSAL.md) (follow-up #7).

## When it is useful

Some providers neither support DCR/CIMD nor make it easy to register your own app (a few
enterprise vendors put developer access behind a sales call). For those, an admin can point
**one named integration** at a shared OAuth app that **a third party you choose** has already
registered with the vendor. Examples are a WorkOS- or Descope-style MCP auth provider, or any
OAuth 2.0 authorization server that publishes RFC 8414 metadata.

## What it depends on

**Turning this on makes that integration depend on the third party you picked, not on
Operation Kit.** If that third party goes down, changes its terms or stops relaying sign-ins,
that one integration stops connecting until you register your own app or turn this off.

- Operation Kit does **not** run a shared OAuth app, and does not suggest one.
- There is **no built-in issuer, client ID or redirect URI**. Every field starts empty and you
  fill in values from the third party you chose.
- Everything else on the install keeps working without it.

## How it behaves

| Situation | What happens |
|---|---|
| Fresh install (nothing saved) | Exactly the same as before Sprint 7.7. No shared app is contacted. |
| Config saved but switched **off** | Same as a fresh install. |
| Switched **on**, and the install has **its own** app for that integration | The install's own app is used. The shared app is ignored. |
| Switched **on**, and the install has **no** app of its own | "Connect" signs in through the third party's OAuth server (PKCE, public client). |

Only integrations that use the generic guided-OAuth flow can be named: Slack, Microsoft 365,
HubSpot, Discord and Intercom today. The server returns a 400 for any other integration.
There is no "all integrations" switch.

## Setting it up

Settings → Integrations → the integration's card → **Shared third-party app (Optional)**.
Only an admin signed in to the browser can change it. Other users see it read-only.

| Field | Where it comes from |
|---|---|
| Who runs it (optional) | Your own label. It is shown on the connection ("via shared app: …") so everyone can see what it depends on. |
| Issuer URL | The third party's OAuth server. Must be `https://`. The install reads `<issuer>/.well-known/oauth-authorization-server`. |
| Client ID | The client ID the third party gave you for its shared app. |
| Redirect URI | The redirect URI registered on the shared app. Must be `https://`. |
| Use this shared app… | The opt-in toggle. Off by default. |

The third party must send the sign-in (`code` + `state`) back to **this install's own
callback**, which the panel shows: `<your install>/api/user/connector-oauth/<id>/callback`.

**Secrets.** The config holds only public values. The shared app is treated as a public client
(PKCE, RFC 7636), so no client secret is needed. If your third party also gives you a client
secret, add it under Settings → Secrets as `<ID>_SHARED_OAUTH_CLIENT_SECRET` (for example
`SLACK_SHARED_OAUTH_CLIENT_SECRET`). It is read by name and never stored in this config.
Secrets storage is unchanged.

To stop using it, untick the toggle or click **Remove**. Users who already connected keep their
stored token until they disconnect. New connections go back to the default path.

## API

Admin only, browser session only:

```
PUT    /api/connectors/:id/shared-app   { enabled, issuer, client_id, redirect_uri, provider_label? }
DELETE /api/connectors/:id/shared-app
```

`GET /api/connectors` returns `shared_app` on each eligible integration (`null` on the rest),
with `enabled: false` until an admin turns it on.

## Code

- `app/server/src/services/shared-oauth-app.ts` — config (one `settings` row,
  `connector_shared_oauth_apps`, absent on a fresh install), validation, PKCE start and code exchange.
- `app/server/src/connectors/lib/oauth-guided-connector.ts` — uses the shared app only when
  there is no own app **and** the toggle is on.
- `app/server/src/routes/connector-oauth-callback.ts` — accepts the relayed callback. It uses
  a separately signed `state`, so a state minted for the install's own app can't be reused here.
- `app/client/src/components/connectors/SharedOAuthAppPanel.tsx` — the standalone panel.
- Tests: `app/server/src/services/shared-oauth-app.test.ts` (default path unchanged and makes
  no network calls; opt-in flow; admin-only routes) and `SharedOAuthAppPanel.test.tsx`.

**Limitation:** a token from a shared app is stored like any other guided-OAuth grant (`connector_oauth_grants`). Guided-OAuth grants have no automatic token refresh yet, whether they come from your own app or a shared one. This card does not add one.
