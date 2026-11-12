# Sprint 7 — Integrations approach: one-click connectors with no Example dependency

**Objective:** 900499 · **Owner:** Operation Kit · **Status:** research/proposal, no product code changed

**Status: approved by the maintainer on 2026-11-11.** Follow-up cards #1-6 from §5 below are
merged: #686 (7.1, catalog manifest + `auth_path` field), #693 (7.2, guided OAuth wizard), #691
(7.3, DCR/CIMD client), #690 (7.4, 15-20 catalog entries), #684 (7.5, per-vendor DCR/CIMD
verification), #692 (7.6, Tools-layer wiring). #7 (card #900511, the opt-in shared third-party
OAuth app) is status `working`, no PR yet. #8, **"Connect any MCP server from Integrations"** (let
a client paste in an arbitrary remote-MCP URL and have it show up as a usable connector, not just
the pre-catalogued vendors), was added to this sprint as card #900620, also status `working`, no
PR yet — see the added entry in §5.

**Hard constraint honored throughout:** every option below works from a client's own install, with
nothing routed through, or dependent on the uptime of, a service the maintainer runs. Where a vendor's
*own* central service is unavoidable (e.g. the provider's own OAuth server), that is called out —
it is a dependency on the **provider**, not on us, and every client already depends on the provider
for the underlying API anyway.

## 1. Why hosted products get one-click — and why a self-hosted install can't copy it for free

Grok (xAI), Zapier, Pipedream and similar products feel "blanket" because **the vendor, not the
end user, already did the one-time registration work with every provider**, once, centrally:

- xAI registered one GitHub-OAuth-app-equivalent with Google, Slack, Notion, HubSpot, Microsoft,
  etc., and told each provider "all callbacks land at `grok.com/connectors/callback`." A user who
  clicks "Connect Slack" is sent through *xAI's* registered app; Slack asks "allow Grok to access
  your workspace?", not "allow a server you've never heard of." ([xAI connectors docs](https://docs.x.ai/grok/connectors), accessed 2026-11-11; [xAI Gmail/Calendar connector docs](https://docs.x.ai/grok/connectors/gmail-google-calendar), accessed 2026-11-11)
- Zapier/Pipedream/Composio do the identical thing for their "managed apps": Composio's managed
  apps "cover popular toolkits... so you do not need to register your own OAuth app," at the cost
  of a shared quota and Composio's name on the consent screen ([Composio docs: custom app vs managed app](https://docs.composio.dev/docs/authentication/custom-app-vs-managed-app), accessed 2026-11-11). Pipedream's default OAuth clients are
  "intended for use within the Pipedream UI or for your own account" — official guidance is they
  are not meant to carry external, white-labeled users ([Pipedream community](https://pipedream.com/community/t/do-we-need-to-provide-our-own-custom-oauth-client-for-each-service-when-managing-external-user-workflows-for-gmail-google-drive-slack-and-notion/13110), accessed 2026-11-11; verify against current docs).

**The mechanical reason a self-hosted install can't reuse someone else's registered app:** OAuth's
redirect model ties a client ID to one or more fixed, pre-registered **redirect URIs**. Slack (or
Google, or GitHub) will only deliver the authorization code to a URI the app owner listed when they
registered. Every OperationKit install has a *different* domain
(`client-a.example.com`, `client-b.example.com`...). To reuse a single shared client ID, every
redirect would have to land on one fixed domain first and get relayed onward — which makes that
fixed domain an intermediary that sees every client's OAuth code/token in transit, is a single
point of failure for every install, and is exactly the "dependency on Example" the brief forbids. A
provider that instead lets the **client ID itself be created automatically, per install, with no
human registration step** (OAuth 2.1 Dynamic Client Registration, or the newer Client ID Metadata
Document / CIMD mechanism) removes the need for a shared app — see 2b. Short of that, each install
either registers its own app (2a) or uses a credential type that has no redirect URI at all — an
API key or PAT (2c).

## 2. Option comparison

| | **a. Guided per-provider OAuth app** | **b. Remote MCP + DCR/CIMD** | **c. API key / PAT** | **d. Self-hosted aggregator (Nango)** | **e. Optional shared third-party OAuth app** |
|---|---|---|---|---|---|
| **Who registers what** | The client (or their consultant) registers one app per provider, once, in the client's own developer console | Nothing — the client's install asks the provider's auth server for a client ID at connect time | Nothing — client pastes a key/token they generate in the provider's UI | Client self-hosts Nango; Nango's *free* self-host tier does Auth+Proxy only — still bring-your-own OAuth app per provider ([Nango self-hosting docs](https://docs.nango.dev/guides/self-hosting/free-self-hosting/overview), accessed 2026-11-11) | A third party (could be us, could be a vendor like WorkOS) registers and runs one shared app; client opts in |
| **Non-technical setup effort** | Medium-high: follow a wizard (pre-filled redirect URI + scopes + screenshots), but still an account in Slack/Google's dev console | Lowest possible — click "Connect," sign in, done. No developer console at all | Lowest for the *client*: paste one string. Finding where to generate it varies per vendor | High: stand up and operate another service (DB, workers) in addition to OperationKit itself, *plus* still do (a) per provider for anything beyond Auth+Proxy | Lowest for the client — same UX as (b)/(d) — but it's an opt-in extra, not the default |
| **Security** | Good: client's own credentials, client's own scopes, client controls revocation directly at the provider | Good in principle (short-lived, scoped tokens; no long-lived shared secret on disk) — but a May-2026 arXiv paper found DCR flaws in ~97% of a sample of 119 remote MCP servers tested, so implementation quality varies a lot ([arXiv:2605.22333, cited via nhimg.org summary](https://nhimg.org/articles/oauth-21-is-becoming-the-minimum-for-remote-mcp-security/), accessed 2026-11-11, not independently verified against the paper itself) | Weakest default blast radius if the key is broad-scoped (PATs are often all-or-nothing); best practice is a scoped/fine-grained token | Same crypto model as (a) once you register your own app; adds Nango's own control plane as new attack surface | Depends entirely on the third party's practices — explicitly why this is opt-in only |
| **Any central dependency?** | None — 100% client-owned, works if Example disappears tomorrow | None, if the *provider's own* auth server supports DCR/CIMD (the provider is a dependency either way — it's their API) | None | None on Example, but yes on whichever Nango plan tier is used if BYOC/managed hosting is chosen instead of fully self-managed | Yes, by design — the whole point of the option — scoped to "whoever runs that one shared app," never Example |
| **Maturity / who offers it today (verify before relying on any one line)** | Universal — every OAuth provider supports this, it's the baseline case | Mixed and moving: MCP's 2026-07-28 spec **deprecates DCR in favor of CIMD**, keeping DCR only as a fallback ([modelcontextprotocol.io spec via ssojet.com summary](https://ssojet.com/blog/mcp-authorization-spec-2026-07-28-what-changed), accessed 2026-11-11 — read the spec page directly before shipping against it: https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/client-registration). GitHub's remote MCP server explicitly does **not** support DCR today and needs a pre-registered OAuth/GitHub App ([GitHub host-integration guide, mirrored via glama.ai](https://glama.ai/mcp/servers/@github/github-mcp-server/blob/bf6467855c13d3b8f5cf72f8dfd9c86f8336b20b/docs/host-integration.md), accessed 2026-11-11). Linear, Notion, Sentry, Atlassian (Rovo) and Stripe all publish remote MCP endpoints with OAuth; whether each one's auth server specifically implements DCR/CIMD (vs. requiring the *client app*, e.g. Claude/Cursor, to be pre-registered with them) needs a per-vendor docs check before the catalog ships — treat the preload-list tags below as a starting point, not a guarantee | Universal — oldest, simplest, best-understood mechanism | Free self-host tier is Auth+Proxy only; Functions/syncs/webhooks/MCP server need an Enterprise plan ([Nango self-hosting docs](https://docs.nango.dev/guides/self-hosting/free-self-hosting/overview), accessed 2026-11-11). License is Elastic License 2.0 (source-available, not OSI open source; self-hosting/embedding allowed, reselling as a hosted service is not) ([Nango GitHub repo license](https://github.com/NangoHQ/nango), accessed 2026-11-11 — confirm current LICENSE file) | Several hosted aggregators (Nango Cloud, Composio, Pipedream) offer this as their commercial product today |

### a. Per-provider OAuth apps, guided
The install owner (or their consultant, during setup) registers one app each for Slack, Google
Workspace, GitHub, Microsoft 365, Notion, HubSpot, Linear, Stripe, etc. — exactly the model
`docs/connectors/README.md` already implements in this codebase (one file per connector,
`connect: { kind: 'oauth' }` or `{ kind: 'token' }`). The lift to make this "guided" rather than
"go read the provider's docs" is a wizard per connector: pre-filled redirect URI (computed from
the install's own domain), the exact scope list to tick, and 3-5 numbered screenshots. This is pure
UI work on top of what already exists — no new auth architecture.

### b. Remote MCP servers with OAuth 2.1 + DCR/CIMD
Where a provider's *own* authorization server supports dynamic registration, the install never
asks a human to create an app at all — it registers itself programmatically the first time someone
clicks "Connect," using the provider's declared `registration_endpoint`. This is the actual
blanket-connector mechanism the owner is asking about in question 1 — it is the one case where "no one
has to become a developer with each provider" is literally true, not merely hidden by a vendor's
central app. Verified as of November 2026 against each vendor's own OAuth Authorization Server
Metadata (`docs/connectors/DCR-CIMD-VENDOR-VERIFICATION.md`): Linear, Notion, and Sentry's
authorization servers confirm DCR/CIMD support with no pre-registration needed; Atlassian (Rovo)
confirms DCR on `mcp.atlassian.com` but CIMD is unconfirmed; Stripe's authorization server
advertises DCR but every official client guide steers through named-client tooling instead, so its
catalog entry ships as bucket (a) (`oauth_guided`) with a mandatory API-key fallback, not bucket
(b) — see row 8 in §3. GitHub's remote MCP explicitly requires a pre-registered app today, so
GitHub stays in bucket (a) or (c) until that changes.

### c. API key / PAT
Simplest and most universal path, and the right default for anything that doesn't have a
reasonable OAuth story (webhooks-only tools, many vertical SaaS products, most of this repo's
existing non-GitHub/Google secrets in Settings → Secrets already work this way). No redirect URI,
no app registration, no token-refresh plumbing — the tradeoff is coarser scoping and the client
has to find the right settings page to mint the key.

### d. Self-hosted aggregator (Nango)
Nango is genuinely open-source-adjacent (Elastic License 2.0, self-hostable) and would remove the
need to hand-write a `ConnectorDefinition` for 1,000+ APIs. But it fails the "no central
dependency" test for the *client*, not for us: the free self-host tier is Auth+Proxy only; anything
resembling the full product (syncs, webhooks, its own MCP server) needs an Enterprise contract —
i.e., it reintroduces a vendor dependency (Nango's) in exchange for removing ours, and a
self-hosted Nango still needs its own per-provider OAuth app for anything beyond what its
Nango-managed dev apps cover (and Nango's own docs say to swap off the shared dev app before going
to production — [Nango auth guide](https://nango.dev/docs/guides/auth/auth-guide), accessed 2026-11-11). Composio and Pipedream are flatly hosted SaaS, not
self-hostable at all for this purpose. **Not recommended as the primary path**; worth revisiting
only if a client specifically wants 1,000+ long-tail integrations and is willing to run (and pay
for) Nango Enterprise themselves.

### e. Optional, opt-in shared third-party OAuth app
For a handful of providers that neither support DCR nor make self-registration easy (some
enterprise SaaS gatekeeps "becoming a developer" behind a sales call), a client can optionally
point their install at a shared app run by a third party (e.g. a WorkOS/Descope-style "MCP auth
provider," or eventually a shared app we publish) purely as a convenience. This must stay **opt-in,
never required, and clearly labeled** — the moment it's load-bearing for the default install, it
violates the hard constraint.

## 3. Recommendation

**Architecture — an integration catalog manifest**, one file per integration (this already matches
`docs/connectors/README.md`'s "one connector, one file" rule almost exactly — extend the existing
`ConnectorDefinition` rather than building a parallel system):

```ts
{
  id: 'linear',
  name: 'Linear',
  auth_path: 'dcr_mcp' | 'oauth_guided' | 'api_key' | 'self_hosted_aggregator',
  mcp_url?: string,                 // for auth_path: 'dcr_mcp'
  oauth?: { authorize_url, token_url, scopes[] },  // for auth_path: 'oauth_guided'
  api_key_fields?: [{ key, label, where_to_get_it_url }],
  setup_guide: 'docs/connectors/guides/linear.md',
  products: [...],                  // unchanged from today's ConnectorDefinition
}
```

`auth_path` is the one new field: it tells the Settings → Connectors page which of the four UX
flows to render (DCR handshake / guided OAuth wizard / paste-a-key form / defer to aggregator), and
tells a reviewer or future maintainer at a glance which of options a-d a given integration uses —
so the choice per provider is visible and auditable, not buried in each connector's code.

### Preload list (15-20), tagged by easiest path

| # | Integration | Easiest path | Note |
|---|---|---|---|
| 1 | Slack | guided OAuth app | No DCR; per-workspace app install is well-documented |
| 2 | Google Workspace (Gmail/Calendar/Drive) | guided OAuth app | Already built in this repo |
| 3 | GitHub | API key (PAT) *or* guided OAuth app | Already built in this repo; remote MCP has no DCR today |
| 4 | Microsoft 365 | guided OAuth app | Azure AD app registration; wizard-worthy, multi-step |
| 5 | Notion | `dcr_mcp` (confirmed) **or** API key (integration token fallback) | Verified: `mcp.notion.com` advertises both `registration_endpoint` and CIMD support ([DCR-CIMD-VENDOR-VERIFICATION.md](./DCR-CIMD-VENDOR-VERIFICATION.md)) |
| 6 | Linear | `dcr_mcp` (confirmed) **or** API key (bearer token fallback) | Verified: Linear's docs state dynamic registration explicitly ([DCR-CIMD-VENDOR-VERIFICATION.md](./DCR-CIMD-VENDOR-VERIFICATION.md)) |
| 7 | HubSpot | guided OAuth app | Private App token is a simpler fallback for small installs |
| 8 | Stripe | `oauth_guided` (ships as `auth_path: 'oauth_guided'`, see `app/server/src/connectors/defs/stripe.ts`) **or** API key (mandatory Agent API key fallback for headless clients after 2026-11-30) | Verified: Stripe's own docs steer every first-party client through named-client tooling rather than a plain authorize/token pair ([DCR-CIMD-VENDOR-VERIFICATION.md](./DCR-CIMD-VENDOR-VERIFICATION.md)) |
| 9 | Atlassian (Jira/Confluence/Bitbucket) | `dcr_mcp` (confirmed on `mcp.atlassian.com`, CIMD unconfirmed — re-verify before relying on it) | Beta-labeled when launched; re-check status ([DCR-CIMD-VENDOR-VERIFICATION.md](./DCR-CIMD-VENDOR-VERIFICATION.md)) |
| 10 | Sentry | `dcr_mcp` (confirmed) **or** API key | mcp.sentry.dev, scoped per org/project ([DCR-CIMD-VENDOR-VERIFICATION.md](./DCR-CIMD-VENDOR-VERIFICATION.md)) |
| 11 | Cloudflare | API key / account token | Cloudflare itself is also an MCP-hosting platform for many of the above |
| 12 | Discord | guided OAuth app (bot token simpler) | Bot token is the common path for server-side automation |
| 13 | Airtable | API key (PAT) | Per-base scoped PATs, no OAuth needed for most uses |
| 14 | ClickUp | API key | Simple token model |
| 15 | Calendly | API key / webhook signing key | Already a secret in this workspace's registry |
| 16 | Cal.com | API key (self-hosted option also exists) | Already a secret in this workspace's registry |
| 17 | DocuSeal | API key | Already a secret in this workspace's registry |
| 18 | Intercom | guided OAuth app or API key | Token path is simplest for a single-workspace install |
| 19 | n8n (as a downstream automation target) | API key / webhook URL | Treats n8n as an integration target, not a competing orchestrator |
| 20 | Supabase | API key (service role / access token) | Already the pattern this repo uses for its own Supabase deploys |

Every row above (follow-up #5, merged as [PR #684](https://github.com/your-org/operationkit/pull/684))
is now backed by a direct check against the provider's own OAuth Authorization Server Metadata or
docs pages — not a search-engine summary — in `docs/connectors/DCR-CIMD-VENDOR-VERIFICATION.md`.
GitHub remains the cautionary example: its remote MCP server has no DCR support and needs a
pre-registered app, which is why rows 5/6/9/10 were not assumed `dcr_mcp` without a per-vendor
check in the first place.

## 4. Where "Tools" fit, and agent self-configuration

OperationKit's "Tools" layer (Tools → Skills → Agents, per `~/ai-workspace/docs/operationkit-architecture.md`
in this install's conventions) is the natural home for *using* a connector once it exists — a Tool
wraps one capability (e.g. "post a Slack message") and reads its credential the same way any
connector already hands environment variables to a session (`readCredential` →
`canUseConnectorCredential` → session env, per `app/server/src/connectors/types.ts`). The catalog
manifest in §3 is the input to that layer: once an integration's `auth_path` is known, a Tool
definition can declare `auth.secrets[].env` naming the variable it needs, exactly as
`app/server/src/routes/internal-operationkit.ts` already describes for the existing OperationKit
Tools/Skills registry.

**Agent self-configuration via copy-paste prompt:** because the catalog is a manifest, not code,
an agent can be handed a short, fixed prompt ("Given this integration name and this manifest
schema, write the connector file and the one-paragraph setup guide") and produce both the
`ConnectorDefinition` file and its `setup_guide` markdown without a human writing TypeScript. This
is the same shape as this repo's existing `okit new tool ... --from-json -` scaffolding path — the
manifest is the thing an agent fills in, and `okit validate` / the registry rebuild is the thing
that checks it did so correctly. No new mechanism needs inventing here; it is a second consumer of
machinery that already exists for Tools.

## 5. Implementation plan — follow-up cards (originally listed here, not created; #1-6 have since
been built and merged — see each item's status line)

1. **Catalog manifest + `auth_path` field** — extend `ConnectorDefinition` (`app/server/src/connectors/types.ts`)
   with the `auth_path` enum and `setup_guide` pointer from §3; no behavior change to existing
   connectors, additive only. Status: **merged**, [PR #686](https://github.com/your-org/operationkit/pull/686).
2. **Guided-wizard UI for `oauth_guided`** — Settings → Connectors renders a pre-filled
   redirect URI + scope list + numbered screenshots per provider, replacing "go read the vendor's
   docs" with an in-app walkthrough. Status: **merged**, [PR #693](https://github.com/your-org/operationkit/pull/693).
3. **DCR/CIMD client implementation** — a shared `connectors/dcr-client.ts` that performs
   dynamic registration against a provider's declared `registration_endpoint` (or CIMD document)
   and stores the resulting per-install client credentials the same way today's OAuth connectors
   store a token; ship Notion and/or Linear first since those publish both a remote-MCP-OAuth path
   and a token fallback to fall back on if DCR support turns out to be partial. Status: **merged**,
   [PR #691](https://github.com/your-org/operationkit/pull/691).
4. **Preload the 15-20 catalog entries** — one PR per small batch, each entry = one
   `ConnectorDefinition` file + one `setup_guide.md`, following the existing "one file" convention.
   Status: **merged**, [PR #690](https://github.com/your-org/operationkit/pull/690).
5. **Per-vendor DCR/CIMD verification pass** — before #3 ships against any "verify"-tagged row
   in §3's table, confirm directly against that vendor's own docs (not a search summary) whether
   their authorization server implements DCR/CIMD or whether the *client* still needs
   pre-registration. Status: **merged**, [PR #684](https://github.com/your-org/operationkit/pull/684)
   — see `docs/connectors/DCR-CIMD-VENDOR-VERIFICATION.md`; §3's table below reflects its verdicts.
6. **Tools-layer wiring** — once a connector exists, a matching Tool definition
   (`auth.secrets[].env` naming its env var) makes it usable by agents; this is the existing
   OperationKit Tools scaffolding (`okit new tool`), not new infrastructure. Status: **merged**,
   [PR #692](https://github.com/your-org/operationkit/pull/692).
7. **(Optional, explicitly opt-in) shared third-party OAuth app for DCR/CIMD-less, hard-to-self-register
   providers** — scope this only after #1-6 ship, and only as a toggle a client turns on for named
   providers, never a default. Status: card #900511, `working`, no PR yet.
8. **Connect any MCP server from Integrations** (added 2026-11-11, per the maintainer's "add MCPs
   to integrations" approval above) — let a client add an arbitrary remote MCP server by URL (not
   limited to the pre-catalogued vendors in §3's preload list) and have it authenticate via
   whatever the server itself advertises (DCR/CIMD per §2b, or a manual token if it doesn't) and
   appear as a usable connector/Tool per §4. This generalizes #3's DCR/CIMD client beyond the
   fixed catalog — same client, no new auth mechanism, just a "custom server URL" entry point
   instead of (or alongside) a preloaded one. Status: card #900620, `working`, no PR yet.

---

## Appendix — sources (accessed 2026-11-11 via web search; re-verify dated/version-specific claims against the vendor's own current docs before implementation)

- xAI Grok connectors: <https://docs.x.ai/grok/connectors>, <https://docs.x.ai/grok/connectors/gmail-google-calendar>
- Composio managed vs. custom OAuth app: <https://docs.composio.dev/docs/authentication/custom-app-vs-managed-app>
- Pipedream OAuth clients for external users (community answer, verify against official docs): <https://pipedream.com/community/t/do-we-need-to-provide-our-own-custom-oauth-client-for-each-service-when-managing-external-user-workflows-for-gmail-google-drive-slack-and-notion/13110>
- Nango self-hosting tiers: <https://docs.nango.dev/guides/self-hosting/free-self-hosting/overview>, <https://docs.nango.dev/guides/self-hosting/enterprise-self-hosting>
- Nango license (Elastic License 2.0 — confirm current file): <https://github.com/NangoHQ/nango>
- Nango auth guide (managed dev app vs. your own app): <https://nango.dev/docs/guides/auth/auth-guide>
- MCP authorization spec 2026-07-28, client registration (DCR deprecated in favor of CIMD): <https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/client-registration>, summarized via <https://ssojet.com/blog/mcp-authorization-spec-2026-07-28-what-changed>
- DCR security weaknesses across tested remote MCP servers (secondary summary of arXiv:2605.22333, not independently verified): <https://nhimg.org/articles/oauth-21-is-becoming-the-minimum-for-remote-mcp-security/>
- GitHub remote MCP server does not support DCR today: <https://glama.ai/mcp/servers/@github/github-mcp-server/blob/bf6467855c13d3b8f5cf72f8dfd9c86f8336b20b/docs/host-integration.md>
- This repo's existing connector contract (basis for the catalog-manifest recommendation): `app/server/src/connectors/types.ts`, `docs/connectors/README.md`

## Non-goals / what this card did not do

This card ([objective 900499](https://github.com/your-org/operationkit/pull/681))
changed no connector code, secrets, access rules, or permissions itself — it is a docs-only
addition (this file) under `docs/connectors/`. The approved follow-up cards listed in §5
subsequently did ship product code (merged PRs #686, #693, #691, #690, #692) plus one further
docs-only follow-up (#684); that work is tracked and reviewed on those cards, not this one.
