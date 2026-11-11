# Sprint 7.5 — Per-vendor DCR/CIMD verification pass

**Objective:** 900505 · **Owner:** Operation Kit · **Status:** research/docs, no connector code changed
**Follow-up #5** of the Sprint 7 proposal in
[PR #681](https://github.com/your-org/operationkit/pull/681)
(`docs/connectors/INTEGRATIONS-PROPOSAL.md`), approved by Operator 2026-11-10 7:52 PM ET.
Blocks Sprint 7.3 (the shared `dcr-client.ts`) — do not build that client against any
row below until this doc backs its `auth_path` tag.

**Method:** every verdict below is backed by either (a) a direct `curl` to the vendor's
own published OAuth Authorization Server Metadata document
(`/.well-known/oauth-authorization-server`, [RFC 8414](https://datatracker.ietf.org/doc/html/rfc8414)) —
the vendor's own authorization server telling you programmatically what it supports — or
(b) the vendor's own docs pages fetched directly, never a search-engine summary. All
checks performed 2026-11-11. §3 of the proposal's "verify"-tagged vendors (Notion,
Linear, Atlassian/Rovo, Sentry, Stripe) plus a GitHub re-check are all covered.

## Quick reference

| Vendor | DCR (`registration_endpoint`) | CIMD (`client_id_metadata_document_supported`) | Pre-registered app still required? | Recommended `auth_path` | Fallback |
|---|---|---|---|---|---|
| Notion | **Yes** | **Yes** | No | `dcr_mcp` | `api_key` (workspace-owner-issued MCP token, Business/Enterprise plans only) |
| Linear | **Yes** | **Yes** | No — docs state dynamic registration explicitly | `dcr_mcp` | `api_key` (bearer token / Linear API key) |
| Atlassian (Rovo — Jira/Confluence/Bitbucket) | **Yes** (on `mcp.atlassian.com`) | **Unconfirmed** on the MCP issuer itself (see caveat below) | Not stated as required; OAuth 2.1 3LO consent flow | `dcr_mcp` (verify CIMD again before relying on it) | None documented beyond OAuth |
| Sentry | **Yes** | **Yes** | No | `dcr_mcp` | CLI login (local/stdio variant only) |
| Stripe | **Yes** | **No** (field absent) | No central dev-console registration found, but every official client guide (Cursor/Claude Code/Codex/VS Code) wires a specific per-client config rather than raw ad-hoc DCR | `oauth_guided` primary, `dcr_mcp` technically available | `api_key` (**agent API key** — mandatory for non-interactive/autonomous clients; full-access/restricted keys stop being accepted after **2026-11-30**) |
| GitHub (re-check) | **No** — explicitly stated unsupported | Not mentioned | **Yes** | `api_key` (PAT) or `oauth_guided` | PAT is the simplest path; GitHub/OAuth App otherwise |

---

## MCP Authorization spec — 2026-07-28, Client Registration

Read directly from
<https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/client-registration>
(accessed 2026-11-11). The spec defines **three** registration mechanisms and a priority
order, confirming the proposal's claim that DCR is deprecated in favor of CIMD:

> "Clients supporting all options **SHOULD** use the following priority order:
> 1. Use pre-registered client information for the server if the client has it available
> 2. Use Client ID Metadata Documents if the Authorization Server indicates that it
>    supports them (via `client_id_metadata_document_supported` in OAuth Authorization
>    Server Metadata)
> 3. Use Dynamic Client Registration as a fallback if the Authorization Server supports
>    it (via `registration_endpoint` in OAuth Authorization Server Metadata)
> 4. Prompt the user to enter the client information if no other option is available"

On Client ID Metadata Documents:

> "MCP clients and authorization servers **SHOULD** support OAuth Client ID Metadata
> Documents... This approach enables clients to use HTTPS URLs as client identifiers...
> This addresses the common MCP scenario where servers and clients have no pre-existing
> relationship."

On Dynamic Client Registration, verbatim (a literal deprecation warning, not a
secondary summary):

> "**Dynamic Client Registration is deprecated.** New implementations should use Client
> ID Metadata Documents instead. This option remains available for backwards
> compatibility with authorization servers that do not support Client ID Metadata
> Documents."
>
> "MCP clients and authorization servers **MAY** support the OAuth 2.0 Dynamic Client
> Registration Protocol [RFC7591]... This option is included for backwards compatibility
> with earlier versions of the MCP authorization spec."

**Implication for `dcr-client.ts` (Sprint 7.3):** the shared client should implement the
spec's own fallback chain — prefer CIMD when the AS metadata advertises
`client_id_metadata_document_supported: true`, fall back to RFC 7591 DCR when only
`registration_endpoint` is present, and surface a manual-entry/API-key path when
neither exists. A client that only knows DCR will still work today against every
`verify`-tagged vendor below except where noted, but will be out of spec with where MCP
is heading.

---

## Per-vendor verdicts

### Notion

- **Official docs checked:** <https://developers.notion.com/guides/mcp/get-started-with-mcp> (accessed 2026-11-11, no page date/version published); OAuth Authorization Server Metadata at `https://mcp.notion.com/.well-known/oauth-authorization-server` (accessed 2026-11-11).
- **Metadata document (verbatim, truncated to the relevant fields):**
  ```json
  {
    "issuer": "https://mcp.notion.com",
    "registration_endpoint": "https://mcp.notion.com/register",
    "client_id_metadata_document_supported": true,
    ...
  }
  ```
  Both `registration_endpoint` (DCR) and `client_id_metadata_document_supported: true`
  (CIMD) are present — Notion's own authorization server supports both registration
  mechanisms the MCP spec defines, with no human pre-registration step.
- **Docs confirm the UX is OAuth-only, no dev console required:** the hosted MCP server
  "requires no infrastructure setup" and the client simply "Complete[s] the OAuth flow
  when prompted."
- **Fallback:** "A workspace owner can create an MCP token with **New MCP token** in the
  Developer portal," sent as a bearer token "with no browser sign-in" — but this is
  "limited to Business and Enterprise plans."
- **Verdict:** `auth_path: dcr_mcp`. Pre-registration NOT required. `api_key` fallback
  exists but is plan-gated.

### Linear

- **Official docs checked:** <https://linear.app/docs/mcp> (accessed 2026-11-11; page cites MCP spec version 2025-03-26, no further page date); metadata at `https://mcp.linear.app/.well-known/oauth-authorization-server` (accessed 2026-11-11).
- **Metadata document (verbatim, truncated):**
  ```json
  {
    "issuer": "https://mcp.linear.app",
    "registration_endpoint": "https://mcp.linear.app/register",
    "client_id_metadata_document_supported": true,
    ...
  }
  ```
  Both DCR and CIMD endpoints/flags present.
- **Docs state the mechanism explicitly, not just implied by the metadata:** "The
  interactive setup flow uses OAuth 2.1 with dynamic client registration."
- **Fallback:** "you can authenticate directly with a bearer token or Linear API key."
- **Verdict:** `auth_path: dcr_mcp`. Pre-registration NOT required — this is the
  cleanest-documented case of all six vendors. `api_key` fallback available.

### Atlassian (Rovo MCP — Jira/Confluence/Bitbucket)

- **Official docs checked:** <https://support.atlassian.com/atlassian-rovo-mcp-server/docs/getting-started-with-the-atlassian-remote-mcp-server/> (accessed 2026-11-11); metadata at `https://mcp.atlassian.com/.well-known/oauth-authorization-server` AND, separately, `https://auth.atlassian.com/.well-known/oauth-authorization-server` (both accessed 2026-11-11).
- **`mcp.atlassian.com` metadata (verbatim, truncated):**
  ```json
  {
    "issuer": "https://mcp.atlassian.com",
    "registration_endpoint": "https://mcp.atlassian.com/v1/register",
    ...
  }
  ```
  No `client_id_metadata_document_supported` field on this issuer.
- **`auth.atlassian.com` metadata (Atlassian's general-identity authorization server, a
  DIFFERENT issuer — verbatim, truncated):**
  ```json
  {
    "issuer": "https://auth.atlassian.com",
    "client_id_metadata_document_supported": true,
    ...
  }
  ```
  No `registration_endpoint` on this issuer.
- **Caveat (read before trusting a `dcr_mcp` tag here):** these are two distinct
  authorization servers with different capability flags, and the docs page does not
  state which issuer the Rovo remote MCP server actually binds to for token issuance in
  production, nor does it describe the registration mechanism in words — it only says
  Atlassian MCP is "powered by secure OAuth 2.1 authorization" and that incompatible
  clients may need to clear cached `clientIds` / `.well-known` credentials (language
  that implies client-ID/discovery machinery is in play but does not name DCR or CIMD).
  **Do not assume CIMD support carries over from `auth.atlassian.com` to the MCP
  issuer** — re-confirm against `mcp.atlassian.com`'s own metadata at build time.
- **Beta status (re-checked per the proposal's call-out):** the current getting-started
  page does **not** label the server "beta" — it instead describes "v2 of Atlassian MCP
  server" as a recent release, with existing v1 usage auto-migrating to v2 tools on
  **2027-03-01**. The proposal's "beta-labeled when launched" note appears to be stale;
  re-verify at Sprint 7.3 build time since this is a fast-moving page.
- **Products confirmed in scope:** Jira, Jira Service Management, Confluence,
  Bitbucket, Projects, Goals, and Loom recordings.
- **Verdict:** `auth_path: dcr_mcp` (DCR confirmed via `registration_endpoint`), but
  flag CIMD as **unconfirmed** for the specific issuer the MCP server uses, and flag
  beta status as **resolved to "not currently beta-labeled"** rather than the
  proposal's assumption — both should be re-checked immediately before Sprint 7.3
  writes the Atlassian connector.

### Sentry

- **Official docs checked:** <https://mcp.sentry.dev/> (accessed 2026-11-11, `docs.sentry.io/product/sentry-mcp/` 301-redirects here; no page date/version); metadata at `https://mcp.sentry.dev/.well-known/oauth-authorization-server` (accessed 2026-11-11).
- **Metadata document (verbatim, truncated):**
  ```json
  {
    "issuer": "https://mcp.sentry.dev",
    "registration_endpoint": "https://mcp.sentry.dev/oauth/register",
    "client_id_metadata_document_supported": true,
    ...
  }
  ```
  Both DCR and CIMD present.
- **Docs confirm no pre-registration:** "All connections use OAuth. The first
  connection will trigger an authentication flow to connect to your Sentry account."
- **Fallback:** a local/CLI-login variant exists ("It uses the CLI login, so the MCP
  config needs no token") but that's a different (stdio, not remote-OAuth) mode.
- **Verdict:** `auth_path: dcr_mcp`. Pre-registration NOT required.

### Stripe

- **Official docs checked:** <https://docs.stripe.com/mcp> (accessed 2026-11-11, page is actively versioned — it carries a live "Update API key authentication by November 30, 2026" deadline notice); metadata at `https://mcp.stripe.com/.well-known/oauth-authorization-server` (accessed 2026-11-11).
- **Metadata document (verbatim, truncated):**
  ```json
  {
    "issuer": "https://access.stripe.com/mcp",
    "registration_endpoint": "https://access.stripe.com/mcp/oauth2/register",
    ...
  }
  ```
  `registration_endpoint` IS present (DCR is technically supported by the authorization
  server) but **`client_id_metadata_document_supported` is absent** — Stripe does not
  currently advertise CIMD.
- **Why the recommendation is `oauth_guided`, not `dcr_mcp`, despite DCR being
  present:** Stripe's own docs do not describe a generic "any MCP client can just
  connect" OAuth flow the way Notion/Linear/Sentry do. Every first-party path in the
  docs is either a named-client command (`stripe agent setup`, `claude mcp add ...`,
  Cursor/VS Code deep-links) or an explicit API-key bearer-token config — the vendor is
  steering integrators toward its own tooling rather than raw ad-hoc DCR against
  `mcp.stripe.com`. Tag it `oauth_guided` for the catalog's UX purposes (wizard-style,
  per-client instructions) while noting DCR is technically live underneath.
- **Mandatory fallback, with a hard deadline:** "Starting in December [2026], Stripe MCP
  will stop accepting full-access secret keys and restricted API keys without the Agent
  tag... Requests using an unsupported key receive a `401` response." Any
  non-interactive/autonomous client (i.e. most of what this repo would build) MUST use
  an **agent API key**, not a legacy secret/restricted key, after **2026-11-30**.
- **Verdict:** `auth_path: oauth_guided` (interactive clients) with `api_key` (agent API
  key) as the required path for autonomous/headless use — not a plain `dcr_mcp` catalog
  entry, despite DCR being present at the protocol level.

### GitHub (remote MCP — re-check)

- **Official docs checked:** <https://github.com/github/github-mcp-server/blob/main/docs/host-integration.md> (accessed 2026-11-11, references MCP spec 2025-06-18 and OAuth 2.1 draft `draft-ietf-oauth-v2-1-13`).
- **Verbatim:** "Dynamic Client Registration is **NOT** supported by Remote GitHub MCP
  Server at this time." The guide instructs integrators to "configure either a GitHub
  App or an OAuth App to allow your client application to utilize GitHub OAuth
  support," and notes the server "does not provide Authentication services" itself —
  the client must obtain a valid GitHub token on its own. It also allows supplying "a
  pre-generated Personal Access Token (PAT)" as a no-registration alternative.
- **No `.well-known/oauth-authorization-server` on `api.githubcopilot.com` or
  `github.com`** (both `curl` to 404) — consistent with "no DCR," since there's no
  metadata document advertising a `registration_endpoint` to find.
- **Verdict (unchanged from the Sprint 7 proposal — confirmed, not stale):**
  `auth_path: api_key` (PAT) as the simplest default, or `oauth_guided` (pre-registered
  GitHub App/OAuth App) for the interactive case. **Do not tag GitHub `dcr_mcp`.**

---

## Recommended `auth_path` per vendor (summary for the catalog manifest, §3 of PR #681)

| Integration | `auth_path` | Fallback field(s) |
|---|---|---|
| Notion | `dcr_mcp` | `api_key` (MCP token, Business/Enterprise only) |
| Linear | `dcr_mcp` | `api_key` (bearer token / Linear API key) |
| Atlassian (Rovo) | `dcr_mcp` *(re-verify CIMD + issuer binding before Sprint 7.3 build)* | none documented |
| Sentry | `dcr_mcp` | none for remote OAuth (CLI-login only in local/stdio mode) |
| Stripe | `oauth_guided` | `api_key` (agent API key — **required** for headless clients after 2026-11-30) |
| GitHub | `api_key` (PAT) or `oauth_guided` | PAT is simplest; no DCR |

## What this doc does NOT do (out of scope, per the card)

No `dcr-client.ts` was written or changed, no `ConnectorDefinition` behavior changed, no
OAuth app was registered with any vendor, no vendor account was created, and no live
credential was used for any of the above — every check was either a public,
unauthenticated `curl` to a vendor's published OAuth Authorization Server Metadata
endpoint, or a fetch of a vendor's own public docs page. Settings → Connectors UI and
the Connectors→Integrations rename (Sprint 4b, #900496) and secrets storage internals
(Sprint 6, #900498) were not touched.
